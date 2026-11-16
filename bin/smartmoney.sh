#!/bin/bash
# 聰明錢每日監控；由 launch.sh 載入環境（BAW_BIN、TG_*、固定 BINANCE_INSTANCE_ID）。
cd "$(dirname "$0")/.." || exit 1
exec node src/smartmoney.mjs
