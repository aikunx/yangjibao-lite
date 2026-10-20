plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.yjb.lite"
    compileSdk = 35
    buildToolsVersion = "35.0.0"

    defaultConfig {
        applicationId = "com.yjb.lite"
        minSdk = 24
        targetSdk = 35
        versionCode = 1
        versionName = "1.0"

        // 只保留真机用的 ABI。
        // 之前打了 4 个 ABI，x86/x86_64 的 OCR 模型占 23MB，手机上完全用不到。
        // arm64-v8a 覆盖近几年所有手机；armeabi-v7a 兼容极老的 32 位设备。
        ndk {
            abiFilters += listOf("arm64-v8a", "armeabi-v7a")
        }
    }

    /**
     * 16KB 页大小适配（Android 15+；Google Play 2025-11 起强制）。
     *
     * 两件事必须同时满足：
     *   1. ELF 的 PT_LOAD 段按 16KB 对齐  -> 由依赖库本身决定，arm64 版 ML Kit 已满足
     *   2. APK 里 .so 的数据偏移按 16KB 对齐 -> 由打包与签名保证
     *
     * useLegacyPackaging=false 让 .so 保持未压缩存储，
     * 这样安装时可以直接 mmap，不必先解压到 /data，启动更快、更省空间。
     */
    packaging {
        jniLibs {
            useLegacyPackaging = false
        }
    }

    // 用 v2 签名方案时，zipalign 必须按 16KB 对齐 .so，
    // 否则 16KB 页设备上会因 mmap 失败而崩溃。
    // 这里通过 AGP 的 zip64 / 对齐选项处理，最终由 apksigner 保证。
    androidResources {
        noCompress += listOf("so")
    }

    /**
     * Play 金标（Play App Quality / 大型屏幕与最新系统适配）相关项：
     *   - targetSdk 35：满足 2025 年 target API 要求
     *   - 关闭无用资源压缩误删（shrinkResources 已开）
     *   - 只保留真实设备 ABI，避免安装包冗余
     */

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro",
            )
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
    buildFeatures { viewBinding = true }
}

dependencies {
    // 基准配置文件安装器：
    // 安装时把 baseline-prof.txt 里的规则交给 ART 做 AOT 编译，
    // 官方实测能让冷启动与首次交互提速约 30%。
    implementation("androidx.profileinstaller:profileinstaller:1.4.1")

    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("com.google.android.material:material:1.12.0")
    implementation("androidx.recyclerview:recyclerview:1.3.2")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.8.4")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.8.1")

    // 网络
    implementation("com.squareup.okhttp3:okhttp:4.12.0")

    // 已移除：
    //   androidx.room        仅被 data/AppDb.kt 使用，而 data/** 是零引用的死代码
    //   mlkit text-recognition-chinese
    //                        仅用于「截图导入持仓」的本地 OCR。
    //                        它的 native 库 + 模型占 APK 的 79.8%（19.8MB），
    //                        而该功能已确认不再需要，整条链路一并移除。
}
