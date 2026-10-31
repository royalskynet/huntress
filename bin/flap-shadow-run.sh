#!/bin/bash
# Flap 影子跑：每分鐘一輪 `flap.mjs shadow`（只讀鏈＋preview，不 execute），跑 MIN 分鐘（預設 30）；
# 之後再等到每筆「本來會買」都滿 checkAfterMin 被重新報價，最後推一則 TG 彙總。零 token。
set -u
export PATH="$HOME/.foundry/bin:$PATH"  # launch.sh 的 PATH 沒有 cast
cd "$(dirname "$0")/.."
# 直接跑沒有 TG 憑證：改經 launch.sh 帶入（10-28 首跑因此沒推出去）
[ -n "${TG_BOT_TOKEN:-}" ] || [ "${TG_DRY:-0}" = 1 ] || exec /bin/bash bin/launch.sh bin/flap-shadow-run.sh
L=${LOG_DIR:-logs}; MIN=${MIN:-30}
start=$(date +%s); from=$(wc -l < "$L/run.log" | tr -d ' ')
rows0=$(cat "$L/shadow.jsonl" 2>/dev/null | wc -l | tr -d ' ')
round() { t=$(date +%s); node src/flap.mjs shadow >/dev/null 2>>"$L/run.log" || echo "flap shadow rc=$?" >> "$L/run.log"; s=$((60 - $(date +%s) + t)); [ $s -gt 0 ] && sleep $s; }
while [ $(( $(date +%s) - start )) -lt $((MIN * 60)) ]; do round; done
new=$(( $(cat "$L/shadow.jsonl" 2>/dev/null | wc -l | tr -d ' ') - rows0 ))
# 有本來會買的才補等對照（最多再 MIN 分鐘），只跑 checkShadow 不再掃新盤
if [ "$new" -gt 0 ]; then
  end=$(( $(date +%s) + MIN * 60 + 60 ))
  while [ "$(date +%s)" -lt "$end" ]; do
    done_n=$(tail -n "$new" "$L/shadow.jsonl" | jq -r .market | while read -r m; do grep -q "\"$m\"" "$L/shadow-check.jsonl" 2>/dev/null && echo x; done | wc -l | tr -d ' ')
    [ "$done_n" -ge "$new" ] && break
    round
  done
fi
rounds=$(sed -n "$((from + 1)),\$p" "$L/run.log" | grep -c ' flap screen ')
fails=$(sed -n "$((from + 1)),\$p" "$L/run.log" | grep -c 'flap shadow rc=')
# 各輪「原因 ×n」加總
reasons=$(sed -n "$((from + 1)),\$p" "$L/run.log" | grep ' flap screen ' | sed -E 's/.*盤：//' | tr '、' '\n' |
  awk -F' ×' 'NF==2{c[$1]+=$2} END{for(k in c) printf "%d %s\n", c[k], k}' | sort -rn | awk '{printf "・%s ×%s\n", $2, $1}')
checks=""
[ "$new" -gt 0 ] && checks=$(tail -n "$new" "$L/shadow.jsonl" | jq -r .market | while read -r m; do
  grep "\"$m\"" "$L/shadow-check.jsonl" 2>/dev/null | tail -1 | jq -r '"・" + (.market[0:10]) + "… ×" + .multiple'; done)
msg="🔍 Flap 影子跑 ${MIN} 分鐘結束（${rounds} 輪，失敗 ${fails} 輪）
本來會買 ${new} 筆（每筆 0.004 BNB，未送交易）"
[ -n "$checks" ] && msg="${msg}
${MIN} 分鐘後重新報價倍數：
${checks}"
msg="${msg}
篩掉原因累計（盤次）：
${reasons:-（無）}"
if [ "${TG_DRY:-0}" = 1 ]; then printf '%s\n' "$msg"; else node src/notify.mjs "$msg" >/dev/null 2>>"$L/run.log" || echo "flap shadow notify fail" >> "$L/run.log"; fi
printf '%s\n' "$msg" > "$L/flap-shadow-report.txt"
