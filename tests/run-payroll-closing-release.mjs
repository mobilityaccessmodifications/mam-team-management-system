import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { createDatabase, target, postgresEnv } from '../scripts/local-test-postgres.mjs';
function sql(socket, database, statement) {
  const result = spawnSync('psql', [...target(socket, database), '-Atq'], { env: postgresEnv, input: statement, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
  if (result.status !== 0 || result.error) throw new Error(result.stderr || result.error?.message || `psql exit ${result.status}`);
  return result.stdout.trim();
}
const [socket, database] = process.argv.slice(2);
const helper = 'scripts/deploy-payroll-closing-carryforward.py';
function python(program, input = {}) {
  const result = spawnSync('python3', ['-c', `import json,runpy,sys\nm=runpy.run_path(${JSON.stringify(helper)})\nd=json.load(sys.stdin)\n${program}`], { input: JSON.stringify(input), encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}
const candidate = JSON.parse(python("print(json.dumps({'version':m['VERSION'],'name':m['NAME'],'raw':m['MIGRATION'].read_text(),'body':m['transaction_body'](m['MIGRATION'].read_text()),'beforeFunctions':m['BEFORE_FUNCTIONS'],'beforeTables':m['BEFORE_TABLES'],'newTables':m['NEW_TABLES']}))"));
createDatabase(socket, database);
sql(socket, database, readFileSync('tests/migrations/0001-supabase-platform.sql', 'utf8'));
sql(socket, database, 'create schema supabase_migrations; create table supabase_migrations.schema_migrations(version text primary key,name text,statements text[]);');
const literal = value => `'${value.replaceAll("'", "''")}'`;
for (const file of readdirSync('supabase/migrations').filter(file => file.endsWith('.sql') && !file.startsWith(candidate.version)).sort()) {
  const raw = readFileSync(path.join('supabase/migrations', file), 'utf8');
  sql(socket, database, raw);
  const [version, ...name] = file.replace(/\.sql$/, '').split('_');
  sql(socket, database, `insert into supabase_migrations.schema_migrations values(${literal(version)},${literal(name.join('_'))},array[${literal(raw)}]);`);
}
sql(socket, database, 'create table private.portal_account_test_sessions(target_user_id uuid,auth_session_id uuid,activated_at timestamptz,revoked_at timestamptz,session_expires_at timestamptz);');
sql(socket, database, 'update private.confirmed_test_purge_schema set schema_hash=private.confirmed_test_purge_schema_hash() where singleton;');
const catalogSql = (functions, tables) => python("print(m['catalog_query'](d['functions'],d['tables']))", { functions, tables });
const before = JSON.parse(sql(socket, database, `begin read only; set local search_path=''; ${catalogSql(candidate.beforeFunctions,candidate.beforeTables)} rollback;`));
assert.deepEqual(before.purgeGuard, { rows: 1, matches: true });
const insert = `insert into supabase_migrations.schema_migrations values(${literal(candidate.version)},${literal(candidate.name)},array[${literal(candidate.raw)}]);`;
const signaturesQuery = "select jsonb_agg(p.oid::regprocedure::text order by p.oid::regprocedure::text) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where (n.nspname='private' and (p.proname like 'payroll_closing_%' or p.proname like 'payroll_carryforward_%' or p.proname like 'payroll_request_%' or p.proname='payroll_retained_hours' or p.proname like '%_before_carryforward')) or (n.nspname='public' and p.proname in ('preview_payroll_closing_reconciliation','reconcile_payroll_closing','settle_payroll_carryforward','get_leave_priority_workspace_before_carryforward'));";
const newFunctions = JSON.parse(sql(socket, database, `begin; set local search_path=''; ${candidate.body} ${signaturesQuery} rollback;`));
const afterFunctions = [...new Set([...candidate.beforeFunctions, ...newFunctions])].sort();
const afterTables = [...candidate.beforeTables, ...candidate.newTables];
const after = JSON.parse(sql(socket, database, `begin; set local search_path=''; ${candidate.body} ${insert} ${catalogSql(afterFunctions,afterTables)} rollback;`));
const build = expected => python("print(m['build_transaction'](d['raw'],d['before'],d['after']))", { raw: candidate.raw, before, after: expected });
const transaction = build(after);
function reject(statement, expected = /Payroll closing release catalog drift/) {
  assert.throws(() => sql(socket, database, statement), expected);
  assert.equal(sql(socket, database, `select count(*) from supabase_migrations.schema_migrations where version=${literal(candidate.version)};`).trim(), '0');
  assert.equal(sql(socket, database, "select to_regclass('private.payroll_closing_receipts') is null;").trim(), 't');
}
for (const drift of [
  "grant execute on function private.approved_leave_hours_after(uuid,text[],date) to service_role;",
  "grant select(hours) on private.employee_sick_leave_balances to service_role;",
  'alter table private.employee_sick_leave_balances disable row level security;',
  'alter role service_role nobypassrls;',
  "grant create on schema private to authenticated;",
  "alter default privileges in schema private grant select on tables to service_role;",
  `update supabase_migrations.schema_migrations set statements=array['select 0;'] where version='20261001130000';`,
]) reject(`begin; ${drift} ${transaction.slice('begin;'.length)}`);
const wrongAfter = structuredClone(after);
wrongAfter.functions['public.reconcile_payroll_closing(text,jsonb)'].sha256 = '0'.repeat(64);
reject(build(wrongAfter));
const finalGuardStart = transaction.lastIndexOf('do $closing_release$');
reject(transaction.slice(0, finalGuardStart) + 'grant select(note) on private.payroll_closing_receipts to service_role;\n' + transaction.slice(finalGuardStart));
sql(socket, database, transaction);
assert.deepEqual(JSON.parse(sql(socket, database, `begin read only; set local search_path=''; ${catalogSql(afterFunctions,afterTables)} rollback;`)), after);
assert.equal(sql(socket, database, "select count(*) from private.payroll_closing_receipts;").trim(), '0', 'Schema release must never apply closing data');
assert.throws(() => sql(socket, database, transaction), /Payroll closing release catalog drift/, 'Recorded source cannot be replayed');
assert.equal(sql(socket, database, `select count(*) from supabase_migrations.schema_migrations where version=${literal(candidate.version)};`).trim(), '1');
console.log('PASS: actual hash-pinned candidate transaction; atomic rollback; source/function/column/role/schema/default-ACL/RLS drift; exact readback; recorded-source no replay');
