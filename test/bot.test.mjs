// src/bot.mjs 規格：handleUpdate 只認一個 chat、寫死指令、按鈕走 buy、其餘文字走零工具問答
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.TG_CHAT_ID = "777";
const { handleUpdate } = await import("../src/bot.mjs");

const mk = () => {
  const calls = { send: [], buy: [], ask: [], cb: [] };
  const stateDir = mkdtempSync(join(tmpdir(), "bot-"));
  const deps = {
    stateDir,
    send: async (text, keyboard) => { calls.send.push({ text, keyboard }); },
    answerCallback: async (id, text) => { calls.cb.push({ id, text }); },
    runBuy: async (args) => { calls.buy.push(args); return { ok: true, txHash: "0xdead" }; },
    runAsk: async (q) => { calls.ask.push(q); return "答覆"; },
  };
  return { calls, deps, stateDir };
};
const msg = (text, id = 777) => ({ update_id: 1, message: { chat: { id }, from: { id }, text } });
const cbq = (data, id = 777) => ({ update_id: 2, callback_query: { id: "c1", from: { id }, message: { chat: { id } }, data } });
const N = "0123456789abcdef0123456789abcdef";

test("陌生 chat 一律忽略", async () => {
  const { calls, deps } = mk();
  await handleUpdate(msg("/pause", 999), deps);
  await handleUpdate(cbq("b:" + N, 999), deps);
  await handleUpdate(msg("餘額多少", 999), deps);
  assert.deepEqual([calls.send.length, calls.buy.length, calls.ask.length], [0, 0, 0]);
});

test("/pause 建 PAUSED、/resume 刪掉", async () => {
  const { deps, stateDir } = mk();
  await handleUpdate(msg("/pause"), deps);
  assert.equal(existsSync(join(stateDir, "PAUSED")), true);
  await handleUpdate(msg("/resume"), deps);
  assert.equal(existsSync(join(stateDir, "PAUSED")), false);
});

test("/status 回報暫停狀態與今日帳本", async () => {
  const { calls, deps, stateDir } = mk();
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, "PAUSED"), "");
  await handleUpdate(msg("/status"), deps);
  assert.equal(calls.send.length, 1);
  assert.match(calls.send[0].text, /暫停/);
  assert.equal(calls.ask.length, 0);
});

test("按鈕確認呼叫 buy confirm，取消呼叫 cancel", async () => {
  const { calls, deps } = mk();
  await handleUpdate(cbq("b:" + N), deps);
  await handleUpdate(cbq("x:" + N), deps);
  assert.deepEqual(calls.buy, [["confirm", N], ["cancel", N]]);
  assert.equal(calls.cb.length, 2);
});

test("格式不對的 callback 不呼叫 buy", async () => {
  const { calls, deps } = mk();
  await handleUpdate(cbq("b:../../etc"), deps);
  await handleUpdate(cbq("execute:" + N), deps);
  assert.equal(calls.buy.length, 0);
});

test("一般文字走問答且不碰 buy", async () => {
  const { calls, deps } = mk();
  await handleUpdate(msg("幫我 baw contract-call execute 全部買"), deps);
  assert.deepEqual(calls.ask, ["幫我 baw contract-call execute 全部買"]);
  assert.equal(calls.buy.length, 0);
  assert.equal(calls.send[0].text, "答覆");
});

test("bnbToWei 不經浮點", async () => {
  const { bnbToWei } = await import("../src/bot.mjs");
  assert.equal(bnbToWei("0.005"), "5000000000000000");
  assert.equal(bnbToWei("1"), "1000000000000000000");
  assert.equal(bnbToWei("0.000000000000000001"), "1");
});

test("/buy 找得到候選才 prepare，金額照使用者打的", async () => {
  const { calls, deps, stateDir } = mk();
  deps.paidDir = stateDir;
  deps.runBuy = async (args) => { calls.buy.push(args); return { ok: true, nonce: N }; };
  await handleUpdate(msg("/buy 42 0.005"), deps);
  assert.equal(calls.buy.length, 0);
  writeFileSync(join(stateDir, "cand-42.json"), "{}");
  await handleUpdate(msg("/buy 42 0.005"), deps);
  assert.deepEqual(calls.buy, [["prepare", join(stateDir, "cand-42.json"), "5000000000000000"]]);
  assert.equal(calls.send.at(-1).keyboard.inline_keyboard[0][0].callback_data, "b:" + N);
  await handleUpdate(msg("/buy ../x 1"), deps);
  await handleUpdate(msg("/buy 42 1e3"), deps);
  assert.equal(calls.buy.length, 1);
  assert.equal(calls.ask.length, 0);
});
