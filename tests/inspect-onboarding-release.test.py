from email.message import Message
import io
import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch
from urllib.error import HTTPError

SCRIPT = Path(__file__).resolve().parents[1] / 'scripts' / 'inspect-onboarding-release.py'
spec = importlib.util.spec_from_file_location('onboarding_inspect', SCRIPT)
assert spec is not None and spec.loader is not None
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class InspectionTests(unittest.TestCase):
    def test_personal_project_route_does_not_require_project_admin_listing(self):
        def fake_api(config, path):
            if path.startswith('credentials?'):
                return {'data': [dict(id=key, name=name, type=kind) for key, (name, kind) in module.CREDENTIALS.items()]}
            if path.startswith('workflows?'):
                return {'data': [{'id': 'synthetic-workflow', 'name': 'Other workflow'}]}
            if path.startswith('workflows/'):
                return {'nodes': []}
            raise AssertionError('project admin route must not be requested')
        with patch.object(module, 'api', side_effect=fake_api) as api:
            self.assertIn('default personal project', module.inspect_n8n({'N8N_API_KEY': 'synthetic-secret'}))
            self.assertFalse(any('projects' in call.args[1] for call in api.call_args_list))

    def test_empty_workflow_listing_supports_personal_project_route(self):
        def fake_api(config, path):
            if path.startswith('credentials?'):
                return {'data': [dict(id=key, name=name, type=kind) for key, (name, kind) in module.CREDENTIALS.items()]}
            if path.startswith('workflows?'):
                return {'data': []}
            raise AssertionError('project admin route must not be requested')
        with patch.object(module, 'api', side_effect=fake_api):
            self.assertIn('default personal project', module.inspect_n8n({}))

    def test_rejects_credential_identity_mismatch(self):
        with patch.object(module, 'api', side_effect=[{'data': []}, {'data': []}]):
            with self.assertRaisesRegex(RuntimeError, 'credential identity differs'):
                module.inspect_n8n({})

    def test_rejects_existing_dedicated_credential(self):
        credentials = [dict(id=key, name=name, type=kind) for key, (name, kind) in module.CREDENTIALS.items()]
        credentials.append(dict(id='synthetic', name=module.WEBHOOK_CREDENTIAL, type='httpHeaderAuth'))
        with patch.object(module, 'api', side_effect=[{'data': credentials}, {'data': []}]):
            with self.assertRaisesRegex(RuntimeError, 'header credential name already exists'):
                module.inspect_n8n({})

    def test_paginates_credentials_and_rejects_repeated_cursor(self):
        with patch.object(module, 'api', side_effect=[{'data': [], 'nextCursor': 'a+b'}, {'data': [], 'nextCursor': 'a+b'}]) as api:
            with self.assertRaisesRegex(RuntimeError, 'pagination repeated'):
                module.list_all({}, 'credentials')
            self.assertEqual(api.call_args_list[1].args[1], 'credentials?limit=250&cursor=a%2Bb')

    def test_rejects_duplicate_webhook_path_even_with_other_name(self):
        def fake_api(config, path):
            if path.startswith('credentials?'):
                return {'data': [dict(id=key, name=name, type=kind) for key, (name, kind) in module.CREDENTIALS.items()]}
            if path.startswith('workflows?'):
                return {'data': [{'id': 'synthetic-workflow', 'name': 'Other workflow'}]}
            return {'nodes': [{'type': 'n8n-nodes-base.webhook', 'parameters': {
                'path': 'mam-people-hub-onboarding-credentials-v1'}}]}
        with patch.object(module, 'api', side_effect=fake_api):
            with self.assertRaisesRegex(RuntimeError, 'webhook path already exists'):
                module.inspect_n8n({})

    def test_vercel_project_mismatch_fails_before_env_listing(self):
        with patch.object(module, 'run', return_value='{"id":"other","name":"mam-team-management-system","owner":{"slug":"ai-7033s-projects"}}'):
            with patch.object(module.subprocess, 'run') as proc:
                with self.assertRaisesRegex(RuntimeError, 'project identity differs'):
                    module.inspect_vercel()
                proc.assert_not_called()


if __name__ == '__main__':
    unittest.main()
