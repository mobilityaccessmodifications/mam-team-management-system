import json
import runpy
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PATH = 'mam-people-hub-employee-lifecycle-v1'


def build_workflow():
    source = runpy.run_path(str(ROOT / 'scripts/build-performance-review-notifications-workflow.py'))
    workflow = source['build_workflow']()
    workflow['settings']['executionTimeout'] = 60
    workflow['name'] = 'MAM People Hub - Onboarding and Offboarding Checklists (Live)'
    names = {'Receive Performance Notification': 'Receive Lifecycle Notification',
             'Send Performance Notification': 'Send Lifecycle Notification',
             'Every Five Minutes': 'Every Minute',
             'Dispatch Performance Notifications': 'Dispatch Lifecycle Notifications'}
    signature = (ROOT / 'scripts/hr-email-signature.mjs').read_text().replace('export const ', 'const ')
    template = (ROOT / 'scripts/employee-lifecycle-email.mjs').read_text()
    template = template.replace("import { HR_EMAIL_SIGNATURE_HTML } from './hr-email-signature.mjs';", '')
    template = template.replace('export const ', 'const ').replace('export function ', 'function ')
    validator = (ROOT / 'deploy/n8n/employee-lifecycle-v1/validate-payload.js').read_text()
    for node in workflow['nodes']:
        node['id'] = node['id'].replace('performance-notification-', 'lifecycle-notification-')
        node['name'] = names.get(node['name'], node['name'])
        parameters = node['parameters']
        if node['type'] == 'n8n-nodes-base.webhook':
            ready = parameters['httpMethod'] == 'GET'
            parameters['path'] = PATH + ('-ready' if ready else '')
            node['webhookId'] = '730f0200-0000-4000-8000-' + ('000000000002' if ready else '000000000001')
        if node['name'] == 'Validate Notification Payload':
            parameters['jsCode'] = signature + '\n' + template + '\n' + validator
        if node['name'] == 'Send Lifecycle Notification':
            node['credentials']['microsoftOutlookOAuth2Api'] = {'id':'Ug5bTBjvF1vCSdhQ','name':'Microsoft Outlook - ai@mobilityaccess.com.au'}
        if node['name'] == 'Every Minute':
            parameters['rule'] = {'interval':[{'field':'cronExpression','expression':'0 * * * * *'}]}
        if node['name'] == 'Dispatch Lifecycle Notifications':
            parameters['url'] = source['HUB'] + '/api/cron/employee-lifecycle'
            parameters['options']['timeout'] = 55000
    workflow['connections'] = {names.get(k,k):{'main':[[{**edge,'node':names.get(edge['node'],edge['node'])} for edge in output] for output in v['main']]} for k,v in workflow['connections'].items()}
    identity = source['http']('Verify Lifecycle Sender', 'https://graph.microsoft.com/v1.0/me?$select=mail,userPrincipalName', mail=True)
    identity['credentials']['microsoftOutlookOAuth2Api'] = {'id':'Ug5bTBjvF1vCSdhQ','name':'Microsoft Outlook - ai@mobilityaccess.com.au'}
    identity['parameters']['options']['response']['response']['responseFormat'] = 'json'
    workflow['nodes'].append(identity)
    workflow['connections']['Check Notification Receipt Readiness'] = {'main':[[{'node':'Verify Lifecycle Sender','type':'main','index':0}]]}
    workflow['connections']['Verify Lifecycle Sender'] = {'main':[[{'node':'Return Notification Readiness','type':'main','index':0}]]}
    ready = next(n for n in workflow['nodes'] if n['name']=='Return Notification Readiness')
    ready['parameters']['jsCode'] = "const r=$('Check Notification Receipt Readiness').first().json; const b=$json.body; const ready=r.statusCode===200 && r.body?.version===1 && r.body?.ready===true && $json.statusCode===200 && [b?.mail,b?.userPrincipalName].some(v=>typeof v==='string' && v.toLowerCase()==='ai@mobilityaccess.com.au'); return [{json:{ok:ready,ready,sender:ready?'ai@mobilityaccess.com.au':null}}];"
    dispatch_check = source['node']('Validate Lifecycle Dispatch', 'code', {'mode':'runOnceForAllItems', 'jsCode':"if ($json.statusCode !== 200 || $json.body?.ok !== true || $json.body?.code !== 'processed') throw new Error('Lifecycle dispatcher requires attention'); return [{json:{ok:true}}];"})
    workflow['nodes'].append(dispatch_check)
    workflow['connections']['Dispatch Lifecycle Notifications'] = {'main':[[{'node':'Validate Lifecycle Dispatch','type':'main','index':0}]]}
    return workflow


if __name__ == '__main__':
    print(json.dumps(build_workflow(), ensure_ascii=False))
