#!/usr/bin/env python3
# 重算免費 mint 每日上限：依推文發出時間（snowflake）統計每天「preview 全過閘」的合約數，
# 加上每日實際 mint 筆數、gas、被上限擋的筆數，印出建議值。零 token；給 recalc-cap.sh 推 TG。
import json, re, glob, os, datetime as dt
from collections import Counter

os.chdir(os.path.join(os.path.dirname(__file__), ".."))
TZ = dt.timezone(dt.timedelta(hours=8))
DAYS = int(os.environ.get("RECALC_DAYS", "7"))
today = dt.datetime.now(TZ).date()
window = [(today - dt.timedelta(days=i)).isoformat() for i in range(DAYS, 0, -1)]  # 不含今天（未滿一天）


def records(path):
    s = open(path).read()
    d, i, out = json.JSONDecoder(), 0, []
    while i < len(s):
        while i < len(s) and s[i] in " \n\r\t":
            i += 1
        if i >= len(s):
            break
        try:
            o, i = d.raw_decode(s, i)
            out.append(o)
        except ValueError:
            nl = s.find("\n", i)
            i = len(s) if nl < 0 else nl + 1
    return out


good = set()
for r in records("logs/exec.jsonl"):
    dd = r.get("data") if r.get("success") else None
    if not (isinstance(dd, dict) and "simulationResult" in dd):
        continue
    sim = dd["simulationResult"]
    if (sim.get("simulationCode") == "000000000" and dd.get("requireConfirmation") is False
            and not sim.get("allowanceChanges") and not sim.get("authorityChanges")
            and all(float(b.get("change", -1)) >= 0 for b in sim.get("balanceChanges") or [])):
        good.add(dd["parsedTx"]["contractAddress"].lower())

first, capblock = {}, Counter()
for l in open("logs/run.log"):
    m = re.match(r"(\S+) \S+ exec queue/cand-(\d+)\.json (\{.*)", l)
    if not m:
        continue
    day, tid, js = m.groups()
    try:
        o = json.loads(js)
    except ValueError:
        continue
    t = dt.datetime.fromtimestamp(((int(tid) >> 22) + 1288834974657) / 1000, TZ).date().isoformat()
    for x in o.get("results", []):
        c = x["to"].lower()
        if any("上限" in r or "gas 預算" in r for r in x.get("reasons", [])):
            capblock[day] += 1
        first.setdefault(c, t)

avail = Counter(t for c, t in first.items() if c in good)
lines = ["📊 免費 mint 上限重算（近 %d 天，依推文發出時間）" % DAYS]
for d in window:
    led = {}
    try:
        led = json.load(open(f"state/ledger-{d}.json"))
    except (OSError, ValueError):
        pass
    gas = int(led.get("gasWei", "0") or 0) / 1e18
    lines.append(f"{d[5:]} 可mint {avail[d]:>2}｜已mint {led.get('total', 0):>2}｜gas {gas:.6f}｜被上限擋 {capblock[d]}")
vals = sorted(avail[d] for d in window)
cfg = json.load(open("config.json"))
if vals and vals[-1] > 0:
    sug = max(10, -(-vals[-1] * 3 // 2 // 5) * 5)  # 最高那天 ×1.5，取 5 的倍數，至少 10
    lines.append(f"中位數 {vals[len(vals) // 2]}、最高 {vals[-1]} → 建議 dailyMax {sug}、gasBudgetBNB {sug * 0.00005:.4f}")
else:
    lines.append("近期沒有可 mint 的合約資料，無法建議")
lines.append(f"現行 dailyMax {cfg.get('dailyMax')}、gasBudgetBNB {cfg.get('gasBudgetBNB')}；要套用跟 Claude 說「mint 上限照建議改」")
print("\n".join(lines))
