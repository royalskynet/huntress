import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { rpcClient } from "./market-detect.mjs";

const APPROVAL = "0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925";
const APPROVAL_ALL = "0x17307eab39ab6107e8899845ad3d59bd9653f200f220920489ca2b5937696c31";
const ALLOWANCE = "0xdd62ed3e";
const IS_APPROVED_FOR_ALL = "0xe985e9c5";
const SEGMENT = 50000;
const INFINITE = 2n ** 255n;

function pad(v) {
  return String(v).replace(/^0x/i, "").toLowerCase().padStart(64, "0");
}

function addrOf(word) {
  return "0x" + String(word).replace(/^0x/i, "").toLowerCase().slice(-40);
}

// addresses：只查這些合約發的事件（publicnode 不帶 address 會拒、一次最多 10 個）；不給就不過濾
export async function scan(rpc, owner, { fromBlock, pairs, addresses } = {}) {
  const ownerTopic = "0x" + pad(owner);
  const headHex = await rpc("eth_blockNumber");
  const head = Number(BigInt(headHex));

  const seen = new Map();
  const add = (kind, token, spender) => {
    if (!token || !spender) return;
    const t = String(token).toLowerCase();
    const s = String(spender).toLowerCase();
    const k = kind === "all" ? "all" : "erc20";
    seen.set(`${k}:${t}:${s}`, { kind: k, token: t, spender: s });
  };
  for (const p of Array.isArray(pairs) ? pairs : []) add(p?.kind, p?.token, p?.spender);

  const groups = [];
  if (Array.isArray(addresses)) { for (let i = 0; i < addresses.length; i += 10) groups.push({ address: addresses.slice(i, i + 10) }); }
  else groups.push({});
  let logsError = false;
  const start = Number(BigInt(fromBlock ?? 0));
  let cur = start;
  while (cur <= head) {
    const to = Math.min(head, cur + SEGMENT - 1);
    const range = { fromBlock: "0x" + cur.toString(16), toBlock: "0x" + to.toString(16) };
    try {
      for (const g of groups) {
      const erc20 = await rpc("eth_getLogs", [{ ...range, ...g, topics: [APPROVAL, ownerTopic] }]);
      for (const lg of Array.isArray(erc20) ? erc20 : []) {
        const topics = Array.isArray(lg?.topics) ? lg.topics : [];
        if (topics.length !== 3) continue;
        if (String(topics[0]).toLowerCase() !== APPROVAL) continue;
        add("erc20", lg.address, addrOf(topics[2]));
      }
      const all = await rpc("eth_getLogs", [{ ...range, ...g, topics: [APPROVAL_ALL, ownerTopic] }]);
      for (const lg of Array.isArray(all) ? all : []) {
        const topics = Array.isArray(lg?.topics) ? lg.topics : [];
        if (topics.length < 3) continue;
        if (String(topics[0]).toLowerCase() !== APPROVAL_ALL) continue;
        add("all", lg.address, addrOf(topics[2]));
      }
      }
    } catch {
      logsError = true;
      break;
    }
    cur = to + 1;
  }

  const allPairs = [...seen.values()];
  const open = [];
  for (const p of allPairs) {
    const data = (p.kind === "all" ? IS_APPROVED_FOR_ALL : ALLOWANCE) + pad(owner) + pad(p.spender);
    let raw = null;
    try { raw = await rpc("eth_call", [{ to: p.token, data }, "latest"]); } catch { raw = null; }
    let amount;
    try { amount = BigInt(raw); } catch { continue; }
    if (amount === 0n) continue;
    open.push({ kind: p.kind, token: p.token, spender: p.spender, amount: amount.toString() });
  }

  return { pairs: allPairs, open, toBlock: head, logsError };
}

export function formatOpen(open) {
  const arr = Array.isArray(open) ? open : [];
  if (arr.length === 0) return "";
  const lines = [`🔓 Agent 錢包有 ${arr.length} 筆未撤授權`];
  for (const o of arr) {
    let amount;
    if (o.kind === "all") amount = "全部 NFT";
    else {
      let v = 0n;
      try { v = BigInt(o.amount); } catch { v = 0n; }
      amount = v >= INFINITE ? "無限" : String(o.amount);
    }
    lines.push(`${o.token} → ${o.spender} ${amount}`);
  }
  lines.push("回 /revoke 一鍵撤，或到幣安 App 撤銷");
  return lines.join("\n");
}

function walletAddress(baw) {
  return (async () => {
    const j = await baw(["wallet", "address", "--json"]);
    const addr = (j?.data?.addresses ?? []).find((a) => a.binanceChainId === "56" || a.chainName === "BSC");
    if (!addr) throw new Error("no bsc wallet");
    return addr.address;
  })();
}

export function candidates(stateDir) {
  const set = new Set();
  const ok = (a) => /^0x[0-9a-f]{40}$/.test(String(a ?? "").toLowerCase()) && set.add(String(a).toLowerCase());
  const read = (f) => { try { return JSON.parse(readFileSync(join(stateDir, f), "utf8")); } catch { return null; } };
  let files = [];
  try { files = readdirSync(stateDir); } catch {}
  for (const f of files) if (/^buy-.*\.json$/.test(f)) Object.keys(read(f)?.byContract ?? {}).forEach(ok);
  const pos = read("positions.json");
  Object.keys(pos?.positions ?? {}).forEach(ok);
  for (const c of pos?.closed ?? []) ok(c?.token);
  let mk = [];
  try { mk = readdirSync(join(stateDir, "markets")); } catch {}
  for (const f of mk) for (const n of read(join("markets", f))?.nfts ?? []) ok(n);
  return [...set].sort();
}

async function daily() {
  const stateDir = process.env.STATE_DIR || "state";
  const statePath = join(stateDir, "allowance.json");
  let state = {};
  try {
    const parsed = JSON.parse(readFileSync(statePath, "utf8"));
    if (parsed && typeof parsed === "object") state = parsed;
  } catch { state = {}; }

  const now = Date.now();
  if (state.lastRun && now - Number(state.lastRun) < 20 * 3600 * 1000) {
    console.log(JSON.stringify({ ok: true, skipped: "recent" }));
    return;
  }

  const rpc = rpcClient(process.env.BSC_LOGS_RPC || "https://bsc-rpc.publicnode.com");
  const bawBin = process.env.BAW_BIN || "node_modules/.bin/baw";
  const baw = async (args) => {
    const r = spawnSync(bawBin, args, { encoding: "utf8" });
    if (r.status !== 0) throw new Error((r.stderr || "").trim() || `baw exited ${r.status}`);
    return JSON.parse(String(r.stdout || "").trim());
  };

  let owner;
  try { owner = await walletAddress(baw); }
  catch (e) {
    console.log(JSON.stringify({ ok: false, reasons: [String(e?.message ?? e)] }));
    return;
  }

  let head;
  try { head = Number(BigInt(await rpc("eth_blockNumber"))); }
  catch (e) {
    console.log(JSON.stringify({ ok: false, reasons: [String(e?.message ?? e)] }));
    return;
  }

  const prevPairs = Array.isArray(state.pairs) ? state.pairs : [];
  const prevBlock = Number.isFinite(Number(state.lastBlock)) ? Number(state.lastBlock) : null;
  let fromBlock = prevBlock != null ? prevBlock + 1 : head - 192000;
  fromBlock = Math.max(fromBlock, head - 384000);
  if (fromBlock < 0) fromBlock = 0;

  // ponytail: 只掃本 bot 碰過的合約（autotrade 買過的幣、sell 碰過的 NFT）；mint 經 gate 擋掉授權變更所以不收。App 手動授權掃不到，要全掃得換付費節點或 BscScan API
  const addresses = candidates(stateDir);
  let res;
  try { res = await scan(rpc, owner, { fromBlock, pairs: prevPairs, addresses }); }
  catch (e) {
    console.log(JSON.stringify({ ok: false, reasons: [String(e?.message ?? e)] }));
    return;
  }

  const next = {
    lastRun: now,
    lastBlock: res.logsError ? (prevBlock ?? null) : res.toBlock,
    pairs: res.pairs,
  };
  try {
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(statePath, JSON.stringify(next));
  } catch {}

  const text = formatOpen(res.open);
  const out = { ok: true, candidates: addresses.length, open: res.open.length, toBlock: res.toBlock, logsError: res.logsError };
  if (text) out.text = text;
  console.log(JSON.stringify(out));
}

const isMain = process.argv[1] != null && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const cmd = process.argv[2];
  (async () => {
    if (cmd === "daily") await daily();
    else console.log(JSON.stringify({ ok: false, reasons: ["unknown command"] }));
  })().catch((e) => {
    console.log(JSON.stringify({ ok: false, reasons: [String(e?.message ?? e)] }));
  });
}
