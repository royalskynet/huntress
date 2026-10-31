#!/bin/bash
# launchd com.agentid.recalc 於 11-04 09:00 叫一次：推重算報告到 @your_bot，推完自己卸載（一次性）
set -u
cd "$(dirname "$0")/.."
msg=$(python3 -I bin/recalc-cap.py 2>>logs/run.log) || { echo "recalc fail" >> logs/run.log; exit 1; }
if [ "${TG_DRY:-0}" = 1 ]; then printf '%s\n' "$msg"; exit 0; fi
node src/notify.mjs "$msg" >/dev/null 2>>logs/run.log || { echo "recalc notify fail" >> logs/run.log; exit 1; }
launchctl bootout "gui/$(id -u)/com.agentid.recalc" 2>/dev/null
rm -f "$HOME/Library/LaunchAgents/com.agentid.recalc.plist"
