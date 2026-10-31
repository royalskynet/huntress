import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, renameSync, appendFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { gate } from "../lib/gate.mjs";

const PER_TX_MAX_WEI = 5000000000000000n;
const DAILY_MAX_WEI = 15000000000000000n;
const DAILY_COUNT = 3;

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
    throw new Error((res.stderr || "").trim() || `baw exited ${res.status}`);
  }
  return out;
}

function taipeiDate() {
  const t = new Date(Date.now() + 8 * 60 * 60 * 1000);
  const y = t.getUTCFullYear();
  const m = String(t.getUTCMonth() + 1).padStart(2, "0");
  const d = String(t.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function loadConfig() {
  try {
    return JSON.parse(readFileSync(configPath, "utf8"));
  } catch {
    return {};
  }
}

function ledgerPath(date) {
  return join(stateDir, `buy-${date}.json`);
}

function loadLedger(date) {
  try {
    const l = JSON.parse(readFileSync(ledgerPath(date), "utf8"));
    if (!l || typeof l !== "object") return { total: 0, byContract: {}, spentWei: "0" };
    if (!l.byContract) l.byContract = {};
    if (l.total === undefined) l.total = 0;
    if (l.spentWei === undefined) l.spentWei = "0";
    return l;
  } catch {
    return { total: 0, byContract: {}, spentWei: "0" };
  }
}

function saveLedger(date, ledger) {
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(ledgerPath(date), JSON.stringify(ledger));
}

function walletAddress() {
  const out = runBaw(["wallet", "address", "--json"]);
  const j = JSON.parse(out);
  return (j?.data?.addresses ?? []).find(
    (a) => a.binanceChainId === "56" || a.chainName === "BSC"
  ).address;
}

function print(obj) {
  console.log(JSON.stringify(obj));
}

async function main() {
  const cmd = process.argv[2];
  if (cmd === "prepare") {
    const candPath = process.argv[3];
    const valueWei = process.argv[4];
    const cand = JSON.parse(readFileSync(candPath, "utf8"));
    const target = Array.isArray(cand?.targets) ? cand.targets[0] : cand;
    const to = target?.to;
    const inputData = target?.inputData;
    if (!inputData) {
      print({ ok: false, reasons: ["缺 inputData"] });
      return;
    }
    const pendingDir = join(stateDir, "pending");
    mkdirSync(pendingDir, { recursive: true });
    // 只數還能確認的單（未用、未過期）；已執行筆數看帳本，跟 confirm 同一把尺
    let pendingCount = 0;
    try {
      pendingCount = readdirSync(pendingDir)
        .filter((f) => /^[0-9a-f]{32}\.json$/.test(f))
        .filter((f) => {
          try { return Date.now() - (JSON.parse(readFileSync(join(pendingDir, f), "utf8")).createdAt ?? 0) <= 10 * 60 * 1000; }
          catch { return true; }
        }).length;
    } catch {}
    if ((loadLedger(taipeiDate()).total ?? 0) + pendingCount >= DAILY_COUNT) {
      print({ ok: false, reasons: ["已達每日執行上限"] });
      return;
    }
    const addr = walletAddress();
    const previewOut = (() => {
      try {
        return runBaw([
          "contract-call",
          "preview",
          "--binanceChainId",
          "56",
          "--from",
          addr,
          "--to",
          to,
          "--value",
          String(valueWei),
          "--inputData",
          inputData,
          "--json",
        ]);
      } catch (e) {
        return null;
      }
    })();
    let preview = { success: false };
    if (previewOut) {
      try { preview = JSON.parse(previewOut); } catch { preview = { success: false }; }
    }
    const cfgRaw = loadConfig();
    const date = taipeiDate();
    const ledger = loadLedger(date);
    const ctx = {
      cfg: {
        dailyMax: DAILY_COUNT,
        perContractDaily: DAILY_COUNT,
        denylist: cfgRaw.denylist ?? [],
      },
      ledger,
    };
    const g = gate(preview, { to, value: valueWei }, ctx, { maxValueWei: String(PER_TX_MAX_WEI) });
    const reasons = [...(g.reasons ?? [])];
    let ok = g.ok;
    if (ok) {
      try {
        if (BigInt(ledger.spentWei ?? "0") + BigInt(valueWei) > DAILY_MAX_WEI) {
          ok = false;
          reasons.push("超過每日金額上限");
        }
      } catch {
        ok = false;
        reasons.push("value 格式錯");
      }
    }
    if (!ok) {
      print({ ok: false, reasons });
      return;
    }
    const nonce = randomBytes(16).toString("hex");
    mkdirSync(join(stateDir, "pending"), { recursive: true });
    writeFileSync(
      join(stateDir, "pending", `${nonce}.json`),
      JSON.stringify({ requestId: g.requestId, to, value: String(valueWei), createdAt: Date.now() })
    );
    print({ ok: true, nonce, to, value: String(valueWei) });
  } else if (cmd === "confirm") {
    const nonce = process.argv[3];
    if (!/^[0-9a-f]{32}$/.test(nonce)) {
      print({ ok: false, reasons: ["nonce 格式錯"] });
      return;
    }
    const pendingPath = join(stateDir, "pending", `${nonce}.json`);
    const usedPath = join(stateDir, "pending", `used-${nonce}.json`);
    try {
      renameSync(pendingPath, usedPath);
    } catch {
      print({ ok: false, reasons: ["invalid or used"] });
      return;
    }
    let data;
    try {
      data = JSON.parse(readFileSync(usedPath, "utf8"));
    } catch {
      print({ ok: false, reasons: ["invalid pending"] });
      return;
    }
    if (Date.now() - (data.createdAt ?? 0) > 10 * 60 * 1000) {
      print({ ok: false, reasons: ["expired"] });
      return;
    }
    const to = data.to;
    const value = String(data.value);
    const date = taipeiDate();
    const ledger = loadLedger(date);
    const cfgRaw = loadConfig();
    const ctx = {
      cfg: { dailyMax: DAILY_COUNT, perContractDaily: DAILY_COUNT, denylist: cfgRaw.denylist ?? [] },
      ledger,
    };
    const reasons = [];
    if ((ledger.total ?? 0) >= DAILY_COUNT) reasons.push("已達每日執行上限");
    const toLow = String(to).toLowerCase();
    if ((ledger.byContract?.[toLow] ?? 0) >= DAILY_COUNT) reasons.push("此合約今日已達上限");
    try {
      if (BigInt(ledger.spentWei ?? "0") + BigInt(value) > DAILY_MAX_WEI) reasons.push("超過每日金額上限");
    } catch {
      reasons.push("value 格式錯");
    }
    // also denylist
    if ((cfgRaw.denylist ?? []).map((a) => a.toLowerCase()).includes(toLow)) reasons.push("合約在 denylist");
    if (reasons.length > 0) {
      print({ ok: false, reasons });
      return;
    }
    // pre-deduct
    ledger.total = (ledger.total ?? 0) + 1;
    ledger.byContract[toLow] = (ledger.byContract[toLow] ?? 0) + 1;
    ledger.spentWei = String(BigInt(ledger.spentWei ?? "0") + BigInt(value));
    saveLedger(date, ledger);
    try {
      const execOut = runBaw([
        "contract-call",
        "execute",
        "--requestId",
        data.requestId,
        "--json",
      ]);
      const execJson = JSON.parse(execOut);
      const d = execJson?.data ?? execJson;
      const txHash = d?.txHash;
      const execOk = execJson?.success !== false;
      if (!execOk) {
        print({ ok: false, reasons: ["execute 失敗"] });
        return;
      }
      print({ ok: true, txHash });
    } catch (e) {
      print({ ok: false, reasons: [String(e?.message ?? e)] });
    }
  } else if (cmd === "cancel") {
    const nonce = process.argv[3];
    if (!/^[0-9a-f]{32}$/.test(nonce)) {
      print({ ok: false, reasons: ["nonce 格式錯"] });
      return;
    }
    const pendingPath = join(stateDir, "pending", `${nonce}.json`);
    const usedPath = join(stateDir, "pending", `used-${nonce}.json`);
    try {
      renameSync(pendingPath, usedPath);
    } catch {
      print({ ok: false, reasons: ["invalid or used"] });
      return;
    }
    print({ ok: true });
  } else {
    print({ ok: false, reasons: ["unknown command"] });
  }
}

main().catch((e) => {
  print({ ok: false, reasons: [String(e?.message ?? e)] });
});
