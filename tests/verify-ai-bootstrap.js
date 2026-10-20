const { withPage } = require('../lib_audit');
(async () => {
  const r = await withPage(async (p, errors) => {
    // 全新用户：清空整个 IndexedDB + localStorage
    await p.evaluate(async () => {
      try { db.idb && db.idb.close(); } catch (e) {}
      await new Promise(res => { const q = indexedDB.deleteDatabase('yjblite'); q.onsuccess = q.onerror = q.onblocked = () => res(); });
      localStorage.clear();
      db.mem = Object.create(null); db.ready = false; db.useIDB = false; db.idb = null;
      await db.open();
      modelBook.data = null; txLog.data = null;
      S.bootProxy = {};
    });
    await p.waitForTimeout(500);
    await p.evaluate(() => {
      S.holdings = [{ code: '015789', name: '永赢高端装备智选混合发起A', shares: 12000,
                      costNav: 0.89, group: '默认', divMode: 'cash' }];
      store.save();
    });
    await p.evaluate(() => refreshAll(true));
    await p.waitForTimeout(14000);

    const out = {};
    out.fresh = await p.evaluate(async () => {
      const before = (modelBook.summary('015789') || []).length;
      const evBefore = ai.evidence('015789');
      const got = await bootstrapErrorHistory('015789');
      const evAfter = ai.evidence('015789');
      return {
        samplesBefore: before,
        evidenceBefore: evBefore ? 'has' : 'null  ← 全新用户点「立即校准」就是这个状态',
        bootstrapped: got,
        evidenceAfter: evAfter ? 'has' : 'null',
        series: evAfter ? evAfter.series.index : null,
        proxyFlagged: !!(S.bootProxy && S.bootProxy['015789']),
      };
    });
    // 端到端：回演后立刻让 AI 校准
    out.aiRun = await p.evaluate(async () => {
      db.del('aitune'); db.del('aistate');
      const t0 = performance.now();
      const r = await ai.analyze('015789');
      return { ms: Math.round(performance.now() - t0), tune: r ? r.tune : null };
    });
    return out;
  });
  console.log(JSON.stringify(r.result, null, 1).slice(0, 2500));
  console.log('pageerrors:', JSON.stringify(r.errors.filter(e => e.kind === 'pageerror').map(e => e.message)));
})();
