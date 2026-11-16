#!/bin/bash
# 取得釘版的幣安官方技能庫（meme-rush 腳本在其中）。換版本要改 SHA 並重讀 meme-rush/scripts/cli.mjs。
set -e
SHA=7d1b1f78d525f9e653b96819f91a549302fda1da
D="$(cd "$(dirname "$0")/.." && pwd)/vendor/binance-skills-hub"
[ -d "$D/.git" ] || git clone https://github.com/binance/binance-skills-hub "$D"
git -C "$D" fetch --depth 1 origin "$SHA" 2>/dev/null || true
git -C "$D" checkout -q "$SHA"
echo "pinned $SHA"
