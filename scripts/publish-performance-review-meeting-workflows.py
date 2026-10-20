import argparse
import hashlib
import importlib.util
import json
import os
import re
import subprocess
import sys
import time
from pathlib import Path
from urllib.error import HTTPError
from urllib.parse import quote, urlparse
from urllib.request import Request, build_opener

ROOT = Path(__file__).resolve().parents[1]
NROOT = Path('/Volumes/UG/MAM/opencode/n8n')
KEYS = ('name', 'nodes', 'connections', 'settings')
PREDECESSOR = {'id': '4Ahuz2qzddNKo7LB', 'versionId': 'e21bd3ab-4f90-494d-92aa-dd6c5a355574',
               'sha256': 'da0043257a71fb4332ecf719adc975bfebb19ea95c66fc88844e4e5d8390c92d'}
READY_PATHS = {'calendar': '/webhook/mam-people-hub-performance-review-meeting-v1-ready',
               'notifications': '/webhook/mam-people-hub-performance-review-notifications-v1-ready'}


def digest(graph):
    return hashlib.sha256(json.dumps(graph, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode()).hexdigest()


def graph(row):
    if not isinstance(row, dict) or not all(key in row for key in KEYS):
        raise RuntimeError('workflow_graph_unavailable')
    return {key: row[key] for key in KEYS}


def load_builder(kind):
    file = ROOT / 'scripts' / ('build-performance-review-meeting-workflow.py' if kind == 'calendar' else 'build-performance-review-notifications-workflow.py')
    spec = importlib.util.spec_from_file_location('performance_meeting_builder', file)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.build_workflow()


def checked(row, expected_graph, identity=None, version=None, active=None):
    if not isinstance(row, dict) or not isinstance(row.get('id'), str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,64}', row['id']) \
       or not isinstance(row.get('versionId'), str) or not re.fullmatch(r'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}', row['versionId']) \
       or graph(row) != expected_graph or type(row.get('active')) is not bool or 'activeVersionId' not in row \
       or (identity is not None and row['id'] != identity) or (version is not None and row['versionId'] != version) \
       or (active is not None and row['active'] is not active) \
       or row['activeVersionId'] != (row['versionId'] if row['active'] else None):
        raise RuntimeError('workflow_target_or_version_differs')
    return row


def save(path, state, new=False):
    target = path if new else path.with_name(path.name + '.next')
    fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w') as stream:
        json.dump(state, stream, sort_keys=True, indent=2)
        stream.flush()
        os.fsync(stream.fileno())
    if not new:
        os.replace(target, path)


def listed(api):
    rows, cursor = [], None
    for _ in range(20):
        payload = api('GET', 'workflows?limit=100' + ('&cursor=' + quote(cursor, safe='') if cursor else ''))
        if not isinstance(payload, dict) or not isinstance(payload.get('data'), list):
            raise RuntimeError('workflow_list_unavailable')
        rows.extend(payload['data'])
        cursor = payload.get('nextCursor')
        if cursor is None:
            return rows
        if not isinstance(cursor, str) or not cursor or len(cursor) > 6144:
            raise RuntimeError('workflow_cursor_invalid')
    raise RuntimeError('workflow_list_incomplete')


def drain(api, identity, pause):
    for attempt in range(13):
        busy = False
        for status in ('running', 'waiting'):
            data = api('GET', 'executions?workflowId=' + identity + '&status=' + status + '&limit=1')
            if not isinstance(data, dict) or not isinstance(data.get('data'), list) or data.get('nextCursor') is not None:
                raise RuntimeError('execution_state_unavailable')
            busy = busy or bool(data['data'])
        if not busy:
            return
        if attempt == 12:
            raise RuntimeError('workflow_still_running')
        pause(3)


def notification_update(state, desired, path, api, pause):
    identity, version = state['id'], state['versionId']
    if identity != PREDECESSOR['id'] or version != PREDECESSOR['versionId'] or state.get('baselineSha256') != PREDECESSOR['sha256']:
        raise RuntimeError('notification_predecessor_differs')
    row = api('GET', 'workflows/' + identity)
    baseline = graph(row)
    if digest(baseline) != PREDECESSOR['sha256']:
        raise RuntimeError('notification_predecessor_graph_differs')
    checked(row, baseline, identity, version, state['phase'] == 'pause_required')
    if state['phase'] == 'pause_required':
        state['phase'] = 'pausing'
        save(path, state)
        api('POST', 'workflows/' + identity + '/deactivate')
        checked(api('GET', 'workflows/' + identity), baseline, identity, version, False)
    state['phase'] = 'paused'
    save(path, state)
    drain(api, identity, pause)
    checked(api('GET', 'workflows/' + identity), baseline, identity, version, False)
    state['phase'] = 'updating'
    save(path, state)
    updated = api('PUT', 'workflows/' + identity, desired)
    state['versionId'] = updated.get('versionId')
    save(path, state)
    return checked(api('GET', 'workflows/' + identity), desired, identity, state['versionId'], False)


def operate(operation, kind, path, expected_id, expected_version, api, pause=time.sleep, ready=None, target_origin=None):
    desired = load_builder(kind)
    sha = digest(desired)
    if operation == 'stage':
        if path.exists():
            raise RuntimeError('journal_exists_use_readback')
        if kind == 'calendar':
            before = listed(api)
            if any(row.get('name') == desired['name'] for row in before):
                raise RuntimeError('calendar_workflow_already_exists')
            state = {'kind': kind, 'graphSha256': sha, 'phase': 'creating', 'beforeIds': [row['id'] for row in before], 'targetOrigin': target_origin}
            save(path, state, new=True)
            created = api('POST', 'workflows', desired)
            state.update(id=created.get('id'), versionId=created.get('versionId'))
            save(path, state)
            row = checked(api('GET', 'workflows/' + str(state['id'])), desired, state['id'], state['versionId'], False)
        else:
            if expected_id != PREDECESSOR['id'] or expected_version != PREDECESSOR['versionId']:
                raise RuntimeError('notification_expected_predecessor_differs')
            row = api('GET', 'workflows/' + expected_id)
            baseline = graph(row)
            checked(row, baseline, expected_id, expected_version, True)
            if digest(baseline) != PREDECESSOR['sha256']:
                raise RuntimeError('notification_predecessor_graph_differs')
            state = {'kind': kind, 'graphSha256': sha, 'phase': 'pause_required', 'id': expected_id,
                     'versionId': expected_version, 'baselineSha256': digest(baseline), 'targetOrigin': target_origin}
            save(path, state, new=True)
            row = notification_update(state, desired, path, api, pause)
        state.update(id=row['id'], versionId=row['versionId'], phase='staged')
        save(path, state)
    else:
        state = json.loads(path.read_text())
        if state.get('kind') != kind or state.get('graphSha256') != sha or state.get('targetOrigin') != target_origin:
            raise RuntimeError('journal_source_or_target_differs')
        if state.get('id') is None:
            if operation != 'readback' or kind != 'calendar' or state.get('phase') != 'creating':
                raise RuntimeError('unknown_create_requires_readback')
            candidates = [row for row in listed(api) if row.get('name') == desired['name'] and row.get('id') not in state['beforeIds']]
            matches = []
            for candidate in candidates:
                value = api('GET', 'workflows/' + candidate['id'])
                if graph(value) == desired:
                    matches.append(checked(value, desired, candidate['id'], active=False))
            if len(matches) != 1:
                raise RuntimeError('unknown_create_unresolved_no_retry')
            state.update(id=matches[0]['id'], versionId=matches[0]['versionId'], phase='staged')
            save(path, state)
        if expected_id != state['id'] or expected_version != state['versionId']:
            if not (operation == 'readback' and expected_id is None and expected_version is None):
                raise RuntimeError('expected_resource_differs')
        row = api('GET', 'workflows/' + state['id'])
        if operation == 'readback' and kind == 'notifications' and state['phase'] in ('pause_required', 'pausing', 'paused', 'updating'):
            if graph(row) == desired:
                checked(row, desired, state['id'], active=False)
                state.update(versionId=row['versionId'], phase='staged')
            else:
                baseline = graph(row)
                checked(row, baseline, PREDECESSOR['id'], PREDECESSOR['versionId'])
                if digest(baseline) != PREDECESSOR['sha256'] or state.get('baselineSha256') != PREDECESSOR['sha256']:
                    raise RuntimeError('notification_predecessor_graph_differs')
                state.update(versionId=row['versionId'], phase='pause_required' if row['active'] else 'paused')
            save(path, state)
            return {'ok': True, 'kind': kind, 'id': state['id'], 'versionId': state['versionId'],
                    'phase': state['phase'], 'graphSha256': sha, 'readiness': False}
        if operation == 'continue':
            if kind != 'notifications' or state['phase'] not in ('pause_required', 'paused'):
                raise RuntimeError('continue_requires_readback_paused_predecessor')
            row = notification_update(state, desired, path, api, pause)
            state.update(versionId=row['versionId'], phase='staged')
            save(path, state)
        else:
            checked(row, desired, state['id'], state['versionId'])
            if operation == 'activate':
                if state['phase'] != 'staged' or row['active']:
                    raise RuntimeError('activation_requires_staged_inactive')
                state['phase'] = 'activating'
                save(path, state)
                api('POST', 'workflows/' + state['id'] + '/activate', {'versionId': state['versionId']})
                row = checked(api('GET', 'workflows/' + state['id']), desired, state['id'], state['versionId'], True)
                state['phase'] = 'active'
                save(path, state)
            elif operation == 'readback':
                state['phase'] = 'active' if row['active'] else 'staged'
                save(path, state)
            elif operation == 'readiness':
                if not row['active'] or state['phase'] != 'active' or ready is None:
                    raise RuntimeError('readiness_requires_active_owned_workflow')
                evidence = ready(kind)
                if evidence != {'ok': True, 'ready': True}:
                    raise RuntimeError('readiness_unavailable')
            else:
                raise RuntimeError('unsupported_operation')
    return {'ok': True, 'kind': kind, 'id': state['id'], 'versionId': state['versionId'],
            'phase': state['phase'], 'graphSha256': sha, 'readiness': operation == 'readiness'}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('operation', choices=['stage', 'continue', 'activate', 'readback', 'readiness'])
    parser.add_argument('--kind', required=True, choices=['calendar', 'notifications'])
    parser.add_argument('--journal', required=True)
    parser.add_argument('--expected-origin', required=True)
    parser.add_argument('--expected-id')
    parser.add_argument('--expected-version')
    args = parser.parse_args()
    path = Path(args.journal).resolve()
    if not path.parent.is_dir() or not str(path).startswith(('/private/tmp/', '/private/var/folders/')):
        raise RuntimeError('journal_requires_owned_temporary_directory')
    subprocess.run(['python3', 'scripts/verify.py'], cwd=NROOT, check=True, stdout=subprocess.DEVNULL)
    spec = importlib.util.spec_from_file_location('mam_n8n_verifier', NROOT / 'scripts/verify.py')
    verifier = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(verifier)
    config = verifier.load_local_env()
    origin = config['N8N_BASE_URL'].rstrip('/')
    parsed = urlparse(origin)
    if config.get('N8N_INSTANCE_LABEL') != 'MAM' or parsed.scheme != 'https' or not parsed.hostname \
       or parsed.username is not None or parsed.password is not None or parsed.query or parsed.fragment or parsed.path not in ('', '/') \
       or origin != args.expected_origin:
        raise RuntimeError('mam_target_configuration_differs')
    opener = build_opener(verifier.NoRedirect())

    def http(method, url, headers, body=None):
        request = Request(url, method=method, headers={'Accept': 'application/json', **headers},
                          data=None if body is None else json.dumps(body).encode())
        with opener.open(request, timeout=20) as response:
            if response.status != 200 and not (response.status == 201 and method == 'POST' and url.endswith('/api/v1/workflows')):
                raise RuntimeError('unexpected_http_status')
            raw = response.read(4 * 1024 * 1024 + 1)
            if len(raw) > 4 * 1024 * 1024:
                raise RuntimeError('response_limit')
            return json.loads(raw)

    def api(method, resource, body=None):
        allowed = (method == 'GET' and (resource.startswith('workflows?limit=100')
                   or re.fullmatch(r'workflows/[A-Za-z0-9_-]{1,64}', resource)
                   or re.fullmatch(r'executions\?workflowId=4Ahuz2qzddNKo7LB&status=(running|waiting)&limit=1', resource))) \
            or (method == 'POST' and (resource == 'workflows' or re.fullmatch(r'workflows/[A-Za-z0-9_-]{1,64}/(activate|deactivate)', resource))) \
            or (method == 'PUT' and resource == 'workflows/' + PREDECESSOR['id'])
        if not allowed:
            raise RuntimeError('operation_outside_workflow_scope')
        return http(method, origin + '/api/v1/' + resource, {'X-N8N-API-KEY': config['N8N_API_KEY'], 'Content-Type': 'application/json'}, body)

    def readiness(kind):
        name = 'MAM_PERFORMANCE_MEETING_CRON_SECRET' if kind == 'calendar' else 'MAM_N8N_LEAVE_WEBHOOK_SECRET'
        secret = os.environ.get(name, '')
        if not 32 <= len(secret) <= 512 or re.search(r'[\x00-\x1f\x7f]', secret):
            raise RuntimeError('readiness_secret_not_configured')
        header = {'Authorization': 'Bearer ' + secret} if kind == 'calendar' else {'X-MAM-Notification-Secret': secret}
        return http('GET', origin + READY_PATHS[kind], header)

    print(json.dumps(operate(args.operation, args.kind, path, args.expected_id, args.expected_version, api, ready=readiness, target_origin=origin)))


if __name__ == '__main__':
    try:
        main()
    except HTTPError as error:
        print(json.dumps({'ok': False, 'code': 'http_' + str(error.code)}), file=sys.stderr)
        raise SystemExit(1)
    except (OSError, RuntimeError, ValueError, subprocess.SubprocessError):
        print(json.dumps({'ok': False, 'code': 'workflow_operation_held_check_journal'}), file=sys.stderr)
        raise SystemExit(1)
