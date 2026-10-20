# -*- coding: utf-8 -*-
"""
把 src/ 下的模块拼回单文件 assets/index.html。

硬性保证：**产物必须与拆分前逐字节一致**（sha256 比对）。
对不上直接 non-zero 退出，绝不生成一个"看起来对"的产物去覆盖正式文件。
"""
import io, os, sys, hashlib

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, 'src')
OUT = os.path.join(ROOT, 'app', 'src', 'main', 'assets', 'index.html')

def rd(name):
    return io.open(os.path.join(SRC, name), encoding='utf-8').read()

SLOT = '<!--@@SLOT@@-->'

shell   = rd('00-shell.html')
hinit   = rd('01-head-init.js')
style   = rd('02-style.css')
appjs   = rd('04-app.js')

if shell.count(SLOT) != 3:
    sys.exit('骨架里的占位符数量不对：%d（应为 3）' % shell.count(SLOT))

out = shell
for piece in [
    '<script>' + hinit + '</script>',
    '<style>' + style + '</style>',
    '<script>' + appjs + '</script>',
]:
    out = out.replace(SLOT, piece, 1)

# 逐字节校验
got = hashlib.sha256(out.encode('utf-8')).hexdigest()
want_path = os.path.join(SRC, 'ORIGIN_SHA256.txt')
want = io.open(want_path, encoding='ascii').read().strip() if os.path.exists(want_path) else None

io.open(OUT, 'w', encoding='utf-8', newline='').write(out)
print('已写出 %s' % os.path.relpath(OUT, ROOT))
print('  大小 %d 字节 / %d 行' % (len(out.encode('utf-8')), out.count(chr(10)) + 1))

if want:
    print('  sha256 = %s' % got)
    print('  期望   = %s' % want)
    if got != want:
        sys.exit('!!! 拼接产物与拆分前不一致，已写出但请立即回滚 !!!')
    print('  ✓ 逐字节一致')
else:
    print('  (没有 ORIGIN_SHA256.txt，跳过校验)')
