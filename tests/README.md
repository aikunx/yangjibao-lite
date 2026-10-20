# 自动化审计

开发期用**无头 Edge** 加载真实 `index.html`、注入原生桥替身、连真实数据源，
把每个页面走一遍，捕获异常与渲染问题。

一个不能忘的前提：**每次都要先把 `assets/index.html` 拷成 `app_test.html`**。
曾经漏了拷贝，测的是旧副本，得出了「某函数未定义」的假结论，白查半天。
`lib_audit.js` 已经自动做了这件事。

另一个：**网络必须走 Node**，不能用浏览器 `fetch`。
浏览器里 `Referer` 是禁止头改不了，而新浪 / 东财 / 腾讯全靠 Referer 放行，
用 `fetch` 测出来一片 403，全是假象。

```bash
npm i playwright-core
node scan-pages.js           # 逐页扫 NaN / undefined / 报错
node verify-ai-bootstrap.js  # 验证 AI 启动数据回演
```
