import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { readFileSync } from 'node:fs';
import { sql, target, postgresEnv } from '../scripts/local-test-postgres.mjs';

const [socket, database] = process.argv.slice(2);
target(socket, database);
const admin = 'a1000000-0000-4000-8000-000000000004';
const p0 = 'a1000000-0000-4000-8000-000000000009';
const delegate = 'a1000000-0000-4000-8000-000000000015';
const firstPerson = 'a1000000-0000-4000-8000-000000000001';
const secondPerson = 'a1000000-0000-4000-8000-000000000002';
const archivedPerson = 'a1000000-0000-4000-8000-000000000003';
const id = 'b3500000-0000-4000-8000-000000000001';
const sessions = new Set();
let sequence = 0;
const claims = actor => `select set_config('request.jwt.claim.sub','${actor}',true);select set_config('request.jwt.claims',jsonb_build_object('sub','${actor}','iat',extract(epoch from clock_timestamp())::bigint,'is_anonymous',false)::text,true);`;
const update = (version, members) => `select public.update_subscription_members_v1('${id}',${version},array[${members.map(person => `'${person}'`).join(',')}]::uuid[]);`;

function connection(actor, statement, { hold = false, owner = false } = {}) {
  const application = `subscription_team_${process.pid}_${++sequence}`;
  const child = spawn('psql', [...target(socket, database), '-Atq', '-v', 'VERBOSITY=verbose'], { env: { ...postgresEnv, PGAPPNAME: application } });
  sessions.add(child);
  let output = '', error = '';
  child.stdout.on('data', data => output += data);
  child.stderr.on('data', data => error += data);
  const done = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('exit', code => { sessions.delete(child); resolve({ code, output, error }); });
  });
  child.stdin.write(`begin;set statement_timeout='8s';${claims(actor)}${owner ? '' : 'set local role authenticated;'}${statement}\n`);
  if (!hold) child.stdin.end('commit;\n');
  return { application, child, done, output: () => output };
}
async function until(check, message) {
  const deadline = Date.now() + 5000;
  while (!check()) { assert.ok(Date.now() < deadline, message); await delay(15); }
}
async function waiting(connection) {
  await until(() => sql(socket, database, `select count(*) from pg_stat_activity where application_name='${connection.application}' and wait_event_type='Lock';`).trim() === '1', 'Expected observable PostgreSQL lock wait');
}

try {
  const fixture = readFileSync('tests/unified-role-fixture.sql', 'utf8')
    .replace('\\ir sql-test-auth.sql', () => readFileSync('tests/sql-test-auth.sql', 'utf8'));
  sql(socket, database, fixture + `
    update private.subscription_request_config set enabled=false;
    insert into private.subscription_register(id,subscription_code,service_name,pricing_model,next_review_on,responsible_person_id,company_scope,created_by,updated_by)
    values('${id}','MAM-SUB-998902','Synthetic team concurrency','free','2027-01-01','${admin}','mam','${admin}','${admin}');`);
  const first = connection(admin, `${update(1, [firstPerson])}select 'HELD';`, { hold: true });
  await until(() => first.output().includes('HELD'), 'First membership writer must hold its lock');
  const second = connection(admin, update(1, [secondPerson]));
  await waiting(second);
  first.child.stdin.end('commit;\n');
  assert.equal((await first.done).code, 0);
  const loser = await second.done;
  assert.notEqual(loser.code, 0);
  assert.match(loser.error, /40001:/);
  assert.equal(sql(socket, database, `select string_agg(person_id::text,',') from private.subscription_memberships where subscription_id='${id}';`).trim(), firstPerson);
  assert.equal(sql(socket, database, `select count(*) from private.subscription_audit_events where subscription_id='${id}';`).trim(), '1');
  console.log('PASS: concurrent membership replacements have one winner, exact UUID and one audit event');

  const control = connection(p0, "select pg_advisory_xact_lock(hashtextextended('mam:directory-role-control',0));select 'HELD';", { hold: true, owner: true });
  await until(() => control.output().includes('HELD'), 'Role-control transaction must hold its lock');
  const revoked = connection(delegate, update(2, [secondPerson]));
  await waiting(revoked);
  control.child.stdin.end("set local role authenticated;select public.replace_subscription_management_delegates('{}'::uuid[]);commit;\n");
  assert.equal((await control.done).code, 0);
  assert.match((await revoked.done).error, /42501:/);
  assert.equal(sql(socket, database, `select version from private.subscription_register where id='${id}';`).trim(), '2');
  console.log('PASS: queued membership writer rechecks revoked delegation before any data change');

  const archive = connection(p0, "select pg_advisory_xact_lock(hashtextextended('mam:directory-role-control',0));select 'HELD';", { hold: true, owner: true });
  await until(() => archive.output().includes('HELD'), 'Archive transaction must hold its lock');
  const inactive = connection(admin, update(2, [archivedPerson]));
  await waiting(inactive);
  archive.child.stdin.end(`update public.internal_org_people set is_active=false where id='${archivedPerson}';commit;\n`);
  assert.equal((await archive.done).code, 0);
  assert.match((await inactive.done).error, /23503:/);
  assert.equal(sql(socket, database, `select version from private.subscription_register where id='${id}';`).trim(), '2');
  assert.equal(sql(socket, database, `select count(*) from private.subscription_audit_events where subscription_id='${id}';`).trim(), '1');
  console.log('PASS: queued membership save rejects a newly inactive person without changing assignments or audit');
} finally {
  for (const child of sessions) { child.stdin.end('rollback;\n'); child.kill('SIGTERM'); }
}
