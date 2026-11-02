// src/pnl.mjs
import { readFileSync } from "node:fs";
import { join } from "node:path";

function toNumWei(w) {
  try {
    if (w == null) return 0n;
    return BigInt(w);
  } catch {
    return 0n;
  }
}

export function summarize(st, sinceMs) {
  const closed = Array.isArray(st?.closed) ? st.closed : [];
  const positions = st?.positions && typeof st.positions === "object" ? st.positions : {};
  const openN = Object.keys(positions).length;
  const since = Number(sinceMs ?? 0);
  let filtered = closed.filter((c) => {
    const t = c?.closedAt ?? c?.closed_at ?? c?.time ?? c?.closed_at_ms ?? 0;
    return Number(t) >= since;
  });
  let closedN = 0;
  let wins = 0;
  let costWeiSum = 0n;
  let proceedsWeiSum = 0n;
  for (const c of filtered) {
    const costW = toNumWei(c?.origCostWei ?? c?.costWei);
    const proceedsW = toNumWei(c?.proceedsWei);
    closedN += 1;
    costWeiSum += costW;
    proceedsWeiSum += proceedsW;
    if (proceedsW > costW) {
      wins += 1;
    }
  }
  const pnlBig = proceedsWeiSum - costWeiSum;
  return {
    closedN,
    wins,
    costWei: costWeiSum.toString(),
    proceedsWei: proceedsWeiSum.toString(),
    pnlWei: pnlBig.toString(),
    openN,
  };
}

export function formatPnl(sum, title) {
  const closedN = sum?.closedN ?? 0;
  const wins = sum?.wins ?? 0;
  const costWei = sum?.costWei ?? "0";
  const proceedsWei = sum?.proceedsWei ?? "0";
  const pnlWei = sum?.pnlWei ?? "0";
  const openN = sum?.openN ?? 0;
  return `${title ?? "戰績"}\n平倉：${closedN}（勝：${wins}）\n成本：${costWei} wei\n實收：${proceedsWei} wei\n損益：${pnlWei} wei\n持倉：${openN}`;
}

function defaultStateDir() {
  return process.env.STATE_DIR || "state";
}

function main() {
  const stateDir = defaultStateDir();
  const stPath = join(stateDir, "positions.json");
  let st = { positions: {}, closed: [] };
  try {
    st = JSON.parse(readFileSync(stPath, "utf8"));
  } catch {
    st = { positions: {}, closed: [] };
  }
  const sum = summarize(st, 0);
  console.log(formatPnl(sum, "全期戰績"));
}

const isMain = process.argv[1] && (process.argv[1].endsWith("src/pnl.mjs") || import.meta.url === new URL(`file://${process.argv[1]}`).href);
if (isMain || process.argv[1]?.includes("pnl.mjs")) {
  // better check
}
if (process.argv[1] && import.meta.url === new URL(process.argv[1], "file:").href) {
  main();
} else if (process.argv[1] && process.argv[1].endsWith("/pnl.mjs")) {
  main();
}
