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
  const holder = session(`select pg_advisory_xact_lock(hashtextextended('mam:directory-role-control',0)); select 'CONTROL_HELD';`, null, true);
  await until(() => holder.output().includes('CONTROL_HELD'), 'held role authority');
  const offboards = ids.map(id => session(`select public.run_scheduled_employee_offboarding('${id}','2020-01-02 00:00:00+00');`, null));
  await until(() => offboards.every(s => activity(s.app).startsWith('Lock:')), 'concurrent P0 service offboarding waits');
  for (const queued of offboards) assert.equal(activity(queued.app), 'Lock:advisory', 'worker authority fence precedes target locks');
  holder.child.stdin.end('commit;\n');
  assert.equal((await holder.done).code, 0);
  for (const queued of offboards) {
    const result = await queued.done;
    assert.notEqual(result.code, 0, 'Unattributed service offboarding must reject a current System Admin');
    assert.match(result.error, /System Admin account access denied/);
  }
  assert.equal(sql(socket, database, `select count(*) from public.profiles where id in ('${ids[0]}','${ids[1]}') and app_role='system_admin' and account_status='active';`).trim(), '2');
  assert.equal(sql(socket, database, `select count(*) from public.internal_org_people where id in ('${ids[0]}','${ids[1]}') and is_active;`).trim(), '2');
  assert.equal(sql(socket, database, `select count(*) from private.portal_account_admin_events where target_user_id in ('${ids[0]}','${ids[1]}');`).trim(), '0');
  console.log('PASS: queued service offboarding cannot disable either current P0 without actual P0 authority');
} finally {
  for (const child of sessions) { child.stdin.end("rollback;\n"); child.kill("SIGTERM"); }
}
