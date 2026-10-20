"""验证板块资金流数据源（东财公开接口）。

目标：为 App 增加「板块资金图」功能，展示各行业板块涨跌幅与主力净流入。
"""

import json
import ssl
import urllib.parse
import urllib.request

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")


def fetch(url: str, referer: str = "https://data.eastmoney.com/") -> tuple[int, str]:
    req = urllib.request.Request(url, headers={
        "User-Agent": UA,
        "Referer": referer,
        "Accept": "*/*",
    })
    try:
        with urllib.request.urlopen(req, timeout=20,
                                    context=ssl.create_default_context()) as r:
            return r.status, r.read().decode("utf-8", "replace")
    except Exception as exc:  # noqa: BLE001
        return -1, f"{type(exc).__name__}: {exc}"


CASES = [
    # 行业板块资金流（今日排行）
    ("行业板块资金流",
     "https://push2.eastmoney.com/api/qt/clist/get"
     "?pn=1&pz=50&po=1&np=1&fltt=2&invt=2"
     "&fid=f62&fs=m:90+t:2"
     "&fields=f12,f14,f2,f3,f62,f104,f105,f128,f140,f141,f136"),

    # 概念板块
    ("概念板块资金流",
     "https://push2.eastmoney.com/api/qt/clist/get"
     "?pn=1&pz=50&po=1&np=1&fltt=2&invt=2"
     "&fid=f62&fs=m:90+t:3"
     "&fields=f12,f14,f2,f3,f62,f104,f105,f128"),

    # 备用域名
    ("行业板块(备用域)",
     "https://push2delay.eastmoney.com/api/qt/clist/get"
     "?pn=1&pz=20&po=1&np=1&fltt=2&invt=2"
     "&fid=f3&fs=m:90+t:2&fields=f12,f14,f3"),
]


def main() -> None:
    for name, url in CASES:
        status, body = fetch(url)
        print(f"[{status}] {name}")
        if status != 200:
            print(f"      {body[:160]}")
            print()
            continue
        try:
            j = json.loads(body)
            diff = (j.get("data") or {}).get("diff") or []
            print(f"      返回 {len(diff)} 条")
            for row in diff[:5]:
                print(f"      {row.get('f14','?'):10s} "
                      f"涨跌={row.get('f3')}%  "
                      f"主力净流入={row.get('f62')}")
        except json.JSONDecodeError:
            print(f"      非 JSON: {body[:160]}")
        print()


if __name__ == "__main__":
    main()
