import copy
import hashlib
import json
from pathlib import Path
import runpy
import sys
import urllib.request


N8N_ROOT = Path('/Volumes/UG/MAM/opencode/n8n')
WORKFLOW_ID = 'UAQJhQHRo882lHo5'
WORKFLOW_NAME = 'MAM People System - Check-In Reminder Dispatcher'
ORIGIN = 'https://mam-team-management-system-ten.vercel.app'
CHECK_IN_PATH = '/api/cron/check-in-reminders'
DAY_ONE_PATH = '/api/cron/new-starter-day-one'
DAY_ONE_TRIGGER_ID = 'ef769181-fdd4-4ba8-92b8-dad5e96fe0cc'
DAY_ONE_TRIGGER_NAME = 'Every 15 minutes for Day 1'
DAY_ONE_NODE_ID = 'bb7b2685-d2a4-4236-8f10-a6b21cadb96e'
DAY_ONE_NODE_NAME = 'Call MAM Day 1 Dispatcher'
QUARTER_HOURLY = [{'field': 'cronExpression', 'expression': '*/15 8-16 * * *'}]
LEGACY_DAILY = [{'field': 'cronExpression', 'expression': '0 8 * * *'}]


def require(condition, message):
    if not condition:
        raise SystemExit(message)


def proposed_workflow(live):
    require(live.get('id') == WORKFLOW_ID and live.get('name') == WORKFLOW_NAME
            and live.get('active') is True, 'Unexpected MAM scheduler target')
    nodes = live.get('nodes') or []
    require(len(nodes) in (2, 4), 'Unexpected MAM scheduler node count')
    trigger = next((node for node in nodes if node.get('name') == 'Every day at 08:00'
                    and node.get('type') == 'n8n-nodes-base.scheduleTrigger'), None)
    original = next((node for node in nodes if node.get('name') == 'Call MAM Check-In Dispatcher'), None)
    require(trigger and original and original.get('type') == 'n8n-nodes-base.httpRequest'
            and original.get('parameters', {}).get('method') == 'GET'
            and original.get('parameters', {}).get('url') == ORIGIN + CHECK_IN_PATH
            and original.get('parameters', {}).get('authentication') == 'genericCredentialType'
            and original.get('parameters', {}).get('genericAuthType') == 'httpHeaderAuth'
            and original.get('credentials', {}).get('httpHeaderAuth', {}).get('id') == 'Fa0hGUfG9sTqnZXP',
            'Unexpected MAM Check-In dispatcher authentication')
    require(trigger.get('parameters', {}).get('rule', {}).get('interval') in (QUARTER_HOURLY, LEGACY_DAILY)
            and live.get('settings', {}).get('timezone') == 'Australia/Melbourne',
            'Unexpected MAM scheduler timing')
    target = copy.deepcopy(live['connections'].get(trigger['name'], {}).get('main'))
    require(target == [[{'node': original['name'], 'type': 'main', 'index': 0}]],
            'Unexpected MAM scheduler wiring')

    result = {key: copy.deepcopy(live[key]) for key in ('name', 'nodes', 'connections', 'settings')}
    if len(nodes) == 2:
        day_one_trigger = copy.deepcopy(trigger)
        day_one_trigger['id'] = DAY_ONE_TRIGGER_ID
        day_one_trigger['name'] = DAY_ONE_TRIGGER_NAME
        day_one_trigger['position'] = [trigger['position'][0], trigger['position'][1] + 200]
        day_one_trigger['parameters']['rule']['interval'] = copy.deepcopy(QUARTER_HOURLY)
        result_trigger = next(node for node in result['nodes'] if node['name'] == trigger['name'])
        result_trigger['parameters']['rule']['interval'] = copy.deepcopy(QUARTER_HOURLY)
        day_one = copy.deepcopy(original)
        day_one['id'] = DAY_ONE_NODE_ID
        day_one['name'] = DAY_ONE_NODE_NAME
        day_one['position'] = [original['position'][0], original['position'][1] + 200]
        day_one['parameters']['url'] = ORIGIN + DAY_ONE_PATH
        result['nodes'].extend((day_one_trigger, day_one))
        result['connections'][DAY_ONE_TRIGGER_NAME] = {'main': [[
            {'node': DAY_ONE_NODE_NAME, 'type': 'main', 'index': 0},
        ]]}
    else:
        day_one_trigger = next((node for node in nodes if node.get('id') == DAY_ONE_TRIGGER_ID
                                and node.get('name') == DAY_ONE_TRIGGER_NAME), None)
        day_one = next((node for node in nodes if node.get('id') == DAY_ONE_NODE_ID
                        and node.get('name') == DAY_ONE_NODE_NAME), None)
        require(day_one_trigger and day_one_trigger.get('type') == 'n8n-nodes-base.scheduleTrigger'
                and day_one_trigger.get('parameters') == trigger.get('parameters')
                and trigger.get('parameters', {}).get('rule', {}).get('interval') == QUARTER_HOURLY
                and live['connections'].get(DAY_ONE_TRIGGER_NAME) == {'main': [[
                    {'node': DAY_ONE_NODE_NAME, 'type': 'main', 'index': 0},
                ]]}
                and day_one and day_one.get('parameters', {}).get('url') == ORIGIN + DAY_ONE_PATH
                and day_one.get('credentials') == original.get('credentials')
                and day_one.get('parameters', {}).get('method') == 'GET',
                'Unexpected MAM Day 1 dispatcher wiring')
    return result


def main():
    operation = sys.argv[1] if len(sys.argv) > 1 else ''
    require(operation in ('inspect', 'apply'), 'Use inspect or apply <reviewed-sha256>')
    if operation == 'apply':
        require(len(sys.argv) == 3 and hashlib.sha256(Path(__file__).read_bytes()).hexdigest() == sys.argv[2],
                'Reviewed scheduler patch differs')
    verifier = runpy.run_path(str(N8N_ROOT / 'scripts/verify.py'))
    require(verifier['main']() == 0, 'MAM n8n verification failed')
    config = verifier['load_local_env']()
    require(config.get('N8N_INSTANCE_LABEL') == 'MAM', 'MAM instance mismatch')

    def api(method, path, body=None):
        request = urllib.request.Request(config['N8N_BASE_URL'].rstrip('/') + '/api/v1/' + path,
            method=method, headers={'X-N8N-API-KEY': config['N8N_API_KEY'],
                                    'Content-Type': 'application/json'},
            data=None if body is None else json.dumps(body).encode())
        with urllib.request.urlopen(request, timeout=40) as response:
            return json.load(response)

    live = api('GET', 'workflows/' + WORKFLOW_ID)
    proposed = proposed_workflow(live)
    if operation == 'apply' and len(live['nodes']) == 2:
        api('PUT', 'workflows/' + WORKFLOW_ID, proposed)
        api('POST', 'workflows/' + WORKFLOW_ID + '/activate')
        live = api('GET', 'workflows/' + WORKFLOW_ID)
        require(live.get('active') is True and all(live.get(key) == proposed[key]
                for key in ('nodes', 'connections')), 'MAM scheduler read-back differs')
    print(json.dumps({'workflowId': WORKFLOW_ID, 'active': live['active'],
                      'dayOneScheduled': len(live['nodes']) == 4,
                      'checkInScheduled': True}))


if __name__ == '__main__':
    main()
