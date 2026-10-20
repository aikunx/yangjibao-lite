"""分析东财资讯页结构，找出正文容器，便于 App 内纯净阅读。"""

import re
import ssl
import urllib.request

UA = ("Mozilla/5.0 (Linux; Android 13; PLC110) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36")

URLS = [
    "http://finance.eastmoney.com/a/202610203901145179.html",
    "http://finance.eastmoney.com/news/1344,202610203901145179.html",
]

CANDIDATES = [
    'id="ContentBody"',
    'class="txtinfos"',
    'id="articleBody"',
    'class="article-body"',
    'id="mainContent"',
    'class="newsContent"',
    'id="ContentBody"',
    'class="content"',
]


def main() -> None:
    for url in URLS:
        print("=" * 60)
        print(url)
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=25,
                                        context=ssl.create_default_context()) as r:
                html = r.read().decode("utf-8", "replace")
        except Exception as exc:  # noqa: BLE001
            print("  失败:", exc)
            continue

        print(f"  长度 {len(html)}")
        for c in CANDIDATES:
            print(f"  {c:26s} -> {c in html}")

        # 打印所有 div 的 id / class 里含 content 的
        print("  --- 含 content 的容器 ---")
        for m in re.finditer(r'<(div|article)[^>]*(?:id|class)="([^"]*[Cc]ontent[^"]*)"', html):
            print(f"    <{m.group(1)} {m.group(2)[:60]}>")

        # 找最长的纯文本块（用段落在 <p> 里的特征）
        ps = re.findall(r"<p[^>]*>(.*?)</p>", html, re.S)
        print(f"  <p> 段落数 {len(ps)}")
        for i, p in enumerate(ps[:3]):
            txt = re.sub(r"<[^>]+>", "", p).strip()
            if txt:
                print(f"    [{i}] {txt[:90]}")
        print()


if __name__ == "__main__":
    main()
