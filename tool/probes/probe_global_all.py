"""探测可用的全球指数代码（新浪 + 腾讯）。

重点：
  1. 美股三大 + 纳斯达克100 + 罗素2000
  2. 费城半导体 SOX（半导体行业指数）
  3. 欧洲：富时100 / DAX / CAC40 / 欧洲斯托克50
  4. 亚太：日经225 / 韩国KOSPI / 台湾加权 / 澳洲 / 印度 / 新加坡
  5. 港股：恒生 / 恒生科技 / 国企指数
"""

import ssl
import urllib.request

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")

SINA_CODES = [
    # 美股
    "gb_dji", "gb_ixic", "gb_inx", "gb_ndx", "gb_rut",
    # 半导体
    "gb_sox", "gb_smh",
    # 欧洲
    "b_FTSE", "b_DAX", "b_CAC", "b_SX5E", "b_IBEX", "b_FTSEMIB", "b_AEX",
    # 亚太
    "b_NKY", "b_TOPIX", "b_KOSPI", "b_TWSE", "b_AS51", "b_SENSEX",
    "b_STI", "b_HSI", "b_SET",
    # 其他
    "int_hangseng", "int_nikkei", "int_dji", "int_sp500", "int_nasdaq",
]

TENCENT_CODES = [
    "hkHSI", "hkHSCEI", "hkHSTECH",
    "usDJI", "usIXIC", "usINX", "usNDX",
]


def fetch_sina(codes):
    url = "https://hq.sinajs.cn/list=" + ",".join(codes)
    req = urllib.request.Request(url, headers={
        "User-Agent": UA, "Referer": "https://finance.sina.com.cn"})
    with urllib.request.urlopen(req, timeout=20,
                                context=ssl.create_default_context()) as r:
        return r.read().decode("gbk", "replace")


def fetch_tencent(codes):
    url = "https://qt.gtimg.cn/q=" + ",".join(codes)
    req = urllib.request.Request(url, headers={
        "User-Agent": UA, "Referer": "https://gu.qq.com/"})
    with urllib.request.urlopen(req, timeout=20,
                                context=ssl.create_default_context()) as r:
        return r.read().decode("gbk", "replace")


def main() -> None:
    print("=== 新浪 ===")
    try:
        body = fetch_sina(SINA_CODES)
        ok, bad = [], []
        for line in body.strip().split("\n"):
            if "=" not in line or '"' not in line:
                continue
            code = line.split("=")[0].replace("var hq_str_", "").strip()
            val = line.split('"')[1]
            if val and len(val.split(",")) >= 4:
                name = val.split(",")[0]
                print(f"  OK   {code:14s} {name}")
                ok.append(code)
            else:
                print(f"  空   {code:14s}")
                bad.append(code)
        print(f"  可用 {len(ok)} / {len(SINA_CODES)}")
    except Exception as exc:  # noqa: BLE001
        print("  失败:", exc)

    print()
    print("=== 腾讯 ===")
    try:
        body = fetch_tencent(TENCENT_CODES)
        for line in body.strip().split("\n"):
            if "=" not in line or '"' not in line:
                continue
            code = line.split("=")[0].replace("v_", "").strip()
            val = line.split('"')[1]
            f = val.split("~")
            if len(f) > 3 and f[3]:
                print(f"  OK   {code:14s} {f[1]}")
            else:
                print(f"  空   {code:14s}")
    except Exception as exc:  # noqa: BLE001
        print("  失败:", exc)


if __name__ == "__main__":
    main()
