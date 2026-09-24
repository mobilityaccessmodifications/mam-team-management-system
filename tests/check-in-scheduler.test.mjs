import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

test('the MAM scheduler keeps both dispatchers independent and upgrades the known daily schedule', () => {
  const result = execFileSync('python3', ['-B', '-c', String.raw`
import copy, json, runpy
m = runpy.run_path('scripts/deploy-check-in-scheduler.py')
trigger = {'id': 'original-trigger', 'name': 'Every day at 08:00',
           'type': 'n8n-nodes-base.scheduleTrigger', 'position': [0, 0],
           'parameters': {'rule': {'interval': m['LEGACY_DAILY']}}}
request = {'id': 'original-request', 'name': 'Call MAM Check-In Dispatcher',
           'type': 'n8n-nodes-base.httpRequest', 'position': [200, 0],
           'parameters': {'method': 'GET', 'url': m['ORIGIN'] + m['CHECK_IN_PATH'],
                          'authentication': 'genericCredentialType', 'genericAuthType': 'httpHeaderAuth'},
           'credentials': {'httpHeaderAuth': {'id': 'Fa0hGUfG9sTqnZXP', 'name': 'MAM cron'}}}
workflow = {'id': m['WORKFLOW_ID'], 'name': m['WORKFLOW_NAME'], 'active': True,
            'nodes': [trigger, request], 'settings': {'timezone': 'Australia/Melbourne'},
            'connections': {trigger['name']: {'main': [[{'node': request['name'], 'type': 'main', 'index': 0}]]}}}
updated = m['proposed_workflow'](workflow)
assert workflow['nodes'][0]['parameters']['rule']['interval'] == m['LEGACY_DAILY']
assert len(updated['nodes']) == 4
assert updated['nodes'][0]['parameters']['rule']['interval'] == m['QUARTER_HOURLY']
assert updated['nodes'][2]['parameters']['rule']['interval'] == m['QUARTER_HOURLY']
assert updated['nodes'][3]['parameters']['url'] == m['ORIGIN'] + m['DAY_ONE_PATH']
assert updated['nodes'][3]['credentials'] == request['credentials']
assert m['proposed_workflow']({**workflow, 'nodes': updated['nodes'],
                               'connections': updated['connections']}) == updated
print('passed')
`], { encoding: 'utf8' });
  assert.equal(result.trim(), 'passed');
});
