import copy
import contextlib
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
HELPER = ROOT/'scripts/deploy-offboarding-version-conflicts.py'
MIGRATION = ROOT/'supabase/migrations/20261013153500_offboarding_version_conflict_responses.sql'
PINS = {
 'public.preflight_employee_removal_reporting_splice(uuid,bigint,bigint,date,text)': '096ef3cf33e6cd6a78dab5722e0b8f50370abbfbdba6e9f81d9c1ccb15db4dca',
 'public.archive_employee_directory_record(uuid,bigint,bigint,date,text)': '801a9f690a30f3f2842f37c1a3e7e3f24339eb7b766b5e289a4740c1fa1782df',
}


def load(path=HELPER):
 assert path.is_file(), 'Required narrowly scoped exact-source forward release helper is missing'
 spec = importlib.util.spec_from_file_location('version_conflict_unit',path)
 assert spec is not None
 module = importlib.util.module_from_spec(spec)
 exec(compile(path.read_bytes(),str(path),'exec'),module.__dict__)
 return module


@contextlib.contextmanager
def dirty_source_fixture():
 paths=[HELPER.relative_to(ROOT),MIGRATION.relative_to(ROOT),Path('scripts/deploy-staff-leave-calendar.py'),Path('supabase/migrations/20261013081500_archived_account_status_finalizer.sql'),Path('supabase/migrations/20261012170000_employee_removal_reporting_splice.sql')]
 with tempfile.TemporaryDirectory(prefix='vc-source-unit-') as directory:
  parent=Path(directory).resolve()
  root=parent/'repo'
  environment={'PATH':os.environ['PATH'],'TMPDIR':tempfile.gettempdir(),'LANG':'C','LC_ALL':'C','HOME':str(parent),'GIT_CONFIG_NOSYSTEM':'1','GIT_CONFIG_GLOBAL':os.devnull,'PYTHONDONTWRITEBYTECODE':'1'}
  cwd=Path.cwd()
  with patch.dict(os.environ,environment,clear=True):
   subprocess.run(['git','clone','--local','--shared','--no-checkout','--quiet',str(ROOT),str(root)],check=True,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
   for relative in paths:
    destination=root/relative
    destination.parent.mkdir(parents=True,exist_ok=True)
    destination.write_bytes((ROOT/relative).read_bytes())
   head=subprocess.check_output(['git','rev-parse','HEAD'],cwd=root).decode().strip()
   os.chdir(root)
   try:yield load(root/HELPER.relative_to(ROOT)),head
   finally:os.chdir(cwd)


def model_before(helper,source):
 return {'major':17,'dataHash':'a'*64,'securityHash':'b'*64,'receiptHash':'c'*64,'purgeHash':'d'*64,'purgeMatches':True,'predecessorExact':True,'predecessorFunctionsExact':True,'targetExact':False,'targetSourceArraySha256':'e'*64,'tradeSchoolEnabledCount':0,'ledger':[{'version':'20261013081500','name':'archived_account_status_finalizer','dimensions':'[1:1]','cardinality':1,'sourceSha256':'f'*64}],'functions':{sig:{'sha256':pin,'metadata':{},'portable':{}} for sig,pin in PINS.items()}}


class VersionConflictReleaseTests(unittest.TestCase):
 def setUp(self):
  guard=patch('urllib.request.urlopen',side_effect=AssertionError('Offline release unit tests forbid network'))
  guard.start()
  self.addCleanup(guard.stop)

 def test_forward_migration_exists_without_rewriting_history(self):
  self.assertTrue(MIGRATION.is_file(),'Required forward migration has not been implemented')
  self.assertEqual(hashlib.sha256((ROOT/'supabase/migrations/20261013081500_archived_account_status_finalizer.sql').read_bytes()).hexdigest(),'7ac9fb016817e36d537e86f468e0383f377c3311e723d0f126cb2c1a228af76d')

 def test_actual_two_function_spec_pins_only_semantic_version_errors(self):
  helper=load()
  source=helper.candidate(helper.sha(MIGRATION.read_bytes()))
  self.assertEqual(helper.BEFORE_SHAS,PINS)
  self.assertEqual(helper.PREDECESSOR_VERSION,'20261013081500')
  self.assertEqual(set(helper.function_spec(source)),set(PINS))
  self.assertEqual(len(re.findall(r"raise exception 'This employee(?: detail)? changed since it was opened\. Refresh and try again\.' using errcode\s*=\s*'PT409'",source)),4)
  helper.semantic_delta(source)
  with self.assertRaises(SystemExit):
   helper.semantic_delta(source.replace("Reporting hierarchy changed. Refresh and try again.' using errcode='40001'","Reporting hierarchy changed. Refresh and try again.' using errcode='PT409'"))

 def test_exact_original_security_collector_and_settings_are_carried_through_ledger(self):
  helper=load()
  source=helper.candidate(helper.sha(MIGRATION.read_bytes()))
  security=helper.source_function(source,'offboarding_version_conflict_security')
  for field in ('schemas','default_acls','column_defaults','types','enums','rewrites','roles','database_role_settings','columns','relations','policies','constraints','role_memberships','functions','triggers','indexes'):
   self.assertIn("'"+field+"'",security)
  branch=next(row for row in security.splitlines() if "'database_role_settings'" in row)
  for token in ['to_jsonb(s)',"-'setconfig'",'array_dims(s.setconfig)','cardinality(s.setconfig)',"coalesce(s.setconfig::text,'<NULL>')",'order by s.setdatabase,s.setrole','pg_db_role_setting s']:
   self.assertIn(token,branch)
  self.assertNotIn('where',branch.lower())
  self.assertIn(branch,helper.state_expression(source))
  query=helper.transaction(source,model_before(helper,source))
  ledger=query.index('\ninsert into supabase_migrations.schema_migrations(version,name,statements)')
  final=query[ledger:]
  self.assertLess(final.index('set constraints all immediate;'),final.index('do $offboarding_version_conflict_release_final$'))
  self.assertIn(branch,final)
  self.assertIn('pg_temp.offboarding_version_conflict_security()',final)

 def test_resulting_function_pins_are_source_derived_and_reversal_is_exact(self):
  helper=load()
  source=helper.candidate(helper.sha(MIGRATION.read_bytes()))
  for signature,spec in helper.function_spec(source).items():
   definition=helper.source_definition(source,signature)
   self.assertEqual(helper.sha(definition.encode()),spec['after'])
   self.assertEqual(helper.sha(definition.replace("'PT409'","'40001'").encode()),PINS[signature])

 def test_new_source_and_predecessor_guards_are_fail_closed(self):
  helper=load()
  source=helper.candidate(helper.sha(MIGRATION.read_bytes()))
  for pin in list(PINS.values())+[helper.sha(helper.PREDECESSOR.read_bytes())]:
   with self.subTest(pin=pin), self.assertRaises(SystemExit):
    if pin in PINS.values(): helper.function_spec(source.replace(pin,'0'*64))
    else: helper.predecessor_definition_checks(source.replace('b63463e0bca9fe0d737338865e2ad0620ed089d634f55a233d0366720e4b0b3c','0'*64))
  for raw in ['{"x":1,"x":2}','{"x":NaN}','{"x":Infinity}','{"x":-Infinity}']:
   with self.subTest(raw=raw),self.assertRaises(SystemExit):helper.load_json(raw)

 def test_model_raw_ledger_null_empty_and_bounds_remain_distinct(self):
  helper=load()
  source=helper.candidate(helper.sha(MIGRATION.read_bytes()))
  for count,dims in [(None,None),(0,None),(2,'[0:1]')]:
   before=model_before(helper,source)
   before['ledger'].insert(0,{'version':'19000101000001','name':'synthetic_history','dimensions':dims,'cardinality':count,'sourceSha256':'9'*64})
   helper.validate_before(before,source)
  for count,dims in [(True,'[1:1]'),(2,'[1:1]'),(2,'[1:1][1:2]'),(None,'[1:1]')]:
   before=model_before(helper,source)
   before['ledger'][0].update(cardinality=count,dimensions=dims)
   with self.subTest(count=count,dims=dims),self.assertRaises(SystemExit):helper.validate_before(before,source)

 def test_model_independent_readback_rejects_every_protected_field(self):
  helper=load()
  source=helper.candidate(helper.sha(MIGRATION.read_bytes()))
  before=model_before(helper,source)
  after=copy.deepcopy(before)
  after.update(purgeHash='0'*64,targetExact=True)
  after['ledger'].append({'version':helper.VERSION,'name':helper.NAME,'dimensions':'[1:1]','cardinality':1,'sourceSha256':before['targetSourceArraySha256']})
  for signature,spec in helper.function_spec(source).items():after['functions'][signature]['sha256']=spec['after']
  helper.verify_after(after,before,source,'0'*64)
  for field in after:
   bad=copy.deepcopy(after)
   bad[field]=None
   with self.subTest(field=field),self.assertRaises((SystemExit,TypeError)):helper.verify_after(bad,before,source,'0'*64)
  for signature in PINS:
   for field in ('metadata','portable','sha256'):
    bad=copy.deepcopy(after)
    bad['functions'][signature][field]=None
    with self.subTest(signature=signature,field=field),self.assertRaises(SystemExit):helper.verify_after(bad,before,source,'0'*64)

 def test_actual_dirty_root_head_and_hostile_git_reject_before_network(self):
  with dirty_source_fixture() as (helper,head):
   source_sha=helper.sha(helper.MIGRATION.read_bytes())
   assert helper.__file__ is not None
   helper_sha=helper.sha(Path(helper.__file__).read_bytes())
   with patch.object(helper,'api',side_effect=AssertionError('Invalid custody cannot call API')) as api,patch.object(helper,'query',side_effect=AssertionError('Invalid custody cannot dispatch')) as query:
    with self.assertRaisesRegex(SystemExit,'Release tree must be clean'):
     helper.clean_source(head,source_sha,helper_sha)
    with patch.dict(os.environ,{'GIT_DIR':'/unknown'}),self.assertRaisesRegex(SystemExit,'Inherited Git override prohibited'):
     helper.clean_source(head,source_sha,helper_sha)
    with self.assertRaises(SystemExit):helper.clean_source('a'*39,source_sha,helper_sha)
    api.assert_not_called();query.assert_not_called()

 def test_measured_transport_is_compiled_without_pathname_reopen(self):
  transport=ROOT/'scripts/deploy-staff-leave-calendar.py'
  original=Path.read_bytes
  measured=[]
  def read(path):
   raw=original(path)
   if path==transport:measured.append(raw)
   return raw
  with patch.object(Path,'read_bytes',new=read):helper=load()
  self.assertEqual(measured,[transport.read_bytes()])
  self.assertEqual(helper.SHARED.__file__,str(transport))
  self.assertIs(helper.api,helper.SHARED.api)
  with patch.object(Path,'read_bytes',new=lambda path:original(path)+b'\ncorrupt' if path==transport else original(path)),self.assertRaises(SystemExit):load()

 def test_sql_runner_wires_separate_helper_units_and_actual_native_regression(self):
  runner=(ROOT/'scripts/test-sql.mjs').read_text()+(ROOT/'scripts/test-migration-replay.mjs').read_text()
  for marker in ["'-p', 'test_offboarding_version_conflict_release.py'", 'tests/offboarding-version-conflicts.sql', 'run-offboarding-version-conflict-release.py']:
   self.assertTrue(marker in runner,'Required focused gate wiring is missing: '+marker)

 def test_model_unknown_dispatch_keeps_spent_public_query_identity_and_only_reads(self):
  helper=load()
  source_sha=helper.sha(MIGRATION.read_bytes())
  source=helper.candidate(source_sha)
  with tempfile.TemporaryDirectory(prefix='vc-model-unknown-') as directory:
   parent=Path(directory).resolve()
   snapshot=parent/'before.json'
   helper.retain(snapshot,model_before(helper,source))
   before=helper.load_json(snapshot.read_bytes())
   expected=helper.transaction(source,before)
   receipt,dispatch=parent/'receipt.json',parent/'dispatch.json'
   args=['apply','--source-sha',source_sha,'--snapshot',str(snapshot),'--snapshot-sha',helper.sha(snapshot.read_bytes()),'--head','a877f86baebe4e4dda481029b736b868f11878f2','--helper-sha',helper.sha(HELPER.read_bytes()),'--attestation',str(receipt),'--dispatch',str(dispatch)]
   with patch.object(helper,'clean_source'),patch.object(helper,'api',return_value={'id':helper.PROJECT,'organization_id':helper.ORGANISATION}),patch.object(helper,'read_state',return_value=before) as reads,patch.object(helper,'query',side_effect=TimeoutError('MODEL_UNKNOWN_NOT_PROVIDER')) as writes,contextlib.redirect_stdout(io.StringIO()),self.assertRaisesRegex(SystemExit,'Write outcome unverified'):
    helper.main(args)
   self.assertEqual(writes.call_count,1)
   self.assertEqual(reads.call_count,2)
   self.assertEqual(writes.call_args.args[0],expected)
   self.assertEqual(helper.load_json(dispatch.read_bytes())['transactionSha256'],helper.sha(expected.encode()))
   self.assertFalse(receipt.exists())
   with patch.object(helper,'clean_source'),patch.object(helper,'api',return_value={'id':helper.PROJECT,'organization_id':helper.ORGANISATION}),patch.object(helper,'read_state',return_value=before),patch.object(helper,'query',side_effect=AssertionError('MODEL spent dispatch cannot write')) as writes,contextlib.redirect_stdout(io.StringIO()),self.assertRaises(SystemExit):
    helper.main(args)
   writes.assert_not_called()

 def test_model_recorded_attestation_and_reconciliation_use_same_complete_public_query(self):
  helper=load()
  source_sha=helper.sha(MIGRATION.read_bytes())
  source=helper.candidate(source_sha)
  before=model_before(helper,source)
  after=copy.deepcopy(before)
  after.update(purgeHash='0'*64,targetExact=True)
  after['ledger'].append({'version':helper.VERSION,'name':helper.NAME,'dimensions':'[1:1]','cardinality':1,'sourceSha256':before['targetSourceArraySha256']})
  for signature,spec in helper.function_spec(source).items():after['functions'][signature]['sha256']=spec['after']
  with tempfile.TemporaryDirectory(prefix='vc-model-recorded-') as directory:
   parent=Path(directory).resolve()
   snapshot=parent/'before.json'
   helper.retain(snapshot,before)
   captured=helper.load_json(snapshot.read_bytes())
   expected=helper.transaction(source,captured)
   receipt,dispatch=parent/'receipt.json',parent/'dispatch.json'
   args=['apply','--source-sha',source_sha,'--snapshot',str(snapshot),'--snapshot-sha',helper.sha(snapshot.read_bytes()),'--head','a877f86baebe4e4dda481029b736b868f11878f2','--helper-sha',helper.sha(HELPER.read_bytes()),'--attestation',str(receipt),'--dispatch',str(dispatch)]
   with patch.object(helper,'clean_source'),patch.object(helper,'api',return_value={'id':helper.PROJECT,'organization_id':helper.ORGANISATION}),patch.object(helper,'read_state',side_effect=[before,after]),patch.object(helper,'query',return_value=[{'offboardingVersionConflictResultingCatalogSha256':'0'*64}]) as writes,contextlib.redirect_stdout(io.StringIO()):helper.main(args)
   self.assertEqual(writes.call_count,1)
   self.assertEqual(writes.call_args.args[0],expected)
   self.assertEqual(helper.load_json(receipt.read_bytes())['transactionSha256'],helper.sha(expected.encode()))
   with patch.object(helper,'clean_source'),patch.object(helper,'api',return_value={'id':helper.PROJECT,'organization_id':helper.ORGANISATION}),patch.object(helper,'read_state',return_value=after),patch.object(helper,'query',side_effect=AssertionError('MODEL recorded readback cannot write')) as writes,contextlib.redirect_stdout(io.StringIO()):helper.main(args+['--attestation-sha',helper.sha(receipt.read_bytes())])
   writes.assert_not_called()

 def test_latest_schema_safety_fixture_distinguishes_semantic_and_reset_conflicts(self):
  safety=(ROOT/'tests/reporting-splice-safety.sql').read_bytes()
  lines=safety.splitlines(keepends=True)
  self.assertEqual(len(lines),119)
  self.assertEqual(hashlib.sha256(b''.join(lines[:55]+lines[59:])).hexdigest(),'63fea5d5b890470dd4fc030170017c339e6059155f8ffef93567bb3f41c34300')
  expected=[
   b"select pg_temp.splice_reject(pg_temp.splice_call('preflight_employee_removal_reporting_splice',20,999),'PT409');",
   b"select pg_temp.splice_reject(pg_temp.splice_call('preflight_employee_removal_reporting_splice',20,null,999),'PT409');",
   b"select pg_temp.splice_reject(pg_temp.splice_call('archive_employee_directory_record',20,999),'PT409');",
   b"select pg_temp.splice_reject(pg_temp.splice_call('archive_employee_directory_record',20,null,999),'PT409');",
   b"select pg_temp.splice_reject(pg_temp.splice_call('preflight_employee_removal_reporting_splice'),'40001');",
   b"select pg_temp.splice_reject(pg_temp.splice_call('archive_employee_directory_record'),'40001');",
  ]
  actual=[line for line in safety.splitlines() if line.startswith(b'select pg_temp.splice_reject(pg_temp.splice_call(') and line.endswith((b",'PT409');",b",'40001');"))]
  self.assertEqual(actual,expected)
  self.assertEqual(safety.splitlines()[55:59],expected[:4])
  self.assertEqual(safety.splitlines()[105:107],expected[4:])
  runner=(ROOT/'tests/run-reporting-splice-sql.mjs').read_text()
  self.assertEqual(runner.count("'reporting-splice-safety.sql'"),1)
  self.assertIn('for (const regression of regressions) {',runner)
  self.assertIn("'-f', path.join(sourceRoot, 'tests', regression)",runner)
  replay=(ROOT/'scripts/test-migration-replay.mjs').read_text()
  self.assertIn('readdirSync("supabase/migrations").filter((file) => file.endsWith(".sql")).sort()',replay)
  self.assertIn('for (const file of files) {',replay)
  self.assertIn('sql(socket, database, readFileSync(path.join("supabase/migrations", file), "utf8"))',replay)
  self.assertEqual(sorted((ROOT/'supabase/migrations').glob('*.sql'))[-1],MIGRATION)
  gate=(ROOT/'scripts/test-sql.mjs').read_text()
  self.assertLess(gate.index('const replay = spawnSync('),gate.index('if (replay.status !== 0) throw new Error("Full migration replay failed")'))
  self.assertLess(gate.index('if (replay.status !== 0) throw new Error("Full migration replay failed")'),gate.index('runReportingSpliceSql(socket, "mam_test_replay", sourceRoot)'))


if __name__=='__main__':unittest.main()
