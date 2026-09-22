import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';

test('receiver release preserves credentials, nodes, connections and receipts, and fails on drift',()=>{
  const result=execFileSync('python3',['-c',`
import copy,runpy
m=runpy.run_path('scripts/deploy-notification-review.py')
nodes=[{'name':name,'type':'n8n-nodes-base.code','parameters':{'jsCode':(m['ROOT']/'workflows'/filename).read_text()}} for name,(filename,_) in m['FILES'].items()]
nodes.append({'name':'Sender','type':'n8n-nodes-base.microsoftOutlook','credentials':{'id':'synthetic'},'parameters':{'operation':'send'}})
live={'name':'MAM People System - Leave Email Delivery','active':True,'nodes':nodes,'connections':{'synthetic':[]},'settings':{'saveDataSuccessExecution':'none','saveDataErrorExecution':'none'},'staticData':{'synthetic':'receipt'}}
before=copy.deepcopy(live)
patched=m['patch'](live)
assert live==before
assert patched['nodes']==live['nodes'] and patched['connections']==live['connections']
assert 'staticData' not in patched
assert patched['settings']['errorWorkflow']==m['ALERT']
for key,value in [('name','wrong'),('active',False)]:
 bad=copy.deepcopy(live);bad[key]=value
 try:m['patch'](bad);raise AssertionError('Expected rejection')
 except ValueError:pass
bad=copy.deepcopy(live);bad['nodes'][0]['parameters']['jsCode']='unreviewed'
try:m['patch'](bad);raise AssertionError('Expected rejection')
except ValueError:pass
print('passed')
`],{encoding:'utf8'});
  assert.equal(result.trim(),'passed');
});
