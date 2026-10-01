import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { command, postgresEnv, sql, target } from '../scripts/local-test-postgres.mjs';

const [socket, database] = process.argv.slice(2);
const user = '95000000-0000-4000-8000-000000000002';
const admin = '95000000-0000-4000-8000-000000000001';
command('psql', [...target(socket, database), '-f', 'tests/password-reset-credential-setup.sql']);
const sessions = new Set();
let counter = 0;
function session(statement, role = 'authenticated', hold = false) {
  const app = `reset_credential_${process.pid}_${++counter}`;
  const child = spawn('psql', [...target(socket, database), '-Atq'], { env: { ...postgresEnv, PGAPPNAME: app }, stdio: ['pipe','pipe','pipe'] });
  sessions.add(child);
  let output = '', error = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { error += chunk; });
  const done = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', code => { sessions.delete(child); resolve({ code, output, error }); });
  });
  child.stdin.write(`\\set VERBOSITY verbose\nbegin; set statement_timeout='2s'; set local role ${role};
    select set_config('request.jwt.claim.sub','${admin}',true);
    select set_config('request.jwt.claim.role','${role}',true);
    select set_config('request.jwt.claims',jsonb_build_object('sub','${admin}','iat',extract(epoch from clock_timestamp())::bigint,'is_anonymous',false)::text,true);
    ${statement}\n`);
  if (!hold) child.stdin.end('commit;\n');
  return { app, child, done, output: () => output };
}
async function until(condition, label) {
  const deadline = Date.now()+5000;
  while (!condition()) { if (Date.now()>deadline) throw new Error(`Timeout: ${label}`); await delay(20); }
}
function reset() {
  const version = sql(socket, database, `select account_version from public.profiles where id='${user}';`).trim();
  return `select reset_token from public.begin_portal_password_reset('${user}','${user}',${version});`;
}
try {
  if (process.argv[4] === '--profile-lock') {
    const writer = session(`select id from public.profiles where id='${user}' for update; select 'HELD';`, 'postgres', true);
    await until(() => writer.output().includes('HELD'), 'profile writer');
    const result = await session(reset()).done;
    assert.notEqual(result.code, 0);
    assert.match(result.error, /40001/, 'reset must fail closed without waiting behind a profile writer');
    writer.child.stdin.end('commit;\n');
    assert.equal((await writer.done).code, 0);
    assert.equal(sql(socket,database,`select count(*) from private.portal_password_reset_claims where auth_user_id='${user}';`).trim(),'0');
    console.log('PASS: reset does not invert a profile writer lock order');
  } else {
    const first = session(`${reset()} select 'HELD';`, 'authenticated', true);
    await until(() => first.output().includes('HELD'), 'reset claim');
    const worker = await session('select count(*) from public.claim_due_onboarding_credentials(10);','service_role').done;
    assert.equal(worker.code,0,worker.error);
    assert.match(worker.output,/\n0\n/);
    first.child.stdin.end('commit;\n');
    assert.equal((await first.done).code,0);
    const blocked = await session('select count(*) from public.claim_due_onboarding_credentials(10);','service_role').done;
    assert.equal(blocked.code,0,blocked.error);
    assert.match(blocked.output,/\n0\n/);
    const claim = sql(socket,database,`select reset_token from private.portal_password_reset_claims where auth_user_id='${user}';`).trim();
    const final = await session(`select account_version from public.finalise_portal_password_reset('${user}','${user}','${claim}');`).done;
    assert.equal(final.code,0,final.error);
    const winner = session("select count(*) from public.claim_due_onboarding_credentials(10); select 'HELD';",'service_role',true);
    await until(() => winner.output().includes('HELD'),'credential claim');
    const loser = session(reset());
    await until(() => sql(socket,database,`select wait_event_type from pg_stat_activity where application_name='${loser.app}';`).trim()==='Lock','reset waiting on credential row');
    winner.child.stdin.end('commit;\n');
    assert.equal((await winner.done).code,0);
    const denied = await loser.done;
    assert.notEqual(denied.code,0);
    assert.match(denied.error,/55000.*Onboarding credential delivery in progress/);
    assert.equal(sql(socket,database,`select status from private.portal_password_reset_claims where auth_user_id='${user}';`).trim(),'finalised');
    const delivery = sql(socket,database,`select id||','||claim_token from private.employee_onboarding_credentials where auth_user_id='${user}';`).trim().split(',');
    const sending = session(`select public.begin_onboarding_credential_delivery('${delivery[0]}','${delivery[1]}','reset-staff@example.test','reset-staff@example.test',null); select 'HELD';`,'service_role',true);
    await until(() => sending.output().includes('HELD'),'credential begin');
    assert.match(sending.output(), /\nt\n/);
    const resetDuringBegin = session(reset());
    await until(() => sql(socket,database,`select wait_event_type from pg_stat_activity where application_name='${resetDuringBegin.app}';`).trim()==='Lock','reset waiting on sending transaction');
    sending.child.stdin.end('commit;\n');
    assert.equal((await sending.done).code,0);
    const sendingDenied = await resetDuringBegin.done;
    assert.notEqual(sendingDenied.code,0);
    assert.match(sendingDenied.error,/55000.*Onboarding credential delivery in progress/);
    assert.equal(sql(socket,database,`select status from private.employee_onboarding_credentials where auth_user_id='${user}';`).trim(),'sending');
    console.log('PASS: two-session reset-first, credential-claim-first and credential-begin-first interleavings preserve the fence');
  }
} finally {
  for (const child of sessions) { child.stdin.end('rollback;\n'); child.kill('SIGTERM'); }
}
