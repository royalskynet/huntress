#!/bin/bash
# launchd com.agentid.flapwatch 每 1800s 經 launch.sh 叫；零 token
export PATH="$HOME/.foundry/bin:$PATH"  # launch.sh 的 PATH 沒有 cast
cd "$(dirname "$0")/.." && exec node src/flap-watch.mjs
