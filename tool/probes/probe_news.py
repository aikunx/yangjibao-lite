"""寻找无需签名即可用的「财经快讯」与「板块异动」数据源。

候选：
  1. 东方财富 快讯（np-listapi / newsapi）
  2. 东方财富 板块异动（push2 板块涨幅榜已有，异动需另寻）
  3. 新浪 7x24 快讯
  4. 腾讯 财经快讯
"""

import json
import ssl
import urllib.request

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")


def fetch(url: str, referer="https://finance.eastmoney.com/"):
    req = urllib.request.Request(url, headers={
        "User-Agent": UA, "Referer": referer,
        "Accept": "application/json, text/plain, */*",
    })
    try:
        with urllib.request.urlopen(req, timeout=20,
                                    context=ssl.create_default_context()) as r:
            return r.status, r.read().decode("utf-8", "replace")
    except Exception as exc:  # noqa: BLE001
        return -1, f"{type(exc).__name__}"


CASES = [
    ("东财 快讯 np-listapi",
     "https://np-listapi.eastmoney.com/comm/web/getNewsByColumns"
     "?client=web&biz=web_news_col&column=344&order=1&needInteractData=0"
     "&page_index=1&page_size=20&req_trace=1"),
    ("东财 快讯(备用)",
     "https://np-listapi.eastmoney.com/comm/web/getFastNewsList"
     "?client=web&biz=web_news_col&column=344&order=1&page_index=1&page_size=20"),
    ("东财 全球财经快讯",
     "https://np-listapi.eastmoney.com/comm/web/getNewsByColumns"
     "?client=web&biz=web_news_col&column=102&order=1&page_index=1&page_size=20"),
    ("新浪 7x24",
     "https://zhibo.sina.com.cn/api/zhibo/feed?page=1&page_size=20"
     "&zhibo_id=152&tag_id=0&dire=f&dpc=1"),
    ("东财 板块异动",
     "https://push2.eastmoney.com/api/qt/clist/get"
     "?pn=1&pz=20&po=1&np=1&fltt=2&invt=2&fid=f3&fs=m:90+t:2"
     "&fields=f12,f14,f3"),
]


def main() -> None:
    for name, url in CASES:
        status, body = fetch(url)
        print(f"[{status}] {name}")
        if status != 200:
            print(f"      {body[:120]}")
            print()
            continue
        try:
            j = json.loads(body)
            print(f"      keys={list(j.keys())[:8]}")
            # 尝试找列表
            for path in [("data", "list"), ("data", "roll_data"),
                         ("result", "data"), ("result", "list")]:
                node = j
                ok = True
                for p in path:
                    if isinstance(node, dict) and p in node:
                        node = node[p]
                    else:
                        ok = False
                        break
                if ok and isinstance(node, list) and node:
                    print(f"      {'.'.join(path)} -> {len(node)} 条")
                    print(f"      首条: {str(node[0])[:300]}")
                    break
            else:
                print(f"      片段: {body[:260]}")
        except json.JSONDecodeError:
            print(f"      非 JSON: {body[:200]}")
        print()


if __name__ == "__main__":
    main()
