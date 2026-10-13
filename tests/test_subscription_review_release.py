import hashlib
import importlib.util
from pathlib import Path
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
        self.assertEqual(helper.PREDECESSOR,latest)
        self.assertEqual((helper.PREDECESSOR_VERSION,helper.PREDECESSOR_NAME),('20261013120000','annual_continuous_accrual'))

    def test_reviewed_hash_required_before_any_remote_call(self):
        helper=self.helper()
        with patch.object(helper,'api',side_effect=AssertionError('remote call')),patch.object(helper,'query',side_effect=AssertionError('remote call')):
            with self.assertRaises(SystemExit): helper.main(['apply','0'*64])

    def test_exact_migration_transaction_keeps_final_guard_after_ledger(self):
        helper=self.helper()
        source=helper.candidate(hashlib.sha256(helper.MIGRATION.read_bytes()).hexdigest())
        query=helper.transaction(source,{'synthetic':'state'})
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
            with patch.object(helper,'api',side_effect=AssertionError('remote call')):
                with self.assertRaises(SystemExit): helper.main(args)

if __name__=='__main__': unittest.main()
