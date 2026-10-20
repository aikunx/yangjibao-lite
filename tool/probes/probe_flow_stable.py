"""验证资金流接口的稳定性，确定可用参数组合。

发现：
  - fid=f62（按主力净流入排序）时服务端偶发 RemoteDisconnected
  - fid=f3（按涨跌幅排序）稳定
  - 因此策略：请求用 f3 排序，拿 60 条后在前端本地排序
"""

import json
import ssl
import time
import urllib.request

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")

FIELDS = ("f12,f14,f2,f3,f62,f184,f66,f72,f78,f84,f87,"
          "f104,f105,f128,f136")


def fetch(url: str) -> tuple[int, str]:
    req = urllib.request.Request(url, headers={
        "User-Agent": UA,
        "Referer": "https://data.eastmoney.com/",
    })
    try:
        with urllib.request.urlopen(req, timeout=20,
                                    context=ssl.create_default_context()) as r:
            return r.status, r.read().decode("utf-8", "replace")
    except Exception as exc:  # noqa: BLE001
        return -1, f"{type(exc).__name__}"


def try_call(fs: str, fid: str, pz: int, retries: int = 3):
    url = ("https://push2.eastmoney.com/api/qt/clist/get"
           f"?pn=1&pz={pz}&po=1&np=1&fltt=2&invt=2&fid={fid}&fs={fs}"
           f"&fields={FIELDS}")
    for i in range(retries):
        st, body = fetch(url)
        if st == 200:
            try:
                j = json.loads(body)
                diff = (j.get("data") or {}).get("diff") or []
                return len(diff), diff
            except json.JSONDecodeError:
                pass
        time.sleep(0.6)
    return 0, []


def main() -> None:
    print("=== 稳定性测试：每种请求试 3 次 ===")
    for label, fs in [("行业板块", "m:90+t:2"), ("概念板块", "m:90+t:3")]:
        for fid in ("f3", "f62"):
            n, diff = try_call(fs, fid, 60)
            print(f"{label} fid={fid:4s} -> {n} 条")

    # 用 f3 拿 60 条，本地按主力净流入排序，验证数据完整性
    print()
    print("=== 本地排序验证（行业板块）===")
    n, diff = try_call("m:90+t:2", "f3", 60)
    rows = [r for r in diff if isinstance(r.get("f62"), (int, float))]
    rows.sort(key=lambda r: r["f62"], reverse=True)
    print(f"共 {len(rows)} 条有资金流数据")
    print("--- 主力净流入 Top5 ---")
    for r in rows[:5]:
        print(f"  {r['f14']:12s} 涨跌 {r['f3']:>6}%  "
              f"主力净流入 {r['f62']/1e8:>7.2f}亿  "
              f"散户净流入 {r['f84']/1e8:>7.2f}亿")
    print("--- 主力净流出 Top5 ---")
    for r in rows[-5:]:
        print(f"  {r['f14']:12s} 涨跌 {r['f3']:>6}%  "
              f"主力净流入 {r['f62']/1e8:>7.2f}亿  "
              f"散户净流入 {r['f84']/1e8:>7.2f}亿")


if __name__ == "__main__":
    main()
