import test from "node:test";
import assert from "node:assert/strict";
import { diffWatch } from "../src/flap-watch.mjs";
const Z = "0x0000000000000000000000000000000000000000";
const r = (m, phase, bps, q = Z) => ({ m, phase, progressBps: bps, quoteToken: q });
test("首輪只建基準不推", () => {
  const { events, next } = diffWatch(null, [r("a", 3, 10000), r("b", 1, 826)]);
  assert.equal(events.length, 0);
  assert.deepEqual(next.grad, ["a"]); assert.deepEqual(next.hot, ["b"]);
});
test("新畢業與新熱盤才推；舊的、非 BNB、低進度不推", () => {
  const prev = { grad: ["a"], hot: ["b"] };
  const { events } = diffWatch(prev, [r("a", 3, 1e4), r("b", 1, 900), r("c", 3, 1e4), r("d", 1, 300), r("e", 1, 299), r("f", 1, 5000, "0x55")]);
  assert.equal(events.length, 2);
  assert.match(events[0], /新畢業 c/); assert.match(events[1], /d（3.00%）/);
});
test("熱盤畢業後不重複推熱盤", () => {
  const { events } = diffWatch({ grad: [], hot: ["d"] }, [r("d", 3, 1e4)]);
  assert.deepEqual(events, ["🎓 新畢業 d"]);
});
