# 养基宝 Lite · 项目状态

> 最后更新：2026-10-20 22:26
> 这份文档记录当前进度、已验证结论、未完成事项。随时可读。

---

## 一、项目概况

| 项 | 值 |
|---|---|
| 目录 | `D:/work/yjb_lite` |
| 技术栈 | Kotlin + 单 Activity + 系统 WebView + `assets/index.html`（单文件 UI） |
| minSdk / target | 24 / 35 |
| 构建 | AGP 8.5.2 + Gradle 8.7（`D:/tools/gradle/gradle-8.7`）+ JDK 21 |
| SDK | `D:/tools/android-sdk`（build-tools 35.0.0） |
| 一键构建 | `bash tool/build_all.sh`（assembleRelease → zipalign -P 16 → 签名 → 校验 APK 内 assets 与源码一致） |
| 产物 | `yjblite.apk`（已签名 v1/v2/v3） |
| 测试机 | OPPO PLC110，**Android 17 (SDK 37)**，120/144Hz，WebView 157 |

**项目性质**：原「养基宝」是 Flutter AOT + 服务端权威 API（TLS 指纹校验，
逆向成本极高）。本项目改为**重写**，对接公开数据源，无广告、无账号。

---

## 二、当前界面结构

底部 4 个 tab：

| Tab | 内容 |
|---|---|
| **资产** | 总资产卡（可点 → 历史收益率；含预估/实际涨跌、组合估值）+ 持仓/自选分段 + 基金列表 |
| **行情** | 大盘（A 股宽基 + 全市场概览）/ 板块 / 涨跌分布 / 全球指数 |
| **发现** | 板块情绪 / 资讯 |
| **我的** | 本地数据概览 + 截图导入 + 外观主题 + 设置（二级页） |

二级页：基金详情、板块详情（**含分钟蜡烛 K 线**）、正文、历史收益率、设置、调试日志、数据源自检。

---

## 三、数据源现状

### 可用的

| 用途 | 来源 | 状态 |
|---|---|---|
| 板块涨跌 / 成分股 | `map.findfin.app` 热力图 | 可用，**偶尔 7~23 秒** |
| 指数估值（PE/分位） | 蛋卷 `danjuanfunds.com` | 可用 |
| 板块情绪 / 热榜 | 同花顺 `dq.10jqka.com.cn` | 可用 |
| 涨停/跌停池 | 东财 `push2ex.eastmoney.com` | 可用 |
| 商品（金/油/铜） | 腾讯 `qt.gtimg.cn` | 可用 |
| 美股/港股指数 | 腾讯 `qt.gtimg.cn` | 可用 |
| 基金净值 | `api.fund.eastmoney.com/f10/lsjz` | 可用，**最及时** |
| 基金全量历史 | `pingzhongdata` | 可用，**比 lsjz 慢一天** |
| 基金重仓股 | `fundf10.eastmoney.com` | 可用（**必须带 fund 域 Referer**） |
| 日线 / 分钟 K 线 | 新浪 `quotes.sina.cn` | 可用，带 OHLC |
| 资讯（5 源） | 新浪/同花顺/东财×3 | 可用，合并约 99 条 |

### 不可用的（已处理）

| 来源 | 问题 | 处理 |
|---|---|---|
| **东财 `push2` 系列** | 整片不可达。原用途：板块资金流、板块 PE、板块成分股 | **已全部替换**，代码零引用 |
| 腾讯 `web.ifzq.gtimg.cn`（手机网络） | 稳定 501。电脑上正常 | 新浪主用、腾讯备用 |
| **`fundgz.1234567.com.cn`（盘中估值）** | **已下线**：任何 UA / Referer 都返回 200 + 3924B 的 HTML「页面未找到」 | 改为走桥取文本 + `jsonpgz(` 校验；拿不到就静默返回 null，自然退回 `predict` |

---

## 四、本轮修复清单（2026-10-20 晚，已全部验证）

### 前端 `assets/index.html`

| 编号 | 标题 | 根因 | 状态 |
|---|---|---|---|
| B1 | **「行情」tab 整体白屏** | `viewMarket()` 默认分段 `'index'` 调用了从未定义的 `viewMarketIndex()`；异常发生在 `renderNow()` 的 `mainEl.innerHTML` 赋值处，标题和底部高亮已更新、正文停在上一个页面 | 已补实现 |
| B2 | **「发现」tab 永不加载数据** | `switchTab()` 先把 `'mood'/'news'` 映射成 `'discover'`，后面的 `if (tab === 'mood')` / `if (tab === 'news')` 永远为假 → 死分支 | 改为按 `'discover'` 统一触发 |
| B3 | **板块 K 线永远出不来** | 拉 K 线的逻辑只挂在「点周期按钮」上，而按钮画在 K 线卡片内、卡片要 `d.kline` 有数据才渲染 → 鸡生蛋 | 新增 `loadSectorKline()`，打开详情即拉 |
| B4 | 板块→指数映射串味 | `sectorQuoteCode()` 先查「基金名→跟踪指数」的 `INDEX_MAP`，导致「食品饮料」落到中证白酒、「银行」落到中证银行 | 改为先查实测过的行业表 |
| B5 | **弹层打开时按返回直接退出 App** | `syncBackState()` 没算弹层；原生 `canGoBack=false` 就 `finish()` | 新增 `canConsumeBack()`，openSheet/closeSheet 各通知一次 |
| B6 | **冷启动冻死最多 6 秒** | 同步调 `Native.forceSyncTime()`，原生侧 `t.join(6000)` 卡住 JS 线程；且 join 常先超时 → 永远报「同步失败」、偏移取旧值 0 | 新增 `syncTimeAtBoot()`，优先异步 `syncTimeAsync` |
| S1 | **CSS v2 重写丢了 41 个仍在用的类** | 行情概览条、板块行、涨跌分布条、骨架屏、缓存条全部无规则 → 数据在、样式没了 | 从 18:26 备份原样恢复 73 条规则 + 补回删掉的 `--chip` 变量 |
| S2 | **「隐藏金额」开关失效** | 规则按旧版 `.big/.today` 写，v2 换成 `.ac-num/.ac-day/.ac-sum` 后匹配不上 | 补 v2 作用域规则（`.ac-money`） |
| S6 | 弹层没有遮罩 | CSS 有 `.sheet-mask`，页面上从来没有这个元素 | 补元素 + 联动 + 点遮罩关闭 |
| S4a | 正文页没有返回入口 | `#artBack` 处理器存在但无元素 | 补正文页顶栏 |
| S4b | 板块列表失败时永远骨架屏、无重试 | `!S.heat` 时无脑画骨架 | 新增 `heatErr/heatLoading` + `heatPending()` + `#secRetry` |
| S3 | 两个死按钮 | `#artOpenWeb`、`#staleRefresh` 无处理器 | 分别接上 `Native.openUrl` / `refreshHeat(true)` |
| R1 | **自选分段搜索添加，永远加不进自选** | `onPickFund()` 判 `S.tab === 'watch'`，而 `S.tab` 只能是 `'hold'` | 改判 `S.assetSeg` |
| R2 | **「历史收益率」页零入口** | 唯一入口 `#assetHead` 长在死函数 `viewHold()` 里 | 入口移到 `viewAssets()` 的资产卡 |
| R3 | 自检页「运行状态」「最近失败的请求」永不显示 | `viewDiag()` 里 `html = ...` 覆盖了前面拼好的两块 | 改 `html +=` |
| R4 | 「净资产 313.02%」 | `Data_assetAllocation` 里净资产量纲是**亿元**，被统一拼了 `%` | 单独按亿元渲染 |
| R5 | 每次刷新每持仓一条全局 SyntaxError | `api.gz` 用 `<script>` 注入 JSONP，fundgz 返回 HTML 被当代码执行 | 改走桥取文本 + `jsonpgz(` 校验 |
| R6 | 下拉刷新在 8 秒节流内静默 no-op | `pull.taskOf()` 返回 `refreshAll(false)`；且 `mood/news` 分支是死代码 | 改 `refreshAll(true)`；发现页正名 |
| R7 | 12 处重复 `class` 属性 | HTML 只认第一个 `class`，`t-pointer/t-dim/t-up` 全丢 | 全部合并 |
| R8 | 文案「19 个接口」与实际 18 不符 | — | 改为 18 |
| R9 | K 线标题显示原始代码 `K 线 · sz399233` | 传的是代码 | 标题用板块名，页脚小字注明跟踪指数 |
| R11 | 负份额渲染出 `¥-399.63` | 无下限校验 | `store.sanitize()` 读入清洗 + `holdCalc` 兜底 |

### 原生层（由 teammate 完成，见 `tool/wvtest/FIXES-native.md`）

N1 异步对时 `syncTimeAsync`（`forceSyncTime` 的 join 6000→250ms）· N2 返回键先问 JS · N3 `onRenderProcessGone` + 主文档失败错误页 · N4 `updateCanGoBack` 切主线程 · N5 release 关调试 + 收紧 WebView 配置 + `allowBackup=false` · N6 `configChanges` 补 `fontScale` + `textZoom` 固定 100 · N7 `onDestroy` 清理 · N8 `onPause` 正确暂停 · N9 补 `Native.copy`（剪贴板）· `shouldOverrideUrlLoading` 白名单

**桥方法现状**：新增 `syncTimeAsync` / `copy`；其余 18 个签名未变。proguard 的 `-keep class com.yjb.lite.JsBridge { *; }` 已覆盖。

---

## 四之二、第二批修复（23:00–23:20：返回键 · 日志 · 返回动画）

### 1. 主 tab 按返回 = 直接退出 App

四个主 tab（资产 / 行情 / 发现 / 我的）是**平级**的，规范上不该用返回键在它们之间导航。
原实现里 `canConsumeBack()` 末尾是 `return S.tab !== 'hold'`，导致：

| 当前所在 | 修复前 | 修复后 |
|---|---|---|
| 资产 | 退出 | 退出 |
| 行情 / 发现 / 我的 | **跳到资产页**（要按第二次才退得出去） | **直接退出** |
| 二级页 / 设置 / 弹层 | 正常返回 | 正常返回 |

改动：`canConsumeBack()` 去掉那个兜底、`nav.onBack()` 去掉「先回首页」分支。

### 2. 预测式返回动画（这次是真正实现了）

**关键转变**：手势阶段就必须看得见「返回后到达的那一页」。
但单 WebView 架构下，盖图底下本来就是当前页，硬推只会看到「同一页叠两层」。

所以流程改成：

1. `onBackStarted`：**同步**截图当前页 → 盖在最上层（用户无感）
2. 紧接着 `window.__beginBackPreview()`：记状态快照 + **真的执行一次返回**
   → WebView 此刻已经渲染出目标页，只是被盖图挡着
3. `onBackProgressed`：盖图跟手平移 → **露出的就是货真价实的目标页**
4. `onBackCancelled`：`window.__cancelBackPreview()` 回滚状态并重渲染，盖图滑回原位；
   两层内容一致，衔接无缝
5. `onBackInvoked`：盖图滑出淡出，目标页就位

**方向跟随**：`BackEvent.swipeEdge`（API 34+，API 33 用 `touchX` 近似）决定符号，
左边缘滑入页面向右推出、右边缘滑入页面向左推出。

### 3. 踩到的坑：手势中途注销回调会把整个手势链路切断

`onBackStarted` 里执行返回后，JS 必然同步一次 `canGoBack=false`。
如果此刻真的去 `unregisterOnBackInvokedCallback()`，**系统会判定手势被取消**，
转头调 `onBackCancelled` → 页面回滚。用户看到的是「边缘划了一下，什么都没发生」。

修法：加 `backGestureActive`，手势期间 `onBackStateChanged` 只记 `pendingBackState`，
手势结束后再应用（`onBackInvoked` 延后一帧，`onBackCancelled` 直接丢弃积压值）。

另一个坑：`unregisterBackCallback()` 末尾会调 `endBackPreview()`，
而它会在换页后被触发 —— 如果无脑摘掉盖图，退场动画几毫秒内就被掐死。
所以加了 `backBusy` 标志，手势预览与退场动画期间禁止任何强行清理。

### 4. 明文流量被拦：资讯正文全部抓不到

日志里的

```
E 请求失败 finance.eastmoney.com/news/... | ERR:CLEARTEXT communication
  to finance.eastmoney.com not permitted by network security policy
```

根因：东财资讯接口返回的 `url` 字段是 `http://`，而 network security config 默认禁明文。
修法：`httpGet()` 入口加 `upgradeToHttps()` —— 一律升级成 https，
**唯独放行 `212.129.244.148`**（宝妈指数没有 HTTPS，已在 config 里单独开）。
实测东财新闻正文恢复抓取（297 字符），0 失败请求。

### 5. 日志时间：UTC 与本地时间混用 + 顺序混乱

两个独立问题：

- **时区**：`diag._push` 用 `new Date(nowMs()).toISOString()` → UTC，
  在东八区**整整少 8 小时**（调试页显示 14:58、实际 22:58）。
  而对时那条走 `nowHHMM()` 是本地时间，两套时间轴混在同一份日志里。
  修法：新增 `hhmmss()` 统一本地时间；`toISOString` 在这个文件里只剩 3968 行那处（那里已经手动 +8 小时）。
- **顺序**：`diag` 走 250ms 批量推送，对时那条走直写通道，两者交错写入 ——
  实测出现过「性能监控已启动」排在「22:58 时间已同步」**后面**。
  修法：`_queue` 每行都带上 `HH:MM:SS`，即使文件顺序乱也能按时间排序。

**教训**：排查时不能靠日志文件里的排列顺序推断事件先后。

### 6. 构建脚本加保险

`tool/build_all.sh` 原来在 gradle 失败后仍会继续 zipalign + 签名，
用的是**上一次**的 unsigned APK —— 会签出一个「看起来成功、其实是旧版」的包。
已修：开跑前删掉旧产物，gradle 退出码非 0 立即 exit。

### 7. 界面调整（用户要求）

| 改动 | 说明 |
|---|---|
| 底部导航图标 | 「资产」柱状图 → **钱包**；「行情」四个方块 → **折线 + 端点**（蜡烛在 21px 下糊成两根针，弃用）；「发现 / 我的」不动 |
| 顶栏 | 搜索 + 加号 → **日/夜模式切换按钮**（太阳↔月亮交叉旋转淡入，纯 transform/opacity） |
| 隐藏金额图标 | emoji 🙈/👁 → **线性睁眼/闭眼**（点一下有眨眼似的旋转切换）；emoji 各系统字形不一还自带颜色，跟单色线性图标不搭 |
| 添加基金入口 | 从顶栏「＋」移到**持仓列表最下方**，跟着列表滚动；空列表时也会出现 |
| 历史页 | 「收益率」→ **总资产涨跌**：主数字从百分比换成**金额**（带千分位），并给出「期初 → 期末」；金额由净值化曲线反推（期初 = 当前总资产 × 期初指数 ÷ 期末指数），不必另存历史快照 |

**注意**：顶栏那个「＋」被挪走后，`bindGlobal()` 里原来的 `btnSearch` / `btnAdd` 绑定必须一起删掉，
否则 `getElementById(...).onclick` 会对着 `null` 报错。

### 8. 底部指数条：改成循环滚动（本次）

**指数清单与顺序**（`IDXBAR_ORDER`，数组顺序即展示顺序）：

```
上证指数 → 沪深300 → 深证成指 → 创业板指 → 科创50 → 国证A指 → 纳斯达克 → 标普500 → 道琼斯
```

排序逻辑：先 A 股宽基（上证是第一风向标，沪深300 是机构基准，然后才是风格指数；
国证A指覆盖沪深全市场，属于「总览」，收尾），再美股（纳斯达克→标普500→道琼斯，按关注度）。

**「A 股全指」的选型坑**：`sh000985`（中证全指）在新浪**没有数据**（返回全 0、名称空），
`sh000002` 只是上证 A 股。实测可用的是 **`sz399317` 国证Ａ指**，覆盖沪深全市场。
`sz399317` 原本不在 `GLOBAL_GROUPS` 里，已补进去（`allGlobal()` 才会拉到它）。

**无缝循环的做法**：内容复制两份，CSS 动画整体左移 `50%`（正好一份宽）。
⚠️ 这里**不能用 flex 的 `gap`** 做间距 —— 两份之间会多出一个间隙，总宽就不是 2 倍、
`-50%` 对不齐，循环到接缝会跳一下。间距一律放在每个 `.grp` 自己的 `margin-right` 里。

**速度**：时长按内容宽度算，保证**线速度恒定** 48px/s（写死时长的话，指数一多就跑飞、一少就发困）。
实测 1370px 一份 → 28.55s 一轮。按住暂停，松开继续；系统开「减少动效」则退回手动横向滚动。

**渲染幂等**：只在内容真的变了才重写 `innerHTML`（用 `dataset.sig` 比对），
否则每 30 秒一次的指数刷新会把动画打断、从接缝处跳一下。

## 四之三、第三批：数据库 · 收益修正 · AI 接入（10-21 凌晨）

### 1. 本地数据库：IndexedDB（`db` 模块）

**为什么不是 SQLite**：这个 App 的数据全在 WebView 的 JS 侧。SQLite 要走 JS↔Java 桥，
每次读写都是一次 IPC，而 `holdCache` / `predLog` 属于高频小读写，跨进程反而更慢。
IndexedDB 浏览器原生、支持事务与索引、容量按磁盘配额，且**零原生改动**。

**为什么是「内存为真相 + 异步落盘」**：IndexedDB 是异步 API，而现有代码到处是同步读
（`store.load()` 在启动时同步调用）。所以启动时一次性把全部数据读进内存，
之后所有读同步走内存；写则先改内存（立刻生效）再异步落盘。调用方几乎不用改。

**迁移的三条安全线**（对应「迁移不要产生 bug」）：
1. 值仍然存**字符串**，和 localStorage 完全一致 —— 调用方 parse 行为不变；
2. localStorage **一个字节都不删**，新库是「再加一份」而不是「搬走」，随时能退回去；
3. IndexedDB 打不开（隐私模式等）就整体退回 localStorage，功能不减。

另外关键数据（holdings/watch/设置）**双写** localStorage：IndexedDB 的事务在页面被强杀时
可能来不及提交，而 localStorage 是同步落盘的。

**实测**：迁移前 localStorage 8 条 → 迁移后仍 8 条（未删），内存 9 条（含 meta），
holdings/watch/themeMode/modelstats/缓存全部正确迁移，重启后读取正常。
（顺带发现数据量已 **1.03MB**，localStorage 的 5MB 上限确实快成问题了。）

### 2. 总资产涨跌：修正 + 支持清仓/加仓/减仓

**原 bug**：`buildPerfCurve` 拿**当前份额**乘**历史净值**回溯 60 天，等于假设
「这套组合你从一开始就持有」。用户明明是最近才买入的，却看到买入之前那段时间的涨跌。

**修复**：
- 新增 `txLog`（持仓变更流水）：每次改份额记一条快照，加仓/减仓/清仓都能还原
- 逐日还原真实份额，而不是当前份额一刀切
- 用**时间加权收益率（TWR）**：`r = (今日市值 - 昨日市值 - 今日净流入) / 昨日市值`
  —— 减掉净流入这一步是关键，没有它用户加仓当天曲线会凭空跳升
- 起始日：买入日 → 加入日期 → 按成本价在净值上反推；曲线从真正开始持仓那天算起

**实测**：10-13 才买入 → 曲线只显示 **6 天**（`startDate` = 买入日，跳过前 54 天）；
09-22 加仓 5000→20000 份 → 当日**无跳升**，最大单日 3.54%（真实行情）。

### 3. AI 估值校准

**定位：只做元决策，不做数值回归。**
LLM 是采样输出（同一输入两次可能给 0.93 和 0.9322）、延迟十几秒且不确定，
而盘中估值要频繁刷新。数值回归交本地最小二乘（快且可复现）；
AI 负责**看模式、说原因** —— 本地只能知道「误差变大了」，说不出为什么。

**模型选型**：`deepseek-v4-flash`。7 个候选里实测最合适：支持 `json_mode`（输出可直接
parse）、免费、带推理、约 20 秒。注意 `sensenova-6.8-flash-lite` 虽然也在模型列表里，
但引擎经常返回 500，不适合放进自动流程。

**触发时机**：`refreshAll()` **所有刷新跑完之后**，且不 await —— 它要读刚结算完的误差账本
和最新报告期，早了就是拿旧数据判断；但它要跑十几秒，绝不能挡住界面。

**四层保护**（对应「别让 AI 一直崩溃」）：
1. 结果缓存：同基金 + 同报告期 + 同误差序列只调一次
2. 失败退避：连续失败 3 次 → 冷却 30 分钟，绝不反复重试
3. 串行 + 超时：同时最多 1 个请求在飞，间隔 1.2 秒，单次 90 秒
4. 完全降级：任何失败都不影响原有预估

**输出钳制**：权重系数 0.6~1.5，置信度 < 0.4 整条丢弃（它自己都没把握，不如不动）。
权重建议超过 7 天不再采信。

**实测对话**：
```
输入误差：index  +0.21 -0.33 +0.33 -0.23 -0.03
          holdings  +0.55 -0.42 +0.38
AI 诊断：「指数拟合不准，β漂移，误差来回跳」
调整建议：index×0.6  holdings×1.0  置信 0.5  风格=行业主题
```
准确识别出「误差来回跳 → 指数/β 问题」，这正是本地算法做不到的部分。

### 4. 界面柔和 + 毛玻璃

- 深色底从 `#0A0D12`（近纯黑）抬到 `#12161D`，卡片 `#1A1F28` —— 纯黑上白字对比过强，
  久了刺眼，而且纯黑底上阴影完全看不出来，层次只能靠描边撑
- 浅色底从 `#F4F6F9` 压到 `#EDF1F7`，正文用 `#141A22` 而非纯黑
- 分隔线改成**半透明**，叠在毛玻璃卡片上才自然融进去
- body 铺两团低饱和光斑：**毛玻璃要有东西可模糊才看得出效果**，纯色底上加 blur 等于白付
  一层离屏合成开销
- 毛玻璃只加在容器级元素（卡片/顶栏/底栏/弹层/分段条）；列表行用半透明底但不模糊 ——
  一行几十个，逐个做离屏模糊 GPU 吃不消
- `prefers-reduced-transparency` 下自动关掉模糊

### 5. 报告发布时点（此前已完成）

`holdingsFreshness()` 原来按**报告期**距今算，会在「报告期刚过、报告还没发布」的窗口里
给一个已过期三个半月的持仓满分信任。改为按**发布日**算（季报 = 季末 + 21 天，年报 = 次年 3/28）。
一年 4 个这样的窗口、合计约 84 天，现在这部分权重从 1.0 降到 0.25。

## 四之四、第四批：锁定技术栈 · 砍 OCR · AI 启动数据（10-21 凌晨）

### 0. 版本控制（此前完全没有）

`git init` + baseline 提交 `dc31c16`，`.gitignore` 排除 `build/` `.gradle/` `*.apk` `*.jks` `.bak/` `.baseline/`。
另存 `.baseline/` 一份优化前的 index.html + APK + SHA256（双保险，不依赖 git）。

### 1. 技术栈审计结论：**锁定现有栈，不迁移**

| 候选 | 结论 | 依据 |
|---|---|---|
| Kotlin + WebView（现有） | **锁定** | 性能达标；界面零改动 |
| Tauri 2 (Rust) | 否决 | **UI 仍是 WebView**，只换外壳；要重写全部原生桥 |
| Kotlin + Compose | 否决 | HTML 界面必须整体重写，违反「界面保持原老界面」 |
| Flutter / RN | 否决 | 同上，且引入更大运行时 |

**决定性证据**：APK 22.4MB 里 **79.8% 是 ML Kit OCR**（19.8MB），UI 层只占 1.9%。
换 UI 技术栈对体积、性能几乎无影响，却要重写全部界面。
真正的瓶颈是**工程问题**（无版本控制、单文件 13k 行、死代码），换栈一个都解决不了。

### 2. 砍掉 OCR：APK 22.4MB → 2.1MB（−90.6%）

移除内容：`mlkit text-recognition-chinese` 依赖、`ocr/**`(298 行)、`data/**`(294 行，Room 死链)、
`ArticleExtractor.kt`(257 行)、原生阅读层实现(~200 行)、`assets/readability.js`(84KB)、
`assets/extract.js`(9KB)、JS 侧截图导入整段(`matchFundCode`/`similarity`/`derivePosition`/`doImport`/`renderImportSheet`)。

| 指标 | 优化前 | 优化后 | 变化 |
|---|---|---|---|
| **APK** | 22,407,418 B | **2,095,177 B** | **−90.6%** |
| classes.dex | 2,333,900 | 1,541,428 | −34% |
| Kotlin 行数 | 4,139 | **2,261** | −45% |
| mlkit/ocr 残留 | — | **0** | 彻底移除 |
| 冷启动 | 379~729ms | **468ms** | 持平 |

**低风险删除策略**：阅读层的 `openReader`/`closeReader` 签名**保留**（空实现），
不动返回键分发与生命周期里那些 `if (reader != null)` 分支 —— 删签名会连带改一堆
与本次优化无关的结构，风险不值当。

### 3. AI 校准的「启动数据」

**问题**：新装用户 / 刚加入的基金，`modelBook` 里一条误差样本都没有，
点「立即校准」只会得到「样本不足，暂不需要校准」—— 功能形同没接。

**解法**：不是预置假数据，而是**用真实历史回演**。
手上本来就有完整净值历史与跟踪指数历史，按日期对齐逐日比一遍即可：

```
预估 = 指数当日涨跌 × β
误差 = 预估 - 实际
```

**关键设计**：
- **主动基金认不出跟踪指数**（`indexOf()` 返回 null）时，用**沪深300 作代理**，
  并**如实告知 AI**「这是代理，不是真实跟踪标的」—— 否则它会把误差归因搞反。
  实测 AI 拿到「沪深300（代理）」后自己就判断出「指数代理失准，压指数」。
- **β 也真实回归**：用 `regressBeta()` 对这批真实数据拟合（主动基金不会走 `predict.byIndex`）。
- 剔除单日涨跌 >15% 的样本（分红除息 / 份额拆分日，单位净值本就该跳）。
- 结果按「基金 + 净值最新日期」缓存，同一批历史只回演一次。

**真机实测**：
```
AI 启动数据 015789 · 回演 12 条（代理指数 sh000300，β=0.79）
AI 校准 015789 · 指数代理失准，β漂移，压指数 · index×0.6 holdings×1.3
AI 启动数据 021179 · 回演 12 条（代理指数 sh000300，β=0.14）
```
021179 的 β 只有 0.14（与大盘几乎不相关），AI 据此把指数法权重压到 0.6 —— 判断正确。
## 五、审计工具（本轮新建，下次修 bug 直接用）

| 文件 | 作用 |
|---|---|
| `tool/wvtest/lib_audit.js` | **无头 Edge 审计框架**。每次运行自动把 `assets/index.html` 拷成 `app_test.html`（漏拷贝会测到旧副本，出过假结论）；注入 Native 桥替身；**网络走 Node http(s)**，`refererFor`/`uaFor` 与 `JsBridge.kt` 逐条 1:1 镜像 |
| `tool/wvtest/lead/sweep.js` | 全界面 19 步交互回归（含 pageerror 捕获） |
| `tool/wvtest/lead/cssdiff.js` | **CSS 契约检查**：算出「页面在用但没有任何规则」的类 |
| `tool/wvtest/lead/scan.js` | state key 拼写 + `data-*` 属性契约检查 |
| `tool/wvtest/lead/dead.js` | 找出定义后从未被调用的顶层函数 |
| `tool/wvtest/lead/dupclass.js` | 找出重复的 `class` 属性 |
| `tool/wvtest/BUGS-{runtime,static,native}.md` | 三份审计报告（共 30 条，均已修或在下方列出） |
| `tool/wvtest/FIXES-native.md` | 原生层修复逐条说明 |

**审计框架最重要的一条**：浏览器里 `fetch` 改不了 Referer，而新浪/东财/腾讯全靠 Referer 放行。
用 `fetch` 测出来的「403 / 数据出不来」**全是假象**。必须用 Node 侧发请求。

---

## 六、调试方法

### 日志（Android 17 的 logcat 读不到 release 输出，走文件通道）

```bash
D:/tools/android-sdk/platform-tools/adb.exe -t 1 shell "cat /sdcard/Android/data/com.yjb.lite/files/dsh/log.txt"
```

注意：MSYS 会把 `/sdcard/x` 当相对路径，**要用 `//sdcard/x`**。

日志开关在「我的 → 设置 → 记录运行日志」，默认开。
记录内容：启动、页面切换、净值校准、接口失败、慢请求、性能采样、JS 错误。

### 性能采样（每 30 秒一条）

```
性能 帧率 60 · 堆 21/256MB · JS堆 10MB · 设备余 2776MB · 线程 70 · CPU 2.9% · DOM 95
```

### 数据源自检

「我的 → 设置 → 数据源自检」，逐个测试 18 个接口，显示耗时和结果。

### 真机操作

```bash
ADB=D:/tools/android-sdk/platform-tools/adb.exe
$ADB -t 1 install -r D:/work/yjb_lite/yjblite.apk
$ADB -t 1 shell am force-stop com.yjb.lite && $ADB -t 1 shell am start -n com.yjb.lite/.MainActivity
$ADB -t 1 shell screencap -p //sdcard/s.png && $ADB -t 1 pull //sdcard/s.png /tmp/s.png
```

---

## 七、未完成 / 已知问题

### 待办

1. **`findfin` 热力图偶尔 7~23 秒**。已加 `refreshHeat` 重入保护（防三处触发叠加），
   但源本身的延迟只能靠缓存缓解。
2. **资讯按板块分类**仍是关键词匹配，准确率有限。
3. **新基金历史推算结果未持久化**，每次重启重算。
4. **死代码未清理**：`viewHold()` / `viewWatch()` / `viewMood()` / `viewNews()` /
   `viewHotRank()` / `matchBoard()` / `sparkline()` / `traced()` / `tracedGet()` /
   `refreshIndexValuation()`（后者功能已由 `refreshMarket` 覆盖）。
   危害：R2 的入口元素就是藏在 `viewHold()` 里才失踪的。**下次重构优先删掉**。
5. **帧率只有 60**（设备是 120Hz）。可研究 WebView 刷新率与 `preferredRefreshRate`。
6. **`assets/readability.js`(84KB) / `extract.js` 与原生阅读层整链不可达**（index.html 从不调
   `Native.openReader`）——要么接上，要么连同 `ArticleExtractor.kt` / `data/**` 一起删。

### 已知限制（不是 bug）

- 东财 `push2` 系列在当前网络不可达，属网络层限制
- `developer.android.com` 本机不可访问（用 `developer.android.google.cn`）
- 基金只有单位净值、没有 OHLC，所以**基金详情页画的是折线**；蜡烛图用在板块详情页
- `fundgz` 盘中估值源已下线（见上）

---

## 八、容易踩的坑

1. **改完 index.html 必须跑**：`python /tmp/dshsess/extract.py` → `node --check D:/tmp/dshsess/app.js`。
   直接看 index.html 看不出语法错。
2. **PC 测试前必须把当前 index.html 拷成 app_test.html**。
   `lib_audit.js` 已自动做，手写脚本容易漏 —— 曾因此得出「`sectorQuoteCode` 未定义」的假结论。
3. **PC 测试的网络必须走 Node**，不能用浏览器 `fetch`（改不了 Referer → 一片 403）。
   而且 `refererFor` 要和 `JsBridge.kt` **逐条镜像**（我手写"更精确"的版本反而让 fundf10 全 404）。
4. **正则批量替换很危险**。曾把 `indexOf(';')` 改坏、大括号配平出错删掉四分之三文件。
   恢复手段：从已打包的 APK 里提取 `unzip -p yjblite.apk assets/index.html`。备份在 `.bak/`。
5. **项目没有 git**。所以上面那条尤其重要。
6. **R8 会删掉 JS 桥方法**。必须 `-keep class com.yjb.lite.JsBridge { *; }`。
7. **`@JavascriptInterface` 参数类型强匹配**。JS 传数组给 Kotlin 的 `String` 会静默失败，必须 `JSON.stringify`。
8. **日志有白名单过滤**。关键词：`/启动|切换页面|自检|校准|失败|异常|性能|掉帧|监控|净值/`。
9. **CSS 类改名的隐性代价**：设计系统 v2 重写时漏了一批类，页面上不报错、只是"变朴素了"，
   很容易被当成"设计如此"。用 `lead/cssdiff.js` 定期扫一遍。
10. **`switchTab()` 会重写 tab 名**（`watch→hold`、`mood/news→discover`）。
    任何"根据当前在哪个页面"做判断的代码，都要用映射后的值或 `S.assetSeg`/`S.discoverSeg`，
    否则就是死分支 —— B2、R1、R6 三个 bug 都是同一个病根。

---

## 九、文件索引

| 文件 | 作用 |
|---|---|
| `app/src/main/assets/index.html` | 全部 UI 与逻辑（约 330KB JS + 完整 CSS） |
| `app/src/main/assets/readability.js` | Mozilla Readability（**目前不可达**） |
| `app/src/main/assets/extract.js` | 阅读层提取脚本（**目前不可达**） |
| `app/src/main/java/com/yjb/lite/MainActivity.kt` | 双 WebView、预测性返回、状态栏、渲染进程崩溃恢复 |
| `app/src/main/java/com/yjb/lite/JsBridge.kt` | OkHttp、DNS、编码检测、日志、性能采集、对时、剪贴板 |
| `app/src/main/java/com/yjb/lite/ArticleExtractor.kt` | 正文提取（**已被 assets/extract.js 取代，不可达**） |
| `tool/build_all.sh` | 一键构建 + 签名 + 校验 |
| `tool/wvtest/` | PC 端审计脚本与报告 |
| `.bak/` | 备份（18:26 的 index.html + APK） |
