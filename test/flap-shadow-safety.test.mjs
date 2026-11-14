// shadow 安全：不得 execute、全讀取失敗 exit 非 0、ENOENT 帶得出來。
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as f from "../src/flap.mjs";

const F = (n) => readFileSync(join(process.cwd(), "test/fixtures/flap", n), "utf8").trim();
const MK = "0xfd0d9e4ad5c9ddc07f68d7adf1ab9b0b20e798c4";
const NATIVE = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
const NOW = 1793180000000;
const pad = (x) => BigInt(x).toString(16).padStart(64, "0");
const page = "0x" + [pad(96), pad(0), pad(1), pad(1), pad(MK)].join("");
const wallet = "0x5e1f5e1f5e1f5e1f5e1f5e1f5e1f5e1f5e1f5e1f";

function readCalls(to, data) {
  if (data.startsWith(f.SEL.marketPage)) return page;
  if (data.startsWith(f.SEL.marketDetail)) return F("detail-0xfd0d9e4AD5c9ddC07f68d7adF1aB9b0B20E798c4.hex");
  if (data.startsWith(f.SEL.marketSettings)) return F("settings-0xfd0d9e4AD5c9ddC07f68d7adF1aB9b0B20E798c4.hex");
  if (data.startsWith(f.SEL.quoteBuy)) return F("quotebuy-0xfd0d9e4AD5c9ddC07f68d7adF1aB9b0B20E798c4.hex");
  throw new Error("unexpected call " + data.slice(0, 10));
}

test("帶舊持倉跑 shadow：execute stub 會丟錯，claimed 不得變 true", async () => {
  const L = mkdtempSync(join(tmpdir(), "fss-l-"));
  const S = mkdtempSync(join(tmpdir(), "fss-s-"));
  writeFileSync(join(S, "flap-live.json"), JSON.stringify({
    positions: { [MK]: { at: NOW - 3 * 3600 * 1000, shares: "600000000000000000000000", valueWei: "4000000000000000" } },
  }));
  let execCalls = 0;
  let execSuccess = 0;
  const deps = {
    now: NOW,
    wallet,
    logDir: L,
    stateDir: S,
    cfg: {},
    cfgAll: {},
    call: readCalls,
    blockTs: () => Math.floor(NOW / 1000) - 30 * 60,
    preview: () => ({
      success: true,
      data: {
        requestId: "rq",
        simulationResult: { simulationCode: "000000000", balanceChanges: [{ contractAddress: NATIVE, change: 1e15 }], authorityChanges: [], allowanceChanges: [] },
        risks: { riskDetails: [] },
        requireConfirmation: false,
      },
    }),
    quoteSell: () => ({ multiple: 0.4 }),
    execute: () => {
      execCalls++;
      throw new Error("shadow 禁止 execute");
    },
    log: () => {},
  };
  await f.runShadow(deps);
  assert.ok(execCalls >= 1, "應該有嘗試過 execute");
  assert.equal(execSuccess, 0);
  const live = JSON.parse(readFileSync(join(S, "flap-live.json"), "utf8"));
  assert.notEqual(live.positions[MK].claimed, true);
});

test("所有 market 讀取都失敗：process.exitCode 為 1", async () => {
  const L = mkdtempSync(join(tmpdir(), "fss-l-"));
  const S = mkdtempSync(join(tmpdir(), "fss-s-"));
  const deps = {
    now: NOW,
    wallet,
    logDir: L,
    stateDir: S,
    cfg: {},
    cfgAll: {},
    call: () => { throw new Error("cast ENOENT status=null signal=null spawnSync cast ENOENT"); },
    blockTs: () => Math.floor(NOW / 1000),
    preview: () => ({ success: false }),
    log: () => {},
  };
  try {
    await f.runShadow(deps);
    assert.equal(process.exitCode, 1);
  } finally {
    process.exitCode = 0;
  }
});

test("spawnSync 找不到指令：r.error.code 是 ENOENT，r.status 是 null", () => {
  const r = spawnSync("no-such-cmd-xyz");
  assert.equal(r.error?.code, "ENOENT");
  assert.equal(r.status, null);
});

test("狀態檔 JSON 損毀：runShadow 丟錯且不覆寫原檔", async () => {
  const L = mkdtempSync(join(tmpdir(), "fss-l-"));
  const S = mkdtempSync(join(tmpdir(), "fss-s-"));
  const bad = join(S, "flap-shadow.json");
  writeFileSync(bad, "{not json");
  const deps = {
    now: NOW,
    wallet,
    logDir: L,
    stateDir: S,
    cfg: {},
    cfgAll: {},
    call: () => { throw new Error("不該讀取"); },
    blockTs: () => Math.floor(NOW / 1000),
    preview: () => ({ success: false }),
    log: () => {},
  };
  await assert.rejects(() => f.runShadow(deps));
  assert.equal(readFileSync(bad, "utf8"), "{not json");
});

test("screenFlap 拒絕 NaN 稅率與 maxWalletBps", () => {
  const d = f.parseDetail(F("detail-0xfd0d9e4AD5c9ddC07f68d7adF1aB9b0B20E798c4.hex"));
  const s = f.parseSettings(F("settings-0xfd0d9e4AD5c9ddC07f68d7adF1aB9b0B20E798c4.hex"));
  assert.match(f.screenFlap(d, { ...s, buyTaxBps: NaN }, 30, f.DEFAULTS), /tax/);
  assert.match(f.screenFlap(d, { ...s, maxWalletBps: NaN }, 30, f.DEFAULTS), /tax/);
});

test("preview 失敗不寫 seen，下輪會重試", async () => {
  const L = mkdtempSync(join(tmpdir(), "fss-l-"));
  const S = mkdtempSync(join(tmpdir(), "fss-s-"));
  const deps = {
    now: NOW,
    wallet,
    logDir: L,
    stateDir: S,
    cfg: {},
    cfgAll: {},
    call: readCalls,
    blockTs: () => Math.floor(NOW / 1000) - 30 * 60,
    preview: () => ({ success: false, error: "temp" }),
    log: () => {},
  };
  try {
    await f.runShadow(deps);
    const st = JSON.parse(readFileSync(join(S, "flap-shadow.json"), "utf8"));
    assert.equal(st.seen[MK], undefined);
    assert.equal(process.exitCode, 1);
  } finally {
    process.exitCode = 0;
  }
});

test("全部市場 quote 丟錯：exitCode 1 且不寫 seen", async () => {
  const L = mkdtempSync(join(tmpdir(), "fss-l-"));
  const S = mkdtempSync(join(tmpdir(), "fss-s-"));
  const deps = {
    now: NOW,
    wallet,
    logDir: L,
    stateDir: S,
    cfg: {},
    cfgAll: {},
    call: (to, data) => {
      if (data.startsWith(f.SEL.marketPage)) return page;
      if (data.startsWith(f.SEL.marketDetail)) return F("detail-0xfd0d9e4AD5c9ddC07f68d7adF1aB9b0B20E798c4.hex");
      if (data.startsWith(f.SEL.marketSettings)) return F("settings-0xfd0d9e4AD5c9ddC07f68d7adF1aB9b0B20E798c4.hex");
      if (data.startsWith(f.SEL.quoteBuy)) throw new Error("quote down");
      throw new Error("unexpected call " + data.slice(0, 10));
    },
    blockTs: () => Math.floor(NOW / 1000) - 30 * 60,
    preview: () => ({ success: true, data: { requestId: "rq" } }),
    log: () => {},
  };
  try {
    await f.runShadow(deps);
    const st = JSON.parse(readFileSync(join(S, "flap-shadow.json"), "utf8"));
    assert.equal(st.seen[MK], undefined);
    assert.equal(process.exitCode, 1);
  } finally {
    process.exitCode = 0;
  }
});

test("真正 CLI shadow：帶持倉也不得呼叫 baw execute", () => {
  const T = mkdtempSync(join(tmpdir(), "fss-cli-"));
  const S = join(T, "state");
  const L = join(T, "logs");
  const castDir = join(T, "castbin");
  mkdirSync(S);
  mkdirSync(L);
  mkdirSync(castDir);
  const TOK = "0x1111111111111111111111111111111111111111";
  const w = (x) => BigInt(x).toString(16).padStart(64, "0");
  const dw = Array.from({ length: 60 }, () => w(0));
  dw[7] = w(826);
  dw[8] = w(2);
  dw[10] = w(TOK);
  dw[38] = w(13);
  dw[41] = w(1700000000);
  dw[42] = w(129338926);
  const detailPath = join(T, "detail.hex");
  writeFileSync(detailPath, "0x" + dw.join("") + "\n");
  const pagePath = join(T, "page.hex");
  writeFileSync(pagePath, "0x" + [w(96), w(0), w(0), w(0)].join("") + "\n");
  const previewPath = join(T, "preview.json");
  writeFileSync(previewPath, JSON.stringify({
    success: true,
    data: {
      requestId: "rq",
      simulationResult: { simulationCode: "000000000", balanceChanges: [{ contractAddress: TOK, change: 1e15 }], authorityChanges: [], allowanceChanges: [] },
      risks: { riskDetails: [] },
      requireConfirmation: false,
    },
  }));
  const bawLog = join(T, "baw.log");
  const bawPath = join(T, "fake-baw.sh");
  writeFileSync(bawPath, [
    "#!/usr/bin/env bash",
    `printf '%s\\n' "$*" >> "${bawLog}"`,
    'if [ "$1" = "wallet" ] && [ "$2" = "address" ]; then',
    `  printf '%s\\n' '{"success":true,"data":{"addresses":[{"binanceChainId":"56","address":"${wallet}"}]}}'`,
    'elif [ "$1" = "contract-call" ] && [ "$2" = "preview" ]; then',
    `  cat "${previewPath}"`,
    'elif [ "$1" = "contract-call" ] && [ "$2" = "execute" ]; then',
    `  printf '%s\\n' '{"success":false,"error":"test"}'`,
    "else",
    `  printf '%s\\n' '{}'`,
    "fi",
  ].join("\n") + "\n", { mode: 0o755 });
  const castPath = join(castDir, "cast");
  writeFileSync(castPath, [
    "#!/usr/bin/env bash",
    'if [ "$1" = "call" ]; then',
    '  data="$5"',
    '  case "$data" in',
    `    ${f.SEL.marketPage}*) cat "${pagePath}" ;;`,
    `    ${f.SEL.marketDetail}*) cat "${detailPath}" ;;`,
    `    *) printf '%s\\n' '0x' ;;`,
    "  esac",
    'elif [ "$1" = "block" ]; then',
    `  printf '%s\\n' '1700000000'`,
    "else",
    `  printf '%s\\n' '0x'`,
    "fi",
  ].join("\n") + "\n", { mode: 0o755 });
  writeFileSync(join(S, "flap-live.json"), JSON.stringify({
    positions: { [MK]: { at: NOW - 3 * 3600 * 1000, shares: "600000000000000000000000", valueWei: "4000000000000000" } },
  }));
  const cfgPath = join(T, "config.json");
  writeFileSync(cfgPath, JSON.stringify({ paidShadow: { enabled: false, live: false }, flap: {} }));
  const env = {
    ...process.env,
    PATH: `${castDir}:${process.env.PATH}`,
    BAW_BIN: bawPath,
    STATE_DIR: S,
    LOG_DIR: L,
    CONFIG: cfgPath,
  };
  const r = spawnSync(process.execPath, ["src/flap.mjs", "shadow"], { cwd: process.cwd(), env, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const log = readFileSync(bawLog, "utf8");
  assert.match(log, /wallet address/);
  assert.equal(log.split("\n").some((line) => line.includes("execute")), false);
});

test("preview 回 success:true 但 data 不完整：算失敗、不寫 seen", async () => {
  const L = mkdtempSync(join(tmpdir(), "fss-l-"));
  const S = mkdtempSync(join(tmpdir(), "fss-s-"));
  const deps = {
    now: NOW, wallet, logDir: L, stateDir: S, cfg: {}, cfgAll: {},
    call: readCalls,
    blockTs: () => Math.floor(NOW / 1000) - 30 * 60,
    preview: () => ({ success: true, data: {} }),
    log: () => {},
  };
  try {
    await f.runShadow(deps);
    const st = JSON.parse(readFileSync(join(S, "flap-shadow.json"), "utf8"));
    assert.equal(st.seen[MK], undefined);
    assert.equal(process.exitCode, 1);
  } finally {
    process.exitCode = 0;
  }
});

test("checkShadow：內盤中報價失敗不標 checked，下輪重試", async () => {
  const det = F("detail-0xfd0d9e4AD5c9ddC07f68d7adF1aB9b0B20E798c4.hex");
  assert.equal(f.parseDetail(det).phase, 1);
  const L = mkdtempSync(join(tmpdir(), "fss-l-"));
  const S = mkdtempSync(join(tmpdir(), "fss-s-"));
  writeFileSync(join(L, "shadow.jsonl"), JSON.stringify({ at: NOW - 3 * 86400000, market: MK, shares: "1000" }) + "\n");
  await f.checkShadow({
    now: NOW, wallet, logDir: L, stateDir: S, cfg: {},
    call: (to, data) => {
      if (data.startsWith(f.SEL.marketDetail)) return det;
      throw new Error("quote down");
    },
  });
  const st = JSON.parse(readFileSync(join(S, "flap-shadow.json"), "utf8"));
  assert.equal(st.checked[MK], undefined);
  process.exitCode = 0;
});

test("previewComplete：缺欄位算不完整，業務拒絕的完整回應算完整", () => {
  assert.equal(f.previewComplete({ success: true, data: { requestId: "rq", simulationResult: {} } }), false);
  const full = { success: true, data: { requestId: "rq", requireConfirmation: false, simulationResult: { simulationCode: "999", authorityChanges: [], allowanceChanges: [], balanceChanges: [] }, risks: { riskDetails: [] } } };
  assert.equal(f.previewComplete(full), true);
  const noBal = structuredClone(full); delete noBal.data.simulationResult.balanceChanges;
  assert.equal(f.previewComplete(noBal), false);
  const noAmt = structuredClone(full); noAmt.data.simulationResult.balanceChanges = [{ contractAddress: NATIVE }];
  assert.equal(f.previewComplete(noAmt), false);
  const g = f.buyGate(noAmt, { to: f.PORTAL, value: "1", inputData: "0x" }, { market: MK, shares: "1", valueWei: "1", slippageBps: 100 });
  assert.ok(g.reasons.includes("餘額變更金額無法解析"));
  for (const bad of ["", false, [], null, "1e5x", NaN]) assert.equal(f.parseAmount(bad), null, String(bad));
  assert.equal(f.parseAmount("-1000"), -1000);
  assert.equal(f.parseAmount(-5), -5);
});

test("checkShadow：到期項目全部讀取失敗 → exitCode 1", async () => {
  process.exitCode = 0;
  const L = mkdtempSync(join(tmpdir(), "fss-l-"));
  const S = mkdtempSync(join(tmpdir(), "fss-s-"));
  writeFileSync(join(L, "shadow.jsonl"), JSON.stringify({ at: NOW - 3 * 86400000, market: MK, shares: "1000" }) + "\n");
  try {
    await f.checkShadow({ now: NOW, wallet, logDir: L, stateDir: S, cfg: {}, call: () => { throw new Error("rpc down"); } });
    assert.equal(process.exitCode, 1);
  } finally {
    process.exitCode = 0;
  }
});
