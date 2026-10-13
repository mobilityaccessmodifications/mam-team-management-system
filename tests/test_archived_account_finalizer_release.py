import builtins
import contextlib
import copy
import importlib.machinery
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT=Path(__file__).resolve().parents[1]
HELPER=ROOT/'scripts/deploy-archived-account-finalizer.py'
SIGNATURE='public.finalise_portal_account_status_change(uuid,uuid,uuid)'


def load_helper(path=HELPER):
 if not path.is_file():
  raise AssertionError('Required exact-source archived finalizer helper is missing')
 spec=importlib.util.spec_from_file_location('archived_finalizer_release',path)
 assert spec is not None and spec.loader is not None
 helper=importlib.util.module_from_spec(spec)
 spec.loader.exec_module(helper)
 return helper


@contextlib.contextmanager
def release_source_fixture():
 paths=[HELPER.relative_to(ROOT),Path('scripts/deploy-staff-leave-calendar.py'),
        Path('supabase/migrations/20261013081500_archived_account_status_finalizer.sql'),
        Path('supabase/migrations/20261012170000_employee_removal_reporting_splice.sql')]
 with tempfile.TemporaryDirectory(prefix='finalizer-source-unit-') as directory:
  parent=Path(directory).resolve()
  root=parent/'repo'
  root.mkdir()
  home=parent/'home'
  home.mkdir()
  for path in paths:
   raw=(ROOT/path).read_bytes()
   target=root/path
   target.parent.mkdir(parents=True,exist_ok=True)
   target.write_bytes(raw)
   assert target.read_bytes()==raw
  environment={'PATH':os.environ.get('PATH',os.defpath),'HOME':str(home),
               'TMPDIR':tempfile.gettempdir(),'LANG':'C','LC_ALL':'C',
               'GIT_CONFIG_NOSYSTEM':'1','GIT_CONFIG_GLOBAL':os.devnull}
  with patch.dict(os.environ,environment,clear=True),patch.object(sys,'dont_write_bytecode',True),patch.dict(sys.modules):
   def git(*args):
    return subprocess.check_output(['git',*args],cwd=root)
   git('-c','init.templateDir=','init','-q')
   git('config','--local','user.name','mobilityaccessmodifications')
   git('config','--local','user.email','310802599+mobilityaccessmodifications@users.noreply.github.com')
   git('config','--local','core.autocrlf','false')
   git('remote','add','origin','https://github.com/mobilityaccessmodifications/mam-team-management-system.git')
   git('add','--',*map(str,paths))
   git('commit','-q','-m','Synthetic archived finalizer source fixture')
   head=git('rev-parse','HEAD').decode().strip()
   helper=load_helper(root/HELPER.relative_to(ROOT))
   cwd=Path.cwd()
   os.chdir(root)
   try:
    yield helper,head
   finally:
    os.chdir(cwd)


def before_frame():
 return {'major':17,'dataHash':'a'*64,'securityHash':'b'*64,'receiptHash':'c'*64,'purgeHash':'d'*64,'purgeMatches':True,'predecessorExact':True,'predecessorFunctionsExact':True,'targetExact':False,'targetSourceArraySha256':'1'*64,'tradeSchoolEnabledCount':0,'ledger':[{'version':'20261012170000','name':'employee_removal_reporting_splice','dimensions':'[1:1]','cardinality':1,'sourceSha256':'e'*64}],'functions':{SIGNATURE:{'sha256':'61ba36c671f280728d474a191b3b6c24d3c578741d995af73b9d8d4929d28792','metadata':{},'portable':{}}}}


class ArchivedFinalizerReleaseTests(unittest.TestCase):
 def setUp(self):
  deny=patch('urllib.request.urlopen',side_effect=AssertionError('Offline tests forbid network'))
  deny.start()
  self.addCleanup(deny.stop)

 def test_actual_transport_replacement_between_measurement_and_loader_cannot_execute(self):
  transport=ROOT/'scripts/deploy-staff-leave-calendar.py'
  raw=transport.read_bytes()
  replacement=raw+b'\nimport builtins\nbuiltins._mam_finalizer_unverified_top.append("unverified_dependency_executed")\n'
  read=Path.read_bytes
  get_data=importlib.machinery.SourceFileLoader.get_data
  compile_source=builtins.compile
  measured=[]
  loaded=[]
  compiled=[]
  def read_bytes(path):
   value=read(path)
   if path==transport:
    measured.append(value)
   return value
  def changed_get_data(loader,path):
   if Path(loader.path) in (HELPER,transport) and Path(path).suffix=='.pyc':
    raise FileNotFoundError(path)
   if Path(loader.path)==transport and Path(path)==transport:
    self.assertEqual(measured,[raw])
    loaded.append(replacement)
    return replacement
   return get_data(loader,path)
  def observed_compile(source,filename,*args,**kwargs):
   if str(filename)==str(transport):
    compiled.append(source.encode() if isinstance(source,str) else source)
   return compile_source(source,filename,*args,**kwargs)
  with patch.object(builtins,'_mam_finalizer_unverified_top',[],create=True),patch.object(Path,'read_bytes',new=read_bytes),patch.object(importlib.machinery.SourceFileLoader,'get_data',new=changed_get_data),patch.object(builtins,'compile',new=observed_compile),patch('urllib.request.urlopen',side_effect=AssertionError('No API or SQL dispatch permitted')) as network:
   helper=load_helper()
   self.provenance={'measuredSha256':helper.sha(raw),'replacementSha256':helper.sha(replacement),'loadedSha256':[helper.sha(value) for value in loaded],'compiledSha256':[helper.sha(value) for value in compiled],'sentinel':list(getattr(builtins,'_mam_finalizer_unverified_top')),'apiAndQueryNetworkCalls':network.call_count,'physicalTransportUnchanged':read(transport)==raw}
   self.assertEqual(getattr(builtins,'_mam_finalizer_unverified_top'),[],'Unverified transport top-level code executed after the pinned read')
   self.assertEqual(measured,[raw])
   self.assertEqual(compiled,[raw])
   self.assertEqual(helper.SHARED.__file__,str(transport))
   self.assertIs(helper.api,helper.SHARED.api)
   self.assertIs(helper.query,helper.SHARED.query)
   network.assert_not_called()
  self.assertEqual(transport.read_bytes(),raw)

 def test_actual_corrupt_transport_snapshot_rejects_before_first_statement(self):
  transport=ROOT/'scripts/deploy-staff-leave-calendar.py'
  raw=transport.read_bytes()
  replacement=raw+b'\nimport builtins\nbuiltins._mam_finalizer_unverified_top.append("corrupt_top_level")\napi("")\nquery("select 1")\n'
  read=Path.read_bytes
  get_data=importlib.machinery.SourceFileLoader.get_data
  def read_bytes(path):
   return replacement if path==transport else read(path)
  def no_bytecode(loader,path):
   if Path(loader.path) in (HELPER,transport) and Path(path).suffix=='.pyc':
    raise FileNotFoundError(path)
   return get_data(loader,path)
  with patch.object(builtins,'_mam_finalizer_unverified_top',[],create=True),patch.object(Path,'read_bytes',new=read_bytes),patch.object(importlib.machinery.SourceFileLoader,'get_data',new=no_bytecode),patch('urllib.request.urlopen',side_effect=AssertionError('Corrupt snapshot cannot call API or SQL')) as network:
   with self.assertRaisesRegex(SystemExit,'Reviewed scoped transport source differs'):
    load_helper()
   self.provenance={'sentinel':list(getattr(builtins,'_mam_finalizer_unverified_top')),'apiAndQueryNetworkCalls':network.call_count,'physicalTransportUnchanged':read(transport)==raw}
   self.assertEqual(getattr(builtins,'_mam_finalizer_unverified_top'),[])
   network.assert_not_called()
  self.assertEqual(transport.read_bytes(),raw)

 def test_actual_default_transport_uses_real_module_metadata_and_functions(self):
  helper=load_helper()
  transport=ROOT/'scripts/deploy-staff-leave-calendar.py'
  self.assertEqual(helper.SHARED.__file__,str(transport))
  self.assertEqual(helper.SHARED.__name__,'archived_finalizer_transport')
  self.assertEqual(helper.SHARED.__spec__.origin,str(transport))
  self.assertIs(helper.SHARED.__loader__,helper.SPEC.loader)
  self.assertEqual(helper.SHARED.MIGRATION.parent,ROOT/'supabase/migrations')
  for name in ('require','literal','api','query'):
   function=getattr(helper.SHARED,name)
   self.assertIs(getattr(helper,name),function)
   self.assertEqual(function.__module__,helper.SHARED.__name__)
   self.assertEqual(function.__code__.co_filename,str(transport))
  self.assertEqual(helper.literal("a'b"),"'a''b'")
  self.provenance={'realModule':True,'file':helper.SHARED.__file__,'transportSha256':helper.sha(transport.read_bytes())}

 def test_database_role_setting_inventory_is_source_derived_and_digest_only(self):
  helper=load_helper()
  source=helper.candidate(helper.sha(helper.MIGRATION.read_bytes()))
  security=helper.source_function(source,'archived_finalizer_security')
  branch=[row for row in security.splitlines() if "'database_role_settings'" in row]
  self.assertEqual(len(branch),1)
  self.assertIn("(to_jsonb(s)-'setconfig')",branch[0])
  self.assertIn("extensions.digest(coalesce(s.setconfig::text,'<NULL>'),'sha256')",branch[0])
  self.assertIn('order by s.setdatabase,s.setrole) from pg_db_role_setting s)',branch[0])
  self.assertNotIn('where',branch[0].lower())
  self.assertIn(branch[0],helper.state_expression(source))
  transaction=helper.transaction(source,before_frame())
  live_final=transaction[transaction.index('\ndo $archived_finalizer_release_final$'):]
  self.assertIn(branch[0],live_final)
  self.assertIn("actual->>'securityHash' is distinct from expected->>'securityHash'",live_final)

 def test_exact_single_function_transaction_preserves_f65_and_full_envelope(self):
  helper=load_helper()
  source=helper.candidate(helper.sha(helper.MIGRATION.read_bytes()))
  self.assertEqual(helper.PREDECESSOR_VERSION,'20261012170000')
  self.assertEqual(helper.sha(helper.PREDECESSOR.read_bytes()),'f65d043e18716538a6bc29bd0f5d0d95b9d58975de43334705972a0919a4e9e4')
  self.assertEqual(set(helper.function_spec(source)),{SIGNATURE})
  self.assertEqual(helper.function_spec(source)[SIGNATURE]['before'],before_frame()['functions'][SIGNATURE]['sha256'])
  transaction=helper.transaction(source,before_frame())
  self.assertEqual(transaction.count(helper.transaction_body(source)),1)
  ledger=transaction.index('\ninsert into supabase_migrations.schema_migrations')
  self.assertIn('set constraints all immediate;',transaction[ledger:])
  self.assertIn('pg_temp.archived_finalizer_assert_delta()',transaction[ledger:])
  self.assertIn('pg_temp.archived_finalizer_security()',transaction[ledger:])
  security=helper.source_function(source,'archived_finalizer_security')
  for name in ('policies','columns','role_memberships','default_acls','roles','schemas','functions','triggers'):
   self.assertIn("'"+name+"'",security)
  with self.assertRaises(SystemExit):
   helper.function_spec(source.replace(before_frame()['functions'][SIGNATURE]['sha256'],'0'*64))


 def test_supported_f65_native_definition_contract_rejects_unknown_source_pins(self):
  helper=load_helper()
  source=helper.candidate(helper.sha(helper.MIGRATION.read_bytes()))
  pin='801a9f690a30f3f2842f37c1a3e7e3f24339eb7b766b5e289a4740c1fa1782df'
  with tempfile.TemporaryDirectory(prefix='finalizer-pin-negative-') as directory:
   path=Path(directory)/'core.sql'
   path.write_text(source.replace(pin,'0'*64))
   with patch.object(helper,'MIGRATION',path), self.assertRaises(SystemExit):
    helper.candidate(helper.sha(path.read_bytes()))


 def test_readback_rejects_every_catalog_security_data_receipt_and_raw_ledger_field(self):
  helper=load_helper()
  source=helper.candidate(helper.sha(helper.MIGRATION.read_bytes()))
  before=before_frame()
  after=copy.deepcopy(before)
  after.update(purgeHash='f'*64,targetExact=True)
  after['functions'][SIGNATURE]['sha256']=helper.function_spec(source)[SIGNATURE]['after']
  after['ledger'].append({'version':helper.VERSION,'name':helper.NAME,'dimensions':'[1:1]','cardinality':1,'sourceSha256':before['targetSourceArraySha256']})
  helper.verify_after(after,before,source,'f'*64)
  for field in before.keys()-{'ledger','functions'}:
   changed=copy.deepcopy(after)
   changed[field]=None
   with self.subTest(field=field),self.assertRaises(SystemExit):
    helper.verify_after(changed,before,source,'f'*64)
  for field,value in [('sha256','0'*64),('metadata',{'owner':'changed'}),('portable',{'acl':'changed'})]:
   changed=copy.deepcopy(after)
   changed['functions'][SIGNATURE][field]=value
   with self.subTest(field=field),self.assertRaises(SystemExit):
    helper.verify_after(changed,before,source,'f'*64)
  changed=copy.deepcopy(after)
  changed['ledger'][0]['dimensions']='[0:0]'
  with self.assertRaises(SystemExit):
   helper.verify_after(changed,before,source,'f'*64)
  for result in [[],[{}],[{'archivedFinalizerResultingCatalogSha256':'bad'}],[{},{}]]:
   with self.subTest(result=result),self.assertRaises(SystemExit):
    helper.resulting_catalog(result)

 def test_exact_raw_ledger_shapes_and_json_are_fail_closed(self):
  helper=load_helper()
  source=helper.candidate(helper.sha(helper.MIGRATION.read_bytes()))
  for count,dimensions in [(None,None),(0,None),(2,'[0:1]')]:
   before=before_frame()
   before['ledger'].insert(0,{'version':'19000101000001','name':'synthetic_history','dimensions':dimensions,'cardinality':count,'sourceSha256':'9'*64})
   helper.validate_before(before,source)
  for count,dimensions in [(True,'[1:1]'),(-1,None),(2,'[1:1]'),(2,'[1:1][1:2]'),(None,'[1:1]')]:
   before=before_frame()
   before['ledger'][0].update(cardinality=count,dimensions=dimensions)
   with self.subTest(count=count,dimensions=dimensions),self.assertRaises(SystemExit):
    helper.validate_before(before,source)
  for raw in ['{"x":1,"x":2}','{"x":NaN}','{"x":Infinity}','{"x":-Infinity}']:
   with self.subTest(raw=raw),self.assertRaises(SystemExit):
    helper.load_json(raw)
  for changes in [{'major':15},{'predecessorFunctionsExact':False},{'predecessorExact':False},{'purgeMatches':False}]:
   before=before_frame()
   before.update(changes)
   with self.subTest(changes=changes),self.assertRaises(SystemExit):
    helper.validate_before(before,source)

 def test_model_unknown_dispatch_is_spent_and_reconciliation_is_read_only(self):
  helper=load_helper()
  source_sha=helper.sha(helper.MIGRATION.read_bytes())
  source=helper.candidate(source_sha)
  with tempfile.TemporaryDirectory(prefix='finalizer-unknown-model-') as directory:
   path=Path(directory)
   snapshot=path/'before.json'
   helper.retain(snapshot,before_frame())
   expected=helper.transaction(source,helper.load_json(snapshot.read_bytes()))
   receipt,dispatch=path/'receipt.json',path/'dispatch.json'
   args=['apply','--source-sha',source_sha,'--snapshot',str(snapshot),'--snapshot-sha',helper.sha(snapshot.read_bytes()),'--head','a'*40,'--helper-sha',helper.sha(HELPER.read_bytes()),'--attestation',str(receipt),'--dispatch',str(dispatch)]
   stdout=io.StringIO()
   with patch.object(helper,'clean_source'),patch.object(helper,'api',return_value={'id':helper.PROJECT,'organization_id':helper.ORGANISATION}),patch.object(helper,'read_state',return_value=before_frame()) as reads,patch.object(helper,'query',side_effect=TimeoutError('MODEL unknown outcome')) as writes,contextlib.redirect_stdout(stdout),self.assertRaises(SystemExit):
    helper.main(args)
   self.assertEqual(writes.call_count,1)
   self.assertEqual(writes.call_args.args[0],expected)
   self.assertEqual(reads.call_count,2)
   self.assertEqual(helper.load_json(dispatch.read_bytes())['transactionSha256'],helper.sha(expected.encode()))
   self.assertFalse(receipt.exists())
   with patch.object(helper,'clean_source'),patch.object(helper,'api',return_value={'id':helper.PROJECT,'organization_id':helper.ORGANISATION}),patch.object(helper,'read_state',return_value=before_frame()),patch.object(helper,'query',side_effect=AssertionError('Spent dispatch cannot write')) as writes,self.assertRaises(SystemExit):
    helper.main(args)
   writes.assert_not_called()

 def test_model_recorded_receipt_replay_checks_identity_without_writing(self):
  helper=load_helper()
  source_sha=helper.sha(helper.MIGRATION.read_bytes())
  source=helper.candidate(source_sha)
  before=before_frame()
  after=copy.deepcopy(before)
  after.update(purgeHash='f'*64,targetExact=True)
  after['functions'][SIGNATURE]['sha256']=helper.function_spec(source)[SIGNATURE]['after']
  after['ledger'].append({'version':helper.VERSION,'name':helper.NAME,'dimensions':'[1:1]','cardinality':1,'sourceSha256':before['targetSourceArraySha256']})
  with tempfile.TemporaryDirectory(prefix='finalizer-commit-model-') as directory:
   path=Path(directory)
   snapshot=path/'before.json'
   helper.retain(snapshot,before)
   receipt,dispatch=path/'receipt.json',path/'dispatch.json'
   args=['apply','--source-sha',source_sha,'--snapshot',str(snapshot),'--snapshot-sha',helper.sha(snapshot.read_bytes()),'--head','a'*40,'--helper-sha',helper.sha(HELPER.read_bytes()),'--attestation',str(receipt),'--dispatch',str(dispatch)]
   with patch.object(helper,'clean_source'),patch.object(helper,'api',return_value={'id':helper.PROJECT,'organization_id':helper.ORGANISATION}),patch.object(helper,'read_state',side_effect=[before,after]),patch.object(helper,'query',return_value=[{'archivedFinalizerResultingCatalogSha256':'f'*64}]) as writes,contextlib.redirect_stdout(io.StringIO()):
    helper.main(args)
   self.assertEqual(writes.call_count,1)
   with patch.object(helper,'clean_source'),patch.object(helper,'api',return_value={'id':helper.PROJECT,'organization_id':helper.ORGANISATION}),patch.object(helper,'read_state',return_value=after),patch.object(helper,'query',side_effect=AssertionError('Recorded replay cannot write')) as writes,contextlib.redirect_stdout(io.StringIO()):
    helper.main(args+['--attestation-sha',helper.sha(receipt.read_bytes())])
   writes.assert_not_called()
   corrupt=helper.load_json(receipt.read_bytes())
   corrupt['transactionSha256']='0'*64
   bad=path/'bad-receipt.json'
   helper.retain(bad,corrupt)
   args[args.index('--attestation')+1]=str(bad)
   with patch.object(helper,'clean_source'),patch.object(helper,'api',return_value={'id':helper.PROJECT,'organization_id':helper.ORGANISATION}),patch.object(helper,'read_state',return_value=after),patch.object(helper,'query',side_effect=AssertionError('Bad identity cannot write')),self.assertRaises(SystemExit):
    helper.main(args+['--attestation-sha',helper.sha(bad.read_bytes())])

 def test_actual_explicit_head_source_custody_rejects_before_transport(self):
  cwd,environment,bytecode,modules=Path.cwd(),dict(os.environ),sys.dont_write_bytecode,dict(sys.modules)
  with release_source_fixture() as (helper,reviewed_head):
   fixture=helper.ROOT
   assert helper.__file__ is not None
   helper_path=Path(helper.__file__)
   source_sha=helper.sha(helper.MIGRATION.read_bytes())
   helper_sha=helper.sha(helper_path.read_bytes())
   paths=[helper_path,helper.MIGRATION,helper.PREDECESSOR,helper.TRANSPORT]
   for path in paths:
    self.assertEqual(path.read_bytes(),(ROOT/path.relative_to(fixture)).read_bytes())
   def git(*args):
    return subprocess.check_output(['git',*args],cwd=fixture)
   args=['apply','--source-sha',source_sha,'--snapshot',str(fixture/'not-created-finalizer-snapshot.json'),'--helper-sha',helper_sha]
   with patch.object(helper,'api',side_effect=AssertionError('Invalid custody must reject before target lookup')) as api,patch.object(helper,'query',side_effect=AssertionError('Invalid custody must reject before SQL')) as query:
    helper.candidate(source_sha)
    helper.clean_source(reviewed_head,source_sha,helper_sha)
    for head in [None,'a'*39,'0'*40]:
     with self.subTest(head=head),self.assertRaisesRegex(SystemExit,'Reviewed HEAD differs' if head=='0'*40 else 'Exact approved root and full reviewed HEAD required'):
      helper.main(args+(['--head',head] if head else []))
    valid_args=args+['--head',reviewed_head]
    for source_pin,helper_pin in [('0'*64,helper_sha),(source_sha,None),(source_sha,'0'*64)]:
     with self.subTest(source_pin=source_pin,helper_pin=helper_pin),self.assertRaises(SystemExit):
      helper.clean_source(reviewed_head,source_pin,helper_pin)
    os.chdir(fixture.parent)
    try:
     with self.assertRaisesRegex(SystemExit,'Exact approved root and full reviewed HEAD required'):
      helper.main(valid_args)
    finally:
     os.chdir(fixture)
    for path in [fixture/'unrelated-file',helper.MIGRATION]:
     raw=path.read_bytes() if path.exists() else None
     path.write_bytes((raw or b'')+b'\nsynthetic dirty source\n')
     try:
      self.assertTrue(git('status','--porcelain').strip())
      with self.subTest(dirty=path.name),self.assertRaisesRegex(SystemExit,'Release tree must be clean'):
       helper.clean_source(reviewed_head,source_sha,helper_sha)
     finally:
      path.unlink() if raw is None else path.write_bytes(raw)
    for path,message in [(helper.MIGRATION,'Reviewed committed bytes differ'),(helper_path,'Reviewed committed bytes differ'),(helper.PREDECESSOR,'Committed predecessor bytes differ'),(helper.TRANSPORT,'Committed scoped transport bytes differ')]:
     raw=path.read_bytes()
     relative=str(path.relative_to(fixture))
     git('update-index','--assume-unchanged','--',relative)
     try:
      path.write_bytes(raw+b'\n')
      self.assertEqual(git('status','--porcelain'),b'')
      self.assertNotEqual(git('show',reviewed_head+':'+relative),path.read_bytes())
      with self.subTest(blob=relative),self.assertRaisesRegex(SystemExit,message):
       helper.clean_source(reviewed_head,helper.sha(helper.MIGRATION.read_bytes()),helper.sha(helper_path.read_bytes()))
     finally:
      path.write_bytes(raw)
      git('update-index','--no-assume-unchanged','--',relative)
    git('remote','set-url','origin','https://github.com/example/synthetic.git')
    try:
     with self.assertRaisesRegex(SystemExit,'Wrong MAM Git remote'):
      helper.main(valid_args)
    finally:
     git('remote','set-url','origin','https://github.com/mobilityaccessmodifications/mam-team-management-system.git')
    with patch.dict(os.environ,{'PATH':str(fixture.parent/'home')}),self.assertRaises(FileNotFoundError) as missing:
     helper.main(valid_args)
    self.assertEqual(missing.exception.filename,'git')
    raw=helper.MIGRATION.read_bytes()
    with tempfile.TemporaryDirectory(prefix='finalizer-crlf-source-') as directory:
     path=Path(directory)/'source.sql'
     path.write_bytes(raw.replace(bytes([10]),bytes([13,10])))
     with patch.object(helper,'MIGRATION',path),self.assertRaises(SystemExit):
      helper.candidate(helper.sha(path.read_bytes()))
    helper.clean_source(reviewed_head,source_sha,helper_sha)
    git('config','--local','user.email','synthetic@example.invalid')
    git('commit','--amend','--reset-author','--no-edit','-q')
    rejected_head=git('rev-parse','HEAD').decode().strip()
    with self.assertRaisesRegex(SystemExit,'Wrong MAM source author'):
     helper.main(args+['--head',rejected_head])
    api.assert_not_called()
    query.assert_not_called()
   self.assertFalse((fixture/'not-created-finalizer-snapshot.json').exists())
  self.assertEqual(Path.cwd(),cwd)
  self.assertEqual(dict(os.environ),environment)
  self.assertEqual(sys.dont_write_bytecode,bytecode)
  self.assertEqual(dict(sys.modules),modules)
  self.assertFalse(fixture.parent.exists())


 def test_model_clean_source_requires_committed_transport_dependency_bytes(self):
  helper=load_helper()
  head='a'*40
  blobs={str(helper.MIGRATION.relative_to(ROOT)):helper.MIGRATION.read_bytes(),str(HELPER.relative_to(ROOT)):HELPER.read_bytes(),str(helper.PREDECESSOR.relative_to(ROOT)):helper.PREDECESSOR.read_bytes(),str(Path(helper.SHARED.__file__).relative_to(ROOT)):b'MODEL changed transport dependency'}
  def git(args,cwd):
   if args==['git','rev-parse','HEAD']:
    return head.encode()
   if args==['git','status','--porcelain']:
    return b''
   if args==['git','remote','get-url','origin']:
    return b'https://github.com/mobilityaccessmodifications/mam-team-management-system.git'
   if args==['git','show','-s','--format=%an <%ae>','HEAD']:
    return b'mobilityaccessmodifications <310802599+mobilityaccessmodifications@users.noreply.github.com>'
   if args[:2]==['git','show']:
    return blobs[args[2].split(':',1)[1]]
   raise AssertionError('Unexpected MODEL Git read')
  with patch.object(helper.subprocess,'check_output',side_effect=git),self.assertRaises(SystemExit):
   helper.clean_source(head,helper.sha(helper.MIGRATION.read_bytes()),helper.sha(HELPER.read_bytes()))


 def test_model_snapshot_hash_and_parser_use_the_same_raw_bytes(self):
  helper=load_helper()
  source_sha=helper.sha(helper.MIGRATION.read_bytes())
  before=before_frame()
  swapped=copy.deepcopy(before)
  swapped['securityHash']='9'*64
  with tempfile.TemporaryDirectory(prefix='finalizer-snapshot-race-model-') as directory:
   snapshot=Path(directory)/'before.json'
   helper.retain(snapshot,before)
   raw=snapshot.read_bytes()
   replacement=json.dumps(swapped).encode()
   read=Path.read_bytes
   calls=[]
   def read_bytes(path):
    if path==snapshot:
     calls.append(path)
     return raw if len(calls)==1 else replacement
    return read(path)
   args=['inspect','--source-sha',source_sha,'--snapshot',str(snapshot),'--snapshot-sha',helper.sha(raw)]
   with patch.object(Path,'read_bytes',new=read_bytes),patch.object(helper,'api',return_value={'id':helper.PROJECT,'organization_id':helper.ORGANISATION}),patch.object(helper,'read_state',return_value=swapped),contextlib.redirect_stdout(io.StringIO()),self.assertRaisesRegex(SystemExit,'Observed predecessor changed'):
    helper.main(args)
   self.assertEqual(len(calls),1)


if __name__=='__main__':
 unittest.main()
