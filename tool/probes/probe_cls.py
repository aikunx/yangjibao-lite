"""探测财联社（cls.cn）公开接口。

目标：
  1. 电报快讯（滚动新闻）
  2. 盘面异动（板块/个股异动）
  3. 板块资讯

财联社接口通常需要 sign 参数，先试探可用性。
"""

import json
import ssl
import urllib.request

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")


def fetch(url: str, referer="https://www.cls.cn/") -> tuple[int, str]:
    req = urllib.request.Request(url, headers={
        "User-Agent": UA,
        "Referer": referer,
        "Accept": "application/json, text/plain, */*",
    })
    try:
        with urllib.request.urlopen(req, timeout=20,
                                    context=ssl.create_default_context()) as r:
            return r.status, r.read().decode("utf-8", "replace")
    except Exception as exc:  # noqa: BLE001
        return -1, f"{type(exc).__name__}: {exc}"


CASES = [
    ("电报列表",
     "https://www.cls.cn/nodeapi/updateTelegraphList?app=CailianpressWeb"
     "&category=&lastTime=&last_time=&os=web&rn=20&sv=7.7.5"),
    ("电报(带签名接口)",
     "https://www.cls.cn/nodeapi/telegraphList?app=CailianpressWeb"
     "&category=&lastTime=&os=web&rn=20&sv=7.7.5"),
    ("盘面异动",
     "https://www.cls.cn/nodeapi/changePlate?app=CailianpressWeb"
     "&os=web&sv=7.7.5"),
    ("板块异动",
     "https://www.cls.cn/nodeapi/plateList?app=CailianpressWeb&os=web&sv=7.7.5"),
    ("首页",
     "https://www.cls.cn/"),
]


def main() -> None:
    for name, url in CASES:
        status, body = fetch(url)
        print(f"[{status}] {name}")
        if status != 200:
            print(f"      {body[:180]}")
        else:
            try:
                j = json.loads(body)
                print(f"      JSON keys={list(j.keys())[:8]}")
                data = j.get("data")
                if isinstance(data, dict):
                    print(f"      data keys={list(data.keys())[:8]}")
                elif isinstance(data, list):
                    print(f"      data 列表 {len(data)} 条")
                    if data and isinstance(data[0], dict):
                        print(f"      首条字段={list(data[0].keys())[:12]}")
                        print(f"      {str(data[0])[:260]}")
            except json.JSONDecodeError:
                print(f"      非 JSON: {body[:200]}")
        print()


if __name__ == "__main__":
    main()
