// test/pnl.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { summarize, formatPnl } from "../src/pnl.mjs";

test("summarize 算法、sinceMs 過濾、origCostWei 缺時退回 costWei", () => {
  const N = 1793150000000;
  const st = {
    positions: { a: {} },
    closed: [
      { origCostWei: "4000000000000000", costWei: "2000000000000000", proceedsWei: "6000000000000000", closedAt: N },
      { costWei: "4000000000000000", proceedsWei: "1000000000000000", closedAt: N },
      { costWei: "9000000000000000", proceedsWei: "0", closedAt: N - 100 },
    ],
  };
  const s = summarize(st, N);
  assert.equal(s.closedN, 2);
  assert.equal(s.wins, 1);
  assert.equal(s.costWei, "8000000000000000");
  assert.equal(s.proceedsWei, "7000000000000000");
  assert.equal(s.pnlWei, "-1000000000000000");

  // origCostWei 缺時退回 costWei
  const st2 = { positions: {}, closed: [{ costWei: "1000", proceedsWei: "2000", closedAt: N }] };
  const s2 = summarize(st2, N);
  assert.equal(s2.costWei, "1000");
  assert.equal(s2.wins, 1);
});

test("免費鑄造不計付費勝率", () => {
  const N = 1793150000000;
  const st = {
    positions: {},
    closed: [
      { kind: "free", costWei: "0", proceedsWei: "5000", closedAt: N },
      { kind: "free", costWei: "0", proceedsWei: "0", closedAt: N },
      { kind: "paid", origCostWei: "1000", proceedsWei: "2000", proceedsSource: "chain", closedAt: N },
      { kind: "paid", origCostWei: "1000", proceedsWei: "500", proceedsSource: "chain", closedAt: N },
    ],
  };
  const s = summarize(st, N);
  assert.equal(s.free.n, 2);
  assert.equal(s.paid.n, 2);
  assert.equal(s.paid.trusted, 2);
  assert.equal(s.paid.wins, 1);
});

test("proceedsSource 是 quote 或 estimate 的付費平倉算帳不全", () => {
  const N = 1793150000000;
  const st = {
    positions: {},
    closed: [
      { kind: "paid", origCostWei: "1000", proceedsWei: "2000", proceedsSource: "quote", closedAt: N },
      { kind: "paid", origCostWei: "1000", proceedsWei: "2000", proceedsSource: "estimate", closedAt: N },
      { kind: "paid", origCostWei: "1000", proceedsWei: "2000", proceedsSource: "chain", closedAt: N },
    ],
  };
  const s = summarize(st, N);
  assert.equal(s.paid.n, 3);
  assert.equal(s.paid.trusted, 1);
  assert.equal(s.paid.incomplete, 2);
  assert.equal(s.paid.wins, 1);
});

test("缺 proceedsWei 算帳不全", () => {
  const N = 1793150000000;
  const st = { positions: {}, closed: [{ kind: "paid", origCostWei: "1000", proceedsSource: "chain", closedAt: N }] };
  const s = summarize(st, N);
  assert.equal(s.paid.n, 1);
  assert.equal(s.paid.trusted, 0);
  assert.equal(s.paid.incomplete, 1);
});

test("壞金額丟錯，訊息含欄位值", () => {
  const N = 1793150000000;
  assert.throws(
    () => summarize({ positions: {}, closed: [{ kind: "paid", costWei: "abc", proceedsWei: "1", proceedsSource: "chain", closedAt: N }] }, N),
    /abc/
  );
  assert.throws(
    () => summarize({ positions: {}, closed: [{ kind: "paid", costWei: "1.5", proceedsWei: "1", proceedsSource: "chain", closedAt: N }] }, N),
    /1\.5/
  );
});

test("byExitReason 只算可信付費並分組", () => {
  const N = 1793150000000;
  const st = {
    positions: {},
    closed: [
      { kind: "paid", origCostWei: "1000", proceedsWei: "1500", proceedsSource: "chain", exitReason: "tp", closedAt: N },
      { kind: "paid", origCostWei: "1000", proceedsWei: "2000", proceedsSource: "chain", exitReason: "tp", closedAt: N },
      { kind: "paid", origCostWei: "1000", proceedsWei: "400", proceedsSource: "chain", exitReason: "sl", closedAt: N },
      { kind: "paid", origCostWei: "1000", proceedsWei: "2000", proceedsSource: "quote", exitReason: "trail", closedAt: N },
    ],
  };
  const s = summarize(st, N);
  assert.equal(s.byExitReason.tp.n, 2);
  assert.equal(s.byExitReason.tp.pnlWei, "1500");
  assert.equal(s.byExitReason.sl.n, 1);
  assert.equal(s.byExitReason.sl.pnlWei, "-600");
  assert.equal(s.byExitReason.trail, undefined);
});

test("formatPnl 主行勝場只算可信：free 與 quote 來源的贏單不計", () => {
  const N = 1793150000000;
  const st = {
    positions: {},
    closed: [
      { kind: "free", costWei: "0", proceedsWei: "5000", closedAt: N },
      { kind: "paid", origCostWei: "1000", proceedsWei: "2000", proceedsSource: "quote", closedAt: N },
      { kind: "paid", origCostWei: "1000", proceedsWei: "500", proceedsSource: "chain", closedAt: N },
      { kind: "paid", origCostWei: "1000", proceedsWei: "2000", proceedsSource: "chain", closedAt: N },
    ],
  };
  const s = summarize(st, N);
  const out = formatPnl(s, "戰績");
  // 主行只算可信付費（chain）：2 筆、1 勝
  assert.ok(out.includes("平倉（可信）：2（勝：1）"), out);
  // 成本／實收／損益用 paid
  assert.ok(out.includes("成本：2000 wei"), out);
  assert.ok(out.includes("實收：2500 wei"), out);
  assert.ok(out.includes("損益：500 wei"), out);
  // 舊總額移到最後一行，含 free 與 quote 贏單（共 3 勝）
  assert.ok(out.includes("（全部含免費與帳不全：勝 3、損益 6500 wei）"), out);
});

test("壞 JSON 的 state 檔丟錯（CLI 非零退出）", () => {
  const dir = mkdtempSync(join(tmpdir(), "pnl-"));
  writeFileSync(join(dir, "positions.json"), "{ this is not json");
  const script = fileURLToPath(new URL("../src/pnl.mjs", import.meta.url));
  const r = spawnSync(process.execPath, [script], {
    env: { ...process.env, STATE_DIR: dir },
    encoding: "utf8",
  });
  assert.notEqual(r.status, 0, `stdout=${r.stdout} stderr=${r.stderr}`);
});
