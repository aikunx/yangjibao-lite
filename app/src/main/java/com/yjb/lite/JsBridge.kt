package com.yjb.lite

import android.app.Activity
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Intent
import android.net.Uri
import android.webkit.JavascriptInterface
import android.webkit.WebView
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import java.io.BufferedReader
import java.io.InputStreamReader
import okhttp3.ConnectionPool
import okhttp3.Dns
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import java.net.InetAddress
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.net.URLEncoder

/**
 * JS <-> Kotlin 桥。
 *
 * 所有网络与 OCR 都在后台线程执行，结果通过 evaluateJavascript 回调首页。
 * JS 侧统一用 Native.xxx(...) 调用，返回值异步送到 window.__onNative(cbId, json)。
 */
class JsBridge(
    private val activity: Activity,
    webView: WebView,
    private val host: MainActivity? = null,
) {
    /**
     * 主 WebView。
     *
     * 刻意不是 val：渲染进程被杀（MainActivity.onRenderProcessGone）
     * 之后 Activity 会新建一个 WebView 实例，这里必须能换指。
     * 否则所有 reply() 都会打到已经作废的实例上，
     * JS 侧 nativeAsync 的 promise 永久 pending（按钮像坏了）。
     */
    @Volatile
    private var webView: WebView = webView

    /** 渲染进程重建后，把桥指向新的 WebView 实例。 */
    fun attachWebView(w: WebView) {
        webView = w
    }

    /**
     * P6：加 SupervisorJob 隔离子协程失败，并允许在 Activity 销毁时
     * 整体取消。原来 scope 没有 Job、没有异常处理器：协程体里抛出的
     * 未捕获异常会走主线程默认处理（闪退），Activity 销毁后长任务
     * （OCR / 网络）还继续持有它（泄漏）。
     */
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)

    /** Activity 销毁时调用：取消所有在飞的协程（N7 / P6）。 */
    fun shutdown() {
        runCatching { scope.cancel() }
    }


    /**
     * 网络层：OkHttp 客户端。
     *
     * 相比 HttpURLConnection，这里做了几件真正能提速的事：
     *
     *  1. 连接池复用：同一域名第二次请求直接走已建立的 TLS 连接，
     *     省掉 TCP 三次握手 + TLS 握手（通常 200~600ms）
     *  2. HTTP/2 多路复用：多个请求共用一条连接，不排队
     *  3. 并行 DNS：默认解析器逐个尝试系统 DNS，国内经常卡 1~2 秒；
     *     这里改成对返回的所有地址并发探测，取最先连通的
     *  4. 启动预连接：App 起来时先给常用域名各发一个请求，
     *     等用户点开页面时连接已经热了
     */
    private val client: OkHttpClient = OkHttpClient.Builder()
        /*
         * 超时收紧。
         *
         * 之前 callTimeout 20 秒，但日志里出现过 44 秒的请求——
         * 那是 OkHttp 的重试叠加起来的：一次 20 秒超时后自动换 IP 重试，
         * 又 20 秒。连接池只有 12 个连接，几个这样的请求就能把池占满，
         * 后面所有请求排队，用户感知就是「整页卡住不动」。
         *
         * 现在单次 10 秒、总 12 秒，失败快速返回，让上层走降级。
         */
        .connectTimeout(6, TimeUnit.SECONDS)
        .readTimeout(10, TimeUnit.SECONDS)
        .callTimeout(12, TimeUnit.SECONDS)
        .retryOnConnectionFailure(true)
        .connectionPool(ConnectionPool(12, 5, TimeUnit.MINUTES))
        .dns(ParallelDns())
        .build()

    /**
     * AI 调用专用 client。
     *
     * 不能复用上面的 client —— 它的 callTimeout 只有 12 秒，是为
     * 「快速失败、让上层降级」设计的；而大模型首包常见 15~25 秒
     * （实测 deepseek-v4-flash 带推理时约 20 秒），用那个必然全部超时。
     * 这里单独派生一个，超时给到 90 秒。
     */
    private val aiClient: OkHttpClient by lazy {
        client.newBuilder()
            .connectTimeout(10, TimeUnit.SECONDS)
            .readTimeout(90, TimeUnit.SECONDS)
            .callTimeout(90, TimeUnit.SECONDS)
            .build()
    }

    companion object {
        private const val UA =
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
                "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"

        /** 桌面 UA：腾讯 K 线接口只认这个，用移动 UA 会直接 501 */
        private const val DESKTOP_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
    }

    // ---------------------------------------------------------------- 回传

    private fun reply(cbId: String, ok: Boolean, payload: String) {
        // cbId 也用 JSON 字面量转义后再拼进 JS（它来自 JS 侧，虽是自己
        // 生成的 id，但没有理由让它能破坏这段脚本）
        val js = "window.__onNative(" + JSONObject.quote(cbId) + ", " + ok + ", " +
            JSONObject.quote(payload) + ")"
        val w = webView
        w.post {
            // P6：WebView 可能已经销毁（渲染进程被杀 / Activity 已退出），
            // 这时 evaluateJavascript 会抛异常，不能让它在主线程
            // 变成未捕获异常（直接闪退）
            runCatching { w.evaluateJavascript(js, null) }
        }
    }

    // ---------------------------------------------------------------- 预热

    /**
     * 预连接：给常用数据源各发一个极小的请求，
     * 把 DNS + TCP + TLS 握手提前做掉。
     * 之后真正取数直接复用连接池，省掉 200~600ms。
     */
    /**
     * 与服务器的时间差（毫秒）。
     *
     * 手机时钟经常被用户随手改，或者时区设置不对，
     * 导致「更新于 14:30」这类标签显示错误的时间。
     * 这里用响应头里的 Date 反推真实时间，算出偏移量，
     * 之后 JS 侧取时间都走 now()，不再直接用 Date.now()。
     */
    @Volatile
    private var timeOffsetMs: Long = 0L

    /** 已校准过服务器时间 */
    @Volatile
    private var timeSynced = false

    /**
     * 校准当前时间。
     *
     * 只发一个极轻量的请求，读 HTTP 响应头的 Date 字段。
     * 服务器 Date 精度到秒，来回网络延迟几十毫秒，
     * 对「显示更新时间」这个用途完全够用。
     */
    fun syncTime() {
        Thread { doSync() }.apply { isDaemon = true }.start()
    }

    /**
     * N1：异步对时（主路径）。
     *
     * 契约（Lead 已按这个改好 index.html，用 nativeAsync 收回调）：
     *   成功 -> reply(cbId, true,  timeOffsetMs.toString())
     *   失败 -> reply(cbId, false, "sync failed")
     *
     * payload 必须是 String；JS 侧只看 ok 布尔，自己再读一次
     * Native.timeOffset()，所以 payload 传偏移量只是为了好排查。
     *
     * 关键：doSync() 绝不能在调用线程上跑。@JavascriptInterface 方法是
     * **同步调用**，JavaBridge 只有一条线程：在这里等网络，WebView 的
     * JS 线程（含 rAF 渲染）和后面排队的其它 Native.* 全都会停摆——
     * 冷启动「整页无响应」就是这么来的。
     */
    @JavascriptInterface
    fun syncTimeAsync(cbId: String) {
        scope.launch {
            val ok = withContext(Dispatchers.IO) {
                runCatching { doSync() }.getOrDefault(false)
            }
            reply(cbId, ok, if (ok) timeOffsetMs.toString() else "sync failed")
        }
    }

    /**
     * 让 doSync 串行化的锁。
     *
     * onCreate 的 syncTime、30 秒后的补校准、JS 的 syncTimeAsync
     * 可能同时在跑。timeOffsetMs 与 timeSynced 必须成对写入，
     * 否则 JS 会读到「偏移换了、标志还没换」的中间态。
     */
    private val syncLock = Any()

    /**
     * 真正去对齐时间。阻塞执行（调用方负责放到后台线程），返回是否成功。
     *
     * 取多个源算中位数：单个服务器的时钟也可能偏，
     * 但几个独立来源同时偏同一个方向的概率很低。
     */
    private fun doSync(): Boolean = synchronized(syncLock) {
        val candidates = listOf(
            "https://qt.gtimg.cn/q=sh000001",
            "https://hq.sinajs.cn/list=sh000001",
            "https://fund.eastmoney.com/pingzhongdata/110011.js",
        )
        val offsets = ArrayList<Long>()
        for (u in candidates) {
            runCatching {
                val t0 = System.currentTimeMillis()
                val req = Request.Builder().url(u)
                    .header("User-Agent", UA).build()
                client.newCall(req).execute().use { resp ->
                    val dateHeader = resp.header("Date") ?: return@use
                    val t1 = System.currentTimeMillis()
                    val serverMs = parseHttpDate(dateHeader) ?: return@use
                    // 取中点，抵消一半的往返延迟
                    offsets.add(serverMs - (t0 + t1) / 2)
                }
            }
        }
        if (offsets.isEmpty()) return@synchronized false
        offsets.sort()
        timeOffsetMs = offsets[offsets.size / 2]
        timeSynced = true
        true
    }

    /** 校准后的当前时间戳（毫秒）。JS 侧统一用它取时间。 */
    @JavascriptInterface
    fun now(): Long = System.currentTimeMillis() + timeOffsetMs

    /** 当前时间偏移量（毫秒），正数表示本机时间慢了 */
    @JavascriptInterface
    fun timeOffset(): Long = timeOffsetMs

    /** 是否已与服务器对齐 */
    @JavascriptInterface
    fun timeSyncedFlag(): Boolean = timeSynced

    /**
     * 同步版对时——**只作兜底**，主路径是 syncTimeAsync()。
     *
     * N1：原来是 t.join(6000)。@JavascriptInterface 方法是同步调用，
     * 这 6 秒里 WebView 的 JS 线程（以及排在后面的其它 Native.* 调用、
     * rAF 渲染）全部冻住，冷启动整页无响应；而且 doSync 三个候选源
     * 串行、正常就要 6 秒以上，join 总是先超时返回 false —— 日志写
     * 「时间同步失败 · 接口不可达」，JS 紧接着读到的 timeOffset 还是
     * 旧值 0，交易时段判断与当日盈亏跟着一起错。
     *
     * 现在最多只等 250ms 做一次「快速试探」。等不到就按已知状态回答，
     * 绝不谎报成功：只有真的同步成功过（timeSynced）才返回 true。
     */
    @JavascriptInterface
    fun forceSyncTime(): Boolean {
        val done = AtomicBoolean(false)
        val t = Thread { done.set(runCatching { doSync() }.getOrDefault(false)) }
        t.isDaemon = true
        t.start()
        runCatching { t.join(250) }
        return done.get() || timeSynced
    }

    /** 解析 HTTP Date 头（RFC 1123），失败返回 null */
    private fun parseHttpDate(s: String): Long? = runCatching {
        java.text.SimpleDateFormat("EEE, dd MMM yyyy HH:mm:ss zzz", java.util.Locale.US)
            .parse(s)?.time
    }.getOrNull()


    fun warmUp() {
        val hosts = listOf(
            "https://map.findfin.app/api/heatmap/overview?period=day",
            "https://dq.10jqka.com.cn/fuyao/hot_list_data/out/hot_list/v1/plate?type=concept",
            // 东财 push2 在当前网络不可达，预热它只是白等
            "https://money.finance.sina.com.cn/quotes_service/api/json_v2.php/CN_MarketData.getKLineData?symbol=sh000300&scale=240&ma=no&datalen=5",
            "https://hq.sinajs.cn/list=sh000001",
            "https://qt.gtimg.cn/q=sh000001",
            "https://fundgz.1234567.com.cn/js/110011.js",
        )
        Thread {
            for (u in hosts) {
                runCatching {
                    val req = Request.Builder()
                        .url(u)
                        .header("User-Agent", UA)
                        .build()
                    client.newCall(req).execute().use { it.body?.bytes() }
                }
            }
        }.apply { isDaemon = true }.start()
    }

    // ---------------------------------------------------------------- 网络

    /** 通用 GET，返回原始文本。 */
    @JavascriptInterface
    fun httpGet(url: String, gbk: Boolean, cbId: String) {
        scope.launch {
            val text = withContext(Dispatchers.IO) {
                runCatching { fetch(url, gbk) }.getOrElse { "ERR:$it" }
            }
            reply(cbId, !text.startsWith("ERR:"), text)
        }
    }

    /**
     * 通用 POST（JSON body），返回原始文本。
     *
     * **只有白名单域名能走这里。** 这是一个能携带 Authorization 头
     * 往外发数据的出口，一旦放开，等于给页面里任何一段脚本
     * （包括将来接入的第三方内容）开了一条外发通道。
     */
    @JavascriptInterface
    fun httpPost(url: String, body: String, auth: String, cbId: String) {
        if (!isAllowedPost(url)) {
            reply(cbId, false, "ERR:host not allowed")
            return
        }
        scope.launch {
            val text = withContext(Dispatchers.IO) {
                runCatching { postJson(url, body, auth) }.getOrElse { "ERR:$it" }
            }
            reply(cbId, !text.startsWith("ERR:"), text)
        }
    }

    private fun isAllowedPost(url: String): Boolean =
        url.startsWith("https://token.sensenova.cn/")

    private fun postJson(url: String, body: String, auth: String): String {
        val b = Request.Builder()
            .url(url)
            .header("User-Agent", UA)
            .header("Accept", "application/json")
        /*
         * Authorization 由 JS 侧传进来 —— API Key 存在用户本地库里，
         * 原生这边不持有也不落盘，少一处泄露面。
         */
        if (auth.isNotBlank()) b.header("Authorization", auth)
        val req = b
            .post(body.toRequestBody("application/json; charset=utf-8".toMediaType()))
            .build()
        return try {
            aiClient.newCall(req).execute().use { resp ->
                val raw = resp.body?.bytes() ?: ByteArray(0)
                val s = String(raw, Charsets.UTF_8)
                if (!resp.isSuccessful) "ERR:HTTP " + resp.code + " " + s.take(300) else s
            }
        } catch (e: Exception) {
            "ERR:" + (e.message ?: e.javaClass.simpleName)
        }
    }

    private fun fetch(url: String, gbk: Boolean): String {
        val ref = refererFor(url)
        /*
         * UA 分场景。
         * 腾讯 K 线接口 web.ifzq.gtimg.cn 对移动版 UA 直接回 501，
         * 用桌面 UA 才正常返回；而文章页要用移动版 UA 才拿到干净正文。
         * 所以按域名切，而不是全局一个 UA。
         */
        val ua = if (url.contains("gtimg.cn")
            || url.contains("/api/qt/")
            || url.contains("pingzhongdata")) DESKTOP_UA else UA
        val req = Request.Builder()
            .url(url)
            .header("User-Agent", ua)
            .header("Referer", ref)
            .header("Accept", "application/json, text/plain, text/html, */*")
            .header("Accept-Language", "zh-CN,zh;q=0.9")
            .build()

        return try {
            client.newCall(req).execute().use { resp ->
                if (!resp.isSuccessful) {
                    return "ERR:HTTP " + resp.code + " " + url
                }
                val body = resp.body ?: return "ERR:empty body"
                val raw = body.bytes()
                // 中文财经站不少还是 GBK，一律按 UTF-8 解会把正文解成乱码
                val cs = detectCharset(raw, resp.header("Content-Type"), gbk)
                String(raw, cs)
            }
        } catch (e: Exception) {
            "ERR:" + (e.message ?: e.javaClass.simpleName)
        }
    }

    /**
     * 猜编码：header 声明 -> HTML meta -> 内容试探。
     */
    private fun detectCharset(
        raw: ByteArray,
        contentType: String?,
        forceGbk: Boolean,
    ): java.nio.charset.Charset {
        if (forceGbk) return charset("GBK")

        val head = String(raw, 0, minOf(raw.size, 2048), Charsets.ISO_8859_1)

        fun norm(n: String): java.nio.charset.Charset = when (n.lowercase()) {
            "gb2312", "gbk", "gb18030" -> charset("GBK")
            "big5" -> charset("Big5")
            else -> Charsets.UTF_8
        }

        val chRe = Regex("charset=[\"']?([A-Za-z0-9_-]+)", RegexOption.IGNORE_CASE)

        chRe.find(contentType ?: "")?.groupValues?.getOrNull(1)?.takeIf { it.isNotBlank() }
            ?.let { return norm(it) }

        Regex("<meta[^>]+charset=[\"']?([A-Za-z0-9_-]+)", RegexOption.IGNORE_CASE)
            .find(head)?.groupValues?.getOrNull(1)?.takeIf { it.isNotBlank() }
            ?.let { return norm(it) }

        // 没声明：UTF-8 解出来替换字符太多，就认定是 GBK
        val asUtf8 = String(raw, Charsets.UTF_8)
        val bad = asUtf8.count { it == 0xFFFD.toChar() }
        return if (bad > 3) charset("GBK") else Charsets.UTF_8
    }

    /**
     * Referer 必须按目标站点匹配，否则会被 403：
     *   新浪 hq.sinajs.cn  必须 finance.sina.com.cn
     *   腾讯 qt.gtimg.cn   必须 gu.qq.com
     */
    private fun refererFor(url: String): String = when {
        url.contains("hq.sinajs.cn") || url.contains("sinajs") ->
            "https://finance.sina.com.cn/"
        url.contains("sina") -> "https://finance.sina.com.cn/"
        url.contains("gtimg.cn") -> "https://gu.qq.com/"
        url.contains("fund") -> "https://fund.eastmoney.com/"
        url.contains("10jqka") -> "https://www.10jqka.com.cn/"
        url.contains("findfin") -> "https://map.findfin.app/"
        url.contains("212.129.244.148") -> "http://212.129.244.148:8890/"
        else -> "https://finance.eastmoney.com/"
    }

    // ---------------------------------------------------------------- 杂项

    /**
     * 当前页面能否「返回上一页」。
     * JS 在每次渲染后同步写入，原生按返回键时直接读，避免异步求值的竞态。
     */
    @Volatile
    var canGoBack: Boolean = false

    /** 由 JS 调用：告知当前这次返回能不能被页面消费。 */
    @JavascriptInterface
    fun updateCanGoBack(v: Boolean) {
        if (canGoBack == v) return
        // canGoBack 是 @Volatile 字段，跨线程读写安全
        canGoBack = v
        /*
         * N4：@JavascriptInterface 方法跑在 WebView 的 JavaBridge 线程，
         * 不是主线程。onBackStateChanged 最终会走到
         * registerOnBackInvokedCallback / unregister +
         * endBackPreview()（里面是 ViewGroup.removeView、View 动画），
         * 都必须在主线程，否则：
         *   轻则 CalledFromWrongThreadException 崩溃，
         *   重则 backRegistered / backCallback / backOverlay 三个字段
         *   跨线程读写错乱 →「回调其实没注册但 backRegistered=true」，
         *   此后返回键不再走页面内返回（表现为返回键失灵或直接退出）。
         *
         * 同一个文件里 setTheme / openReader 早就是这个写法，这里补齐。
         */
        activity.runOnUiThread {
            runCatching { host?.onBackStateChanged(v) }
        }
    }

    /**
     * 运行时状态：内存 / CPU / GPU / 线程。
     *
     * Android 没有现成的「性能面板」，这几项都得自己算：
     *   内存  Runtime 的 Java 堆 + ActivityManager 的设备内存
     *   CPU   读 /proc/self/stat 的累计 tick，两次采样求差
     *   GPU   读 kgsl 节点的 busy/total（高通平台），读不到就返回 null
     *   线程  当前进程的线程数
     *
     * 返回 JSON 字符串，前端解析后记进日志。
     */
    @JavascriptInterface
    fun getStats(): String {
        val o = org.json.JSONObject()
        return try {
            val rt = Runtime.getRuntime()
            o.put("heapUsed", (rt.totalMemory() - rt.freeMemory()) / 1048576)
            o.put("heapMax", rt.maxMemory() / 1048576)

            val am = activity.getSystemService(android.content.Context.ACTIVITY_SERVICE)
                as android.app.ActivityManager
            val mi = android.app.ActivityManager.MemoryInfo()
            am.getMemoryInfo(mi)
            o.put("deviceAvail", mi.availMem / 1048576)
            o.put("deviceTotal", mi.totalMem / 1048576)
            o.put("lowMemory", mi.lowMemory)

            // CPU：累计 tick，前端用两次采样差值算占用率
            o.put("cpuTicks", readCpuTicks())
            o.put("cpuCores", Runtime.getRuntime().availableProcessors())

            // GPU 负载（高通 kgsl），读不到就留空
            val gpu = readGpuBusy()
            if (gpu != null) o.put("gpuBusy", gpu.first)
            else o.put("gpuBusy", -1)

            o.put("threads", Thread.activeCount())
            o.toString()
        } catch (e: Exception) {
            "{}"
        }
    }

    /** 进程累计 CPU tick（utime + stime） */
    private fun readCpuTicks(): Long = runCatching {
        val stat = java.io.File("/proc/self/stat").readText()
        // 跳过 comm 字段（可能含空格和括号），从右括号之后切
        val rest = stat.substring(stat.lastIndexOf(')') + 2).split(" ")
        val utime = rest.getOrNull(11)?.toLongOrNull() ?: 0L
        val stime = rest.getOrNull(12)?.toLongOrNull() ?: 0L
        utime + stime
    }.getOrDefault(0L)

    /** GPU 忙碌度：节点格式是「busy total」，返回百分比 */
    private fun readGpuBusy(): Pair<Int, Int>? = runCatching {
        val f = java.io.File("/sys/class/kgsl/kgsl-3d0/gpubusy")
        if (!f.exists()) return null
        val parts = f.readText().trim().split(" ")
        if (parts.size < 2) return null
        val busy = parts[0].toLong()
        val total = parts[1].toLong()
        if (total <= 0) null else Pair(((busy * 100) / total).toInt(), total.toInt())
    }.getOrNull()

    /**
     * 前端日志直通 logcat。
     *
     * 远程排查时最省事的一条路：adb logcat -s YjbLite 就能把
     * 页面里的关键事件、接口失败原因全拉下来，不用碰手机。
     */
    @JavascriptInterface
    fun log(msg: String) {
        android.util.Log.i("YjbWeb", msg.take(900))
    }

    /**
     * 把日志写到文件。
     *
     * Android 17 对 release 版 App 的 logcat 输出有限制，
     * Log.i 写进去但 adb 抓不到。所以额外开一条文件通道：
     * 日志落到 App 的外部私有目录，adb pull 就能拿到，
     * 完全绕开 logcat 的权限问题。
     *
     * 路径：/sdcard/Android/data/com.yjb.lite/files/dsh/log.txt
     */
    @JavascriptInterface
    fun writeLogText(text: String) {
        if (text.isBlank()) return
        Thread {
            runCatching {
                val dir = activity.getExternalFilesDir("dsh") ?: return@runCatching
                if (!dir.exists()) dir.mkdirs()
                val f = java.io.File(dir, "log.txt")
                // 超过 200KB 就截掉前面，避免无限增长
                if (f.exists() && f.length() > 200_000) {
                    val keep = f.readText().takeLast(120_000)
                    f.writeText(keep)
                }
                f.appendText(text + 10.toChar())
            }
        }.apply { isDaemon = true }.start()
    }

    /**
     * 批量日志。
     *
     * 前端把日志攒 250ms 再一次性调过来，避免每条都跨进程。
     * 一次最多 40 条，超出部分丢掉——排查问题时最新的几十条就够。
     */
    @JavascriptInterface
    fun logBatch(lines: String) {
        if (lines.isBlank()) return
        val arr = runCatching {
            JSONArray(lines)
        }.getOrNull() ?: return
        for (i in 0 until minOf(arr.length(), 40)) {
            val v = arr.optString(i, "")
            if (v.isNotBlank()) android.util.Log.i("YjbWeb", v.take(600))
        }
    }

    /** 切换主题时同步状态栏/导航栏，避免深色页面配白状态栏。 */
    @JavascriptInterface
    fun setTheme(mode: String) {
        activity.runOnUiThread {
            runCatching { host?.applyTheme(mode == "dark") }
            runCatching {
                val dark = mode == "dark"
                val win = activity.window
                val bg = if (dark) 0xFF0E1116.toInt() else 0xFFF2F4F7.toInt()
                win.statusBarColor = bg
                win.navigationBarColor = bg
                if (android.os.Build.VERSION.SDK_INT >= 30) {
                    val ctl = win.insetsController ?: return@runCatching
                    val light = if (dark) 0 else
                        android.view.WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS
                    ctl.setSystemBarsAppearance(
                        light,
                        android.view.WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS
                            or android.view.WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS
                    )
                } else if (android.os.Build.VERSION.SDK_INT >= 23) {
                    @Suppress("DEPRECATION")
                    var flags = win.decorView.systemUiVisibility
                    flags = if (dark) {
                        flags and android.view.View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR.inv()
                    } else {
                        flags or android.view.View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR
                    }
                    @Suppress("DEPRECATION")
                    win.decorView.systemUiVisibility = flags
                }
            }
        }
    }

    @JavascriptInterface
    fun toast(msg: String) {
        android.widget.Toast.makeText(activity, msg, android.widget.Toast.LENGTH_SHORT)
            .show()
    }

    /**
     * 写系统剪贴板（补 log 菜单里的「复制日志」）。
     *
     * index.html 的「复制日志」按钮调的是 `Native.copy(diag.dump())`，
     * 但桥里从来没有这个方法：外面套了 `Native.copy ? ... : null`
     * 的 falsy 保护所以不崩，功能却是**静默失效**的（只剩
     * navigator.clipboard 兜底，而 file:// 页面下它不可靠）。
     *
     * 不需要回调。Android 13+ 由系统自己弹「已复制」提示条，
     * 页面里那句 toast('已复制 N 条日志') 会同时出现，属于正常现象。
     */
    @JavascriptInterface
    fun copy(text: String) {
        if (text.isEmpty()) return
        // 剪贴板是系统服务，统一回主线程操作
        activity.runOnUiThread {
            runCatching {
                val cm = activity.getSystemService(android.content.Context.CLIPBOARD_SERVICE)
                    as ClipboardManager
                cm.setPrimaryClip(ClipData.newPlainText("yjb", text))
            }
        }
    }

    /** 用系统浏览器 / 应用内浏览器打开链接。 */
    @JavascriptInterface
    fun openUrl(url: String) {
        if (url.isBlank()) return
        runCatching {
            val intent = Intent(Intent.ACTION_VIEW, Uri.parse(url))
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            activity.startActivity(intent)
        }.onFailure {
            android.widget.Toast.makeText(
                activity, "无法打开链接", android.widget.Toast.LENGTH_SHORT
            ).show()
        }
    }

    @JavascriptInterface
    fun close() {
        activity.finish()
    }
}


/**
 * 并行 DNS 解析。
 *
 * Android 默认解析器按顺序尝试系统 DNS，国内经常某个 DNS 不响应，
 * 一卡就是 1~2 秒。这里改成：所有地址并发探测，谁先连通用谁。
 *
 * 注意：失败时回退到系统解析，保证不会因为加速反而解析不了。
 */
class ParallelDns : Dns {
    override fun lookup(hostname: String): List<InetAddress> {
        val addrs = try {
            InetAddress.getAllByName(hostname).toList()
        } catch (e: Exception) {
            throw java.net.UnknownHostException(hostname)
        }
        if (addrs.size <= 1) return addrs

        // 并发探测：按返回顺序赛跑，第一个连通的排到最前
        val pool = java.util.concurrent.Executors.newFixedThreadPool(addrs.size)
        return try {
            val futures = addrs.map { a ->
                pool.submit<Pair<InetAddress, Long>> {
                    val t0 = System.nanoTime()
                    val ok = runCatching {
                        java.net.Socket().use { sk ->
                            sk.connect(java.net.InetSocketAddress(a, 443), 400)
                        }
                        true
                    }.getOrDefault(false)
                    val cost = if (ok) System.nanoTime() - t0 else Long.MAX_VALUE
                    a to cost
                }
            }
            val ranked = futures.mapNotNull {
                runCatching { it.get(900, java.util.concurrent.TimeUnit.MILLISECONDS) }
                    .getOrNull()
            }.sortedBy { it.second }

            if (ranked.isEmpty()) addrs else ranked.map { it.first }
        } catch (e: Exception) {
            addrs
        } finally {
            pool.shutdownNow()
        }
    }
}
