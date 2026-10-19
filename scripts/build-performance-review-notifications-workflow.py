import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SOURCES = ROOT / 'deploy/n8n/performance-review-notifications-v1'
HUB = 'https://mam-team-management-system-ten.vercel.app'
RECEIPTS = HUB + '/api/internal/integrations/notifications/receipts'
POST_PATH = 'mam-people-hub-performance-review-notifications-v1'
HEADER = {'id': 'tGtpwegru8OxtdCt', 'name': 'MAM Team Management - Notification Webhook Header'}
OUTLOOK = {'id': 'Ug5bTBjvF1vCSdhQ', 'name': 'Microsoft Outlook - ai@mobilityaccess.com.au'}
CRON = {'id': 'Fa0hGUfG9sTqnZXP', 'name': 'MAM People System - Check-In Reminder Cron Bearer v2'}


def node(name, kind, parameters, version=2, credentials=None):
    result = {'id': 'performance-notification-' + name.lower().replace(' ', '-').replace('?', ''),
              'name': name, 'type': 'n8n-nodes-base.' + kind, 'typeVersion': version,
              'position': [0, 0], 'retryOnFail': False, 'parameters': parameters}
    if credentials:
        result['credentials'] = credentials
    return result


def code(name, filename):
    return node(name, 'code', {'mode': 'runOnceForAllItems', 'jsCode': (SOURCES / filename).read_text()})


def gate(name, field):
    return node(name, 'if', {'conditions': {
        'options': {'caseSensitive': True, 'typeValidation': 'strict', 'version': 2},
        'conditions': [{'id': field, 'leftValue': '={{ $json.' + field + ' }}', 'rightValue': True,
                        'operator': {'type': 'boolean', 'operation': 'true', 'singleValue': True}}],
        'combinator': 'and'}, 'options': {}}, 2.2)


def http(name, url, body=None, mail=False, timeout=5000, credential=None):
    parameters = {'method': 'POST' if body is not None else 'GET', 'url': url,
                  'authentication': 'predefinedCredentialType' if mail else 'genericCredentialType',
                  'options': {'timeout': timeout, 'redirect': {'redirect': {'followRedirects': False}},
                              'response': {'response': {'fullResponse': True, 'neverError': True,
                                                        'responseFormat': 'text' if mail else 'json'}}}}
    if body is not None:
        parameters.update({'sendBody': True, 'contentType': 'json', 'specifyBody': 'json', 'jsonBody': body})
    if mail:
        parameters['nodeCredentialType'] = 'microsoftOutlookOAuth2Api'
        parameters['options']['response']['response']['outputPropertyName'] = 'body'
        credentials = {'microsoftOutlookOAuth2Api': OUTLOOK.copy()}
    else:
        parameters['genericAuthType'] = 'httpHeaderAuth'
        credentials = {'httpHeaderAuth': (credential or HEADER).copy()}
    result = node(name, 'httpRequest', parameters, 4.2, credentials)
    result['onError'] = 'continueRegularOutput'
    return result


def webhook(name, method, path, identifier):
    result = node(name, 'webhook', {'httpMethod': method, 'path': path, 'authentication': 'headerAuth',
                                   'responseMode': 'lastNode', 'options': {}}, 2.1,
                  {'httpHeaderAuth': HEADER.copy()})
    result['webhookId'] = identifier
    return result


def build_workflow():
    nodes = [
        webhook('Receive Performance Notification', 'POST', POST_PATH, '720f0200-0000-4000-8000-000000000001'),
        code('Validate Notification Payload', 'validate-payload.js'),
        gate('Valid Notification Payload?', 'valid'),
        http('Reserve Notification Delivery', RECEIPTS, '={{ $json.reserveBody }}'),
        code('Gate Notification Reservation', 'gate-reservation.js'),
        gate('Send Notification?', 'allowed'),
        http('Send Performance Notification', 'https://graph.microsoft.com/v1.0/me/sendMail',
             "={{ $('Validate Notification Payload').first().json.graphBody }}", mail=True, timeout=15000),
        code('Classify Notification Send', 'classify-send.js'),
        gate('Notification Accepted?', 'accepted'),
        http('Confirm Notification Delivery', RECEIPTS, '={{ $json.confirmBody }}'),
        code('Validate Notification Confirmation', 'validate-confirmation.js'),
        node('Return Notification Reservation', 'code', {'mode': 'runOnceForAllItems',
                                                        'jsCode': 'return [{json: $json.response}];'}),
        node('Return Notification Held', 'code', {'mode': 'runOnceForAllItems',
                                                'jsCode': 'return [{json: {ok: false, sent: false, alreadySent: false}}];'}),
        webhook('Receive Notification Readiness', 'GET', POST_PATH + '-ready', '720f0200-0000-4000-8000-000000000002'),
        http('Check Notification Receipt Readiness', RECEIPTS),
        code('Return Notification Readiness', 'validate-readiness.js'),
        node('Every Five Minutes', 'scheduleTrigger', {'rule': {'interval': [{'field': 'minutes', 'minutesInterval': 5}]}}, 1.2),
        http('Dispatch Performance Notifications', HUB + '/api/performance-reviews/mail?notifications=1',
             timeout=25000, credential=CRON),
    ]
    connections = {}

    def connect(source, *targets):
        connections[source] = {'main': [[{'node': target, 'type': 'main', 'index': 0}] for target in targets]}

    connect('Receive Performance Notification', 'Validate Notification Payload')
    connect('Validate Notification Payload', 'Valid Notification Payload?')
    connect('Valid Notification Payload?', 'Reserve Notification Delivery', 'Return Notification Held')
    connect('Reserve Notification Delivery', 'Gate Notification Reservation')
    connect('Gate Notification Reservation', 'Send Notification?')
    connect('Send Notification?', 'Send Performance Notification', 'Return Notification Reservation')
    connect('Send Performance Notification', 'Classify Notification Send')
    connect('Classify Notification Send', 'Notification Accepted?')
    connect('Notification Accepted?', 'Confirm Notification Delivery', 'Return Notification Held')
    connect('Confirm Notification Delivery', 'Validate Notification Confirmation')
    connect('Receive Notification Readiness', 'Check Notification Receipt Readiness')
    connect('Check Notification Receipt Readiness', 'Return Notification Readiness')
    connect('Every Five Minutes', 'Dispatch Performance Notifications')
    for index, value in enumerate(nodes):
        value['position'] = [index * 220, 0]
    return {'name': 'MAM People Hub - Performance Review Notifications (Live)', 'nodes': nodes,
            'connections': connections, 'settings': {
                'executionOrder': 'v1', 'timezone': 'Australia/Melbourne',
                'saveDataSuccessExecution': 'none', 'saveDataErrorExecution': 'none',
                'saveManualExecutions': False, 'saveExecutionProgress': False, 'executionTimeout': 30}}


if __name__ == '__main__':
    json.dump(build_workflow(), sys.stdout, ensure_ascii=False)
    sys.stdout.write('\n')
