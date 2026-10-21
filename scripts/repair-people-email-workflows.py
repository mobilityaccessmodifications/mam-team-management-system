import copy
import hashlib
import json
from pathlib import Path
import runpy
import sys
import urllib.error
import urllib.request

N8N_ROOT = Path('/Volumes/UG/MAM/opencode/n8n')
ALERT_ID = 'UoQAe53Yu0fJ3ncq'
CHECK_IN_ID = 'bNyzWxzblY7VOSSk'
LEAVE_RECEIVER_ID = 'D6UG5ACZGILCpsOk'
ERROR_CALLER_IDS = (LEAVE_RECEIVER_ID, 'JIfKwVdB5moiMehH')
TARGETS = {
    ALERT_ID: ('MAM Booking Automation Error Alert - Internal', 'ea7c5dfc-c7a5-4068-82b5-9fa66d1df88f'),
    CHECK_IN_ID: ('MAM People Hub - Check-In Emails (Live)', '45e5cbf0-b267-4bdb-9ac3-7f1e0958a4ca'),
}
BCC_EXPRESSION = "={{ ($json.deliveryBcc || '').split(',').map(email => email.trim()).filter(Boolean) }}"


def patch(workflow):
    target = TARGETS.get(workflow.get('id'))
    if not target or workflow.get('name') != target[0] or not workflow.get('active'):
        raise ValueError('Workflow identity or active state mismatch')
    if workflow.get('versionId') != target[1] or workflow.get('activeVersionId') != target[1]:
        raise ValueError('Workflow changed since review')
    result = {key: copy.deepcopy(workflow[key]) for key in ['name', 'nodes', 'connections', 'settings']}
    if workflow['id'] == ALERT_ID:
        settings = result['settings']
        if settings.get('callerPolicy') != 'workflowsFromAList' or not isinstance(settings.get('callerIds'), str):
            raise ValueError('Alert caller policy mismatch')
        callers = settings['callerIds'].split(',')
        if '6X4YAXsgss59fsjg' not in callers or len(callers) != len(set(callers)) or any(not caller for caller in callers):
            raise ValueError('Alert caller list mismatch')
        for caller_id in ERROR_CALLER_IDS:
            if caller_id not in callers:
                settings['callerIds'] += ',' + caller_id
    else:
        senders = [node for node in result['nodes'] if node['type'] == 'n8n-nodes-base.microsoftOutlook']
        if len(senders) != 8:
            raise ValueError('Check-In sender count mismatch')
        for sender in senders:
            fields = sender['parameters'].get('additionalFields', {})
            credential = sender.get('credentials', {}).get('microsoftOutlookOAuth2Api', {})
            if sender['parameters'].get('operation') != 'send' or sender.get('typeVersion') != 2 \
                    or credential.get('id') != 'Ug5bTBjvF1vCSdhQ' \
                    or fields.get('bccRecipients') not in ['={{ $json.deliveryBcc }}', BCC_EXPRESSION]:
                raise ValueError('Check-In Outlook sender mismatch')
            fields['bccRecipients'] = BCC_EXPRESSION
    return result


def main():
    operation = sys.argv[1] if len(sys.argv) > 1 else ''
    digest = hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
    if operation not in ['inspect', 'apply']:
        raise SystemExit('Use inspect or apply <reviewed-sha256>')
    if operation == 'apply' and (len(sys.argv) != 3 or sys.argv[2] != digest):
        raise SystemExit('Reviewed workflow patch differs')
    verifier = runpy.run_path(str(N8N_ROOT / 'scripts/verify.py'))
    if verifier['main']() != 0:
        raise SystemExit('MAM n8n verification failed')
    config = verifier['load_local_env']()
    if config.get('N8N_INSTANCE_LABEL') != 'MAM':
        raise SystemExit('MAM instance mismatch')
    opener = urllib.request.build_opener(verifier['NoRedirect']())

    def api(method, path, body=None):
        request = urllib.request.Request(config['N8N_BASE_URL'].rstrip('/') + '/api/v1/' + path,
            method=method, headers={'X-N8N-API-KEY': config['N8N_API_KEY'], 'Content-Type': 'application/json'},
            data=None if body is None else json.dumps(body).encode())
        try:
            with opener.open(request, timeout=45) as response:
                return json.load(response)
        except urllib.error.HTTPError as error:
            raise SystemExit(f'n8n {method} failed: HTTP {error.code}') from None
        except urllib.error.URLError:
            raise SystemExit('n8n service unreachable') from None

    plans = []
    for workflow_id in TARGETS:
        live = api('GET', 'workflows/' + workflow_id)
        plans.append((workflow_id, live, patch(live)))
    for workflow_id, live, proposed in plans:
        if operation == 'apply':
            current = api('GET', 'workflows/' + workflow_id)
            if patch(current) != proposed:
                raise SystemExit('Workflow changed after preflight')
            api('PUT', 'workflows/' + workflow_id, proposed)
            api('POST', 'workflows/' + workflow_id + '/activate')
            saved = api('GET', 'workflows/' + workflow_id)
            if not saved.get('active') or saved.get('activeVersionId') != saved.get('versionId') \
                    or any(saved.get(key) != proposed[key] for key in proposed):
                raise SystemExit('Workflow read-back did not match')
        print(json.dumps({'workflowId': workflow_id, 'workflow': live['name'], 'operation': operation,
            'reviewedVersion': live['versionId'], 'changes': ['settings.callerIds'] if workflow_id == ALERT_ID
            else ['bccRecipients on 8 Outlook senders'], 'staticDataOmitted': True, 'scriptSha256': digest}))


if __name__ == '__main__':
    main()
