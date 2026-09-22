"""Publish only the reviewed leave receiver and its existing sanitized alert link.

Run inspect first; apply takes the SHA256 of this script plus both code files.
Never execute a mail webhook, export payloads, or replace static delivery receipts.
"""
import copy
import hashlib
import json
from pathlib import Path
import runpy
import sys
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
N8N = Path('/Volumes/UG/MAM/opencode/n8n')
WORKFLOW = 'D6UG5ACZGILCpsOk'
ALERT = 'UoQAe53Yu0fJ3ncq'
FILES = {
    'Validate and Reserve Leave Notification': ('leave-notification-validator.n8n.txt', '361fe9b9d0235cff45ea6db0f12d8eb75722f92132230825c64353e38e7d4ae9'),
    'Confirm Leave HR Delivery': ('leave-notification-confirmation.n8n.txt', 'b8c536c8188ffaee49822c49a69532ad8dd872a56bf58c5e2666642ef638ed2e'),
}


def bundle_hash():
    parts = [Path(__file__).read_bytes()]
    parts.extend((ROOT / 'workflows' / filename).read_bytes() for filename, _ in FILES.values())
    return hashlib.sha256(b'\0'.join(parts)).hexdigest()


def patch(live):
    if live.get('name') != 'MAM People System - Leave Email Delivery' or not live.get('active'):
        raise ValueError('Unexpected leave receiver identity or inactive state')
    result = {key: copy.deepcopy(live[key]) for key in ['name', 'nodes', 'connections', 'settings']}
    for name, (filename, baseline) in FILES.items():
        matches = [node for node in result['nodes'] if node['name'] == name]
        if len(matches) != 1 or matches[0]['type'] != 'n8n-nodes-base.code':
            raise ValueError('Receiver code node changed')
        node = matches[0]
        desired = (ROOT / 'workflows' / filename).read_text()
        actual = node['parameters']['jsCode']
        if actual != desired and hashlib.sha256(actual.encode()).hexdigest() != baseline:
            raise ValueError('Live code changed since review; inspect before replacing')
        node['parameters']['jsCode'] = desired
    if result['settings'].get('errorWorkflow') not in [None, ALERT]:
        raise ValueError('Existing error workflow differs')
    result['settings']['errorWorkflow'] = ALERT
    # Full execution data includes HR payloads; keep the minimisation boundary.
    if any(result['settings'].get(k) != 'none' for k in ['saveDataSuccessExecution', 'saveDataErrorExecution']):
        raise ValueError('Execution retention settings changed')
    return result


def main():
    operation = sys.argv[1] if len(sys.argv) > 1 else ''
    if operation == 'hash':
        print(bundle_hash())
        return
    if operation not in ['inspect', 'apply']:
        raise SystemExit('Use hash, inspect, or apply <reviewed-bundle-sha256>')
    if operation == 'apply' and (len(sys.argv) != 3 or sys.argv[2] != bundle_hash()):
        raise SystemExit('Reviewed bundle differs')
    verifier = runpy.run_path(str(N8N / 'scripts/verify.py'))
    if verifier['main']() != 0:
        raise SystemExit('MAM n8n verification failed')
    config = verifier['load_local_env']()
    if config.get('N8N_INSTANCE_LABEL') != 'MAM':
        raise SystemExit('MAM instance mismatch')

    def api(method, path, body=None):
        request = urllib.request.Request(config['N8N_BASE_URL'].rstrip('/') + '/api/v1/' + path,
            method=method, headers={'X-N8N-API-KEY': config['N8N_API_KEY'], 'Content-Type': 'application/json'},
            data=None if body is None else json.dumps(body).encode())
        with urllib.request.urlopen(request, timeout=40) as response:
            return json.load(response)

    alert = api('GET', 'workflows/' + ALERT)
    if alert.get('name') != 'MAM Booking Automation Error Alert - Internal' or not alert.get('active'):
        raise SystemExit('Existing sanitized error alert unavailable')
    live = api('GET', 'workflows/' + WORKFLOW)
    proposed = patch(live)
    if operation == 'apply':
        current = api('GET', 'workflows/' + WORKFLOW)
        if current.get('versionId') != live.get('versionId'):
            raise SystemExit('Concurrent workflow edit; inspect again')
        # Omit staticData: never overwrite a concurrent delivery receipt.
        api('PUT', 'workflows/' + WORKFLOW, proposed)
        api('POST', 'workflows/' + WORKFLOW + '/activate')
        saved = api('GET', 'workflows/' + WORKFLOW)
        if not saved.get('active') or any(saved[k] != proposed[k] for k in ['nodes', 'connections', 'settings']):
            raise SystemExit('Active receiver read-back mismatch')
        before = (current.get('staticData') or {}).get('global', {}).get('leaveNotificationEvents', {})
        after = (saved.get('staticData') or {}).get('global', {}).get('leaveNotificationEvents', {})
        if any(key not in after for key in before):
            raise SystemExit('Receipt preservation could not be verified')
    print(json.dumps({'operation': operation, 'workflowId': WORKFLOW, 'verified': True, 'bundleSha256': bundle_hash()}))


if __name__ == '__main__':
    main()
