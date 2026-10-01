import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import path from 'node:path';
import { testPurgeConcurrency } from './confirmed-test-purge-concurrency.mjs';
import { testDeliveredHistoryConcurrency } from './confirmed-test-purge-delivered-concurrency.mjs';

const scratch = process.env.MAM_TEST_SCRATCH_DIR ?? path.join(homedir(), '.hermes/profiles/mam/cache/scratch');
const socket = mkdtempSync(path.join(scratch, 'spg-'));
const env = { PATH: process.env.PATH, LANG: 'C', LC_ALL: 'C', PGPASSFILE: path.join(socket, 'no-password-file'), PGSERVICEFILE: '/dev/null' };
const migration = '20261001130000_confirmed_test_identity_cleanup.sql';
const database = 'mam_test_provider_storage';
const deniedDatabase = 'mam_test_provider_storage_denied';
const providerTables = ['storage.migrations', 'storage.buckets_vectors', 'storage.vector_indexes'];
const target = (db = database, user = 'postgres') => ['-X', '-h', socket, '-p', '55442', '-U', user, '-d', db, '-v', 'ON_ERROR_STOP=1'];
function run(binary, args, input) {
  const result = spawnSync(binary, args, { env, input, encoding: 'utf8' });
  if (result.status !== 0 || result.error) throw new Error(result.stderr || result.error?.message);
  return result.stdout;
}
const sql = (query, db = database, user = 'postgres') => run('psql', [...target(db, user), '-Atq'], query).trim();
let started = false;
try {
  run('initdb', ['-D', path.join(socket, 'data'), '-U', 'fixture_bootstrap', '--auth-local=trust', '--auth-host=reject', '--no-locale']);
  run('pg_ctl', ['-D', path.join(socket, 'data'), '-l', path.join(socket, 'postgres.log'), '-o', `-k ${socket} -p 55442 -c listen_addresses='' -c unix_socket_permissions=0700`, '-w', 'start']);
  started = true;
  sql('create role postgres login superuser; create role fixture_storage_owner nologin noinherit;', 'postgres', 'fixture_bootstrap');
  run('createdb', ['-h', socket, '-p', '55442', '-U', 'fixture_bootstrap', '-O', 'postgres', database]);
  sql(readFileSync('tests/migrations/0001-supabase-platform.sql', 'utf8'));
  const migrations = readdirSync('supabase/migrations').filter(file => file.endsWith('.sql')).sort();
  assert.ok(migrations.includes(migration));
  const forwards = migrations.filter(file => file > migration);
  assert.deepEqual(forwards, ['20261001140000_confirmed_test_purge_delivered_leave_history.sql']);
  for (const file of migrations.filter(file => file < migration)) sql(readFileSync(path.join('supabase/migrations', file), 'utf8'));
  sql(`create table storage.confirmed_test_identity_purges (id text primary key, metadata jsonb not null default '{}');
    create table storage.confirmed_test_purge_schema (id text primary key, metadata jsonb not null default '{}');`);
  sql(`
    create table storage.migrations (id text primary key, metadata jsonb not null default '{}');
    create table storage.buckets_vectors (id text primary key, metadata jsonb not null default '{}');
    create table storage.vector_indexes (id text primary key, metadata jsonb not null default '{}');
    create function storage.fixture_provider_guard() returns trigger language plpgsql as $$ begin return new; end $$;
    do $$ declare tbl text; begin
      foreach tbl in array array['migrations','buckets_vectors','vector_indexes'] loop
        execute format('create trigger fixture_existing_provider_guard before insert or update on storage.%I for each row execute function storage.fixture_provider_guard()',tbl);
        execute format('alter table storage.%I owner to fixture_storage_owner',tbl);
        execute format('grant select on storage.%I to postgres',tbl);
      end loop;
    end $$;
    alter default privileges for role postgres in schema public, private grant execute on functions to anon, authenticated, service_role;
    alter default privileges for role postgres in schema private grant all on tables to anon, authenticated, service_role;
  `, database, 'fixture_bootstrap');
  run('createdb', ['-h', socket, '-p', '55442', '-U', 'fixture_bootstrap', '-O', 'postgres', `--template=${database}`, deniedDatabase]);
  sql('create table storage.unknown_provider_metadata (id text primary key, metadata jsonb); alter table storage.unknown_provider_metadata owner to fixture_storage_owner; grant select on storage.unknown_provider_metadata to postgres;', deniedDatabase, 'fixture_bootstrap');
  sql('grant authenticated, service_role to postgres; alter role postgres nosuperuser bypassrls;', database, 'fixture_bootstrap');
  assert.equal(sql("select rolsuper from pg_roles where rolname=current_user;"), 'f');
  assert.equal(sql(`select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='storage' and c.relname in ('migrations','buckets_vectors','vector_indexes')
    and has_table_privilege(current_user,c.oid,'SELECT')
    and not has_table_privilege(current_user,c.oid,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
    and c.relowner='fixture_storage_owner'::regrole
    and not pg_has_role(current_user,'fixture_storage_owner','MEMBER');`), '3');
  const providerCatalog = `select jsonb_agg(jsonb_build_object('table',c.relname,'owner',c.relowner,'acl',c.relacl::text,'trigger',pg_get_triggerdef(t.oid),'enabled',t.tgenabled) order by c.relname)
    from pg_class c join pg_namespace n on n.oid=c.relnamespace join pg_trigger t on t.tgrelid=c.oid
    where n.nspname='storage' and c.relname in ('migrations','buckets_vectors','vector_indexes') and not t.tgisinternal;`;
  const providerSnapshot = sql(providerCatalog);
  const source = readFileSync(path.join('supabase/migrations', migration), 'utf8');
  const denied = spawnSync('psql', target(deniedDatabase), { env, input: source, encoding: 'utf8' });
  assert.notEqual(denied.status, 0, 'Unknown missing-TRIGGER relation was silently skipped');
  assert.match(denied.stderr, /permission denied for table unknown_provider_metadata/);
  assert.equal(sql(`select to_regclass('private.confirmed_test_identity_purges') is null
    and to_regclass('private.confirmed_test_purge_schema') is null
    and not exists(select 1 from pg_proc where proname in ('prepare_confirmed_test_identity_purge','reject_retired_test_identity_reference'))
    and not exists(select 1 from pg_trigger where tgname='reject_retired_test_identity_reference');`, deniedDatabase), 't');
  console.log('PASS unknown provider table without TRIGGER fails closed; whole migration rolled back');
  sql(source);
  for (const file of forwards) sql(readFileSync(path.join('supabase/migrations', file), 'utf8'));
  assert.equal(sql(providerCatalog), providerSnapshot, 'Provider ownership/ACL/existing triggers changed');
  assert.equal(sql(`select count(*) from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='storage' and c.relname in ('migrations','buckets_vectors','vector_indexes')
    and t.tgname='reject_retired_test_identity_reference';`), '0');
  assert.equal(sql(`select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where (n.nspname in ('public','private','storage') or c.oid='auth.users'::regclass)
    and c.relkind in ('r','p')
    and (n.nspname,c.relname) not in (('private','confirmed_test_identity_purges'),('private','confirmed_test_purge_schema'),('storage','migrations'),('storage','buckets_vectors'),('storage','vector_indexes'))
    and not exists(select 1 from pg_trigger t where t.tgrelid=c.oid and t.tgname='reject_retired_test_identity_reference' and t.tgenabled='O');`), '0');
  console.log(`PASS non-superuser unchanged replay (${migrations.length} migrations): SELECT-only provider tables excluded exactly; every eligible guard installed`);
  run('psql', [...target(), '-f', 'tests/confirmed-test-purge-provider-storage.sql']);
  console.log('PASS actual authenticated preview/prepare/claim/completion with SELECT-only provider Storage');
  for (const regression of ['history', 'blockers', 'envelope', 'address-items', 'retention', 'manager-only', 'timezone']) {
    run('psql', [...target(), '-f', `tests/confirmed-test-purge-delivered-${regression}.sql`]);
  }
  console.log('PASS delivered-history purge, private provenance, fail-closed receipts and monotonic retention with SELECT-only provider Storage');
  const person = '98abcdef-0000-4000-8000-000000000002';
  const actor = '98abcdef-0000-4000-8000-000000000001';
  sql(`insert into auth.users(id,email,email_confirmed_at,banned_until) values
    ('${actor}','provider-admin@example.test',now(),null),('${person}','provider-fake@example.test',now(),now()+interval '1 day');
    insert into public.profiles(id,full_name,app_role,login_name,account_status,credentials_valid_after,disabled_at) values
    ('${actor}','Provider Admin Synthetic','system_admin','provider-admin@example.test','active',now()-interval '1 day',null),
    ('${person}','Provider Fake Synthetic','employee','provider-fake@example.test','disabled',now()-interval '1 day',now());
    insert into public.internal_org_people(id,full_name,company_key,position_title,auth_user_id,is_active)
    values ('${person}','Provider Fake Synthetic','mam','Synthetic','${person}',true);`);
  const claims = `do $$ begin perform set_config('request.jwt.claims',jsonb_build_object('sub','${actor}','role','authenticated','iat',extract(epoch from now())::bigint,'is_anonymous',false)::text,false); end $$; set role authenticated; `;
  const rpc = statement => sql(claims + statement);
  const identity = `'${person}','${person}','mam','Provider Fake Synthetic','provider-fake@example.test',1,1`;
  const hash = rpc(`select public.preview_confirmed_test_identity_purge(${identity})->>'manifest_hash';`);
  const prepare = `select public.prepare_confirmed_test_identity_purge(${identity},'${hash}',true,true);`;
  const seed = table => sql(`insert into ${table}(id,metadata) values('synthetic-reference',jsonb_build_object(upper('${person}'),jsonb_build_object('path','people/'||upper('${person}')||'/metadata')));`, database, 'fixture_bootstrap');
  const clear = table => sql(`delete from ${table} where id='synthetic-reference';`, database, 'fixture_bootstrap');
  for (const table of providerTables) {
    seed(table);
    for (const statement of [`select public.preview_confirmed_test_identity_purge(${identity});`, prepare]) {
      assert.throws(() => rpc(statement), error => error.message.includes(`unreviewed/shared/immutable reference in ${table}`));
    }
    assert.equal(sql(`select exists(select 1 from public.internal_org_people where id='${person}')
      and exists(select 1 from public.profiles where id='${person}')
      and not exists(select 1 from private.confirmed_test_identity_purges where person_id='${person}');`), 't');
    clear(table);
  }
  console.log('PASS existing uppercase/nested/key/path references in all three excluded tables block authenticated preview and prepare without destruction');
  const receipt = rpc(prepare);
  assert.equal(JSON.parse(rpc(`select public.claim_confirmed_test_identity_auth_delete('${receipt}');`)).delete_authorized, true);
  sql(`delete from auth.users where id='${person}';`);
  for (const table of providerTables) {
    seed(table);
    assert.throws(() => rpc(`select public.complete_confirmed_test_identity_purge('${receipt}');`), error => error.message.includes(`Operational reference remains in ${table}`));
    assert.equal(sql(`select phase from private.confirmed_test_identity_purges where id='${receipt}';`), 'auth_delete_started');
    clear(table);
  }
  assert.equal(JSON.parse(rpc(`select public.complete_confirmed_test_identity_purge('${receipt}');`)).phase, 'complete');
  for (const table of providerTables) {
    assert.equal(sql(`select count(*) from ${table} where private.confirmed_test_has_reference(to_jsonb(${table.split('.')[1]}),array['${person}']::uuid[]);`), '0');
  }
  console.log('PASS later provider references block authenticated completion; explicit final readback finds zero references in every excluded table');
  for (const table of providerTables) {
    sql(`alter table ${table} add column fixture_drift text;`, database, 'fixture_bootstrap');
    assert.equal(sql('select private.confirmed_test_purge_schema_hash()<>(select schema_hash from private.confirmed_test_purge_schema);'), 't');
    assert.throws(() => rpc(`select public.preview_confirmed_test_identity_purge(${identity});`), /schema\/projection\/trigger drift requires review/);
    sql(`alter table ${table} drop column fixture_drift;`, database, 'fixture_bootstrap');
    sql(`create trigger fixture_drift before insert on ${table} for each row execute function storage.fixture_provider_guard();`, database, 'fixture_bootstrap');
    assert.equal(sql('select private.confirmed_test_purge_schema_hash()<>(select schema_hash from private.confirmed_test_purge_schema);'), 't');
    sql(`drop trigger fixture_drift on ${table};`, database, 'fixture_bootstrap');
    sql(`grant select on ${table} to anon;`, database, 'fixture_bootstrap');
    assert.equal(sql('select private.confirmed_test_purge_schema_hash()<>(select schema_hash from private.confirmed_test_purge_schema);'), 't');
    sql(`revoke select on ${table} from anon;`, database, 'fixture_bootstrap');
    assert.equal(sql('select private.confirmed_test_purge_schema_hash()=(select schema_hash from private.confirmed_test_purge_schema);'), 't');
  }
  assert.equal(sql(providerCatalog), providerSnapshot, 'Provider fixture was not restored exactly');
  console.log('PASS excluded Storage tables remain in column/trigger/ACL schema fingerprint; provider guards and SELECT-only grants preserved');
  if (process.argv.includes('--concurrency')) {
    await testPurgeConcurrency(target(), env);
    await testDeliveredHistoryConcurrency(target(), env, { databaseCreator: 'fixture_bootstrap' });
  }
} finally {
  if (started) run('pg_ctl', ['-D', path.join(socket, 'data'), '-m', 'fast', '-w', 'stop']);
  rmSync(socket, { recursive: true, force: true });
}
