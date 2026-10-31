#!/bin/bash
# blocked-digest：只有例行擋下（同合約重複、preview revert）不推；有要人看的才推，訊息帶 gas
set -eu
cd "$(dirname "$0")/.."
t=$(mktemp -d); mkdir -p "$t/logs" "$t/state"
d=$(TZ=Asia/Taipei date +%F)
echo '{"dailyMax":100,"gasBudgetBNB":"0.0015"}' > "$t/cfg.json"
echo '{"total":22,"byContract":{},"gasWei":"231483043083872"}' > "$t/state/ledger-$d.json"
run() { LOG_DIR="$t/logs" STATE_DIR="$t/state" CONFIG="$t/cfg.json" TG_DRY=1 bash bin/blocked-digest.sh; }

cat > "$t/logs/run.log" <<'L'
2026-10-29 12:06:01 exec {"ok":false,"reasons":["此合約今日已達上限"]}
2026-10-29 12:06:02 exec {"ok":false,"reasons":["preview 失敗或被攔截：Transaction simulation failed: execution reverted"]}
L
out=$(run)
[ -z "$out" ] || { echo "例行擋下不該推：$out"; exit 1; }

cat >> "$t/logs/run.log" <<'L'
2026-10-29 12:30:00 exec {"ok":false,"reasons":["已達每日自動執行上限"]}
2026-10-29 12:30:01 exec {"ok":false,"reasons":["此合約今日已達上限"]}
2026-10-29 12:30:02 exec {"ok":false,"reasons":["preview 失敗或被攔截"]}
L
out=$(run)
grep -q '已達每日自動執行上限' <<<"$out" || { echo "上限該推：$out"; exit 1; }
grep -q "例行 2 筆" <<<"$out" || { echo "缺例行行：$out"; exit 1; }
grep -q '今日 22/100 筆，gas 0.00023/0.0015 BNB' <<<"$out" || { echo "缺 gas 行：$out"; exit 1; }
echo "digest ok"
