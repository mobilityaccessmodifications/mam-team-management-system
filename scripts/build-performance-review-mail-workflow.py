import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SOURCES = ROOT / 'deploy/n8n/performance-review-mail-v1'
NAME = 'MAM People Hub - Performance Review Careers Mail (Live)'
HUB = 'https://mam-team-management-system-ten.vercel.app'
POST_PATH = 'mam-people-hub-performance-review-mail-v1'
READY_PATH = 'mam-people-hub-performance-review-mail-v1-ready'
PLACEHOLDER = {'id': '__PARENT_PERFORMANCE_HEADER_ID__', 'name': '__PARENT_PERFORMANCE_HEADER_NAME__'}


def node(name, kind, parameters, version=2.0, credentials=None):
    result = {'id': 'performance-' + name.lower().replace(' ', '-').replace('?', ''), 'name': name,
              'type': 'n8n-nodes-base.' + kind, 'typeVersion': version, 'position': [0, 0], 'retryOnFail': False, 'parameters': parameters}
    if credentials:
        result['credentials'] = credentials
    if kind == 'httpRequest':
        result['onError'] = 'continueRegularOutput'
    return result


def code(name, filename):
    texts = globals().get('_SOURCE_TEXTS')
    text = texts[filename] if texts is not None else (SOURCES / filename).read_text()
    return node(name, 'code', {'mode': 'runOnceForAllItems', 'jsCode': text})


def gate(name, field):
    return node(name, 'if', {'conditions': {'options': {'caseSensitive': True, 'typeValidation': 'strict', 'version': 2},
        'conditions': [{'id': field, 'leftValue': '={{ $json.' + field + ' }}', 'rightValue': True,
        'operator': {'type': 'boolean', 'operation': 'true', 'singleValue': True}}], 'combinator': 'and'}, 'options': {}}, 2.2)


def http(name, url, body, mail=False):
    parameters = {'method': 'POST', 'url': url, 'authentication': 'predefinedCredentialType' if mail else 'genericCredentialType',
        'sendBody': True, 'contentType': 'json', 'specifyBody': 'json', 'jsonBody': body,
        'options': {'timeout': 20000, 'redirect': {'redirect': {'followRedirects': False}},
        'response': {'response': {'fullResponse': True, 'neverError': True, 'responseFormat': 'text' if mail else 'json'}}}}
    if mail:
        parameters['options']['response']['response']['outputPropertyName'] = 'body'
        parameters['nodeCredentialType'] = 'microsoftOutlookOAuth2Api'
        credentials = {'microsoftOutlookOAuth2Api': {'id': 'UW7gUbruKT6NzniR', 'name': 'Microsoft Outlook - careers@mobilityaccess.com.au'}}
    else:
        parameters['genericAuthType'] = 'httpHeaderAuth'
        credentials = {'httpHeaderAuth': PLACEHOLDER.copy()}
    return node(name, 'httpRequest', parameters, 4.2, credentials)


def edge(target):
    return [{'node': target, 'type': 'main', 'index': 0}]


def build_workflow():
    nodes = [{
        'id': 'performance-receive', 'name': 'Receive Finalisation',
        'type': 'n8n-nodes-base.webhook', 'typeVersion': 2.1,
        'position': [0, 0], 'webhookId': '720f0100-0000-4000-8000-000000000001',
        'retryOnFail': False,
        'parameters': {'httpMethod': 'POST', 'path': POST_PATH, 'authentication': 'headerAuth', 'responseMode': 'lastNode', 'options': {}},
        'credentials': {'httpHeaderAuth': PLACEHOLDER.copy()},
    }]
    nodes.extend([code('Validate Payload', 'validate-payload.js'), gate('Valid Payload?', 'valid'),
        http('Begin Delivery', HUB + '/api/performance-reviews/mail', '={{ $json.beginBody }}'),
        code('Gate Begin', 'gate-begin.js'), gate('Permit Send?', 'allowed'),
        http('Send Word to Manager', 'https://graph.microsoft.com/v1.0/me/sendMail', "={{ $('Validate Payload').first().json.graphBody }}", mail=True),
        code('Return Held', 'return-held.js'), code('Classify Send', 'classify-send.js'),
        http('Finish Delivery', HUB + '/api/performance-reviews/mail', '={{ $json.finishBody }}'),
        code('Validate Finish', 'validate-finish.js')])
    connections = {
        'Receive Finalisation': {'main': [edge('Validate Payload')]},
        'Validate Payload': {'main': [edge('Valid Payload?')]},
        'Valid Payload?': {'main': [edge('Begin Delivery'), edge('Return Held')]},
        'Begin Delivery': {'main': [edge('Gate Begin')]},
        'Gate Begin': {'main': [edge('Permit Send?')]},
        'Permit Send?': {'main': [edge('Send Word to Manager'), edge('Return Held')]},
        'Send Word to Manager': {'main': [edge('Classify Send')]},
        'Classify Send': {'main': [edge('Finish Delivery')]},
        'Finish Delivery': {'main': [edge('Validate Finish')]},
    }
    ready_trigger = node('Receive Readiness', 'webhook', {'httpMethod': 'GET', 'path': READY_PATH, 'authentication': 'headerAuth', 'responseMode': 'lastNode', 'options': {}}, 2.1, {'httpHeaderAuth': PLACEHOLDER.copy()})
    ready_trigger['webhookId'] = '720f0100-0000-4000-8000-000000000002'
    ready_http = http('Hub Readiness', HUB + '/api/performance-reviews/mail', '={{ {phase: "readiness"} }}')
    ready_http['parameters']['options']['timeout'] = 5000
    dispatch = http('Dispatch New Performance Queue', HUB + '/api/performance-reviews/mail', None)
    dispatch['parameters']['method'] = 'GET'
    for key in ('sendBody', 'contentType', 'specifyBody', 'jsonBody'):
        dispatch['parameters'].pop(key)
    dispatch['credentials'] = {'httpHeaderAuth': {'id': '__PARENT_CRON_ID__', 'name': '__PARENT_CRON_NAME__'}}
    nodes.extend([ready_trigger, ready_http, code('Return Readiness', 'validate-readiness.js'),
        node('Every Five Minutes', 'scheduleTrigger', {'rule': {'interval': [{'field': 'minutes', 'minutesInterval': 5}]}}, 1.2), dispatch])
    connections.update({'Receive Readiness': {'main': [edge('Hub Readiness')]}, 'Hub Readiness': {'main': [edge('Return Readiness')]},
                        'Every Five Minutes': {'main': [edge('Dispatch New Performance Queue')]}})
    for index, value in enumerate(nodes):
        value['position'] = [index * 220, 0]
    return {'name': NAME, 'nodes': nodes, 'connections': connections, 'settings': {
        'executionOrder': 'v1', 'timezone': 'Australia/Melbourne',
        'saveDataSuccessExecution': 'none', 'saveDataErrorExecution': 'none',
        'saveManualExecutions': False, 'saveExecutionProgress': False,
    }}


def main():
    json.dump(build_workflow(), sys.stdout, ensure_ascii=False)
    sys.stdout.write('\n')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
