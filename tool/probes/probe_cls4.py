"""找财联社「盘面异动」的正确入口。"""
import hashlib
import json
import ssl
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
j = fetch("https://www.cls.cn/v3/depth/home/assembled/1000?" + signed(base))
print("顶层:", list(j.get("data", {}).keys()))
d = j["data"]
for k in ("roll_bar", "banner", "depth_list", "top_article", "hot"):
    v = d.get(k)
    if isinstance(v, list) and v:
        print(f"  {k}: n={len(v)} keys={list(v[0].keys())[:12]}")
        print("     sample:", json.dumps(v[0], ensure_ascii=False)[:300])

# 逐个 category 试探
print()
for cat in ("", "1", "2", "3", "4", "5", "6", "7", "8"):
    try:
        jj = fetch("https://www.cls.cn/v1/roll/get_roll_list?" + signed(
            {**base, "category": cat, "rn": "3"}))
        dd = (jj.get("data") or {}).get("roll_data") or []
        cats = {x.get("category") for x in dd}
        print(f"[cat={cat!r}] n={len(dd)} cats={cats} "
              f"first={(dd[0].get('title') or dd[0].get('brief',''))[:50] if dd else ''}")
    except Exception as e:  # noqa: BLE001
        print(f"[cat={cat!r}] FAIL {e}")
