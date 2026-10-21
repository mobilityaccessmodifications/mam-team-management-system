import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { command, postgresEnv, sql, target } from '../scripts/local-test-postgres.mjs';
import { runSubscriptionAuthorityConcurrency } from './helpers/unified-role-subscription-concurrency.mjs';

const [socket, database] = process.argv.slice(2);
command('psql', [...target(socket, database), '-f', 'tests/unified-role-concurrency-setup.sql']);
const id = (n) => `a1000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const sessions = new Set();
let counter = 0;
function session(actor, statement, hold = false, asOwner = false, serializable = false) {
  const app = `unified_role_${process.pid}_${++counter}`;
  const child = spawn('psql', [...target(socket, database), '-v', 'VERBOSITY=verbose', '-Atq'], {
    env: { ...postgresEnv, PGAPPNAME: app }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  sessions.add(child);
  let output = '', error = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { error += chunk; });
  const done = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('exit', (code) => { sessions.delete(child); resolve({ code, output, error }); });
  });
  child.stdin.write(`begin${serializable ? ' isolation level serializable' : ''}; set statement_timeout='8s'; ${asOwner ? '' : 'set local role authenticated;'}
    select set_config('request.jwt.claim.sub','${actor ?? ''}',true);
    select set_config('request.jwt.claims',${actor ? `jsonb_build_object('sub','${actor}',
      'iat',extract(epoch from clock_timestamp())::bigint,'is_anonymous',false,
      'app_metadata',jsonb_build_object('org_role','system_admin'))::text` : `'{}'`},true);
    ${statement}\n`);
  if (!hold) child.stdin.end('commit;\n');
  return { app, child, done, output: () => output };
}
async function until(condition, label) {
  const deadline = Date.now() + 5000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await delay(20);
  }
}
async function blocked(connection) {
  await until(() => sql(socket, database,
    `select count(*) from pg_stat_activity where application_name='${connection.app}' and wait_event_type='Lock';`).trim() === '1',
  `blocked PostgreSQL session ${connection.app}`);
}
async function reject(connection, pattern) {
  const result = await connection.done;
  assert.notEqual(result.code, 0, 'Operation is denied');
  assert.match(result.error, pattern);
}
try {
  if (!process.argv.includes('--subscription-only')) {
  const resetVersion = sql(socket, database, `select account_version from public.profiles where id='${id(1)}';`).trim();
  const resetting = session(id(4), `select public.begin_portal_password_reset('${id(1)}','${id(1)}',${resetVersion}); select 'RESET_HELD';`, true);
  await until(() => resetting.output().includes('RESET_HELD'), 'durable reset claim held before commit');
  for (const actor of [id(1), id(2), id(3), id(4)]) {
    await reject(session(actor, `set statement_timeout='700ms'; select public.update_employee_directory_role('${id(1)}','account','employee');`), /42501: Directory access denied/);
  }
  const resetRole = session(id(9), `select public.update_employee_directory_role('${id(1)}','account','employee');`);
  await blocked(resetRole);
  const personProbe = await session(null, `select id from public.internal_org_people where id='${id(1)}' for share nowait;`, false, true).done;
  assert.equal(personProbe.code, 0, 'Role edit must wait on the account/credential fence before locking its target person');
  resetting.child.stdin.end('commit;\n');
  assert.equal((await resetting.done).code, 0);
  await reject(resetRole, /55000: A password reset is in progress\. Resolve it before changing this role\./);
  assert.equal(sql(socket, database, `select app_role from public.profiles where id='${id(1)}';`).trim(), 'employee');
  assert.equal(sql(socket, database, `select count(*) from private.employee_directory_audit_events where person_id='${id(1)}' and changed_fields=array['app_role']::text[];`).trim(), '0');
  const resetToken = sql(socket, database, `select reset_token from private.portal_password_reset_claims where auth_user_id='${id(1)}' and status='pending';`).trim();
  assert.match(resetToken, /^[0-9a-f-]{36}$/);
  const cancelled = await session(id(4), `select public.cancel_portal_password_reset('${id(1)}','${resetToken}');`).done;
  assert.equal(cancelled.code, 0, cancelled.error);
  assert.equal(sql(socket, database, `select status from private.portal_password_reset_claims where auth_user_id='${id(1)}';`).trim(), 'cancelled');
  console.log('PASS: reset-before-role holds the account fence before target locks and rejects the role without deadlock, takeover or audit');

  const heldDelivery = session(null, `select id from private.employee_onboarding_credentials where person_id='${id(3)}' for update; select 'DELIVERY_HELD';`, true, true);
  await until(() => heldDelivery.output().includes('DELIVERY_HELD'), 'target credential fence');
  const credentialRole = session(id(9), `select public.update_employee_directory_role('${id(3)}','employee','account');`);
  await blocked(credentialRole);
  const credentialTargetProbe = await session(null, `select id from public.internal_org_people where id='${id(3)}' for share nowait; select id from public.profiles where id='${id(3)}' for share nowait;`, false, true).done;
  assert.equal(credentialTargetProbe.code, 0, 'Role edit must wait on the credential fence before either target person or target profile lock');
  heldDelivery.child.stdin.end('rollback;\n');
  assert.equal((await heldDelivery.done).code, 0);
  const credentialRoleResult = await credentialRole.done;
  assert.equal(credentialRoleResult.code, 0, credentialRoleResult.error);
  assert.equal(sql(socket, database, `select count(*) from private.employee_directory_audit_events where person_id='${id(3)}' and actor_user_id='${id(9)}' and changed_fields=array['app_role']::text[];`).trim(), '1');
  console.log('PASS: role mutation waits on credential delivery before locking either target row');

  const roleBeforeReset = session(id(9), `select public.update_employee_directory_role('${id(2)}','employee','manager'); select 'ROLE_BEFORE_RESET_HELD';`, true);
  await until(() => roleBeforeReset.output().includes('ROLE_BEFORE_RESET_HELD'), 'role-first CAS held before reset');
  const roleFirstVersion = sql(socket, database, `select account_version from public.profiles where id='${id(2)}';`).trim();
  const queuedReset = session(id(4), `select public.begin_portal_password_reset('${id(2)}','${id(2)}',${roleFirstVersion});`);
  await blocked(queuedReset);
  assert.equal(sql(socket, database, `select count(*) from private.portal_password_reset_claims where auth_user_id='${id(2)}';`).trim(), '0', 'Reset waits before creating its durable claim');
  roleBeforeReset.child.stdin.end('commit;\n');
  assert.equal((await roleBeforeReset.done).code, 0);
  const queuedResetResult = await queuedReset.done;
  assert.equal(queuedResetResult.code, 0, queuedResetResult.error);
  assert.equal(sql(socket, database, `select app_role from public.profiles where id='${id(2)}';`).trim(), 'employee');
  assert.equal(sql(socket, database, `select count(*) from private.employee_directory_audit_events where person_id='${id(2)}' and actor_user_id='${id(9)}' and changed_fields=array['app_role']::text[];`).trim(), '1');
  const roleFirstClaim = sql(socket, database, `select to_jsonb(c) from private.portal_password_reset_claims c where auth_user_id='${id(2)}';`).trim();
  assert.equal(JSON.parse(roleFirstClaim).status, 'pending');
  await reject(session(id(5), `select public.update_employee_directory_role('${id(2)}','account','employee');`), /A password reset is in progress\. Resolve it before changing this role\./);
  assert.equal(sql(socket, database, `select to_jsonb(c) from private.portal_password_reset_claims c where auth_user_id='${id(2)}';`).trim(), roleFirstClaim, 'Later role mutation never takes over or changes the queued reset');
  assert.equal(sql(socket, database, `select count(*) from private.employee_directory_audit_events where person_id='${id(2)}' and changed_fields=array['app_role']::text[];`).trim(), '1');
  const resolveQueuedReset = await session(id(4), `select public.cancel_portal_password_reset('${id(2)}','${JSON.parse(roleFirstClaim).reset_token}');`).done;
  assert.equal(resolveQueuedReset.code, 0, resolveQueuedReset.error);
  console.log('PASS: role-before-reset commits one audited CAS, then reset claims safely and fences later role edits');

  const first = session(id(9), `select public.update_employee_directory_role('${id(1)}','account','employee'); select 'FIRST_HELD';`, true);
  await until(() => first.output().includes('FIRST_HELD'), 'first ordinary role CAS');
  const second = session(id(5), `select public.update_employee_directory_role('${id(1)}','admin','employee');`);
  await blocked(second);
  first.child.stdin.end('commit;\n');
  assert.equal((await first.done).code, 0);
  await reject(second, /PT409: Role has changed\. Refresh and try again\./);
  assert.equal(sql(socket, database, `select app_role from public.profiles where id='${id(1)}';`).trim(), 'account');
  assert.equal(sql(socket, database, `select count(*) from private.employee_directory_audit_events where person_id='${id(1)}' and changed_fields=array['app_role']::text[];`).trim(), '1');
  await reject(session(id(9), `select public.update_employee_directory_role('${id(5)}','employee','system_admin');`), /System Admin accounts cannot be changed/);
  assert.equal(sql(socket, database, `select count(*) from public.profiles where id in ('${id(5)}','${id(9)}') and app_role='system_admin';`).trim(), '2');
  console.log('PASS: simultaneous ordinary-role CAS writes serialize; immutable linked/standalone P0 and one real-actor audit');

  const serializationLoser = session(id(5), `select public.get_portal_role_capabilities('${id(8)}'); select 'SERIALIZABLE_SNAPSHOT_HELD';`, true, false, true);
  await until(() => serializationLoser.output().includes('SERIALIZABLE_SNAPSHOT_HELD'), 'real serializable pre-write snapshot');
  const serializationWinner = await session(id(9), `select public.update_employee_directory_role('${id(8)}','manager','employee');`).done;
  assert.equal(serializationWinner.code, 0, serializationWinner.error);
  serializationLoser.child.stdin.end(`select public.update_employee_directory_role('${id(8)}','account','employee'); commit;\n`);
  await reject(serializationLoser, /40001: could not serialize access due to concurrent update/);
  assert.equal(sql(socket, database, `select app_role from public.profiles where id='${id(8)}';`).trim(), 'manager');
  assert.equal(sql(socket, database, `select count(*) from private.employee_directory_audit_events where person_id='${id(8)}' and actor_user_id='${id(9)}' and changed_fields=array['app_role']::text[];`).trim(), '1');
  console.log('PASS: genuine PostgreSQL serialization remains 40001, separate from semantic PT409 and with one winner audit');

  const demote = session(id(9), `select public.update_employee_directory_role('${id(15)}','account','manager'); select 'DEMOTION_HELD';`, true);
  await until(() => demote.output().includes('DEMOTION_HELD'), 'Manager demotion lock');
  const grant = session(id(5), `select public.replace_subscription_management_delegates(array['${id(15)}']::uuid[]);`);
  await blocked(grant);
  demote.child.stdin.end('commit;\n');
  assert.equal((await demote.done).code, 0);
  await reject(grant, /Choose active linked Managers/);
  const read = session(id(15), `select public.can_manage_subscriptions(); select public.can_manage_subscription_credentials();`);
  const result = await read.done;
  assert.equal(result.code, 0);
  assert.match(result.output, /f\nf\n/);
  console.log('PASS: role demotion invalidates stale register/vault grants and a queued delegate replacement re-authorizes');

  const replace = session(id(9), `select public.replace_subscription_management_delegates(array['${id(14)}']::uuid[]); select 'REPLACEMENT_HELD';`, true);
  await until(() => replace.output().includes('REPLACEMENT_HELD'), 'delegate replacement locks');
  const nextDemote = session(id(5), `select public.update_employee_directory_role('${id(14)}','employee','manager');`);
  await blocked(nextDemote);
  replace.child.stdin.end('commit;\n');
  assert.equal((await replace.done).code, 0);
  assert.equal((await nextDemote.done).code, 0);
  assert.equal(sql(socket, database, `select can_manage_subscriptions from private.portal_role_policy('${id(14)}');`).trim(), 'f');
  assert.equal(sql(socket, database, `select count(*) from private.subscription_management_grants where person_id='${id(14)}';`).trim(), '1');
  console.log('PASS: replacement-before-demotion preserves grant history but cannot preserve effective privileges');

  const actorDisable = session(id(5), `update public.profiles set account_status='disabled',disabled_at=now() where id='${id(9)}'; select 'ACTOR_DISABLE_HELD';`, true, true);
  await until(() => actorDisable.output().includes('ACTOR_DISABLE_HELD'), 'pending actor disable');
  const pending = session(id(9), `select public.replace_subscription_credential_access_grants(array['${id(16)}']::uuid[]);`);
  await blocked(pending);
  actorDisable.child.stdin.end('commit;\n');
  assert.equal((await actorDisable.done).code, 0);
  await reject(pending, /Only System Admin/);
  const actorRestored = await session(id(5), `update public.profiles set account_status='active',disabled_at=null where id='${id(9)}';`, false, true).done;
  assert.equal(actorRestored.code, 0, actorRestored.error);
  console.log('PASS: P0 disabled while waiting on actor lock cannot finish subscription configuration');

  const batch = sql(socket, database, `select id from private.payroll_balance_import_batches where uploaded_by='${id(6)}' limit 1;`).trim();
  assert.match(batch, /^[0-9a-f-]{36}$/);
  const heldBatch = session(null, `select id from private.payroll_balance_import_batches where id='${batch}' for update; select 'BATCH_HELD';`, true, true);
  await until(() => heldBatch.output().includes('BATCH_HELD'), 'late payroll batch lock');
  const commit = session(id(6), `set statement_timeout='700ms'; select public.commit_payroll_balance_import('${batch}',1);`);
  await reject(commit, /Not authorised/);
  heldBatch.child.stdin.end('rollback;\n');
  assert.equal((await heldBatch.done).code, 0);
  console.log('PASS: Account commit rejects before waiting on immutable payroll batch lock');

  sql(socket, database, `insert into auth.users(id,email,email_confirmed_at) values('${id(17)}','synthetic-provision@example.test',now());
    insert into public.internal_org_people(id,full_name,company_key,position_title) values('${id(17)}','Synthetic New Starter','mam','Synthetic');`);
  const newPersonLock = session(null, `select id from public.internal_org_people where id='${id(17)}' for update; select 'PERSON_HELD';`, true, true);
  await until(() => newPersonLock.output().includes('PERSON_HELD'), 'provision target lock');
  const provisioning = session(id(4), `select public.create_portal_account('${id(17)}','${id(17)}','synthetic-provision','employee',1);`);
  await blocked(provisioning);
  const demotedProvisioner = session(id(9), `select public.update_employee_directory_role('${id(4)}','employee','admin');`);
  await until(() => sql(socket, database, `select app_role from public.profiles where id='${id(4)}';`).trim() === 'employee' || sql(socket, database,
    `select count(*) from pg_stat_activity where application_name='${demotedProvisioner.app}' and wait_event_type='Lock';`).trim() === '1', 'provision actor reauthorization');
  const demotionFirst = sql(socket, database, `select app_role from public.profiles where id='${id(4)}';`).trim() === 'employee';
  newPersonLock.child.stdin.end('rollback;\n');
  assert.equal((await newPersonLock.done).code, 0);
  const provisionResult = await provisioning.done;
  if (!demotionFirst) {
    assert.equal(provisionResult.code, 0, provisionResult.error);
    const demoteResult = await demotedProvisioner.done;
    assert.equal(demoteResult.code, 0, demoteResult.error);
    assert.equal(sql(socket, database, `select count(*) from private.portal_account_admin_events where target_user_id='${id(17)}' and actor_user_id='${id(4)}';`).trim(), '1');
    console.log('PASS: authorized provisioning locks its actor through commit before concurrent demotion');
  } else {
    assert.match(provisionResult.error, /account administrator/);
    const demoteResult = await demotedProvisioner.done;
    assert.equal(demoteResult.code, 0, demoteResult.error);
    assert.equal(sql(socket, database, `select count(*) from private.portal_account_admin_events where target_user_id='${id(17)}';`).trim(), '0');
    console.log('PASS: demoted provisioning actor cannot finish a queued account creation');
  }
  assert.equal(sql(socket, database, `select app_role from public.profiles where id='${id(4)}';`).trim(), 'employee');
  }
  await runSubscriptionAuthorityConcurrency(socket,database);
} finally {
  for (const child of sessions) { child.stdin.end('rollback;\n'); child.kill('SIGTERM'); }
}