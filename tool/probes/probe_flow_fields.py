"""探测东财板块资金流接口的完整字段。

目标字段：
  f62  主力净流入净额
  f184 主力净流入净占比
  f66  超大单净流入净额
  f72  大单净流入净额
  f78  中单净流入净额
  f84  小单净流入净额（散户）
  f87  小单净流入净占比
  f3   涨跌幅
  f14  名称
  f12  代码
  f104/f105 上涨/下跌家数
  f128 领涨股
"""

import json
import ssl
import urllib.request

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")

FIELDS = ("f12,f14,f2,f3,f62,f184,f66,f69,f72,f75,f78,f81,f84,f87,"
          "f104,f105,f128,f140,f141,f136")


def fetch(url: str) -> tuple[int, str]:
    req = urllib.request.Request(url, headers={
        "User-Agent": UA,
        "Referer": "https://data.eastmoney.com/",
    })
    try:
        with urllib.request.urlopen(req, timeout=20,
                                    context=ssl.create_default_context()) as r:
            return r.status, r.read().decode("utf-8", "replace")
    except Exception as exc:  # noqa: BLE001
        return -1, f"{type(exc).__name__}: {exc}"


def probe(label: str, fs: str, fid: str = "f62") -> None:
    url = ("https://push2.eastmoney.com/api/qt/clist/get"
           f"?pn=1&pz=5&po=1&np=1&fltt=2&invt=2&fid={fid}&fs={fs}"
           f"&fields={FIELDS}")
    status, body = fetch(url)
    print(f"=== {label} (fid={fid}) -> HTTP {status}")
    if status != 200:
        print("   ", body[:200])
        return
    try:
        j = json.loads(body)
    except json.JSONDecodeError:
        print("    非 JSON:", body[:200])
        return

    diff = (j.get("data") or {}).get("diff") or []
    if not diff:
        print("    无数据")
        return

    row = diff[0]
    print(f"    样本: {row.get('f14')} 涨跌={row.get('f3')}%")
    for k, name in [
        ("f62", "主力净流入"), ("f184", "主力净占比"),
        ("f66", "超大单净流出"), ("f69", "超大单占比"),
        ("f72", "大单净流入"), ("f75", "大单占比"),
        ("f78", "中单净流入"), ("f81", "中单占比"),
        ("f84", "小单净流入(散户)"), ("f87", "小单占比"),
        ("f104", "上涨家数"), ("f105", "下跌家数"),
        ("f128", "领涨股"), ("f136", "领涨股涨幅"),
    ]:
        v = row.get(k)
        if v is not None:
            print(f"      {k:6s} {name:14s} = {v}")
    print()


def main() -> None:
    probe("行业板块-按主力净流入", "m:90+t:2", "f62")
    probe("行业板块-按涨跌幅", "m:90+t:2", "f3")
    probe("行业板块-按涨幅倒序", "m:90+t:2", "f3")   # po=1 是降序
    probe("概念板块-按主力净流入", "m:90+t:3", "f62")
    probe("个股-按主力净流入", "m:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23", "f62")


if __name__ == "__main__":
    main()
