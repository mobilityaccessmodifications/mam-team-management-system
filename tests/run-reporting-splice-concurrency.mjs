import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { readFileSync } from 'node:fs';
import { command, postgresEnv, sql, target } from '../scripts/local-test-postgres.mjs';

const [socket, database] = process.argv.slice(2);
const id = n => `a7100000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const fixture = readFileSync('tests/reporting-splice-fixture.sql', 'utf8').replace('\\ir sql-test-auth.sql', `\\ir '${`${process.cwd()}/tests/sql-test-auth.sql`.replaceAll("'", "''")}'`);
sql(socket, database, `begin; ${fixture}
update public.profiles set login_name='splice8@example.test' where id='${id(8)}';
update public.internal_org_people set auth_user_id='${id(8)}',started_date=(clock_timestamp() at time zone 'Australia/Melbourne')::date-1 where id='${id(30)}';
update private.employee_directory_details set work_email='splice8@example.test' where person_id='${id(30)}';
commit;`);
const sessions = new Set();
let serial = 0;
function session(statement, { actor = 1, role = 'postgres', hold = false } = {}) {
  const app = `reporting_splice_${process.pid}_${++serial}`;
  const child = spawn('psql', [...target(socket, database), '-Atq'], { env: { ...postgresEnv, PGAPPNAME: app }, stdio: ['pipe', 'pipe', 'pipe'] });
  sessions.add(child);
  let output = '', error = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { error += chunk; });
  child.stdin.on('error', () => {});
  const done = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', code => { sessions.delete(child); resolve({ code, output, error }); });
  });
  const auth = actor === null
    ? `select set_config('request.jwt.claim.sub','',true); select set_config('request.jwt.claims','{"role":"service_role"}',true); select set_config('request.jwt.claim.role','service_role',true);`
    : `select set_config('request.jwt.claim.sub','${id(actor)}',true); select set_config('request.jwt.claim.role','',true); select set_config('request.jwt.claims',jsonb_build_object('sub','${id(actor)}','iat',extract(epoch from clock_timestamp())::bigint,'is_anonymous',false,'app_metadata',jsonb_build_object('org_role',(select app_role from public.profiles where id='${id(actor)}')))::text,true);`;
  child.stdin.write(`\\set VERBOSITY verbose\nbegin; set local statement_timeout='5s'; ${auth} set local role ${role}; ${statement}\n`);
  if (!hold) child.stdin.end('commit;\n');
  return { app, child, done, output: () => output };
}
async function until(check, label) {
  const deadline = Date.now() + 5000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${label}`);
    await delay(20);
  }
}
const activity = app => sql(socket, database, `select coalesce(wait_event_type,'')||':'||coalesce(wait_event,'') from pg_stat_activity where application_name='${app}' and state='active'`).trim();
const versions = () => JSON.parse(sql(socket, database, `select json_build_array(p.version,d.version) from public.internal_org_people p join private.employee_directory_details d on d.person_id=p.id where p.id='${id(20)}'`));
function archive() {
  const [person, detail] = versions();
  return `select * from public.archive_employee_directory_record('${id(20)}',${person},${detail},'2026-10-12','Resigned');`;
}
function preflight() {
  const [person, detail] = versions();
  return `select public.preflight_employee_removal_reporting_splice('${id(20)}',${person},${detail},'2026-10-12','Resigned');`;
}
const deliveryLock = `select id from private.employee_onboarding_credentials where person_id='${id(30)}' for update;`;
const beginDelivery = `reset role; select id as did,claim_token as token from private.employee_onboarding_credentials where person_id='${id(30)}' \\gset
set local role service_role; select public.begin_onboarding_credential_delivery(:'did',:'token','splice8@example.test','splice8@example.test',null); select 'SENDING';`;
function snapshot() {
  return sql(socket, database, `select encode(extensions.digest(jsonb_build_object('people',(select jsonb_agg(to_jsonb(p) order by id) from public.internal_org_people p),'credentials',(select jsonb_agg(to_jsonb(c) order by id) from private.employee_onboarding_credentials c),'events',(select jsonb_agg(to_jsonb(e) order by id) from private.employee_onboarding_credential_events e),'audits',(select jsonb_agg(to_jsonb(a) order by id) from private.employee_directory_audit_events a),'profiles',(select jsonb_agg(to_jsonb(p) order by id) from public.profiles p))::text,'sha256'),'hex')`).trim();
}
async function denyReporting(statement = archive(), actor = 1) {
  const before = snapshot();
  const result = await session(statement, { actor, role: 'authenticated' }).done;
  assert.notEqual(result.code, 0);
  assert.match(result.error, /55000.*Onboarding credential delivery in progress/);
  assert.doesNotMatch(result.error, /40P01|57014/, 'NOWAIT denial must not be a deadlock or timeout');
  assert.equal(snapshot(), before, 'Failed reporter leaves complete graph, accounts, delivery/events and reporting audit unchanged');
}
try {
  const worker = session("select count(*) from public.claim_due_onboarding_credentials(10); select 'DELIVERY_HELD';", { actor: null, role: 'service_role', hold: true });
  await until(() => worker.output().includes('DELIVERY_HELD'), 'worker owns uncommitted delivery claim');
  await denyReporting();
  await denyReporting(preflight());
  worker.child.stdin.write(beginDelivery + '\n');
  await until(() => worker.output().includes('SENDING'), 'worker begins after reporters reject');
  worker.child.stdin.end('rollback;\n');
  assert.equal((await worker.done).code, 0);
  console.log('PASS: delivery-first worker claim/begin rejects both archive and preflight NOWAIT without altering its row/events');

  const reporter = session(archive() + " select 'REPORTING_HELD';", { role: 'authenticated', hold: true });
  await until(() => reporter.output().includes('REPORTING_HELD'), 'reporter holds actual complete splice');
  const skipped = await session('select count(*) from public.claim_due_onboarding_credentials(10);', { actor: null, role: 'service_role' }).done;
  assert.equal(skipped.code, 0, skipped.error);
  assert.match(skipped.output, /\n0\n/);
  reporter.child.stdin.end('rollback;\n');
  assert.equal((await reporter.done).code, 0);
  console.log('PASS: reporting-first actual splice makes worker skip its locked delivery row');

  for (const [label, writerSql] of [
    ['child tuple', `update public.internal_org_people set position_title='Synthetic Ordinary Writer' where id='${id(30)}';`],
    ['ancestor tuple', `update public.internal_org_people set position_title='Synthetic Ancestor Writer' where id='${id(10)}';`],
    ['child profile', `update public.profiles set updated_at=clock_timestamp() where id='${id(8)}';`],
  ]) {
    const writer = session(writerSql + " select 'WRITER_HELD';", { hold: true });
    await until(() => writer.output().includes('WRITER_HELD'), label);
    await denyReporting();
    writer.child.stdin.write(deliveryLock + " select pg_advisory_xact_lock(hashtextextended('internal_org_people_hierarchy',0)); select 'OPPOSING_LOCKS_ACQUIRED';\n");
    await until(() => writer.output().includes('OPPOSING_LOCKS_ACQUIRED'), 'ordinary writer proceeds in opposing late delivery/hierarchy order');
    writer.child.stdin.end('rollback;\n');
    const result = await writer.done;
    assert.equal(result.code, 0, result.error);
    console.log(`PASS: ${label} first writer and reporting delivery-first order fail closed without deadlock`);
  }

  const personWriter = session(`update public.internal_org_people set position_title='Synthetic Worker Contention' where id='${id(30)}'; select 'PERSON_HELD';`, { hold: true });
  await until(() => personWriter.output().includes('PERSON_HELD'), 'child writer tuple');
  const queuedWorker = session('select count(*) from public.claim_due_onboarding_credentials(10);\n' + beginDelivery, { actor: null, role: 'service_role', hold: true });
  await until(() => activity(queuedWorker.app).startsWith('Lock:'), 'actual delivery-first begin waiting for child SHARE');
  await denyReporting();
  personWriter.child.stdin.end('rollback;\n');
  assert.equal((await personWriter.done).code, 0);
  await until(() => queuedWorker.output().includes('SENDING'), 'actual waiting worker finishes');
  queuedWorker.child.stdin.end('rollback;\n');
  assert.equal((await queuedWorker.done).code, 0);
  console.log('PASS: actual delivery-before-person SHARE wait cannot draw reporter into a lock inversion');

  const authority = session("select pg_advisory_xact_lock(hashtextextended('mam:directory-role-control',0)); select 'ROLE_HELD';", { hold: true });
  await until(() => authority.output().includes('ROLE_HELD'), 'role authority');
  const queued = session(preflight(), { actor: 2, role: 'authenticated' });
  await until(() => activity(queued.app) === 'Lock:advisory', 'preflight waits at declaration-time role fence');
  const probe = session(`select id from public.internal_org_people where id='${id(20)}' for update nowait;`);
  assert.equal((await probe.done).code, 0, 'Queued authority check must precede target locks');
  authority.child.stdin.end(`update public.profiles set app_role='employee' where id='${id(2)}'; commit;\n`);
  assert.equal((await authority.done).code, 0);
  const denied = await queued.done;
  assert.notEqual(denied.code, 0);
  assert.match(denied.error, /42501/);
  assert.doesNotMatch(denied.error, /40P01|57014/);
  sql(socket, database, `begin; ${readFileSync('tests/sql-test-auth.sql', 'utf8')} select pg_temp.set_test_actor('${id(1)}'); update public.profiles set app_role='admin' where id='${id(2)}'; commit;`);
  console.log('PASS: post-wait demotion is re-authorized before target/reporting resources');

  const hierarchy = session("select pg_advisory_xact_lock(hashtextextended('internal_org_people_hierarchy',0)); select 'HIERARCHY_HELD';", { hold: true });
  await until(() => hierarchy.output().includes('HIERARCHY_HELD'), 'hierarchy lock');
  const current = session(archive(), { role: 'authenticated' });
  await until(() => activity(current.app) === 'Lock:advisory', 'archive waits for current tree');
  hierarchy.child.stdin.end(`insert into public.internal_org_people(id,node_kind,company_key,position_title,parent_id) values('${id(71)}','org_unit','mam','Synthetic Added While Queued','${id(20)}'); commit;\n`);
  assert.equal((await hierarchy.done).code, 0);
  const committed = await current.done;
  assert.equal(committed.code, 0, committed.error);
  assert.equal(sql(socket, database, `select count(*) from public.internal_org_people where id in ('${id(30)}','${id(40)}','${id(50)}','${id(71)}') and parent_id='${id(10)}'`).trim(), '4');
  console.log('PASS: queued removal recomputes the complete child set after hierarchy acquisition');
  console.log('PASS: all eight native reporting-splice concurrency methods completed');
} finally {
  for (const child of sessions) { child.stdin.end('rollback;\n'); child.kill('SIGTERM'); }
}
