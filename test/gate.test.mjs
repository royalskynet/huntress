import { test } from "node:test";
import assert from "node:assert/strict";
import { gate } from "../lib/gate.mjs";

const TO = "0x" + "ab".repeat(20);
const ctx = () => ({ cfg: { dailyMax: 5, perContractDaily: 2, denylist: [] }, ledger: { total: 0, byContract: {} } });
const good = () => ({
  success: true,
  data: {
    requestId: "req1",
    parsedTx: { transactionType: "ContractCall", amount: 0 },
    simulationResult: { simulationCode: "000000000", balanceChanges: [], allowanceChanges: [], authorityChanges: [] },
    risks: { riskDetails: [], addresses: {}, riskBehaviors: [] },
    requireConfirmation: false,
  },
});

test("乾淨的 0 元 mint 放行", () => {
  const r = gate(good(), { to: TO, value: "0" }, ctx());
  assert.equal(r.ok, true, r.reasons.join());
  assert.equal(r.requestId, "req1");
});

const reject = (name, mutate, call = { to: TO, value: "0" }, c = ctx()) =>
  test(`拒絕：${name}`, () => {
    const p = good();
    mutate(p, c);
    assert.equal(gate(p, call, c).ok, false);
  });

reject("preview 被攔截", (p) => { p.success = false; });
reject("缺 requestId", (p) => { delete p.data.requestId; });
reject("模擬失敗", (p) => { p.data.simulationResult.simulationCode = "351805"; });
reject("授權變更", (p) => { p.data.simulationResult.allowanceChanges = [{ spender: TO }]; });
reject("權限變更", (p) => { p.data.simulationResult.authorityChanges = [{}]; });
reject("缺 allowanceChanges", (p) => { delete p.data.simulationResult.allowanceChanges; });
reject("資產減少", (p) => { p.data.simulationResult.balanceChanges = [{ amount: "-1" }]; });
reject("風險項", (p) => { p.data.risks.riskDetails = [{ code: "RISK_001" }]; });
reject("風險地址", (p) => { p.data.risks.addresses = { [TO]: { riskLevel: 5 } }; });
reject("缺 risks", (p) => { delete p.data.risks; });
reject("需 App 確認", (p) => { p.data.requireConfirmation = true; });
reject("缺 requireConfirmation", (p) => { delete p.data.requireConfirmation; });
reject("parsedTx 轉出", (p) => { p.data.parsedTx.amount = 255; });
reject("value 非 0", () => {}, { to: TO, value: "1" });
reject("value 亂碼", () => {}, { to: TO, value: "abc" });
reject("to 格式錯", () => {}, { to: "0x123", value: "0" });
reject("denylist", (p, c) => { c.cfg.denylist = [TO.toUpperCase().replace("0X", "0x")]; });
reject("每日上限", (p, c) => { c.ledger.total = 5; });
reject("單合約上限", (p, c) => { c.ledger.byContract[TO] = 2; });
reject("config 缺上限", (p, c) => { c.cfg = {}; });

// 付費確認單（opts.maxValueWei）
const MAX = { maxValueWei: "5000000000000000" };
const spend = (p) => { p.data.simulationResult.balanceChanges = [{ amount: -0.005 }, { amount: 1000 }]; };
test("付費單：上限內、一筆扣 BNB 放行", () => {
  const p = good(); spend(p);
  assert.equal(gate(p, { to: TO, value: "5000000000000000" }, ctx(), MAX).ok, true);
});
test("付費單：超過上限拒絕", () => {
  const p = good(); spend(p);
  assert.equal(gate(p, { to: TO, value: "5000000000000001" }, ctx(), MAX).ok, false);
});
test("付費單：兩筆資產減少拒絕", () => {
  const p = good(); p.data.simulationResult.balanceChanges = [{ amount: -0.005 }, { amount: -3 }];
  assert.equal(gate(p, { to: TO, value: "1" }, ctx(), MAX).ok, false);
});
test("付費單：授權變更仍拒絕", () => {
  const p = good(); p.data.simulationResult.allowanceChanges = [{ spender: TO }];
  assert.equal(gate(p, { to: TO, value: "1" }, ctx(), MAX).ok, false);
});
test("付費單：value 格式錯拒絕", () => {
  assert.equal(gate(good(), { to: TO, value: "0.01" }, ctx(), MAX).ok, false);
});
test("免費路徑：一筆資產減少仍拒絕", () => {
  const p = good(); p.data.simulationResult.balanceChanges = [{ amount: -0.005 }];
  assert.equal(gate(p, { to: TO, value: "0" }, ctx()).ok, false);
});

const gasCtx = (spent) => {
  const c = ctx();
  c.cfg.gasBudgetWei = "100"; c.cfg.gasReserveWei = "30"; c.ledger.gasWei = spent;
  return c;
};
test("gas 預算：預留後剛好等於預算放行", () => {
  assert.equal(gate(good(), { to: TO, value: "0" }, gasCtx("70")).ok, true);
});
test("gas 預算：預留後超過預算拒絕", () => {
  const r = gate(good(), { to: TO, value: "0" }, gasCtx("71"));
  assert.deepEqual(r.reasons, ["已達每日 gas 預算"]);
});
test("gas 預算：格式錯拒絕", () => {
  const c = gasCtx("0"); c.cfg.gasBudgetWei = "x";
  assert.equal(gate(good(), { to: TO, value: "0" }, c).ok, false);
});
