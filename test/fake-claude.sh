#!/usr/bin/env bash
printf '%s\n' "$@" > "${FAKE_CLAUDE_ARGS:?}"
cat > "${FAKE_CLAUDE_IN:?}"
printf '%s\n' '答覆OK'
