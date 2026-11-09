import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer, connect } from "node:net";
import { readLedger, writeLedger, withLedgerLock, lockPort } from "../lib/ledger.mjs";

const moduleURL = new URL("../lib/ledger.mjs", import.meta.url).href;
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "huntress-ledger-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const state = join(dir, "state");
  mkdirSync(state);
  const date = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
  const path = join(state, `ledger-${date}.json`);
  const config = join(dir, "config.json");
  const candidate = join(dir, "candidate.json");
  writeFileSync(config, JSON.stringify({ dailyMax: 1, perContractDaily: 1, denylist: [] }));
  writeFileSync(candidate, JSON.stringify({ kind: "free", to: "0x" + "ab".repeat(20) }));
  const calls = join(dir, "calls");
  const env = { ...process.env, STATE_DIR: state, CONFIG: config, LOG_DIR: join(dir, "logs"),
    BAW_BIN: resolve("test/fake-baw.sh"), FAKE_BAW_LOG: calls,
    FAKE_PREVIEW: resolve("test/fixtures/preview-ok.json"), BSC_RPC: "http://127.0.0.1:1" };
  return { dir, state, path, candidate, calls, env };
}
function exec(f) {
  const child = spawn(process.execPath, ["src/exec.mjs", f.candidate], { env: f.env });
  let out = "", err = "";
  child.stdout.on("data", (b) => { out += b; });
  child.stderr.on("data", (b) => { err += b; });
  return once(child, "close").then(([code]) => ({ code, out, err }));
}

test("only ENOENT initializes; corrupt JSON, wrong fields and IO errors stop", (t) => {
  const f = fixture(t);
  assert.deepEqual(readLedger(f.path), { total: 0, byContract: {}, gasWei: "0", pending: [] });
  for (const value of ["{", "null", "[]", '{"total":"0","byContract":{}}',
    '{"total":0,"byContract":[],"gasWei":"0"}',
    '{"total":0,"byContract":{"x":-1}}', '{"total":0,"byContract":{},"gasWei":0}',
    '{"total":0,"byContract":{},"pending":{}}',
    '{"total":0,"byContract":{},"pending":[{"txHash":null,"reservedWei":1}]}']) {
    writeFileSync(f.path, value);
    assert.throws(() => readLedger(f.path));
    assert.equal(readFileSync(f.path, "utf8"), value);
  }
  chmodSync(f.path, 0);
  try { assert.throws(() => readLedger(f.path), { code: "EACCES" }); }
  finally { chmodSync(f.path, 0o600); }
  rmSync(f.path);
  mkdirSync(f.path);
  assert.throws(() => readLedger(f.path), { code: "EISDIR" });
});

test("corrupt ledger stops exec before execute and preserves original", async (t) => {
  const f = fixture(t);
  writeFileSync(f.path, "{broken");
  const result = await exec(f);
  assert.notEqual(result.code, 0);
  assert.match(result.err, /SyntaxError/);
  assert.doesNotMatch(readFileSync(f.calls, "utf8"), /execute/);
  assert.equal(readFileSync(f.path, "utf8"), "{broken");
});

test("two exec processes compete for last allowance; exactly one executes", async (t) => {
  const f = fixture(t);
  const results = await Promise.all([exec(f), exec(f)]);
  assert.deepEqual(results.map((r) => r.code), [0, 0]);
  assert.equal(results.filter((r) => JSON.parse(r.out).ok).length, 1);
  assert.equal(readFileSync(f.calls, "utf8").split("\n").filter((s) => s.includes("execute")).length, 1);
  assert.equal(readLedger(f.path).total, 1);
});

test("SIGKILL during temporary write preserves original valid JSON", async (t) => {
  const f = fixture(t);
  const original = { total: 1, byContract: {}, gasWei: "0", pending: [] };
  writeLedger(f.path, original);
  // 在真正的暫存檔寫入一半後停住，精確驗證 rename 前被 kill 的情況。
  const code = `import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    const write = fs.writeFileSync;
    fs.writeFileSync = (path, data, options) => {
      write(path, data.slice(0, Math.floor(data.length / 2)), options);
      process.stdout.write('partial\\n');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
    };
    syncBuiltinESMExports();
    const { writeLedger } = await import(${JSON.stringify(moduleURL)});
    writeLedger(${JSON.stringify(f.path)}, { total: 2, byContract: {} });`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", code]);
  t.after(() => child.kill("SIGKILL"));
  const closed = once(child, "close");
  await once(child.stdout, "data");
  child.kill("SIGKILL");
  const [, signal] = await closed;
  assert.equal(signal, "SIGKILL");
  assert.deepEqual(JSON.parse(readFileSync(f.path, "utf8")), original);
  writeLedger(f.path, { ...original, total: 2 });
  assert.equal(readLedger(f.path).total, 2);
});

test("two processes acquire the port without overlapping callbacks", { timeout: 10_000 }, async (t) => {
  const f = fixture(t);
  const log = join(f.dir, "critical.jsonl");
  const workers = [0, 1].map(id => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", `
      import { appendFileSync } from 'node:fs';
      import { withLedgerLock } from ${JSON.stringify(moduleURL)};
      console.log('ready');
      await new Promise(resolve => process.stdin.once('data', resolve));
      await withLedgerLock(${JSON.stringify(f.state)}, async () => {
        const record = event => appendFileSync(${JSON.stringify(log)}, JSON.stringify({ id: ${id}, event, time: process.hrtime.bigint().toString() }) + '\\n');
        record('enter');
        await new Promise(resolve => setTimeout(resolve, 150));
        record('leave');
      });`]);
    t.after(() => child.kill("SIGKILL"));
    return { child, ready: once(child.stdout, "data"), closed: once(child, "close") };
  });
  await Promise.all(workers.map(w => w.ready));
  workers.forEach(w => w.child.stdin.end("go"));
  assert.deepEqual(await Promise.all(workers.map(w => w.closed)), [[0, null], [0, null]]);
  const records = readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line));
  assert.deepEqual(records.map(r => r.event), ["enter", "leave", "enter", "leave"]);
  assert.equal(records[0].id, records[1].id);
  assert.equal(records[2].id, records[3].id);
  assert.notEqual(records[0].id, records[2].id);
  assert.ok(BigInt(records[1].time) <= BigInt(records[2].time));
});

test("abort interrupts a waiting lock with the original reason", async (t) => {
  const f = fixture(t);
  const controller = new AbortController();
  const reason = new Error("cancel waiting");
  let release;
  let ready;
  const acquired = new Promise(resolve => { ready = resolve; });
  const held = withLedgerLock(f.state, () => new Promise(resolve => { release = resolve; ready(); }));
  await Promise.race([acquired, held]);
  let entered = false;
  try {
    const waiting = withLedgerLock(f.state, () => { entered = true; }, { signal: controller.signal });
    setTimeout(() => controller.abort(reason), 50);
    await assert.rejects(waiting, error => error === reason);
    assert.equal(entered, false);
    await assert.rejects(withLedgerLock(f.state, () => { entered = true; }, { signal: controller.signal }), error => error === reason);
    assert.equal(entered, false);
  } finally { release(); await held; }
});

function holder(t, state, ms) {
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import { withLedgerLock } from ${JSON.stringify(moduleURL)};
    await withLedgerLock(${JSON.stringify(state)}, async () => {
      console.log('held');
      await new Promise(resolve => setTimeout(resolve, ${ms}));
    });`]);
  t.after(() => child.kill('SIGKILL'));
  const closed = once(child, 'close');
  const ready = Promise.race([once(child.stdout, 'data'), closed.then(([code]) => { throw Error(`lock holder exited: ${code}`); })]);
  return { child, ready, closed };
}

test("SIGKILL releases port to waiting process within two seconds", { timeout: 5000 }, async t => {
  const f = fixture(t), owner = holder(t, f.state, 10000);
  await owner.ready;
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import { withLedgerLock } from ${JSON.stringify(moduleURL)};
    console.log('waiting');
    await withLedgerLock(${JSON.stringify(f.state)}, () => console.log('acquired'), { signal: AbortSignal.timeout(2000) });`]);
  t.after(() => child.kill('SIGKILL'));
  const closed = once(child, 'close');
  let output = '';
  child.stdout.on('data', b => { output += b; });
  await once(child.stdout, 'data');
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.doesNotMatch(output, /acquired/);
  const start = Date.now();
  owner.child.kill('SIGKILL');
  await owner.closed;
  assert.deepEqual(await closed, [0, null]);
  assert.match(output, /acquired/);
  assert.ok(Date.now() - start < 2000);
});

test("300ms timeout never enters callback while child holds port for 1.5s", async t => {
  const f = fixture(t), owner = holder(t, f.state, 1500);
  await owner.ready;
  let entered = false;
  await assert.rejects(withLedgerLock(f.state, () => { entered = true; }, {
    signal: AbortSignal.timeout(300)
  }), { name: 'TimeoutError' });
  assert.equal(entered, false);
  assert.deepEqual(await owner.closed, [0, null]);
});

test("LEDGER_LOCK_PORT cannot split one ledger across ports", t => {
  const f = fixture(t), original = process.env.LEDGER_LOCK_PORT;
  try {
    delete process.env.LEDGER_LOCK_PORT;
    const port = lockPort(f.state);
    process.env.LEDGER_LOCK_PORT = String(port === 30000 ? 30001 : 30000);
    assert.equal(lockPort(f.state), port);
  } finally {
    if (original === undefined) delete process.env.LEDGER_LOCK_PORT;
    else process.env.LEDGER_LOCK_PORT = original;
  }
});

test("lock wait without signal gives up after waitMs when port is occupied", async t => {
  const f = fixture(t);
  const blocker = createServer();
  await new Promise(resolve => blocker.listen({ host: "127.0.0.1", port: lockPort(f.state), exclusive: true }, resolve));
  t.after(() => blocker.close());
  let entered = false;
  await assert.rejects(withLedgerLock(f.state, () => { entered = true; }, { waitMs: 200 }), { name: "TimeoutError" });
  assert.equal(entered, false);
});

test("open client connection does not block lock release", { timeout: 5000 }, async t => {
  const f = fixture(t);
  let client;
  await withLedgerLock(f.state, async () => {
    client = connect({ host: "127.0.0.1", port: lockPort(f.state) });
    client.on("error", () => {});
    await once(client, "connect");
  });
  client.destroy();
  assert.equal(await withLedgerLock(f.state, () => 7), 7);
});

test("derived port is stable and between 20000 and 59999", t => {
  const f = fixture(t), original = process.env.LEDGER_LOCK_PORT;
  delete process.env.LEDGER_LOCK_PORT;
  try {
    const port = lockPort(f.state);
    assert.equal(lockPort(f.state), port);
    assert.equal(lockPort(join(f.state, '..', 'state')), port);
    assert.ok(port >= 20000 && port <= 59999);
  } finally {
    if (original !== undefined) process.env.LEDGER_LOCK_PORT = original;
  }
});

test("callback failure releases port", async t => {
  const f = fixture(t);
  await assert.rejects(withLedgerLock(f.state, () => { throw Error('stop'); }), /stop/);
  assert.equal(await withLedgerLock(f.state, () => 42), 42);
});
