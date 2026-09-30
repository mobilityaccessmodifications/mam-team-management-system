import importlib.util
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import patch

SCRIPT = Path(__file__).resolve().parents[1] / 'scripts' / 'stage-onboarding-community.py'
spec = importlib.util.spec_from_file_location('stage_onboarding', SCRIPT)
assert spec is not None and spec.loader is not None
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class StageTests(unittest.TestCase):
    def test_community_preflight_never_requests_projects(self):
        calls = []
        def api(config, method, path, body=None):
            calls.append((method, path))
            if path.startswith('credentials?'):
                return {'data': [dict(id=k, name=n, type=t) for k, (n, t) in module.inspector.CREDENTIALS.items()]}
            if path.startswith('workflows?'):
                return {'data': []}
            raise AssertionError(path)
        with patch.object(module, 'api', side_effect=api):
            state = module.inspect_n8n({}, None, None)
        self.assertEqual(state, (None, None))
        self.assertFalse(any('projects' in path for _, path in calls))

    def test_existing_credential_without_local_binding_stops_before_write(self):
        prereqs = [dict(id=k, name=n, type=t) for k, (n, t) in module.inspector.CREDENTIALS.items()]
        with self.assertRaisesRegex(RuntimeError, 'unbound credential'):
            module.check_credential(prereqs + [{'id': 'synthetic-id', 'name': module.inspector.WEBHOOK_CREDENTIAL,
                                                 'type': 'httpHeaderAuth'}], None)

    def test_existing_credential_with_binding_is_reused(self):
        item = {'id': 'synthetic-id', 'name': module.inspector.WEBHOOK_CREDENTIAL, 'type': 'httpHeaderAuth'}
        prereqs = [dict(id=k, name=n, type=t) for k, (n, t) in module.inspector.CREDENTIALS.items()]
        self.assertEqual(module.check_credential(prereqs + [item], 'synthetic-id'), 'synthetic-id')

    def test_rejects_wrong_workflow_before_any_write(self):
        with self.assertRaisesRegex(RuntimeError, 'workflow collision'):
            module.check_workflows([{'id': 'wrong', 'name': module.inspector.WORKFLOW}], None)

    def test_workflow_readback_compares_nodes_links_and_inactive(self):
        expected = {'name': module.inspector.WORKFLOW, 'active': False, 'nodes': [
            {'name': 'Hook', 'type': 'n8n-nodes-base.webhook', 'parameters': {'path': module.WEBHOOK_PATH},
             'credentials': {'httpHeaderAuth': {'id': 'synthetic-id', 'name': module.inspector.WEBHOOK_CREDENTIAL}}}],
             'connections': {'Hook': {'main': []}}, 'settings': {'executionOrder': 'v1'}}
        module.verify_workflow(expected, dict(expected, id='synthetic-workflow'))
        for change in ({'active': True}, {'connections': {}}, {'nodes': []}):
            with self.subTest(change=change), self.assertRaisesRegex(RuntimeError, 'workflow readback'):
                module.verify_workflow(expected, dict(expected, **change))

    def test_vercel_values_must_be_exact_and_disabled(self):
        expected = module.vercel_values('https://example.test')
        self.assertEqual(expected['ONBOARDING_CREDENTIAL_WEBHOOK_URL'],
                         'https://example.test/webhook/' + module.WEBHOOK_PATH)
        self.assertEqual(expected['ONBOARDING_CREDENTIAL_EMAIL_MODE'], 'disabled')
        for origin in ('http://example.test', 'https://example.test/other', 'https://user@example.test'):
            with self.assertRaisesRegex(RuntimeError, 'origin'):
                module.vercel_values(origin)

    def test_secret_is_not_accepted_without_valid_local_binding(self):
        with self.assertRaisesRegex(RuntimeError, 'binding'):
            module.parse_secret_state({'ONBOARDING_CREDENTIAL_STAGE_SECRET': 'not-a-secret'})

    def test_staging_uses_only_personal_post_and_disabled_scoped_env(self):
        config = {'N8N_INSTANCE_LABEL': 'MAM', 'N8N_BASE_URL': 'https://synthetic.example.test',
                  'N8N_API_KEY': 'synthetic-api-key'}
        state, calls, bindings = {}, [], {}
        expected = {'name': module.inspector.WORKFLOW, 'active': False, 'nodes': [
            {'name': 'Hook', 'type': 'n8n-nodes-base.webhook', 'parameters': {'path': module.WEBHOOK_PATH},
             'credentials': {'httpHeaderAuth': {'id': 'synthetic-id', 'name': module.inspector.WEBHOOK_CREDENTIAL}}}],
            'connections': {'Hook': {'main': []}}, 'settings': {'executionOrder': 'v1'}}
        def api(_, method, path, body=None):
            calls.append((method, path, body))
            if (method, path) == ('POST', 'credentials'):
                return {'id': 'synthetic-id'}
            if (method, path) == ('POST', 'workflows'):
                return {'id': 'synthetic-workflow'}
            if (method, path) == ('GET', 'workflows/synthetic-workflow'):
                return dict(expected, id='synthetic-workflow')
            raise AssertionError((method, path))
        def stage_var(*args, input_value=None):
            calls.append(('VERCEL', args, input_value))
            name = args[2]
            state[name] = {'value': input_value if name != 'ONBOARDING_CREDENTIAL_WEBHOOK_SECRET' else None,
                           'target': ['production'], 'type': 'sensitive' if name.endswith('SECRET') else 'encrypted'}
        with patch.object(module.subprocess, 'run', return_value=SimpleNamespace(returncode=0, stdout='')) as verifier, \
             patch.object(module.inspector.runpy, 'run_path', return_value={'load_local_env': lambda: config}), \
             patch.object(module, 'inspect_n8n', side_effect=[(None, None), ('synthetic-id', None),
                                                                ('synthetic-id', 'synthetic-workflow')]), \
             patch.object(module, 'vercel_state', side_effect=lambda: state.copy()), \
             patch.object(module, 'api', side_effect=api), \
             patch.object(module, 'append_env', side_effect=lambda k, v: bindings.update({k: v})), \
             patch.object(module, 'workflow_payload', return_value=expected), \
             patch.object(module, 'vercel', side_effect=stage_var), \
             patch.object(module, 'verify_workflow', wraps=module.verify_workflow):
            module.stage()
        self.assertEqual(verifier.call_args.args[0], ('python3', 'scripts/verify.py'))
        self.assertEqual([p for m, p, _ in calls if m == 'POST'], ['credentials', 'workflows'])
        self.assertNotIn('projectId', calls[0][2])
        self.assertNotIn('active', calls[1][2])
        self.assertEqual(state['ONBOARDING_CREDENTIAL_EMAIL_MODE']['value'], 'disabled')
        self.assertEqual(state['ONBOARDING_CREDENTIAL_WEBHOOK_URL']['value'],
                         'https://synthetic.example.test/webhook/' + module.WEBHOOK_PATH)
        self.assertEqual(bindings[module.DONE_KEY], 'yes')
        self.assertEqual(len(bindings[module.SECRET_KEY]), 64)
        self.assertTrue(all('production' in args and '--yes' in args
                            for method, args, _ in calls if method == 'VERCEL'))

    def test_vercel_helper_explicitly_scopes_project_and_account(self):
        with patch.object(module.subprocess, 'run', return_value=SimpleNamespace(returncode=0, stdout='')) as run:
            module.vercel('env', 'add', 'SYNTHETIC', 'production', input_value='synthetic-value')
        command = run.call_args.args[0]
        self.assertEqual(command[-4:], ('--project', module.inspector.PROJECT, '--scope', module.inspector.SCOPE))
        self.assertEqual(run.call_args.kwargs['input'], 'synthetic-value')


if __name__ == '__main__':
    unittest.main()
