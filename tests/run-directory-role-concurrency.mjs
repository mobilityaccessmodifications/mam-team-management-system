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
    child.on("exit", (code) => {
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
  const first = session(ids[0], `select public.update_employee_directory_role('${ids[1]}','employee','system_admin'); select 'FIRST_HELD';`, true);
  await until(() => first.output().includes("FIRST_HELD"), "first demotion transaction");
  const second = session(ids[1], `select public.update_employee_directory_role('${ids[0]}','employee','system_admin');`);
  await until(() => Number(sql(socket, database, `select count(*) from pg_stat_activity where application_name='${second.app}' and state='active';`).trim()) === 1,
    "second active database session");
  first.child.stdin.end("commit;\n");
  assert.equal((await first.done).code, 0, "first demotion commits");
  const result = await second.done;
  assert.notEqual(result.code, 0, "demoted administrator cannot cross-demote the remaining administrator");
  assert.match(result.error, /Directory access denied/);
  assert.equal(sql(socket, database, `select count(*) from public.profiles where id in ('${ids[0]}','${ids[1]}') and app_role='system_admin';`).trim(), "1");
  const stale = session(ids[1], `select public.update_employee_directory_role('${ids[2]}','manager','employee');`);
  const staleResult = await stale.done;
  assert.notEqual(staleResult.code, 0, "former administrator cannot modify other roles");
  assert.match(staleResult.error, /Directory access denied/);
  console.log("PASS: two-session cross-demotion preserves admin; demoted caller cannot edit another role");
} finally {
  for (const child of sessions) { child.stdin.end("rollback;\n"); child.kill("SIGTERM"); }
}
