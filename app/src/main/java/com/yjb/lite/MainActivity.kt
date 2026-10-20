package com.yjb.lite

import android.annotation.SuppressLint
import android.content.pm.ApplicationInfo
import android.content.res.Configuration
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.view.ViewGroup
import android.webkit.ConsoleMessage
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import androidx.appcompat.app.AppCompatActivity

/**
 * 单 Activity 承载两层 WebView：
 *
 *   1. 主 WebView —— assets/index.html，全部 UI 与业务逻辑
 *   2. 阅读 WebView —— 打开资讯原文时叠加在上面，用系统自带内核渲染
 *
 * 阅读层存在的意义：很多资讯站的正文要执行 JS 才出现，
 * 或者做了防盗链 / 反爬（纯 HTTP 抓取只拿到骨架）。
 * 直接用手机自带的 WebView 打开，就是「App 内打开」的真实环境，
 * 既不跳外部浏览器，也拿得到完整正文。
 *
 * 阅读层还会注入一段 CSS，去掉登录框、评论、下载条、广告位，
 * 只留标题与正文，做到「纯净阅读」。
 */
class MainActivity : AppCompatActivity() {

    private lateinit var root: FrameLayout
    private lateinit var webView: WebView
    private var reader: WebView? = null
    private var readerBox: android.widget.LinearLayout? = null
    private lateinit var bridge: JsBridge

    /** 当前是否深色主题，供阅读层顶栏配色。 */
    private var isDark: Boolean = false

    /** 主线程消息队列。30 秒后那次补校准挂在它上面，onDestroy 要能撤掉。 */
    private val mainHandler = Handler(Looper.getMainLooper())

    /** 冷启动 30 秒后补一次时间校准（只读响应头 Date，失败无副作用）。 */
    private val delayedSync = Runnable { runCatching { bridge.syncTime() } }

    /**
     * 渲染进程是否还活着（N3）。
     *
     * onRenderProcessGone 之后 WebView 实例就作废了：这时再
     * evaluateJavascript 不会回调，返回键会变成「点了没反应」。
     * 这个字段用来判断还能不能「问页面」。
     */
    @Volatile
    private var rendererAlive = true

    /** 主文档加载失败时盖在 WebView 上的原生错误页（N3）。 */
    private var errorPage: android.widget.LinearLayout? = null

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        /*
         * N5：远程调试只在 debug 构建开。
         *
         * 原来是无条件 true：任何接过 USB 的主机打开 chrome://inspect
         * 就能往页面里注入 JS——读走持仓 / 自选 / 分组（全在 JS 的
         * localStorage 里），还能直接调 Native.httpGet（带 App 的
         * Referer/UA 任意取数）和 writeLogText（写文件）。这是理财工具，
         * 数据本身就是资产信息。
         *
         * 这里刻意不用 BuildConfig.DEBUG：本模块没有开
         * buildFeatures.buildConfig，release dex 里不存在
         * Lcom/yjb/lite/BuildConfig;（已用二进制反查确认），
         * 引用它会直接编译失败。FLAG_DEBUGGABLE 与 BuildConfig.DEBUG
         * 语义完全等价，且不依赖构建配置。
         */
        if (isDebuggableBuild()) {
            WebView.setWebContentsDebuggingEnabled(true)
        }

        root = FrameLayout(this)

        // 先给根容器上底色，避免 WebView 首帧未绘制时闪白屏
        root.setBackgroundColor(
            if (isSystemDark()) 0xFF0E1116.toInt() else 0xFFF2F4F7.toInt()
        )

        webView = createMainWebView()

        bridge = JsBridge(this, webView, this)
        webView.addJavascriptInterface(bridge, "Native")

        root.addView(
            webView,
            FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT,
            ),
        )
        setContentView(root)

        /*
         * 状态栏避让。
         *
         * targetSdk 35 起系统强制 edge-to-edge：窗口内容会一直画到
         * 状态栏底下，WebView 顶部那一截就被时间和电池图标盖住了。
         * 这里给 WebView 补上状态栏高度的上内边距，内容从头开始排。
         *
         * 底部导航栏不补——页面里的 env(safe-area-inset-bottom)
         * 已经在处理，重复补会把内容顶得太高。
         */
        /*
         * 关键：让系统栏重新占位。
         * API 35 默认 edge-to-edge，窗口内容会一直画到状态栏底下
         * （用户说的「显示入侵到状态栏里面」就是这个）。
         * 这里把 decorFitsSystemWindows 设回 true，恢复老行为：
         * 窗口只占系统栏之外的区域。
         */
        androidx.core.view.WindowCompat.setDecorFitsSystemWindows(window, true)

        androidx.core.view.ViewCompat.setOnApplyWindowInsetsListener(root) { _, insets ->
            val top = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                insets.getInsets(android.view.WindowInsets.Type.statusBars()).top
            } else {
                @Suppress("DEPRECATION")
                insets.systemWindowInsetTop
            }
            if (webView.paddingTop != top) {
                webView.setPadding(0, top, 0, 0)
            }
            insets
        }
        androidx.core.view.ViewCompat.requestApplyInsets(root)

        webView.loadUrl(ASSET_URL)

        setupBackHandler()

        // 启动即预热连接：等用户点开行情页时 TLS 已经握好
        bridge.warmUp()

        /*
         * 强制时间校准。
         *
         * 手机时钟不准会连带一串问题：
         *   交易时段判断错  -> 该刷新的时候不刷
         *   净值日期对比错  -> 当日盈亏算成 0
         *   时间戳显示错
         *
         * 所以启动就校，失败自动重试，之后每小时再对一次。
         */
        bridge.syncTime()
        /*
         * N7：延迟任务挂到字段上。
         * 原来每次 new 一个匿名 Handler + 匿名 Runnable，onDestroy 里
         * 既没有引用也没 removeCallbacks：冷启动后 30 秒内退出 Activity，
         * 已销毁的实例会被主线程消息队列按着最长 30 秒，期间还在
         * 已死的实例上发一次网络请求（经 bridge → activity/webView）。
         */
        mainHandler.postDelayed(delayedSync, 30_000)
    }

    // ------------------------------------------------- 主 WebView 的创建 / 重建

    /**
     * 创建（或重建）主 WebView。
     *
     * 单独抽成函数，是因为渲染进程被杀（onRenderProcessGone）之后必须
     * 换一个**全新实例**——旧实例在回调返回后已经作废，继续用就是
     * 永久纯色白屏。重建时走同一个函数，保证设置项、客户端、桥定一致。
     */
    @SuppressLint("SetJavaScriptEnabled")
    private fun createMainWebView(): WebView = WebView(this).apply {
        setBackgroundColor(
            if (isDark || isSystemDark()) 0xFF0E1116.toInt() else 0xFFF2F4F7.toInt()
        )

        settings.javaScriptEnabled = true
        settings.domStorageEnabled = true
        /*
         * N5：收紧到「加载 assets 所需要的最小集」。
         *
         * allowFileAccess 只影响普通 file:// 路径。官方文档写得很清楚：
         * 「this enables or disables file system access only. Assets and
         * resources are still accessible using file:///android_asset and
         * file:///android_res」。所以关掉它不影响
         * file:///android_asset/index.html 的加载（而且 targetSdk>=30
         * 的默认值本来就是 false），却堵死了页面用 file:// 读任意
         * 本地文件这条通道。
         */
        settings.allowFileAccess = false
        settings.allowContentAccess = false
        settings.cacheMode = android.webkit.WebSettings.LOAD_DEFAULT
        /*
         * N5：原来是 MIXED_CONTENT_ALWAYS_ALLOW。
         * 本页只从 assets 加载，所有取数都走 Native.httpGet（OkHttp），
         * WebView 自身没有任何混合内容（唯一一个明文源
         * http://212.129.244.148:8890 是 JS 字符串，走的也是 httpGet）。
         * 退回平台默认的 COMPATIBILITY_MODE 即可，万一以后真有
         * https 页面里的 http 静态资源也不会被硬掐。
         */
        settings.mixedContentMode =
            android.webkit.WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE

        /*
         * P1：固定 textZoom = 100，不再跟随系统字号。
         *
         * 原来是 (100 * fontScale).coerceIn(85, 130)。但页面是 px 定死的
         * 布局（--fs-xs:11px、.appbar{height:54px}、nav{height:64px}），
         * textZoom 放大的是**文字渲染字号**，跟容器 px 高度毫无关系：
         * 系统字号 130% 时 tab 文案 11px→14.3px、标题 20px→26px，
         * 容器不变，先溢出的地方取决于机型宽度。
         * 字号可访问性由页面自己的设置项负责，不由系统字号直接改版式。
         */
        settings.textZoom = 100

        // 支持双指缩放：图表、K 线看得更清
        settings.setSupportZoom(true)
        settings.builtInZoomControls = true
        settings.displayZoomControls = false
        settings.blockNetworkImage = false

        webViewClient = mainWebViewClient()

        webChromeClient = object : WebChromeClient() {
            override fun onConsoleMessage(msg: ConsoleMessage?): Boolean {
                if (msg == null) return true
                Log.i(TAG, "[js] " + msg.message() + " @" + msg.lineNumber())
                return true
            }
        }
    }

    /**
     * 主 WebView 的客户端。
     *
     * 原来只有 onPageFinished / onReceivedError 各打一行日志，这里补三件事：
     *   1. onRenderProcessGone  —— 渲染进程被杀后重建，防永久白屏（N3）
     *   2. 主文档加载失败 → 原生错误页 + 重试按钮（N3）
     *   3. shouldOverrideUrlLoading —— 只放行本地 assets 与 https（N5）
     */
    private fun mainWebViewClient(): WebViewClient = object : WebViewClient() {
        override fun onPageFinished(view: WebView?, url: String?) {
            super.onPageFinished(view, url)
            Log.i(TAG, "page finished: " + url)
        }

        override fun onReceivedError(
            view: WebView?,
            request: WebResourceRequest?,
            error: android.webkit.WebResourceError?,
        ) {
            Log.e(
                TAG,
                "resource error: " + request?.url + " -> " + error?.description
            )
            // 子资源失败不打扰用户（和阅读层同一策略）
            if (request == null || !request.isForMainFrame) return
            val desc = error?.description?.toString() ?: ""
            /*
             * 重定向、或被一次新的导航打断时，WebView 也会报一次
             * 「主文档错误」（net::ERR_ABORTED）。那不是加载失败，
             * 弹错误页属于误伤，这里忽略。
             */
            if (desc.contains("ERR_ABORTED")) return
            showErrorPage(desc)
        }

        /**
         * N5：主 WebView 只允许两类主框架导航——本地 assets 与 https。
         * 其余（http 明文、content://、intent://、站外 file://、自定义
         * scheme）一律拦掉并记日志。
         *
         * 已全量 grep 确认 index.html 里没有任何 location.href /
         * window.open / <a href，正文 HTML 也会剥掉 <a>，所以拦掉
         * 不影响现有功能；「用系统浏览器打开链接」走的是
         * Native.openUrl（ACTION_VIEW），根本不经过 WebView。
         */
        override fun shouldOverrideUrlLoading(
            view: WebView?,
            request: WebResourceRequest?,
        ): Boolean {
            val u = request?.url?.toString() ?: return false
            val allow = u.startsWith("file:///android_asset/") || u.startsWith("https://")
            if (!allow) Log.w(TAG, "blocked navigation: " + u)
            return !allow
        }

        /**
         * N3：渲染进程被杀（OOM / 内核崩溃）时必须处理。
         *
         * Android 官方规定：不处理这个回调时，回调返回后 WebView 实例
         * 就作废了——页面变纯色、触摸无反应，用户只能从最近任务里
         * 划掉重开。而且必须 return true；返回 false 系统会直接杀进程。
         */
        override fun onRenderProcessGone(
            view: WebView?,
            detail: RenderProcessGoneDetail?,
        ): Boolean {
            Log.e(TAG, "main renderer gone, didCrash=" + (detail?.didCrash() ?: false))
            onMainRendererGone(view)
            return true
        }
    }

    /**
     * N3：主 WebView 的渲染进程没了，就地重建。
     *
     * 不能用「拿旧实例重新 loadUrl」——回调之后它已经作废。
     * 必须：摘出视图 → destroy → 新建 → 重新 addJavascriptInterface
     * → 重新 loadUrl。
     */
    private fun onMainRendererGone(dead: WebView?) {
        rendererAlive = false
        // 阅读层（如果开着）与主 WebView 是同一个渲染进程，必然一起死
        runCatching { closeReader() }
        if (dead != null) {
            runCatching { (dead.parent as? ViewGroup)?.removeView(dead) }
            runCatching { dead.destroy() }
        }
        if (isFinishing || isDestroyed) return
        // 现在还在 onRenderProcessGone 的调用栈里，挪到下一条消息再建更稳
        root.post { rebuildMainWebView() }
    }

    private fun rebuildMainWebView() {
        if (isFinishing || isDestroyed) return
        // 极端情况：渲染进程在 onCreate 里 bridge 赋值之前就崩了
        if (!::bridge.isInitialized) return
        // 重建后错误页就不再适用了；留着它还会让 errorPage 字段非空，
        // 导致以后真正加载失败时弹不出错误页
        hideErrorPage()
        val fresh = createMainWebView()
        /*
         * 两处「挂桥」缺一不可：
         *   addJavascriptInterface 让 JS 能调 Native.*
         *   bridge.attachWebView 让 Native.* 的回调还能回到新页面
         * 少后者的话，httpGet / pickImage 的 reply 会打到已销毁的
         * WebView 上，JS 侧 promise 永久 pending。
         */
        fresh.addJavascriptInterface(bridge, "Native")
        bridge.attachWebView(fresh)
        webView = fresh
        rendererAlive = true
        root.addView(
            fresh,
            FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT,
            ),
        )
        // 新实例还没有状态栏内边距，重新走一次 insets 分发
        androidx.core.view.ViewCompat.requestApplyInsets(root)
        fresh.loadUrl(ASSET_URL)
        Log.w(TAG, "main webview rebuilt after renderer gone")
    }

    /**
     * N3：主文档加载失败时的原生错误页。
     *
     * 原来只有一行 Log.e，用户看到的是纯色空屏、没有任何重试入口。
     * 用原生 View 盖在 WebView 上，不依赖 WebView 本身还画得出来。
     * 颜色跟系统深浅色对齐（此时 JS 还没跑起来，拿不到页面内主题）。
     */
    private fun showErrorPage(reason: String) {
        if (errorPage != null || isFinishing || isDestroyed) return
        runCatching {
            val dark = isDark || isSystemDark()
            val box = android.widget.LinearLayout(this).apply {
                orientation = android.widget.LinearLayout.VERTICAL
                gravity = android.view.Gravity.CENTER
                setBackgroundColor(if (dark) 0xFF0E1116.toInt() else 0xFFF2F4F7.toInt())
                // 吃掉点击，避免穿透到底下已经失效的 WebView
                isClickable = true
            }
            val title = android.widget.TextView(this).apply {
                text = "页面加载失败"
                textSize = 17f
                gravity = android.view.Gravity.CENTER
                setTextColor(if (dark) 0xFFE9EDF2.toInt() else 0xFF15181D.toInt())
            }
            val sub = android.widget.TextView(this).apply {
                text = reason.ifBlank { "未知错误" }
                textSize = 12.5f
                gravity = android.view.Gravity.CENTER
                setTextColor(0xFF8A919C.toInt())
                setPadding(dp(24), dp(10), dp(24), dp(22))
            }
            // 用 AppCompatButton 而不是 android.widget.Button：主题是
            // Theme.Material3.DayNight，AppCompatButton 对 buttonStyle 的
            // 解析是 AppCompat 自己处理的，不会踩 Material 主题的坑
            val retry = androidx.appcompat.widget.AppCompatButton(this).apply {
                text = "重新加载"
                setOnClickListener {
                    hideErrorPage()
                    rendererAlive = true
                    webView.loadUrl(ASSET_URL)
                }
            }
            box.addView(title)
            box.addView(sub)
            box.addView(retry)
            errorPage = box
            root.addView(
                box,
                FrameLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.MATCH_PARENT,
                ),
            )
        }
    }

    /**
     * 撤掉错误页。
     *
     * 只在两个地方调：点「重新加载」时、重建 / 销毁时。
     * 刻意不挂在 onPageStarted/onPageFinished 上——主文档失败后 WebView
     * 自己会提交一张内核错误页并再报一次 onPageFinished，挂在上面
     * 会把刚显示的错误页立刻抹掉。
     */
    private fun hideErrorPage() {
        val v = errorPage ?: return
        errorPage = null
        runCatching { root.removeView(v) }
    }

    // ------------------------------------------------------------ 阅读层



    /**
     * 原生阅读层已移除。
     *
     * 它原本用第二个 WebView 加载原页面、再注入 Readability 抽正文。
     * 但 index.html 从来不调 Native.openReader（实测调用次数 = 0），
     * 整条链路不可达；而它依赖的 assets/readability.js 与 extract.js
     * 也已删除（Readability 现在是内联进 index.html 的）。
     *
     * 保留签名而不动调用点：返回键分发、生命周期里都有
     * 「reader 非空就先关阅读层」的分支，删签名会连带改一堆
     * 与本次优化无关的结构，风险不值当。
     */
    fun openReader(url: String): Boolean = false

    private fun dp(v: Int): Int =
        (v * resources.displayMetrics.density).toInt()

    fun closeReader() {}


    /**
     * 返回键分发。
     *
     * 页面自己的「返回上一页」逻辑在 JS 的 nav 栈里。
     * evaluateJavascript 是异步的，直接用它会出现「按一下回桌面」；
     * 所以改成：JS 每次渲染后把「当前能否返回」同步写进 bridge 的字段，
     * 原生按返回键时只读这个字段，立刻就能决定是页面内后退还是退出 App。
     */
    /** 由 JS 调用：切换主题时同步阅读层配色与系统栏。 */
    fun applyTheme(dark: Boolean) {
        isDark = dark

        val bg = if (dark) 0xFF0A0D12.toInt() else 0xFFF4F6F9.toInt()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.VANILLA_ICE_CREAM) {
            // API 35 起系统栏完全透明，颜色靠窗口背景，不再设 statusBarColor
            window.decorView.setBackgroundColor(bg)
        } else {
            @Suppress("DEPRECATION")
            run {
                window.statusBarColor = bg
                window.navigationBarColor = bg
            }
        }

        /*
         * 图标明暗必须跟着主题走。
         *
         * 之前只改了背景色没改图标色：深色主题下背景是深色，
         * 图标还是深色，时间和电量直接看不见——用户说的
         * 「状态栏异常」就是这个。
         *
         * isAppearanceLightStatusBars = true 表示「用深色图标」，
         * 所以浅色主题要 true，深色主题要 false。
         */
        runCatching {
            val c = androidx.core.view.WindowInsetsControllerCompat(window, window.decorView)
            c.isAppearanceLightStatusBars = !dark
            c.isAppearanceLightNavigationBars = !dark
        }
    }

    /**
     * 回到前台时让页面补一次刷新。
     *
     * WebView 的 visibilitychange 在部分机型上不可靠，
     * 这里直接从生命周期兜底：用户切回来看到的一定是最新数据。
     */
    override fun onResume() {
        super.onResume()

        // 恢复 WebView：在后台时我们主动挂了暂停，回来要接上
        runCatching { webView.onResume() }
        runCatching { webView.resumeTimers() }

        // 前台给最高渲染优先级：高刷屏上动画才跟得上
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            runCatching {
                webView.setRendererPriorityPolicy(
                    WebView.RENDERER_PRIORITY_IMPORTANT, false
                )
            }
        }

        webView.post {
            runCatching { webView.evaluateJavascript("window.__onAppResume&&window.__onAppResume()", null) }
        }
    }

    /**
     * 退到后台就停掉 WebView。
     *
     * 这台机器的屏幕是 120/144Hz 可变刷新率，WebView 在后台继续跑
     * 定时器和合成器是实打实的耗电。onPause + pauseTimers 会把
     * JS 定时器和渲染一起挂起，回到前台再恢复，用户在后台的
     * 那段时间几乎不耗电。
     *
     * 注意 pauseTimers 是进程级的，本 App 只有这两个 WebView，
     * 阅读层在挂在后台时本来就会被关掉，所以没有副作用。
     */
    override fun onPause() {
        super.onPause()
        /*
         * 兜底清理返回手势留下的状态。
         *
         * 用户可能在手势中途（比如被来电、被手势导航打断）切走，
         * 这时 onBackInvoked / onBackCancelled 都不一定会来。
         * 盖图是加在 root 上的，留在那里会挡住整个界面，
         * 而且 backBusy 卡在 true 会让后续所有清理路径失效。
         */
        backGestureActive = false
        pendingBackState = null
        backBusy = false
        runCatching { endBackPreview() }

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            runCatching {
                webView.setRendererPriorityPolicy(
                    WebView.RENDERER_PRIORITY_BOUND, true
                )
            }
        }
        /*
         * 后台彻底降载。
         *   onPause      暂停 WebView 的渲染与 JS 的 rAF
         *   pauseTimers  挂起所有定时器（进程级）
         *   clearCache   不主动清，留热缓存给下次启动提速
         */
        runCatching { webView.onPause() }
        runCatching { webView.pauseTimers() }
        /*
         * N8：这里原来还有一段「停掉 CSS 动画」——
         *   document.documentElement.style.setProperty(
         *       'animation-play-state','paused')
         * 它是无效的：animation-play-state 不是可继承属性，写在 <html>
         * 上只影响 <html> 自身，页面里真正在跑的动画（骨架屏 shimmer、
         * 进度条、主题过渡）一个都不会停；而且它紧跟在 pauseTimers()
         * 之后执行，时机本身也不可靠。后台降载已经由上面的
         * onPause + pauseTimers 完成，所以整段删掉，免得后来者误以为
         * 「后台动画已经处理过了」。
         */
    }

    /**
     * 返回处理。Android 13 起走新的预测型返回通道。
     *
     * 老写法 OnBackPressedCallback 在 Android 13+ 上拿不到系统级的
     * 「侧滑跟手」动画——手势进行到一半时系统需要知道这次返回会不会
     * 真的发生，才能把页面跟着手指推开。只有注册 OnBackInvokedCallback
     * 并把 enableOnBackInvokedCallback 打开，系统才会做那个效果。
     *
     * 我们这边只要保证 bridge.canGoBack 是实时的（JS 每次渲染都同步），
     * 系统就能在手指刚按下时判断出「能不能退」，动画自然跟手。
     */

    // ------------------------------------------------ 预测性返回
    //
    // Android 13 起系统提供了「返回手势进行中」的回调通道。
    // 以前只在手势结束时才处理，用户滑到一半看不到任何反馈。
    //
    // 这里做两件事：
    //
    //   1. 能返回页面时（栈里有上一页）注册跟手回调，
    //      手势过程中把当前页做成一张静态图跟着手指走，
    //      底下露出上一层页面，滑回原位能平滑取消。
    //
    //   2. 已经在首页、没有可返回的页面时，主动注销回调，
    //      把这次滑动完整交还给系统，让系统播放「退出 App」动画。
    //      这一条很关键：一直占着回调不放，系统就永远不做退出的
    //      预测动画，用户会觉得「滑了没反应，只能干等它关」。
    //
    // 动画操作的是截图位图，不是 WebView 本体。
    // 让真实 WebView 跟着缩放平移会强制它每帧重绘，
    // 高刷屏上反而更卡；在顶层推一张图，帧率是稳的。

    private var backOverlay: android.widget.ImageView? = null

    /** 盖图的识别标记，用于兜底清理（见 beginBackPreview） */
    private val OVERLAY_TAG = "yjb_back_overlay".hashCode()

    /**
     * 退场动画是否正在播放。
     * 播放期间禁止任何"立刻移除盖图"的操作（见 endBackPreview）。
     */
    private var backBusy = false

    /** 系统的返回手势是否正在进行中（onBackStarted 到 onBackInvoked/Cancelled） */
    private var backGestureActive = false

    /** 手势期间 JS 同步过来的 canGoBack，等手势结束再应用，避免切断手势链路 */
    private var pendingBackState: Boolean? = null

    /**
     * 这次返回手势的方向。
     *   +1 = 从左边缘往右滑（页面向右推出）
     *   -1 = 从右边缘往左滑（页面向左推出）
     * Android 的返回手势两侧都支持，动画方向必须跟着走，
     * 否则从右边滑进来页面却往右跑，看着像「往回弹」。
     */
    private var backEdgeSign = 1f
    private var backRegistered = false
    private var backCallback: Any? = null

    /** API<33 用的旧返回回调句柄，退出时要临时禁用再派发。 */
    private var legacyBackCallback: androidx.activity.OnBackPressedCallback? = null

    /** JS 侧同步过来的「当前页能否返回」，一变就重挂回调 */
    fun onBackStateChanged(canGoBack: Boolean) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return

        /*
         * 手势进行中绝不改回调的注册状态。
         *
         * 因为 onBackStarted 里我们会**立刻执行一次返回**让 WebView 渲染
         * 目标页，JS 换完页必然同步一次 canGoBack=false。
         * 如果此刻真的去 unregisterOnBackInvokedCallback()，
         * 系统会判定「这次手势被取消了」，转头调 onBackCancelled ——
         * 我们只好把页面回滚。用户看到的就是：
         * 边缘划了一下，盖图推出去又弹回来，什么都没发生。
         *
         * 所以先把值记下来，等手势真正结束再应用。
         */
        if (backGestureActive) {
            pendingBackState = canGoBack
            return
        }
        if (canGoBack) registerBackCallback() else unregisterBackCallback()
    }

    /** 手势结束后把积压的回调状态应用上去 */
    private fun applyPendingBackState() {
        backGestureActive = false
        val p = pendingBackState
        pendingBackState = null
        if (p != null) onBackStateChanged(p)
    }

    /** 能否做跟手预览（API 34+ 才有进度回调） */
    private val canAnimateBack: Boolean
        get() = Build.VERSION.SDK_INT >= 34

    private fun registerBackCallback() {
        if (backRegistered) return
        val d = onBackInvokedDispatcher
        if (canAnimateBack) {
            val cb = object : android.window.OnBackAnimationCallback {
                /*
                 * 手势开始。
                 *
                 * 顺序很关键：
                 *   1) 先同步把当前页截成图盖上去 —— 这一步是同步的，
                 *      用户还没看到任何变化；
                 *   2) 再调 JS 真的执行一次返回，让 WebView 渲染出**目标页**。
                 *      evaluateJavascript 是异步的，等它跑完时盖图已经在了。
                 *
                 * 这样一来，接下来盖图跟手平移时，底下露出来的就是
                 * 货真价实的目标页，而不是「同一页叠两层」。
                 */
                override fun onBackStarted(backEvent: android.window.BackEvent) {
                    backEdgeSign = edgeSignOf(backEvent)

                    // 截图没成功就什么都别做，否则用户会看到「哗」一下直接换页。
                    // 这种情况下 onBackInvoked 会走 playBackExit 的兜底分支正常返回。
                    if (!beginBackPreview()) return

                    // 从这里到手势结束，onBackStateChanged 只记录不生效
                    backGestureActive = true
                    pendingBackState = null

                    webView.evaluateJavascript(BEGIN_BACK_JS) { ret ->
                        // 页面明确表示这次返回它不消费（理论上与 canGoBack 同步，
                        // 不该出现）：撤掉盖图，让 playBackExit 走兜底分支
                        if (ret != "true") {
                            backBusy = false
                            endBackPreview()
                        }
                    }
                }

                override fun onBackProgressed(backEvent: android.window.BackEvent) {
                    updateBackPreview(backEvent.progress)
                }

                /*
                 * 手势提交：页面在 onBackStarted 时就已经切过去了，
                 * 这里只需要把盖图滑出去，露出已经就位的目标页。
                 * 绝不能再调一次 performBack()，那会返回两次。
                 */
                override fun onBackInvoked() {
                    webView.evaluateJavascript(COMMIT_BACK_JS, null)
                    playBackExit()
                    /*
                     * 延后一帧再应用积压状态。
                     * 此刻我们还站在系统的回调栈里，就地注销自己容易出问题；
                     * 而且退场动画要先把 backBusy 用起来，注销触发的
                     * endBackPreview() 正好会被它挡掉，不会打断动画。
                     */
                    webView.post { applyPendingBackState() }
                }

                /* 手势取消：先把页面回滚，再让盖图滑回原位 */
                override fun onBackCancelled() {
                    webView.evaluateJavascript(CANCEL_BACK_JS, null)
                    cancelBackPreview()
                    /*
                     * 手势取消 = 用户还在原来那一页，能返回的状态没变。
                     * 这里直接丢弃积压值（那是「切页之后」的 false，
                     * 已经被回滚作废了），并保持回调注册不动；
                     * JS 回滚完成后自己会再同步一次正确的值。
                     */
                    backGestureActive = false
                    pendingBackState = null
                }
            }
            d.registerOnBackInvokedCallback(
                android.window.OnBackInvokedDispatcher.PRIORITY_DEFAULT, cb
            )
            backCallback = cb
        } else {
            val cb = android.window.OnBackInvokedCallback {
                performBack()
            }
            d.registerOnBackInvokedCallback(
                android.window.OnBackInvokedDispatcher.PRIORITY_DEFAULT, cb
            )
            backCallback = cb
        }
        backRegistered = true
    }

    private fun unregisterBackCallback() {
        if (!backRegistered) return
        val d = onBackInvokedDispatcher
        when (val cb = backCallback) {
            is android.window.OnBackInvokedCallback -> d.unregisterOnBackInvokedCallback(cb)
            is android.window.OnBackAnimationCallback -> d.unregisterOnBackInvokedCallback(cb)
        }
        backCallback = null
        backRegistered = false
        endBackPreview()
    }

    /**
     * 判断这次返回手势是从哪一侧进来的。
     *
     * API 34 起 BackEvent 直接给了 swipeEdge，比用触点猜准得多。
     * API 33 只有 touchX/touchY，就按触点落在屏幕哪半边来近似 ——
     * 返回手势本来就必须从边缘开始，所以这个近似足够可靠。
     */
    private fun edgeSignOf(ev: android.window.BackEvent): Float {
        if (Build.VERSION.SDK_INT >= 34) {
            return when (ev.swipeEdge) {
                android.window.BackEvent.EDGE_RIGHT -> -1f
                else -> 1f
            }
        }
        val mid = webView.width / 2f
        return if (mid > 0f && ev.touchX > mid) -1f else 1f
    }

    /** 手势开始：把当前画面截一张图盖在上面，之后只推这张图 */
    private fun beginBackPreview(): Boolean {
        if (reader != null) return false
        /*
         * 先清掉可能残留的旧盖图。
         *
         * playBackExit() 里的退场动画挂在 WebView 的 postDelayed 上，
         * 万一那一轮 WebView 被 detach（比如刚好看完阅读层回来），
         * 回调就不会执行，盖图会永远留在屏幕上。
         * 这里按 tag 找而不是看 backOverlay 字段 —— 字段可能已经被
         * 置空，但 view 还在 root 上。
         */
        backBusy = false
        backOverlay = null
        root.findViewWithTag<android.view.View>(OVERLAY_TAG)?.let {
            (it.parent as? android.view.ViewGroup)?.removeView(it)
        }
        val v = webView
        if (v.width <= 0 || v.height <= 0) return false

        val bmp = runCatching {
            android.graphics.Bitmap.createBitmap(
                v.width, v.height, android.graphics.Bitmap.Config.ARGB_8888
            ).also { b ->
                val c = android.graphics.Canvas(b)
                // 先刷底色，截图带透明时不会叠出黑边
                c.drawColor(if (isDark) 0xFF0E1116.toInt() else 0xFFF2F4F7.toInt())
                v.draw(c)
            }
        }.getOrNull() ?: return false

        val iv = android.widget.ImageView(this).apply {
            setImageBitmap(bmp)
            scaleType = android.widget.ImageView.ScaleType.MATRIX
            layoutParams = FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT,
            )
            isClickable = true
            tag = OVERLAY_TAG
        }
        root.addView(iv)
        backOverlay = iv
        // 从现在起到盖图被摘掉为止，禁止任何路径把它强行清掉
        backBusy = true
        return true
    }

    /**
     * 手势进行中：按进度推图。
     *
     * progress 0 到 1 对应手指从屏幕边缘滑到触发线。
     *
     * 有一件事必须注意：盖图底下就是 WebView 本体，而它显示的
     * **还是当前这一页**。如果只把盖图推开，用户看到的是
     * 「同一页叠了两层」——上面那层在动，下面那层不动，很出戏。
     *
     * 所以滑动的同时把 WebView 一起淡出：手势期间盖图是唯一的
     * 可见层，等手势提交、WebView 渲染好目标页之后它再显出来
     * （见 playBackExit），那时露出的才是真正的「下一页」。
     */
    private fun updateBackPreview(progress: Float) {
        val iv = backOverlay ?: return
        val pr = progress.coerceIn(0f, 1f)
        val w = iv.width.coerceAtLeast(1)

        iv.translationX = w * 0.30f * pr * backEdgeSign
        val sc = 1f - 0.08f * pr
        iv.scaleX = sc
        iv.scaleY = sc
        iv.alpha = 1f - 0.06f * pr
        // 底下是 onBackStarted 里就渲染好的**目标页**，
        // 不能再把它遮掉 —— 用户要看的就是它。
    }

    /** 手势取消：平滑回到原位，WebView 同时回到不透明 */
    private fun cancelBackPreview() {
        val iv = backOverlay ?: return
        webView.animate().alpha(1f).setDuration(160).start()
        iv.animate()
            .translationX(0f)
            .scaleX(1f)
            .scaleY(1f)
            .alpha(1f)
            .setDuration(180)
            .withEndAction { detachOverlay(iv) }
            .start()
    }

    /**
     * 手势提交：先让 WebView 把「返回后的那一页」渲染好，
     * 再把定格的当前页滑出去 —— 这时露出的才是真正的下一页内容。
     *
     * 时序：
     *   1. WebView 透明（盖图还盖着，用户看不到中间过程）
     *   2. performBack() → JS 跑 nav.onBack() → render() 换页
     *      （render() 走 requestAnimationFrame，一帧之内就画好了）
     *   3. WebView 恢复不透明 → 目标页就位，且被盖图挡着
     *   4. 盖图右滑 + 淡出 → 目标页从底下露出来
     *
     * 原实现是直接 removeView 撤掉盖图，等于「啪」一下换页，
     * 手势里跟手推出来的位移和缩放在最后一帧全被丢掉。
     */
    private fun playBackExit() {
        val iv = backOverlay
        // 没有盖图（比如 beginBackPreview 没成功，或者根本来不及）
        // 就只能老老实实走一次返回
        if (iv == null) { performBack(); return }
        backOverlay = null

        /*
         * 只做一件事：把盖图滑出去。
         *
         * 页面在 onBackStarted 时就已经切成目标页了，
         * 这里既不用再 performBack()（会返回两次），
         * 也不用给 WebView 做淡入淡出 —— 它一直都在，只是被盖着。
         */
        val w = iv.width.coerceAtLeast(1)
        iv.animate()
            .translationX(w * 0.34f * backEdgeSign)
            .alpha(0f)
            .setDuration(170)
            .setInterpolator(android.view.animation.DecelerateInterpolator())
            .withEndAction { detachOverlay(iv) }
            .start()
    }

    /** 把盖图摘下来并释放位图。所有退场路径最后都汇到这里。 */
    private fun detachOverlay(iv: android.widget.ImageView) {
        backBusy = false
        iv.animate().cancel()
        (iv.parent as? android.view.ViewGroup)?.removeView(iv)
        iv.setImageDrawable(null)
        // 兜底：任何路径结束后 WebView 都必须是可见的
        if (!isFinishing && !isDestroyed) webView.alpha = 1f
    }

    /**
     * 强制清理（注销回调 / 页面销毁时用）。
     *
     * 关键：退场动画进行中时**什么都不做**。
     *
     * 因为换页之后 JS 会同步一次 canGoBack（多半变成 false），
     * 那条路会走到 unregisterBackCallback()，而它末尾就是这个函数。
     * 如果无脑把盖图摘掉，playBackExit() 里刚起步的滑出动画会在
     * 几毫秒内被掐死 —— 用户看到的还是「啪一下换页」，
     * 等于动画白做了。
     */
    private fun endBackPreview() {
        /*
         * 手势预览或退场动画进行中时什么都不做。
         *
         * 因为 onBackStarted 里 JS 已经执行过返回，canGoBack 多半变成 false，
         * 那条路会走到 unregisterBackCallback()，而它末尾就是这个函数。
         * 如果无脑把盖图摘掉，跟手位移和退场动画会在几毫秒内被掐死 ——
         * 用户看到的还是「啪一下换页」。
         */
        if (backBusy) return
        val iv = backOverlay ?: run {
            if (!isFinishing && !isDestroyed) webView.alpha = 1f
            return
        }
        backOverlay = null
        detachOverlay(iv)
    }

    /**
     * 真正执行一次返回。
     *
     * N2 加固：`bridge.canGoBack` 是 JS 异步同步过来的值，而打开 /
     * 关闭弹层、进 diag/settings 这些**都不改变 tab 与 nav 栈**，
     * 所以这个字段可能还停在旧值上。此时直接 finish()，用户看到的
     * 就是「点了个操作菜单、按返回，App 直接退到桌面」。
     *
     * 所以 canGoBack 为 false 时不再立刻退出，而是再问一次页面：
     * 这次返回到底会不会被消费（= nav.onBack() 的返回值）？
     * 只有页面明确回答「不消费」才真的 finish。
     * 代价是异步多一帧，但不会误杀。
     */
    private fun performBack() {
        if (reader != null) {
            closeReader()
            return
        }
        // 渲染进程没了的话 evaluateJavascript 不会回调，问页面等于返回键失灵
        if (!rendererAlive || isFinishing || isDestroyed) {
            finish()
            return
        }
        /*
         * 统一「问页面」，不再因为 bridge.canGoBack 为 true 就直接派发且
         * 不看返回值。
         *
         * canGoBack 是 JS 异步同步过来的一个布尔值，而「这次返回会不会被
         * 页面消费」是另一回事：弹层、二级页、设置页……都可能消费它。
         * 原来那条分支是 evaluateJavascript(BACK_JS, null) —— 回调传 null，
         * 页面就算回答「我不消费」，原生也收不到，返回键就彻底失灵。
         *
         * 唯一的快速路径只剩「渲染进程不可用」，那时只能直接退出。
         */
        webView.evaluateJavascript(BACK_JS) { ret ->
            if (ret == null || ret == "null" || ret == "false") finish()
        }
    }

    private fun setupBackHandler() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            // 初始无栈，交给系统处理退出动画
            onBackStateChanged(bridge.canGoBack)
            return
        }

        // Android 13 以下没有预测通道，沿用旧的返回键回调
        val cb = object : androidx.activity.OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (reader != null) {
                    closeReader()
                    return
                }
                // 与 performBack() 完全同一套：渲染进程不可用就直接退，
                // 否则一律问页面，只有页面明确「不消费」才退出。
                if (!rendererAlive || isFinishing || isDestroyed) {
                    exitLegacyBack()
                    return
                }
                webView.evaluateJavascript(BACK_JS) { ret ->
                    if (ret == null || ret == "null" || ret == "false") exitLegacyBack()
                }
            }
        }
        legacyBackCallback = cb
        onBackPressedDispatcher.addCallback(this, cb)
    }

    /** API<33 的退出：沿用原来「禁用回调再派发一次」的写法。 */
    private fun exitLegacyBack() {
        val cb = legacyBackCallback
        if (cb == null) {
            finish()
            return
        }
        cb.isEnabled = false
        onBackPressedDispatcher.onBackPressed()
        cb.isEnabled = true
    }

    /**
     * 系统内存紧张时释放阅读层。
     *
     * 阅读层是第二个 WebView，每个 WebView 实例都很吃内存
     * （渲染进程 + 缓存），在后台时继续留着容易被系统直接杀掉整个进程。
     * 官方建议在 onTrimMemory 的 UI_HIDDEN / RUNNING_LOW 等档位主动释放。
     */
    override fun onTrimMemory(level: Int) {
        super.onTrimMemory(level)
        if (level >= android.content.ComponentCallbacks2.TRIM_MEMORY_UI_HIDDEN) {
            // 界面已不可见，阅读层没必要留着
            closeReader()
        }
        if (level >= android.content.ComponentCallbacks2.TRIM_MEMORY_RUNNING_LOW) {
            runCatching {
                webView.clearCache(false)
            }
        }
        if (level >= android.content.ComponentCallbacks2.TRIM_MEMORY_COMPLETE) {
            closeReader()
            runCatching {
                webView.clearCache(true)
                webView.clearHistory()
            }
        }
    }

    override fun onLowMemory() {
        super.onLowMemory()
        closeReader()
    }

    /** 读系统当前的深浅色设置。 */
    private fun isSystemDark(): Boolean {
        val mode = resources.configuration.uiMode and
            android.content.res.Configuration.UI_MODE_NIGHT_MASK
        return mode == android.content.res.Configuration.UI_MODE_NIGHT_YES
    }

    /** N5：当前是不是可调试构建（等价于 BuildConfig.DEBUG，但不依赖 buildConfig 特性）。 */
    private fun isDebuggableBuild(): Boolean =
        (applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE) != 0

    /**
     * N6：configChanges 里补了 fontScale / locale / colorMode。
     *
     * 改系统字号、语言、色彩模式（HDR 开关）不再重建 Activity——否则
     * WebView 会重新 loadUrl，当前 tab、nav 栈、滚动位置、弹层与
     * 正在填的表单、没完成的 OCR 导入流程**全部消失**，用户被弹回首页，
     * 还要重新拉一遍全部网络数据。
     *
     * 配合 P1：页面是 px 定死的布局，这里把 textZoom 重新钉回 100，
     * 防止系统字号变化把它带跑。密度也可能一起变，重走一次 insets。
     */
    override fun onConfigurationChanged(newConfig: Configuration) {
        super.onConfigurationChanged(newConfig)
        runCatching { webView.settings.textZoom = 100 }
        runCatching { androidx.core.view.ViewCompat.requestApplyInsets(root) }
        Log.i(TAG, "config changed: fontScale=" + newConfig.fontScale)
    }

    /**
     * N7：销毁时把「引用了 Activity 的东西」全部断开。
     *
     * 原来只有 closeReader() + webView.destroy()：root 里还挂着已经
     * destroy 掉的 WebView 视图，30 秒后那次延迟校准也还排在主线程
     * 消息队列里（持有着 bridge → activity → webView）。
     */
    override fun onDestroy() {
        // 先撤掉所有延迟任务，再断其它引用
        mainHandler.removeCallbacksAndMessages(null)
        hideErrorPage()
        closeReader()
        // 取消 JsBridge 的协程作用域，长任务（OCR / 网络）不再持有 Activity
        runCatching { bridge.shutdown() }
        runCatching { webView.stopLoading() }
        runCatching { webView.loadUrl("about:blank") }
        runCatching { webView.removeJavascriptInterface("Native") }
        runCatching { (webView.parent as? ViewGroup)?.removeView(webView) }
        runCatching { webView.destroy() }
        runCatching { root.removeAllViews() }
        super.onDestroy()
    }

    companion object {
        private const val TAG = "YjbWeb"

        /** 唯一入口页面。所有 loadUrl 都走这个常量，避免多处硬编码漂移。 */
        private const val ASSET_URL = "file:///android_asset/index.html"

        /**
         * 返回键的最终裁决脚本。
         *
         * 返回 true  = 这次返回被页面消费了（弹层关了 / 退了一层 /
         *              切回了持仓页），原生不要退出；
         * 返回 false = 页面不管，原生可以退出 App。
         *
         * 只认 window.__onSystemBack —— 那是 JS 侧显式挂到 window 上的
         * 唯一入口。
         *
         * 这里踩过一个很隐蔽的坑，别再改回去：
         * 页面里 nav 是用 const 声明的，属于全局**词法**绑定，
         * 只存在于全局词法环境，不是 window 的属性。
         * 老脚本写的是 window.nav && nav.onBack() —— window.nav 恒为
         * undefined，整句被跳过，然后照样 return true，
         * 向原生谎称「这次返回我消费了」，实际什么都没做：
         * 二级页按返回没反应，首页按返回也退不出去。
         *
         * 整段包在 try 里，页面还没加载完（函数还没定义）时返回 false，
         * 语义正好是「首屏按返回 = 退出」。
         */
        private const val BACK_JS = "(" +
            "function(){try{" +
            "if(typeof window.__onSystemBack==='function')" +
            "return !!window.__onSystemBack();" +
            "return false;" +
            "}catch(e){return false}}" +
            ")()"

        /**
         * 手势开始：让页面记一份状态快照，然后立刻执行返回。
         * 之后跟手平移露出的就是目标页。
         */
        private const val BEGIN_BACK_JS = "(" +
            "function(){try{" +
            "return !!(window.__beginBackPreview&&window.__beginBackPreview());" +
            "}catch(e){return false}}" +
            ")()"

        /** 手势取消：把页面回滚到返回前 */
        private const val CANCEL_BACK_JS = "(" +
            "function(){try{" +
            "window.__cancelBackPreview&&window.__cancelBackPreview();" +
            "}catch(e){}return true}" +
            ")()"

        /** 手势提交：丢掉快照。页面已经是目标页了，不用再动 */
        private const val COMMIT_BACK_JS = "(" +
            "function(){try{" +
            "window.__commitBackPreview&&window.__commitBackPreview();" +
            "}catch(e){}return true}" +
            ")()"

        private const val MOBILE_UA =
            "Mozilla/5.0 (Linux; Android 13; PLC110 Build/TP1A.220905.001; wv) " +
                "AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 " +
                "Chrome/120.0.0.0 Mobile Safari/537.36"

        /**
         * 阅读层净化脚本：隐藏登录/评论/下载/推荐/广告区块，
         * 放大正文、收紧行距。用 CSS 隐藏而不是删除，避免误删正文。
         */
        private val READER_JS: String = buildString {
            append("(function(){")
            append("if(window.__yjbReader)return;window.__yjbReader=true;")
            append("var s=document.createElement('style');")
            append("s.textContent=[")
            append("'header,footer,nav,aside{display:none !important}',")
            append("'[class*=\"login\"],[id*=\"login\"]{display:none !important}',")
            append("'[class*=\"comment\"],[id*=\"comment\"]{display:none !important}',")
            append("'[class*=\"download\"],[id*=\"download\"]{display:none !important}',")
            append("'[class*=\"recommend\"],[class*=\"relate\"],[class*=\"share\"]")
            append("{display:none !important}',")
            append("'[class*=\"advert\"],[id*=\"advert\"],ins.adsbygoogle,iframe")
            append("{display:none !important}',")
            append("'body{background:#f5f6f8 !important}',")
            append("'p,article,#ContentBody,#artibody,.news-content,.main-text")
            append("{font-size:17px !important;line-height:1.85 !important;")
            append("color:#1a1d23 !important}',")
            append("'img{max-width:100% !important;height:auto !important}'")
            append("].join('\\n');")
            append("document.head.appendChild(s);")
            append("})();")
        }
    }
}
