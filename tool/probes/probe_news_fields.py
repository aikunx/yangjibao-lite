"""确认新浪 7x24 与同花顺快讯的字段含义。"""

import json
import ssl
import urllib.request

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")


def fetch(url, referer=""):
    h = {"User-Agent": UA, "Accept": "application/json, text/plain, */*"}
    if referer:
        h["Referer"] = referer
    req = urllib.request.Request(url, headers=h)
    with urllib.request.urlopen(req, timeout=20,
                                context=ssl.create_default_context()) as r:
        return r.read().decode("utf-8", "replace")


def main() -> None:
    print("=" * 60)
    print("新浪 7x24")
    body = fetch("https://zhibo.sina.com.cn/api/zhibo/feed"
                 "?page=1&page_size=3&zhibo_id=152&tag_id=0&dire=f&dpc=1",
                 "https://finance.sina.com.cn/")
    lst = json.loads(body)["result"]["data"]["feed"]["list"]
    for it in lst[:2]:
        print("--- 单条 ---")
        for k in ["id", "rich_text", "create_time", "tag", "docurl", "ext"]:
            v = it.get(k)
            if v is not None:
                s = str(v)
                print(f"  {k:14s} {s[:120]}")
        print()

    print("=" * 60)
    print("同花顺快讯")
    body = fetch("https://news.10jqka.com.cn/tapp/news/push/stock/"
                 "?page=1&tag=&track=website&pagesize=3",
                 "https://news.10jqka.com.cn/")
    lst = json.loads(body)["data"]["list"]
    for it in lst[:2]:
        print("--- 单条 ---")
        for k, v in it.items():
            s = str(v)
            print(f"  {k:12s} {s[:110]}")
        print()


if __name__ == "__main__":
    main()
