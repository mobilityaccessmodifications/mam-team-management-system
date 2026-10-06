import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { command, postgresEnv, sql, target } from "../scripts/local-test-postgres.mjs";

const [socket, database] = process.argv.slice(2);
const ids = [1, 2, 3].map((n) => `93000000-0000-4000-8000-${String(n).padStart(12, "0")}`);
command("psql", [...target(socket, database), "-f", "tests/directory-role-concurrency-setup.sql"]);
let counter = 0;
const sessions = new Set();
function session(actor, statement, hold = false) {
  const app = `directory_role_test_${process.pid}_${++counter}`;
  const child = spawn("psql", [...target(socket, database), "-X", "-Atq", "-v", "ON_ERROR_STOP=1"], {
    env: { ...postgresEnv, PGAPPNAME: app }, stdio: ["pipe", "pipe", "pipe"],
  });
  sessions.add(child);
  let output = "", error = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { error += chunk; });
  const done = new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => {
      sessions.delete(child);
      resolve({ code, output, error });
    });
  });
  child.stdin.write(`begin; set statement_timeout='10s'; set local role authenticated;
    select set_config('request.jwt.claim.sub','${actor}',true);
    select set_config('request.jwt.claims',jsonb_build_object('sub','${actor}',
      'iat',extract(epoch from clock_timestamp())::bigint,'is_anonymous',false)::text,true);
    ${statement}\n`);
  if (!hold) child.stdin.end("commit;\n");
  return { app, child, done, output: () => output };
}
async function until(condition, label) {
  const deadline = Date.now() + 5000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await delay(20);
  }
}
try {
  const first = session(ids[0], `select public.update_employee_directory_role('${ids[2]}','account','employee'); select 'FIRST_HELD';`, true);
  await until(() => first.output().includes("FIRST_HELD"), "first ordinary role transaction");
  const second = session(ids[1], `select public.update_employee_directory_role('${ids[2]}','admin','employee');`);
  await until(() => sql(socket, database, `select count(*) from pg_stat_activity where application_name='${second.app}' and wait_event_type='Lock';`).trim() === '1',
    "second blocked role writer");
  first.child.stdin.end("commit;\n");
  assert.equal((await first.done).code, 0, "first role write commits");
  const result = await second.done;
  assert.notEqual(result.code, 0, "stale ordinary role writer cannot overwrite committed role");
  assert.match(result.error, /Role has changed/);
  const protectedResults = await Promise.all([
    session(ids[0], `select public.update_employee_directory_role('${ids[1]}','employee','system_admin');`).done,
    session(ids[1], `select public.update_employee_directory_role('${ids[0]}','employee','system_admin');`).done,
  ]);
  for (const protectedResult of protectedResults) {
    assert.notEqual(protectedResult.code, 0);
    assert.match(protectedResult.error, /System Admin accounts cannot be changed/);
  }
  assert.equal(sql(socket, database, `select count(*) from public.profiles where id in ('${ids[0]}','${ids[1]}') and app_role='system_admin';`).trim(), "2");
  sql(socket, database, `begin;
    select set_config('request.jwt.claim.sub','${ids[0]}',true);
    select set_config('request.jwt.claims',jsonb_build_object('sub','${ids[0]}',
      'iat',extract(epoch from clock_timestamp())::bigint,'is_anonymous',false)::text,true);
    update public.profiles set account_status='disabled',disabled_at=now() where id='${ids[1]}';
    commit;`);
  const stale = session(ids[1], `select public.update_employee_directory_role('${ids[2]}','manager','account');`);
  const staleResult = await stale.done;
  assert.notEqual(staleResult.code, 0, "disabled P0 cannot modify other roles");
  assert.match(staleResult.error, /Directory access denied/);
  console.log("PASS: two-session ordinary-role CAS, immutable P0, and disabled caller rejection");
} finally {
  for (const child of sessions) { child.stdin.end("rollback;\n"); child.kill("SIGTERM"); }
}
