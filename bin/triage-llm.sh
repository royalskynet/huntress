#!/bin/sh
exec opencode run -m "${TRIAGE_MODEL:-opencode-go/beam-free}" "$(cat)" </dev/null
