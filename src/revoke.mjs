// 撤授權：approve(spender, 0)／setApprovalForAll(op, false)，preview 過閘才 execute。
// prepare／confirm 走 TG 按鈕，nonce 單次、10 分鐘過期。
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { rpcClient } from "./market-detect.mjs";
import { scan } from "./allowance-scan.mjs";

const APPROVE = "0x095ea7b3";
const SET_APPROVAL_FOR_ALL = "0xa22cb465";
const PENDING_TTL = 10 * 60 * 1000;

const pad = (h) => String(h).replace(/^0x/i, "").toLowerCase().padStart(64, "0");

function isAddr(a) {
  return /^0x[0-9a-f]{40}$/i.test(String(a ?? ""));
}

export function revokeData(kind, spender) {
  return (kind === "all" ? SET_APPROVAL_FOR_ALL : APPROVE) + pad(spender) + pad("0");
}

export function revokeGate(pv) {
  const r = [];
  const d = pv?.success === true ? pv.data : null;
  const sim = d?.simulationResult;
  if (!d?.requestId) r.push("preview 失敗");
  if (sim?.simulationCode !== "000000000") r.push("模擬未通過");
  if (!(Array.isArray(sim?.authorityChanges) && sim.authorityChanges.length === 0)) r.push("有權限變更");
  const bal = Array.isArray(sim?.balanceChanges) ? sim.balanceChanges : [];
  if (!bal.every((x) => Number(x?.change) >= 0)) r.push("資產會減少");
  return { ok: r.length === 0, reasons: r, requestId: r.length ? null : d.requestId };
}

export async function revoke(deps, { kind, token, spender }) {
  if (!isAddr(token)) throw new Error("token 位址不合法");
  if (!isAddr(spender)) throw new Error("spender 位址不合法");
  const pv = await deps.baw([
    "contract-call", "preview",
    "--binanceChainId", "56",
    "--from", deps.wallet,
    "--to", token,
    "--value", "0",
    "--inputData", revokeData(kind, spender),
    "--json",
  ]);
  const g = revokeGate(pv);
  if (!g.ok) return { ok: false, txHash: null, reasons: g.reasons };
  const ex = await deps.baw(["contract-call", "execute", "--requestId", g.requestId, "--json"]);
  if (ex?.success === true) return { ok: true, txHash: ex.data?.txHash ?? null, reasons: [] };
  const reason = ex?.error ? JSON.stringify(ex.error) : "execute 失敗";
  return { ok: false, txHash: ex?.data?.txHash ?? null, reasons: [reason] };
}

export async function prepare(deps) {
  const open = await deps.list();
  const now = deps.now();
  const dir = join(deps.stateDir, "revoke-pending");
  mkdirSync(dir, { recursive: true });
  const items = [];
  for (const o of Array.isArray(open) ? open : []) {
    const nonce = randomBytes(16).toString("hex");
    writeFileSync(
      join(dir, `${nonce}.json`),
      JSON.stringify({ kind: o.kind, token: o.token, spender: o.spender, amount: o.amount, exp: now + PENDING_TTL })
    );
    items.push({ nonce, kind: o.kind, token: o.token, spender: o.spender, amount: o.amount });
  }
  return { ok: true, items };
}

export async function confirm(nonce, deps) {
  if (!/^[0-9a-f]{32}$/.test(String(nonce ?? ""))) return { ok: false, reasons: ["nonce 格式錯"] };
  const path = join(deps.stateDir, "revoke-pending", `${nonce}.json`);
  let data;
  try { data = JSON.parse(readFileSync(path, "utf8")); }
  catch { return { ok: false, reasons: ["invalid pending"] }; }
  try { unlinkSync(path); } catch {}
  if (deps.now() > Number(data.exp)) return { ok: false, reasons: ["已過期"] };
  return revoke(deps, data);
}

const isMain = process.argv[1] != null && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const cmd = process.argv[2];
  (async () => {
    const bawBin = process.env.BAW_BIN || "node_modules/.bin/baw";
    const baw = async (args) => {
      const r = spawnSync(bawBin, args, { encoding: "utf8" });
      if (r.status !== 0) throw new Error((r.stderr || "").trim() || `baw exited ${r.status}`);
      return JSON.parse(String(r.stdout || "").trim());
    };
    const stateDir = process.env.STATE_DIR || "state";
    const wallet = async () => {
      const j = await baw(["wallet", "address", "--json"]);
      const a = (j?.data?.addresses ?? []).find((x) => x.binanceChainId === "56" || x.chainName === "BSC");
      if (!a) throw new Error("no bsc wallet");
      return a.address;
    };
    const list = async () => {
      let state = {};
      try { state = JSON.parse(readFileSync(join(stateDir, "allowance.json"), "utf8")); } catch { state = {}; }
      const pairs = Array.isArray(state.pairs) ? state.pairs : [];
      const owner = await wallet();
      const rpc = rpcClient(process.env.BSC_LOGS_RPC || "https://bsc-rpc.publicnode.com");
      const head = Number(BigInt(await rpc("eth_blockNumber")));
      const res = await scan(rpc, owner, { fromBlock: head + 1, pairs });
      return res.open;
    };
    const deps = { stateDir, now: () => Date.now(), list, baw };
    let out;
    if (cmd === "prepare") out = await prepare(deps);
    else if (cmd === "confirm") {
      deps.wallet = await wallet();
      out = await confirm(process.argv[3], deps);
    } else out = { ok: false, reasons: ["unknown command"] };
    console.log(JSON.stringify(out));
  })().catch((e) => {
    console.log(JSON.stringify({ ok: false, reasons: [String(e?.message ?? e)] }));
  });
}
