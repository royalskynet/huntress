import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, appendFileSync, renameSync, existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { toWei, fromWei } from "./autotrade.mjs";

export const READER = "0x18Aa6C93f1887a243fdc348C9A77F5136555174a";
export const PORTAL = "0x49387D2E6cbF8FefE856e3FBc3E98a01aC3af062";
export const SEL = { buy: "0xcce7ec13", sellAll: "0xd69f8e66", sell: "0x92cdbac5", claim: "0x1e83409a", marketPage: "0x8f82e165", marketDetail: "0x37fe8893", marketSettings: "0x51c023e2", quoteBuy: "0x34259b1b" };
export const PER_BUY_MAX_WEI = 4000000000000000n;
export const DEFAULTS = { valueBNB: "0.004", minProgressBps: 300, maxProgressBps: 4000, minHolders: 5, maxAgeMin: 60, maxTaxBps: 500, slippageBps: 2000, scanLast: 32, checkAfterMin: 30 };

const ZERO_ADDR = "0x0000000000000000000000000000000000000000";
const NATIVE = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";

export function words(hex) {
  let h = String(hex ?? "").trim();
  if (h.startsWith("0x") || h.startsWith("0X")) h = h.slice(2);
  if (h.length === 0 || h.length % 64 !== 0) throw new Error("bad hex words");
  const out = [];
  for (let i = 0; i < h.length; i += 64) {
    const chunk = h.slice(i, i + 64);
    if (!/^[0-9a-fA-F]+$/.test(chunk)) throw new Error("bad hex words");
    out.push(BigInt("0x" + chunk));
  }
  return out;
}

function addr(w) {
  return "0x" + (w & ((1n << 160n) - 1n)).toString(16).padStart(40, "0");
}

export function parsePage(hex) {
  const w = words(hex);
  const o = Number(w[0] / 32n);
  const len = Number(w[o]);
  const markets = [];
  for (let i = 0; i < len; i++) markets.push(addr(w[o + 1 + i]).toLowerCase());
  return { markets, next: Number(w[1]), total: Number(w[2]) };
}

export function parseDetail(hex) {
  const w = words(hex);
  if (w.length < 50) throw new Error("detail too short");
  return {
    quoteToken: addr(w[2]).toLowerCase(),
    progressBps: Number(w[7]),
    phase: Number(w[8]),
    token: addr(w[10]).toLowerCase(),
    holders: Number(w[38]),
    launchedAt: Number(w[41]),
    startBlock: Number(w[42]),
  };
}

export function parseSettings(hex) {
  const w = words(hex);
  const t = Number(w[0] / 32n);
  const l = t + Number(w[t] / 32n);
  return {
    quoteToken: addr(w[t + 1]).toLowerCase(),
    buyTaxBps: Number(w[l + 5]),
    sellTaxBps: Number(w[l + 6]),
    maxWalletBps: Number(w[l + 11]),
  };
}

export function parseQuote(hex) {
  const w = words(hex);
  return { gross: w[0], fee: w[1], extra: w[2], shares: w[3] };
}

export function encAddr(a) {
  const h = String(a ?? "").trim().replace(/^0x/i, "").toLowerCase();
  return h.padStart(64, "0");
}

export function encUint(n) {
  return BigInt(n).toString(16).padStart(64, "0");
}

export function encBuy(market, minShares) {
  return SEL.buy + encAddr(market) + encUint(minShares);
}

export function encPage(cursor, limit) {
  return SEL.marketPage + encUint(cursor) + encUint(limit);
}

export function encDetail(m) {
  return SEL.marketDetail + encAddr(m);
}

export function encSettings(m) {
  return SEL.marketSettings + encAddr(m);
}

export function encQuoteBuy(market, wallet, wei) {
  return SEL.quoteBuy + encAddr(market) + encAddr(wallet) + encUint(wei);
}

export function screenFlap(d, s, ageMin, cfg) {
  const c = cfg ?? {};
  if (String(d?.quoteToken ?? "").toLowerCase() !== ZERO_ADDR) return "非 BNB 計價";
  if (Number(d?.phase) !== 1) return "已畢業或遷移中";
  const progress = Number(d?.progressBps);
  const minP = Number(c.minProgressBps);
  const maxP = Number(c.maxProgressBps);
  if (!(progress >= minP && progress <= maxP)) return `曲線 ${d?.progressBps}%`;
  const holders = Number(d?.holders);
  if (!(holders >= Number(c.minHolders))) return `持幣 ${d?.holders}`;
  if (!Number.isFinite(ageMin) || ageMin > Number(c.maxAgeMin)) return `上線 ${ageMin} 分鐘`;
  const buyTax = s?.buyTaxBps;
  const sellTax = s?.sellTaxBps;
  const maxTax = Number(c.maxTaxBps);
  if (typeof buyTax !== "number" || typeof sellTax !== "number" || buyTax > maxTax || sellTax > maxTax) {
    return `稅 ${buyTax}/${sellTax}`;
  }
  return null;
}

export function buyGate(pv, tx, ctx) {
  const reasons = [];
  const c = ctx ?? {};
  const market = c.market;
  const shares = c.shares;
  const valueWei = c.valueWei;
  const slippageBps = c.slippageBps;
  const d = pv?.success === true && pv?.data?.success !== false ? pv.data : null;
  const sim = d?.simulationResult;
  if (!d) reasons.push("preview 失敗");
  if (d && !d.requestId) reasons.push("缺 requestId");
  if (d && sim?.simulationCode !== "000000000") reasons.push("模擬未通過");
  if (sim && !Array.isArray(sim.authorityChanges)) reasons.push("缺 authorityChanges");
  if (sim && Array.isArray(sim.authorityChanges) && sim.authorityChanges.length !== 0) reasons.push("有權限變更");
  if (sim && !Array.isArray(sim.allowanceChanges)) reasons.push("缺 allowanceChanges");
  if (sim && Array.isArray(sim.allowanceChanges) && sim.allowanceChanges.length !== 0) reasons.push("有授權變更");
  const risks = d?.risks;
  if (d && !risks) reasons.push("缺 risks");
  if (risks && !Array.isArray(risks.riskDetails)) reasons.push("缺 riskDetails");
  if (risks && Array.isArray(risks.riskDetails) && risks.riskDetails.length !== 0) reasons.push("有風險項");
  if (d && d.requireConfirmation !== false) reasons.push("需 App 確認");

  const to = String(tx?.to ?? "").toLowerCase();
  if (to !== String(PORTAL).toLowerCase()) reasons.push("to 不是 Portal");
  let v;
  try { v = BigInt(tx?.value); } catch { v = -1n; }
  let vw;
  try { vw = BigInt(valueWei); } catch { vw = -1n; }
  if (v !== vw) reasons.push("value 不符");
  if (!(vw <= PER_BUY_MAX_WEI)) reasons.push("超過單筆上限");

  const input = String(tx?.inputData ?? "");
  if (!input.toLowerCase().startsWith(SEL.buy.toLowerCase())) reasons.push("selector 錯");
  if (input.length !== 10 + 128) reasons.push("calldata 長度錯");
  if (input.length === 10 + 128) {
    const first = input.slice(10, 74).toLowerCase();
    const second = input.slice(74, 138);
    if (first !== encAddr(market).toLowerCase()) reasons.push("market 不符");
    let minShares;
    try { minShares = BigInt("0x" + second); } catch { minShares = 0n; }
    let sharesBn;
    try { sharesBn = BigInt(shares); } catch { sharesBn = 0n; }
    if (!(minShares > 0n)) reasons.push("minShares 為 0");
    let threshold = 0n;
    try { threshold = sharesBn * (10000n - BigInt(slippageBps)) / 10000n; } catch { threshold = 0n; }
    if (minShares < threshold) reasons.push("minShares 低於滑點下限");
    if (!(sharesBn > 0n)) reasons.push("份額為 0");
  }

  const bc = Array.isArray(sim?.balanceChanges) ? sim.balanceChanges : null;
  if (!bc || bc.length !== 1) reasons.push("balanceChanges 不是一筆");
  else {
    const ch = bc[0];
    if (String(ch?.contractAddress ?? "").toLowerCase() !== NATIVE) reasons.push("非 BNB 資產變更");
    let change;
    try { change = ch?.change ?? ch?.amount; } catch { change = 0; }
    let deducted;
    try { deducted = BigInt(Math.round(-Number(change))); } catch { deducted = 0n; }
    // use BigInt from rounded number already; but for large use Math.round may lose precision. Accept uses BigInt(Math.round(-change)).
    if (!(deducted <= vw)) reasons.push("付出超過 valueWei");
  }

  const ok = reasons.length === 0;
  return { ok, reasons, requestId: ok ? d?.requestId ?? null : null };
}

function loadJson(p, dflt) {
  try { return JSON.parse(readFileSync(p, "utf8")); } catch { return dflt; }
}

function saveJson(p, v) {
  writeFileSync(p + ".tmp", JSON.stringify(v, null, 2));
  renameSync(p + ".tmp", p);
}

export async function runShadow(deps) {
  const cfg = { ...DEFAULTS, ...(deps.cfg ?? {}) };
  const valueWei = toWei(cfg.valueBNB);
  const now = deps.now;
  const wallet = deps.wallet;
  const logDir = deps.logDir;
  const stateDir = deps.stateDir;
  mkdirSync(logDir, { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  const statePath = join(stateDir, "flap-shadow.json");
  const state = loadJson(statePath, { seen: {}, checked: {} });
  if (!state.seen) state.seen = {};
  if (!state.checked) state.checked = {};

  const totalPage = parsePage(deps.call(READER, encPage(0, 1)));
  const total = totalPage.total;
  const start = Math.max(0, total - Number(cfg.scanLast));
  const markets = [];
  const marketSet = new Set();
  for (let cur = start; cur < total; ) {
    const pg = parsePage(deps.call(READER, encPage(cur, 16)));
    for (const m of pg.markets) {
      if (!marketSet.has(m)) { marketSet.add(m); markets.push(m); }
    }
    if (!pg.markets || pg.markets.length === 0) break;
    cur += 16;
  }

  const seen = state.seen;
  const counts = {};
  let blocked = 0;

  for (const m of markets) {
    if (seen[m]) continue;
    let detail, settings;
    try {
      detail = parseDetail(deps.call(READER, encDetail(m)));
      settings = parseSettings(deps.call(READER, encSettings(m)));
    } catch (e) {
      deps.log(`flap ${m} 讀取失敗 ${e?.message ?? e}`);
      continue;
    }
    const ageMin = (now / 1000 - deps.blockTs(detail.startBlock)) / 60;
    const reason = screenFlap(detail, settings, ageMin, cfg);
    if (reason !== null) {
      blocked++;
      const key = String(reason).split(/\s+/)[0];
      counts[key] = (counts[key] ?? 0) + 1;
      continue;
    }
    try {
      const quote = parseQuote(deps.call(PORTAL, encQuoteBuy(m, wallet, valueWei)));
      const minShares = (quote.shares * (10000n - BigInt(cfg.slippageBps))) / 10000n;
      const tx = { to: PORTAL, value: String(valueWei), inputData: encBuy(m, minShares) };
      const pv = deps.preview(wallet, PORTAL, tx.value, tx.inputData);
      const g = buyGate(pv, tx, { market: m, shares: quote.shares, valueWei, slippageBps: cfg.slippageBps });
      if (g.ok) {
        const row = { at: now, market: m, progressBps: detail.progressBps, holders: detail.holders, ageMin: Number(ageMin.toFixed(1)), valueWei: String(valueWei), shares: String(quote.shares), minShares: String(minShares) };
        appendFileSync(join(logDir, "shadow.jsonl"), JSON.stringify(row) + "\n");
        deps.log(`flap shadow ${m} 會買 進度 ${detail.progressBps}% 持幣 ${detail.holders}`);
        seen[m] = now;
      } else {
        deps.log(`flap gate ${m} ${g.reasons.join("、")}`);
        seen[m] = now;
      }
    } catch (e) {
      deps.log(`flap ${m} 讀取失敗 ${e?.message ?? e}`);
    }
  }

  if (blocked > 0) {
    const parts = Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ×${v}`).join("、");
    deps.log(`flap screen ${markets.length} 盤：${parts}`);
  }

  saveJson(statePath, { seen, checked: state.checked });
}

export async function checkShadow(deps) {
  const cfg = { ...DEFAULTS, ...(deps.cfg ?? {}) };
  const valueWei = toWei(cfg.valueBNB);
  const now = deps.now;
  const stateDir = deps.stateDir;
  const logDir = deps.logDir;
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(logDir, { recursive: true });
  const statePath = join(stateDir, "flap-shadow.json");
  const state = loadJson(statePath, { seen: {}, checked: {} });
  if (!state.checked) state.checked = {};
  const checked = state.checked;

  const shadowPath = join(logDir, "shadow.jsonl");
  let entries = [];
  try {
    entries = readFileSync(shadowPath, "utf8").trim().split("\n").filter(Boolean).map((x) => JSON.parse(x));
  } catch { entries = []; }

  for (const e of entries) {
    const m = e.market;
    if (checked[m]) continue;
    if (now - Number(e.at) < Number(cfg.checkAfterMin) * 60000) continue;
    let multiple;
    try {
      const q = parseQuote(deps.call(PORTAL, encQuoteBuy(m, deps.wallet, valueWei)));
      const entryShares = BigInt(e.shares);
      const nowShares = q.shares;
      const scaled = (entryShares * 100n) / nowShares;
      const intPart = scaled / 100n;
      const fracPart = scaled % 100n;
      multiple = `${intPart}.${String(fracPart).padStart(2, "0")}`;
    } catch (err) {
      try {
        const d = parseDetail(deps.call(READER, encDetail(m)));
        multiple = d.phase !== 1 ? "graduated" : "error";
      } catch (e2) {
        multiple = "error";
      }
    }
    appendFileSync(join(logDir, "shadow-check.jsonl"), JSON.stringify({ at: now, market: m, multiple }) + "\n");
    checked[m] = true;
  }

  saveJson(statePath, { seen: state.seen ?? {}, checked });
}

function defaultDeps() {
  const bawBin = process.env.BAW_BIN || "node_modules/.bin/baw";
  const rpc = process.env.FLAP_RPC || "https://bsc-rpc.publicnode.com";
  const logDir = process.env.LOG_DIR || "logs";
  const stateDir = process.env.STATE_DIR || "state";
  const json = (cmd, args) => {
    const r = spawnSync(cmd, args, { encoding: "utf8" });
    try { return JSON.parse(r.stdout); } catch { return { success: false, error: (r.stderr || "").trim() || `exit ${r.status}` }; }
  };
  const baw = (args) => json(bawBin, args);
  const addr = baw(["wallet", "address", "--json"])?.data?.addresses?.find((a) => a.binanceChainId === "56")?.address;
  if (!addr) throw new Error("取不到錢包地址");
  const cfgAll = loadJson(process.env.CONFIG || "config.json", {});
  mkdirSync(logDir, { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  return {
    now: Date.now(),
    stateDir,
    wallet: addr,
    cfg: cfgAll.flap ?? {},
    logDir,
    call: (to, data) => {
      const r = spawnSync("cast", ["call", "--rpc-url", rpc, to, data], { encoding: "utf8" });
      if (r.status !== 0) throw new Error((r.stderr || "").trim() || `exit ${r.status}`);
      return String(r.stdout ?? "").trim();
    },
    blockTs: (n) => {
      const r = spawnSync("cast", ["block", String(n), "--field", "timestamp", "--rpc-url", rpc], { encoding: "utf8" });
      if (r.status !== 0) throw new Error((r.stderr || "").trim() || `exit ${r.status}`);
      return Number(String(r.stdout ?? "").trim());
    },
    preview: (from, to, value, data) => baw(["contract-call", "preview", "--binanceChainId", "56", "--from", from, "--to", to, "--value", value, "--inputData", data, "--json"]),
    log: (m) => appendFileSync(join(logDir, "run.log"), `${new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 19).replace("T", " ")} ${m}\n`),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv[2] === "shadow") {
    const deps = defaultDeps();
    await runShadow(deps);
    await checkShadow(deps);
  }
}