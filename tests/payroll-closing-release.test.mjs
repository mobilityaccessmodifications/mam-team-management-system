import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
test('closing release helper requires explicit reviewed hashes and slices only outer transaction boundaries', () => {
  assert.ok(existsSync('scripts/deploy-payroll-closing-carryforward.py'), 'A target-checked hash-pinned closing release helper is required');
  const result = spawnSync('python3', ['-c', `import hashlib,runpy
m=runpy.run_path('scripts/deploy-payroll-closing-carryforward.py')
sql=m['MIGRATION'].read_text()
sha=hashlib.sha256(sql.encode()).hexdigest()
assert m['load_candidate'](sha)==sql
try: m['load_candidate']('0'*64)
except ValueError: pass
else: raise AssertionError('Changed candidate accepted')
body=m['transaction_body']("begin;\\nselect 'commit;';\\ncommit;\\n")
assert body=="select 'commit;';"
assert m['VERSION']>'20261001130000'
query=m['catalog_query']()
for key in ['columnAcl','policies','roles','schemas','defaultAcl']:
    assert "'"+key+"'" in query, 'Security catalog omits '+key
assert 'private.is_active_portal_account(uuid)' in m['BEFORE_FUNCTIONS']
metadata=m['full_security_query'](m['load_candidate']('686ad41be98237ed7da92d46a9c476877c65d67aae96964100017ead684a0e2c'))
assert metadata.startswith('SELECT (select jsonb_build_object(') and metadata.endswith(' AS metadata;')
for key in ['column_acls','schema_acls','default_acls','roles']:
    assert "'"+key+"'" in metadata
assert "('public','private','storage','auth')" in metadata
assert 'from pg_roles)))' in metadata and 'from pg_default_acl d)' in metadata
pins=__import__('json').loads(m['PINS'].read_bytes())
transaction=m['build_transaction'](sql,pins['before'],pins['after'])
final=transaction[transaction.rindex('insert into supabase_migrations.schema_migrations'):]
assert final.count('set constraints all immediate;')==1
assert final.index('set constraints all immediate;')<final.index('do $closing_release$')<final.index('do $closing_release_purge$')<final.rindex('commit;')
print('PASS: real candidate hash, transaction slicing and complete security catalog')`], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});
