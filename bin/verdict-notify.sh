#!/bin/bash
# 影子帳判定閘每日一次：過關（exit 0）推 TG 等使用者批准階段 3 實盤；exit 2 推錯誤。永不下單。
# 判定閘本身要求 ≥7 天、n≥30，這裡只負責「看到結果就通知」，同一組過關版本只推一次。
# 測試可覆寫 VERDICT_CMD／NOTIFY_CMD／STATE_DIR／VERDICT_EVERY_MIN。
set -u
cd "$(dirname "$0")/.."
S=${STATE_DIR:-state}; mkdir -p "$S"
stamp="$S/verdict.stamp"
[ -n "$(find "$stamp" -mmin -"${VERDICT_EVERY_MIN:-1440}" 2>/dev/null)" ] && exit 0
notify() { ${NOTIFY_CMD:-node src/notify.mjs} "$1" >/dev/null; }
out=$(${VERDICT_CMD:-node bin/shadow-verdict.mjs})
rc=$?
case $rc in
  0)
    pass=$(printf '%s' "$out" | jq -r '.pass | join(",")' 2>/dev/null)
    if [ -n "$pass" ] && [ "$pass" != "$(cat "$S/verdict.notified" 2>/dev/null)" ]; then
      notify "✅ 影子帳過關：${pass}。階段 3 實盤要你批准才開，回覆後再動" || exit 1
      printf '%s' "$pass" > "$S/verdict.notified"
    fi ;;
  1) ;;
  *) notify "⚠️ 影子帳判定閘 exit ${rc}，看 logs/run.log" || exit 1 ;;
esac
touch "$stamp"
echo "verdict rc=$rc"
