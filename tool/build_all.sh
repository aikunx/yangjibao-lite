#!/bin/bash
#
# 一键构建 + 签名 + 校验。
#
# 两个必须保留的保险（都是踩过坑加上的）：
#   1. 开跑前删掉旧的产物。gradle 失败时后面的步骤找不到文件会立刻报错，
#      而不是拿上一次的 APK 去签名 —— 那会签出一个"看起来成功、其实是旧版"
#      的包，装到手机上根本看不到新改动。
#   2. gradle 退出码非 0 立即 exit，不再往下走。
#
set -o pipefail
cd /d/work/yjb_lite || exit 1
export JAVA_HOME='D:\\tools\\jdk-21.0.12.1+1'
export ANDROID_HOME='D:\\tools\\android-sdk'
BT=/d/tools/android-sdk/build-tools/35.0.0
SRC=app/src/main/assets/index.html
UNS=app/build/outputs/apk/release/app-release-unsigned.apk
ALIGNED=app/build/outputs/apk/release/app-release-aligned.apk

echo "### source index.html"
sha256sum "$SRC"
wc -c "$SRC"

echo "### 源码拼接（src/ -> assets/index.html）"
python tool/concat.py || { echo "!!!!! 拼接失败，中止 !!!!!"; exit 1; }
echo ""

echo "### 清理旧产物（防止失败时误签旧包）"
rm -f "$UNS" "$ALIGNED" yjblite.apk

echo "### gradle assembleRelease"
D:/tools/gradle/gradle-8.7/bin/gradle.bat --no-daemon assembleRelease 2>&1 | tail -50
GRADLE_RC=${PIPESTATUS[0]}
echo "### gradle exit: $GRADLE_RC"
if [ "$GRADLE_RC" != "0" ]; then
  echo "!!!!! GRADLE FAILED — 已中止，不签名 !!!!!"
  exit 1
fi
[ -f "$UNS" ] || { echo "!!!!! 没有产出 APK — 中止 !!!!!"; exit 1; }

echo "### zipalign"
"$BT/zipalign.exe" -P 16 -f 4 "$UNS" "$ALIGNED" && echo "zipalign ok"

echo "### sign"
"$BT/apksigner.bat" sign --ks yjb.jks --ks-pass pass:yjb123456 --key-pass pass:yjb123456 --out yjblite.apk "$ALIGNED" && echo "sign ok"

echo "### verify"
"$BT/apksigner.bat" verify --print-certs yjblite.apk 2>&1 | head -8

echo "### APK size"
ls -la yjblite.apk

echo "### index.html inside APK vs source"
unzip -p yjblite.apk assets/index.html > /tmp/dshsess/apk_index.html
sha256sum /tmp/dshsess/apk_index.html
if cmp -s "$SRC" /tmp/dshsess/apk_index.html; then
  echo "ASSET MATCH: OK"
else
  echo "ASSET MATCH: MISMATCH — APK 里的页面和源码不一致，别装！"
  exit 1
fi
echo "### DONE"