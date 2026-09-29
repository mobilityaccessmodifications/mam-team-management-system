import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("Analytics post-migration verification markers match each SQL field expression", () => {
  const helper = readFileSync("scripts/deploy-analytics-employee-org-fields.py", "utf8");
  const migration = readFileSync("supabase/migrations/20260929140000_analytics_employee_org_fields.sql", "utf8");
  const expressions = [
    "'team', (select employee_detail.team_name from private.employee_directory_details employee_detail where employee_detail.person_id = person.id)",
    "'scheduled_employment_end_date', (select employee_detail.scheduled_employment_end_date from private.employee_directory_details employee_detail where employee_detail.person_id = person.id)",
    "'employment_type', (select employee_detail.employment_type from private.employee_directory_details employee_detail where employee_detail.person_id = person.id)",
    "'contract_type', (select classification.contract_type from private.employee_check_in_contract_classifications classification where classification.person_id = person.id)",
    "'working_weekdays', (select employee_detail.working_weekdays from private.employee_directory_details employee_detail where employee_detail.person_id = person.id)",
    "'working_day_times', coalesce((select employee_detail.working_day_times from private.employee_directory_details employee_detail where employee_detail.person_id = person.id), '[]'::jsonb)",
  ];
  for (const expression of expressions) {
    assert.ok(migration.includes(expression), `migration is missing ${expression}`);
    assert.ok(helper.includes(`position($$${expression}$$ in pg_get_functiondef`), `post-migration check is not aligned for ${expression}`);
  }
});

function run(operation, { recorded = false, wrongHash = false, unsafe = false, laterLocalOnly = false, laterRemote = false } = {}) {
  const source = String.raw`
import hashlib,json,runpy,sys
m=runpy.run_path('scripts/deploy-analytics-employee-org-fields.py')
g=m['main'].__globals__
sql=m['MIGRATION'].read_text()
base_sql=m['BASE_MIGRATION'].read_text()
state={
  'expected_owner':True,'trusted_owner':True,'security_definer':True,
  'stable_function':True,'empty_search_path':True,'service_role_execute':True,
  'anon_denied':True,'authenticated_denied':True,'execute_acl_restricted':True,
  'directory_columns':True,'contract_columns':True,'directory_rls':True,
  'contract_rls':True,'private_sources_unreadable':True,
  'expected_projection_anchor':True,'fields_projected':${recorded ? "True" : "False"},
  'fields_not_preprojected':${recorded ? "False" : "True"}}
if ${unsafe ? "True" : "False"}: state['authenticated_denied']=False
writes=[]
remote=[
  {'version':'20260925030000','name':'analytics_employee_names'},
  {'version':'20260929133000','name':'leave_register_read_grants'}]
if ${laterRemote ? "True" : "False"}:
  remote.append({'version':'20260929150000','name':'later_migration'})
if ${recorded ? "True" : "False"}:
  remote.append({'version':'20260929140000','name':'analytics_employee_org_fields'})
base=[{'version':'20260925030000','name':'analytics_employee_names','statements':[base_sql]}]
existing=[{'version':'20260929140000','name':'analytics_employee_org_fields','statements':[sql]}] if ${recorded ? "True" : "False"} else []
def fake_api(path,body=None):
  assert path=='' and body is None
  return {'id':'xtwlrjqbusadghavchqm','organization_id':'fwlmbmospuwoaosffvmw'}
def fake_query(statement):
  if statement.startswith('select version,name from supabase_migrations.schema_migrations'):
    return remote
  if 'select version,name,statements from supabase_migrations.schema_migrations where version=' in statement:
    return base if "20260925030000" in statement else existing
  if statement.startswith('select') and 'from pg_proc p join pg_roles owner_role' in statement:
    return [dict(state)]
  if statement.startswith('begin;'):
    writes.append(statement)
    state['fields_projected']=True
    existing[:]=[{'version':'20260929140000','name':'analytics_employee_org_fields','statements':[sql]}]
    return []
  raise AssertionError('unexpected query: '+statement[:120])
g['api']=fake_api
g['query']=fake_query
g['schema_state']=lambda:dict(state)
local_files={version:name for version,name in g['migration_files']().items() if version<='20260929140000'}
if ${laterLocalOnly ? "True" : "False"}:
  local_files['20260929150000']='later_migration'
g['migration_files']=lambda:local_files
g['sys'].argv=['deploy-analytics-employee-org-fields.py',${JSON.stringify(operation)},${wrongHash ? '"wrong-hash"' : 'hashlib.sha256(sql.encode()).hexdigest()'}]
g['main']()
assert len(writes)==${operation === "apply" && !recorded && !wrongHash && !unsafe ? 1 : 0}, ('unexpected write count',len(writes))
if writes:
  assert writes[0].startswith("begin;"+chr(10)+"set local lock_timeout='5s';"+chr(10)+"set local statement_timeout='75s';"), ('bad release prefix',repr(writes[0][:150]))
  expected_history="insert into supabase_migrations.schema_migrations(version,name,statements) values('20260929140000','analytics_employee_org_fields',ARRAY["+g['literal'](sql)+"]);"
  assert expected_history in writes[0], 'migration history did not retain the exact reviewed source'
  assert writes[0].endswith("notify pgrst,'reload schema';"+chr(10)+"commit;"+chr(10)), ('bad schema notification tail',repr(writes[0][-150:]))
print(json.dumps({'writes':len(writes)}))
`;
  return spawnSync("python3", ["-B", "-c", source], { encoding: "utf8" });
}

test("Analytics employee-org-fields inspection is read-only", () => {
  const result = run("inspect");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /"writes": 0/);
});

test("Analytics employee-org-fields applies only the hash-pinned migration and verifies it", () => {
  const result = run("apply");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /"writes": 1/);
});

test("Analytics employee-org-fields replay verifies the recorded source without reapplying", () => {
  const result = run("apply", { recorded: true });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /"writes": 0/);
});

test("Analytics employee-org-fields recorded replay blocks a later local-only migration", () => {
  const result = run("inspect", { recorded: true, laterLocalOnly: true });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /later local migration/);
});

test("Analytics employee-org-fields rejects an unrecorded target behind a later remote version", () => {
  const result = run("inspect", { laterRemote: true });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /not newer than the remote ledger/);
});

test("Analytics employee-org-fields rejects an unreviewed migration hash before target access", () => {
  const result = run("apply", { wrongHash: true });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Reviewed migration differs/);
});

test("Analytics employee-org-fields fails closed on a broadened RPC grant", () => {
  const result = run("apply", { unsafe: true });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /security boundary/);
});
