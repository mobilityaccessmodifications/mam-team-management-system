"""Patch only the verified MAM People Hub reminder workflows.

Run the n8n project's prescribed verifier first. inspect is read-only.
apply requires this reviewed script's SHA256. No credentials are exported.
"""
import copy
import hashlib
import json
from pathlib import Path
import runpy
import sys
import urllib.request

ROOT = Path('/Volumes/UG/MAM/opencode/n8n')
TARGETS = {
    'UAQJhQHRo882lHo5': ('MAM People System - Check-In Reminder Dispatcher', '*/15 8-16 * * *'),
    'zTY1Ro3jX3vShRra': ('MAM People System - Leave and Birthday Daily Reminders', '*/15 7-16 * * *'),
    'D6UG5ACZGILCpsOk': ('MAM People System - Leave Email Delivery', None),
}
CC_EXPRESSION = "={{ ($json.ccRecipients || '').split(',').map(email => email.trim()).filter(Boolean) }}"


def patch(workflow, expression):
    result = {key: copy.deepcopy(workflow[key]) for key in ['name', 'nodes', 'connections', 'settings']}
    if expression:
        triggers = [node for node in result['nodes'] if node['type'] == 'n8n-nodes-base.scheduleTrigger']
        if len(triggers) != 1:
            raise ValueError('Unexpected reminder trigger shape')
        triggers[0]['parameters'] = {'rule': {'interval': [{'field': 'cronExpression', 'expression': expression}]}}
    else:
        senders = [node for node in result['nodes'] if node['type'] == 'n8n-nodes-base.microsoftOutlook']
        if len(senders) != 1 or senders[0]['parameters'].get('operation') != 'send':
            raise ValueError('Unexpected email sender shape')
        # Outlook splits a blank string into one invalid address. An empty
        # array represents no CC and preserves manager-only reminder privacy.
        fields = senders[0]['parameters'].get('additionalFields')
        if not isinstance(fields, dict) or 'ccRecipients' not in fields:
            raise ValueError('Unexpected Outlook CC configuration')
        fields['ccRecipients'] = CC_EXPRESSION
    return result


def main():
    operation = sys.argv[1] if len(sys.argv) > 1 else ''
    if operation not in ['inspect', 'apply']:
        raise SystemExit('Use inspect or apply <reviewed-sha256>')
    if operation == 'apply' and (len(sys.argv) != 3 or hashlib.sha256(Path(__file__).read_bytes()).hexdigest() != sys.argv[2]):
        raise SystemExit('Reviewed workflow patch differs')
    verifier = runpy.run_path(str(ROOT / 'scripts/verify.py'))
    if verifier['main']() != 0:
        raise SystemExit('MAM n8n verification failed')
    config = verifier['load_local_env']()
    if config.get('N8N_INSTANCE_LABEL') != 'MAM':
        raise SystemExit('MAM instance mismatch')
    def api(method, path, body=None):
        request = urllib.request.Request(config['N8N_BASE_URL'].rstrip('/')+'/api/v1/'+path,
            method=method, headers={'X-N8N-API-KEY':config['N8N_API_KEY'], 'Content-Type':'application/json'},
            data=None if body is None else json.dumps(body).encode())
        with urllib.request.urlopen(request, timeout=40) as response:
            return json.load(response)
    for workflow_id, (name, expression) in TARGETS.items():
        live = api('GET', 'workflows/'+workflow_id)
        if live['name'] != name or not live.get('active'):
            raise SystemExit('Workflow target or active state mismatch')
        proposed = patch(live, expression)
        if operation == 'apply':
            # Preserve live staticData by omitting it from the update payload.
            # Do not overwrite concurrent delivery receipts with an old snapshot.
            api('PUT', 'workflows/'+workflow_id, proposed)
            api('POST', 'workflows/'+workflow_id+'/activate')
            saved = api('GET', 'workflows/'+workflow_id)
            if not saved.get('active') or any(saved[k] != proposed[k] for k in ['nodes','connections']):
                raise SystemExit('Workflow read-back did not match')
            old_receipts = (live.get('staticData') or {}).get('global', {}).get('leaveNotificationEvents', {})
            new_receipts = (saved.get('staticData') or {}).get('global', {}).get('leaveNotificationEvents', {})
            if any(key not in new_receipts for key in old_receipts):
                raise SystemExit('Delivery receipt preservation could not be verified')
        print(json.dumps({'workflow': name, 'operation':operation, 'schedule':expression, 'verified':True}))

if __name__ == '__main__':
    main()
