// bin/shadow-verdict.mjs：透過 CLI 驗 exit code 與判定結果（fixture 在 mktemp 目錄生成）
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { lowerIndex, parseRows } from "../bin/shadow-verdict.mjs";

const CLI = fileURLToPath(new URL("../bin/shadow-verdict.mjs", import.meta.url));
const DAY = 86400000;
const BASE = Date.UTC(2025, 0, 1);
const NOW = BASE + 40 * DAY;
const COST = 2000000000000000n;
const GAS = 50000000000000n;

const hexToken = (i) => `0x${(i + 1).toString(16).padStart(40, "0")}`;
const defaultAt = (i, n = 120) => BASE + Math.floor((i * 16) / n) * DAY + (i % 8) * 60000;

function entryRow(sv, token, at, cost = COST) {
  return { v: 1, kind: "entry", strategyVersion: sv, token, signalId: `sig-${token}-${at}`, at, costWei: String(cost), qty: "1000" };
}

function exitRow(sv, token, entryAt, at, net, cost = COST) {
  return {
    v: 1,
    kind: "exit",
    strategyVersion: sv,
    token,
    entryAt,
    at,
    costWei: String(cost),
    estProceedsWei: String(cost + net + GAS),
    gasWei: String(GAS),
    netWei: String(net),
    exitReason: "tp",
  };
}

function makeSet({ sv = "s@v1", n = 120, tokenOf = (i) => hexToken(i), atOf = (i) => defaultAt(i, n), netOf = () => 20000000000000n, cost = COST, extra = [] } = {}) {
  const rows = [];
  for (let i = 0; i < n; i++) {
    const token = tokenOf(i);
    const at = atOf(i);
    const c = typeof cost === "function" ? cost(i) : cost;
    rows.push(entryRow(sv, token, at - 1000, c));
    rows.push(exitRow(sv, token, at - 1000, at, netOf(i), c));
  }
  return [...rows, ...extra];
}

function run(rows, opts = {}) {
  const dir = opts.dir ?? mkdtempSync(join(tmpdir(), "shadow-verdict-"));
  const file = opts.file ?? join(dir, "input.jsonl");
  if (rows !== undefined) {
    const body = rows.map((r) => (typeof r === "string" ? r : JSON.stringify(r))).join("\n");
    writeFileSync(file, `${body}\n`);
  }
  const ledgerPath = opts.ledger ?? join(dir, "ledger.json");
  const args = [CLI, "--file", file, "--ledger", ledgerPath, "--now", String(opts.now ?? NOW), ...(opts.args ?? [])];
  const res = spawnSync(process.execPath, args, { encoding: "utf8", cwd: opts.cwd });
  return { ...res, dir, file, ledgerPath };
}

const json = (res) => JSON.parse(res.stdout);

test("全過 fixture → 第一次檢視（n≥30、7 天）就過，α=0.002", () => {
  const r = run(makeSet());
  assert.equal(r.status, 0, r.stderr);
  const out = json(r);
  assert.equal(out.gate, 2);
  assert.deepEqual(out.pass, ["s@v1"]);
  const v = out.results["s@v1"];
  assert.equal(v.look, 30);
  assert.ok(Math.abs(v.alpha - 0.002) < 1e-15, `alpha=${v.alpha}`);
  assert.ok(v.n >= 30 && v.n < 60, `n=${v.n}`);
  assert.ok(v.tokens >= 18);
  assert.ok(v.days >= 7);
  assert.ok(v.mean > 0);
  assert.ok(v.lb > 0);
  assert.ok(v.meanTrim > 0);
  assert.ok(v.mdd < 0.3);
  assert.deepEqual(v.reasons, []);
});

test("29 筆（只差筆數）→ exit 1、不寫 ledger 鎖定", () => {
  const r = run(makeSet({ n: 29 }));
  assert.equal(r.status, 1, r.stderr);
  assert.deepEqual(json(r).pass, []);
  const ledger = JSON.parse(readFileSync(r.ledgerPath, "utf8"));
  assert.equal(ledger["s@v1"], undefined);
});

test("17 個不同 token → 三次檢視都不過 → exit 1、鎖定不過", () => {
  const r = run(makeSet({ tokenOf: (i) => hexToken(i % 17) }));
  assert.equal(r.status, 1, r.stderr);
  assert.deepEqual(json(r).pass, []);
  const ledger = JSON.parse(readFileSync(r.ledgerPath, "utf8"));
  assert.equal(ledger["s@v1"].pass, false);
  assert.deepEqual(ledger["s@v1"].looks.map((l) => l.look), [30, 60, 100]);
});

test("前兩次檢視 token 不夠、第三次（等同 v1 門檻）過 → exit 0，α=0.005", () => {
  const tokenOf = (i) => hexToken(i < 60 ? i % 17 : i);
  const r = run(makeSet({ tokenOf }));
  assert.equal(r.status, 0, r.stderr);
  const v = json(r).results["s@v1"];
  assert.equal(v.look, 100);
  assert.ok(Math.abs(v.alpha - 0.005) < 1e-15);
  assert.ok(v.n >= 100 && v.tokens >= 60 && v.days >= 14);
});

test("第一次檢視不過、資料還不夠第二次 → 記一次不過但不鎖定；補資料後第二次過", () => {
  const dir = mkdtempSync(join(tmpdir(), "shadow-verdict-looks-"));
  const tokenOf = (i) => hexToken(i < 75 ? i % 17 : i);
  const atOf = (i) => BASE + Math.floor((i * 12) / 119) * DAY + (i % 8) * 60000;
  const all = makeSet({ n: 120, tokenOf, atOf });
  const cut = BASE + 8 * DAY;
  const early = all.filter((r) => r.at < cut);
  const first = run(early, { dir });
  assert.equal(first.status, 1, first.stderr);
  const l1 = JSON.parse(readFileSync(first.ledgerPath, "utf8"))["s@v1"];
  assert.equal(l1.pass, null);
  assert.equal(l1.looks.length, 1);
  assert.match(json(first).results["s@v1"].reasons.join(), /待第 2 次檢視/);
  const second = run(all, { dir });
  assert.equal(second.status, 0, second.stderr);
  assert.equal(json(second).results["s@v1"].look, 60);
});

test("涵蓋 6.9 天 → exit 1", () => {
  const atOf = (i) => BASE + Math.round((i * 6.9 * DAY) / 119);
  const r = run(makeSet({ atOf }));
  assert.equal(r.status, 1, r.stderr);
  const v = json(r).results["s@v1"];
  assert.ok(v.days < 7);
  assert.deepEqual(v.reasons, ["樣本不足"]);
});

test("平均報酬 ≤ 0 → exit 1", () => {
  const netOf = (i) => (i % 2 === 0 ? 20000000000000n : -30000000000000n);
  const r = run(makeSet({ netOf }));
  assert.equal(r.status, 1, r.stderr);
  const v = json(r).results["s@v1"];
  assert.ok(v.mean <= 0);
  assert.ok(v.reasons.some((x) => x.includes("平均")));
});

test("bootstrap 下界 ≤ 0 → exit 1", () => {
  // 16 天裡有 2 天是 -4%，其餘 +1%；整體平均仍為正，但重抽下界會落在負值。
  const netOf = (i) => (Math.floor((i * 16) / 120) < 2 ? -80000000000000n : 20000000000000n);
  const r = run(makeSet({ netOf }));
  assert.equal(r.status, 1, r.stderr);
  const v = json(r).results["s@v1"];
  assert.ok(v.mean > 0);
  assert.ok(v.lb <= 0);
  assert.ok(v.reasons.some((x) => x.includes("bootstrap")));
});

test("拿掉最賺 3 筆後平均 ≤ 0 → exit 1", () => {
  const dayOf = (i) => (i < 3 ? i * 5 : 3 + Math.floor(((i - 3) * 13) / 117));
  const atOf = (i) => BASE + dayOf(i) * DAY + (i % 8) * 60000;
  const netOf = (i) => (i < 3 ? 5000000000000000n : -2000000000000n);
  const r = run(makeSet({ atOf, netOf }));
  assert.equal(r.status, 1, r.stderr);
  const v = json(r).results["s@v1"];
  assert.ok(v.mean > 0);
  assert.ok(v.meanTrim <= 0);
  assert.ok(v.reasons.some((x) => x.includes("最高 3 筆")));
});

test("MDD 剛好 30% → exit 1（< 30% 才算過）", () => {
  const cost = 10000000000000000n;
  const netOf = (i) => (i < 2 ? -6285000000000000n : 2000000000000000n);
  const r = run(makeSet({ cost, netOf }));
  assert.equal(r.status, 1, r.stderr);
  const v = json(r).results["s@v1"];
  assert.ok(Math.abs(v.mdd - 0.3) < 1e-12, `mdd=${v.mdd}`);
  assert.ok(v.reasons.some((x) => x.includes("MDD")));
});

test("超過 72 小時沒有對應 exit 的 entry → exit 1", () => {
  const extra = [entryRow("s@v1", `0x${"de".repeat(20)}`, BASE + 2 * DAY)];
  const r = run(makeSet({ extra }));
  assert.equal(r.status, 1, r.stderr);
  const v = json(r).results["s@v1"];
  assert.ok(v.reasons.some((x) => x.includes("cohort")));
});

test("空檔 → exit 1、pass 為空", () => {
  const r = run([]);
  assert.equal(r.status, 1, r.stderr);
  const out = json(r);
  assert.deepEqual(out.pass, []);
  assert.deepEqual(out.results, {});
  assert.equal(out.alpha, 0.01);
  assert.deepEqual(out.looks.map((l) => l.n), [30, 60, 100]);
});

test("金額是 1.5（非整數字串）→ exit 2，stderr 帶行號與原因", () => {
  const bad = { ...exitRow("s@v1", hexToken(0), BASE - 1000, BASE, 20000000000000n), costWei: "1.5" };
  const r = run([bad]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /第 1 行/);
  assert.match(r.stderr, /整數字串/);
});

test("未知 kind → exit 2", () => {
  const r = run([{ v: 1, kind: "bogus", strategyVersion: "s@v1", token: hexToken(0), at: BASE }]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /未知 kind/);
});

test("兩版本一過一不過 → exit 0 且 pass 只含過的版本", () => {
  const good = makeSet({ sv: "good@v1" });
  const bad = makeSet({ sv: "bad@v1", tokenOf: (i) => hexToken(i % 17) });
  const r = run([...good, ...bad]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(json(r).pass, ["good@v1"]);
});

test("鎖定後追加虧損 exit 再跑，結果不變", () => {
  const dir = mkdtempSync(join(tmpdir(), "shadow-verdict-lock-"));
  const first = run(makeSet(), { dir });
  assert.equal(first.status, 0, first.stderr);
  const before = json(first);
  const locked = JSON.parse(readFileSync(first.ledgerPath, "utf8"));
  assert.equal(locked["s@v1"].pass, true);

  const lossEntry = entryRow("s@v1", hexToken(999), BASE + 1000);
  const loss = exitRow("s@v1", hexToken(999), BASE + 1000, BASE + 20 * DAY, -1000000000000000n);
  const second = run([...makeSet(), lossEntry, loss], { dir, file: first.file, ledger: first.ledgerPath });
  assert.equal(second.status, 0, second.stderr);
  assert.deepEqual(json(second), before);
});

test("檔案不存在 → 視為零筆 → exit 1", () => {
  const r = run(undefined);
  assert.equal(r.status, 1, r.stderr);
  assert.deepEqual(json(r).pass, []);
});

test("netWei 與 est−cost−gas 不符 → exit 2，stderr 帶行號", () => {
  const entry = entryRow("s@v1", hexToken(0), BASE - 1000);
  const exit = exitRow("s@v1", hexToken(0), BASE - 1000, BASE, 20000000000000n);
  exit.netWei = String(BigInt(exit.netWei) + 1n);
  const r = run([entry, exit]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /第 2 行/);
  assert.match(r.stderr, /netWei/);
});

test("entry 的 costWei 是 0 → exit 2", () => {
  const bad = entryRow("s@v1", hexToken(0), BASE - 1000);
  bad.costWei = "0";
  const r = run([bad]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /costWei 必須大於 0/);
});

test("孤兒 exit（找不到 entry）→ exit 2", () => {
  const r = run([exitRow("s@v1", hexToken(0), BASE - 1000, BASE, 20000000000000n)]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /找不到對應 entry/);
});

test("完全相同的重複 exit 只算一次，結果不變", () => {
  const rows = makeSet();
  const r = run([...rows, { ...rows[1] }]);
  assert.equal(r.status, 0, r.stderr);
  const baseline = run(makeSet());
  assert.deepEqual(json(r), json(baseline));
});

test("鍵相同但內容不同的重複 exit → exit 2", () => {
  const rows = makeSet();
  const dup = { ...rows[1] };
  dup.netWei = String(BigInt(dup.netWei) + 1000n);
  dup.estProceedsWei = String(BigInt(dup.estProceedsWei) + 1000n);
  const r = run([...rows, dup]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /重複鍵但內容不同/);
});

test("首次達標前綴虧損、之後才轉好 → exit 1（F5 前綴判定）", () => {
  const atOf = (i) => BASE + Math.floor((i * 30) / 199) * DAY + (i % 8) * 60000;
  const netOf = (i) => (i < 100 ? -1000000000000n : 20000000000000n);
  const r = run(makeSet({ n: 200, atOf, netOf }));
  assert.equal(r.status, 1, r.stderr);
  const v = json(r).results["s@v1"];
  assert.equal(v.n, 100);
  assert.ok(v.mean < 0, `mean=${v.mean}`);
  assert.ok(v.reasons.some((x) => x.includes("平均")));
});

test("同一資料 --max-versions 1 通過、--max-versions 1000 下界變小不過（F6）", () => {
  const rows = makeSet({ netOf: (i) => (i < 8 ? -80000000000000n : 40000000000000n) });
  const small = run(rows, { args: ["--max-versions", "1"] });
  assert.equal(small.status, 0, small.stderr);
  assert.equal(json(small).alpha, 0.05);
  const big = run(rows, { args: ["--max-versions", "1000"] });
  assert.equal(big.status, 1, big.stderr);
  assert.ok(json(big).results["s@v1"].lb <= 0);
  assert.ok(Math.abs(json(big).alpha - 0.00005) < 1e-15);
});

test("lowerIndex 取單起算分位（第 100 小）", () => {
  assert.equal(lowerIndex(0.05, 2000), 99);
  assert.equal(lowerIndex(0.05 / 1000, 2000), 0);
});

test("同版本同 token 同 at 不同 signalId 的兩筆 dup reject 皆保留（F2）", () => {
  const base = { v: 1, kind: "reject", strategyVersion: "s@v1", token: hexToken(0), at: BASE, reason: "dup" };
  const a = { ...base, signalId: "1" };
  const b = { ...base, signalId: "2" };
  const rows = parseRows([a, b].map((r) => JSON.stringify(r)).join("\n"));
  assert.equal(rows.length, 2);
  const r = run([a, b]);
  assert.equal(r.status, 1, r.stderr);
});

test("同一 ledger 先 --max-versions 1 再 1000 → 第二次 exit 2（F3）", () => {
  const rows = makeSet({ netOf: (i) => (i < 8 ? -80000000000000n : 40000000000000n) });
  const dir = mkdtempSync(join(tmpdir(), "shadow-verdict-mv-"));
  const first = run(rows, { dir, args: ["--max-versions", "1"] });
  assert.equal(first.status, 0, first.stderr);
  const ledger = JSON.parse(readFileSync(first.ledgerPath, "utf8"));
  assert.equal(ledger["s@v1"].maxVersions, 1);
  const second = run(rows, { dir, args: ["--max-versions", "1000"] });
  assert.equal(second.status, 2, second.stderr);
  assert.match(second.stderr, /maxVersions/);
});

test("既有 ledger 是 v1 門檻（缺 gate）→ 拒絕沿用 → exit 2", () => {
  const dir = mkdtempSync(join(tmpdir(), "shadow-verdict-v1-"));
  const ledgerPath = join(dir, "ledger.json");
  writeFileSync(ledgerPath, JSON.stringify({ "s@v1": { lockedAt: 1, pass: false, maxVersions: 5, result: {} } }));
  const r = run(makeSet(), { dir, ledger: ledgerPath });
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /gate/);
});

test("既有 ledger 缺 maxVersions 時拒絕沿用 → exit 2（F3）", () => {
  const dir = mkdtempSync(join(tmpdir(), "shadow-verdict-nomv-"));
  const ledgerPath = join(dir, "ledger.json");
  writeFileSync(ledgerPath, JSON.stringify({ "s@v1": { gate: 2, lockedAt: 1, pass: true, looks: [], result: {} } }));
  const r = run(makeSet(), { dir, ledger: ledgerPath });
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /maxVersions/);
});

test("config.json 壞掉 → exit 2（F4）", () => {
  const dir = mkdtempSync(join(tmpdir(), "shadow-verdict-badcfg-"));
  writeFileSync(join(dir, "config.json"), "{bad");
  const r = run(makeSet(), { dir, cwd: dir });
  assert.equal(r.status, 2, r.stderr);
});

test("signalShadow.maxVersions 非正整數 → exit 2（F4）", () => {
  const dir = mkdtempSync(join(tmpdir(), "shadow-verdict-mvcfg-"));
  writeFileSync(join(dir, "config.json"), JSON.stringify({ signalShadow: { maxVersions: 0 } }));
  const r = run(makeSet(), { dir, cwd: dir });
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /maxVersions/);
});

test("沒有 config.json → 用預設 5（F4 僅 ENOENT 回落）", () => {
  const dir = mkdtempSync(join(tmpdir(), "shadow-verdict-nocfg-"));
  const r = run(makeSet(), { dir, cwd: dir });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(json(r).alpha, 0.01);
});
