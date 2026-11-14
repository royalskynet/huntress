#!/bin/bash
# lane <名稱> <指令…>：跑指令，追蹤連續失敗；連敗 6 輪且距上次告警滿 24h 就推 TG。
# 被 run.sh source；狀態存 ${LANE_STATE:-$S/lane-fail.json}，時間可用 LANE_NOW 覆寫。
# 讀改寫以 mkdir "$state.lock" 互斥（bash 3.2 無 flock）；狀態壞或存檔失敗一律保留原檔。
lane() {
  local name="$1" state now prev next n last tmp rc lk i
  shift
  state="${LANE_STATE:-$S/lane-fail.json}"
  now="${LANE_NOW:-$(date +%s)}"
  "$@"
  rc=$?

  lk="$state.lock"
  i=0
  while ! mkdir "$lk" 2>/dev/null; do
    # 程序中途被殺會留下鎖；超過 10 分鐘視為遺留，回收後重取
    if [ -n "$(find "$lk" -maxdepth 0 -mmin +10 2>/dev/null)" ]; then
      rmdir "$lk" 2>/dev/null && continue
    fi
    i=$((i + 1))
    if [ "$i" -ge 50 ]; then
      echo "lane state 壞: ${state}（拿不到鎖）" >&2
      return "$rc"
    fi
    sleep 0.1
  done

  prev='{}'
  if [ -e "$state" ]; then
    prev=$(cat "$state" 2>/dev/null)
    if ! printf '%s' "$prev" | jq -e . >/dev/null 2>&1; then
      echo "lane state 壞: ${state}（JSON 解析失敗）" >&2
      rmdir "$lk" 2>/dev/null
      return "$rc"
    fi
  fi

  n=$(printf '%s' "$prev" | jq -r --arg k "$name" '.[$k].n // 0' 2>/dev/null)
  case "$n" in
    ''|*[!0-9]*)
      echo "lane state 壞: ${state}（計數讀取失敗）" >&2
      rmdir "$lk" 2>/dev/null
      return "$rc" ;;
  esac

  if [ "$rc" -ne 0 ]; then
    n=$((n + 1))
    last=$(printf '%s' "$prev" | jq -r --arg k "$name" '.[$k].lastAlertAt // 0' 2>/dev/null)
    case "$last" in ''|*[!0-9]*) last=0 ;; esac
    if [ "$n" -ge 6 ] && [ $((n % 6)) -eq 0 ] && [ $((now - last)) -ge 86400 ]; then
      # 只有 tg 回 0 才寫 lastAlertAt；送達失敗時 n 照記，下個合格輪仍可再試
      if tg "⚠️ ${name} 連續失敗 ${n} 輪"; then
        next=$(printf '%s' "$prev" | jq --arg k "$name" --argjson n "$n" --argjson t "$now" '.[$k] = ((.[$k] // {}) + {n: $n, lastAlertAt: $t})' 2>/dev/null)
      else
        next=$(printf '%s' "$prev" | jq --arg k "$name" --argjson n "$n" '.[$k] = ((.[$k] // {}) + {n: $n})' 2>/dev/null)
      fi
    else
      next=$(printf '%s' "$prev" | jq --arg k "$name" --argjson n "$n" '.[$k] = ((.[$k] // {}) + {n: $n})' 2>/dev/null)
    fi
  else
    next=$(printf '%s' "$prev" | jq --arg k "$name" '.[$k] = ((.[$k] // {}) + {n: 0})' 2>/dev/null)
  fi

  if [ -z "$next" ]; then
    echo "lane state 壞: ${state}（jq 更新失敗）" >&2
    rmdir "$lk" 2>/dev/null
    return "$rc"
  fi

  tmp="$state.tmp.$$"
  if ! printf '%s\n' "$next" > "$tmp" 2>/dev/null; then
    echo "lane state 壞: ${state}（寫暫存失敗）" >&2
    rm -f "$tmp"
    rmdir "$lk" 2>/dev/null
    return "$rc"
  fi
  if ! mv "$tmp" "$state" 2>/dev/null; then
    echo "lane state 壞: ${state}（替換失敗）" >&2
    rm -f "$tmp"
    rmdir "$lk" 2>/dev/null
    return "$rc"
  fi
  rmdir "$lk" 2>/dev/null
  return "$rc"
}
