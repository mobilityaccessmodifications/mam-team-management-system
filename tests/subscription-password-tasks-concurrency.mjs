import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { command, postgresEnv, sql, target } from '../scripts/local-test-postgres.mjs';

const [socket, predecessor] = process.argv.slice(2);
target(socket, predecessor);
const database = `mam_test_password_race_${process.pid}`;
command('createdb', ['-h', socket, '-p', '55439', '-U', 'postgres', `--template=${predecessor}`, database]);
const firstActor = 'a1000000-0000-4000-8000-000000000001';
const secondActor = 'a1000000-0000-4000-8000-000000000015';
const p0 = 'a1000000-0000-4000-8000-000000000009';
const sessions = new Set();
let counter = 0;
const claims = actor => `select set_config('request.jwt.claim.sub','${actor}',true); select set_config('request.jwt.claims',jsonb_build_object('sub','${actor}','iat',extract(epoch from clock_timestamp())::bigint,'is_anonymous',false)::text,true);`;
function connection(actor, statement, hold = false, owner = false) {
  const app = `password_race_${process.pid}_${++counter}`;
  const child = spawn('psql', [...target(socket, database), '-Atq', '-v', 'VERBOSITY=verbose'], { env: { ...postgresEnv, PGAPPNAME: app } });
  sessions.add(child);
  let output = '', error = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { error += chunk; });
  const done = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('exit', code => { sessions.delete(child); resolve({ code, output, error }); });
  });
  child.stdin.write(`begin; set statement_timeout='8s'; ${claims(actor)} ${owner ? '' : 'set local role authenticated;'} ${statement}\n`);
  if (!hold) child.stdin.end('commit;\n');
  return { app, child, done, output: () => output };
}
async function until(check, label) {
  const deadline = Date.now() + 5000;
  while (!check()) { assert.ok(Date.now() < deadline, label); await delay(15); }
}
async function waiting(connection, holder) {
  await until(() => sql(socket, database, `select count(*) from pg_stat_activity a where a.application_name='${connection.app}' and a.wait_event_type='Lock' and exists(select 1 from pg_stat_activity b where b.application_name='${holder.app}' and b.pid=any(pg_blocking_pids(a.pid)));`).trim() === '1', 'Expected the real PostgreSQL lock owner');
}
try {
  const fixture = readFileSync('tests/unified-role-fixture.sql', 'utf8').replace('\\ir sql-test-auth.sql', () => readFileSync('tests/sql-test-auth.sql', 'utf8'));
  const setup = readFileSync('tests/subscription-password-tasks.sql', 'utf8').split('create function pg_temp.expect_password_state')[0].replace('\\set ON_ERROR_STOP on\n', '').replace('\\ir unified-role-fixture.sql', () => fixture);
  sql(socket, database, setup + `${claims(p0)} set local role authenticated;
    select * from public.archive_employee_directory_record('a1000000-0000-4000-8000-000000000008',
      (select person_version from public.get_employee_directory_record_with_archive_visibility('a1000000-0000-4000-8000-000000000008')),
      (select detail_version from public.get_employee_directory_record_with_archive_visibility('a1000000-0000-4000-8000-000000000008')),
      (clock_timestamp() at time zone 'Australia/Melbourne')::date,'Resigned'); commit;`);
  const tasks = JSON.parse(sql(socket, database, 'select jsonb_agg(id order by id) from private.subscription_password_tasks;').trim());
  assert.equal(tasks.length, 2);
  const complete = id => `select public.complete_my_subscription_password_task('${id}',1,true);`;
  const first = connection(firstActor, complete(tasks[0]) + "select 'HELD';", true);
  await until(() => first.output().includes('HELD'), 'First completion holds shared task');
  const second = connection(secondActor, complete(tasks[0]));
  await waiting(second, first);
  first.child.stdin.end('commit;\n');
  assert.equal((await first.done).code, 0);
  const stale = await second.done;
  assert.notEqual(stale.code, 0); assert.match(stale.error, /40001:/);
  assert.equal(sql(socket, database, `select count(*) from private.subscription_password_task_completions where task_id='${tasks[0]}' and actor_user_id='${firstActor}' and task_version=2;`).trim(), '1');
  console.log('PASS: concurrent Register delegates create one audited completion and one stale rejection');

  const revoker = connection(p0, `select public.replace_subscription_management_delegates(array['${secondActor}']::uuid[]); select 'HELD';`, true);
  await until(() => revoker.output().includes('HELD'), 'Revocation holds authority fence');
  const queued = connection(firstActor, complete(tasks[1]));
  await waiting(queued, revoker);
  revoker.child.stdin.end('commit;\n'); assert.equal((await revoker.done).code, 0);
  const denied = await queued.done;
  assert.notEqual(denied.code, 0); assert.match(denied.error, /42501:/);
  assert.equal(sql(socket, database, `select version from private.subscription_password_tasks where id='${tasks[1]}' and completed_at is null;`).trim(), '1');
  assert.equal(sql(socket, database, `select count(*) from private.subscription_password_task_completions where task_id='${tasks[1]}';`).trim(), '0');
  console.log('PASS: queued password completion rechecks current Register delegation and leaves task/audit untouched');
} finally {
  for (const child of sessions) { child.stdin.end('rollback;\n'); child.kill('SIGTERM'); }
}
