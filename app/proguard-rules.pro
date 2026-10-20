# OkHttp / MLKit 保留
-dontwarn org.conscrypt.**
-keepclassmembers class * { @android.webkit.JavascriptInterface <methods>; }

# JS 桥必须整体保留。
#
# 只写 -keepclassmembers 是不够的：R8 full mode 下如果类本身
# 没有被显式 keep，成员照样会被删。之前 log / logBatch 就是这么
# 消失的——dex 里连字符串常量都没了，前端调用静默失败。
-keep class com.yjb.lite.JsBridge { *; }
-keep class com.yjb.lite.MainActivity { *; }
