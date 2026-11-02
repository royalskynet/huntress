// test/pnl.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { summarize } from "../src/pnl.mjs";

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
