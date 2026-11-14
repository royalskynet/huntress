#!/usr/bin/env node
// 訊號模擬線的判定閘：讀 logs/signal-shadow.jsonl，按 strategyVersion 逐一判定。
// ponytail: 門檻與算式照計畫 §2；ledger 用單一 JSON 檔，不另做鎖檔。
// 門檻 v2：每版本 α 預算 0.05/maxVersions 以 Bonferroni 拆給三次檢視（n≥30／60／100），
// 任一次過即鎖定通過；三次都沒過才鎖定不過。預設 maxVersions=5 時最後一次與 v1 門檻完全相同。
import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from "node:fs";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";

const DAY_MS = 86400000;
const TAIPEI_OFFSET_MS = 8 * 3600 * 1000;
const CAPITAL_WEI = 41900000000000000n;
const DEADLINE_MS = 72 * 3600 * 1000;
const BOOT_N = 2000;
const DEFAULT_MAX_VERSIONS = 5;
const GATE = 2;
// 早看只拿小份 α（O'Brien–Fleming 精神：早期證據要更強），三份加總 = 1。
// 去頂固定 3 筆不按比例縮：迷因幣報酬是彩券分布，小樣本更怕一兩筆暴賺撐平均。
const LOOKS = [
  { n: 30, days: 7, tokens: 18, trim: 3, share: 0.2 },
  { n: 60, days: 10, tokens: 36, trim: 3, share: 0.3 },
  { n: 100, days: 14, tokens: 60, trim: 3, share: 0.5 },
];
const AMOUNT_RE = /^-?\d+$/;
const QTY_RE = /^\d+(\.\d+)?$/;
const KINDS = new Set(["entry", "exit", "reject"]);

const REQUIRED = {
  entry: ["strategyVersion", "token", "signalId", "at", "costWei", "qty"],
  exit: ["strategyVersion", "token", "entryAt", "at", "costWei", "estProceedsWei", "gasWei", "netWei", "exitReason"],
  reject: ["strategyVersion", "token", "signalId", "at", "reason"],
};

const AMOUNTS = {
  entry: ["costWei"],
  exit: ["costWei", "estProceedsWei", "gasWei", "netWei"],
  reject: [],
};

const TIMES = {
  entry: ["at"],
  exit: ["entryAt", "at"],
  reject: ["at"],
};

function failLine(line, why) {
  throw new Error(`第 ${line} 行：${why}`);
}

function isText(v) {
  return typeof v === "string" && v.length > 0;
}

function stable(v) {
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  if (v !== null && typeof v === "object") {
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stable(v[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v);
}

function validate(row, line) {
  if (row === null || typeof row !== "object" || Array.isArray(row)) failLine(line, "不是 JSON 物件");
  if (row.v !== 1) failLine(line, "v 必須是 1");
  if (!KINDS.has(row.kind)) failLine(line, `未知 kind ${JSON.stringify(row.kind)}`);
  const kind = row.kind;
  for (const f of REQUIRED[kind]) {
    if (!(f in row) || row[f] === null || row[f] === "") failLine(line, `缺欄位 ${f}`);
  }
  for (const f of ["strategyVersion", "token", ...(kind === "entry" ? ["signalId", "qty"] : []), ...(kind === "reject" ? ["signalId", "reason"] : []), ...(kind === "exit" ? ["exitReason"] : [])]) {
    if (!isText(row[f])) failLine(line, `${f} 必須是非空字串`);
  }
  for (const f of TIMES[kind]) {
    if (typeof row[f] !== "number" || !Number.isFinite(row[f])) failLine(line, `${f} 必須是數字`);
  }
  for (const f of AMOUNTS[kind]) {
    if (typeof row[f] !== "string" || !AMOUNT_RE.test(row[f])) failLine(line, `${f} 必須是整數字串`);
  }
  if (kind === "entry" && !QTY_RE.test(row.qty)) failLine(line, "qty 必須是十進位字串");

  if (kind === "entry" || kind === "exit") {
    const cost = BigInt(row.costWei);
    if (cost <= 0n) failLine(line, "costWei 必須大於 0");
  }
  if (kind === "exit") {
    const cost = BigInt(row.costWei);
    const est = BigInt(row.estProceedsWei);
    const gas = BigInt(row.gasWei);
    const net = BigInt(row.netWei);
    if (est < 0n) failLine(line, "estProceedsWei 不得為負");
    if (gas < 0n) failLine(line, "gasWei 不得為負");
    if (net !== est - cost - gas) failLine(line, "netWei 不等於 estProceedsWei − costWei − gasWei");
  }
}

function dupKey(row) {
  if (row.kind === "reject") {
    return `${row.kind}|${row.strategyVersion}|${row.token}|${row.at}|${row.signalId}|${row.reason}`;
  }
  if (row.kind === "exit") {
    return `${row.kind}|${row.strategyVersion}|${row.token}|${row.at}|${row.entryAt}`;
  }
  return `${row.kind}|${row.strategyVersion}|${row.token}|${row.at}`;
}

export function parseRows(text) {
  const rows = [];
  const lineOf = new Map();
  const seen = new Map();
  const lines = String(text).split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === "") continue;
    let row;
    try {
      row = JSON.parse(lines[i]);
    } catch {
      failLine(i + 1, "JSON 解析失敗");
    }
    validate(row, i + 1);
    const key = dupKey(row);
    const prev = seen.get(key);
    if (prev) {
      if (stable(prev.row) === stable(row)) continue;
      failLine(i + 1, `重複鍵但內容不同（首次於第 ${prev.line} 行）`);
    }
    seen.set(key, { row, line: i + 1 });
    lineOf.set(row, i + 1);
    rows.push(row);
  }

  const entries = new Map();
  for (const row of rows) {
    if (row.kind !== "entry") continue;
    entries.set(`${row.strategyVersion}|${row.token}|${row.at}`, {
      row,
      used: false,
      line: lineOf.get(row),
    });
  }
  for (const row of rows) {
    if (row.kind !== "exit") continue;
    const line = lineOf.get(row);
    const key = `${row.strategyVersion}|${row.token}|${row.entryAt}`;
    const entry = entries.get(key);
    if (!entry) failLine(line, "exit 找不到對應 entry");
    if (BigInt(entry.row.costWei) !== BigInt(row.costWei)) failLine(line, "exit 的 costWei 與 entry 不符");
    if (row.at < row.entryAt) failLine(line, "exit.at 早於 entryAt");
    if (entry.used) failLine(line, "同一 entry 有多筆 exit");
    entry.used = true;
  }
  return rows;
}

function avg(xs) {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

function trimMean(xs, drop) {
  if (xs.length <= drop) return 0;
  const sorted = [...xs].sort((a, b) => b - a);
  return avg(sorted.slice(drop));
}

function mulberry32(seed) {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function taipeiDay(at) {
  return Math.floor((at + TAIPEI_OFFSET_MS) / DAY_MS);
}

export function lowerIndex(alpha, n) {
  return Math.max(0, Math.ceil(alpha * n) - 1);
}

// 以台北日期分組，整天有放回重抽；回傳單尾下界。
function bootstrapLower(exits, alpha) {
  if (!exits.length) return 0;
  const byDay = new Map();
  for (const r of exits) {
    const d = taipeiDay(r.at);
    const ret = Number(r.netWei) / Number(r.costWei);
    if (!byDay.has(d)) byDay.set(d, []);
    byDay.get(d).push(ret);
  }
  const groups = [...byDay.values()];
  const rng = mulberry32(42);
  const means = [];
  for (let iter = 0; iter < BOOT_N; iter++) {
    let sum = 0;
    let cnt = 0;
    for (let j = 0; j < groups.length; j++) {
      const g = groups[Math.floor(rng() * groups.length)];
      for (const x of g) {
        sum += x;
        cnt++;
      }
    }
    means.push(cnt ? sum / cnt : 0);
  }
  means.sort((a, b) => a - b);
  const idx = Math.min(means.length - 1, lowerIndex(alpha, means.length));
  return means[idx];
}

// MDD < 0.30 等同於每一步 10*equity > 7*peak；用 BigInt 比，避免浮點剛好 30% 判錯。
function maxDrawdown(exits) {
  let equity = CAPITAL_WEI;
  let peak = CAPITAL_WEI;
  let worst = 0;
  let ok = true;
  for (const r of exits) {
    equity += BigInt(r.netWei);
    if (equity > peak) peak = equity;
    if (10n * equity <= 7n * peak) ok = false;
    if (peak > 0n) {
      const d = Number(peak - equity) / Number(peak);
      if (d > worst) worst = d;
    }
  }
  return { value: worst, ok };
}

function cohortComplete(entries, exits, now) {
  const paired = new Set(exits.map((x) => `${x.token}|${x.entryAt}`));
  let ok = true;
  for (const e of entries) {
    if (paired.has(`${e.token}|${e.at}`)) continue;
    if (now - e.at >= DEADLINE_MS) ok = false;
  }
  return ok;
}

function num(v) {
  return Number.isFinite(v) ? v : 0;
}

function statsFor(exits, entries, now, alpha, trim = 3) {
  const tokens = new Set(exits.map((r) => r.token)).size;
  const n = exits.length;
  const firstEntry = entries.length ? Math.min(...entries.map((r) => r.at)) : null;
  const lastExit = n ? Math.max(...exits.map((r) => r.at)) : null;
  const days = firstEntry != null && lastExit != null ? (lastExit - firstEntry) / DAY_MS : 0;
  const returns = exits.map((r) => Number(r.netWei) / Number(r.costWei));
  const mdd = maxDrawdown(exits);
  return {
    n,
    tokens,
    days,
    mean: num(avg(returns)),
    lb: num(bootstrapLower(exits, alpha)),
    meanTrim: num(trimMean(returns, trim)),
    mdd: num(mdd.value),
    mddOk: mdd.ok,
    cohortOk: cohortComplete(entries, exits, now),
    reasons: [],
  };
}

function findPrefix(exits, entries, look) {
  for (let i = look.n - 1; i < exits.length; i++) {
    const end = exits[i].at;
    const prefixEntries = entries.filter((e) => e.at <= end);
    if (!prefixEntries.length) continue;
    if ((end - prefixEntries[0].at) / DAY_MS >= look.days) {
      return { exits: exits.slice(0, i + 1), entries: prefixEntries, now: end };
    }
  }
  return null;
}

function judgeLook(chosen, look, alpha) {
  const stat = statsFor(chosen.exits, chosen.entries, chosen.now, alpha, look.trim);
  const result = {
    look: look.n,
    alpha,
    n: stat.n,
    tokens: stat.tokens,
    days: stat.days,
    mean: stat.mean,
    lb: stat.lb,
    meanTrim: stat.meanTrim,
    trim: look.trim,
    mdd: stat.mdd,
    reasons: [],
  };
  if (stat.tokens < look.tokens) result.reasons.push(`不同 token 數 ${stat.tokens} < ${look.tokens}`);
  if (!(stat.mean > 0)) result.reasons.push("平均淨報酬 ≤ 0");
  if (!(stat.lb > 0)) result.reasons.push("bootstrap 下界 ≤ 0");
  if (!(stat.meanTrim > 0)) result.reasons.push(`去掉最高 ${look.trim} 筆平均 ≤ 0`);
  if (!stat.mddOk) result.reasons.push("MDD ≥ 30%");
  if (!stat.cohortOk) result.reasons.push("cohort 不完整");
  return result;
}

export function evaluate(rows, { now = Date.now(), ledger = {}, maxVersions = DEFAULT_MAX_VERSIONS } = {}) {
  if (!Number.isInteger(maxVersions) || maxVersions < 1) throw new Error("maxVersions 必須是正整數");
  const versions = [...new Set(rows.map((r) => r.strategyVersion).filter(isText))];
  if (versions.length > maxVersions) {
    throw new Error(`檔內版本數 ${versions.length} 超過 maxVersions ${maxVersions}`);
  }
  const alpha = 0.05 / maxVersions;
  const results = {};
  const pass = [];
  const nextLedger = { ...ledger };

  for (const sv of versions) {
    const prev = nextLedger[sv];
    if (prev) {
      if (prev.gate !== GATE) {
        throw new Error(`${sv} 的 ledger gate=${prev.gate ?? "缺"} 與本版門檻 ${GATE} 不一致，拒絕沿用舊結果`);
      }
      if (prev.maxVersions !== maxVersions) {
        throw new Error(
          `${sv} 的 ledger maxVersions=${prev.maxVersions ?? "缺"} 與本次 ${maxVersions} 不一致，拒絕沿用舊結果`,
        );
      }
      if (prev.pass !== null) {
        results[sv] = prev.result;
        if (prev.pass) pass.push(sv);
        continue;
      }
    }

    const entries = rows
      .filter((r) => r.strategyVersion === sv && r.kind === "entry")
      .sort((a, b) => a.at - b.at);
    const exits = rows
      .filter((r) => r.strategyVersion === sv && r.kind === "exit")
      .sort((a, b) => a.at - b.at);

    // 每次檢視只在首次達標的前綴判一次，判過寫進 ledger，之後不重判。
    const rec = prev ? { ...prev, looks: [...prev.looks] } : { gate: GATE, maxVersions, pass: null, looks: [], result: null };
    let last = rec.looks.length ? rec.looks[rec.looks.length - 1] : null;
    for (let k = rec.looks.length; k < LOOKS.length; k++) {
      const chosen = findPrefix(exits, entries, LOOKS[k]);
      if (!chosen) break;
      last = judgeLook(chosen, LOOKS[k], alpha * LOOKS[k].share);
      rec.looks.push(last);
      if (last.reasons.length === 0) {
        rec.pass = true;
        break;
      }
      if (k === LOOKS.length - 1) rec.pass = false;
    }

    if (rec.looks.length === 0) {
      const full = statsFor(exits, entries, now, alpha * LOOKS[0].share, LOOKS[0].trim);
      results[sv] = {
        n: full.n,
        tokens: full.tokens,
        days: full.days,
        mean: full.mean,
        lb: full.lb,
        meanTrim: full.meanTrim,
        mdd: full.mdd,
        reasons: ["樣本不足"],
      };
      continue;
    }

    rec.result = last;
    rec.lockedAt = now;
    nextLedger[sv] = rec;
    results[sv] = rec.pass === null ? { ...last, reasons: [...last.reasons, `待第 ${rec.looks.length + 1} 次檢視`] } : last;
    if (rec.pass) pass.push(sv);
  }

  return { pass, results, ledger: nextLedger, alpha, looks: LOOKS.map((l) => ({ ...l, alpha: alpha * l.share })) };
}

function loadLedger(path) {
  if (!existsSync(path)) return {};
  const parsed = JSON.parse(readFileSync(path, "utf8"));
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("ledger 不是物件");
  return parsed;
}

function configMaxVersions() {
  let cfg;
  try {
    cfg = JSON.parse(readFileSync("config.json", "utf8"));
  } catch (e) {
    if (e?.code === "ENOENT") return DEFAULT_MAX_VERSIONS;
    throw e;
  }
  const v = cfg?.signalShadow?.maxVersions;
  if (v === undefined) return DEFAULT_MAX_VERSIONS;
  if (!Number.isInteger(v) || v < 1) throw new Error("signalShadow.maxVersions 必須是正整數");
  return v;
}

function parseArgs(argv) {
  const opt = { file: "logs/signal-shadow.jsonl", ledger: "state/verdict-ledger.json", now: Date.now(), maxVersions: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--file" || a === "--ledger" || a === "--now" || a === "--max-versions") {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} 缺值`);
      if (a === "--now") {
        if (!/^-?\d+$/.test(v)) throw new Error("--now 必須是毫秒整數");
        opt.now = Number(v);
      } else if (a === "--max-versions") {
        if (!/^\d+$/.test(v) || Number(v) < 1) throw new Error("--max-versions 必須是正整數");
        opt.maxVersions = Number(v);
      } else {
        opt[a.slice(2)] = v;
      }
    } else {
      throw new Error(`未知參數 ${a}`);
    }
  }
  return opt;
}

function writeLedger(path, ledger) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(ledger, null, 2)}\n`);
  renameSync(tmp, path);
}

function main() {
  let opt;
  let rows;
  let ledger;
  try {
    opt = parseArgs(process.argv.slice(2));
    const text = existsSync(opt.file) ? readFileSync(opt.file, "utf8") : "";
    rows = parseRows(text);
    ledger = loadLedger(opt.ledger);
  } catch (e) {
    process.stderr.write(`${e.message}\n`);
    return 2;
  }

  let out;
  try {
    const maxVersions = opt.maxVersions ?? configMaxVersions();
    out = evaluate(rows, { now: opt.now, ledger, maxVersions });
  } catch (e) {
    process.stderr.write(`${e.message}\n`);
    return 2;
  }
  try {
    writeLedger(opt.ledger, out.ledger);
  } catch (e) {
    process.stderr.write(`ledger 寫入失敗：${e.message}\n`);
    return 2;
  }
  process.stdout.write(`${JSON.stringify({ gate: GATE, pass: out.pass, results: out.results, alpha: out.alpha, looks: out.looks })}\n`);
  return out.pass.length ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main());
}
