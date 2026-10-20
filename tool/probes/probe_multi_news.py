"""探测多渠道财经资讯源（无需签名的公开接口）。

目标渠道：
  1. 东方财富（已验证可用）
  2. 新浪财经 7x24
  3. 同花顺
  4. 和讯
  5. 证券时报 / 中证网
  6. 财联社（尝试绕过签名）
"""

import json
import ssl
import urllib.request

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")


def fetch(url: str, referer: str = "") -> tuple[int, str]:
    h = {"User-Agent": UA, "Accept": "application/json, text/plain, */*"}
    if referer:
        h["Referer"] = referer
    req = urllib.request.Request(url, headers=h)
    try:
        with urllib.request.urlopen(req, timeout=20,
                                    context=ssl.create_default_context()) as r:
            return r.status, r.read().decode("utf-8", "replace")
    except Exception as exc:  # noqa: BLE001
        return -1, f"{type(exc).__name__}"


CASES = [
    # ---- 新浪 7x24 ----
    ("新浪7x24-财经", "https://zhibo.sina.com.cn/api/zhibo/feed"
     "?page=1&page_size=20&zhibo_id=152&tag_id=0&dire=f&dpc=1",
     "https://finance.sina.com.cn/"),

    # ---- 同花顺 ----
    ("同花顺-快讯", "https://news.10jqka.com.cn/tapp/news/push/stock/"
     "?page=1&tag=&track=website&pagesize=20",
     "https://news.10jqka.com.cn/"),

    # ---- 和讯 ----
    ("和讯-快讯", "https://gateway.hexun.com/news/GetListNew.aspx"
     "?type=1&page=1&num=20", "https://news.hexun.com/"),

    # ---- 证券时报 ----
    ("证券时报-快讯", "https://www.stcn.com/article/list/kx.html",
     "https://www.stcn.com/"),

    # ---- 中证网 ----
    ("中证网", "https://www.cs.com.cn/sylm/jsbd/", "https://www.cs.com.cn/"),

    # ---- 东财（对照）----
    ("东财-要闻", "https://np-listapi.eastmoney.com/comm/web/getNewsByColumns"
     "?client=web&biz=web_news_col&column=344&order=1"
     "&needInteractData=0&page_index=1&page_size=20&req_trace=1",
     "https://finance.eastmoney.com/"),
]


def main() -> None:
    for name, url, ref in CASES:
        status, body = fetch(url, ref)
        print(f"[{status}] {name}")
        if status != 200:
            print(f"      {body[:100]}")
            print()
            continue
        try:
            j = json.loads(body)
            # 尝试常见列表路径
            found = None
            for path in [("data", "list"), ("result", "data", "feed", "list"),
                         ("data",), ("result", "data"), ("list",)]:
                node = j
                ok = True
                for p in path:
                    if isinstance(node, dict) and p in node:
                        node = node[p]
                    else:
                        ok = False
                        break
                if ok and isinstance(node, list) and node:
                    found = (path, node)
                    break
            if found:
                path, lst = found
                print(f"      列表路径 {'.'.join(path)} -> {len(lst)} 条")
                first = lst[0]
                if isinstance(first, dict):
                    keys = list(first.keys())
                    print(f"      字段: {keys[:12]}")
            else:
                print(f"      keys={list(j.keys())[:6]} 片段={body[:150]}")
        except json.JSONDecodeError:
            # 可能是 HTML
            has_kx = "快讯" in body
            print(f"      HTML, 长度 {len(body)}, 含快讯={has_kx}")
        print()


if __name__ == "__main__":
    main()
