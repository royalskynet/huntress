#!/bin/bash
# bin/verdict-notify.sh：假判定閘與假通知，驗一天一次、過關只推一次、exit 2 告警。
set -u
T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT
N="$(cd "$(dirname "$0")/.." && pwd)/bin/verdict-notify.sh"
fail=0
check() { [ "$2" = "$3" ] && return 0; echo "FAIL: $1 (want $2 got $3)" >&2; fail=1; }
cat > "$T/notify" <<EOF
#!/bin/bash
echo "\$1" >> "$T/sent"
EOF
cat > "$T/verdict" <<EOF
#!/bin/bash
cat "$T/out"; exit \$(cat "$T/rc")
EOF
chmod +x "$T/notify" "$T/verdict"
run() { STATE_DIR="$T/s" NOTIFY_CMD="$T/notify" VERDICT_CMD="$T/verdict" VERDICT_EVERY_MIN="${1:-1440}" bash "$N" >/dev/null 2>&1; }
sent() { [ -e "$T/sent" ] && wc -l < "$T/sent" | tr -d ' ' || echo 0; }

# 1) 未過關 → 不推
echo '{"pass":[]}' > "$T/out"; echo 1 > "$T/rc"; run
check "未過關不推" 0 "$(sent)"
# 2) 一天內第二次不跑判定閘
echo '{"pass":["a@v1"]}' > "$T/out"; echo 0 > "$T/rc"; run
check "一天內不重跑" 0 "$(sent)"
# 3) 過期後過關 → 推一次；同組再跑不重推
rm -f "$T/s/verdict.stamp"; run
check "過關推一次" 1 "$(sent)"
grep -q "a@v1" "$T/sent"; check "訊息含版本" 0 $?
rm -f "$T/s/verdict.stamp"; run
check "同組不重推" 1 "$(sent)"
# 4) 多一個版本過關 → 再推
echo '{"pass":["a@v1","b@v1"]}' > "$T/out"; rm -f "$T/s/verdict.stamp"; run
check "新版本過關再推" 2 "$(sent)"
# 5) exit 2 → 告警
echo 2 > "$T/rc"; rm -f "$T/s/verdict.stamp"; run
check "exit2 告警" 3 "$(sent)"

[ "$fail" -ne 0 ] && exit 1
echo "VERDICT NOTIFY TEST PASS"
