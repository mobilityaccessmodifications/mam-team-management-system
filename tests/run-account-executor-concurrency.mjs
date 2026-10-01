// First load tests/portal-account-executor.sql into a fresh disposable DB.
// Example: node tests/run-account-executor-concurrency.mjs --host /private/tmp/mam-accounts-sql-XXXXXX/socket --port 55439 --user accounts_test --database accounts_executor
// CI may use localhost and ACCOUNT_TEST_PASSWORD=synthetic-ci-only. No .env or
// ordinary PG* variables/password/service files are loaded by this harness.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { target as verifyDisposableTarget } from "../scripts/local-test-postgres.mjs";

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i], process.argv[i + 1]);
const host = args.get("--host");
const port = args.get("--port") ?? "5432";
const user = args.get("--user");
const database = args.get("--database");
const sharedLocalCluster = /^mam-openclaw-pg\.[A-Za-z0-9]+$/.test(path.basename(host ?? ""));
if (sharedLocalCluster) {
  verifyDisposableTarget(host, database);
  assert.equal(port, "55439");
  assert.equal(user, "postgres");
}
assert.ok(sharedLocalCluster || ["127.0.0.1", "localhost", "::1"].includes(host) || /^\/(?:private\/)?tmp\/mam-accounts-sql-[A-Za-z0-9]+\/socket$/.test(host ?? ""), "explicit local disposable host required");
assert.match(port, /^\d{1,5}$/);
assert.match(user ?? "", /^[a-z_][a-z_0-9]*$/);
assert.match(database ?? "", /^(accounts_executor(?:_v\d+)?|portal_account_executor_test)$/);
const env = { PATH: process.env.PATH, LANG: "C", PGCONNECT_TIMEOUT: "3", PGPASSFILE: "/dev/null", PGSERVICEFILE: "/dev/null", PGPASSWORD: process.env.ACCOUNT_TEST_PASSWORD ?? "" };
const workers = new Set();

function connection(name, script, keepOpen = false) {
  const child = spawn("psql", ["-X", "-qAt", "-v", "ON_ERROR_STOP=1", "-h", host, "-p", port, "-U", user, "-d", database, "-f", "-"], { env: { ...env, PGAPPNAME: name }, stdio: ["pipe", "pipe", "pipe"] });
  workers.add(child);
  let stdout = "", stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const done = new Promise((resolve, reject) => {
    child.on("error", reject);
    // `exit` can fire before the stdout/stderr pipes have drained. PostgreSQL
    // 16 exposed that race by occasionally resolving with only psql's startup
    // warning and dropping the database error that this test must assert.
    child.on("close", (code) => { workers.delete(child); resolve({ code, stdout, stderr }); });
  });
  child.stdin.write("set statement_timeout = '5s';\n" + script + "\n");
  if (!keepOpen) child.stdin.end();
  async function waitFor(marker) {
    const deadline = Date.now() + 5000;
    while (!stdout.includes(marker)) {
      if (child.exitCode !== null) throw new Error(stderr || "connection ended before " + marker);
      if (Date.now() > deadline) throw new Error("timeout waiting for " + marker);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
  return { child, done, waitFor };
}

async function query(sql) {
  const result = await connection("account-executor-observer", sql).done;
  assert.equal(result.code, 0, result.stderr);
  return result.stdout.trim();
}

async function waitUntilBlocked(name) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (await query("select exists(select 1 from pg_stat_activity where application_name = '" + name + "' and wait_event = 'advisory');") === "t") return;
  }
  throw new Error("second transaction did not block on the operation lock");
}

try {
  // The fixture fingerprint is synthetic and deliberately strict: no generic
  // existing local database may be used merely because its host is localhost.
  assert.equal(await query("select count(*) = 6 and bool_and(email like 'portal-10000000-0000-4000-8000-%@accounts.mobilityaccess.com.au') from auth.users;"), "t");
  const actor = "10000000-0000-4000-8000-000000000001";
  const target = "10000000-0000-4000-8000-000000000005";
  const person = "20000000-0000-4000-8000-000000000005";
  const change = await query("set test.actor = '" + actor + "'; select change_token from public.begin_portal_account_status_change('" + person + "','" + target + "',false,1);");
  assert.match(change, /^[a-f0-9-]{36}$/);
  const executor = randomUUID();
  const claimSql = (token) => "select public.claim_portal_account_status_execution('" + target + "','" + change + "','" + actor + "','" + token + "');";
  const winner = connection("account-executor-winner", "begin;\n" + claimSql(executor) + "\n\\echo winner_granted", true);
  await winner.waitFor("winner_granted");
  const duplicateName = "account-duplicate-" + randomUUID();
  const duplicate = connection(duplicateName, claimSql(randomUUID()));
  await waitUntilBlocked(duplicateName);
  winner.child.stdin.end("commit;\n");
  const [won, lost] = await Promise.all([winner.done, duplicate.done]);
  assert.equal(won.code, 0, won.stderr);
  assert.match(won.stdout, /execute\nwinner_granted/);
  assert.equal(lost.code, 0, lost.stderr);
  assert.equal(lost.stdout.trim(), "executing");
  // Receipt and finalise are separate committed transactions. Replaying
  // completion never acquires a second executor or increments the version twice.
  assert.equal(await query("select public.record_portal_account_status_execution('" + target + "','" + change + "','" + executor + "',true);"), "t");
  for (let i = 0; i < 2; i += 1) {
    assert.equal(await query("set test.actor = '" + actor + "'; select account_version from public.finalise_portal_account_status_change('" + person + "','" + target + "','" + change + "');"), "2");
  }
  console.log("PASS: concurrent sessions grant exactly one executor; durable completion replays once.");

  const orphan = "10000000-0000-4000-8000-000000000007";
  const email = "portal-" + orphan + "@accounts.mobilityaccess.com.au";
  await query("insert into auth.users(id,email) values ('" + orphan + "','" + email + "'); insert into public.profiles(id,account_status) values ('" + orphan + "','active');");
  const cleanup = connection("account-cleanup-winner", "begin; select public.reserve_portal_account_creation_cleanup('" + orphan + "','" + email + "');\n\\echo cleanup_reserved", true);
  await cleanup.waitFor("cleanup_reserved");
  const linkerName = "account-linker-" + randomUUID();
  const linker = connection(linkerName, "insert into public.internal_org_people(id,auth_user_id,node_kind) values ('20000000-0000-4000-8000-000000000007','" + orphan + "','person');");
  await waitUntilBlocked(linkerName);
  cleanup.child.stdin.end("commit;\n");
  const [reserved, link] = await Promise.all([cleanup.done, linker.done]);
  assert.equal(reserved.code, 0, reserved.stderr);
  assert.notEqual(link.code, 0);
  assert.match(link.stderr, /reserved for cleanup/);
  assert.equal(await query("select count(*) from public.internal_org_people where auth_user_id = '" + orphan + "';"), "0");
  console.log("PASS: cleanup reservation prevents a concurrent late linkage before external deletion.");
} finally {
  for (const worker of workers) worker.kill("SIGTERM");
}
