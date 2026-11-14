// src/pnl.mjs
import { readFileSync } from "node:fs";
import { join } from "node:path";

function toNumWei(w, field) {
  if (w == null) return 0n;
  try {
    return BigInt(w);
  } catch {
    throw new Error(`金額解析失敗 ${field ?? "金額"}：${w}`);
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
    const costW = toNumWei(c?.origCostWei ?? c?.costWei, "costWei");
    const proceedsW = toNumWei(c?.proceedsWei, "proceedsWei");
    closedN += 1;
    costWeiSum += costW;
    proceedsWeiSum += proceedsW;
    if (proceedsW > costW) {
      wins += 1;
    }
  }
  const pnlBig = proceedsWeiSum - costWeiSum;

  // 免費與付費分開算；付費只有 chain 實收且成本、實收都在的才算可信
  let freeN = 0;
  let paidN = 0;
  let trusted = 0;
  let incomplete = 0;
  let paidWins = 0;
  let paidCost = 0n;
  let paidProceeds = 0n;
  const byExitReason = {};
  for (const c of filtered) {
    if (c?.kind === "free") {
      freeN += 1;
      continue;
    }
    paidN += 1;
    const costRaw = c?.origCostWei ?? c?.costWei;
    const proceedsRaw = c?.proceedsWei;
    if (c?.proceedsSource !== "chain" || proceedsRaw == null || costRaw == null) {
      incomplete += 1;
      continue;
    }
    const costW = toNumWei(costRaw, "costWei");
    const proceedsW = toNumWei(proceedsRaw, "proceedsWei");
    trusted += 1;
    paidCost += costW;
    paidProceeds += proceedsW;
    if (proceedsW > costW) paidWins += 1;
    const reason = c?.exitReason ?? "unknown";
    const bucket = byExitReason[reason] ?? (byExitReason[reason] = { n: 0, pnlWei: "0" });
    bucket.n += 1;
    bucket.pnlWei = (BigInt(bucket.pnlWei) + (proceedsW - costW)).toString();
  }
  const paidPnl = paidProceeds - paidCost;
  return {
    closedN,
    wins,
    costWei: costWeiSum.toString(),
    proceedsWei: proceedsWeiSum.toString(),
    pnlWei: pnlBig.toString(),
    openN,
    free: { n: freeN },
    paid: {
      n: paidN,
      trusted,
      incomplete,
      wins: paidWins,
      costWei: paidCost.toString(),
      proceedsWei: paidProceeds.toString(),
      pnlWei: paidPnl.toString(),
    },
    byExitReason,
  };
}

export function formatPnl(sum, title) {
  const trustedN = sum?.paid?.trusted ?? 0;
  const paidWins = sum?.paid?.wins ?? 0;
  const paidCostWei = sum?.paid?.costWei ?? "0";
  const paidProceedsWei = sum?.paid?.proceedsWei ?? "0";
  const paidPnlWei = sum?.paid?.pnlWei ?? "0";
  const incompleteN = sum?.paid?.incomplete ?? 0;
  const freeN = sum?.free?.n ?? 0;
  const openN = sum?.openN ?? 0;
  const totalWins = sum?.wins ?? 0;
  const totalPnlWei = sum?.pnlWei ?? "0";
  return `${title ?? "戰績"}\n平倉（可信）：${trustedN}（勝：${paidWins}）\n可信 ${trustedN} 筆／帳不全 ${incompleteN} 筆／免費 ${freeN} 筆\n成本：${paidCostWei} wei\n實收：${paidProceedsWei} wei\n損益：${paidPnlWei} wei\n持倉：${openN}\n（全部含免費與帳不全：勝 ${totalWins}、損益 ${totalPnlWei} wei）`;
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
  } catch (e) {
    // 只有檔案不存在才算空帳；JSON 壞掉或權限問題要讓上層看到
    if (e?.code === "ENOENT") {
      st = { positions: {}, closed: [] };
    } else {
      throw e;
    }
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
