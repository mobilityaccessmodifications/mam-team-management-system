import json
import sys
from pathlib import Path
from urllib.parse import quote

ROOT = Path(__file__).resolve().parents[1]
SOURCES = ROOT / 'deploy/n8n/performance-review-meeting-v1'
HUB = 'https://mam-team-management-system-ten.vercel.app/api/performance-reviews/meeting'
OUTLOOK = {'id': 'Ug5bTBjvF1vCSdhQ', 'name': 'Microsoft Outlook - ai@mobilityaccess.com.au'}
CRON = {'id': 'Fa0hGUfG9sTqnZXP', 'name': 'MAM People System - Check-In Reminder Cron Bearer v2'}
READINESS = {'id': 'tGtpwegru8OxtdCt', 'name': 'MAM Team Management - Notification Webhook Header'}
FIELDS = 'id,subject,type,isOrganizer,organizer,attendees,start,end,isCancelled,isAllDay,isDraft,isOnlineMeeting,onlineMeeting,onlineMeetingProvider,location,iCalUId,lastModifiedDateTime,createdDateTime,recurrence'


def node(name, kind, parameters, version=2, credentials=None):
    result = {'id': 'performance-meeting-' + name.lower().replace(' ', '-').replace('?', ''),
              'name': name, 'type': 'n8n-nodes-base.' + kind, 'typeVersion': version,
              'position': [0, 0], 'retryOnFail': False, 'parameters': parameters}
    if credentials:
        result['credentials'] = credentials
    return result


def code(name, filename, each=False):
    return node(name, 'code', {'mode': 'runOnceForEachItem' if each else 'runOnceForAllItems',
                              'jsCode': (SOURCES / filename).read_text()})


def gate(name, field):
    return node(name, 'if', {'conditions': {
        'options': {'caseSensitive': True, 'typeValidation': 'strict', 'version': 2},
        'conditions': [{'id': field, 'leftValue': '={{ $json.' + field + ' }}', 'rightValue': True,
                        'operator': {'type': 'boolean', 'operation': 'true', 'singleValue': True}}],
        'combinator': 'and'}, 'options': {}}, 2.2)


def http(name, url, graph=False, body=None):
    parameters = {'method': 'POST' if body else 'GET', 'url': url,
                  'authentication': 'predefinedCredentialType' if graph else 'genericCredentialType',
                  'options': {'timeout': 5000, 'redirect': {'redirect': {'followRedirects': False}},
                              'response': {'response': {'fullResponse': True, 'neverError': True,
                                                        'responseFormat': 'json'}}}}
    if body:
        parameters.update({'sendBody': True, 'contentType': 'json', 'specifyBody': 'json', 'jsonBody': body})
    if graph:
        parameters.update({'nodeCredentialType': 'microsoftOutlookOAuth2Api', 'sendHeaders': True,
                           'headerParameters': {'parameters': [
                               {'name': 'Prefer', 'value': 'IdType="ImmutableId", outlook.timezone="UTC"'}]}})
        credentials = {'microsoftOutlookOAuth2Api': OUTLOOK.copy()}
    else:
        parameters['genericAuthType'] = 'httpHeaderAuth'
        credentials = {'httpHeaderAuth': CRON.copy()}
    result = node(name, 'httpRequest', parameters, 4.2, credentials)
    result['onError'] = 'continueRegularOutput'
    return result


def calendar(name, url, initial):
    result = http(name, url, graph=True)
    policy = (SOURCES / 'event.js').read_text().split('\nconst reject =', 1)[0]
    complete = policy + '\nreturn $response.statusCode !== 200 || !$response.body || !Array.isArray($response.body.value) || $response.body.value.length > 50 || !safeNext($response.body["@odata.nextLink"], ' + initial + ');'
    result['parameters']['options']['pagination'] = {'pagination': {
        'paginationMode': 'responseContainsNextURL',
        'nextURL': '={{ $pageCount === 0 ? ' + initial + ' : $response.body["@odata.nextLink"] }}',
        'paginationCompleteWhen': 'other', 'completeExpression': '={{ (() => {' + complete + '})() }}',
        'limitPagesFetched': True, 'maxRequests': 5, 'requestInterval': 0}}
    return result


def build_workflow():
    marker = 'MAM-PEOPLE-HUB-READINESS-720f0200-20261021'
    readiness_filter = "contains(subject,'" + marker + "')"
    readiness_url = 'https://graph.microsoft.com/v1.0/me/events?$filter=' + quote(readiness_filter, safe='') + '&$select=' + FIELDS + '&$top=50'
    nodes = [
        node('Every Five Minutes', 'scheduleTrigger', {'rule': {'interval': [{'field': 'minutes', 'minutesInterval': 5}]}}, 1.2),
        http('Read AI Identity', 'https://graph.microsoft.com/v1.0/me?$select=mail,userPrincipalName', graph=True),
        code('Verify AI Identity', 'identity.js'), gate('AI Identity Valid?', 'valid'),
        http('Read Pending Meeting Imports', HUB), code('Prepare Calendar Queries', 'queries.js'),
        calendar('Read AI Calendar', '={{ $json.queryUrl }}', '$json.queryUrl'),
        code('Validate Manager Meeting', 'event.js'), gate('Manager Meeting Valid?', 'valid'),
        http('Import Meeting Once', HUB, body='={{ $json.importBody }}'), code('Return Meeting Result', 'result.js', each=True),
        node('Meeting Readiness', 'webhook', {'httpMethod': 'GET', 'path': 'mam-people-hub-performance-review-meeting-v1-ready',
             'authentication': 'headerAuth', 'responseMode': 'lastNode', 'options': {}}, 2.1, {'httpHeaderAuth': READINESS.copy()}),
        http('Check Meeting API Readiness', HUB + '?readiness=1'),
        http('Read Readiness AI Identity', 'https://graph.microsoft.com/v1.0/me?$select=mail,userPrincipalName', graph=True),
        code('Verify Readiness AI Identity', 'identity.js'), gate('Readiness AI Identity Valid?', 'valid'),
        calendar('Check Calendar Read Access', readiness_url, json.dumps(readiness_url)),
        code('Return Meeting Readiness', 'readiness.js'),
    ]
    nodes[11]['webhookId'] = '720f0200-0000-4000-8000-000000000021'
    connections = {}

    def connect(source, target):
        connections[source] = {'main': [[{'node': target, 'type': 'main', 'index': 0}]]}

    for chain in [
        ['Every Five Minutes', 'Read AI Identity', 'Verify AI Identity', 'AI Identity Valid?',
         'Read Pending Meeting Imports', 'Prepare Calendar Queries', 'Read AI Calendar',
         'Validate Manager Meeting', 'Manager Meeting Valid?', 'Import Meeting Once', 'Return Meeting Result'],
        ['Meeting Readiness', 'Check Meeting API Readiness', 'Read Readiness AI Identity',
         'Verify Readiness AI Identity', 'Readiness AI Identity Valid?', 'Check Calendar Read Access', 'Return Meeting Readiness'],
    ]:
        for source, target in zip(chain, chain[1:]):
            connect(source, target)
    for index, value in enumerate(nodes):
        value['position'] = [index * 220, 0 if index < 11 else 300]
    return {'name': 'MAM People Hub - Performance Review Meeting Import (Live)', 'nodes': nodes,
            'connections': connections, 'settings': {'executionOrder': 'v1', 'timezone': 'Australia/Melbourne',
                'saveDataSuccessExecution': 'none', 'saveDataErrorExecution': 'none', 'saveManualExecutions': False,
                'saveExecutionProgress': False, 'executionTimeout': 90}}


if __name__ == '__main__':
    json.dump(build_workflow(), sys.stdout, ensure_ascii=False)
    sys.stdout.write('\n')
