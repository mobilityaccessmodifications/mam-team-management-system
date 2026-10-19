import contextlib,copy,hashlib,io,json,os,re,runpy,shutil,subprocess,sys,tempfile,urllib.request
from pathlib import Path
from unittest.mock import patch
ROOT=Path(__file__).resolve().parents[1]
mode=sys.argv[1]
sha=lambda b:hashlib.sha256(b).hexdigest()
base=Path(tempfile.mkdtemp(prefix='prcli')).resolve()
root=base/'source'; root.mkdir(); private=base/'operator';private.mkdir(mode=0o700)
paths=['scripts/deploy-performance-reviews.py','scripts/deploy-staff-leave-calendar.py']+[str(p.relative_to(ROOT)) for p in (ROOT/'supabase/migrations').glob('*.sql') if p.name[:14]<='20261016150000']
for name in paths:
 p=root/name;p.parent.mkdir(parents=True,exist_ok=True);p.write_bytes((ROOT/name).read_bytes())
helper=root/'scripts/deploy-performance-reviews.py';migration=root/'supabase/migrations/20261016150000_performance_reviews_and_mail.sql'; predecessor=root/'supabase/migrations/20261014233948_subscription_request_start_date.sql'
source=migration.read_text();spec=json.loads(re.search(r'\$performance_expected\$(.*?)\$performance_expected\$',source,re.S).group(1))['17']
anchor_text=re.search(r'anchors jsonb; expected jsonb:=\'(.*?)\'::jsonb;',source,re.S).group(1).replace("''", "'")
anchors=json.loads(anchor_text)
ledger=json.loads((ROOT/'tests/performance-review-production-ledger-fixture.json').read_text())
for row in ledger:
 row.update(isNull=row['statementCount'] is None,ndims=1 if row['dimensions'] else None,lower=1 if row['dimensions'] else None,upper=row['statementCount'] if row['dimensions'] else None,sourceRoundtrip=True,rowSha256=sha(('MODEL-row-'+row['version']).encode()),elements=[{'subscript':i+1,'isNull':False,'sha256':sha(('MODEL-element-'+row['version']+'-'+str(i)).encode()),'bytes':10} for i in range(row['statementCount'] or 0)])
state={'major':17,'actor':'postgres','session':'postgres','readOnly':'on','catalogHash':'a'*64,'catalogMatches':True,'securityHash':'b'*64,'dataHash':'c'*64,'predecessorExact':True,'targetExact':False,'ledger':ledger,'anchors':anchors,'feature':{'functions':{},'relations':{k:None for k in spec['relations']},'sequences':{k:None for k in spec['sequences']}}}
counts={'projectReads':0,'metadataReads':0,'mutationDispatches':0};last_sql=None
active_fault=None
trace=[]
trace_root=Path(os.environ.get('MAM_PERFORMANCE_TEST_EVIDENCE',str(base/'traces')))
trace_root.mkdir(parents=True,exist_ok=True)
trace_dir=Path(tempfile.mkdtemp(prefix='cli-'+mode+'-',dir=trace_root))
class Response:
 def __init__(self,value):self.buffer=io.BytesIO(json.dumps(value).encode())
 def __enter__(self):return self
 def __exit__(self,*a):pass
 def read(self,*a):return self.buffer.read(*a)
def api(request,**kwargs):
 global state,last_sql
 if request.full_url=='https://api.supabase.com/v1/projects/xtwlrjqbusadghavchqm' and request.data is None:
  counts['projectReads']+=1
  if active_fault=='source-race':helper.write_bytes(helper.read_bytes()+b'\n')
  return Response({'id':'xtwlrjqbusadghavchqm','organization_id':'fwlmbmospuwoaosffvmw'})
 assert request.full_url=='https://api.supabase.com/v1/projects/xtwlrjqbusadghavchqm/database/query'
 body=json.loads(request.data);assert set(body)=={'query'};sql=body['query'];last_sql=sql
 if sql.startswith('begin read only;'):
  counts['metadataReads']+=1
  if active_fault=='readback-error' and counts['mutationDispatches']:raise TimeoutError('synthetic-readback-marker')
  return Response([{'state':copy.deepcopy(state)}])
 counts['mutationDispatches']+=1
 if active_fault=='unknown-before':raise TimeoutError('synthetic-provider-marker')
 if active_fault=='unknown-interrupt':raise KeyboardInterrupt('synthetic-interrupt-marker')
 journal=json.loads((private/'20261016150000.entered.json').read_text())
 assert journal['enteredMutation'] is True and journal['querySha256']==sha(sql.encode())
 assert sql.startswith('begin;') and 'lock table supabase_migrations.schema_migrations in access exclusive mode nowait;' in sql
 target={'version':'20261016150000','name':'performance_reviews_and_mail','dimensions':'[1:1]','statementCount':1,'isNull':False,'ndims':1,'lower':1,'upper':1,'sourceArraySha256':sha(b'MODEL-target-array'),'sourceRoundtrip':True,'rowSha256':sha(b'MODEL-target-row'),'elements':[{'subscript':1,'isNull':False,'sha256':sha(source.encode()),'bytes':len(source.encode())}]}
 state=copy.deepcopy(state);state.update(targetExact=True,catalogHash='d'*64,feature=spec);state['ledger'].append(target)
 if active_fault=='unknown-after':raise TimeoutError('synthetic-provider-marker')
 if active_fault=='malformed-attestation':return Response([{'resultingCatalogSha256':'d'*64,'unexpected':True}])
 if active_fault and active_fault.startswith('drift-'):
  field=active_fault[6:]
  if field=='major':state[field]=16
  elif field=='ledger':state['ledger'][0]['elements'][0]['sha256']='9'*64
  elif field=='feature':state['feature']=copy.deepcopy(spec);state['feature']['functions'].pop(next(iter(state['feature']['functions'])))
  else:state[field]='9'*64
 return Response([{'resultingCatalogSha256':'d'*64}])
git_binary=shutil.which('git')
assert git_binary is not None, 'Git is required for the portable source fixture'
git_env={'PATH':os.defpath,'LANG':'C','LC_ALL':'C','GIT_CONFIG_NOSYSTEM':'1','GIT_CONFIG_GLOBAL':'/dev/null','GIT_CONFIG_SYSTEM':'/dev/null'}
def fixture_git(*args):
 return subprocess.check_output([git_binary,'-c','core.hooksPath=/dev/null',*args],cwd=root,env=git_env,stderr=subprocess.PIPE)
fixture_git('init','--quiet','--template=')
fixture_git('config','--local','user.name','mobilityaccessmodifications')
fixture_git('config','--local','user.email','310802599+mobilityaccessmodifications@users.noreply.github.com')
fixture_git('remote','add','origin','https://github.com/mobilityaccessmodifications/mam-team-management-system.git')
fixture_git('add','--',*paths)
fixture_git('commit','--quiet','-m','Synthetic performance helper fixture')
head=fixture_git('rev-parse','HEAD').decode().strip()
args=[head]+[sha(p.read_bytes()) for p in [helper,root/'scripts/deploy-staff-leave-calendar.py',migration,predecessor]]
def invoke(command,extra=()):
 out,err=io.StringIO(),io.StringIO();oldargv=sys.argv;oldcwd=Path.cwd()
 try:
  os.chdir(root);sys.argv=[str(helper),command]+args+list(extra)
  with patch('urllib.request.urlopen',api),patch.dict(os.environ,{'SUPABASE_ACCESS_TOKEN':'synthetic-inert-only','PATH':os.defpath},clear=True),contextlib.redirect_stdout(out),contextlib.redirect_stderr(err):
   try:runpy.run_path(str(helper),run_name='__main__');code=0
   except SystemExit as e:code=e.code if isinstance(e.code,int) else 1;err.write(str(e.code))
  result={'exit':code,'stdout':out.getvalue(),'stderr':err.getvalue()}
  number=str(len(trace)+1).zfill(2);trace.append(result)
  for channel in ('stdout','stderr'):(trace_dir/(number+'.'+channel+'.log')).write_text(result[channel])
  (trace_dir/(number+'.receipt.json')).write_text(json.dumps({'classification':'MODEL_CLI_INERT_MANAGEMENT_REAL_GIT','command':command,'exit':code,'counts':copy.deepcopy(counts),'sourceHashes':{str(p.relative_to(root)):sha(p.read_bytes()) for p in [helper,root/'scripts/deploy-staff-leave-calendar.py',migration,predecessor]}},indent=2)+'\n')
  return result
 finally:sys.argv=oldargv;os.chdir(oldcwd)
try:
 results=[]
 if mode in ('recorded-major','snapshot-corrupt','snapshot-bound','spent-journal','source-race','unknown-interrupt','late-local','duplicate-local','malformed-local'):
  captured=invoke('snapshot',[str(private/'before.json')]);assert captured['exit']==0,captured
  pin=sha((private/'before.json').read_bytes())
  if mode=='recorded-major':
   completed=invoke('apply',[str(private/'before.json'),pin]);assert completed['exit']==0,completed
   state['major']=16
   for command in ('inspect','apply','readback'):
    denied=invoke(command,[] if command=='inspect' else [str(private/'before.json'),pin]);assert denied['exit']!=0,denied
   assert counts['mutationDispatches']==1
  else:
   if mode=='snapshot-corrupt':
    with (private/'before.json').open('ab') as stream:stream.write(b' ')
   elif mode=='snapshot-bound':
    saved=json.loads((private/'before.json').read_text());saved['project']='foreign-project';(private/'before.json').write_text(json.dumps(saved));pin=sha((private/'before.json').read_bytes())
   elif mode=='spent-journal':
    (private/'20261016150000.entered.json').write_text('{}');(private/'20261016150000.entered.json').chmod(0o600)
   elif mode=='late-local':(migration.parent/'20261017150000_unrelated.sql').write_text('select 1;')
   elif mode=='duplicate-local':(migration.parent/'20261016150000_duplicate.sql').write_text('select 1;')
   elif mode=='malformed-local':(migration.parent/'20261016_malformed.sql').write_text('select 1;')
   else:active_fault=mode
   denied=invoke('apply',[str(private/'before.json'),pin]);assert denied['exit']!=0,denied
   assert counts['mutationDispatches']==(1 if mode=='unknown-interrupt' else 0)
   if mode=='unknown-interrupt':
    assert 'HOLD' in denied['stderr'];active_fault=None;again=invoke('apply',[str(private/'before.json'),pin]);assert again['exit']!=0 and counts['mutationDispatches']==1
  print(json.dumps({'classification':'MODEL_CLI_INERT_MANAGEMENT_REAL_GIT','scenario':mode,'counts':counts,'results':trace}));sys.exit(0)
 if mode in ('unknown-before','unknown-after','malformed-attestation','readback-error') or mode.startswith('drift-'):
  captured=invoke('snapshot',[str(private/'before.json')]);assert captured['exit']==0,captured
  pin=sha((private/'before.json').read_bytes());active_fault=mode
  failed=invoke('apply',[str(private/'before.json'),pin]);assert failed['exit']!=0 and 'HOLD' in failed['stderr'],failed
  assert 'synthetic-provider-marker' not in failed['stderr'] and 'synthetic-readback-marker' not in failed['stderr']
  journal=(private/'20261016150000.entered.json').read_bytes();assert counts['mutationDispatches']==1
  active_fault=None
  repeated=invoke('apply',[str(private/'before.json'),pin]);assert repeated['exit']!=0 and 'HOLD' in repeated['stderr'],repeated
  assert counts['mutationDispatches']==1 and (private/'20261016150000.entered.json').read_bytes()==journal
  reconciled=invoke('readback',[str(private/'before.json'),pin])
  if mode in ('unknown-after','malformed-attestation','readback-error'):assert reconciled['exit']==0,reconciled
  else:assert reconciled['exit']!=0,reconciled
  assert counts['mutationDispatches']==1 and not (private/'20261016150000.verified.json').exists()
  print(json.dumps({'classification':'MODEL_CLI_INERT_MANAGEMENT_REAL_GIT','scenario':mode,'counts':counts,'results':trace}));sys.exit(0)
 if mode.startswith('deny-'):
  field=mode[5:];row=next(row for row in state['ledger'] if row['elements'])
  if field=='major':state['major']=16
  elif field=='boolean-major':state['major']=True
  elif field=='boolean-ndims':row['ndims']=True
  elif field=='duplicate-version':state['ledger'].insert(0,copy.deepcopy(state['ledger'][0]))
  elif field=='alias':row['name']+='x'
  elif field=='dimensions':row['dimensions']='[0:'+str(row['statementCount']-1)+']'
  elif field=='null-elements':row['elements'][0]['isNull']=True
  elif field=='raw-source':row['sourceArraySha256']='9'*64
  elif field=='anchor':state['anchors']=copy.deepcopy(anchors);state['anchors'].pop(next(iter(anchors)))
  elif field=='predecessor':state['predecessorExact']=False
  elif field=='catalog':state['catalogMatches']=False
  else:raise AssertionError(mode)
  denied=invoke('inspect');assert denied['exit']!=0,denied
  assert counts['mutationDispatches']==0 and not (private/'20261016150000.entered.json').exists()
  print(json.dumps({'classification':'MODEL_CLI_INERT_MANAGEMENT_REAL_GIT','scenario':mode,'counts':counts,'results':trace}));sys.exit(0)
 if mode=='apply':
  captured=invoke('snapshot',[str(private/'before.json')]);assert captured['exit']==0,captured;results.append(captured)
  pin=sha((private/'before.json').read_bytes())
  result=invoke('apply',[str(private/'before.json'),pin]);assert result['exit']==0,result;results.append(result)
  receipt=json.loads(result['stdout']);assert receipt['committed'] is True and receipt['readbackVerified'] is True
  again=invoke('apply',[str(private/'before.json'),pin]);assert again['exit']==0,again;results.append(again);assert json.loads(again['stdout'])['recorded'] is True
  readback=invoke('readback',[str(private/'before.json'),pin]);assert readback['exit']==0,readback;results.append(readback)
  assert counts['mutationDispatches']==1
  print(json.dumps({'classification':'MODEL_CLI_INERT_MANAGEMENT_REAL_GIT','scenario':mode,'counts':counts,'results':results}))
  sys.exit(0)
 result=invoke('snapshot',[str(private/'before.json')]) if mode=='snapshot' else invoke('inspect');assert result['exit']==0,result
 receipt=json.loads(result['stdout']);assert receipt['readOnly'] is True and receipt['major']==17 and receipt['targetAbsent'] is True
 if mode=='snapshot':
  captured=json.loads((private/'before.json').read_text());assert captured['before']==state and captured['version']=='20261016150000';assert receipt['snapshotSha256']==sha((private/'before.json').read_bytes())
 assert counts=={'projectReads':1,'metadataReads':1,'mutationDispatches':0},counts
 print(json.dumps({'classification':'MODEL_CLI_INERT_MANAGEMENT_REAL_GIT','scenario':mode,'counts':counts,'results':[result]}))
finally:shutil.rmtree(base)
