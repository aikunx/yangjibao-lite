/**
 * 审计框架：把当前 index.html 加载进无头 Edge，注入原生桥的替身，
 * 真实联网，捕获一切 JS 错误。
 *
 * 两个关键设计（都是踩过坑才加的）：
 *
 * 1) 每次运行都把 assets/index.html 拷成 app_test.html。
 *    之前忘了拷贝，测的是旧副本，得出了「sectorQuoteCode 未定义」的假结论。
 *
 * 2) 网络走 Node 的 http(s) 模块，不走浏览器 fetch。
 *    浏览器 fetch 里 Referer 是禁止头，改不了；而新浪/东财/腾讯这几个源
 *    都靠 Referer 放行，缺了它一律 403。用 fetch 测出来的
 *    「净值出不来」「指数 403」全是假象，真机上是好的。
 *    Node 侧没有这个限制，能 1:1 复刻 JsBridge 的请求头。
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { chromium } = require('playwright-core');

const SRC = 'D:/work/yjb_lite/app/src/main/assets/index.html';
const TEST = path.join(__dirname, 'app_test.html');
const EDGE = 'C:\\\\Program Files (x86)\\\\Microsoft\\\\Edge\\\\Application\\\\msedge.exe';

function stage() {
  const st = fs.statSync(SRC);
  fs.copyFileSync(SRC, TEST);
  return { bytes: st.size, mtime: st.mtime.toISOString() };
}

/* UA 与 JsBridge.kt 的 DESKTOP_UA 保持一致 */
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const DESKTOP_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/**
 * 与 JsBridge.kt:295 的 refererFor **逐条 1:1 对齐**。
 *
 * 必须镜像它的 `contains` 语义，不能自作聪明写得更"精确"：
 * 我一开始把 fundf10.eastmoney.com 归到 quote.eastmoney.com 的 Referer，
 * 结果 24 个请求全 404，差点报成一个不存在的 App bug。
 * 而 App 用的是 `url.contains("fund")` → fund.eastmoney.com，是对的，服务端 200。
 * 顺序也要一致，否则先命中的分支不同。
 */
function refererFor(url) {
  if (url.includes('hq.sinajs.cn') || url.includes('sinajs')) return 'https://finance.sina.com.cn/';
  if (url.includes('sina')) return 'https://finance.sina.com.cn/';
  if (url.includes('gtimg.cn')) return 'https://gu.qq.com/';
  if (url.includes('fund')) return 'https://fund.eastmoney.com/';
  if (url.includes('10jqka')) return 'https://www.10jqka.com.cn/';
  if (url.includes('findfin')) return 'https://map.findfin.app/';
  if (url.includes('212.129.244.148')) return 'http://212.129.244.148:8890/';
  return 'https://finance.eastmoney.com/';
}

/** 与 JsBridge.kt:230 的 UA 分场景 1:1 对齐 */
function uaFor(url) {
  if (url.includes('gtimg.cn') || url.includes('/api/qt/') || url.includes('pingzhongdata')) return DESKTOP_UA;
  return UA;
}

function nodeGet(url, gbk) {
  return new Promise(function (resolve) {
    const t0 = Date.now();
    let mod;
    try { mod = new URL(url).protocol === 'http:' ? http : https; }
    catch (e) { return resolve({ status: 0, err: 'badurl', ms: 0 }); }
    const headers = {
      'User-Agent': uaFor(url),
      'Accept': 'application/json, text/plain, text/html, */*',
      'Accept-Language': 'zh-CN,zh;q=0.9',
      'Accept-Encoding': 'identity',
    };
    // 总是带 Referer：JsBridge 也是无条件 .header("Referer", ref)
    headers['Referer'] = refererFor(url);
    const req = mod.get(url, { headers: headers, timeout: 15000 }, function (res) {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve({ status: res.statusCode, err: 'redirect', ms: Date.now() - t0 });
      }
      const chunks = [];
      res.on('data', function (c) { chunks.push(c); });
      res.on('end', function () {
        const buf = Buffer.concat(chunks);
        let text;
        try { text = new TextDecoder(gbk ? 'gbk' : 'utf-8').decode(buf); }
        catch (e) { text = buf.toString('utf8'); }
        resolve({ status: res.statusCode, body: text, bytes: buf.length, ms: Date.now() - t0 });
      });
    });
    req.on('timeout', function () { req.destroy(new Error('timeout')); });
    req.on('error', function (e) { resolve({ status: 0, err: String(e.message), ms: Date.now() - t0 }); });
  });
}

function nodePost(url, body, auth) {
  return new Promise(function (resolve) {
    const t0 = Date.now();
    let mod;
    try { mod = new URL(url).protocol === 'http:' ? http : https; }
    catch (e) { return resolve({ status: 0, err: 'badurl', ms: 0 }); }
    const data = Buffer.from(String(body || ''), 'utf8');
    const headers = {
      'User-Agent': UA,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'Content-Length': data.length,
    };
    if (auth) headers['Authorization'] = String(auth);
    const req = mod.request(url, { method: 'POST', headers: headers, timeout: 95000 }, function (res) {
      const chunks = [];
      res.on('data', function (c) { chunks.push(c); });
      res.on('end', function () {
        resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8'), ms: Date.now() - t0 });
      });
    });
    req.on('timeout', function () { req.destroy(new Error('timeout')); });
    req.on('error', function (e) { resolve({ status: 0, err: String(e.message), ms: Date.now() - t0 }); });
    req.write(data); req.end();
  });
}

const STUB = String.raw`
window.__stubErrors = [];
window.__nativeLogs = [];
window.__nativeCalls = [];
(function () {
  function reply(id, ok, payload) {
    setTimeout(function () { try { window.__onNative(id, ok, payload); } catch (e) {} }, 0);
  }
  window.Native = {
    now: function () { return Date.now(); },
    timeOffset: function () { return 0; },
    timeSyncedFlag: function () { return true; },
    forceSyncTime: function () { return true; },
    httpGet: function (url, gbk, cbId) {
      window.__nativeCalls.push({ m: 'httpGet', url: url });
      window.__nativeHttpGet(url, !!gbk).then(function (r) {
        if (r.status && r.status >= 200 && r.status < 400 && r.body != null) {
          reply(cbId, true, r.body);
        } else {
          reply(cbId, false, 'ERR:HTTP ' + (r.status || r.err || 'fail'));
        }
      }).catch(function (e) { reply(cbId, false, 'ERR:' + ((e && e.message) || e)); });
    },
    httpPost: function (url, body, auth, cbId) {
      window.__nativeCalls.push({ m: 'httpPost', url: url });
      window.__nativeHttpPost(url, body, auth).then(function (r) {
        if (r.status && r.status >= 200 && r.status < 400) reply(cbId, true, r.body);
        else reply(cbId, false, 'ERR:HTTP ' + (r.status || r.err || 'fail') + ' ' + String(r.body || '').slice(0, 200));
      }).catch(function (e) { reply(cbId, false, 'ERR:' + ((e && e.message) || e)); });
    },
    log: function (m) { window.__nativeLogs.push(String(m)); },
    logBatch: function (m) { window.__nativeLogs.push(String(m)); },
    writeLogText: function (m) { window.__nativeLogs.push(String(m)); },
    setTheme: function () {}, updateCanGoBack: function () {}, copy: function () {},
    pickImage: function (cbId) { reply(cbId, false, 'ERR:test'); },
    getStats: function () {
      return JSON.stringify({ heapUsed: 20, heapMax: 256, deviceAvail: 2000, threads: 40, cpu: 1.5, gpu: 0, dom: 60 });
    }
  };
})();
`;

async function withPage(opt, fn) {
  if (typeof opt === 'function') { fn = opt; opt = {}; }
  const info = stage();
  const b = await chromium.launch({
    executablePath: EDGE,
    headless: true,
    args: ['--disable-web-security', '--no-first-run', '--no-default-browser-check'],
  });
  const ctx = await b.newContext({
    viewport: opt.viewport || { width: 412, height: 892 },
    isMobile: true, deviceScaleFactor: 2, locale: 'zh-CN',
  });
  const p = await ctx.newPage();
  const errors = [];
  const net = [];
  p.on('pageerror', function (e) {
    errors.push({ kind: 'pageerror', msg: e.message, stack: String(e.stack || '').split('\n').slice(1, 4).join(' <- ') });
  });
  p.on('console', function (m) {
    if (m.type() === 'error') errors.push({ kind: 'console.error', msg: m.text().slice(0, 400) });
  });
  await p.exposeFunction('__nativeHttpPost', async function (url, body, auth) {
    const r = await nodePost(url, body, auth);
    net.push({ url: url, status: r.status, ms: r.ms, bytes: (r.body || '').length, err: r.err });
    return { status: r.status, body: r.body == null ? null : r.body, err: r.err };
  });
  await p.exposeFunction('__nativeHttpGet', async function (url, gbk) {
    const r = await nodeGet(url, gbk);
    net.push({ url: url, status: r.status, ms: r.ms, bytes: r.bytes, err: r.err });
    return { status: r.status, body: r.body == null ? null : r.body, err: r.err };
  });
  await p.addInitScript(STUB);
  const t0 = Date.now();
  await p.goto('file:///' + TEST.replace(/\\/g, '/'), { waitUntil: 'load', timeout: 60000 });
  let out;
  try {
    out = await fn(p, errors, net);
  } finally {
    await b.close();
  }
  return { result: out, errors: errors, net: net, staged: info, ms: Date.now() - t0 };
}

/** 网络失败汇总，方便判断"数据没出来"到底是源不可用还是前端 bug */
function netSummary(net) {
  const bad = net.filter(function (n) { return n.status !== 200; });
  const byHost = {};
  for (const n of net) {
    let h = 'bad';
    try { h = new URL(n.url).host; } catch (e) {}
    byHost[h] = byHost[h] || { n: 0, bad: 0, maxMs: 0 };
    byHost[h].n++;
    if (n.status !== 200) byHost[h].bad++;
    if (n.ms > byHost[h].maxMs) byHost[h].maxMs = n.ms;
  }
  return { total: net.length, failed: bad.length, byHost: byHost, badSample: bad.slice(0, 8) };
}

module.exports = { withPage, stage, netSummary, nodeGet, SRC, TEST, EDGE, refererFor };
