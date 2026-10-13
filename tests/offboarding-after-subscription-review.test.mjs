import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

test('subscription and note aware release preserves the public custody, query, snapshot, and spent-dispatch guards in offline models', () => {
  const code = String.raw`
import contextlib,copy,hashlib,importlib.util,io,json,os,pathlib,sys,unittest
from unittest.mock import patch
ROOT=pathlib.Path.cwd()
WRAPPER=ROOT/'scripts/deploy-offboarding-after-subscription-review.py'
def load(path,name):
    spec=importlib.util.spec_from_file_location(name,path)
    module=importlib.util.module_from_spec(spec)
    exec(compile(path.read_bytes(),str(path),'exec'),module.__dict__)
    return module
fixtures=load(ROOT/'tests/test_after_annual_offboarding_release.py','subscription_model_fixtures')
fixtures.ADAPTER=WRAPPER
def add_subscription(module,before):
    before.update(subscriptionExact=True,subscriptionFunctionsExact=True,subscriptionStateHash='6'*64)
    before['ledger'].append({'version':module.SUBSCRIPTION_VERSION,'name':module.SUBSCRIPTION_NAME,'dimensions':'[1:1]','cardinality':1,'sourceSha256':module.SUBSCRIPTION_ARRAY_SHA})
    before.update(noteExact=True,noteFunctionsExact=True,noteStateHash='7'*64)
    before['ledger'].append({'version':module.NOTE_VERSION,'name':module.NOTE_NAME,'dimensions':'[1:1]','cardinality':1,'sourceSha256':module.NOTE_ARRAY_SHA})
    before['ledger'].sort(key=lambda row:row['version'])
    return before
def model(phase):
    module=load(WRAPPER,'subscription_control_model')
    adapter=module.AfterSubscriptionReviewAdapter.__new__(module.AfterSubscriptionReviewAdapter)
    adapter.phase=phase
    adapter.raw={ROOT/path:(ROOT/path).read_bytes() for path in module.IMMUTABLE}
    adapter.load_components();adapter.load_subscription();adapter.load_note()
    return module,adapter,add_subscription(module,fixtures.model_before(module,adapter))
def construct(module,phase,head,pins,**overrides):
    helper,_,source=module.PHASES[phase]
    values={'adapter_sha':pins[str(module.ADAPTER.relative_to(module.ROOT))],
      'helper_sha':pins['scripts/'+helper],'guarded_sha':pins['scripts/deploy-reporting-splice-guarded.py'],
      'transport_sha':pins['scripts/deploy-staff-leave-calendar.py'],'source_sha':pins['supabase/migrations/'+source],
      'annual_sha':pins[str(module.ANNUAL.relative_to(module.ROOT))],
      'wrapper_sha':pins[str(module.WRAPPER.relative_to(module.ROOT))],
      'subscription_sha':pins[str(module.SUBSCRIPTION.relative_to(module.ROOT))],
      'note_sha':pins[str(module.NOTE.relative_to(module.ROOT))]}
    values.update(overrides)
    return module.AfterSubscriptionReviewAdapter(phase,head,**values)
def arguments(module,adapter,parent,action='apply'):
    values=fixtures.entry_arguments(module,adapter,parent,action)
    return values+['--wrapper-sha',adapter.pins[module.WRAPPER],'--subscription-sha',adapter.pins[module.SUBSCRIPTION],'--note-sha',adapter.pins[module.NOTE]]
class SubscriptionReleaseGuards(unittest.TestCase):
    def setUp(self):
        trap=patch('urllib.request.urlopen',side_effect=AssertionError('Offline MODEL tests forbid network'))
        trap.start();self.addCleanup(trap.stop)
    def test_precise_subscription_ledger_and_state_reject_unknown_or_malformed_predecessors(self):
        for phase in ('reporting-splice','finalizer','version-conflict'):
            module,adapter,before=model(phase);source=adapter.raw[adapter.core].decode()
            adapter.validate_before(before,source)
            for version in (module.SUBSCRIPTION_VERSION,module.NOTE_VERSION):
                for key,value in [('name','renamed'),('dimensions','[0:0]'),('dimensions',None),('cardinality',True),('cardinality',0),('cardinality',None),('sourceSha256','0'*64)]:
                    bad=copy.deepcopy(before);next(row for row in bad['ledger'] if row['version']==version)[key]=value
                    with self.subTest(phase=phase,version=version,key=key,value=value),self.assertRaises(SystemExit):adapter.validate_before(bad,source)
            for field,value in [('subscriptionExact',False),('subscriptionFunctionsExact',False),('subscriptionStateHash',None),('subscriptionStateHash','bad'),('noteExact',False),('noteFunctionsExact',False),('noteStateHash',None),('noteStateHash','bad')]:
                bad=copy.deepcopy(before);bad[field]=value
                with self.subTest(phase=phase,field=field),self.assertRaises(SystemExit):adapter.validate_before(bad,source)
            variants=[]
            for version in (module.SUBSCRIPTION_VERSION,module.NOTE_VERSION):
                bad=copy.deepcopy(before);bad['ledger']=[row for row in bad['ledger'] if row['version']!=version];variants.append(bad)
            bad=copy.deepcopy(before);bad['ledger'].append(dict(bad['ledger'][-1]));variants.append(bad)
            bad=copy.deepcopy(before);bad['ledger'].append(dict(bad['ledger'][-1],version='20261013180001'));variants.append(bad)
            bad=copy.deepcopy(before);bad['ledger'].reverse();variants.append(bad)
            bad=copy.deepcopy(before);bad['unexpected']=True;variants.append(bad)
            for bad in variants:
                with self.subTest(phase=phase),self.assertRaises(SystemExit):adapter.validate_before(bad,source)
    def test_reversible_actual_queries_keep_both_published_rows_and_all_three_phase_sources(self):
        for phase in ('reporting-splice','finalizer','version-conflict'):
            module,adapter,before=model(phase);source=adapter.raw[adapter.core].decode()
            with self.assertRaises(SystemExit):adapter.helper.validate_before(before,source)
            query,original,changes=adapter.bind_query(source,before);restored=query
            for old,new in reversed(changes):
                self.assertEqual(restored.count(new),1);restored=restored.replace(new,old,1)
            self.assertEqual(restored,original)
            self.assertEqual(adapter.transaction(source,before),query)
            projection=adapter.validation_projection(before)
            self.assertEqual(len(projection['ledger']),len(before['ledger'])-3)
            self.assertTrue(all(row['version'] not in (module.ANNUAL_VERSION,module.SUBSCRIPTION_VERSION,module.NOTE_VERSION) for row in projection['ledger']))
            self.assertTrue(all(field not in projection for field in (*module.SUBSCRIPTION_FIELDS,*module.NOTE_FIELDS)))
            self.assertEqual(len(adapter.subscription_functions),5)
            self.assertTrue(module.SUBSCRIPTION_SIGNATURES.isdisjoint(adapter.helper.function_spec(source)))
            self.assertIn('20261013170000',query);self.assertIn('20261013120000',query);self.assertIn('20261013180000',query)
            self.assertIn(module.NOTE_SIGNATURE,query)
            self.assertNotIn(module.NOTE_SIGNATURE,adapter.helper.function_spec(source))
            for signature in module.SUBSCRIPTION_SIGNATURES:self.assertIn(signature,query)
            self.assertIn('pg_get_userbyid(p.proowner)',query);self.assertIn('parameter_defaults',query)
    def test_independent_readback_keeps_full_history_and_subscription_metadata(self):
        for phase in ('reporting-splice','finalizer','version-conflict'):
            module,adapter,before=model(phase);source=adapter.raw[adapter.core].decode();after=fixtures.model_after(adapter,before)
            adapter.verify_after(after,before,source,'5'*64)
            self.assertEqual(after['ledger'],sorted(after['ledger'],key=lambda row:row['version']))
            for field,value in [('subscriptionExact',False),('subscriptionFunctionsExact',False),('subscriptionStateHash','0'*64),('noteExact',False),('noteFunctionsExact',False),('noteStateHash','0'*64),('annualStateHash','0'*64),('dbRoleSettingHash','0'*64),('dataHash','0'*64),('securityHash','0'*64)]:
                bad=copy.deepcopy(after);bad[field]=value
                with self.subTest(phase=phase,field=field),self.assertRaises(SystemExit):adapter.verify_after(bad,before,source,'5'*64)
            for version in (module.SUBSCRIPTION_VERSION,module.NOTE_VERSION):
                bad=copy.deepcopy(after);bad['ledger']=[row for row in bad['ledger'] if row['version']!=version]
                with self.assertRaises(SystemExit):adapter.verify_after(bad,before,source,'5'*64)
    def test_clean_committed_constructor_measures_wrapper_and_subscription_before_ports(self):
        with fixtures.source_fixture() as (module,parent,head,pins):
            adapter=construct(module,'reporting-splice',head,pins)
            self.assertEqual(adapter.raw[module.WRAPPER],module.WRAPPER.read_bytes())
            self.assertEqual(adapter.raw[module.SUBSCRIPTION],module.SUBSCRIPTION.read_bytes())
            self.assertEqual(adapter.raw[module.NOTE],module.NOTE.read_bytes())
            for name in ('wrapper_sha','subscription_sha','note_sha','adapter_sha'):
                with self.subTest(pin=name),self.assertRaises(SystemExit):construct(module,'reporting-splice',head,pins,**{name:'0'*64})
            args=arguments(module,adapter,parent,'prepare')
            for flag in ('--wrapper-sha','--subscription-sha','--note-sha'):
                bad=list(args);i=bad.index(flag);del bad[i:i+2]
                with contextlib.redirect_stderr(io.StringIO()),self.assertRaises(SystemExit):module.arguments(bad)
            for path in (module.SUBSCRIPTION,module.NOTE):
                path.write_bytes(adapter.raw[path]+b'\n')
                with self.assertRaises(SystemExit):adapter.check_custody()
                with self.assertRaises(SystemExit):construct(module,'reporting-splice',head,pins)
                path.write_bytes(adapter.raw[path])
    def test_public_entry_single_dispatch_and_attested_inspect_use_the_same_full_query(self):
        for phase in ('reporting-splice','finalizer','version-conflict'):
            with fixtures.source_fixture() as (module,parent,head,pins):
                adapter=construct(module,phase,head,pins);before=add_subscription(module,fixtures.model_before(module,adapter));after=fixtures.model_after(adapter,before);writes=[]
                expected=None
                def inert_query(sql):
                    if sql.startswith('begin read only;'):return [{'state':after if writes else before}]
                    self.assertEqual(sql,expected);writes.append(sql)
                    return [{'reporting-splice':{'reportingSpliceResultingCatalogSha256':'5'*64},'finalizer':{'archivedFinalizerResultingCatalogSha256':'5'*64},'version-conflict':{'offboardingVersionConflictResultingCatalogSha256':'5'*64}}[phase]]
                with patch.object(adapter.helper,'api',return_value={'id':adapter.helper.PROJECT,'organization_id':adapter.helper.ORGANISATION}),patch.object(adapter.helper,'query',side_effect=inert_query),contextlib.redirect_stdout(io.StringIO()):
                    adapter.run(module.arguments(arguments(module,adapter,parent,'prepare')))
                    captured=adapter.helper.load_json((parent/'MODEL-before.json').read_bytes());expected=adapter.transaction(adapter.raw[adapter.core].decode(),captured)
                    adapter.run(module.arguments(arguments(module,adapter,parent,'inspect')))
                    args=arguments(module,adapter,parent);adapter.run(module.arguments(args))
                    adapter.run(module.arguments(args+['--attestation-sha',module.sha((parent/'MODEL-attestation.json').read_bytes())]))
                    bad=arguments(module,adapter,parent,'inspect');bad[bad.index('--snapshot-sha')+1]='0'*64
                    with self.assertRaises(SystemExit):adapter.run(module.arguments(bad))
                self.assertEqual(writes,[expected])
                for name in ('MODEL-dispatch.json','MODEL-attestation.json'):
                    receipt=adapter.helper.load_json((parent/name).read_bytes());self.assertEqual(receipt['head'],head);self.assertEqual(receipt['transactionSha256'],module.sha(expected.encode()))
    def test_wrapper_custody_failure_after_api_prevents_query_or_dispatch(self):
        with fixtures.source_fixture() as (module,parent,head,pins):
            adapter=construct(module,'reporting-splice',head,pins)
            def api(_):
                module.WRAPPER.write_bytes(adapter.raw[module.WRAPPER]+b'\n')
                return {'id':adapter.helper.PROJECT,'organization_id':adapter.helper.ORGANISATION}
            with patch.object(adapter.helper,'api',side_effect=api),patch.object(adapter.helper,'query') as query,contextlib.redirect_stdout(io.StringIO()),self.assertRaises(SystemExit):
                adapter.run(module.arguments(arguments(module,adapter,parent,'prepare')))
            query.assert_not_called();self.assertFalse((parent/'MODEL-before.json').exists());self.assertFalse((parent/'MODEL-dispatch.json').exists())
unittest.main(argv=['offline-subscription-guards'])
`;
  const result = spawnSync('python3', ['-B', '-c', code], {
    encoding: 'utf8', timeout: 120000, maxBuffer: 4 * 1024 * 1024,
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /Ran 6 tests/);
  assert.match(result.stderr, /OK/);
});
