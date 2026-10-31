#!/bin/bash
# X 推文掃描（launchd com.agentid.watchx 每 600s）；寫入 queue，由 run.sh 下一輪 triage
set -u
cd "$(dirname "$0")"
L=${LOG_DIR:-logs}; mkdir -p "$L"
node src/watch-x.mjs --once >> "$L/run.log" 2>&1 || printf '%s watch-x fail\n' "$(TZ=Asia/Taipei date '+%F %T')" >> "$L/run.log"
# 收 Grok 每日掃描 issue（grokscan.sh 送出）；沒有 open issue 時只花一次 gh 查詢
node src/ingest-grok.mjs >> "$L/run.log" 2>&1 || printf '%s ingest-grok fail\n' "$(TZ=Asia/Taipei date '+%F %T')" >> "$L/run.log"
# Grok 加的帳號 7 天沒出新盤就移出輪流池
node src/prune-extra.mjs >> "$L/run.log" 2>&1 || printf '%s prune-extra fail\n' "$(TZ=Asia/Taipei date '+%F %T')" >> "$L/run.log"
