import hashlib
import importlib.util
import base64
import builtins
import os
import io
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import urllib.request
import unittest
from unittest.mock import patch

ROOT=Path(__file__).resolve().parents[1]
PATH=ROOT/'scripts/deploy-subscription-review-tasks.py'

class SubscriptionReviewReleaseTests(unittest.TestCase):
    def helper(self):
        self.assertTrue(PATH.exists(),'subscription review tasks need a hash-pinned additive release helper')
        spec=importlib.util.spec_from_file_location('subscription_review_release',PATH)
        assert spec is not None and spec.loader is not None
        module=importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module

    def test_candidate_has_unique_version_after_latest_predecessor(self):
        helper=self.helper()
        migrations=sorted((ROOT/'supabase/migrations').glob('*.sql'))
        versions=[path.stem.split('_',1)[0] for path in migrations]
        self.assertEqual(len(versions),len(set(versions)),'migration versions must be unique')
        predecessors=[path for path in migrations if path.stem.split('_',1)[0] < helper.VERSION]
        latest=predecessors[-1]
        self.assertGreater(helper.VERSION,latest.stem.split('_',1)[0])
        self.assertIn(helper.PREDECESSOR,predecessors)
        self.assertEqual((helper.PREDECESSOR_VERSION,helper.PREDECESSOR_NAME),('20261013120000','annual_continuous_accrual'))

    def test_reviewed_hash_required_before_any_remote_call(self):
        helper=self.helper()
        args=['apply','0'*40,*[hashlib.sha256(path.read_bytes()).hexdigest() for path in (helper.HELPER,helper.TRANSPORT,helper.MIGRATION,helper.PREDECESSOR)]]
        args[4]='0'*64
        with patch.object(urllib.request,'urlopen',side_effect=AssertionError('remote call')):
            with self.assertRaisesRegex(SystemExit,'Reviewed source bytes differ'): helper.main(args)

    def test_exact_migration_transaction_keeps_final_guard_after_ledger(self):
        helper=self.helper()
        raw=helper.MIGRATION.read_bytes()
        source=helper.candidate(hashlib.sha256(raw).hexdigest(),raw)
        query=helper.transaction(source,{'synthetic':'state'},helper.PREDECESSOR.read_bytes().decode())
        ledger=query.index('insert into supabase_migrations.schema_migrations(version,name,statements)')
        final=query.index('set constraints all immediate;',ledger)
        self.assertGreater(final,ledger)
        self.assertIn('select pg_temp.subscription_review_assert_delta();',query[final:])
        self.assertTrue(query.endswith('commit;'))
        self.assertEqual(query.count('insert into supabase_migrations.schema_migrations(version,name,statements)'),1)
        self.assertTrue(helper.literal(source) in query,'exact escaped migration must be recorded')
        self.assertTrue(helper.transaction_body(source) in query,'only validated outer boundaries may be replaced')

    def test_unsupported_modes_are_denied_without_credentials(self):
        helper=self.helper()
        for args in [[],['apply'],['inspect','extra'],['configure']]:
            with patch.object(urllib.request,'urlopen',side_effect=AssertionError('remote call')):
                with self.assertRaises(SystemExit): helper.main(args)

class SubscriptionReviewCustodyTests(unittest.TestCase):
    paths = ['scripts/deploy-subscription-review-tasks.py', 'scripts/deploy-staff-leave-calendar.py',
             'supabase/migrations/20261013170000_subscription_review_tasks.sql', 'supabase/migrations/20261013120000_annual_continuous_accrual.sql']

    def setUp(self):
        self.previous = Path.cwd()
        self.environment = dict(os.environ)
        self.temp = tempfile.TemporaryDirectory(prefix='review-custody-', dir=os.environ['TMPDIR'])
        self.root = Path(self.temp.name)/'repo'
        self.root.mkdir()
        self.raw = {}
        for name in self.paths:
            self.raw[name] = (ROOT/name).read_bytes()
            target = self.root/name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(self.raw[name])
        self.git('init', '--quiet')
        self.git('config', 'user.name', 'mobilityaccessmodifications')
        self.git('config', 'user.email', '310802599+mobilityaccessmodifications@users.noreply.github.com')
        self.git('remote', 'add', 'origin', 'https://github.com/mobilityaccessmodifications/mam-team-management-system.git')
        self.git('add', '--', *self.paths)
        self.git('commit', '--quiet', '-m', 'Synthetic reviewed source')
        self.head = self.git('rev-parse', 'HEAD').decode().strip()
        self.args = ['inspect', self.head, *[hashlib.sha256(self.raw[name]).hexdigest() for name in self.paths]]
        os.chdir(self.root)

    def tearDown(self):
        os.chdir(self.previous)
        os.environ.clear()
        os.environ.update(self.environment)
        self.temp.cleanup()
        self.assertEqual(Path.cwd(), self.previous)
        self.assertEqual(dict(os.environ), self.environment)

    def git(self, *args):
        env = {key:value for key,value in os.environ.items() if not key.startswith('GIT_')}
        env.update(GIT_CONFIG_NOSYSTEM='1', GIT_CONFIG_GLOBAL='/dev/null')
        return subprocess.check_output(['git', '-C', str(self.root), *args], env=env, stderr=subprocess.PIPE)

    def load(self):
        spec = importlib.util.spec_from_file_location('review_custody', self.root/self.paths[0])
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module

    def poison_transport(self, marker):
        raw = self.raw[self.paths[1]]
        poison = raw+b'\nfrom pathlib import Path as _Path\nimport base64 as _base64\n'+(
            '_Path('+repr(str(marker))+').write_text("unmeasured transport executed")\n'
            '_Path(__file__).write_bytes(_base64.b64decode('+repr(base64.b64encode(raw).decode())+'))\n').encode()
        (self.root/self.paths[1]).write_bytes(poison)

    def test_replaced_then_restored_transport_never_executes_at_import(self):
        marker = Path(self.temp.name)/'executed'
        self.poison_transport(marker)
        module = self.load()
        self.assertFalse(marker.exists(), 'Unmeasured restored transport executed before pin validation')
        with self.assertRaises(SystemExit): module.main(self.args)
        self.assertFalse(marker.exists())

    def test_explicit_review_pins_admit_only_clean_committed_source(self):
        module = self.load()
        class ReachedProject(Exception): pass
        with patch.object(urllib.request, 'urlopen', side_effect=ReachedProject), patch.dict(os.environ, {'SUPABASE_ACCESS_TOKEN':'synthetic'}):
            with self.assertRaises(ReachedProject): module.main(self.args)
            for index in range(1, 6):
                with self.subTest(pin=index):
                    args = self.args.copy()
                    args[index] = '0'*len(args[index])
                    with self.assertRaises(SystemExit): module.main(args)
        self.git('update-index', '--assume-unchanged', self.paths[2])
        (self.root/self.paths[2]).write_bytes(self.raw[self.paths[2]]+b'\n')
        with patch.object(urllib.request, 'urlopen', side_effect=AssertionError('remote boundary reached')):
            with self.assertRaises(SystemExit): module.main(self.args)

    def test_transport_replacement_after_measurement_cannot_execute(self):
        module = self.load()
        marker = Path(self.temp.name)/'executed'
        actual = subprocess.check_output
        swaps = []
        def replace(args, **kwargs):
            result = actual(args, **kwargs)
            if args[-1] == 'HEAD:'+self.paths[3] and not swaps:
                swaps.append(True)
                self.poison_transport(marker)
            return result
        with patch.object(subprocess, 'check_output', side_effect=replace), patch.object(urllib.request, 'urlopen', side_effect=SystemExit('inert provider boundary')), patch.dict(os.environ, {'SUPABASE_ACCESS_TOKEN':'synthetic'}):
            with self.assertRaises(SystemExit): module.main(self.args)
        self.assertEqual(swaps, [True])
        self.assertFalse(marker.exists(), 'Pathname import executed bytes other than the measured snapshot')

    def test_hostile_git_selectors_and_configuration_cannot_redirect_custody(self):
        module = self.load()
        decoy = Path(self.temp.name)/'decoy'
        shutil.copytree(self.root, decoy)
        subprocess.run(['git', '-C', str(decoy), 'commit', '--allow-empty', '--quiet', '-m', 'Different decoy HEAD'], check=True)
        config = Path(self.temp.name)/'hostile.gitconfig'
        config.write_text('[core]\nworktree = '+str(decoy)+'\n')
        hostile = {'GIT_DIR':str(decoy/'.git'), 'GIT_WORK_TREE':str(decoy), 'GIT_CONFIG_GLOBAL':str(config),
                   'GIT_CONFIG_SYSTEM':str(config), 'GIT_CONFIG_COUNT':'1', 'GIT_CONFIG_KEY_0':'core.worktree', 'GIT_CONFIG_VALUE_0':str(decoy), 'SUPABASE_ACCESS_TOKEN':'synthetic'}
        class ReachedProject(Exception): pass
        with patch.dict(os.environ, hostile), patch.object(urllib.request, 'urlopen', side_effect=ReachedProject):
            with self.assertRaises(ReachedProject): module.main(self.args)
            wrong = self.args.copy()
            wrong[1] = subprocess.check_output(['git', '-C', str(decoy), 'rev-parse', 'HEAD']).decode().strip()
            with self.assertRaises(SystemExit): module.main(wrong)

    def test_each_source_change_during_project_preflight_stops_before_state_query(self):
        module = self.load()
        for name in self.paths:
            with self.subTest(source=name):
                calls = []
                def remote(request, **kwargs):
                    calls.append(request.full_url)
                    if len(calls) == 1:
                        (self.root/name).write_bytes(self.raw[name]+b'\n')
                        return io.BytesIO(json.dumps({'id':'xtwlrjqbusadghavchqm','organization_id':'fwlmbmospuwoaosffvmw'}).encode())
                    raise SystemExit('unexpected state read after changed source')
                try:
                    with patch.object(urllib.request, 'urlopen', side_effect=remote), patch.dict(os.environ, {'SUPABASE_ACCESS_TOKEN':'synthetic'}):
                        with self.assertRaises(SystemExit): module.main(self.args)
                    self.assertEqual(len(calls), 1, 'Changed source reached SQL generation/provider state read')
                finally:
                    (self.root/name).write_bytes(self.raw[name])

    def test_source_custody_is_checked_on_every_exceptional_exit(self):
        module = self.load()
        for kind in (RuntimeError, SystemExit, KeyboardInterrupt):
            with self.subTest(exception=kind.__name__):
                def remote(*args, **kwargs):
                    (self.root/self.paths[3]).write_bytes(self.raw[self.paths[3]]+b'\n')
                    raise kind('synthetic provider interruption')
                try:
                    with patch.object(urllib.request, 'urlopen', side_effect=remote), patch.dict(os.environ, {'SUPABASE_ACCESS_TOKEN':'synthetic'}):
                        with self.assertRaises(BaseException) as failure: module.main(self.args)
                        self.assertIsInstance(failure.exception, SystemExit)
                        self.assertRegex(str(failure.exception), 'Source custody.*'+kind.__name__)
                finally:
                    (self.root/self.paths[3]).write_bytes(self.raw[self.paths[3]])

    def test_changed_loaded_helper_cannot_be_certified_by_restored_disk(self):
        path = self.root/self.paths[0]
        path.write_bytes(self.raw[self.paths[0]].replace(b"Wrong MAM organization/project", b"Altered loaded helper"))
        module = self.load()
        path.write_bytes(self.raw[self.paths[0]])
        with patch.object(urllib.request,'urlopen',side_effect=AssertionError('remote call')):
            with self.assertRaisesRegex(SystemExit,'Loaded helper differs'): module.main(self.args)

    def test_generation_uses_held_predecessor_without_reopening_path(self):
        module = self.load()
        source = module.candidate(self.args[4], self.raw[self.paths[2]])
        predecessor = self.raw[self.paths[3]].decode()
        with patch.object(Path, 'read_bytes', side_effect=AssertionError('Source reopened during generation')):
            expression = module.state_expression(source, predecessor)
            transaction = module.transaction(source, {'synthetic':'state'}, predecessor)
        self.assertIn(module.literal(predecessor), expression)
        self.assertIn(module.literal(predecessor), transaction)

    def test_transport_initialization_failure_is_not_mislabeled_as_source_drift(self):
        module = self.load()
        actual = builtins.__import__
        def fail(name, *args, **kwargs):
            if name == 'urllib.request': raise ImportError('synthetic transport initialization failure')
            return actual(name, *args, **kwargs)
        with patch.object(builtins, '__import__', side_effect=fail):
            with self.assertRaisesRegex(ImportError, 'synthetic transport initialization failure'): module.main(self.args)
        self.assertNotIn('SHARED', module.__dict__)

if __name__=='__main__': unittest.main()
