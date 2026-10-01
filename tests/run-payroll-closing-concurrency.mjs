import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { command, postgresEnv, sql, target } from '../scripts/local-test-postgres.mjs';
const [socket, database] = process.argv.slice(2);
command('psql', [...target(socket, database), '-c', 'begin', '-f', 'tests/payroll-closing-setup.sql', '-c', 'create table if not exists private.portal_account_test_sessions(target_user_id uuid,auth_session_id uuid,activated_at timestamptz,revoked_at timestamptz,session_expires_at timestamptz);', '-c', 'commit']);
const payloadFunction = readFileSync('tests/payroll-closing-setup.sql', 'utf8').split('create function pg_temp.closing_payload()')[1];
const admin = '96000000-0000-4000-8000-000000000001', person = '96000000-0000-4000-8000-000000000003';
const children = new Set(); let counter = 0;
function session(statement, { hold = false, actor = admin } = {}) {
  const app = `payroll_closing_${process.pid}_${++counter}`;
  const child = spawn('psql', [...target(socket, database), '-Atq', '-v', 'VERBOSITY=verbose'], { env: { ...postgresEnv, PGAPPNAME: app }, stdio: ['pipe', 'pipe', 'pipe'] });
  children.add(child); let output = '', error = '';
  child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { error += chunk; });
  const done = new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', code => { children.delete(child); resolve({ code, output, error }); }); });
  child.stdin.write(`begin; set local statement_timeout='5s';
    select set_config('request.jwt.claim.sub','${actor}',true);
    select set_config('request.jwt.claims',jsonb_build_object('sub','${actor}','iat',extract(epoch from clock_timestamp())::bigint,'is_anonymous',false)::text,true);
    create function pg_temp.closing_payload()${payloadFunction}
    ${statement}\n`);
  if (!hold) child.stdin.end('rollback;\n');
  return { app, child, done, output: () => output };
}
async function until(condition) { const deadline = Date.now() + 4000; while (!condition()) { assert.ok(Date.now() < deadline, 'Session readiness deadline'); await delay(20); } }
try {
  for (const [name, statement] of [
    ['request', `update public.leave_requests set reason='Synthetic nonfinancial change' where id='96000000-0000-4000-8000-000000000013';`],
    ['daily review', `select public.review_employee_leave_accrual_day('${person}','2026-09-23',7.6,7.6,7.6,0,'Synthetic concurrent review');`],
    ['manual balance', `select public.set_employee_annual_leave_balance('${person}',201,'2026-09-01',false);`],
    ['live session guard dependency', 'lock table private.portal_account_test_sessions in row exclusive mode;'],
    ['late audit lock', 'lock table private.sick_leave_balance_history in row exclusive mode;'],
    ['import-shaped writer', `update private.employee_sick_leave_balances set hours=81 where person_id='${person}';`],
  ]) {
    const writer = session(`${statement} select 'HELD';`, { hold: true });
    await until(() => writer.output().includes('HELD'));
    const start = Date.now();
    const closing = await session(`select public.reconcile_payroll_closing('concurrent-${name}',pg_temp.closing_payload());`).done;
    assert.notEqual(closing.code, 0, `${name}: closing must reject contention`);
    assert.match(closing.error, /55P03/);
    assert.ok(Date.now() - start < 2000, `${name}: bounded NOWAIT failure`);
    const denied = await session(`select public.reconcile_payroll_closing('unauthorized', '{}'::jsonb);`, { actor: person }).done;
    assert.match(denied.error, /42501/, 'Authority must be checked before locks');
    writer.child.stdin.end(`update public.leave_requests set reason='Synthetic ordinary writer continues' where id='96000000-0000-4000-8000-000000000013'; rollback;\n`);
    assert.equal((await writer.done).code, 0, `${name}: ordinary writer must not become a deadlock victim`);
    assert.equal(sql(socket, database, 'select count(*) from private.payroll_closing_receipts;').trim(), '0');
  }
  const closing = session("select public.reconcile_payroll_closing('closing-first',pg_temp.closing_payload()); select 'HELD';", { hold: true });
  await until(() => closing.output().includes('HELD'));
  const writer = session("update public.leave_requests set reason='Synthetic unrelated edit' where id='96000000-0000-4000-8000-000000000013';");
  await until(() => sql(socket, database, `select count(*) from pg_stat_activity where application_name='${writer.app}' and wait_event_type='Lock';`).trim() === '1');
  closing.child.stdin.end('commit;\n'); assert.equal((await closing.done).code, 0);
  assert.equal((await writer.done).code, 0, 'Waiting nonfinancial writer can finish after closing');
  assert.equal(sql(socket, database, 'select count(*) from private.payroll_closing_receipts;').trim(), '1');
  console.log('PASS: actual two-session closing/request/day-review/manual/audit/import-shaped contention; authority before locks; no ordinary-writer deadlocks');
} finally { for (const child of children) { child.stdin.end('rollback;\n'); child.kill('SIGTERM'); } }
