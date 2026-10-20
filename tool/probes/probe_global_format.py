"""探明新浪全球指数三种代码格式的字段含义。

格式分类：
  gb_*   美股（道指/纳指/标普）
  b_*    其他全球指数（日经/韩综/台股/富时/DAX/CAC）
  int_*  国际指数简版（恒生/日经）
"""

import ssl
import urllib.request

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")


def fetch(codes: str) -> str:
    url = "https://hq.sinajs.cn/list=" + codes
    req = urllib.request.Request(url, headers={
        "User-Agent": UA,
        "Referer": "https://finance.sina.com.cn",
    })
    with urllib.request.urlopen(req, timeout=20,
                                context=ssl.create_default_context()) as r:
        return r.read().decode("gbk", "replace")


def show(code: str, raw: str) -> None:
    parts = raw.split(",")
    print(f"=== {code}  共 {len(parts)} 段")
    for i, v in enumerate(parts):
        if v:
            print(f"    [{i:2d}] {v}")
    print()


def main() -> None:
    body = fetch("gb_dji,b_NKY,int_hangseng")
    for line in body.strip().split("\n"):
        if "=" not in line:
            continue
        code = line.split("=")[0].replace("var hq_str_", "").strip()
        raw = line.split('"')[1] if '"' in line else ""
        if raw:
            show(code, raw)


if __name__ == "__main__":
    main()
