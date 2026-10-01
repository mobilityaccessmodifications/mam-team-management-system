import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const runners = [
  ["run-directory-role-concurrency.mjs", ["synthetic-actor", "select 1"]],
  ["run-offboarding-admin-concurrency.mjs", ["select 1", "synthetic-actor"]],
  ["run-password-reset-credential-concurrency.mjs", ["select 1"]],
  ["run-payroll-closing-concurrency.mjs", ["select 1"]],
  ["run-notification-delivery-sql.mjs", ["select 1"]],
];

function fixture(file, args) {
  const source = readFileSync(new URL(file, import.meta.url), "utf8");
  const start = source.indexOf("function session(");
  const end = source.indexOf("async function until(", start);
  assert.ok(start >= 0 && end > start, "actual session definition must exist");
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = { write() {}, end() {} };
  const tracked = new Set();
  const session = vm.runInNewContext(`(${source.slice(start, end).trim()})`, {
    spawn: () => child,
    target: () => [],
    postgresEnv: {},
    socket: "synthetic-socket",
    database: "synthetic-database",
    process: { pid: 1 },
    counter: 0,
    serial: 0,
    args: [],
    admin: "synthetic-actor",
    payloadFunction: "synthetic-unused-body",
    sessions: tracked,
    children: tracked,
    active: tracked,
  });
  return { child, tracked, result: session(...args) };
}

for (const [file, args] of runners) {
  test(`${file}: completion waits for both output streams to close`, async () => {
    const { child, tracked, result } = fixture(file, args);
    let settled = false;
    result.done.then(() => { settled = true; }, () => { settled = true; });
    const code = file.includes("notification") ? 0 : 1;
    child.emit("exit", code);
    await Promise.resolve();
    assert.equal(settled, false, "exit does not prove stderr/stdout drained");
    assert.equal(tracked.size, 1, "retain the child until stream completion");
    child.stdout.emit("data", "synthetic final output\n");
    child.stderr.emit("data", "Directory access denied\n");
    child.emit("close", code);
    const actual = await result.done;
    if (typeof actual === "string") {
      assert.equal(actual, "synthetic final output\n");
    } else {
      assert.equal(actual.code, code);
      assert.equal(actual.output, "synthetic final output\n");
      assert.equal(actual.error, "Directory access denied\n");
    }
    assert.equal(tracked.size, 0);
  });

  test(`${file}: spawn failure remains rejected`, async () => {
    const { child, result } = fixture(file, args);
    const rejection = assert.rejects(result.done, /synthetic startup failure/);
    child.emit("error", new Error("synthetic startup failure"));
    child.emit("close", null);
    await rejection;
  });
}

test("notification failure retains final stderr instead of an empty error", async () => {
  const { child, result } = fixture("run-notification-delivery-sql.mjs", ["select 1"]);
  const rejection = assert.rejects(result.done, /Synthetic psql failed \(1\): final synthetic denial/);
  child.emit("exit", 1);
  child.stderr.emit("data", "final synthetic denial");
  child.emit("close", 1);
  await rejection;
});
