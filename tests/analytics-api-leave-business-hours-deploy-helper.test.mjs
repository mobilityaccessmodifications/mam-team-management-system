import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("Analytics business-hours helper verifies the migration's exact projected expression", () => {
  const helper = readFileSync("scripts/deploy-analytics-leave-business-hours.py", "utf8");
  const migration = readFileSync("supabase/migrations/20260930180000_analytics_leave_business_hours.sql", "utf8");
  const expression = "'business_hours', coalesce(";
  assert.ok(migration.includes(expression));
  assert.ok(helper.includes("business_hours_projected"));
  assert.ok(helper.includes("business_hours_not_preprojected"));
  assert.ok(helper.includes("employment_type_snapshot"));
});

function validateMigrationFilenames(filenames) {
  const source = String.raw`
import json,runpy,sys
m=runpy.run_path('scripts/deploy-analytics-leave-business-hours.py')
print(json.dumps(m['migration_map'](json.loads(sys.argv[1]))))
`;
  return spawnSync("python3", ["-B", "-c", source, JSON.stringify(filenames)], { encoding: "utf8" });
}

test("Analytics business-hours helper rejects malformed local migration filenames", () => {
  const result = validateMigrationFilenames(["bad-name.sql"]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Malformed local migration filename/);
});

test("Analytics business-hours helper rejects duplicate local migration versions", () => {
  const result = validateMigrationFilenames([
    "20260930180000_analytics_leave_business_hours.sql",
    "20260930180000_duplicate.sql",
  ]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Duplicate local migration version/);
});

function run(operation, { recorded = false, wrongHash = false, unsafe = false, laterLocalOnly = false, laterRemote = false, wrongRecordedSource = false } = {}) {
  const source = String.raw`
import hashlib,json,runpy,sys
m=runpy.run_path('scripts/deploy-analytics-leave-business-hours.py')
g=m['main'].__globals__
sql=m['MIGRATION'].read_text()
base_sql=m['BASE_MIGRATION'].read_text()
state={
  'expected_owner':True,'trusted_owner':True,'security_definer':True,
  'stable_function':True,'empty_search_path':True,'service_role_execute':True,
  'anon_denied':True,'authenticated_denied':True,'execute_acl_restricted':True,
  'leave_columns':True,'directory_columns':True,'leave_requests_rls':True,
  'directory_rls':True,'private_directory_unreadable':True,
  'expected_hours_anchor':True,'business_hours_not_preprojected':${recorded ? "False" : "True"},
  'business_hours_projected':${recorded ? "True" : "False"},'employee_fields_present':True}
if ${unsafe ? "True" : "False"}: state['authenticated_denied']=False
writes=[]
remote=[
  {'version':'20260929140000','name':'analytics_employee_org_fields'},
  {'version':'20260930170000','name':'directory_overseas_employment'},
  {'version':'20260818160000','name':'remote_only_migration'}]
if ${laterRemote ? "True" : "False"}:
  remote.append({'version':'20260930190000','name':'later_remote_migration'})
if ${recorded ? "True" : "False"}:
  remote.append({'version':'20260930180000','name':'analytics_leave_business_hours'})
base=[{'version':'20260929140000','name':'analytics_employee_org_fields','statements':[base_sql]}]
recorded_sql='select 1' if ${wrongRecordedSource ? "True" : "False"} else sql
existing=[{'version':'20260930180000','name':'analytics_leave_business_hours','statements':[recorded_sql]}] if ${recorded ? "True" : "False"} else []
def fake_api(path,body=None):
  assert path=='' and body is None
  if ${wrongHash ? "True" : "False"}: raise AssertionError('API accessed before hash validation')
  return {'id':'xtwlrjqbusadghavchqm','organization_id':'fwlmbmospuwoaosffvmw'}
def fake_query(statement):
  if statement.startswith('select version,name from supabase_migrations.schema_migrations'):
    return remote
  if 'select version,name,statements from supabase_migrations.schema_migrations where version=' in statement:
    return base if '20260929140000' in statement else existing
  if statement.startswith('select') and 'from pg_proc p join pg_roles owner_role' in statement:
    return [dict(state)]
  if statement.startswith('begin;'):
    writes.append(statement)
    state['business_hours_projected']=True
    state['business_hours_not_preprojected']=False
    existing[:]=[{'version':'20260930180000','name':'analytics_leave_business_hours','statements':[sql]}]
    return []
  raise AssertionError('unexpected query: '+statement[:120])
g['api']=fake_api
g['query']=fake_query
g['schema_state']=lambda:dict(state)
local_files={version:name for version,name in g['migration_files']().items() if version<='20260930180000'}
if ${laterLocalOnly ? "True" : "False"}:
  local_files['20260930190000']='later_local_migration'
g['migration_files']=lambda:local_files
g['sys'].argv=['deploy-analytics-leave-business-hours.py',${JSON.stringify(operation)},${wrongHash ? '"wrong-hash"' : 'hashlib.sha256(sql.encode()).hexdigest()'}]
g['main']()
assert len(writes)==${operation === "apply" && !recorded && !wrongHash && !unsafe && !wrongRecordedSource ? 1 : 0}, ('unexpected write count',len(writes))
if writes:
  assert writes[0].startswith("begin;"+chr(10)+"set local lock_timeout='5s';"+chr(10)+"set local statement_timeout='75s';"), ('bad release prefix',repr(writes[0][:150]))
  expected_history="insert into supabase_migrations.schema_migrations(version,name,statements) values('20260930180000','analytics_leave_business_hours',ARRAY["+g['literal'](sql)+"]);"
  assert expected_history in writes[0], 'migration history did not retain the exact reviewed source'
  assert writes[0].endswith("notify pgrst,'reload schema';"+chr(10)+"commit;"+chr(10)), ('bad schema notification tail',repr(writes[0][-150:]))
print(json.dumps({'writes':len(writes)}))
`;
  return spawnSync("python3", ["-B", "-c", source], { encoding: "utf8" });
}

test("Analytics business-hours inspection is read-only", () => {
  const result = run("inspect");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /"writes": 0/);
});

test("Analytics business-hours helper applies only the reviewed migration and records exact source", () => {
  const result = run("apply");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /"writes": 1/);
});

test("Analytics business-hours recorded replay verifies source without reapplying", () => {
  const result = run("apply", { recorded: true });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /"writes": 0/);
});

test("Analytics business-hours helper rejects a recorded version with different SQL", () => {
  const result = run("inspect", { recorded: true, wrongRecordedSource: true });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /recorded.*differs/i);
});

test("Analytics business-hours helper blocks later local-only migrations before replay", () => {
  const result = run("inspect", { recorded: true, laterLocalOnly: true });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /later local migration/i);
});

test("Analytics business-hours helper rejects an unrecorded target behind a later remote version", () => {
  const result = run("inspect", { laterRemote: true });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /not newer than the remote ledger/i);
});

test("Analytics business-hours helper rejects the wrong reviewed hash before project access", () => {
  const result = run("apply", { wrongHash: true });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Reviewed migration differs/);
});

test("Analytics business-hours helper fails closed on broadened RPC permissions", () => {
  const result = run("apply", { unsafe: true });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /security boundary/i);
});
