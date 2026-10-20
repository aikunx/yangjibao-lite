"""找财联社「盘面异动」入口 + 东财盘口异动备选。"""
import hashlib
import json
import ssl
import time
import urllib.parse
import urllib.request

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")


def get(url, ref="https://www.cls.cn/"):
    req = urllib.request.Request(url, headers={
        "User-Agent": UA, "Referer": ref,
        "Accept": "application/json, text/plain, */*"})
    try:
        with urllib.request.urlopen(req, timeout=15,
                                    context=ssl.create_default_context()) as r:
            return r.status, r.read().decode("utf-8", "replace")
    except Exception as e:  # noqa: BLE001
        return -1, f"{type(e).__name__}: {e}"


def signed(params):
    q = urllib.parse.urlencode(sorted(params.items()))
    sign = hashlib.md5(hashlib.sha1(q.encode()).hexdigest().encode()).hexdigest()
    return q + "&sign=" + sign


base = {"app": "CailianpressWeb", "os": "web", "sv": "8.4.6"}
cands = [
    ("异动-roll", "https://www.cls.cn/v1/roll/get_roll_list",
     {**base, "category": "change", "rn": "20"}),
    ("异动-telegraphs", "https://www.cls.cn/nodeapi/telegraphs",
     {**base, "rn": "20"}),
    ("异动-plate", "https://www.cls.cn/v1/roll/get_plate_list", {**base}),
    ("异动-hq", "https://www.cls.cn/v1/roll/get_hq_roll", {**base, "rn": "20"}),
    ("异动-stock", "https://www.cls.cn/v1/roll/get_stock_roll", {**base, "rn": "20"}),
]
for name, u, p in cands:
    s, b = get(u + "?" + signed(p))
    print(f"[{s}] {name}: {b[:200]}")

print()
print("=== 东财盘口异动 ===")
for u in [
    "https://push2ex.eastmoney.com/getAllStockChanges?type=8201,8202,8193,4,32,64,8207,8209,8211,8213,8215&ut=7eea3edcaed734bea9cbfc24409ed989&pageindex=0&pagesize=20&dpt=wzchanges",
    "https://push2ex.eastmoney.com/getTopicZTPool?ut=7eea3edcaed734bea9cbfc24409ed989&dpt=wz.ztzt&Pageindex=0&pagesize=10&sort=fbt%3Aasc",
]:
    s, b = get(u, ref="https://quote.eastmoney.com/")
    print(f"[{s}] {b[:300]}")
