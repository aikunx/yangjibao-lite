"""确定资金流接口的最佳调用方式。

结论方向：
  - 必须用 fid=f62 才能拿到资金流字段
  - 但该请求偶发 RemoteDisconnected，需要重试
  - 加长间隔 + 重试 5 次看成功率
"""

import json
import ssl
import time
import urllib.request

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")

FIELDS = "f12,f14,f3,f62,f184,f66,f72,f78,f84,f87,f104,f105,f128,f136"


def fetch(url: str) -> tuple[int, str]:
    req = urllib.request.Request(url, headers={
        "User-Agent": UA,
        "Referer": "https://data.eastmoney.com/",
        "Accept": "*/*",
        "Accept-Language": "zh-CN,zh;q=0.9",
        "Connection": "keep-alive",
    })
    try:
        with urllib.request.urlopen(req, timeout=25,
                                    context=ssl.create_default_context()) as r:
            return r.status, r.read().decode("utf-8", "replace")
    except Exception as exc:  # noqa: BLE001
        return -1, f"{type(exc).__name__}"


def call_with_retry(fs: str, pz: int = 60, retries: int = 5):
    url = ("https://push2.eastmoney.com/api/qt/clist/get"
           f"?pn=1&pz={pz}&po=1&np=1&fltt=2&invt=2&fid=f62&fs={fs}"
           f"&fields={FIELDS}")
    for i in range(retries):
        st, body = fetch(url)
        if st == 200:
            try:
                j = json.loads(body)
                diff = (j.get("data") or {}).get("diff") or []
                if diff:
                    return diff, i + 1
            except json.JSONDecodeError:
                pass
        time.sleep(1.2)
    return [], retries


def main() -> None:
    print("=== 重试机制测试（行业板块，最多 5 次）===")
    ok = 0
    for round_i in range(5):
        diff, tries = call_with_retry("m:90+t:2")
        has_flow = sum(1 for r in diff if isinstance(r.get("f62"), (int, float)))
        print(f"  第{round_i+1}轮: 第{tries}次成功, {len(diff)} 条, "
              f"含资金流 {has_flow} 条")
        if diff:
            ok += 1
        time.sleep(1.5)
    print(f"  成功率 {ok}/5")
    print()

    if diff:
        rows = [r for r in diff if isinstance(r.get("f62"), (int, float))]
        rows.sort(key=lambda r: r["f62"], reverse=True)
        print("--- 主力净流入 Top5 ---")
        for r in rows[:5]:
            print(f"  {r['f14']:14s} {r['f3']:>6}%  "
                  f"主力 {r['f62']/1e8:>7.2f}亿  "
                  f"超大单 {r['f66']/1e8:>7.2f}亿  "
                  f"散户 {r['f84']/1e8:>7.2f}亿")
        print("--- 主力净流出 Top5 ---")
        for r in rows[-5:]:
            print(f"  {r['f14']:14s} {r['f3']:>6}%  "
                  f"主力 {r['f62']/1e8:>7.2f}亿  "
                  f"超大单 {r['f66']/1e8:>7.2f}亿  "
                  f"散户 {r['f84']/1e8:>7.2f}亿")


if __name__ == "__main__":
    main()
