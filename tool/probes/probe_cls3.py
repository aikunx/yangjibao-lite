"""财联社字段确认：电报 + 盘面异动。"""
import hashlib
import json
import ssl
import time
import urllib.parse
import urllib.request

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")


def fetch(url):
    req = urllib.request.Request(url, headers={
        "User-Agent": UA, "Referer": "https://www.cls.cn/",
        "Accept": "application/json, text/plain, */*"})
    with urllib.request.urlopen(req, timeout=15,
                                context=ssl.create_default_context()) as r:
        return json.loads(r.read().decode("utf-8", "replace"))


def signed(params):
    q = urllib.parse.urlencode(sorted(params.items()))
    sign = hashlib.md5(hashlib.sha1(q.encode()).hexdigest().encode()).hexdigest()
    return q + "&sign=" + sign


base = {"app": "CailianpressWeb", "os": "web", "sv": "8.4.6"}

j = fetch("https://www.cls.cn/v1/roll/get_roll_list?" + signed(
    {**base, "category": "", "last_time": str(int(time.time())), "rn": "5"}))
items = j["data"]["roll_data"]
print("字段:", sorted(items[0].keys()))
for it in items[:3]:
    print("-" * 50)
    for k in ("id", "title", "brief", "content", "ctime", "shareurl",
              "level", "reading_num", "subjects", "stock_list", "images"):
        v = it.get(k)
        print(f"  {k:12s} = {str(v)[:160]}")

print()
print("=== 异动分类 ===")
for cat in ("change", "important", "hq", "gn", "ssgs"):
    try:
        jj = fetch("https://www.cls.cn/v1/roll/get_roll_list?" + signed(
            {**base, "category": cat, "last_time": str(int(time.time())), "rn": "3"}))
        d = (jj.get("data") or {}).get("roll_data") or []
        print(f"[{cat}] errno={jj.get('errno')} n={len(d)} first={d[0]['content'][:60] if d else ''}")
    except Exception as e:  # noqa: BLE001
        print(f"[{cat}] FAIL {e}")
