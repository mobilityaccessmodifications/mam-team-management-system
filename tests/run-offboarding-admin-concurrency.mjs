import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { command, postgresEnv, sql, target } from "../scripts/local-test-postgres.mjs";

const [socket, database] = process.argv.slice(2);
const ids = [1, 2].map((n) => `94000000-0000-4000-8000-${String(n).padStart(12, "0")}`);
command("psql", [...target(socket, database), "-f", "tests/offboarding-admin-concurrency-setup.sql"]);
const sessions = new Set();
let serial = 0;
function session(statement, actor, hold = false) {
  const app = `offboarding_admin_test_${process.pid}_${++serial}`;
  const child = spawn("psql", [...target(socket, database), "-Atq"], {
    env: { ...postgresEnv, PGAPPNAME: app }, stdio: ["pipe", "pipe", "pipe"],
  });
  sessions.add(child);
  let output = "", error = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { error += chunk; });
  const done = new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => { sessions.delete(child); resolve({ code, output, error }); });
  });
  child.stdin.write(`begin; set statement_timeout='10s'; ${actor ? `set local role authenticated;
    select set_config('request.jwt.claim.sub','${actor}',true);
    select set_config('request.jwt.claims',jsonb_build_object('sub','${actor}',
      'iat',extract(epoch from clock_timestamp())::bigint,'is_anonymous',false)::text,true);` : "set local role service_role;"}
    ${statement}\n`);
  if (!hold) child.stdin.end("commit;\n");
  return { app, child, done, output: () => output };
}
async function until(check, label) {
  const deadline = Date.now() + 5000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await delay(25);
  }
}
function activity(app) {
  return sql(socket, database, `select coalesce(wait_event_type,'')||':'||coalesce(wait_event,'') from pg_stat_activity where application_name='${app}' and state='active';`).trim();
}
try {
  const demotion = session(`select public.update_employee_directory_role('${ids[1]}','employee','system_admin'); select 'DEMOTION_HELD';`, ids[0], true);
  await until(() => demotion.output().includes("DEMOTION_HELD"), "held role change");
  const offboard = session(`select public.run_scheduled_employee_offboarding('${ids[0]}','2020-01-02 00:00:00+00');`, null);
  await until(() => activity(offboard.app).startsWith("Lock:"), "concurrent offboarding lock wait");
  try {
    assert.equal(activity(offboard.app), "Lock:advisory", "offboarding must acquire the role-control lock before inspecting the target profile");
  } finally {
    demotion.child.stdin.end("commit;\n");
  }
  assert.equal((await demotion.done).code, 0);
  const result = await offboard.done;
  assert.notEqual(result.code, 0, `offboarding must reject the remaining administrator: ${JSON.stringify(result)}`);
  assert.match(result.error, /last active account administrator cannot be disabled/);
  assert.equal(sql(socket, database, `select count(*) from public.profiles where id in ('${ids[0]}','${ids[1]}') and app_role='system_admin' and account_status='active';`).trim(), "1");
  assert.equal(sql(socket, database, `select is_active from public.internal_org_people where id='${ids[0]}';`).trim(), "t");
  console.log("PASS: role change and offboarding share advisory serialization; last administrator survives");
} finally {
  for (const child of sessions) { child.stdin.end("rollback;\n"); child.kill("SIGTERM"); }
}
