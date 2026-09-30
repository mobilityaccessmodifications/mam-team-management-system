#!/usr/bin/env python3
import base64
import importlib.util
import json
import os
from pathlib import Path
import re
import secrets
import subprocess
import sys
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[1]
N8N_ROOT = Path('/Volumes/UG/MAM/opencode/n8n')
ENV = N8N_ROOT / '.env'
WEBHOOK_PATH = 'mam-people-hub-onboarding-credentials-v1'
SECRET_KEY = 'ONBOARDING_CREDENTIAL_STAGE_SECRET'
CREDENTIAL_KEY = 'ONBOARDING_CREDENTIAL_STAGE_ID'
WORKFLOW_KEY = 'ONBOARDING_CREDENTIAL_STAGE_WORKFLOW_ID'
DONE_KEY = 'ONBOARDING_CREDENTIAL_STAGE_VERCEL_SECRET_ADDED'
VERCEL = ('npx', 'vercel', '--global-config', '/Users/nixon/.vercel-profiles/mam')

spec = importlib.util.spec_from_file_location('onboarding_inspector', ROOT / 'scripts/inspect-onboarding-release.py')
assert spec is not None and spec.loader is not None
inspector = importlib.util.module_from_spec(spec)
spec.loader.exec_module(inspector)


def api(config, method, path, body=None):
    request = Request(config['N8N_BASE_URL'].rstrip('/') + '/api/v1/' + path,
                      headers={'X-N8N-API-KEY': config['N8N_API_KEY'], 'Accept': 'application/json',
                               'Content-Type': 'application/json'},
                      data=json.dumps(body).encode() if body is not None else None, method=method)
    with urlopen(request, timeout=25) as response:
        return json.load(response)


def listing(config, kind):
    items, cursor, seen = [], None, set()
    from urllib.parse import quote
    while True:
        page = api(config, 'GET', kind + '?limit=250' + ('&cursor=' + quote(cursor, safe='') if cursor else ''))
        if not isinstance(page, dict) or not isinstance(page.get('data'), list):
            raise RuntimeError('incomplete n8n listing')
        items.extend(page['data'])
        cursor = page.get('nextCursor')
        if not cursor:
            return items
        if cursor in seen:
            raise RuntimeError('repeated n8n cursor')
        seen.add(cursor)


def check_credential(credentials, bound):
    for ident, (name, kind) in inspector.CREDENTIALS.items():
        matches = [c for c in credentials if c.get('id') == ident and c.get('name') == name and c.get('type') == kind]
        if len(matches) != 1:
            raise RuntimeError('MAM prerequisite credential differs')
    matches = [c for c in credentials if c.get('name') == inspector.WEBHOOK_CREDENTIAL or
               (bound and c.get('id') == bound)]
    if not matches:
        if bound:
            raise RuntimeError('bound credential disappeared')
        return None
    if not bound:
        raise RuntimeError('unbound credential: manual investigation required')
    if len(matches) != 1 or matches[0].get('id') != bound or matches[0].get('type') != 'httpHeaderAuth' or matches[0].get('name') != inspector.WEBHOOK_CREDENTIAL:
        raise RuntimeError('credential binding mismatch')
    return bound


def check_workflows(workflows, bound):
    matches = [w for w in workflows if w.get('name') == inspector.WORKFLOW or
               (bound and w.get('id') == bound)]
    if not matches:
        if bound:
            raise RuntimeError('bound workflow disappeared')
        return None
    if len(matches) != 1 or not bound or matches[0].get('id') != bound or matches[0].get('name') != inspector.WORKFLOW:
        raise RuntimeError('workflow collision: manual investigation required')
    return bound


def inspect_n8n(config, credential_id, workflow_id):
    credentials = listing(config, 'credentials')
    workflows = listing(config, 'workflows')
    credential = check_credential(credentials, credential_id)
    workflow = check_workflows(workflows, workflow_id)
    for item in workflows:
        detail = api(config, 'GET', 'workflows/' + item['id'])
        paths = [n.get('parameters', {}).get('path') for n in detail.get('nodes', [])
                 if n.get('type') == 'n8n-nodes-base.webhook']
        if WEBHOOK_PATH in paths and item['id'] != workflow:
            raise RuntimeError('webhook path collision: manual investigation required')
    return credential, workflow


def verify_workflow(expected, actual):
    nodes = actual.get('nodes') if isinstance(actual, dict) else None
    if isinstance(nodes, list) and len(nodes) == len(expected['nodes']):
        normalized = []
        for wanted, received in zip(expected['nodes'], nodes):
            if (isinstance(received, dict) and wanted.get('type') == 'n8n-nodes-base.microsoftOutlook'
                    and 'webhookId' not in wanted and isinstance(received.get('webhookId'), str)
                    and received['webhookId']):
                received = {key: value for key, value in received.items() if key != 'webhookId'}
            normalized.append(received)
        actual = dict(actual, nodes=normalized)
    if not isinstance(actual, dict) or not actual.get('id') or actual.get('active') is not False or any(
        actual.get(key) != expected[key] for key in ('name', 'nodes', 'connections', 'settings')
    ):
        raise RuntimeError('workflow readback mismatch')


def vercel_values(origin):
    from urllib.parse import urlsplit
    parsed = urlsplit(origin)
    if parsed.scheme != 'https' or not parsed.hostname or parsed.username or parsed.password or parsed.path not in ('', '/') or parsed.query or parsed.fragment or origin.endswith('/'):
        raise RuntimeError('invalid n8n origin')
    return {'ONBOARDING_CREDENTIAL_EMAIL_MODE': 'disabled',
            'ONBOARDING_CREDENTIAL_WEBHOOK_ORIGIN': origin,
            'ONBOARDING_CREDENTIAL_WEBHOOK_URL': origin + '/webhook/' + WEBHOOK_PATH}


def parse_secret_state(values):
    secret = values.get(SECRET_KEY)
    bound = values.get(CREDENTIAL_KEY)
    if secret and not re.fullmatch(r'[A-Za-z0-9_-]{64}', secret):
        raise RuntimeError('invalid local secret binding')
    if bound and not secret:
        raise RuntimeError('invalid local secret binding')
    if values.get(WORKFLOW_KEY) and not bound:
        raise RuntimeError('invalid local workflow binding')
    return secret


def append_env(key, value):
    if not re.fullmatch(r'[A-Z_]+', key) or not re.fullmatch(r'[A-Za-z0-9_-]+', value):
        raise RuntimeError('invalid local stage value')
    if not ENV.is_file() or ENV.stat().st_mode & 0o077:
        raise RuntimeError('MAM n8n .env must exist and be private (chmod 600)')
    with ENV.open('a') as handle:
        handle.write('\n' + key + '=' + value + '\n')
        handle.flush()
        os.fsync(handle.fileno())


def vercel(*args, input_value=None):
    result = subprocess.run((*VERCEL, *args, '--project', inspector.PROJECT, '--scope', inspector.SCOPE),
                            cwd=ROOT, input=input_value, capture_output=True, text=True, timeout=90)
    if result.returncode:
        raise RuntimeError('scoped Vercel command failed (details withheld)')
    return result.stdout


def vercel_state():
    inspector.inspect_vercel()
    payload = json.loads(vercel('env', 'ls', 'production', '--json'))
    rows = payload.get('envs')
    if not isinstance(rows, list):
        raise RuntimeError('unexpected Vercel listing')
    selected = {}
    for row in rows:
        if row.get('key') in inspector.VARIABLES and 'production' in row.get('target', []):
            selected.setdefault(row['key'], []).append(row)
    if any(len(group) != 1 for group in selected.values()):
        raise RuntimeError('duplicate production environment variable')
    return {key: group[0] for key, group in selected.items()}


def verify_var(name, secret=False):
    row = vercel_state().get(name)
    if not row or row.get('type') != ('sensitive' if secret else 'encrypted') or (
        secret and row.get('visibility') != 'secret'
    ):
        raise RuntimeError('Vercel production variable metadata mismatch: ' + name)


def workflow_payload(credential_id):
    result = subprocess.run(('node', 'scripts/prepare-onboarding-workflow.mjs', credential_id,
                             inspector.WEBHOOK_CREDENTIAL), cwd=ROOT, capture_output=True, text=True, check=True)
    workflow = json.loads(result.stdout)
    if workflow.get('active') is not False:
        raise RuntimeError('workflow builder returned active payload')
    return workflow


def stage():
    subprocess.run(('python3', 'scripts/verify.py'), cwd=N8N_ROOT, check=True,
                   capture_output=True, text=True, timeout=40)
    config = inspector.runpy.run_path(str(N8N_ROOT / 'scripts/verify.py'))['load_local_env']()
    if config.get('N8N_INSTANCE_LABEL') != 'MAM':
        raise RuntimeError('wrong n8n instance label')
    values = config
    secret = parse_secret_state(values)
    credential_id, workflow_id = inspect_n8n(config, values.get(CREDENTIAL_KEY), values.get(WORKFLOW_KEY))
    origin = config['N8N_BASE_URL'].rstrip('/')
    expected_vars = vercel_values(origin)
    vars_before = vercel_state()
    for key in expected_vars:
        if key in vars_before:
            verify_var(key)
    name = 'ONBOARDING_CREDENTIAL_WEBHOOK_SECRET'
    if name in vars_before:
        verify_var(name, secret=True)
        raise RuntimeError('existing Vercel secret value cannot be proven: manual reconciliation required')
    if values.get(DONE_KEY):
        raise RuntimeError('Vercel secret binding uncertain: manual reconciliation required')
    if not secret:
        secret = base64.urlsafe_b64encode(secrets.token_bytes(48)).decode().rstrip('=')
        append_env(SECRET_KEY, secret)
    if not credential_id:
        created = api(config, 'POST', 'credentials', {'name': inspector.WEBHOOK_CREDENTIAL,
                        'type': 'httpHeaderAuth', 'data': {'name': 'x-mam-onboarding-secret', 'value': secret}})
        credential_id = created.get('id')
        if not isinstance(credential_id, str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,128}', credential_id):
            raise RuntimeError('credential POST result uncertain; inspect manually')
        append_env(CREDENTIAL_KEY, credential_id)
    credential_id, workflow_id = inspect_n8n(config, credential_id, workflow_id)
    expected = workflow_payload(credential_id)
    if not workflow_id:
        payload = {key: expected[key] for key in ('name', 'nodes', 'connections', 'settings')}
        created = api(config, 'POST', 'workflows', payload)
        workflow_id = created.get('id')
        if not isinstance(workflow_id, str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,128}', workflow_id):
            raise RuntimeError('workflow POST result uncertain; inspect manually')
        append_env(WORKFLOW_KEY, workflow_id)
    credential_id, workflow_id = inspect_n8n(config, credential_id, workflow_id)
    verify_workflow(expected, api(config, 'GET', 'workflows/' + workflow_id))
    for name, value in expected_vars.items():
        if name not in vercel_state():
            vercel('env', 'add', name, 'production', '--no-sensitive', '--yes', input_value=value)
        verify_var(name)
    name = 'ONBOARDING_CREDENTIAL_WEBHOOK_SECRET'
    if name in vercel_state():
        raise RuntimeError('Vercel secret appeared before add: manual reconciliation required')
    vercel('env', 'add', name, 'production', '--sensitive', '--yes', input_value=secret)
    verify_var(name, secret=True)
    append_env(DONE_KEY, 'yes')
    verify_workflow(expected, api(config, 'GET', 'workflows/' + workflow_id))
    print(json.dumps({'stage': 'metadata-verified', 'vercelValueReadback': 'unverified',
                      'n8nProject': 'default personal', 'workflowId': workflow_id,
                      'credentialId': credential_id, 'active': False, 'vercelProject': inspector.SCOPE + '/' + inspector.PROJECT,
                      'environment': 'production', 'requestedEmailMode': 'disabled'}))


if __name__ == '__main__':
    try:
        if sys.argv[1:] != ['stage']:
            raise RuntimeError('Usage: python3 scripts/stage-onboarding-community.py stage')
        stage()
    except Exception:
        print('Staging stopped; no activation or email attempted. Inspect exact target state before retrying (details withheld).', file=sys.stderr)
        sys.exit(1)
