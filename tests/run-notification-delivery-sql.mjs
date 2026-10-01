// Only a marked, disposable Unix-socket PostgreSQL cluster. No env files/network.
// Run: node tests/run-notification-delivery-sql.mjs SOCKET mam_test_notification_NAME
// Full-schema coverage separately: scripts/test-migration-replay.mjs SOCKET DB tests/notification-delivery-receipts.sql
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { command, createDatabase, postgresEnv, sql, target } from "../scripts/local-test-postgres.mjs";

const [socket, database] = process.argv.slice(2);
const args = target(socket, database);
createDatabase(socket, database);
sql(socket, database, readFileSync(new URL("./migrations/0001-supabase-platform.sql", import.meta.url), "utf8"));
sql(socket, database, "create schema private;");
sql(socket, database, readFileSync(new URL("../supabase/migrations/20260923010000_durable_notification_delivery_receipts.sql", import.meta.url), "utf8"));
command("psql", [...args, "-f", fileURLToPath(new URL("./notification-delivery-receipts.sql", import.meta.url))]);
console.log("PASS: isolated SQL contract/ACL/gate/legacy/recipient/provider/retention cases");

const q = (value) => `'${String(value).replaceAll("'", "''")}'`;
const key = (n) => `payroll-comparison:20000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
const proof = { accepted: true, messageId: "synthetic-concurrency", requestId: null, statusCode: 202 };
const reserve = (k, legacy = null) => `select public.reserve_notification_delivery(${q(k)},'one@example.test','',${legacy ? q(legacy) : "null"});`;
const confirm = (k, token) => `select public.confirm_notification_delivery(${q(k)},${q(token)}::uuid,'one@example.test','',${q(JSON.stringify(proof))}::jsonb);`;
const parsed = (stdout) => stdout.split("\n").filter((line) => line.startsWith("{")).map((line) => JSON.parse(line));
const service = (query) => sql(socket, database, `set role service_role; ${query}`);
const mutex = "select pg_advisory_xact_lock(hashtextextended('mam_notification_delivery_store_v1',0));";
const recordProof = `update private.notification_delivery_control set legacy_import_sha256=repeat('a',64),
  legacy_import_count=(select count(*) from private.notification_delivery_receipts where state in ('legacy_sent','legacy_unknown')),
  legacy_imported_at=clock_timestamp();`;
let serial = 0;
const active = new Set();

function session(query, { hold = false, role = "service_role" } = {}) {
  const app = `notification_test_${process.pid}_${++serial}`;
  const child = spawn("psql", [...args, "-Atq"], {
    env: { ...postgresEnv, PGAPPNAME: app }, stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "", stderr = "";
  active.add(child);
  child.stdout.on("data", (data) => { stdout += data; });
  child.stderr.on("data", (data) => { stderr += data; });
  const done = new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => {
      active.delete(child);
      if (code !== 0) reject(new Error(`Synthetic psql failed (${code}): ${stderr}`));
      else resolve(stdout);
    });
  });
  // Attach a handler immediately; an assertion still receives the rejection.
  done.catch(() => {});
  child.stdin.write(`set statement_timeout='12s'; set role ${role};\n${query}\n`);
  if (!hold) child.stdin.end();
  return { app, child, done, output: () => stdout };
}

async function until(condition, label) {
  const deadline = Date.now() + 8000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`Timed out observing ${label}`);
    await delay(20);
  }
}
async function holder(query = mutex) {
  const result = session(`begin; ${query} select 'TEST_LOCK_HELD';`, { hold: true, role: "postgres" });
  await until(() => result.output().includes("TEST_LOCK_HELD"), "committed test barrier");
  return result;
}
async function waiting(...clients) {
  await until(() => Number(sql(socket, database, `select count(distinct a.application_name)
    from pg_stat_activity a join pg_locks l on l.pid=a.pid
    where a.application_name in (${clients.map((c) => q(c.app)).join(",")})
      and l.locktype='advisory' and not l.granted;`).trim()) === clients.length,
  "all distinct backend sessions waiting on database mutex");
}
async function release(h, action = "commit") {
  h.child.stdin.end(`${action};\n`);
  await h.done;
}

try {
  sql(socket, database, `${recordProof} select private.set_notification_delivery_ready(true);`);
  // Three truly concurrent DB sessions: two contenders queue behind a real lock.
  let h = await holder();
  const a = session(reserve(key(1))), b = session(reserve(key(1)));
  await waiting(a, b);
  await release(h);
  const race = (await Promise.all([a.done, b.done])).flatMap(parsed);
  assert.equal(race.filter((r) => r.outcome === "send").length, 1);
  assert.equal(race.filter((r) => r.rejectionCode === "delivery-in-flight").length, 1);
  assert.equal(race.filter((r) => "deliveryToken" in r).length, 1);
  const token = race.find((r) => r.outcome === "send").deliveryToken;
  assert.equal(sql(socket, database, `select count(*) from private.notification_delivery_receipts where event_key=${q(key(1))};`).trim(), "1");
  console.log("PASS: simultaneous reserves grant one token only");

  // Ignore the winning response: a new connection cannot recover/regrant its token.
  const lost = parsed(service(reserve(key(1))))[0];
  assert.equal(lost.rejectionCode, "delivery-in-flight");
  assert.equal("deliveryToken" in lost, false);
  sql(socket, database, `update private.notification_delivery_receipts set created_at=clock_timestamp()-interval '21 minutes' where event_key=${q(key(1))};`);
  assert.equal(parsed(service(reserve(key(1))))[0].rejectionCode, "receipt-delivery-unknown");
  assert.equal(parsed(service(confirm(key(1), "00000000-0000-0000-0000-000000000000")))[0].rejectionCode, "receipt-token-mismatch");
  console.log("PASS: lost reserve/timeout never regrant; wrong token cannot confirm");

  // Reserve cannot observe a half-written confirmation; it returns proven evidence.
  h = await holder(confirm(key(1), token));
  const replay = session(reserve(key(1)));
  await waiting(replay);
  await release(h);
  const duplicate = parsed(await replay.done)[0];
  assert.equal(duplicate.outcome, "duplicate");
  assert.deepEqual(duplicate.providerReceipt, proof);
  const confirmed = parsed(service(confirm(key(1), token)))[0];
  assert.equal(confirmed.sent, true);
  assert.equal(confirmed.actualRecipient, "one@example.test");
  console.log("PASS: confirm/reserve serialization and late/idempotent confirmation");

  // Closing cutover while a new reserve is queued fails closed without a row.
  h = await holder("select private.set_notification_delivery_ready(false);");
  const disabled = session(reserve(key(2)));
  await waiting(disabled);
  await release(h);
  assert.equal(parsed(await disabled.done)[0].rejectionCode, "receipt-store-not-ready");
  assert.equal(sql(socket, database, `select count(*) from private.notification_delivery_receipts where event_key=${q(key(2))};`).trim(), "0");
  console.log("PASS: cutover gate serialized with reserve");

  const legacy = "leave:30000000-0000-0000-0000-000000000001:leave-submitted:aaaaaaaaaaaaaaaaaaaaaaaa";
  const childKey = legacy.replace(/a{24}$/, "b".repeat(24));
  const importSql = `select private.import_notification_delivery_legacy(${q(JSON.stringify([{ eventKey: legacy, state: "legacy_sent", at: 1790070000123 }]))}::jsonb);`;
  h = await holder(`${importSql} ${recordProof} select private.set_notification_delivery_ready(true);`);
  const legacyAttempt = session(reserve(childKey, legacy));
  await waiting(legacyAttempt);
  await release(h);
  assert.equal(parsed(await legacyAttempt.done)[0].rejectionCode, "legacy-receipt-reconciliation");
  assert.equal(sql(socket, database, `select count(*) from private.notification_delivery_receipts where event_key=${q(childKey)};`).trim(), "0");
  console.log("PASS: atomic import/activation cannot race into a legacy resend");

  // Import racing import serializes and does not invent tokens/evidence.
  sql(socket, database, "select private.set_notification_delivery_ready(false);");
  const anotherImport = `select private.import_notification_delivery_legacy(${q(JSON.stringify([{ eventKey: key(3), state: "legacy_unknown", at: 1790070000456 }]))}::jsonb);`;
  h = await holder();
  const i1 = session(anotherImport, { role: "postgres" }), i2 = session(anotherImport, { role: "postgres" });
  await waiting(i1, i2);
  await release(h);
  const imports = (await Promise.all([i1.done, i2.done])).flatMap(parsed);
  assert.equal(imports.reduce((sum, r) => sum + r.inserted, 0), 1);
  assert.equal(imports.reduce((sum, r) => sum + r.existing, 0), 1);
  sql(socket, database, `${recordProof} select private.set_notification_delivery_ready(true);`);
  console.log("PASS: concurrent imports preserve one evidence-less tombstone");

  // Cleanup versus duplicate confirmation: no old token can resurrect evidence.
  sql(socket, database, `update private.notification_delivery_receipts set sent_at=clock_timestamp()-interval '91 days' where event_key=${q(key(1))};`);
  h = await holder("select private.minimize_notification_delivery_receipts();");
  const afterCleanup = session(confirm(key(1), token));
  await waiting(afterCleanup);
  await release(h);
  assert.equal(parsed(await afterCleanup.done)[0].rejectionCode, "receipt-evidence-unavailable");
  assert.equal(parsed(service(reserve(key(1))))[0].rejectionCode, "receipt-evidence-unavailable");
  console.log("PASS: retention/confirm race preserves permanent no-resend tombstone");

  // A transaction aborted before returning a committed grant does not poison a key.
  h = await holder(reserve(key(4)));
  const afterRollback = session(reserve(key(4)));
  await waiting(afterRollback);
  await release(h, "rollback");
  assert.equal(parsed(await afterRollback.done)[0].outcome, "send");
  console.log("PASS: reservation transaction rollback is atomic");
  console.log(`PASS: real multi-session notification tests on ${database}`);
} finally {
  for (const child of active) {
    child.stdin.end("rollback;\n");
    child.kill("SIGTERM");
  }
}
