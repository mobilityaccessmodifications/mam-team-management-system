import copy
import importlib.util
import json
from pathlib import Path
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location('lifecycle_deploy', Path(__file__).resolve().parents[1] / 'scripts/deploy-employee-lifecycle-mail.py')
m = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(m)


def config():
    return [{'slot': slot, 'personId': None if slot == 'it' else f'10000000-0000-4000-8000-{i:012d}',
        'approvedEmail': f'contact{i}@example.test', 'companyKey': m.TEAMS.get(slot, (None, None))[0],
        'teamName': m.TEAMS.get(slot, (None, None))[1]} for i, slot in enumerate(sorted(m.SLOTS), 1)]


class LifecycleDeployTests(unittest.TestCase):
    def test_exact_runtime_configuration(self):
        expected = config()
        self.assertEqual(m.parse_config(json.dumps(expected)), expected)
        for entries in [expected[:-1], expected + [expected[0]], expected[:-1] + [expected[0]]]:
            with self.assertRaises(ValueError):
                m.parse_config(json.dumps(entries))

    def test_wrong_mapping_address_and_employee_binding_rejected(self):
        for field, value in [('approvedEmail', 'a@example.test,b@example.test'), ('approvedEmail', 'bad\r@example.test'),
                ('companyKey', 'other'), ('teamName', 'Management'), ('personId', None), ('extra', 'secret')]:
            entries = copy.deepcopy(config())
            entries[0][field] = value
            with self.assertRaises(ValueError):
                m.parse_config(json.dumps(entries))
        entries = config()
        next(e for e in entries if e['slot'] == 'it')['personId'] = '10000000-0000-4000-8000-000000000099'
        with self.assertRaises(ValueError):
            m.parse_config(json.dumps(entries))

    def test_sql_configuration_and_activation_are_separate(self):
        entries = config()
        configured = m.configure_sql(entries)
        self.assertIn('is distinct from false', configured)
        self.assertNotIn('set_employee_lifecycle_mail_enabled(true)', configured)
        enabled = m.enable_sql(entries)
        self.assertIn('except all', enabled)
        self.assertIn('set_employee_lifecycle_mail_enabled(true)', enabled)
        self.assertNotIn('insert into', enabled)

    def test_markerless_mam_wrapper_and_exact_origin(self):
        class Result:
            stdout = m.ORIGIN
        with patch.object(m.subprocess, 'run', return_value=Result()), patch.dict(m.os.environ, {'CODEX_COMPANY_PROFILE': 'mam'}), \
                patch.object(m, 'api', return_value={'id': m.PROJECT, 'organization_id': m.ORG}) as api:
            m.verify_target()
            api.assert_called_once_with('')
        with patch.object(m.subprocess, 'run', return_value=Result()), patch.dict(m.os.environ, {'CODEX_COMPANY_PROFILE': 'personal'}), \
                patch.object(m, 'api') as api:
            with self.assertRaises(ValueError):
                m.verify_target()
            api.assert_not_called()

    def test_target_mismatch_stops_before_writes(self):
        class Result:
            stdout = m.ORIGIN
        with patch.object(m.subprocess, 'run', return_value=Result()), patch.dict(m.os.environ, {'CODEX_COMPANY_PROFILE': 'mam'}), \
                patch.object(m, 'api', return_value={'id': 'wrong', 'organization_id': m.ORG}), patch.object(m, 'query') as query:
            with self.assertRaises(ValueError):
                m.verify_target()
            query.assert_not_called()

    def test_recorded_migration_must_match_exact_source_and_name(self):
        with patch.object(m, 'query', return_value=[{'name': m.NAME, 'statements': [m.MIGRATION.read_text()]}]):
            self.assertTrue(m.installed_exact())
        for row in [{'name': 'wrong', 'statements': [m.MIGRATION.read_text()]}, {'name': m.NAME, 'statements': ['different']}]:
            with patch.object(m, 'query', return_value=[row]), self.assertRaises(ValueError):
                m.installed_exact()


if __name__ == '__main__':
    unittest.main()
