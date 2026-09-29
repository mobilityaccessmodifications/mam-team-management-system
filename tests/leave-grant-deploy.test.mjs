import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

function run(operation, { recorded = false, wrongHash = false, candidates = 1, reviewers = 0 } = {}) {
  const source = String.raw`
import hashlib,json,runpy
m=runpy.run_path('scripts/deploy-leave-register-read-grant.py')
g=m['main'].__globals__
sql=m['MIGRATION'].read_text()
writes=[]
recorded=${recorded ? "True" : "False"}
granted=0
def fake_api(path,body=None):
  assert path=='' and body is None
  return {'id':'xtwlrjqbusadghavchqm','organization_id':'fwlmbmospuwoaosffvmw'}
def fake_query(statement):
  global recorded,granted
  if statement.startswith('select version from supabase_migrations'): return [{'version':'20260929120000'}]
  if statement.startswith('select statements from supabase_migrations'): return [{'statements':[sql]}] if recorded else []
  if statement.startswith('select count(*) as candidates'): return [{'candidates':${candidates},'employees':${candidates},'reviewers':${reviewers},'granted':granted}]
  if statement.startswith('begin;'):
    writes.append(statement)
    if 'insert into private.leave_register_read_grants' in statement: granted=1
    else: recorded=True
    return []
  raise AssertionError('unexpected query: '+statement[:120])
g['api']=fake_api
g['query']=fake_query
g['verify_predecessors']=lambda:None
g['verify_schema']=lambda sql:None
g['sys'].argv=['helper',${JSON.stringify(operation)},${wrongHash ? '"wrong-hash"' : 'hashlib.sha256(sql.encode()).hexdigest()'}] if ${JSON.stringify(operation)}!='inspect' else ['helper','inspect']
g['main']()
assert len(writes)==${operation === "inspect" || wrongHash || (operation === "apply" && recorded) ? 0 : 1}, ('writes',len(writes))
if writes:
  assert writes[0].startswith("begin;"), 'no transaction'
  assert "set local lock_timeout='5s'" in writes[0], 'no lock bound'
  if ${JSON.stringify(operation)}=='apply':
    assert "notify pgrst,'reload schema';" in writes[0]
    assert g['literal'](sql) in writes[0], 'different ledger bytes'
  else:
    assert "having count(*)=1 and bool_and(eligible)" in writes[0]
    assert "on conflict (person_id) do nothing" in writes[0]
print(json.dumps({'writes':len(writes)}))
`;
  return spawnSync("python3", ["-B", "-c", source], { encoding: "utf8" });
}

test("Leave grant deployment inspection makes no write", () => {
  const result = run("inspect");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /"writes": 0/);
});

test("Leave grant migration is hash-pinned, transactional and recorded", () => {
  const result = run("apply");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /"writes": 1/);
});

test("Leave grant migration replay is read-only", () => {
  const result = run("apply", { recorded: true });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /"writes": 0/);
});

test("Leave grant rejects a mismatched reviewed hash before API access", () => {
  const result = run("apply", { wrongHash: true });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Reviewed migration differs/);
});

test("Leave grant insertion requires an already recorded migration", () => {
  const result = run("grant");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Apply reviewed migration before granting/);
});

test("Leave grant insertion identifies one active non-reviewer Jackie", () => {
  const result = run("grant", { recorded: true });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /"writes": 1/);
});

for (const options of [{ candidates: 2 }, { reviewers: 1 }]) {
  test(`Leave grant refuses ambiguous or reviewer identities ${JSON.stringify(options)}`, () => {
    const result = run("grant", { recorded: true, ...options });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Jackie account is not unique/);
  });
}
