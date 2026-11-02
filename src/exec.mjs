import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { gate } from "../lib/gate.mjs";

const bawBin = process.env.BAW_BIN || "node_modules/.bin/baw";
const configPath = process.env.CONFIG || "config.json";
const stateDir = process.env.STATE_DIR || "state";
const logDir = process.env.LOG_DIR || "logs";

function runBaw(args) {
  const res = spawnSync(bawBin, args, { encoding: "utf8" });
  const out = res.stdout ?? "";
  mkdirSync(logDir, { recursive: true });
  appendFileSync(join(logDir, "exec.jsonl"), out.endsWith("\n") ? out : out + "\n");
  if (res.status !== 0) {
    const err = new Error((res.stderr || "").trim() || `baw exited ${res.status}`);
    err.stdout = out;
    throw err;
  }
  return out;
}

const bnbToWei = (s) => {
  const [i, f = ""] = String(s).split(".");
  return BigInt(i) * 10n ** 18n + BigInt(f.padEnd(18, "0") || "0");
};

// 預留的 gas 用鏈上 receipt 換成實際花費；查不到（未上鏈、RPC 掛）就維持預留，寧可多算
async function reconcileGas(ledger) {
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

function taipeiDate() {
  const t = new Date(Date.now() + 8 * 60 * 60 * 1000);
  const y = t.getUTCFullYear();
  const m = String(t.getUTCMonth() + 1).padStart(2, "0");
  const d = String(t.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function selectorOf(cd) {
  const s = String(cd ?? "").trim().toLowerCase();
  if (s.length >= 10 && s.startsWith("0x")) return s.slice(0, 10);
  return s;
}

function buildCandidates(addr) {
  const w = String(addr).toLowerCase().replace(/^0x/, "").padStart(64, "0");
  const one32 = "0".repeat(63) + "1";
  return [
    "0x1249c58b",
    "0x4e71d92d",
    "0xa0712d68" + one32,
    "0x6a627842" + w,
    "0x40c10f19" + w + one32,
  ];
}

const PREVIEW_FAIL = "preview 失敗或被攔截";

async function main() {
  const candPath = process.argv[2];
  const dryRun = process.argv.includes("--dry-run");
  const cand = JSON.parse(readFileSync(candPath, "utf8"));

  if (cand.kind !== "free") {
    console.log(JSON.stringify({ ok: false, skipped: true }));
    return;
  }

  const addrOut = runBaw(["wallet", "address", "--json"]);
  const addrJson = JSON.parse(addrOut);
  const addr = (addrJson?.data?.addresses ?? []).find(
    (a) => a.binanceChainId === "56" || a.chainName === "BSC"
  ).address;

  const cfgRaw = JSON.parse(readFileSync(configPath, "utf8"));
  const date = taipeiDate();
  const ledgerPath = join(stateDir, `ledger-${date}.json`);
  let ledger = { total: 0, byContract: {} };
  try {
    ledger = JSON.parse(readFileSync(ledgerPath, "utf8"));
  } catch {}
  if (!ledger || typeof ledger !== "object") ledger = { total: 0, byContract: {} };
  if (!ledger.byContract) ledger.byContract = {};
  if (!ledger.gasWei) ledger.gasWei = "0";
  if (!Array.isArray(ledger.pending)) ledger.pending = [];
  if (ledger.pending.length) {
    await reconcileGas(ledger);
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(ledgerPath, JSON.stringify(ledger));
  }

  let gasCfg = {};
  if (cfgRaw.gasBudgetBNB !== undefined || cfgRaw.gasReserveBNB !== undefined) {
    try {
      gasCfg = { gasBudgetWei: bnbToWei(cfgRaw.gasBudgetBNB).toString(), gasReserveWei: bnbToWei(cfgRaw.gasReserveBNB).toString() };
    } catch {
      gasCfg = { gasBudgetWei: "x", gasReserveWei: "x" }; // 格式錯 → gate fail-closed
    }
  }
  const ctx = {
    cfg: {
      dailyMax: cfgRaw.dailyMax,
      perContractDaily: cfgRaw.perContractDaily,
      denylist: cfgRaw.denylist ?? [],
      ...gasCfg,
    },
    ledger,
  };

  const baseCandidates = buildCandidates(addr);

  let targets;
  if (Array.isArray(cand.targets)) {
    targets = cand.targets.map((t) => ({
      to: t.to,
      value: t.value ?? cand.value ?? "0",
      inputData: t.inputData,
    }));
  } else {
    targets = [{ to: cand.to, value: cand.value ?? "0", inputData: cand.inputData }];
  }

  const results = [];
  let firstTxHash = null;
  let firstStatus = null;
  let anyOk = false;

  for (const target of targets) {
    const tryList = [];
    if (target.inputData) tryList.push(target.inputData);
    tryList.push(...baseCandidates);

    let targetResult = { to: target.to, ok: false };
    let succeeded = false;
    let lastReasons = null;
    let passReasons = null;

    for (const cd of tryList) {
      let preview;
      try {
        const previewOut = runBaw([
          "contract-call",
          "preview",
          "--binanceChainId",
          "56",
          "--from",
          addr,
          "--to",
          target.to,
          "--value",
          String(target.value),
          "--inputData",
          cd,
          "--json",
        ]);
        preview = JSON.parse(previewOut);
      } catch (e) {
        try { preview = JSON.parse(e.stdout); } catch { preview = { success: false }; }
      }

      const call = { to: target.to, value: target.value };
      const g = gate(preview, call, ctx);

      if (!g.ok) {
        // 回報以「模擬有過」那組 calldata 的原因為準（真正擋下的是上限之類）；
        // 全都模擬失敗才報失敗原因，且不混入上限原因
        if (preview?.success === true) passReasons ??= g.reasons;
        else lastReasons = [`${PREVIEW_FAIL}：${preview?.error?.message ?? "無回應"}`];
        continue;
      }

      if (dryRun) {
        console.log(JSON.stringify({ ok: true, dryRun: true, requestId: g.requestId }));
        return;
      }

      const sel = selectorOf(cd);
      // 送出前先預扣額度：execute 拋錯／逾時時鏈上可能已送出，不能讓下一輪重送
      ledger.total = (ledger.total ?? 0) + 1;
      const toLow = String(target.to).toLowerCase();
      ledger.byContract[toLow] = (ledger.byContract[toLow] ?? 0) + 1;
      const pend = { txHash: null, reservedWei: ctx.cfg.gasReserveWei ?? "0" };
      ledger.gasWei = (BigInt(ledger.gasWei) + BigInt(pend.reservedWei)).toString();
      ledger.pending.push(pend);
      mkdirSync(stateDir, { recursive: true });
      writeFileSync(ledgerPath, JSON.stringify(ledger));
      try {
        const execOut = runBaw([
          "contract-call",
          "execute",
          "--requestId",
          g.requestId,
          "--json",
        ]);
        const execJson = JSON.parse(execOut);
        const data = execJson?.data ?? execJson;
        const txHash = data?.txHash;
        const execOk = execJson?.success !== false;
        targetResult = { to: target.to, ok: execOk, selector: sel };
        if (txHash) {
          targetResult.txHash = txHash;
          pend.txHash = txHash;
          writeFileSync(ledgerPath, JSON.stringify(ledger));
        }
        if (!execOk) {
          targetResult.reasons = ["execute 失敗"];
        }
        succeeded = true;
        if (execOk) {
          anyOk = true;
          if (!firstTxHash && txHash) firstTxHash = txHash;
          if (!firstStatus && data?.status) firstStatus = data.status;
          if (txHash) {
            mkdirSync(stateDir, { recursive: true });
            appendFileSync(join(stateDir, "free-mints.jsonl"), JSON.stringify({ txHash, at: Date.now() }) + "\n");
          }
        }
      } catch (e) {
        targetResult = { to: target.to, ok: false, selector: sel, reasons: [String(e?.message ?? e)] };
        succeeded = true;
      }
      break;
    }

    if (!succeeded) {
      targetResult.reasons = passReasons ?? lastReasons ?? ["無可用 calldata"];
    }
    results.push(targetResult);
  }

  const out = { ok: anyOk, results };
  if (firstTxHash) out.txHash = firstTxHash;
  if (firstStatus) out.status = firstStatus;
  if (!anyOk && results.length > 0) {
    const last = results[results.length - 1];
    if (last.reasons) out.reasons = last.reasons;
  }
  console.log(JSON.stringify(out));
}

await main();
