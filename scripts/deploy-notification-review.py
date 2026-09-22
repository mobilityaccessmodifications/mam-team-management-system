"""Paused-only durable receipt cutover. This helper NEVER pauses or activates.

Parent sequence: pause exact receiver; snapshot /private/tmp/<task>/legacy.json;
import every legacy key with ready=false; apply <reviewed hash> <snapshot>;
verify API/credential GET readiness, set ready last, explicitly activate outside
this helper. Never replay a webhook, retry a failed sender, or test-send mail.

snapshot waits the full pinned 30s execution timeout AFTER observing inactivity,
then requires zero nonterminal executions and two identical final snapshots.
Artifacts contain only legacy keys/state/time and digests, created mode 0600.
inspect is read-only. hash is offline. apply installs INACTIVE and omits staticData.
No automatic recovery retry after an uncertain PUT; inspect/review the new state.
"""
import copy
import hashlib
import json
import os
from pathlib import Path
import re
import runpy
import subprocess
import sys
import time
import urllib.parse
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
TEMP_ROOT = Path('/tmp').resolve()  # /private/tmp on macOS, /tmp on Linux CI.
N8N = Path('/Volumes/UG/MAM/opencode/n8n')
WORKFLOW = 'D6UG5ACZGILCpsOk'
NAME = 'MAM People System - Leave Email Delivery'
ALERT = 'UoQAe53Yu0fJ3ncq'
CALLBACK = 'https://mam-team-management-system-ten.vercel.app/api/internal/integrations/notifications/receipts'
COMMON = 'notification-receipt-contract.n8n.txt'
FILES = {
    'Validate and Reserve Leave Notification': ('leave-notification-validator.n8n.txt', False),
    'Confirm Leave HR Delivery': ('leave-notification-confirmation.n8n.txt', True),
    'Return Leave HR Duplicate': ('leave-notification-duplicate.n8n.txt', False),
    'Return Leave HR Rejection': ('leave-notification-rejection.n8n.txt', False),
    'Gate Durable Leave Reservation': ('leave-notification-reservation-gate.n8n.txt', True),
    'Validate Durable Leave Confirmation': ('leave-notification-confirmation-result.n8n.txt', True),
}
# Fresh read/review 2026-09-22. Whole-node hashes include IDs, parameters,
# credential REFERENCES and retry/error settings, without storing secrets here.
BASELINE = {
    'versionId': '07108502-d6a3-4396-b68d-5b9abe0a5d4e',
    'connectionsSha256': '6eaedc6cd883f832593d7870c543e724051cc95df9ea541860bb86cb4bec51d0',
    'settingsSha256': '0f4802a8b187cc78df5e7786aab4c0bc3a510bb0ae249e3cdb835e57f3169188',
    'nodes': {
        'Already Delivered?': 'ec0ee7b8468c0bef8cf7c2892b3b6787d9086bf58682a3318c7c64094af9d9d4',
        'Confirm Leave HR Delivery': 'e03d9b425f2ab6dee72e583dab53d99595b0c852d53e669bc25a1f5e2f61fde7',
        'Receive Leave Notification': 'ff20c996454e45ec2f2de9694f4432870c1ace407df8ecf7d01c7a0e34ea6caf',
        'Return Leave HR Duplicate': '8abce0bd6637a4cf5591334efcc90af168914016b60957f4fbf52a9794d3d871',
        'Return Leave HR Rejection': '014d9a9ed924a6c6e60765f3067511e7de67d874287256894af4d159bcf5b00d',
        'Send Leave Notification to HR': '65eb37dac0e1c775085142a2370bec5875c1cbf0dc750834c4b9ac032724b3b5',
        'Send Leave Notification?': 'f188dab77d6f7875c42abff3af87ccab74f0b89e6a4ff3de0001fa43adb74ae7',
        'Validate and Reserve Leave Notification': '2d4ad997fc9fa50d719e41a00e12bde22c89e72921ecfc09a7d3e9b04acc7c72',
    },
}


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode()).hexdigest()


def bundle_hash():
    paths = [Path(__file__), ROOT / 'workflows' / COMMON]
    paths.extend(ROOT / 'workflows' / filename for filename, _ in FILES.values())
    return hashlib.sha256(b'\0'.join(path.read_bytes() for path in paths)).hexdigest()


def source(name):
    filename, common = FILES[name]
    return ((ROOT / 'workflows' / COMMON).read_text() + '\n' if common else '') + (ROOT / 'workflows' / filename).read_text()


def fingerprint(live):
    nodes = live['nodes']
    if len({node['name'] for node in nodes}) != len(nodes):
        raise ValueError('Duplicate node names')
    return {'versionId': live['versionId'], 'nodes': {node['name']: digest(node) for node in nodes},
            'connectionsSha256': digest(live['connections']), 'settingsSha256': digest(live['settings'])}


def verify_baseline(live, baseline=BASELINE):
    if live.get('id') != WORKFLOW or live.get('name') != NAME or fingerprint(live) != baseline:
        raise ValueError('Receiver version/nodes/credentials/settings/topology drift; fresh review required')
    if live.get('activeVersionId') not in (None, baseline['versionId']):
        raise ValueError('Published version differs from reviewed version')
    settings = live['settings']
    if settings.get('executionTimeout') != 30 or settings.get('errorWorkflow') != ALERT \
            or settings.get('saveExecutionProgress') is not False \
            or any(settings.get(k) != 'none' for k in ['saveDataSuccessExecution', 'saveDataErrorExecution']):
        raise ValueError('Timeout/error/retention policy drift')


def http_node(name, node_id, credential, body=None):
    # Schema verified against n8n@2.32.6 HttpRequest/V3/Description.ts.
    parameters = {'method': 'POST' if body else 'GET', 'url': CALLBACK,
                  'authentication': 'genericCredentialType', 'genericAuthType': 'httpHeaderAuth',
                  'options': {'redirect': {'redirect': {'followRedirects': False}}, 'timeout': 10000,
                              'response': {'response': {'responseFormat': 'json', 'neverError': False, 'fullResponse': False}}}}
    if body:
        parameters.update({'sendBody': True, 'contentType': 'json', 'specifyBody': 'json', 'jsonBody': body})
    return {'id': node_id, 'name': name, 'type': 'n8n-nodes-base.httpRequest', 'typeVersion': 4.2,
            'position': [720, 400], 'parameters': parameters,
            'credentials': {'httpHeaderAuth': copy.deepcopy(credential)}, 'retryOnFail': False, 'onError': 'stopWorkflow'}


def edges(*targets):
    return {'main': [[{'node': name, 'type': 'main', 'index': 0}] for name in targets]}


def patch(live, baseline=BASELINE):
    verify_baseline(live, baseline)
    result = {key: copy.deepcopy(live[key]) for key in ['name', 'nodes', 'connections', 'settings']}
    nodes = {node['name']: node for node in result['nodes']}
    for name in FILES:
        if name in nodes:
            nodes[name]['parameters']['jsCode'] = source(name)
    sender = nodes['Send Leave Notification to HR']
    # Explicit, not a default inferred from absence. No error output/retry path.
    sender['retryOnFail'] = False
    sender['onError'] = 'stopWorkflow'
    credential = nodes['Receive Leave Notification']['credentials']['httpHeaderAuth']
    valid = copy.deepcopy(nodes['Send Leave Notification?'])
    valid.update({'id': 'mam-durable-valid', 'name': 'Valid Leave Notification?', 'position': [240, 400]})
    condition = valid['parameters']['conditions']['conditions'][0]
    condition.update({'id': 'mam-durable-valid-condition', 'leftValue': "={{ $json.outcome === 'reserve' }}"})
    additions = [valid,
        http_node('Reserve Durable Leave Delivery', 'mam-durable-reserve', credential,
                  "={{ { action: 'reserve', eventKey: $json.eventKey, recipient: $json.deliveryRecipient, cc: $json.ccRecipients, legacyEventKey: $json.legacyEventKey } }}"),
        http_node('Confirm Durable Leave Delivery', 'mam-durable-confirm', credential, '={{ $json }}')]
    for name, node_id, position in [
        ('Gate Durable Leave Reservation', 'mam-durable-grant', [960, 400]),
        ('Validate Durable Leave Confirmation', 'mam-durable-ack', [1440, 400]),
    ]:
        additions.append({'id': node_id, 'name': name, 'type': 'n8n-nodes-base.code', 'typeVersion': 2,
                          'position': position, 'parameters': {'jsCode': source(name)}, 'retryOnFail': False, 'onError': 'stopWorkflow'})
    result['nodes'].extend(additions)
    result['connections'].update({
        'Validate and Reserve Leave Notification': edges('Valid Leave Notification?'),
        'Valid Leave Notification?': edges('Reserve Durable Leave Delivery', 'Return Leave HR Rejection'),
        'Reserve Durable Leave Delivery': edges('Gate Durable Leave Reservation'),
        'Gate Durable Leave Reservation': edges('Send Leave Notification?'),
        'Confirm Leave HR Delivery': edges('Confirm Durable Leave Delivery'),
        'Confirm Durable Leave Delivery': edges('Validate Durable Leave Confirmation'),
    })
    return result


def credential_probe(live, probe_path, baseline=BASELINE):
    """OFFLINE plan only. Parent may review/create/run/delete this no-mail GET probe.

    Parent supplies an unpredictable UUIDv4 path; GET exposes ONLY readiness.
    No POST/action, sender, secret extraction, or mail-workflow reuse. Parent
    creates/activates/GETs/deactivates/deletes this exact isolated probe only.
    """
    verify_baseline(live, baseline)
    if not isinstance(probe_path, str) or not re.fullmatch(r'[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}', probe_path):
        raise ValueError('Probe path must be an unpredictable lowercase UUIDv4')
    credential = next(n for n in live['nodes'] if n['name'] == 'Receive Leave Notification')['credentials']['httpHeaderAuth']
    return {'name': 'MAM receipt credential readiness - temporary reviewed GET only', 'nodes': [
        {'id': 'mam-probe-trigger', 'name': 'Temporary readiness GET', 'type': 'n8n-nodes-base.webhook', 'typeVersion': 2.1,
         'webhookId': probe_path, 'parameters': {'httpMethod': 'GET', 'path': probe_path, 'authentication': 'none', 'responseMode': 'lastNode', 'options': {}}, 'position': [0, 0]},
        http_node('GET Receipt Readiness', 'mam-probe-get', credential),
        {'id': 'mam-probe-result', 'name': 'Readiness only', 'type': 'n8n-nodes-base.code', 'typeVersion': 2, 'position': [960, 0],
         'parameters': {'jsCode': "const r=$input.all(); if(r.length!==1||r[0].json.version!==1||typeof r[0].json.ready!=='boolean') throw new Error('Readiness unavailable'); return [{json:{version:1,ready:r[0].json.ready}}];"}},
    ], 'connections': {'Temporary readiness GET': edges('GET Receipt Readiness'), 'GET Receipt Readiness': edges('Readiness only')},
        'settings': {'executionOrder': 'v1', 'executionTimeout': 30, 'saveDataSuccessExecution': 'none', 'saveDataErrorExecution': 'none', 'saveManualExecutions': False, 'saveExecutionProgress': False}}


def require_paused(live):
    if live.get('active') is not False or live.get('activeVersionId') is not None:
        raise ValueError('Parent must pause the exact receiver before cutover')


def nonterminal_count(api):
    # Enumerate metadata for THIS receiver, not retained execution payloads.
    # Include new/queued/running/waiting/unknown; retention=none is not evidence.
    cursor, seen, count = None, set(), 0
    for _ in range(1000):
        path = 'executions?' + urllib.parse.urlencode({'workflowId': WORKFLOW, 'includeData': 'false', 'limit': 100, **({'cursor': cursor} if cursor else {})})
        page = api('GET', path)
        if not isinstance(page.get('data'), list):
            raise ValueError('Execution inventory unavailable')
        for execution in page['data']:
            if execution.get('workflowId') != WORKFLOW:
                raise ValueError('Execution scope mismatch')
            if execution.get('status') not in ('success', 'error', 'canceled', 'crashed'):
                count += 1
        cursor = page.get('nextCursor')
        if not cursor:
            return count
        if cursor in seen:
            raise ValueError('Execution pagination repeated')
        seen.add(cursor)
    raise ValueError('Execution inventory incomplete')


def minimal_receipts(live):
    events = (live.get('staticData') or {}).get('global', {}).get('leaveNotificationEvents', {})
    if not isinstance(events, dict):
        raise ValueError('Legacy receipt shape changed')
    # Same syntax as the application contract, never print a failed key.
    uid = r'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
    pattern = rf'(leave:{uid}:(leave-submitted|leave-approved|leave-declined|leave-cancelled|leave-conditionally-approved|leave-reminder|team-birthday):[0-9a-f]{{24}}|payroll-balance:{uid}:[0-9]{{4}}-(0[1-9]|1[0-2])|payroll-comparison:{uid})'
    result = {}
    for key, receipt in events.items():
        if not re.fullmatch(pattern, key) or not isinstance(receipt, dict) or receipt.get('state') not in ('sent', 'processing') \
                or type(receipt.get('at')) not in (int, float) or not 0 <= receipt['at'] <= 8640000000000000:
            raise ValueError('Legacy key/state/time requires explicit import review')
        result[key] = {'state': receipt['state'], 'at': receipt['at']}
    return result


def freeze(api, baseline=BASELINE, sleep=time.sleep, now=time.time):
    initial = api('GET', 'workflows/' + WORKFLOW)
    verify_baseline(initial, baseline)
    require_paused(initial)
    # A pre-drain receipt read is NEVER the import snapshot.
    sleep(30)
    final = api('GET', 'workflows/' + WORKFLOW)
    verify_baseline(final, baseline)
    require_paused(final)
    if nonterminal_count(api):
        raise ValueError('Receiver still has nonterminal executions')
    sleep(1)
    stable = api('GET', 'workflows/' + WORKFLOW)
    verify_baseline(stable, baseline)
    require_paused(stable)
    if digest(final.get('staticData')) != digest(stable.get('staticData')) or nonterminal_count(api):
        raise ValueError('Final receipt snapshot is not stable/drained')
    desired = patch(stable, baseline)
    return {'workflowId': WORKFLOW, 'versionId': stable['versionId'],
            'capturedAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime(now())),
            'receipts': minimal_receipts(stable), 'staticDataSha256': digest(stable.get('staticData')),
            'baseline': fingerprint(stable), 'bundleSha256': bundle_hash(), 'drainSeconds': 30, 'nonterminalCount': 0,
            'desired': {key: digest(desired[key]) for key in ('nodes', 'connections', 'settings')}}


def verify_frozen_snapshot(snapshot, phase='baseline', expected_version=None, api=None, baseline=BASELINE):
    """Read-only parent import/enable gate. Caller verifies exact artifact bytes.

    baseline: before import/patch. desired: before ready=true/activation. This is
    a bounded fresh check, NOT an atomic lease over n8n+Postgres: parent must keep
    exclusive cutover ownership and the receiver paused until explicit activate.
    No credential or receipt keys are returned/logged.
    """
    if snapshot.get('workflowId') != WORKFLOW or snapshot.get('baseline') != baseline \
            or snapshot.get('versionId') != baseline['versionId'] or snapshot.get('bundleSha256') != bundle_hash() \
            or snapshot.get('drainSeconds') != 30 or snapshot.get('nonterminalCount') != 0:
        raise ValueError('Frozen snapshot identity/review evidence differs')
    if phase not in ('baseline', 'desired'):
        raise ValueError('Expected baseline or desired phase')
    api = api or connect()
    previous = None
    for _ in range(2):
        live = api('GET', 'workflows/' + WORKFLOW)
        require_paused(live)
        if live.get('id') != WORKFLOW or live.get('name') != NAME:
            raise ValueError('Receiver identity differs')
        if phase == 'baseline':
            verify_baseline(live, baseline)
        elif any(digest(live.get(key)) != snapshot.get('desired', {}).get(key) for key in ('nodes', 'connections', 'settings')):
            raise ValueError('Installed topology/code/credentials differ from reviewed snapshot')
        if expected_version is not None and live.get('versionId') != expected_version:
            raise ValueError('Installed version changed')
        if digest(live.get('staticData')) != snapshot.get('staticDataSha256') or minimal_receipts(live) != snapshot.get('receipts'):
            raise ValueError('Frozen legacy receipts changed')
        if nonterminal_count(api):
            raise ValueError('Receiver has nonterminal executions')
        current = fingerprint(live)
        if previous is not None and current != previous:
            raise ValueError('Receiver changed during verification')
        previous = current
    return {'workflowId': WORKFLOW, 'phase': phase, 'versionId': live['versionId'], 'active': False,
            'nonterminalCount': 0, 'receiptCount': len(snapshot['receipts']), 'bundleSha256': bundle_hash()}


def apply_paused(api, snapshot, reviewed_hash, baseline=BASELINE):
    if reviewed_hash != bundle_hash() or snapshot.get('bundleSha256') != reviewed_hash:
        raise ValueError('Reviewed bundle differs')
    if snapshot.get('workflowId') != WORKFLOW or snapshot.get('baseline') != baseline \
            or snapshot.get('versionId') != baseline['versionId'] or snapshot.get('drainSeconds') != 30 \
            or snapshot.get('nonterminalCount') != 0 or not snapshot.get('capturedAt'):
        raise ValueError('Missing frozen cutover evidence')
    verify_frozen_snapshot(snapshot, api=api, baseline=baseline)
    current = api('GET', 'workflows/' + WORKFLOW)
    verify_baseline(current, baseline)
    require_paused(current)
    proposed = patch(current, baseline)
    if nonterminal_count(api):
        raise ValueError('Receiver still has nonterminal executions')
    latest = api('GET', 'workflows/' + WORKFLOW)
    verify_baseline(latest, baseline)
    require_paused(latest)
    if snapshot.get('staticDataSha256') != digest(latest.get('staticData')) or snapshot.get('receipts') != minimal_receipts(latest):
        raise ValueError('Frozen legacy snapshot changed; import must be reconciled')
    if nonterminal_count(api):
        raise ValueError('Receiver acquired a nonterminal execution')
    api('PUT', 'workflows/' + WORKFLOW, proposed)
    saved = api('GET', 'workflows/' + WORKFLOW)
    require_paused(saved)
    if any(saved.get(key) != proposed[key] for key in proposed) or digest(saved.get('staticData')) != snapshot['staticDataSha256']:
        raise ValueError('Inactive receiver/staticData read-back mismatch; do not activate')
    if nonterminal_count(api):
        raise ValueError('Unexpected execution after inactive update')
    return {'operation': 'apply', 'workflowId': WORKFLOW, 'active': False, 'verified': True,
            'versionId': saved['versionId'], 'bundleSha256': reviewed_hash,
            'nodesSha256': digest(saved['nodes']), 'connectionsSha256': digest(saved['connections'])}


def read_snapshot(path, expected_sha256):
    path = Path(path)
    if not path.is_absolute() or not path.resolve().is_relative_to(TEMP_ROOT) or path.stat().st_mode & 0o077:
        raise ValueError('Snapshot must be private under the system temporary root')
    raw = path.read_bytes()
    if hashlib.sha256(raw).hexdigest() != expected_sha256:
        raise ValueError('Exact snapshot file SHA256 differs')
    return json.loads(raw)


def write_snapshot(path, snapshot):
    path = Path(path)
    if not path.is_absolute() or not path.resolve().is_relative_to(TEMP_ROOT):
        raise ValueError('Snapshot must be in a task-owned system temporary directory')
    # O_EXCL prevents clobbering an earlier recovery snapshot/symlink.
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, 'w') as output:
        json.dump(snapshot, output, sort_keys=True)


def connect():
    # Exact prescribed verifier. On sandbox failure caller must retry this exact
    # verifier system-level, never bypass it via global MCP/browser/another host.
    subprocess.run(['python3', 'scripts/verify.py'], cwd=N8N, check=True)
    config = runpy.run_path(str(N8N / 'scripts/verify.py'))['load_local_env']()
    if config.get('N8N_INSTANCE_LABEL') != 'MAM':
        raise SystemExit('MAM instance mismatch')

    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *_args, **_kwargs):
            return None

    def api(method, path, body=None):
        request = urllib.request.Request(config['N8N_BASE_URL'].rstrip('/') + '/api/v1/' + path,
            method=method, headers={'X-N8N-API-KEY': config['N8N_API_KEY'], 'Content-Type': 'application/json'},
            data=None if body is None else json.dumps(body).encode())
        with urllib.request.build_opener(NoRedirect).open(request, timeout=40) as response:
            return json.load(response)

    return api


def main():
    args = sys.argv[1:]
    if args == ['hash']:
        print(bundle_hash())
        return
    if not args or len(args) != {'inspect': 1, 'snapshot': 2, 'apply': 4, 'verify-snapshot': 4}.get(args[0]):
        raise SystemExit('Use hash | inspect | snapshot PATH | verify-snapshot PATH FILE-SHA PHASE | apply BUNDLE-SHA PATH FILE-SHA')
    if args[0] == 'apply' and args[1] != bundle_hash():
        raise SystemExit('Reviewed bundle differs')
    api = connect()
    alert = api('GET', 'workflows/' + ALERT)
    if alert.get('name') != 'MAM Booking Automation Error Alert - Internal' or not alert.get('active'):
        raise SystemExit('Existing sanitized error alert unavailable')
    if args[0] == 'snapshot':
        snapshot = freeze(api)
        write_snapshot(args[1], snapshot)
        print(json.dumps({'operation': 'snapshot', 'workflowId': WORKFLOW, 'count': len(snapshot['receipts']), 'nonterminalCount': 0, 'active': False,
                          'snapshotSha256': hashlib.sha256(Path(args[1]).read_bytes()).hexdigest()}))
    elif args[0] == 'verify-snapshot':
        print(json.dumps(verify_frozen_snapshot(read_snapshot(args[1], args[2]), args[3], api=api)))
    elif args[0] == 'apply':
        print(json.dumps(apply_paused(api, read_snapshot(args[2], args[3]), args[1])))
    else:
        live = api('GET', 'workflows/' + WORKFLOW)
        proposed = patch(live)
        print(json.dumps({'operation': 'inspect', 'workflowId': WORKFLOW, 'active': live['active'], 'versionId': live['versionId'],
            'legacyCount': len(minimal_receipts(live)), 'nonterminalCount': nonterminal_count(api), 'bundleSha256': bundle_hash(),
            'proposedNodesSha256': digest(proposed['nodes']), 'proposedConnectionsSha256': digest(proposed['connections'])}))


if __name__ == '__main__':
    try:
        main()
    except (urllib.error.URLError, subprocess.CalledProcessError):
        raise SystemExit('MAM provider verification/request unavailable; no automatic retry or activation')
