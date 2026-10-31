#!/bin/bash
# ingest-grok：合法帳號／推文進 x-extra 與 queue；非法 handle、非 x.com 網址、已看過的推文都不進；issue 被關
set -eu
cd "$(dirname "$0")/.."
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
mkdir -p "$T/s"; echo '["111111"]' > "$T/s/seen-x.json"
inner='{"accounts":[{"handle":"@good_one","why":"x"},{"handle":"bad;rm -rf","why":"x"},"plain2"],"launches":[{"tweet":"https://x.com/abc/status/222222","name":"P","contract":"0x1"},{"tweet":"https://evil.com/abc/status/333333"},{"tweet":"https://x.com/abc/status/111111"}]}'
jq -n --arg b "$(printf '好的\n```json\n%s\n```' "$inner")" '[{number:7,title:"agentid-grokscan 2026-10-29",body:$b},{number:8,title:"other",body:"x"}]' > "$T/issues.json"
printf '#!/bin/bash\necho "$*" >> %s/calls\n[ "$1 $2" = "issue list" ] && cat %s/issues.json\nexit 0\n' "$T" "$T" > "$T/gh"
chmod +x "$T/gh"
GH_BIN=$T/gh STATE_DIR=$T/s QUEUE_DIR=$T/q node src/ingest-grok.mjs
[ "$(jq -c . "$T/s/x-extra.json")" = '["good_one","plain2"]' ]
[ -f "$T/q/x-222222.json" ] && [ "$(jq -r .tweet.url "$T/q/x-222222.json")" = https://x.com/abc/status/222222 ]
[ "$(ls "$T/q" | wc -l | tr -d ' ')" = 1 ]
grep -q 'issue close 7' "$T/calls"
if grep -q 'issue close 8' "$T/calls"; then exit 1; fi
# 再跑一次：issue 已關（fake 仍回同一筆）→ 帳號不重複、推文已看過不重寫
rm "$T/q/x-222222.json"; GH_BIN=$T/gh STATE_DIR=$T/s QUEUE_DIR=$T/q node src/ingest-grok.mjs >/dev/null
[ "$(jq length "$T/s/x-extra.json")" = 2 ] && [ -z "$(ls "$T/q")" ]
echo ingest-grok ok
