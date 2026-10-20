const { withPage } = require('../lib_audit');
(async () => {
  const r = await withPage(async (p, errors) => {
    await p.waitForTimeout(10000);
    await p.evaluate(() => {
      S.holdings = [
        { code: '015789', name: '永赢高端装备智选混合发起A', shares: 12000, costNav: 0.89, group: '默认', divMode: 'cash' },
        { code: '021179', name: '易方达产业机遇混合A', shares: 5000, costNav: 2.9, group: '默认', divMode: 'reinvest' },
      ];
      S.watch = [{ code: '161725', name: '招商中证白酒指数(LOF)A' }];
      store.save();
    });
    await p.evaluate(() => refreshAll(true));
    await p.waitForTimeout(13000);

    const pages = [
      ['资产', () => { switchTab('hold'); }],
      ['资产-自选', () => { S.assetSeg = 'watch'; renderNow(); }],
      ['行情-大盘', () => { switchTab('market'); S.mktSeg = 'index'; renderNow(); }],
      ['行情-板块', () => { S.mktSeg = 'industry'; renderNow(); }],
      ['行情-分布', () => { S.mktSeg = 'concept'; renderNow(); }],
      ['行情-全球', () => { S.mktSeg = 'global'; renderNow(); }],
      ['发现-情绪', () => { switchTab('discover'); S.discoverSeg = 'mood'; renderNow(); }],
      ['发现-资讯', () => { S.discoverSeg = 'news'; renderNow(); }],
      ['我的', () => { switchTab('me'); }],
      ['设置', () => { S.tab = 'settings'; renderNow(); }],
      ['调试日志', () => { S.tab = 'diag'; renderNow(); }],
    ];
    const bad = [];
    for (const [name, fn] of pages) {
      await p.evaluate(fn);
      await p.waitForTimeout(1400);
      const txt = await p.evaluate(() => document.getElementById('main').innerText);
      const hits = [];
      if (/\bNaN\b/.test(txt)) hits.push('NaN');
      if (/\bundefined\b/.test(txt)) hits.push('undefined');
      if (/\[object Object\]/.test(txt)) hits.push('[object Object]');
      if (hits.length) bad.push({ name, hits, sample: txt.slice(0, 120).replace(/\n/g, '|') });
    }
    return { checked: pages.length, bad };
  });
  console.log(JSON.stringify(r.result, null, 1));
  console.log('pageerrors:', JSON.stringify(r.errors.filter(e => e.kind === 'pageerror').map(e => e.message)));
})();
