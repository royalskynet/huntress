#!/bin/bash
# watch-x 輪替：priority 每輪都查；pool 每輪 3 個，4 輪涵蓋全部 10 個
set -eu
cd "$(dirname "$0")/.."
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
printf '#!/bin/bash\necho "$*" >> %s/calls\necho "{\\"data\\":[]}"\n' "$T" > "$T/tw"; chmod +x "$T/tw"
export CONFIG=$PWD/config.example.json STATE_DIR=$T/s QUEUE_DIR=$T/q TWITTER_BIN=$T/tw
for i in 1 2 3 4; do node src/watch-x.mjs --once >/dev/null; done
for u in $(jq -r '.x.priority[]' config.example.json); do [ "$(grep -c "user-posts $u " "$T/calls")" -eq 4 ]; done
for u in $(jq -r '.x.accounts[]' config.example.json); do grep -q "user-posts $u " "$T/calls"; done
[ "$(grep -c user-posts "$T/calls")" -eq $((4 * (5 + 3))) ]
echo x-rotate ok
