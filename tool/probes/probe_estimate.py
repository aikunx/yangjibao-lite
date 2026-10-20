"""验证「基金盘中加权预估」算法（修正版）。

原理（参照 daily-forecast 页）：
  基金当日预估涨跌% = Σ(重仓股实时涨跌% × 占净值权重%) / Σ(权重%)
  即对前十大重仓做归一化加权，作为基金净值盘中预估。
"""

import re
import ssl
import urllib.request

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")


def get(url, gbk=False, ref="https://fund.eastmoney.com/"):
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Referer": ref})
    with urllib.request.urlopen(req, timeout=20,
                                context=ssl.create_default_context()) as r:
        raw = r.read()
    return raw.decode("gbk", "replace") if gbk else raw.decode("utf-8", "replace")


def market(c):
    """6 位 A 股 / 5 位港股 -> 腾讯行情代码前缀。"""
    if re.fullmatch(r"\d{6}", c):
        return ("sh" if c[0] in "69" else ("bj" if c[0] in "48" else "sz")) + c
    if re.fullmatch(r"\d{5}", c):
        return "hk" + c
    return None


def stock_quotes(codes):
    """腾讯简版行情：v_s_sh600519="1~贵州茅台~600519~价格~涨跌~涨跌幅~..."。"""
    pairs = [(c, market(c)) for c in codes]
    pairs = [(c, m) for c, m in pairs if m]
    if not pairs:
        return {}
    arg = ",".join("s_" + m for _, m in pairs)
    body = get("https://qt.gtimg.cn/q=" + arg, gbk=True, ref="https://gu.qq.com/")
    got = {}
    for line in body.strip().split("\n"):
        m = re.match(r'v_s_(\w+)="([^"]*)"', line)
        if not m:
            continue
        f = m.group(2).split("~")
        if len(f) > 5:
            got[m.group(1)] = float(f[5])
    return {c: got[m] for c, m in pairs if m in got}


def fund_holdings(code):
    """天天基金前十大重仓（最新报告期）。返回 ([{code,name,weightPct}], 报告期)"""
    url = ("https://fundf10.eastmoney.com/FundArchivesDatas.aspx"
           f"?type=jjcc&code={code}&topline=10&year=&month=")
    html = get(url)
    dates = re.findall(r"截止至：<font class='px12'>(\d{4}-\d{2}-\d{2})", html)
    rows = []
    for rm in re.finditer(r"<tr>([\s\S]*?)</tr>", html):
        cells = [re.sub(r"<[^>]+>", "", c).strip()
                 for c in re.findall(r"<td[^>]*>([\s\S]*?)</td>", rm.group(1))]
        cells = [c for c in cells if c]
        if len(cells) < 4:
            continue
        ci = next((i for i, c in enumerate(cells) if re.fullmatch(r"\d{5,6}", c)), -1)
        if ci < 0 or ci + 1 >= len(cells):
            continue
        pct = 0.0
        for c in reversed(cells):
            m = re.fullmatch(r"(\d+(?:\.\d+)?)%", c)
            if m:
                pct = float(m.group(1))
                break
        rows.append({"code": cells[ci], "name": cells[ci + 1], "weightPct": pct})
    seen, uniq = set(), []
    for r in rows:
        if r["code"] in seen:
            continue
        seen.add(r["code"])
        uniq.append(r)
    return uniq[:10], (dates[0] if dates else "")


def estimate(code):
    holds, report = fund_holdings(code)
    if not holds:
        return None, [], report
    quotes = stock_quotes([h["code"] for h in holds])
    total_w = sum(h["weightPct"] for h in holds) or 1.0
    weighted, missing = [], []
    for h in holds:
        q = quotes.get(h["code"])
        if q is None:
            missing.append(h["name"])
            continue
        weighted.append({**h, "pct": q, "contrib": q * h["weightPct"] / total_w})
    est = sum(w["contrib"] for w in weighted)
    covered = sum(h["weightPct"] for h in weighted) / total_w
    return {"est": est, "covered": covered, "missing": missing}, weighted, report


def main():
    for code, name in [("021179", "易方达产业机遇混合A"),
                       ("015789", "永赢高端装备"),
                       ("025491", "平安卫星产业C"),
                       ("004253", "国泰黄金ETF C")]:
        print("=" * 60)
        print(f"{code} {name}")
        res, w, report = estimate(code)
        if res is None:
            print("  无法获取持仓")
            continue
        print(f"  报告期 {report}  覆盖权重 {res['covered']*100:.1f}%"
              f"  缺行情 {res['missing'] or '-'}")
        print(f"  盘中预估: {res['est']:+.2f}%  (前十大归一化加权)")
        for x in w:
            print(f"    {x['name']:10s} {x['code']} w={x['weightPct']:>5.2f}%  "
                  f"实时={x['pct']:+6.2f}%  贡献={x['contrib']:+.3f}pct")
        print()


if __name__ == "__main__":
    main()
