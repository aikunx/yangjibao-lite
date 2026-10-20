"""验证从东财资讯页提取纯正文（简洁版）。

思路：直接摘取 id="ContentBody" 起始位置到文章尾标记之间的文本，
再逐 <p> 清洗，避免复杂正则。
"""

import re
import ssl
import urllib.request

UA = ("Mozilla/5.0 (Linux; Android 13; PLC110) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36")

URL = "http://finance.eastmoney.com/a/202610203901145179.html"

NOISE = [
    "方便，快捷", "手机查看财经快讯", "专业，丰富", "一手掌握市场脉搏",
    "扫描二维码", "下载", "登录", "注册", "评论", "分享", "收藏",
    "免责声明", "风险提示", "责任编辑", "举报", "广告", "更多",
    "东方财富发布此内容", "本文不构成", "仅供参考", "点击", "查看",
]

# 正文结束标志（出现其一即截断）
ENDS = ['class="foot', 'class="share', 'class="relate', 'id="related',
        'class="article-source', 'class="em_media', '<!-- 正文结束']


def extract(html: str) -> tuple[str, list[str]]:
    m = re.search(r"<title>(.*?)</title>", html, re.S)
    title = ""
    if m:
        title = re.sub(r"<[^>]+>", "", m.group(1)).strip()
        for sep in ("_", "-", "|"):
            title = title.split(sep)[0].strip()

    # 定位正文起点
    idx = html.find('id="ContentBody"')
    if idx < 0:
        return title, []
    start = html.find(">", idx) + 1

    # 定位正文终点
    end = len(html)
    for mark in ENDS:
        p = html.find(mark, start)
        if p > start:
            end = min(end, p)
    body = html[start:min(end, start + 60000)]

    paras = []
    for p in re.findall(r"<p[^>]*>(.*?)</p>", body, re.S):
        txt = re.sub(r"<[^>]+>", "", p)
        txt = (txt.replace("&nbsp;", " ")
                  .replace("&amp;", "&")
                  .replace("&quot;", '"')
                  .replace("&lt;", "<")
                  .replace("&gt;", ">"))
        txt = re.sub(r"\s+", " ", txt).strip()
        if len(txt) < 8:
            continue
        if any(n in txt for n in NOISE):
            continue
        paras.append(txt)
    return title, paras


def main() -> None:
    req = urllib.request.Request(URL, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=25,
                                context=ssl.create_default_context()) as r:
        html = r.read().decode("utf-8", "replace")

    title, paras = extract(html)
    print(f"标题: {title}")
    print(f"段落: {len(paras)}  总字数: {sum(len(p) for p in paras)}")
    print("-" * 60)
    for i, p in enumerate(paras[:10]):
        print(f"[{i}] {p[:120]}")


if __name__ == "__main__":
    main()
