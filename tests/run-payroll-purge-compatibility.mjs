import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startCluster, stopCluster, createDatabase, sql, target, command, postgresEnv } from '../scripts/local-test-postgres.mjs';
import { testCompatibilityMigration, testCompatibilityConcurrency } from './payroll-purge-compatibility-migration.mjs';
import { testPurgeConcurrency } from './confirmed-test-purge-concurrency.mjs';

process.chdir(fileURLToPath(new URL('..', import.meta.url)));
const hosted = process.argv.includes('--hosted');
const baseline = process.argv.includes('--baseline');
const sourcePath = baseline ? '/Volumes/UG/MAM/opencode/mam-payroll-reconciliation-release/supabase/migrations/20261001150000_payroll_closing_carryforward.sql' : 'supabase/migrations/20261001150000_payroll_closing_carryforward.sql';
const source = readFileSync(sourcePath, 'utf8');
const sourceSha = createHash('sha256').update(source).digest('hex');
if (baseline) assert.equal(sourceSha, '39427e62a986922231132d94d47ca73a4546b99219707bbb4052c1fb373e983f');
function startHostedCluster() {
  const socket = realpathSync(mkdtempSync(path.join(realpathSync(os.tmpdir()), 'mam-openclaw-pg.')));
  command('initdb', ['-D', path.join(socket, 'data'), '-U', 'mam_fixture_admin', '--auth-local=trust', '--auth-host=reject', '--no-locale', '--encoding=UTF8']);
  writeFileSync(path.join(socket, 'mam-test-cluster.json'), JSON.stringify({ owner: 'mam-local-tests-v1', socket, port: 55439 }));
  command('pg_ctl', ['-D', path.join(socket, 'data'), '-l', path.join(socket, 'postgres.log'), '-o', `-k ${socket} -p 55439 -c listen_addresses='' -c unix_socket_permissions=0700`, '-w', 'start']);
  command('psql', ['-X', '-h', socket, '-p', '55439', '-U', 'mam_fixture_admin', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1'], {
    input: 'create role postgres login nosuperuser createdb createrole replication bypassrls inherit; create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls; grant anon,authenticated,service_role to postgres;'
  });
  return socket;
}
const socket = hosted ? startHostedCluster() : startCluster();
const base = 'mam_test_payroll_purge_predecessor';
const candidate = 'mam_test_payroll_purge_candidate';
const collector = `select prosrc from pg_proc where oid='private.confirmed_test_purge_schema_hash()'::regprocedure;`;
const funcs = `select jsonb_agg(jsonb_build_object('signature',p.oid::regprocedure::text,'definition',pg_get_functiondef(p.oid),'sha',encode(extensions.digest(pg_get_functiondef(p.oid),'sha256'),'hex'),'owner',p.proowner,'acl',p.proacl::text) order by p.oid::regprocedure::text) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('public','private') and p.prokind='f';`;
function run(database, statement) {
  return spawnSync('psql', [...target(socket, database), '-Atq'], { env: postgresEnv, input: statement, encoding: 'utf8', timeout: 60000, maxBuffer: 10000000 });
}
function clone(name, template = base) {
  command('createdb', ['-h', socket, '-p', '55439', '-U', 'postgres', `--template=${template}`, name]);
  return name;
}
function catalog(database) {
  const body = sql(socket, database, collector).trim();
  const query = body.replace("select encode(extensions.digest(coalesce(string_agg(definition,E'\\n' order by definition),''),'sha256'),'hex')", 'select jsonb_agg(definition order by definition)');
  const definitions = run(database, "set search_path='';\n" + query);
  const functions = run(database, "set search_path='';\n" + funcs);
  assert.equal(definitions.status, 0, definitions.stderr);
  assert.equal(functions.status, 0, functions.stderr);
  return { definitions: JSON.parse(definitions.stdout), functions: JSON.parse(functions.stdout) };
}
function snapshot(database) {
  return sql(socket, database, `set search_path=''; select jsonb_build_object(
    'guard',(select jsonb_agg(to_jsonb(g) order by singleton) from private.confirmed_test_purge_schema g),
    'receipts',(select encode(extensions.digest(coalesce(jsonb_agg(to_jsonb(p) order by id),'[]')::text,'sha256'),'hex') from private.confirmed_test_identity_purges p),
    'columnAcls',(select jsonb_agg(jsonb_build_array(a.attrelid::regclass::text,a.attname,a.attacl::text) order by a.attrelid,a.attnum) from pg_attribute a join pg_class c on c.oid=a.attrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname in ('public','private','storage') and a.attnum>0 and not a.attisdropped and a.attacl is not null),
    'schemaAcls',(select jsonb_agg(jsonb_build_array(nspname,nspowner,nspacl::text) order by nspname) from pg_namespace where nspname in ('public','private','storage','auth')),
    'defaultAcls',(select jsonb_agg(to_jsonb(d) order by oid) from pg_default_acl d),
    'roles',(select jsonb_agg(jsonb_build_array(oid,rolname,rolsuper,rolinherit,rolcreaterole,rolcreatedb,rolcanlogin,rolreplication,rolbypassrls) order by oid) from pg_roles));`).trim();
}
function regression(database, file, superuser = false) {
  const args = target(socket, database);
  if (superuser && hosted) args[args.indexOf('-U') + 1] = 'mam_fixture_admin';
  const result = spawnSync('psql', [...args, '-f', file], { env: postgresEnv, encoding: 'utf8', maxBuffer: 10000000, timeout: 60000 });
  writeFileSync(path.join(socket, path.basename(file) + '.log'), result.stdout + result.stderr);
  assert.equal(result.status, 0, result.stderr);
  console.log(`PASS: ${file}`);
}
let result = { sourcePath, migrationSha256: sourceSha, hosted, baseline, passed: false };
try {
  createDatabase(socket, base);
  sql(socket, base, readFileSync('tests/migrations/0001-supabase-platform.sql', 'utf8'));
  const migrations = readdirSync('supabase/migrations').filter(f => f.endsWith('.sql') && !f.startsWith('20261001150000')).sort();
  for (const file of migrations) sql(socket, base, readFileSync(path.join('supabase/migrations', file), 'utf8'));
  assert.equal(migrations.length, 166);
  console.log(`PASS: full predecessor replay ${migrations.length} unchanged migrations`);
  if (hosted) {
    sql(socket, base, readFileSync('tests/payroll-purge-compatibility-hosted.sql', 'utf8'));
    sql(socket, base, 'alter default privileges in schema public,private grant execute on functions to anon,authenticated,service_role; alter default privileges in schema private grant all on tables to anon,authenticated,service_role;');
    assert.equal(sql(socket, base, "select not rolsuper from pg_roles where rolname='postgres';").trim(), 't');
  }
  sql(socket, base, `insert into auth.users(id,email,banned_until) values
    ('97abcdef-0000-4000-8000-000000000001','compat-admin@example.test',null),
    ('97abcdef-0000-4000-8000-000000000002','compat-pending@example.test',clock_timestamp()+interval '1 day');
    insert into public.profiles(id,full_name,app_role,login_name,account_status,credentials_valid_after) values
    ('97abcdef-0000-4000-8000-000000000001','Compatibility Admin Synthetic','system_admin','compat-admin@example.test','active',clock_timestamp()-interval '1 day');
    insert into public.internal_org_people(id,full_name,company_key,position_title,is_active) values
    ('97abcdef-0000-4000-8000-000000000003','Compatibility Test Synthetic','mam','Synthetic',false);
    insert into private.confirmed_test_identity_purges(id,person_id,auth_user_id,actor_user_id,company_key,manifest_hash,manifest,retained_audit,retired_identifiers,phase,completed_at) values
    ('97abcdef-0000-4000-8001-000000000002','97abcdef-0000-4000-8000-000000000002','97abcdef-0000-4000-8000-000000000002','97abcdef-0000-4000-8000-000000000001','mam',repeat('a',64),'{}','{}',array['97abcdef-0000-4000-8000-000000000002']::uuid[],'business_purged',null),
    ('97abcdef-0000-4000-8001-000000000099','97abcdef-0000-4000-8000-000000000099',null,'97abcdef-0000-4000-8000-000000000001','mam',repeat('b',64),'{}','{}',array['97abcdef-0000-4000-8000-000000000099']::uuid[],'complete',clock_timestamp());`);
  if (hosted) sql(socket, base, 'update private.confirmed_test_purge_schema set schema_hash=private.confirmed_test_purge_schema_hash();');
  assert.equal(sql(socket, base, 'select private.confirmed_test_purge_schema_hash()=(select schema_hash from private.confirmed_test_purge_schema);').trim(), 't');
  const before = catalog(base);
  const beforeReceipts = JSON.parse(snapshot(base)).receipts;
  const beforeTriggers = before.definitions.filter(d => d.includes(':CREATE TRIGGER'));
  writeFileSync(path.join(socket, 'predecessor-catalog.json'), JSON.stringify(before, null, 2));
  if (process.argv.includes('--fault-red')) testCompatibilityMigration({ source, clone, run, catalog, snapshot });
  clone(candidate);
  const applied = run(candidate, source);
  writeFileSync(path.join(socket, 'migration.log'), applied.stdout + applied.stderr);
  assert.equal(applied.status, 0, applied.stderr);
  const after = catalog(candidate);
  writeFileSync(path.join(socket, 'candidate-catalog.json'), JSON.stringify(after, null, 2));
  assert.equal(JSON.parse(snapshot(candidate)).receipts, beforeReceipts, 'Migration changed completed or pending receipts');
  for (const definition of beforeTriggers) assert.ok(after.definitions.includes(definition), 'Migration changed an existing trigger');
  for (const original of before.functions.filter(f => /confirmed_test|retired_test|is_active_portal_account/.test(f.signature))) {
    assert.deepEqual(after.functions.find(f => f.signature === original.signature), original, 'Migration changed existing purge/retirement/Auth owner, ACL or full definition');
  }
  regression(candidate, 'tests/payroll-purge-compatibility.sql');
  regression(candidate, 'tests/payroll-purge-compatibility-references.sql', true);
  console.log(`PASS: full candidate replay ${migrations.length + 1} migrations; unchanged purge preview/pending Auth completion/catalog/receipt digests`);
  result.atomicFaultCases = testCompatibilityMigration({ source, clone, run, catalog, snapshot });
  result.concurrencyCases = await testCompatibilityConcurrency({ source, database: base, args: target(socket, base), env: postgresEnv, run, snapshot });
  const payroll = ['payroll-closing-contract.sql','payroll-closing.sql','payroll-carryforward-lifecycle.sql','payroll-closing-privacy.sql','payroll-closing-mutation-guards.sql','payroll-closing-security.sql','payroll-closing-legacy-drift.sql','payroll-carryforward-import.sql','payroll-carryforward-cutoff.sql'];
  for (const file of payroll) regression(candidate, 'tests/' + file);
  result.payrollRegressions = payroll.length;
  const purge = ['confirmed-test-purge.sql','confirmed-test-purge-security.sql','confirmed-test-purge-permissions.sql','confirmed-test-purge-submission-wire-status.sql', ...readdirSync('tests').filter(f => /^confirmed-test-purge-delivered-.*\.sql$/.test(f) && f !== 'confirmed-test-purge-delivered-fixture.sql')];
  for (const file of purge) regression(candidate, 'tests/' + file);
  result.purgeRegressions = purge.length;
  regression(candidate, 'tests/migrations/effective-contract.sql');
  const clean = 'mam_test_payroll_compat_clean_replay';
  createDatabase(socket, clean);
  sql(socket, clean, readFileSync('tests/migrations/0001-supabase-platform.sql', 'utf8'));
  for (const file of migrations) sql(socket, clean, readFileSync(path.join('supabase/migrations', file), 'utf8'));
  if (hosted) {
    sql(socket, clean, readFileSync('tests/payroll-purge-compatibility-hosted.sql', 'utf8'));
    sql(socket, clean, 'alter default privileges in schema public,private grant execute on functions to anon,authenticated,service_role; alter default privileges in schema private grant all on tables to anon,authenticated,service_role; update private.confirmed_test_purge_schema set schema_hash=private.confirmed_test_purge_schema_hash();');
  }
  assert.equal(run(clean, source).status, 0);
  regression(clean, 'tests/core-review-safety.sql');
  const race = clone('mam_test_payroll_compat_accounting_race', candidate);
  const accountingRace = spawnSync(process.execPath, ['tests/run-payroll-closing-concurrency.mjs', socket, race], { env: postgresEnv, encoding: 'utf8', timeout: 60000, maxBuffer: 10000000 });
  writeFileSync(path.join(socket, 'payroll-concurrency.log'), accountingRace.stdout + accountingRace.stderr);
  assert.equal(accountingRace.status, 0, accountingRace.stderr);
  console.log(accountingRace.stdout.trim());
  await testPurgeConcurrency(target(socket, clone('mam_test_payroll_compat_purge_race', candidate)), postgresEnv);
  assert.equal(createHash('sha256').update(readFileSync(sourcePath)).digest('hex'), sourceSha, 'Candidate changed during verification');
  result = { ...result, passed: true, fullReplayCount: migrations.length + 1, existingPurgeStateUnchanged: true, existingReceiptsUnchanged: true };
  console.log(JSON.stringify(result));
} finally {
  writeFileSync(path.join(socket, 'compatibility-results.json'), JSON.stringify(result, null, 2));
  stopCluster(socket);
  console.log(`OWN_CLUSTER_STOPPED ${socket}`);
}
