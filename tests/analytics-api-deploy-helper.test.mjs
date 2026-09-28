import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

function run(operation, { recorded = false, wrongHash = false, unsafe = false } = {}) {
  const source = String.raw`
import hashlib,json,runpy,sys
m=runpy.run_path('scripts/deploy-analytics-employee-names.py')
g=m['main'].__globals__
sql=m['MIGRATION'].read_text()
state={
  'employee_name_columns':True,'expected_owner':True,'security_definer':True,
  'stable_function':True,'empty_search_path':True,'service_role_execute':True,
  'anon_denied':True,'authenticated_denied':True,'execute_acl_restricted':True,
  'employee_projection_anchor':True,'names_projected':${recorded ? "True" : "False"}}
if ${unsafe ? "True" : "False"}: state['authenticated_denied']=False
writes=[]
base=[{'version':'20260904022514','name':'20260904110000_analytics_dashboard_api'}]
existing=[{'version':'20260925030000','name':'analytics_employee_names','statements':[sql]}] if ${recorded ? "True" : "False"} else []
def fake_api(path,body=None):
  assert path=='' and body is None
  return {'id':'xtwlrjqbusadghavchqm','organization_id':'fwlmbmospuwoaosffvmw'}
def fake_query(statement):
  global state
  if 'select version,name from supabase_migrations.schema_migrations' in statement: return base
  if 'select version,name,statements from supabase_migrations.schema_migrations' in statement:
    return existing if ${recorded ? "True" : "False"} or len(writes) else []
  if statement.startswith('begin;'):
    writes.append(statement)
    state['names_projected']=True
    existing[:]=[{'version':'20260925030000','name':'analytics_employee_names','statements':[sql]}]
    return []
  if statement.startswith('select version from supabase_migrations.schema_migrations'):
    return [{'version':'20260925030000'}] if existing else []
  raise AssertionError('unexpected query: '+statement[:100])
g['api']=fake_api
g['query']=fake_query
g['schema_state']=lambda:dict(state)
g['sys'].argv=['deploy-analytics-employee-names.py',${JSON.stringify(operation)},${wrongHash ? '"wrong-hash"' : 'hashlib.sha256(sql.encode()).hexdigest()'}]
g['main']()
assert len(writes)==${operation === "apply" && !recorded && !wrongHash && !unsafe ? 1 : 0}, ('unexpected write count',len(writes))
if writes:
  assert writes[0].startswith("begin;"+chr(10)+"set local lock_timeout='5s';"+chr(10)+"set local statement_timeout='75s';"), ('bad release prefix',repr(writes[0][:150]))
  expected_history="insert into supabase_migrations.schema_migrations(version,name,statements) values('20260925030000','analytics_employee_names',ARRAY["+g['literal'](sql)+"]);"
  assert expected_history in writes[0], 'migration history did not retain the exact reviewed source'
  assert writes[0].endswith("notify pgrst,'reload schema';"+chr(10)+"commit;"+chr(10)), ('bad schema notification tail',repr(writes[0][-150:]))
print(json.dumps({'writes':len(writes)}))
`;
  return spawnSync("python3", ["-B", "-c", source], { encoding: "utf8" });
}

test("Analytics deployment inspection is read-only", () => {
  const result = run("inspect");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /"writes": 0/);
});

test("Analytics deployment applies only the hash-pinned migration and verifies it", () => {
  const result = run("apply");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /"writes": 1/);
});

test("Analytics deployment replay verifies the recorded source without reapplying", () => {
  const result = run("apply", { recorded: true });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /"writes": 0/);
});

test("Analytics deployment rejects an unreviewed migration hash before target access", () => {
  const result = run("apply", { wrongHash: true });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Reviewed migration differs/);
});

test("Analytics deployment fails closed on a broadened RPC grant", () => {
  const result = run("apply", { unsafe: true });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /security boundary/);
});
