import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { postgresEnv, sql, target } from '../scripts/local-test-postgres.mjs';

const [socket, database] = process.argv.slice(2);
const user = '97000000-0000-4000-8000-000000000001';
const email = 'recovery-race@example.test';
sql(socket, database, `
  insert into auth.users(id,email,email_confirmed_at) values ('${user}','opaque-recovery@example.test',now());
  insert into public.profiles(id,full_name,app_role,login_name) values ('${user}','Synthetic Recovery Race','employee','${email}');
  insert into public.internal_org_people(id,node_kind,company_key,full_name,position_title,auth_user_id,started_date,is_active)
    values ('${user}','person','mam','Synthetic Recovery Race','Tester','${user}',current_date-1,true);
  insert into private.employee_directory_details(person_id,first_name,work_email) values ('${user}','Synthetic','${email}');
`);
const sessions = new Set();
let sequence = 0;
function session(statement, hold = false) {
  const app = `recovery_race_${process.pid}_${++sequence}`;
  const child = spawn('psql', [...target(socket, database), '-Atq'], {
    env: { ...postgresEnv, PGAPPNAME: app }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  sessions.add(child);
  let output = '', error = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { error += chunk; });
  const done = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', code => { sessions.delete(child); resolve({ code, output, error }); });
  });
  child.stdin.write(`begin; set statement_timeout='10s'; select set_config('request.jwt.claim.role','service_role',true); ${statement}\n`);
  if (!hold) child.stdin.end('commit;\n');
  return { app, child, done, output: () => output };
}
async function until(condition, label) {
  const deadline = Date.now() + 8000;
  while (!condition()) { assert.ok(Date.now() < deadline, label); await delay(20); }
}
try {
  const writer = session(`select pg_advisory_xact_lock(hashtextextended('portal_account:${user}',0));
    update public.profiles set login_name='renamed-recovery@example.test',account_version=account_version+1 where id='${user}';
    select 'HELD';`, true);
  await until(() => writer.output().includes('HELD'), 'account writer did not acquire lock');
  const issuer = session(`select request_id from public.issue_portal_password_recovery('${email}',repeat('7',64));`);
  await until(() => sql(socket, database, `select wait_event_type from pg_stat_activity where application_name='${issuer.app}';`).trim() === 'Lock', 'issuance did not wait behind account writer');
  writer.child.stdin.end('commit;\n');
  assert.equal((await writer.done).code, 0);
  const result = await issuer.done;
  assert.equal(result.code, 0, result.error);
  assert.equal(sql(socket, database, `select r.account_version=p.account_version from private.portal_password_recovery_requests r join public.profiles p on p.id=r.auth_user_id where p.id='${user}';`).trim(), 't');
  assert.equal(sql(socket, database, `begin; select set_config('request.jwt.claim.role','service_role',true); select count(*) from public.begin_portal_password_recovery(repeat('7',64)); commit;`).trim().split('\n').at(-1), '1');
  console.log('PASS: recovery issuance refreshes the account version after waiting for a concurrent login change');
} finally {
  for (const child of sessions) { child.stdin.end('rollback;\n'); child.kill('SIGTERM'); }
}
