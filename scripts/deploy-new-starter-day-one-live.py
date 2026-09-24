import hashlib
import json
from pathlib import Path
import runpy
import subprocess
import sys
from urllib.error import HTTPError
from urllib.parse import quote
from urllib.request import Request, urlopen


ROOT = Path(__file__).resolve().parent.parent
N8N_ROOT = Path('/Volumes/UG/MAM/opencode/n8n')
TEST_ID = 'lDe4pksbh4SegkvS'
TEST_NAME = 'MAM People Hub - Day 1 New Starter Email (Marketing Test)'
LIVE_NAME = 'MAM People Hub - Day 1 New Starter Email (Live)'
LIVE_PATH = 'mam-people-hub-new-starter-day-one-live-v1'
WEBHOOK_CREDENTIAL = 'b5WWH2Mm2r1QTCHp'
OUTLOOK_CREDENTIAL = 'vFEolsXoEOOxNyan'
RECEIPT_CREDENTIAL = 'tGtpwegru8OxtdCt'


def require(condition, message):
    if not condition:
        raise SystemExit(message)


def node(workflow, name):
    matches = [item for item in workflow['nodes'] if item.get('name') == name]
    require(len(matches) == 1, f'Unexpected node: {name}')
    return matches[0]


def canonical_nodes(workflow):
    result = []
    for item in workflow['nodes']:
        copy = dict(item)
        if copy.get('type') == 'n8n-nodes-base.microsoftOutlook':
            copy.pop('webhookId', None)
        result.append(copy)
    return result


def assert_receiver(workflow, name, path):
    require(workflow.get('name') == name and len(workflow.get('nodes', [])) == 14,
            'Unexpected MAM Day 1 receiver')
    webhook = node(workflow, 'Receive Day 1 Request')
    require(webhook.get('parameters', {}).get('path') == path
            and webhook.get('parameters', {}).get('authentication') == 'headerAuth'
            and webhook.get('credentials', {}).get('httpHeaderAuth', {}).get('id') == WEBHOOK_CREDENTIAL,
            'Unexpected Day 1 webhook authentication')
    send = node(workflow, 'Send Day 1 Email from HR')
    require(send.get('type') == 'n8n-nodes-base.microsoftOutlook'
            and send.get('credentials', {}).get('microsoftOutlookOAuth2Api', {}).get('id') == OUTLOOK_CREDENTIAL,
            'Unexpected Day 1 HR Outlook credential')
    for name in ('Reserve Durable Day 1 Delivery', 'Confirm Durable Day 1 Delivery'):
        require(node(workflow, name).get('credentials', {}).get('httpHeaderAuth', {}).get('id')
                == RECEIPT_CREDENTIAL, 'Unexpected Day 1 receipt credential')


def blueprint(mode):
    require(mode in ('test', 'live'), 'Unexpected Day 1 workflow mode')
    source = ("import { buildNewStarterDayOneWorkflow } from "
              "'./scripts/build-new-starter-day-one-workflow.mjs'; "
              f"process.stdout.write(JSON.stringify(buildNewStarterDayOneWorkflow({{mode:'{mode}'}})))")
    result = subprocess.run(['node', '--input-type=module', '-e', source], cwd=ROOT,
                            text=True, capture_output=True, check=True)
    workflow = json.loads(result.stdout)
    if mode == 'live':
        assert_receiver(workflow, LIVE_NAME, LIVE_PATH)
        require(workflow['settings']['saveDataSuccessExecution'] == 'none'
                and workflow['settings']['saveDataErrorExecution'] == 'none',
                'Live employee data must not be saved in n8n executions')
    return workflow


def api(config, method, path, body=None):
    request = Request(config['N8N_BASE_URL'].rstrip('/') + '/api/v1/' + path,
                      method=method,
                      headers={'X-N8N-API-KEY': config['N8N_API_KEY'],
                               'Accept': 'application/json', 'Content-Type': 'application/json'},
                      data=None if body is None else json.dumps(body).encode())
    try:
        with urlopen(request, timeout=45) as response:
            return json.load(response)
    except HTTPError as error:
        raise SystemExit(f'MAM n8n returned HTTP {error.code} for {method} {path}') from None


def matching_workflows(config):
    matches = []
    path = 'workflows?limit=250'
    while path:
        listing = api(config, 'GET', path)
        matches.extend(item for item in listing.get('data', [])
                       if item.get('name') in (TEST_NAME, LIVE_NAME))
        cursor = listing.get('nextCursor')
        path = 'workflows?limit=250&cursor=' + quote(cursor) if cursor else None
    return matches


def assert_blueprint(saved, expected):
    assert_receiver(saved, LIVE_NAME, LIVE_PATH)
    require(canonical_nodes(saved) == expected['nodes']
            and saved.get('connections') == expected['connections']
            and all(saved.get('settings', {}).get(key) == value
                    for key, value in expected['settings'].items()),
            'Live Day 1 receiver read-back differs from reviewed blueprint')


def main():
    operation = sys.argv[1] if len(sys.argv) > 1 else ''
    require(operation in ('inspect', 'apply'), 'Use inspect or apply <reviewed-sha256>')
    expected = blueprint('live')
    test_expected = blueprint('test')
    review_hash = hashlib.sha256(Path(__file__).read_bytes()
                                 + json.dumps({'test': test_expected, 'live': expected},
                                              sort_keys=True).encode()).hexdigest()
    if operation == 'apply':
        require(len(sys.argv) == 3 and sys.argv[2] == review_hash,
                'Reviewed Day 1 deployment differs')
    verifier = runpy.run_path(str(N8N_ROOT / 'scripts/verify.py'))
    config = verifier['load_local_env']()
    approved_origin = runpy.run_path(str(N8N_ROOT / 'scripts/set_api_key.py'))['BASE_URL']
    require(config.get('N8N_BASE_URL', '').rstrip('/') == approved_origin,
            'MAM n8n origin differs from project-owned approved setup')
    require(verifier['main']() == 0, 'MAM n8n verification failed')
    require(config.get('N8N_INSTANCE_LABEL') == 'MAM', 'MAM n8n instance mismatch')

    test = api(config, 'GET', f'workflows/{TEST_ID}')
    require(test.get('id') == TEST_ID and test.get('active') is True,
            'Expected MAM Marketing Test receiver is not active')
    require(test.get('versionId') and test.get('versionId') == test.get('activeVersionId'),
            'MAM Marketing Test receiver draft is not the active version')
    assert_receiver(test, TEST_NAME, 'mam-people-hub-new-starter-day-one-test-v1')
    require(canonical_nodes(test) == test_expected['nodes']
            and test.get('connections') == test_expected['connections']
            and all(test.get('settings', {}).get(key) == value
                    for key, value in test_expected['settings'].items()),
            'MAM Marketing Test receiver differs from reviewed blueprint')
    matches = matching_workflows(config)
    require(len([item for item in matches if item.get('name') == TEST_NAME]) == 1,
            'Unexpected duplicate MAM Day 1 test receiver')
    live_matches = [item for item in matches if item.get('name') == LIVE_NAME]
    require(len(live_matches) <= 1, 'Unexpected duplicate MAM Day 1 live receiver')
    live_id = live_matches[0]['id'] if live_matches else None

    if operation == 'apply' and live_id is None:
        created = api(config, 'POST', 'workflows', expected)
        live_id = created.get('id')
        require(isinstance(live_id, str) and live_id, 'MAM Day 1 receiver creation failed')
    if live_id:
        saved = api(config, 'GET', f'workflows/{live_id}')
        assert_blueprint(saved, expected)
        if operation == 'apply' and saved.get('active') is not True:
            api(config, 'POST', f'workflows/{live_id}/activate')
            saved = api(config, 'GET', f'workflows/{live_id}')
        if operation == 'apply':
            assert_blueprint(saved, expected)
            require(saved.get('active') is True
                    and saved.get('versionId')
                    and saved.get('versionId') == saved.get('activeVersionId'),
                    'Reviewed live Day 1 version is not active')
    print(json.dumps({'reviewSha256': review_hash, 'testWorkflowId': TEST_ID,
                      'liveWorkflowId': live_id, 'liveActive': bool(live_id and saved.get('active'))}))


if __name__ == '__main__':
    main()
