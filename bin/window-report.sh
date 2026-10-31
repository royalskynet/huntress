#!/bin/bash
# 統計 run.log 從第 N 行起的區間：X 429／X 輪次、mint 執行結果、autotrade 買賣、餘額、launchd 狀態（零 token）
set -u
cd "$(dirname "$0")/.."
from=${1:?用法: window-report.sh <起始行號>}
w=$(tail -n +"$from" logs/run.log)
c() { grep -cE "$1" <<<"$w" || true; }
echo "區間 log 行數: $(wc -l <<<"$w" | tr -d ' ')"
echo "X 429 次數: $(c 'Rate limited \(429\)')  429 三次重試仍失敗: $(c 'attempt 3/3')"
echo "X 輪次（watch-x 輸出）: $(c '^\{"ok":(true|false),"new":[0-9]+,"ids"')  新推文合計: $(grep -oE '"new":[0-9]+,"ids"' <<<"$w" | grep -oE '[0-9]+' | paste -sd+ - | bc 2>/dev/null || echo 0)"
echo "watch-x fail: $(c 'watch-x fail')  autotrade fail: $(c 'autotrade fail')  triage fail: $(c 'triage fail')"
echo "mint exec ok: $(c ' exec .*"ok":true')  exec 擋下: $(c ' exec .*"ok":false')"
grep -oE '"txHash":"0x[0-9a-f]{64}"' <<<"$w" | sort -u | sed 's/^/  /'
echo "autotrade 相關行:"; grep -E 'autotrade|"bought"|"sold"|buy |sell ' <<<"$w" | cut -c1-200 | tail -10 | sed 's/^/  /'
echo "positions: $(jq -c '{open:(.positions|keys), closed:(.closed|length), rejected:(.rejected|length)}' state/positions.json)"
echo "ledger: $(jq -c . state/ledger-$(TZ=Asia/Taipei date +%F).json 2>/dev/null | cut -c1-300)"
echo "BNB: $(node_modules/.bin/baw wallet balance --json 2>/dev/null | jq -r '[.data[]? | select(.binanceChainId=="56" and .symbol=="BNB") | .balance][0]')"
for j in newlaunch watchx bot; do echo "launchd $j: $(launchctl print gui/$(id -u)/com.agentid.$j 2>/dev/null | grep -E 'runs =|last exit code' | tr -s '\t ' ' ' | paste -sd' ' -)"; done
echo "Grok ingest: $(grep -E '^\{"ok":true,"issues":[1-9]' <<<"$w" | tail -1)  ingest fail: $(c 'ingest-grok fail')  x-extra: $(jq -c . state/x-extra.json 2>/dev/null)"
echo "Grok issues: $(gh issue list -R royalskynet/grokbots-ops --state all --search 'grokscan in:title' --json number,title,state --jq '[.[]|"#\(.number) \(.title) \(.state)"]|join(" ; ")' 2>&1 | head -1)"
ls state | grep -E 'PAUSED|BAL_UNKNOWN' | sed 's/^/旗標: /'
