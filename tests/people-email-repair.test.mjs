import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

test('pinned n8n repair changes only BCC expressions and missing configured error callers', () => {
  const result = spawnSync('python3', ['-c', `
import copy, runpy
m = runpy.run_path('scripts/repair-people-email-workflows.py')
for wid, (name, version) in m['TARGETS'].items():
    workflow = {'id':wid,'name':name,'versionId':version,'activeVersionId':version,'active':True,
        'nodes':[],'connections':{'reserved':{'main':[]}},
        'settings':{'callerPolicy':'workflowsFromAList','callerIds':'6X4YAXsgss59fsjg,synthetic',
            'saveDataSuccessExecution':'none','saveDataErrorExecution':'none'},
        'staticData':{'global':{'receipts':{'synthetic':{'state':'sent'}}}}}
    if wid == m['CHECK_IN_ID']:
        workflow['nodes'] = [{'id':str(i),'type':'n8n-nodes-base.microsoftOutlook','typeVersion':2,
            'parameters':{'operation':'send','toRecipients':'={{ $json.deliveryTo }}',
                'additionalFields':{'bccRecipients':'={{ $json.deliveryBcc }}','saveToSentItems':True}},
            'credentials':{'microsoftOutlookOAuth2Api':{'id':'Ug5bTBjvF1vCSdhQ'}}} for i in range(8)]
    original = copy.deepcopy(workflow)
    proposed = m['patch'](workflow)
    assert workflow == original
    assert set(proposed) == {'name','nodes','connections','settings'}
    expected = {key:copy.deepcopy(original[key]) for key in proposed}
    if wid == m['ALERT_ID']:
        expected['settings']['callerIds'] += ',' + ','.join(m['ERROR_CALLER_IDS'])
        assert proposed['nodes'] == original['nodes']
    else:
        for node in expected['nodes']:
            node['parameters']['additionalFields']['bccRecipients'] = m['BCC_EXPRESSION']
    assert proposed == expected
    for key, value in [('versionId','changed'),('activeVersionId','changed'),('name','wrong'),('active',False)]:
        changed = copy.deepcopy(workflow); changed[key] = value
        try: m['patch'](changed)
        except ValueError: pass
        else: raise AssertionError('Unexpected target accepted')
    if wid == m['ALERT_ID']:
        workflow['settings']['callerPolicy'] = 'any'
    else:
        workflow['nodes'][0]['credentials']['microsoftOutlookOAuth2Api']['id'] = 'wrong'
    try: m['patch'](workflow)
    except ValueError: pass
    else: raise AssertionError('Unsafe patch accepted')
`], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});
