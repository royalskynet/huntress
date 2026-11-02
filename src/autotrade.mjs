// 自動打 Agent ID 內盤＋自動賣。規則寫死、不經 LLM；run.sh 每輪叫一次（node src/autotrade.mjs）。
// 買：meme-rush 內盤列（rankType 10/20）過門檻 → audit → info(route=contract-call) → quote-buy
//     → preview → gate(付費模式)＋「收到的就是這顆幣」→ 預扣帳本 → execute。每輪最多買 1 筆。
// 賣：每個持倉 → 估值（內盤 quote-sell all／外盤 market-order quote）→ 2 倍賣一半、跌半全賣、
//     持有超時全賣。內盤賣要先 approve（只准授權這顆幣給 Core），下一輪才賣。
// 帳本與 buy.mjs 共用 state/buy-<日期>.json：每筆 0.005、每日 0.016 BNB、4 筆。
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, appendFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { gate } from "../lib/gate.mjs";
import { revoke } from "./revoke.mjs";
import { rpcClient } from "./market-detect.mjs";
import { summarize, formatPnl } from "./pnl.mjs";

export const PER_TX_MAX_WEI = 5000000000000000n;
export const DAILY_MAX_WEI = 16000000000000000n;
export const DAILY_COUNT = 4;
const NATIVE = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";

export const DEFAULTS = {
  buy: { enabled: true, amountBNB: "0.004", minHolders: 15, minProgress: 3, maxAgeMin: 120, slippageBps: 2000, maxOpen: 4, minWalletBNB: "0.005", maxDevSellPct: 50, maxDevLaunches24h: 3 },
  sell: { tiers: [{ x: 2, bps: 5000 }, { x: 10, bps: 4000 }, { x: 20, bps: 5000 }], stopLossX: 0.5, maxHoldH: 24, moonMaxHoldH: 168, trailPreBE: 0.4, trailPostBE: 0.6, trailConfirm: 2, slippageBps: 2000, marketSlippagePct: 15, dustBNB: "0.0004", freeWarmMin: 3, freeTrail: 0.5 },
};

export function toWei(s, dec = 18) {
  const m = String(s).match(/^([0-9]+)(?:\.([0-9]+))?$/);
  if (!m) throw new Error(`bad amount ${s}`);
  return BigInt(m[1]) * 10n ** BigInt(dec) + BigInt((m[2] ?? "").slice(0, dec).padEnd(dec, "0") || "0");
}
export function fromWei(w, dec = 18) {
  const s = BigInt(w).toString().padStart(dec + 1, "0");
  const out = `${s.slice(0, -dec)}.${s.slice(-dec)}`.replace(/0+$/, "").replace(/\.$/, "");
  return out;
}

export function backoffMs(n) {
  return Math.min(2 ** (n - 1), 15) * 60000;
}

export function devReject(row, st, cfg, now) {
  const dev = row?.devAddress;
  if (!dev) return "dev 地址未知";
  const d = lc(dev);
  if (st?.devBlack && st.devBlack[d] != null) return "黑名單 DEV";
  const sellPct = Number(row?.devSellPercent ?? row?.devSellPct ?? NaN);
  if (!Number.isNaN(sellPct) && sellPct > Number(cfg?.maxDevSellPct ?? DEFAULTS.buy.maxDevSellPct)) return "dev 已賣";
  const seen = st?.devSeen?.[d];
  if (Array.isArray(seen)) {
    const cutoff = now - 24 * 60 * 60 * 1000;
    const active = seen.filter((x) => Number(x?.at) >= cutoff);
    if (active.length >= Number(cfg?.maxDevLaunches24h ?? DEFAULTS.buy.maxDevLaunches24h)) return "重複 DEV";
  }
  return null;
}

function taipeiDate(now) {
  return new Date(now + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

// 門檻不過回傳原因字串；過了回傳 null。任何欄位缺漏都算不過
export function screen(row, cfg, now) {
  const h = Number(row?.holders);
  if (!(h >= cfg.minHolders)) return `持幣 ${row?.holders ?? "未知"} < ${cfg.minHolders}`;
  const p = Number(row?.progress);
  if (!(p >= cfg.minProgress)) return `曲線 ${row?.progress ?? "未知"}% < ${cfg.minProgress}%`;
  if (row?.devPosition == null) return "dev 持倉未知";
  if (Number(row.devPosition) === 2) return "dev 已清倉";
  const age = (now - Number(row?.createTime)) / 60000;
  if (!(age >= 0 && age <= cfg.maxAgeMin)) return `上線 ${Math.floor(age)} 分鐘 > ${cfg.maxAgeMin}`;
  return null;
}

const lc = (s) => String(s ?? "").toLowerCase();
const changes = (pv) => (Array.isArray(pv?.data?.simulationResult?.balanceChanges) ? pv.data.simulationResult.balanceChanges : []);

// 買：除了 gate，還要確認模擬裡唯一收到的是這顆幣、付出去的只有 BNB
export function buyLooksRight(pv, token) {
  const c = changes(pv);
  const gain = c.filter((x) => Number(x?.change) > 0);
  const loss = c.filter((x) => !(Number(x?.change) >= 0));
  return gain.length === 1 && lc(gain[0].contractAddress) === lc(token) && loss.every((x) => lc(x.contractAddress) === NATIVE);
}

function commonChecks(pv, tx, r) {
  const d = pv?.success === true ? pv.data : null;
  const sim = d?.simulationResult;
  if (!d?.requestId) r.push("preview 失敗");
  if (sim?.simulationCode !== "000000000") r.push("模擬未通過");
  let v = 1n;
  try { v = BigInt(tx?.value ?? "1"); } catch {}
  if (v !== 0n) r.push("value 不為 0");
  if (!(Array.isArray(sim?.authorityChanges) && sim.authorityChanges.length === 0)) r.push("有權限變更");
  if ((d?.risks?.riskDetails ?? [1]).length) r.push("有風險項");
  if (d?.requireConfirmation !== false) r.push("需 App 確認");
  return { d, sim };
}

// 賣：value 0、唯一減少的是這顆幣、收到的只有 BNB、無授權／權限變更、無風險、免 App 確認
export function sellGate(pv, tx, token) {
  const r = [];
  const { d, sim } = commonChecks(pv, tx, r);
  const c = changes(pv);
  const loss = c.filter((x) => !(Number(x?.change) >= 0));
  const gain = c.filter((x) => Number(x?.change) > 0);
  if (!(loss.length === 1 && lc(loss[0].contractAddress) === lc(token))) r.push("減少的不只這顆幣");
  if (!gain.every((x) => lc(x.contractAddress) === NATIVE)) r.push("收到非 BNB");
  if (!(Array.isArray(sim?.allowanceChanges) && sim.allowanceChanges.length === 0)) r.push("有授權變更");
  return { ok: r.length === 0, reasons: r, requestId: r.length ? null : d.requestId };
}

// approve：value 0、資產不減少、恰一筆授權變更且只提到這顆幣與 Core
// ponytail: allowanceChanges 欄位名未實測，先用「整筆 JSON 含 token 與 core 位址」比對；第一次真 approve 後改成欄位比對
export function approveGate(pv, tx, token, core) {
  const r = [];
  const { d, sim } = commonChecks(pv, tx, r);
  if (lc(tx?.to) !== lc(token)) r.push("approve 對象不是這顆幣");
  if (changes(pv).some((x) => !(Number(x?.change) >= 0))) r.push("資產會減少");
  const al = sim?.allowanceChanges;
  if (!(Array.isArray(al) && al.length === 1)) r.push("授權變更不是恰一筆");
  else {
    const j = lc(JSON.stringify(al[0]));
    if (!/^0x[0-9a-f]{40}$/.test(lc(core)) || !j.includes(lc(core)) || !j.includes(lc(token))) r.push("授權對象不是 Core");
  }
  return { ok: r.length === 0, reasons: r, requestId: r.length ? null : d.requestId };
}

function load(p, dflt) {
  try { return JSON.parse(readFileSync(p, "utf8")); } catch { return dflt; }
}
function save(p, v) {
  writeFileSync(p + ".tmp", JSON.stringify(v, null, 2));
  renameSync(p + ".tmp", p);
}

const preview = (deps, from, tx) =>
  deps.baw(["contract-call", "preview", "--binanceChainId", "56", "--from", from, "--to", tx.to, "--value", String(tx.value), "--inputData", tx.inputData, "--json"]);
const execute = (deps, requestId) => deps.baw(["contract-call", "execute", "--requestId", requestId, "--json"]);

async function tryBuy(deps, cfg, st) {
  const { now, stateDir } = deps;
  const ledgerPath = join(stateDir, `buy-${taipeiDate(now)}.json`);
  const ledger = load(ledgerPath, { total: 0, byContract: {}, spentWei: "0" });
  const value = toWei(cfg.amountBNB);
  if (value > PER_TX_MAX_WEI) return deps.log(`autobuy amount ${cfg.amountBNB} 超過單筆上限`);
  if ((ledger.total ?? 0) >= DAILY_COUNT || BigInt(ledger.spentWei ?? "0") + value > DAILY_MAX_WEI) return;

  const openCount = Object.values(st.positions).filter((pp) => !pp?.dust && pp?.kind !== "free").length;
  if (openCount >= cfg.maxOpen) {
    deps.log(`autobuy 持倉已滿 ${openCount}/${cfg.maxOpen}`);
    return;
  }
  let balance = null;
  try { balance = await deps.balance(); } catch { balance = null; }
  if (balance === null || typeof balance !== "bigint") {
    deps.log(`autobuy 錢包餘額讀不到`);
    return;
  }
  const minWalletWei = toWei(cfg.minWalletBNB);
  if (balance - value < minWalletWei) {
    if (st.walletLow !== true) {
      st.walletLow = true;
      await deps.notify(`⏸ 錢包 ${fromWei(balance)} BNB，低於停手線 ${cfg.minWalletBNB}，付費買入停手（賣出照常）`);
    }
    return;
  }
  if (st.walletLow === true) {
    st.walletLow = false;
    await deps.notify(`▶️ 錢包 ${fromWei(balance)} BNB 回到停手線以上，付費買入恢復`);
  }

  const rows = await deps.rows();
  if (!st.devSeen) st.devSeen = {};
  if (!st.devBlack) st.devBlack = {};
  const cutoffDev = now - 24 * 60 * 60 * 1000;
  for (const [devKey, arr] of Object.entries(st.devSeen)) {
    if (!Array.isArray(arr)) { delete st.devSeen[devKey]; continue; }
    const filtered = arr.filter((x) => Number(x?.at) >= cutoffDev);
    if (filtered.length === 0) delete st.devSeen[devKey];
    else st.devSeen[devKey] = filtered;
  }
  // 每輪先用 rows 更新 devSeen
  for (const row of rows ?? []) {
    const devAddr = row?.devAddress;
    const token = lc(row?.contractAddress);
    if (!devAddr || !/^0x[0-9a-f]{40}$/.test(token)) continue;
    const dk = lc(devAddr);
    const arr = st.devSeen[dk] ?? (st.devSeen[dk] = []);
    const exists = arr.some((x) => lc(x?.token) === token);
    if (exists) continue;
    arr.push({ token, at: now });
  }
  const counts = {};
  let blocked = 0;
  try {
    for (const row of rows) {
      const token = lc(row?.contractAddress);
      if (!/^0x[0-9a-f]{40}$/.test(token) || st.positions[token] || st.rejected[token] || st.closed.some((c) => c.token === token)) continue;
      const scr = screen(row, cfg, now);
      if (scr) {
        blocked++;
        const key = String(scr).split(/\s+/)[0];
        counts[key] = (counts[key] ?? 0) + 1;
        continue;
      }
      const dr = devReject(row, st, cfg, now);
      if (dr) {
        st.rejected[token] = dr;
        continue;
      }
      const audit = await deps.audit(token);
      if (!audit?.ok) { deps.log(`autobuy ${token} audit 取不到：${audit?.error}`); continue; }
      const hits = (audit.data?.riskItems ?? []).flatMap((c) => (c?.details ?? []).filter((d) => d?.isHit).map((d) => d.title));
      if (hits.length || Number(audit.data?.riskLevel ?? 0) >= 4) { st.rejected[token] = `audit：${hits.join("、") || "高風險"}`; continue; }

      const info = deps.script("info", { token, wallet: deps.wallet });
      if (info?.data?.route !== "contract-call" || info?.data?.isAgentIdExclusive !== true) { st.rejected[token] = `route ${info?.data?.route ?? info?.error?.code}`; continue; }
      const q = deps.script("quote-buy", { token, wallet: deps.wallet, amount: cfg.amountBNB, slippageBps: cfg.slippageBps });
      const tx = q?.data?.tx;
      if (q?.success !== true || q.data.simulation?.ok !== true || !tx || q.data.approveTx) { deps.log(`autobuy ${token} quote 不可執行：${JSON.stringify(q?.error ?? q?.data?.simulation)}`); continue; }
      let txValue = -1n;
      try { txValue = BigInt(tx.value); } catch {}
      if (!(txValue > 0n && txValue <= value)) { st.rejected[token] = "quote value 超過設定金額"; continue; }

      const pv = preview(deps, deps.wallet, tx);
      const g = gate(pv, { to: tx.to, value: tx.value }, { cfg: { dailyMax: DAILY_COUNT, perContractDaily: DAILY_COUNT, denylist: deps.denylist ?? [] }, ledger: { total: ledger.total ?? 0, byContract: {} } }, { maxValueWei: String(PER_TX_MAX_WEI) });
      if (!g.ok || !buyLooksRight(pv, token)) { st.rejected[token] = `閘：${(g.reasons.length ? g.reasons : ["收到的不是這顆幣"]).join("、")}`; deps.log(`autobuy ${token} ${st.rejected[token]}`); continue; }

      // 送出前先扣帳本＋記持倉：execute 逾時或失敗也算一筆，寧可少買不可重送
      ledger.total = (ledger.total ?? 0) + 1;
      ledger.spentWei = String(BigInt(ledger.spentWei ?? "0") + txValue);
      ledger.byContract = { ...(ledger.byContract ?? {}), [token]: (ledger.byContract?.[token] ?? 0) + 1 };
      save(ledgerPath, ledger);
      const devAddr = row?.devAddress;
      st.positions[token] = { symbol: row.symbol ?? "", costWei: String(txValue), origCostWei: String(txValue), boughtAt: now, soldHalf: false, proceedsWei: "0", dev: devAddr ? lc(devAddr) : undefined };
      save(join(stateDir, "positions.json"), st);
      const ex = execute(deps, g.requestId);
      st.positions[token].txHash = ex?.data?.txHash ?? null;
      deps.log(`autobuy ${token} ${JSON.stringify(ex)}`);
      await deps.notify(ex?.success
        ? `🟢 自動買入 ${row.symbol} ${fromWei(txValue)} BNB（最少收 ${q.data.minTokenOut}，滑點 ${q.data.slippagePercent}%）\n${token}\ntx ${ex.data?.txHash ?? ex.data?.status}`
        : `⚠️ 自動買入 ${row.symbol} 送出失敗（帳本已扣）：${JSON.stringify(ex?.error ?? ex)}`);
      return; // 每輪最多 1 筆
    }
  } finally {
    if (blocked > 0) {
      const parts = Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ×${v}`).join("、");
      deps.log(`autobuy screen four ${rows.length} 盤：${parts}`);
    }
  }
}

async function valueOf(deps, token, info) {
  if (info?.data?.route === "contract-call") {
    const q = deps.script("quote-sell", { token, wallet: deps.wallet, amount: "all" });
    try { return q?.success ? toWei(q.data.estimate.userReceives) : null; } catch { return null; }
  }
  if (info?.data?.route === "market-order") {
    const q = deps.baw(["market-order", "quote", "--binanceChainId", "56", "--fromTokenQty", String(info.data.wallet?.tokenBalance), "--fromToken", token, "--toToken", NATIVE, "--json"]);
    try { return q?.success && lc(q.data?.toCoinSymbol) === "bnb" ? toWei(q.data.toCoinAmount) : null; } catch { return null; }
  }
  return null;
}

// 要賣多少：[null|"all"|bps, 原因]
export function decide(pos, valWei, raw, cfg, now) {
  if (pos?.kind === "free") {
    if (valWei == null || raw === 0n) return [null, "估值失敗"];
    pos.firstValAt ??= now;
    const warmMs = (cfg.freeWarmMin ?? 3) * 60 * 1000;
    if (now - pos.firstValAt < warmMs) return [null, "暖機"];
    if (now - pos.boughtAt >= (cfg.moonMaxHoldH ?? 168) * 3600 * 1000) return ["all", `持有滿 ${cfg.moonMaxHoldH}h`];
    const px = valWei * 10n ** 18n / raw;
    if (pos.peakPx == null || px > BigInt(pos.peakPx)) {
      pos.peakPx = String(px);
      pos.dropHits = 0;
    }
    const peakPx = BigInt(pos.peakPx);
    const trail = cfg.freeTrail ?? 0.5;
    if (px * 10000n <= peakPx * (10000n - BigInt(Math.round(trail * 10000)))) {
      pos.dropHits = (pos.dropHits ?? 0) + 1;
      if (pos.dropHits >= (cfg.trailConfirm ?? 2)) return ["all", "高點回落"];
    } else {
      pos.dropHits = 0;
    }
    return [null, ""];
  }
  const t = pos.tierIdx ?? (pos.soldHalf ? 1 : 0);
  const back = t >= 1;
  // 1. 回本前持有超時
  if (!back && (now - pos.boughtAt >= cfg.maxHoldH * 3600 * 1000)) return ["all", `持有滿 ${cfg.maxHoldH}h`];
  // 2. 回本後持有超時
  if (back && (now - pos.boughtAt >= cfg.moonMaxHoldH * 3600 * 1000)) return ["all", `持有滿 ${cfg.moonMaxHoldH}h`];
  // 3. 估值失敗
  if (valWei == null || raw === 0n) return [null, "估值失敗"];
  const cost = BigInt(pos.costWei);
  // 4. 高點更新
  const px = valWei * 10n ** 18n / raw;
  if (pos.peakPx == null || px > BigInt(pos.peakPx)) {
    pos.peakPx = String(px);
    pos.dropHits = 0;
  }
  const peakPx = BigInt(pos.peakPx);
  // 5. 停損（回本前）
  if (!back && valWei * 100n <= cost * BigInt(Math.round(cfg.stopLossX * 100))) return ["all", `跌到成本 ${cfg.stopLossX} 倍`];
  // 6. 分批停利
  if (t < cfg.tiers.length && valWei * 100n >= cost * BigInt(Math.round(cfg.tiers[t].x * 100))) return [cfg.tiers[t].bps, `漲到成本 ${cfg.tiers[t].x} 倍`];
  // 7. 高點回落
  const trail = back ? cfg.trailPostBE : cfg.trailPreBE;
  if (px * 10000n <= peakPx * (10000n - BigInt(Math.round(trail * 10000)))) {
    pos.dropHits = (pos.dropHits ?? 0) + 1;
    if (pos.dropHits >= cfg.trailConfirm) return ["all", "高點回落"];
  } else {
    pos.dropHits = 0;
  }
  return [null, ""];
}

export function applySell(pos, how) {
  if (how === "all") { pos.selling = true; return; }
  const t = pos.tierIdx ?? (pos.soldHalf ? 1 : 0);
  pos.costWei = String(BigInt(pos.costWei) * (10000n - BigInt(how)) / 10000n);
  pos.tierIdx = t + 1;
  pos.soldHalf = true;
  pos.dropHits = 0;
}

const ERC20_TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

export async function ingestFreeMints(deps, st) {
  const { now, stateDir, wallet } = deps;
  const filePath = join(stateDir, "free-mints.jsonl");
  let lines = [];
  try {
    const raw = readFileSync(filePath, "utf8");
    lines = raw.split(/\n/).filter((l) => l.trim());
  } catch {
    return;
  }
  if (!st.positions) st.positions = {};
  if (!st.closed) st.closed = [];
  const remaining = [];
  const W = lc(wallet);
  for (const line of lines) {
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    const txHash = rec?.txHash;
    const at = Number(rec?.at ?? 0);
    let receipt = null;
    try { receipt = await deps.receipt(txHash); } catch { receipt = null; }
    if (!receipt) {
      if (now - at < 30 * 60 * 1000) remaining.push(rec);
      continue;
    }
    if (receipt.status !== "0x1") continue;
    const logs = Array.isArray(receipt.logs) ? receipt.logs : [];
    for (const log of logs) {
      const topics = log?.topics;
      if (!Array.isArray(topics) || topics.length !== 3) continue;
      if (String(topics[0]).toLowerCase() !== ERC20_TRANSFER_TOPIC) continue;
      const toAddr = "0x" + String(topics[2]).slice(-40).toLowerCase();
      if (toAddr !== W) continue;
      const token = lc(log.address);
      if (!/^0x[0-9a-f]{40}$/.test(token)) continue;
      if (st.positions[token] || st.closed.some((c) => lc(c?.token) === token)) continue;
      st.positions[token] = { kind: "free", symbol: "", costWei: "0", boughtAt: now, txHash };
    }
  }
  const out = remaining.map((r) => JSON.stringify(r)).join("\n");
  writeFileSync(filePath + ".tmp", out ? out + "\n" : "");
  renameSync(filePath + ".tmp", filePath);
}

export async function sellCheck(deps, token, pos, info) {
  const route = info?.data?.route;
  if (route === "contract-call") {
    const q = deps.script("quote-sell", { token, wallet: deps.wallet, amount: "all" });
    if (q?.success !== true) {
      if (pos?.sellCheck != null && pos?.sellCheck !== undefined) return;
      pos.sellCheck = "fail:quote";
      if (pos.sellCheckNotified !== true) {
        pos.sellCheckNotified = true;
        try { await deps.notify(`⚠️ ${pos.symbol ?? token} 預演賣出不過…可能賣不掉`); } catch {}
      }
      return;
    }
    if (q?.data?.approveTx) {
      if (pos.sellCheck) {
        delete pos.sellCheck;
      }
      return;
    }
    if (pos?.sellCheck != null && pos?.sellCheck !== undefined) return;
    const tx = q?.data?.tx;
    try {
      const pv = preview(deps, deps.wallet, tx);
      const g = sellGate(pv, tx, token);
      if (g.ok) {
        pos.sellCheck = "ok";
      } else {
        pos.sellCheck = `fail:${(g.reasons || []).join("、") || "gate"}`;
        if (pos.sellCheckNotified !== true) {
          pos.sellCheckNotified = true;
          try { await deps.notify(`⚠️ ${pos.symbol ?? token} 預演賣出不過…可能賣不掉`); } catch {}
        }
      }
    } catch (e) {
      pos.sellCheck = "fail:gate";
      if (pos.sellCheckNotified !== true) {
        pos.sellCheckNotified = true;
        try { await deps.notify(`⚠️ ${pos.symbol ?? token} 預演賣出不過…可能賣不掉`); } catch {}
      }
    }
    return;
  }
  if (route === "market-order") {
    const qty = info?.data?.wallet?.tokenBalance;
    try {
      const q = deps.baw(["market-order", "quote", "--binanceChainId", "56", "--fromTokenQty", String(qty ?? "0"), "--fromToken", token, "--toToken", NATIVE, "--json"]);
      if (q?.success === true && lc(q?.data?.toCoinSymbol) === "bnb") {
        let quoteAmt = 0n;
        try { quoteAmt = toWei(q?.data?.toCoinAmount); } catch {}
        if (quoteAmt > 0n) {
          pos.sellCheck = "ok";
          return;
        }
      }
    } catch {}
    pos.sellCheck = "fail:quote";
    if (pos.sellCheckNotified !== true) {
      pos.sellCheckNotified = true;
      try { await deps.notify(`⚠️ ${pos.symbol ?? token} 預演賣出不過…可能賣不掉`); } catch {}
    }
    return;
  }
}

async function trySell(deps, cfg, st) {
  for (const [token, pos] of Object.entries(st.positions)) {
    if (pos?.sellFail && deps.now < pos.sellFail.nextAt) continue;
    const info = deps.script("info", { token, wallet: deps.wallet });
    if (info?.success !== true) { deps.log(`autosell ${token} info 失敗`); continue; }
    let raw = 0n;
    try { raw = BigInt(info.data.wallet?.tokenBalanceRaw ?? "0"); } catch {}
    if (info?.success === true && raw > 0n) {
      try { await sellCheck(deps, token, pos, info); } catch {}
    }
    if (raw === 0n) {
      // 買單可能還沒上鏈；10 分鐘後仍是 0＝已賣完或買失敗，結案
      if (deps.now - pos.boughtAt > 10 * 60 * 1000) {
        let revoked = null;
        if (pos.selling && pos.core) {
          try {
            const r = await revoke(deps, { kind: "erc20", token, spender: pos.core });
            revoked = r.ok === true;
            await deps.notify(revoked
              ? `🔓 ${pos.symbol} 已賣完，已撤授權\ntx ${r.txHash ?? ""}`.trim()
              : `⚠️ ${pos.symbol} 已賣完但授權未撤：${(r.reasons ?? []).join("、") || "失敗"}，回 /revoke 處理`);
          } catch (e) {
            revoked = false;
            await deps.notify(`⚠️ ${pos.symbol} 已賣完但授權未撤：${String(e?.message ?? e)}，回 /revoke 處理`);
          }
        }
        const rec = { token, ...pos, closedAt: deps.now };
        if (revoked !== null) rec.revoked = revoked;
        st.closed.push(rec);
        delete st.positions[token];
      }
      continue;
    }
    const valWei = await valueOf(deps, token, info);
    const [how, why] = decide(pos, valWei, raw, cfg, deps.now);
    if (!how) continue;
    // 零頭不賣
    if (valWei != null) {
      const est = how === "all" ? valWei : (valWei * BigInt(how) / 10000n);
      const dustWei = toWei(cfg.dustBNB);
      if (est < dustWei) {
        if (how === "all") pos.dust = true;
        deps.log(`autosell ${token} 零頭不賣`);
        continue;
      }
    }
    const route = info.data.route;
    const qty = how === "all" ? null : fromWei(raw * BigInt(how) / 10000n);

    const recordFail = () => {
      const n = (pos.sellFail?.n ?? 0) + 1;
      pos.sellFail = { n, nextAt: deps.now + backoffMs(n) };
      return n;
    };

    if (route === "market-order") {
      const qQty = how === "all" ? String(info.data.wallet.tokenBalance) : qty;
      const msp = cfg.marketSlippagePct;
      const q = deps.baw(["market-order", "quote", "--binanceChainId", "56", "--fromTokenQty", qQty, "--fromToken", token, "--toToken", NATIVE, "--slippage", String(msp), "--json"]);
      deps.log(`autosell ${token} quote ${JSON.stringify(q)}`);
      let quoteOk = q?.success === true && lc(q?.data?.toCoinSymbol) === "bnb";
      let quoteAmt = 0n;
      try { quoteAmt = toWei(q?.data?.toCoinAmount); } catch {}
      if (!quoteOk || !(quoteAmt > 0n)) {
        const n = recordFail();
        if (n === 1 || n % 5 === 0) await deps.notify(`⚠️ 自動賣出失敗（${why}）${pos.symbol}\n${token}\nquote 失敗`);
        continue;
      }
      const r = deps.baw(["market-order", "swap", "--binanceChainId", "56", "--fromTokenQty", qQty, "--fromToken", token, "--toToken", NATIVE, "--slippage", String(msp), "--json"]);
      deps.log(`autosell ${token} swap ${JSON.stringify(r)}`);
      if (r?.success) {
        delete pos.sellFail;
        try {
          if (pos.proceedsWei == null) pos.proceedsWei = "0";
          const recv = r?.data?.toCoinAmount ?? r?.data?.amount ?? r?.data?.receiveAmount;
          if (recv != null) {
            pos.proceedsWei = (BigInt(pos.proceedsWei) + toWei(String(recv))).toString();
          } else if (typeof quoteAmt === "bigint" && quoteAmt > 0n) {
            pos.proceedsWei = (BigInt(pos.proceedsWei) + quoteAmt).toString();
          }
        } catch {}
        applySell(pos, how);
        if (how === "all" && (why === `跌到成本 ${cfg.stopLossX} 倍` || why === "高點回落") && pos.dev) {
          if (!st.devBlack) st.devBlack = {};
          st.devBlack[pos.dev] = deps.now;
        }
        await deps.notify(`🔴 自動賣出（${why}）${pos.symbol} ${how === "all" ? "全部" : `${how / 100}%`}\n${token}\norder ${r.data?.orderId}`);
      } else {
        const n = recordFail();
        if (n === 1 || n % 5 === 0) await deps.notify(`⚠️ 自動賣出失敗（${why}）${pos.symbol} ${how === "all" ? "全部" : `${how / 100}%`}\n${token}\n${JSON.stringify(r?.error ?? r)}`);
      }
      continue;
    }
    if (route !== "contract-call") continue;

    const q = deps.script("quote-sell", { token, wallet: deps.wallet, amount: how === "all" ? "all" : qty, slippageBps: cfg.slippageBps });
    if (q?.success !== true) {
      const n = recordFail();
      deps.log(`autosell ${token} quote 失敗 ${JSON.stringify(q?.error)}`);
      if (n === 1 || n % 5 === 0) await deps.notify(`⚠️ 自動賣出失敗（${why}）${pos.symbol}\n${token}\nquote 失敗`);
      continue;
    }
    if (q.data.approveTx) {
      const atx = q.data.approveTx.tx ?? q.data.approveTx;
      const core = q.data.contracts?.core ?? q.data.approveTx.spender;
      const g = approveGate(preview(deps, deps.wallet, atx), atx, token, core);
      if (!g.ok) {
        const n = recordFail();
        deps.log(`autosell ${token} approve 被閘：${g.reasons.join("、")}`);
        if (n === 1 || n % 5 === 0) await deps.notify(`⚠️ ${pos.symbol} 要賣（${why}）但 approve 沒過閘：${g.reasons.join("、")}`);
        continue;
      }
      const ax = execute(deps, g.requestId);
      deps.log(`autosell ${token} approve ${JSON.stringify(ax)}`);
      if (ax?.success) {
        delete pos.sellFail;
        pos.core = lc(core); // 記下授權對象，全部賣完結案時撤
      } else {
        const n = recordFail();
        if (n === 1 || n % 5 === 0) await deps.notify(`⚠️ 自動賣出失敗（${why}）${pos.symbol}\n${token}\n${JSON.stringify(ax?.error ?? ax)}`);
      }
      continue; // 等 approve 上鏈，下一輪重新報價再賣
    }
    // 不用 approve＝授權早已存在（舊持倉也是），同樣記下，結案時撤
    if (!pos.core && /^0x[0-9a-f]{40}$/.test(lc(q.data.contracts?.core))) pos.core = lc(q.data.contracts.core);
    const tx = q.data.tx;
    const g = sellGate(preview(deps, deps.wallet, tx), tx, token);
    if (!g.ok) {
      const n = recordFail();
      deps.log(`autosell ${token} 被閘：${g.reasons.join("、")}`);
      if (n === 1 || n % 5 === 0) await deps.notify(`⚠️ 自動賣出失敗（${why}）${pos.symbol}\n${token}\n${g.reasons.join("、")}`);
      continue;
    }
    const ex = execute(deps, g.requestId);
    deps.log(`autosell ${token} ${JSON.stringify(ex)}`);
    if (ex?.success) {
      delete pos.sellFail;
      try {
        if (pos.proceedsWei == null) pos.proceedsWei = "0";
        const recv = q?.data?.estimate?.userReceives;
        if (recv != null) {
          pos.proceedsWei = (BigInt(pos.proceedsWei) + toWei(String(recv))).toString();
        }
      } catch {}
      applySell(pos, how);
      if (how === "all" && (why === `跌到成本 ${cfg.stopLossX} 倍` || why === "高點回落") && pos.dev) {
        if (!st.devBlack) st.devBlack = {};
        st.devBlack[pos.dev] = deps.now;
      }
      await deps.notify(`🔴 自動賣出（${why}）${pos.symbol} ${how === "all" ? "全部" : `${how / 100}%`}，預估收 ${q.data.estimate?.userReceives} BNB\n${token}\ntx ${ex.data?.txHash ?? ex.data?.status}`);
    } else {
      const n = recordFail();
      if (n === 1 || n % 5 === 0) await deps.notify(`⚠️ 自動賣出失敗（${why}）${pos.symbol} ${how === "all" ? "全部" : `${how / 100}%`}，預估收 ${q.data.estimate?.userReceives} BNB\n${token}\n${JSON.stringify(ex?.error ?? ex)}`);
    }
  }
}

function taipeiHour(now) {
  return new Date(now + 8 * 3600 * 1000).getUTCHours();
}

export async function runOnce(deps) {
  const cfg = { buy: { ...DEFAULTS.buy, ...(deps.cfg?.buy ?? {}) }, sell: { ...DEFAULTS.sell, ...(deps.cfg?.sell ?? {}) } };
  mkdirSync(deps.stateDir, { recursive: true });
  const stPath = join(deps.stateDir, "positions.json");
  const st = { positions: {}, rejected: {}, closed: [], ...load(stPath, {}) };
  try {
    await ingestFreeMints(deps, st);
    await trySell(deps, cfg.sell, st);
    if (cfg.buy.enabled) await tryBuy(deps, cfg.buy, st);
    try {
      const h = taipeiHour(deps.now);
      const td = taipeiDate(deps.now);
      if (h >= 21 && st.pnlSentDate !== td) {
        const sinceMs = deps.now - 24 * 3600 * 1000;
        const ssum = summarize(st, sinceMs);
        const msg = formatPnl(ssum, "24h 戰績");
        if (deps.notify) {
          await deps.notify(msg);
        }
        st.pnlSentDate = td;
      }
    } catch {}
  } finally {
    save(stPath, st);
  }
}

function defaultDeps() {
  const bawBin = process.env.BAW_BIN || "node_modules/.bin/baw";
  const script = process.env.AID_SCRIPT || "vendor/skills-hub/skills/binance-web3/binance-agentic-wallet/scripts/agent-id-exclusive-token-launches.mjs";
  const mr = "vendor/skills-hub/skills/binance-web3/meme-rush/scripts/cli.mjs";
  const logDir = process.env.LOG_DIR || "logs";
  const json = (cmd, args) => {
    const r = spawnSync(cmd, args, { encoding: "utf8" });
    try { return JSON.parse(r.stdout); } catch { return { success: false, error: (r.stderr || "").trim() || `exit ${r.status}` }; }
  };
  const baw = (args) => json(bawBin, args);
  const addr = baw(["wallet", "address", "--json"])?.data?.addresses?.find((a) => a.binanceChainId === "56")?.address;
  if (!addr) throw new Error("取不到錢包地址");
  const cfgAll = load(process.env.CONFIG || "config.json", {});
  mkdirSync(logDir, { recursive: true });
  return {
    now: Date.now(),
    stateDir: process.env.STATE_DIR || "state",
    wallet: addr,
    cfg: cfgAll.autotrade ?? {},
    denylist: cfgAll.denylist ?? [],
    baw,
    balance: async () => {
      const res = baw(["wallet", "balance", "--json"]);
      if (res?.success !== true) return null;
      const arr = Array.isArray(res?.data) ? res.data : [];
      const hit = arr.find((x) => x?.binanceChainId === "56" && x?.symbol === "BNB");
      if (!hit) return null;
      try { return toWei(hit.balance); } catch { return null; }
    },
    script: (cmd, params) => json("node", [script, cmd, JSON.stringify(params)]),
    rows: async () => {
      if (process.env.AUTOTRADE_ROWS) return load(process.env.AUTOTRADE_ROWS, []);
      const seen = new Map();
      for (const rankType of [10, 20]) {
        const r = json("node", [mr, "meme-rush", JSON.stringify({ chainId: "56", rankType, protocol: [2004], tokenVersionFilter: { 2004: ["openfour.meme.AgentIdExclusive"] }, limit: 100 })]);
        for (const row of r?.data ?? []) seen.set(lc(row.contractAddress), row);
      }
      return [...seen.values()];
    },
    audit: async (token) => (await import("./research.mjs")).fetchAudit("56", token),
    receipt: async (h) => rpcClient()("eth_getTransactionReceipt", [h]),
    notify: async (text) => (await import("./notify.mjs")).notify(text).catch((e) => appendFileSync(join(logDir, "run.log"), `notify fail ${e.message}\n`)),
    log: (m) => appendFileSync(join(logDir, "run.log"), `${new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 19).replace("T", " ")} ${m}\n`),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runOnce(defaultDeps()).catch((e) => { process.stderr.write(`${e?.stack || e}\n`); process.exit(1); });
}
