import { createServer } from "node:net";
import { readFileSync, writeFileSync, mkdirSync, renameSync, unlinkSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

const object = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const count = (v) => Number.isSafeInteger(v) && v >= 0;
const wei = (v) => typeof v === "string" && /^\d+$/.test(v);

export function readLedger(path) {
  let ledger;
  try {
    ledger = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    if (e.code === "ENOENT") return { total: 0, byContract: {}, gasWei: "0", pending: [] };
    throw e;
  }
  if (!object(ledger) || !count(ledger.total) || !object(ledger.byContract) ||
      !Object.values(ledger.byContract).every(count) ||
      (ledger.gasWei !== undefined && !wei(ledger.gasWei)) ||
      (ledger.pending !== undefined && (!Array.isArray(ledger.pending) || !ledger.pending.every(
        (p) => object(p) && (p.txHash === null || typeof p.txHash === "string") && wei(p.reservedWei))))) {
    throw new TypeError("Invalid ledger fields");
  }
  ledger.gasWei ??= "0";
  ledger.pending ??= [];
  return ledger;
}

export function writeLedger(path, ledger) {
  mkdirSync(dirname(path), { recursive: true });
  const temp = join(dirname(path), `.ledger-${process.pid}-${randomUUID()}.tmp`);
  try {
    writeFileSync(temp, JSON.stringify(ledger), { flag: "wx" });
    renameSync(temp, path);
  } finally {
    try { unlinkSync(temp); } catch (e) { if (e.code !== "ENOENT") throw e; }
  }
}

export function lockPort(stateDir) {
  const n = createHash("sha256").update(realpathSync(stateDir)).digest().readUInt32BE(0);
  return 20000 + n % 40000;
}

// 共用者必須在 callback 內讀帳、對帳、gate、預扣與寫帳。
// port 只由 stateDir 推導：同一本帳必定同一把鎖。取鎖最多等 waitMs，與呼叫者 signal 取先到者。
// ponytail: port 被無關程式占用時取鎖逾時失敗；要換 port 只能換 stateDir 路徑。
export async function withLedgerLock(stateDir, fn, { signal, waitMs = 60_000 } = {}) {
  signal?.throwIfAborted();
  mkdirSync(stateDir, { recursive: true });
  const port = lockPort(stateDir);
  const wait = AbortSignal.any([AbortSignal.timeout(waitMs), ...(signal ? [signal] : [])]);
  let server;
  for (;;) {
    wait.throwIfAborted();
    server = createServer(socket => socket.destroy());
    try {
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen({ host: "127.0.0.1", port, exclusive: true }, resolve);
      });
      server.unref();
      break;
    } catch (e) {
      await new Promise(resolve => server.close(resolve));
      wait.throwIfAborted();
      if (e.code !== "EADDRINUSE") throw e;
      try { await delay(25, undefined, { signal: wait }); }
      catch (error) { wait.throwIfAborted(); throw error; }
    }
  }
  try {
    signal?.throwIfAborted();
    return await fn();
  } finally {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}

// 預留的 gas 用鏈上 receipt 換成實際花費；查不到（未上鏈、RPC 掛）就維持預留，寧可多算
export async function reconcileGas(ledger) {
  const rpc = process.env.BSC_RPC || "https://bsc-dataseed.bnbchain.org";
  const keep = [];
  for (const p of ledger.pending) {
    let r = null;
    if (/^0x[0-9a-f]{64}$/i.test(p.txHash ?? "")) {
      try {
        const res = await fetch(rpc, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getTransactionReceipt", params: [p.txHash] }),
          signal: AbortSignal.timeout(8000),
        });
        r = (await res.json())?.result ?? null;
      } catch {}
    }
    if (r?.gasUsed && r?.effectiveGasPrice) {
      const actual = BigInt(r.gasUsed) * BigInt(r.effectiveGasPrice);
      ledger.gasWei = (BigInt(ledger.gasWei) + actual - BigInt(p.reservedWei)).toString();
    } else if (p.txHash) {
      keep.push(p);
    }
    // 沒 txHash（execute 拋錯）：預留永遠不退
  }
  ledger.pending = keep;
}

