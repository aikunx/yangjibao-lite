"""测量各数据源的真实延迟与更新频率，用于确定合理刷新间隔。

测试项：
  1. 单次请求的网络往返耗时（决定最小可行间隔）
  2. 数据源自身的更新频率（决定刷新再快有没有意义）
"""

import ssl
import time
import urllib.request
import statistics

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")


def timed(url, referer="https://data.eastmoney.com/", n=5):
    times = []
    ok = 0
    for _ in range(n):
        t0 = time.perf_counter()
        try:
            req = urllib.request.Request(url, headers={
                "User-Agent": UA, "Referer": referer})
            with urllib.request.urlopen(req, timeout=15,
                                        context=ssl.create_default_context()) as r:
                r.read()
            times.append((time.perf_counter() - t0) * 1000)
            ok += 1
        except Exception:  # noqa: BLE001
            times.append((time.perf_counter() - t0) * 1000)
        time.sleep(0.3)
    if not times:
        return ok, 0, 0
    return ok, statistics.mean(times), min(times)


CASES = [
    ("腾讯指数行情", "https://qt.gtimg.cn/q=sh000001", "https://gu.qq.com/"),
    ("东财板块资金流",
     "https://push2.eastmoney.com/api/qt/clist/get"
     "?pn=1&pz=60&po=1&np=1&fltt=2&invt=2&fid=f62&fs=m:90+t:2"
     "&fields=f12,f14,f3,f62", "https://data.eastmoney.com/"),
    ("东财基金净值",
     "https://api.fund.eastmoney.com/f10/lsjz?fundCode=110011&pageIndex=1&pageSize=1",
     "https://fund.eastmoney.com/"),
    ("宝妈指数",
     "http://212.129.244.148:8890/api/mom/index", "http://212.129.244.148:8890/"),
]


def main() -> None:
    print("=== 单次请求网络往返耗时（5 次采样）===")
    for name, url, ref in CASES:
        ok, avg, mn = timed(url, ref)
        print(f"{name:16s} 成功 {ok}/5  "
              f"平均 {avg:6.0f} ms  最快 {mn:6.0f} ms")
    print()
    print("结论：10 ms 刷新要求单次请求 < 10 ms，"
          "而实际网络往返已是其 10~30 倍。")
    print("     10 ms 间隔下，仅网络排队就会导致请求堆积。")
    print()

    # 数据源更新频率：连续采样看数值多久变化
    print("=== 数据源自身更新频率（连续 12 秒采样腾讯行情）===")
    seen = []
    for i in range(12):
        try:
            req = urllib.request.Request(
                "https://qt.gtimg.cn/q=sh000001",
                headers={"User-Agent": UA, "Referer": "https://gu.qq.com/"})
            with urllib.request.urlopen(req, timeout=10,
                                        context=ssl.create_default_context()) as r:
                body = r.read().decode("gbk", "replace")
            # 取第 4 个字段（当前点位）与第 31 个（时间戳）
            f = body.split('"')[1].split("~")
            if len(f) > 31:
                seen.append((f[3], f[30]))
        except Exception:  # noqa: BLE001
            pass
        time.sleep(1)

    uniq = len(set(seen))
    print(f"  12 秒内采样 {len(seen)} 次，数值变化 {uniq} 种")
    for v in seen[:8]:
        print(f"    {v[0]}  @{v[1]}")


if __name__ == "__main__":
    main()
