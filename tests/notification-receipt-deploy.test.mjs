import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

test('database release helper rejects malformed imports and requires exact frozen proof', () => {
  const result = spawnSync('python3', ['-B', '-c', String.raw`
import hashlib,json,runpy
m=runpy.run_path('scripts/deploy-notification-receipts.py')
key='leave:10000000-0000-4000-8000-000000000001:leave-submitted:'+'a'*24
snapshot={'workflowId':m['WORKFLOW'],'drainSeconds':30,'nonterminalCount':0,'versionId':'synthetic',
  'capturedAt':'2026-09-22T00:00:00Z','bundleSha256':'b'*64,'receipts':{key:{'state':'sent','at':1780000000123}}}
def parsed(value):
  raw=json.dumps(value).encode(); return m['parse_snapshot'](raw,hashlib.sha256(raw).hexdigest())
_,entries=parsed(snapshot)
assert entries==[{'eventKey':key,'state':'legacy_sent','at':1780000000123}]
for name,value in [('workflowId','wrong'),('drainSeconds',0),('nonterminalCount',1),('bundleSha256','wrong')]:
  try: parsed({**snapshot,name:value}); raise AssertionError('unsafe snapshot accepted')
  except ValueError: pass
for receipt in [{'state':'unknown','at':1},{'state':'sent','at':True},{'state':'sent','at':float('nan')},
  {'state':'sent','at':-1},{'state':'sent','at':253402300800000},{'state':'sent','at':1,'recipient':'invented@example.test'}]:
  try: parsed({**snapshot,'receipts':{key:receipt}}); raise AssertionError('unsafe receipt accepted')
  except ValueError: pass
raw=b'{"workflowId":"first","workflowId":"second"}'
try: m['parse_snapshot'](raw,hashlib.sha256(raw).hexdigest()); raise AssertionError('duplicate property accepted')
except ValueError: pass
try: m['parse_snapshot'](json.dumps(snapshot).encode(),'0'*64); raise AssertionError('wrong digest accepted')
except ValueError: pass
assert parsed({**snapshot,'receipts':{}})[1]==[]
assert parsed({**snapshot,'receipts':{key:{'state':'processing','at':1}}})[1][0]['state']=='legacy_unknown'
for operation in ['import_sql','enable_sql']:
  sql=m[operation](entries,'c'*64)
  assert sql.startswith('begin;') and sql.endswith('commit;')
  assert 'private.lock_notification_delivery_store()' in sql
  assert 'created_at is distinct from to_timestamp' in sql
  assert 'select count(*) from private.notification_delivery_receipts' in sql
  assert 'legacy_import_sha256' in sql and 'legacy_import_count' in sql
  assert not any(word in sql.lower() for word in ['truncate ','delete ','drop '])
assert 'private.set_notification_delivery_ready(true)' not in m['import_sql'](entries,'c'*64)
assert 'private.set_notification_delivery_ready(true)' in m['enable_sql'](entries,'c'*64)
print('PASS private snapshot validation and import/enable SQL guards')
`], { encoding: 'utf8', env: { PATH: process.env.PATH } });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /PASS/);
});
