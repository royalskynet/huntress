// 訊號模擬線：讀 baw 訊號、虛擬帳進出場，只寫 logs/signal-shadow.jsonl，不碰錢包。
// 每輪：先估已開倉 → 再讀 signal list → 進場前雙向報價 → 寫 entry／reject／exit。
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, appendFileSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { decide, toWei } from "./autotrade.mjs";

const NATIVE = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";

export const SIGNAL_DEFAULTS = {
  version: "v1",
  // 帶 Token Fee 的訊號另記到 <strategyId>@<taxVersion>，與主版本分帳判定；設 null 或 "" 則照舊拒絕（reject tax）
  taxVersion: "v1-tax",
  strategies: [],
  perBNB: "0.002",
  capitalBNB: "0.0419",
  reserveBNB: "0.003",
  maxOpen: 3,
  deadlineH: 72,
  haircutBps: 300,
  gasWei: "50000000000000",
};

// 唯讀白名單：只放行前兩個子命令是 signal list 或 market-order quote 的呼叫。
export function readOnlyBaw(spawnFn) {
  const allowed = new Set(["signal list", "market-order quote"]);
  return (args = []) => {
    const head = args.slice(0, 2).join(" ");
    if (!allowed.has(head)) throw new Error(`baw ${head} not allowed`);
    return spawnFn(args);
  };
}

function quote(deps, fromToken, toToken, qty) {
  try {
    return deps.baw([
      "market-order", "quote",
      "--binanceChainId", "56",
      "--fromTokenQty", String(qty),
      "--fromToken", fromToken,
      "--toToken", toToken,
      "--json",
    ]);
  } catch {
    return null;
  }
}

function amountOf(q, dec = 18) {
  if (q?.success !== true) return null;
  const s = q?.data?.toCoinAmount;
  if (s == null) return null;
  try {
    return { dec: String(s), wei: toWei(String(s), dec) };
  } catch {
    return null;
  }
}

// Flap TaxTokenHelper.getTaxTokenInfoV2(address)；回傳全為靜態欄位，第 5、6 個 word 是 buyTaxRate／sellTaxRate（BPS）
// 文件：https://docs.flap.sh/flap/developers/wallet-and-terminal-and-bot-developers/inspect-a-tax-token.md
export const TAX_HELPER = "0x53841c73217735F37BC1775538b03b23feFD8346";
export function encTaxInfo(token) {
  return `0x6c06b371${String(token).toLowerCase().replace(/^0x/, "").padStart(64, "0")}`;
}
export function parseTaxInfo(hex) {
  const h = String(hex ?? "").trim().replace(/^0x/, "");
  if (!/^[0-9a-fA-F]*$/.test(h) || h.length < 64 * 6) return null;
  return { buyBps: Number(BigInt(`0x${h.slice(256, 320)}`)), sellBps: Number(BigInt(`0x${h.slice(320, 384)}`)) };
}

function hasTokenFee(tag) {
  const t = tag?.["Token Fee"];
  return Array.isArray(t) && t.length > 0;
}

function allowedStrategy(cfg, row) {
  const list = Array.isArray(cfg.strategies) ? cfg.strategies : [];
  return list.length === 0 || list.includes(row?.strategyId);
}

function snapshotParams(cfg, sellCfg) {
  return {
    perBNB: cfg.perBNB,
    capitalBNB: cfg.capitalBNB,
    reserveBNB: cfg.reserveBNB,
    maxOpen: cfg.maxOpen,
    deadlineH: cfg.deadlineH,
    haircutBps: cfg.haircutBps,
    gasWei: cfg.gasWei,
    sellCfg: { ...(sellCfg ?? {}) },
  };
}

function ensureAccount(st, sv, cfg, sellCfg) {
  let a = st.accounts[sv];
  if (!a) {
    a = { cashWei: String(toWei(cfg.capitalBNB)), positions: {}, params: snapshotParams(cfg, sellCfg) };
    st.accounts[sv] = a;
  }
  if (!a.positions) a.positions = {};
  if (!a.params) a.params = snapshotParams(cfg, sellCfg);
  if (a.cashWei == null) a.cashWei = String(toWei(a.params.capitalBNB));
  return a;
}

// 先原子存下待寫事件（st.pending），再 append；中斷後下一輪依 pending 原樣補寫。
// 重複補寫的完全相同事件由判定閘的 dupKey 去重吸收。
function commit(deps, st, evt) {
  st.pending = evt;
  deps.saveState(st);
  deps.append(JSON.stringify(evt));
  delete st.pending;
  deps.saveState(st);
}

function exitReasonOf(why) {
  const s = String(why ?? "");
  if (s.includes("漲到成本")) return "tp";
  if (s.includes("高點回落")) return "trail";
  if (s.includes("跌到成本")) return "sl";
  if (s.includes("持有滿")) return "timeout";
  return "timeout";
}

function finish(deps, st, sv, acct, token, now, estWei, reason) {
  const p = acct.params;
  const pos = acct.positions[token];
  const costWei = BigInt(pos.costWei);
  const gasWei = BigInt(p.gasWei);
  const netWei = estWei - costWei - gasWei;
  acct.cashWei = String(BigInt(acct.cashWei) + estWei - gasWei);
  delete acct.positions[token];
  commit(deps, st, {
    v: 1,
    kind: "exit",
    strategyVersion: sv,
    token,
    entryAt: pos.entryAt,
    at: now,
    costWei: pos.costWei,
    estProceedsWei: String(estWei),
    gasWei: String(gasWei),
    netWei: String(netWei),
    exitReason: reason,
  });
}

function settle(deps, st, sv, acct, token, now) {
  const p = acct.params;
  const pos = acct.positions[token];
  const val = amountOf(quote(deps, pos.token, NATIVE, pos.qty), 18);
  const deadlineMs = Number(p.deadlineH) * 3600 * 1000;
  if (!val) {
    if (now - Number(pos.entryAt) >= deadlineMs) finish(deps, st, sv, acct, token, now, 0n, "noquote");
    return;
  }
  const raw = toWei(pos.qty, pos.decimals ?? 18);
  // baw 報價不含 Flap 代幣稅（2026-11-15 實測 3%/3% 稅往返仍 0.986）：持有量先扣買稅，賣出所得再扣賣稅
  const held = val.wei * (10000n - BigInt(pos.buyTaxBps ?? 0)) / 10000n;
  const [how, why] = decide(pos, held, raw, p.sellCfg ?? {}, now);
  if (how == null) return;
  const estWei = held * (10000n - BigInt(p.haircutBps)) / 10000n * (10000n - BigInt(pos.sellTaxBps ?? 0)) / 10000n;
  finish(deps, st, sv, acct, token, now, estWei, exitReasonOf(why));
}

async function tryEntry(deps, cfg, st, row, now, sellCfg) {
  const tax = hasTokenFee(row?.tokenTag);
  const sv = `${row?.strategyId}@${tax && cfg.taxVersion ? cfg.taxVersion : cfg.version}`;
  const token = String(row?.contractAddress ?? "").toLowerCase();
  const signalId = row?.signalId;
  if (!token || !row?.strategyId) return;
  const reject = (reason) => commit(deps, st, {
    v: 1, kind: "reject", strategyVersion: sv, token, signalId: String(signalId), at: now, reason,
  });
  const acct = ensureAccount(st, sv, cfg, sellCfg);
  const p = acct.params;
  if (acct.positions[token]) return reject("dup");
  if (tax && !cfg.taxVersion) return reject("tax");
  if (Object.keys(acct.positions).length >= Number(p.maxOpen)) return reject("full");
  const perWei = toWei(p.perBNB);
  if (BigInt(acct.cashWei) - perWei < toWei(p.reserveBNB)) return reject("cash");
  const decimals = Number(row.tokenDecimals ?? 18);
  const buy = amountOf(quote(deps, NATIVE, token, p.perBNB), decimals);
  if (!buy) return reject("quotefail");
  const back = amountOf(quote(deps, token, NATIVE, buy.dec), 18);
  if (!back || back.wei < perWei * 50n / 100n) return reject("roundtrip");
  let taxBps = null;
  if (tax) {
    try {
      taxBps = await deps.taxOf(token);
    } catch {
      taxBps = null;
    }
    const ok = (n) => Number.isInteger(n) && n >= 0 && n < 10000;
    if (!ok(taxBps?.buyBps) || !ok(taxBps?.sellBps)) return reject("taxread");
  }
  acct.cashWei = String(BigInt(acct.cashWei) - perWei);
  acct.positions[token] = {
    token,
    signalId: String(signalId),
    costWei: String(perWei),
    qty: buy.dec,
    decimals,
    entryAt: now,
    boughtAt: now,
    kind: "shadow",
    peakPx: null,
    dropHits: 0,
    tierIdx: 0,
    soldHalf: false,
    ...(taxBps ? { buyTaxBps: taxBps.buyBps, sellTaxBps: taxBps.sellBps } : {}),
  };
  commit(deps, st, {
    v: 1,
    kind: "entry",
    strategyVersion: sv,
    token,
    signalId: String(signalId),
    at: now,
    costWei: String(perWei),
    qty: buy.dec,
  });
}

export async function runOnce(deps) {
  const cfg = { ...SIGNAL_DEFAULTS, ...(deps.cfg ?? {}) };
  if (cfg.taxVersion && cfg.taxVersion === cfg.version) throw new Error("signalShadow.taxVersion 不可等於 version");
  const sellCfg = deps.sellCfg ?? {};
  const now = Number(deps.now ?? Date.now());
  const st = deps.loadState() ?? { v: 1, accounts: {} };
  st.v ??= 1;
  st.accounts ??= {};

  if (st.pending) {
    deps.append(JSON.stringify(st.pending));
    delete st.pending;
    deps.saveState(st);
  }

  for (const [sv, acct] of Object.entries(st.accounts)) {
    acct.params ??= snapshotParams(cfg, sellCfg);
    acct.positions ??= {};
    for (const token of Object.keys(acct.positions)) settle(deps, st, sv, acct, token, now);
  }

  let rows;
  try {
    const sig = deps.baw(["signal", "list", "-c", "56", "-s", "meme", "--time-range", "1h", "--json"]);
    if (sig?.success !== true || !Array.isArray(sig?.data)) {
      throw new Error(`success=${sig?.success} ${sig?.error ?? "data 不是陣列"}`);
    }
    rows = sig.data;
  } catch (e) {
    throw new Error(`signal list 讀取失敗：${e?.message ?? e}`);
  }
  for (const row of rows) {
    if (!allowedStrategy(cfg, row)) continue;
    await tryEntry(deps, cfg, st, row, now, sellCfg);
  }

  deps.saveState(st);
}

export function defaultDeps() {
  const bin = process.env.BAW_BIN || "node_modules/.bin/baw";
  const spawn = (args) => {
    const r = spawnSync(bin, args, { encoding: "utf8" });
    if (r?.error) throw new Error(`baw ${args.slice(0, 2).join(" ")} fail ${r.error.code ?? r.error.message}`);
    try {
      return JSON.parse(String(r.stdout ?? ""));
    } catch {
      return { success: false, error: String(r.stderr ?? "").trim() || `exit ${r.status}` };
    }
  };
  const stateDir = process.env.STATE_DIR || "state";
  const logPath = process.env.SIGNAL_SHADOW_LOG || join(process.env.LOG_DIR || "logs", "signal-shadow.jsonl");
  const stPath = join(stateDir, "signal-shadow.json");
  let cfgAll = {};
  try {
    cfgAll = JSON.parse(readFileSync(process.env.CONFIG || "config.json", "utf8"));
  } catch (e) {
    if (e?.code !== "ENOENT") throw e;
  }
  return {
    now: Date.now(),
    cfg: cfgAll.signalShadow ?? {},
    sellCfg: cfgAll.autotrade?.sell ?? {},
    baw: readOnlyBaw(spawn),
    taxOf: (token) => {
      const rpc = process.env.FLAP_RPC || "https://bsc-rpc.publicnode.com";
      const r = spawnSync("cast", ["call", "--rpc-url", rpc, TAX_HELPER, encTaxInfo(token)], { encoding: "utf8" });
      if (r.status !== 0) throw new Error(`cast status=${r.status} ${(r.stderr || "").trim()}`);
      return parseTaxInfo(r.stdout);
    },
    append: (line) => {
      mkdirSync(dirname(logPath), { recursive: true });
      appendFileSync(logPath, `${line}\n`);
    },
    loadState: () => {
      try {
        return JSON.parse(readFileSync(stPath, "utf8"));
      } catch (e) {
        if (e?.code === "ENOENT") return { v: 1, accounts: {} };
        throw e;
      }
    },
    saveState: (st) => {
      mkdirSync(stateDir, { recursive: true });
      writeFileSync(`${stPath}.tmp`, JSON.stringify(st, null, 2));
      renameSync(`${stPath}.tmp`, stPath);
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runOnce(defaultDeps()).catch((e) => {
    process.stderr.write(`${e?.stack || e}\n`);
    process.exit(1);
  });
}
