"""财联社签名接口探测：sign = md5(sha1(sorted_query))。"""
import hashlib
import ssl
import time
import urllib.parse
import urllib.request

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")


def fetch(url, ref="https://www.cls.cn/"):
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


def main():
    base = {"app": "CailianpressWeb", "os": "web", "sv": "8.4.6"}
    cases = [
        ("电报滚动", "https://www.cls.cn/v1/roll/get_roll_list",
         {**base, "category": "", "last_time": str(int(time.time())), "rn": "20"}),
        ("电报(旧)", "https://www.cls.cn/nodeapi/telegraphList",
         {**base, "category": "", "lastTime": "", "rn": "20"}),
        ("盘面异动", "https://www.cls.cn/v1/roll/get_roll_list",
         {**base, "category": "change", "last_time": str(int(time.time())), "rn": "20"}),
        ("首页聚合", "https://www.cls.cn/v3/depth/home/assembled/1000",
         {**base}),
        ("板块", "https://www.cls.cn/v1/plate/get_plate_list",
         {**base}),
    ]
    for name, url, p in cases:
        s, b = fetch(url + "?" + signed(p))
        print(f"[{s}] {name}")
        print("   ", b[:400])
        print()


if __name__ == "__main__":
    main()
