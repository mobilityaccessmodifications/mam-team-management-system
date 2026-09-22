import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync,spawnSync} from 'node:child_process';
import {baselineFixture,workflow} from './notification-workflow-harness.mjs';

function python(code) {
  return execFileSync('python3',['-c',`import copy,json,sys,runpy,tempfile,os,hashlib,pathlib
m=runpy.run_path('scripts/deploy-notification-review.py')
w=json.load(sys.stdin)
pins=m['fingerprint'](w)
def fails(fn):
 try:fn()
 except (ValueError,FileExistsError):return
 raise AssertionError('Expected fail-closed rejection')
${code}`],{input:JSON.stringify(baselineFixture()),encoding:'utf8'}).trim();
}

test('exact deploy preserves original sender identity, HTML expressions, credential refs and unaffected nodes/settings',()=>{
  const before=baselineFixture();
  assert.deepEqual(workflow.settings,before.settings);assert.equal('staticData' in workflow,false);
  for(const node of before.nodes) {
    const next=workflow.nodes.find(n=>n.name===node.name);
    if(node.type==='n8n-nodes-base.microsoftOutlook') {
      assert.deepEqual(next,{...node,retryOnFail:false,onError:'stopWorkflow'});
    } else if(node.type!=='n8n-nodes-base.code')assert.deepEqual(next,node);
  }
  const credential=before.nodes[0].credentials.httpHeaderAuth;
  for(const node of workflow.nodes.filter(n=>n.type==='n8n-nodes-base.httpRequest'))assert.deepEqual(node.credentials,{httpHeaderAuth:credential});
  assert.equal(workflow.nodes.length,13);
});

test('full-node, version, settings and topology pins reject every unreviewed baseline mutation',()=>{
  assert.equal(python(`
before=copy.deepcopy(w)
m['patch'](w,pins)
assert w==before
mutations=[lambda x:x.update(id='wrong'),lambda x:x.update(name='wrong'),lambda x:x.update(versionId='new'),
 lambda x:x.update(activeVersionId='unreviewed'),lambda x:x['connections'].clear(),lambda x:x['settings'].update(executionTimeout=300),
 lambda x:x['nodes'].append(copy.deepcopy(x['nodes'][0]))]
for index in range(len(w['nodes'])):
 mutations.append(lambda x,i=index:x['nodes'][i]['parameters'].update(unreviewed=True))
mutations += [lambda x:x['nodes'][0]['credentials']['httpHeaderAuth'].update(id='wrong'),
 lambda x:x['nodes'][3]['credentials']['microsoftOutlookOAuth2Api'].update(id='wrong'),
 lambda x:x['nodes'][3].update(retryOnFail=True),lambda x:x['nodes'][3].update(onError='continueRegularOutput')]
for mutate in mutations:
 bad=copy.deepcopy(w);mutate(bad);fails(lambda:m['patch'](bad,pins))
print('passed')`),'passed');
});

const fakeApi=`
class Api:
 def __init__(self):self.live=copy.deepcopy(w);self.requests=[];self.executions=[];self.pages=None
 def __call__(self,method,path,body=None):
  self.requests.append((method,path,copy.deepcopy(body)))
  if path.startswith('executions?'):
   assert 'workflowId=D6UG5ACZGILCpsOk' in path and 'includeData=false' in path
   return copy.deepcopy(self.pages.pop(0) if self.pages else {'data':self.executions})
  assert path=='workflows/'+m['WORKFLOW']
  if method=='PUT':
   assert self.live['active'] is False and 'staticData' not in body
   self.live.update(copy.deepcopy(body));self.live['versionId']='installed-version'
  else:assert method=='GET'
  return copy.deepcopy(self.live)
api=Api()
key='leave:10000000-0000-4000-8000-000000000001:leave-submitted:'+'a'*24
api.live['staticData']['global']['leaveNotificationEvents'][key]={'state':'sent','at':1,'unknownPrivateField':'not exported'}
sleeps=[]
snapshot=m['freeze'](api,pins,sleep=sleeps.append,now=lambda:1000)
`;

test('snapshot drains full timeout before final receipts and never pauses/activates; exact file bytes mode0600',()=>{
  assert.equal(python(fakeApi+`
assert sleeps==[30,1]
assert snapshot['receipts']=={key:{'state':'sent','at':1}}
assert set(['workflowId','versionId','capturedAt','receipts'])<=set(snapshot)
assert 'unknownPrivateField' not in json.dumps(snapshot)
assert all(method=='GET' for method,_,_ in api.requests)
with tempfile.TemporaryDirectory(prefix='mam-receipt-test-',dir=m['TEMP_ROOT']) as folder:
 path=pathlib.Path(folder)/'legacy.json'
 m['write_snapshot'](path,snapshot)
 assert path.stat().st_mode & 0o777 == 0o600
 exact=hashlib.sha256(path.read_bytes()).hexdigest()
 assert m['read_snapshot'](path,exact)==snapshot
 fails(lambda:m['read_snapshot'](path,'0'*64))
 fails(lambda:m['write_snapshot'](path,snapshot))
 os.chmod(path,0o644);fails(lambda:m['read_snapshot'](path,exact))
print('passed')`),'passed');
});

test('baseline import gate and desired enable gate verify paused static snapshot and exact installed graph',()=>{
  assert.equal(python(fakeApi+`
assert m['verify_frozen_snapshot'](snapshot,'baseline',api=api,baseline=pins)['nonterminalCount']==0
fails(lambda:m['verify_frozen_snapshot'](snapshot,'desired',api=api,baseline=pins))
installed=m['apply_paused'](api,snapshot,m['bundle_hash'](),pins)
assert installed['active'] is False and installed['versionId']=='installed-version'
assert m['verify_frozen_snapshot'](snapshot,'desired',expected_version='installed-version',api=api,baseline=pins)['phase']=='desired'
fails(lambda:m['verify_frozen_snapshot'](snapshot,'baseline',api=api,baseline=pins))
fails(lambda:m['verify_frozen_snapshot'](snapshot,'desired',expected_version='wrong',api=api,baseline=pins))
assert [method for method,_,_ in api.requests if method!='GET']==['PUT']
assert api.live['staticData']['global']['leaveNotificationEvents'][key]['unknownPrivateField']=='not exported'
for mutate in [lambda x:x.update(active=True),lambda x:x.update(activeVersionId='active'),
 lambda x:x['nodes'][0]['credentials']['httpHeaderAuth'].update(id='wrong'),
 lambda x:x['connections'].clear(),lambda x:x['staticData']['global']['leaveNotificationEvents'].clear()]:
 saved=copy.deepcopy(api.live);mutate(api.live)
 fails(lambda:m['verify_frozen_snapshot'](snapshot,'desired',api=api,baseline=pins))
 api.live=saved
print('passed')`),'passed');
});

test('snapshot observes post-drain changes and refuses unstable final snapshots or active executions',()=>{
  assert.equal(python(fakeApi+`
api=Api()
def drain(seconds):
 if seconds==30:api.live['staticData']['global']['leaveNotificationEvents'][key]={'state':'sent','at':999}
snap=m['freeze'](api,pins,sleep=drain)
assert snap['receipts'][key]['at']==999
def race(seconds):
 if seconds==1:api.live['staticData']['global']['leaveNotificationEvents'][key]['at']+=1
fails(lambda:m['freeze'](api,pins,sleep=race))
api.live['active']=True
fails(lambda:m['freeze'](api,pins,sleep=lambda _:None))
api.live['active']=False
for status in ['new','running','waiting','unknown','queued',None]:
 api.executions=[{'workflowId':m['WORKFLOW'],'status':status}]
 fails(lambda:m['freeze'](api,pins,sleep=lambda _:None))
print('passed')`),'passed');
});

test('execution inventory paginates all nonterminal states without reading payloads and fails on incomplete scope',()=>{
  assert.equal(python(fakeApi+`
api.pages=[{'data':[{'workflowId':m['WORKFLOW'],'status':'success'}],'nextCursor':'next'},
 {'data':[{'workflowId':m['WORKFLOW'],'status':'new'},{'workflowId':m['WORKFLOW'],'status':'waiting'}]}]
assert m['nonterminal_count'](api)==2
api.pages=[{'data':[],'nextCursor':'repeat'},{'data':[],'nextCursor':'repeat'}]
fails(lambda:m['nonterminal_count'](api))
api.executions=[{'workflowId':'wrong','status':'running'}]
fails(lambda:m['nonterminal_count'](api))
print('passed')`),'passed');
});

test('apply fails before write on active, running, bundle, frozen receipt or baseline drift',()=>{
  assert.equal(python(fakeApi+`
for mutate in [lambda a:a.live.update(active=True),lambda a:a.live.update(versionId='drift'),
 lambda a:a.live['staticData']['global']['leaveNotificationEvents'][key].update(at=2),
 lambda a:a.executions.append({'workflowId':m['WORKFLOW'],'status':'running'})]:
 saved=copy.deepcopy(api.live);mutate(api);api.requests=[]
 fails(lambda:m['apply_paused'](api,snapshot,m['bundle_hash'](),pins))
 assert all(method=='GET' for method,_,_ in api.requests)
 api.live=saved;api.executions=[]
fails(lambda:m['apply_paused'](api,snapshot,'wrong',pins))
bad=copy.deepcopy(snapshot);bad['receipts'][key]['at']=2
fails(lambda:m['apply_paused'](api,bad,m['bundle_hash'](),pins))
print('passed')`),'passed');
});

test('snapshot rejects legacy syntax/state/time ambiguity without printing raw keys',()=>{
  assert.equal(python(`
for key,value in [('invalid',{'state':'sent','at':1}),('payroll-comparison:10000000-0000-4000-8000-000000000001',{'state':'unknown','at':1}),
 ('payroll-comparison:10000000-0000-4000-8000-000000000001',{'state':'sent','at':float('nan')})]:
 bad=copy.deepcopy(w);bad['staticData']['global']['leaveNotificationEvents']={key:value}
 fails(lambda:m['minimal_receipts'](bad))
print('passed')`),'passed');
});

test('obsolete receiver installer is blocked before verification or any network operation',()=>{
  const result=spawnSync('python3',['scripts/deploy-priority-n8n.py','--n8n-root','/does-not-exist','receiver'],{encoding:'utf8'});
  assert.notEqual(result.status,0);assert.match(result.stderr,/durable topology and paused cutover/);
  assert(!result.stderr.includes('verify.py'));
});

test('isolated credential probe is callable only by random GET path and returns minimal readiness, never sends/reserves',()=>{
  const probe=JSON.parse(python(`
probe=m['credential_probe'](w,'10000000-0000-4000-8000-000000000001',pins)
for path in ['fixed','../secret','https://attacker.test','10000000-0000-1000-8000-000000000001']:
 fails(lambda:m['credential_probe'](w,path,pins))
print(json.dumps(probe))`));
  const [hook,http,result]=probe.nodes;
  assert.equal(probe.nodes.length,3);assert.equal(hook.type,'n8n-nodes-base.webhook');
  assert.equal(hook.parameters.httpMethod,'GET');assert.equal(hook.parameters.authentication,'none');assert.equal(hook.parameters.responseMode,'lastNode');
  assert.equal(http.parameters.method,'GET');assert.equal(http.parameters.sendBody,undefined);
  assert.equal(http.parameters.url,'https://mam-team-management-system-ten.vercel.app/api/internal/integrations/notifications/receipts');
  assert.equal(http.parameters.options.redirect.redirect.followRedirects,false);
  assert.deepEqual(http.credentials,baselineFixture().nodes[0].credentials);
  assert.deepEqual(Object.keys(probe.connections),[hook.name,http.name]);
  assert.equal(probe.connections[hook.name].main[0][0].node,http.name);
  assert.equal(probe.connections[http.name].main[0][0].node,result.name);
  const evaluate=new Function('$input',result.parameters.jsCode);
  assert.deepEqual(evaluate({all:()=>[{json:{version:1,ready:false,secret:'DO NOT ECHO'}}]}),[{json:{version:1,ready:false}}]);
  assert.throws(()=>evaluate({all:()=>[{json:{ready:true}}]}),/Readiness unavailable/);
  assert.equal(probe.settings.saveManualExecutions,false);assert.equal(probe.settings.saveDataErrorExecution,'none');
});
