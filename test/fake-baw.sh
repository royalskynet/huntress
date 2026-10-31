#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "${FAKE_BAW_LOG:?}"
if [[ "$1" == "wallet" && "${2:-}" == "address" ]]; then
  printf '%s\n' '{"success":true,"data":{"addresses":[{"binanceChainId":"CT_501","chainName":"Solana","address":"E...S"},{"binanceChainId":"56","chainName":"BSC","address":"0x1111111111111111111111111111111111111111"}]}}'
elif [[ "$1" == "wallet" && "${2:-}" == "balance" ]]; then
  if [[ -n "${FAKE_BAL_FAIL:-}" ]]; then echo "not signed in" >&2; exit 1; fi
  printf '{"success":true,"data":[{"symbol":"BNB","binanceChainId":"56","balance":"%s"}]}\n' "${FAKE_BAL:-0.02}"
elif [[ "$1" == "contract-call" && "${2:-}" == "preview" ]]; then
  if [[ -n "${FAKE_PREVIEW_MATCH:-}" ]]; then
    if printf '%s' "$*" | grep -qF "${FAKE_PREVIEW_MATCH}"; then
      cat "${FAKE_PREVIEW:?}"
    else
      printf '%s\n' '{"success":false,"error":{"code":351805,"message":"sim fail"}}'
    fi
  else
    cat "${FAKE_PREVIEW:?}"
  fi
elif [[ "$1" == "contract-call" && "${2:-}" == "execute" ]]; then
  if [[ -n "${FAKE_EXEC_FAIL:-}" ]]; then echo "timeout" >&2; exit 1; fi
  printf '%s\n' '{"success":true,"data":{"status":"BROADCASTED","txHash":"0xdead"}}'
else
  printf '%s\n' '{}'
fi
