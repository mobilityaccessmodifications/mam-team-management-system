"""Publish the reviewed MAM validator/schedule; never execute a mail workflow.

Usage: python3 scripts/deploy-priority-n8n.py --n8n-root /approved/MAM/n8n receiver|scheduler
The existing MAM verification script must succeed before any API call.
"""
import argparse
import copy
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import urllib.request
import uuid

parser = argparse.ArgumentParser()
parser.add_argument('--n8n-root', type=Path, required=True)
parser.add_argument('operation', choices=['receiver', 'scheduler'])
args = parser.parse_args()
subprocess.run(['python3', 'scripts/verify.py'], cwd=args.n8n_root, check=True)
spec = importlib.util.spec_from_file_location('mam_verify', args.n8n_root / 'scripts/verify.py')
verify = importlib.util.module_from_spec(spec)
spec.loader.exec_module(verify)
config = verify.load_local_env()
assert config['N8N_INSTANCE_LABEL'] == 'MAM'
root = Path(__file__).resolve().parent.parent

def api(path, method='GET', body=None):
    request = urllib.request.Request(config['N8N_BASE_URL'].rstrip('/') + '/api/v1/' + path,
        headers={'X-N8N-API-KEY': config['N8N_API_KEY'], 'Content-Type': 'application/json'},
        method=method, data=None if body is None else json.dumps(body).encode())
    with urllib.request.urlopen(request, timeout=40) as response:
        return json.load(response)

def save_snapshot(workflow):
    with tempfile.NamedTemporaryFile(mode='w', prefix='mam-priority-n8n-backup-', suffix='.json', delete=False) as backup:
        json.dump(workflow, backup)
        print('Recovery snapshot:', backup.name)

def verify_scheduler(workflow):
    nodes = {n['name']:n for n in workflow['nodes']}
    call = nodes['Call MAM Leave and Birthday Dispatcher']
    wait = nodes['Wait 30 minutes before retry']
    retry = nodes['Retry MAM Leave and Birthday Dispatcher']
    assert workflow['active'] and workflow['settings']['executionTimeout'] == 3600
    assert workflow['settings']['timezone'] == 'Australia/Melbourne'
    assert call['onError'] == 'continueErrorOutput' and retry['onError'] == 'stopWorkflow'
    assert wait['type'] == 'n8n-nodes-base.wait' and wait['parameters'] == {'resume':'timeInterval','amount':30,'unit':'minutes'}
    assert retry['parameters']['url'] == call['parameters']['url'] == 'https://mam-team-management-system-ten.vercel.app/api/cron/leave-priority-reminders'
    assert workflow['connections'][call['name']]['main'][1] == [{'node':wait['name'],'type':'main','index':0}]
    assert workflow['connections'][wait['name']]['main'][0] == [{'node':retry['name'],'type':'main','index':0}]

if args.operation == 'receiver':
    workflow = api('workflows/D6UG5ACZGILCpsOk')
    assert workflow['name'] == 'MAM People System - Leave Email Delivery'
    save_snapshot(workflow)
    validator = next(n for n in workflow['nodes'] if n['name'] == 'Validate and Reserve Leave Notification')
    assert validator['type'] == 'n8n-nodes-base.code'
    assert "const HR = 'hr@mobilityaccess.com.au'" in validator['parameters']['jsCode']
    validator['parameters']['jsCode'] = (root / 'workflows/leave-notification-validator.n8n.txt').read_text()
    duplicate = next(n for n in workflow['nodes'] if n['name'] == 'Return Leave HR Duplicate')
    duplicate['parameters']['jsCode'] = "return [{ json: { ok: true, sent: false, alreadySent: true, actualRecipient: String($json.actualRecipient ?? $json.confirmationRecipient ?? ''), eventKey: String($json.eventKey ?? '') } }];"
    payload = {key: workflow[key] for key in ['name', 'nodes', 'connections', 'settings']}
    api('workflows/' + workflow['id'], 'PUT', payload)
    api('workflows/' + workflow['id'] + '/activate', 'POST', {})
    updated = api('workflows/' + workflow['id'])
    assert updated['active']
    assert next(n for n in updated['nodes'] if n['name'] == validator['name'])['parameters']['jsCode'] == validator['parameters']['jsCode']
    print('Verified active leave receiver:', updated['id'])
else:
    # A separate schedule prevents check-in failures from blocking this job.
    name = 'MAM People System - Leave and Birthday Daily Reminders'
    existing = []
    cursor = None
    while True:
        page = api('workflows?limit=100' + ('&cursor=' + cursor if cursor else ''))
        existing.extend(w for w in page['data'] if w['name'] == name)
        cursor = page.get('nextCursor')
        if not cursor: break
    if existing:
        assert len(existing) == 1 and existing[0]['active'], 'Review existing scheduler rather than overwrite it'
        workflow = api('workflows/' + existing[0]['id'])
        # Never silently bless or overwrite an older/custom scheduler.
        verify_scheduler(workflow)
        print('Existing active priority scheduler:', workflow['id'])
    else:
        template = api('workflows/UAQJhQHRo882lHo5')
        assert template['name'] == 'MAM People System - Check-In Reminder Dispatcher'
        trigger = copy.deepcopy(next(n for n in template['nodes'] if n['type'] == 'n8n-nodes-base.scheduleTrigger'))
        request = copy.deepcopy(next(n for n in template['nodes'] if n['name'] == 'Call MAM Check-In Dispatcher'))
        assert request['parameters']['url'] == 'https://mam-team-management-system-ten.vercel.app/api/cron/check-in-reminders'
        request['name'] = 'Call MAM Leave and Birthday Dispatcher'
        request['parameters']['url'] = request['parameters']['url'].replace('/check-in-reminders', '/leave-priority-reminders')
        request['parameters']['options']['timeout'] = 310000
        retry = copy.deepcopy(request)
        retry['id'] = str(uuid.uuid4())
        retry['name'] = 'Retry MAM Leave and Birthday Dispatcher'
        retry['onError'] = 'stopWorkflow'
        request['onError'] = 'continueErrorOutput'
        wait = {'id':str(uuid.uuid4()), 'name':'Wait 30 minutes before retry',
            'type':'n8n-nodes-base.wait', 'typeVersion':1.1,
            'position':[600,200], 'parameters':{'resume':'timeInterval','amount':30,'unit':'minutes'}}
        retry['position'] = [850,200]
        settings = copy.deepcopy(template['settings'])
        settings['executionTimeout'] = 3600
        assert settings['timezone'] == 'Australia/Melbourne'
        workflow = api('workflows', 'POST', {'name':name, 'nodes':[trigger,request,wait,retry],
            'connections':{
                trigger['name']:{'main':[[{'node':request['name'],'type':'main','index':0}]]},
                request['name']:{'main':[[],[{'node':wait['name'],'type':'main','index':0}]]},
                wait['name']:{'main':[[{'node':retry['name'],'type':'main','index':0}]]},
            }, 'settings':settings})
        api('workflows/' + workflow['id'] + '/activate', 'POST', {})
        verify_scheduler(api('workflows/' + workflow['id']))
        print('Verified active priority scheduler:', workflow['id'])
