#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""quick_build.py —— 不依赖 gradle 的快速构建。

适用场景：**只改了 src/*.js / *.css / *.html**（即 WebView 里的页面逻辑），
          没动 Kotlin、没动资源、没动依赖。
这种改动占日常迭代的 99%，用 gradle 重新编译纯属浪费时间，
而且 gradle daemon 在某些 Windows 环境（127.0.0.1 通信被拦）根本起不来。

做法：
  1. concat.py 把 src/ 拼回 app/src/main/assets/index.html（带 sha 校验）
  2. 拿 dist 里的**已签名基线 APK** 做底包，只替换 assets/index.html
  3. zipalign（16KB 页对齐）
  4. apksigner 用原厂密钥重新签名

这样产出的 APK 和 gradle 编译的等价（因为 classes.dex / resources.arsc 没变），
但耗时从分钟级降到秒级。

用法：
    python tool/quick_build.py                 # 用 dist/yjblite-baseline.apk
    python tool/quick_build.py --base xxx.apk  # 指定底包
    python tool/quick_build.py --no-sign       # 只打包不签名（调试用）

前置条件（从环境变量或参数读取，缺一即报错退出）：
    ANDROID_HOME   Android SDK 根目录（需要 build-tools 里含 zipalign/apksigner）
    JAVA_HOME      JDK（apksigner 依赖）
    YJB_KEYSTORE   签名库路径（.jks）
    YJB_STORE_PASS 库口令
    YJB_KEY_PASS   密钥口令
"""
from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / 'src'
ASSET = ROOT / 'app' / 'src' / 'main' / 'assets' / 'index.html'
DIST = ROOT / 'dist'
DEFAULT_BASE = DIST / 'yjblite-baseline.apk'


def die(msg):
    print('[quick_build] 错误: ' + msg, file=sys.stderr)
    sys.exit(1)


def find_build_tool(name):
    """在 ANDROID_HOME/build-tools 下找版本最高的可用工具。"""
    android = os.environ.get('ANDROID_HOME') or os.environ.get('ANDROID_SDK_ROOT')
    if not android:
        die('未设置 ANDROID_HOME')
    bt_root = Path(android) / 'build-tools'
    if not bt_root.is_dir():
        die('找不到 %s' % bt_root)
    cands = sorted([d for d in bt_root.iterdir() if d.is_dir()],
                   key=lambda d: [int(x) for x in d.name.split('.') if x.isdigit()],
                   reverse=True)
    for d in cands:
        for ext in ('.exe', '.bat', ''):
            p = d / (name + ext)
            if p.exists():
                return p
    die('build-tools 里找不到 %s' % name)


def run(cmd, **kw):
    print('[quick_build] $ ' + ' '.join(str(c) for c in cmd))
    r = subprocess.run(cmd, **kw)
    if r.returncode != 0:
        die('命令失败 (exit %d)' % r.returncode)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--base', default=str(DEFAULT_BASE), help='已签名的底包 APK')
    ap.add_argument('--out', default=str(DIST / 'yjblite-quick.apk'), help='输出 APK')
    ap.add_argument('--no-sign', action='store_true', help='只打包不签名')
    ap.add_argument('--skip-concat', action='store_true', help='跳过 src->assets 拼接')
    args = ap.parse_args()

    # 1) 拼接
    if not args.skip_concat:
        concat = ROOT / 'tool' / 'concat.py'
        if not concat.exists():
            die('找不到 tool/concat.py')
        run([sys.executable, str(concat)])

    if not ASSET.exists():
        die('缺 %s' % ASSET)

    base = Path(args.base)
    if not base.exists():
        die('底包不存在: %s\n'
            '  提示：把一份已验证可安装的 APK 放在 dist/yjblite-baseline.apk，\n'
            '        或在命令行用 --base 指定。' % base)

    # 2) 替换 assets/index.html（保留其它所有条目的原始压缩方式与时间戳）
    tmpdir = Path(tempfile.mkdtemp(prefix='yjb_'))
    raw = tmpdir / 'raw.apk'
    new_asset = ASSET.read_bytes()
    replaced = False
    with zipfile.ZipFile(base, 'r') as zin, zipfile.ZipFile(raw, 'w', zipfile.ZIP_DEFLATED) as zout:
        for item in zin.infolist():
            name = item.filename
            # 丢掉旧的 JAR 签名残留：内容变了，摘要必然失效
            if name.startswith('META-INF/') and name.upper().endswith(
                    ('.SF', '.RSA', '.DSA', '.EC', 'MANIFEST.MF')):
                continue
            data = zin.read(name)
            if name == 'assets/index.html':
                data = new_asset
                replaced = True
            zi = zipfile.ZipInfo(name, date_time=item.date_time)
            zi.compress_type = item.compress_type
            zi.external_attr = item.external_attr
            zi.internal_attr = item.internal_attr
            zi.create_system = item.create_system
            zout.writestr(zi, data)
    if not replaced:
        die('底包里没有 assets/index.html，选错底包了？')
    print('[quick_build] 已替换 assets/index.html (%d 字节)' % len(new_asset))

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)

    if args.no_sign:
        shutil.copy2(raw, out)
        print('[quick_build] 未签名产物: %s' % out)
        return

    # 3) zipalign
    zipalign = find_build_tool('zipalign')
    aligned = tmpdir / 'aligned.apk'
    run([str(zipalign), '-f', '-P', '16', '4', str(raw), str(aligned)])

    # 4) 签名
    ks = os.environ.get('YJB_KEYSTORE')
    sp = os.environ.get('YJB_STORE_PASS')
    kp = os.environ.get('YJB_KEY_PASS')
    if not (ks and sp and kp):
        die('签名需要 YJB_KEYSTORE / YJB_STORE_PASS / YJB_KEY_PASS 三个环境变量；\n'
            '  或加 --no-sign 只打包。')
    if not Path(ks).exists():
        die('签名库不存在: %s' % ks)
    apksigner = find_build_tool('apksigner')
    if out.exists():
        out.unlink()
    run([str(apksigner), 'sign',
         '--ks', ks, '--ks-pass', 'pass:' + sp, '--key-pass', 'pass:' + kp,
         '--out', str(out), str(aligned)])

    # 5) 校验：APK 里的 index.html 必须与源码逐字节一致
    with zipfile.ZipFile(out) as z:
        inside = z.read('assets/index.html')
    if inside != new_asset:
        die('产物里的 index.html 与源码不一致，别装！')
    print('[quick_build] ASSET MATCH: OK')

    # 6) 打印证书指纹，便于和旧包装机对比
    try:
        vr = subprocess.run([str(apksigner), 'verify', '--print-certs', str(out)],
                            capture_output=True, text=True)
        for line in vr.stdout.splitlines():
            if 'SHA-256' in line:
                print('[quick_build] ' + line.strip())
    except Exception:
        pass

    print('[quick_build] 完成: %s (%d 字节)' % (out, out.stat().st_size))
    shutil.rmtree(tmpdir, ignore_errors=True)


if __name__ == '__main__':
    main()
