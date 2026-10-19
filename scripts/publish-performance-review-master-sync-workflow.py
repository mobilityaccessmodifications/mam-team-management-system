import hashlib
import json
import os
from pathlib import Path
import re
import stat
import sys
import time
import types
from urllib.parse import quote

LOADED_CODE = sys._getframe().f_code
ROOT = Path(__file__).resolve().parents[1]
NROOT = Path('/Volumes/UG/MAM/opencode/n8n')
JOURNAL_ROOT = NROOT / '.performance-review-master-sync-v1'
SELF = 'scripts/publish-performance-review-master-sync-workflow.py'
PUBLISHER = 'scripts/publish-performance-review-mail-workflow.py'
PUBLISHER_SHA256 = 'e7e8fdc51aebfedc059054c42cffb09428057db9368627a39f0bf527ff159437'
BUILDER = 'scripts/build-performance-review-master-sync-workflow.py'
NAME = 'MAM People Hub - Performance Review Master Sync v1'
INVENTORY_QUERY = 'workflows?limit=1&name=' + quote(NAME, safe='')
FILES = (SELF, PUBLISHER, BUILDER, 'deploy/n8n/performance-review-master-sync-v1/target.json',
         'deploy/n8n/performance-review-master-sync-v1/schema.json',
         'deploy/n8n/performance-review-master-sync-v1/validate-job.mjs',
         'deploy/n8n/performance-review-master-sync-v1/project-row.mjs',
         'deploy/n8n/performance-review-master-sync-v1/classify-result.mjs',
         'supabase/migrations/20261019000000_performance_review_master_sync.sql',
         'tests/performance-review-master-publisher.test.mjs', 'tests/performance-review-master-publisher-fixture.py')


def require(condition, message='HOLD_MASTER_PUBLICATION'):
    if not condition:
        raise ValueError(message)


def allowed_operation(method, path):
    return isinstance(path, str) and ((method == 'GET' and (path == 'workflows?limit=1' or re.fullmatch(re.escape(INVENTORY_QUERY) + r'(?:&cursor=(?:[A-Za-z0-9._~-]|%[0-9A-F]{2}){1,6144})?', path) or re.fullmatch(r'workflows/[A-Za-z0-9_-]{1,64}', path))) or (method == 'POST' and path == 'workflows'))


def acquire():
    raw = {}
    for name in FILES:
        path = ROOT / name
        require(path.resolve() == path and path.is_file())
        raw[name] = path.read_bytes()
    external = {'MAM_VERIFY': (NROOT / 'scripts/verify.py').read_bytes()}
    code = compile(raw[SELF], str(ROOT / SELF), 'exec', dont_inherit=True)
    require(LOADED_CODE == code)
    for item in code.co_consts:
        if isinstance(item, types.CodeType):
            function = globals().get(item.co_name)
            require(isinstance(function, types.FunctionType) and function.__code__ == item)
    c = types.ModuleType('master_protected_n8n_transport')
    c.__file__ = str(ROOT / PUBLISHER)
    require(hashlib.sha256(raw[PUBLISHER]).hexdigest() == PUBLISHER_SHA256)
    exec(compile(raw[PUBLISHER], c.__file__, 'exec', dont_inherit=True), c.__dict__)
    c.allowed_operation = allowed_operation
    closure = {**{name: c.digest(value) for name, value in raw.items()}, 'external:MAM_VERIFY': c.digest(external['MAM_VERIFY'])}
    return c, raw, external, closure


def check(source):
    _, raw, external, closure = acquire()
    require(raw == source[1] and external == source[2] and closure == source[3], 'HOLD_SOURCE_DRIFT')


def graph_for(source, credentials=None):
    c, raw, _, _ = source
    builder = types.ModuleType('master_disabled_builder')
    builder.__file__ = str(ROOT / BUILDER)
    exec(compile(raw[BUILDER], builder.__file__, 'exec', dont_inherit=True), builder.__dict__)
    target = c.load_json(raw['deploy/n8n/performance-review-master-sync-v1/target.json'])
    require(c.json_equal(target, {'enabled': False, 'singleWriterAdmitted': False, 'binding': None}))
    graph = builder.build_workflow(target)
    require(graph.pop('active') is False and graph['name'] == NAME and graph['nodes'][0].get('disabled') is True)
    if credentials is not None:
        c.closed(credentials, ('hub', 'gateway'))
        for ref in credentials.values():
            c.closed(ref, ('id', 'name'))
            require(isinstance(ref['id'], str) and re.fullmatch(r'[A-Za-z0-9_-]{1,64}', ref['id']) is not None)
            require(isinstance(ref['name'], str) and re.fullmatch(r'[^\x00-\x1f\x7f]{1,200}', ref['name']) is not None)
        require(credentials['hub']['id'] != credentials['gateway']['id'])
        for node in graph['nodes']:
            if 'credentials' in node:
                expected = node['credentials']['httpHeaderAuth']['id']
                require(expected in ('__PARENT_MASTER_HUB_ID__', '__PARENT_MASTER_GATEWAY_ID__'))
                ref = credentials['hub' if expected == '__PARENT_MASTER_HUB_ID__' else 'gateway']
                node['credentials'] = {'httpHeaderAuth': dict(ref)}
    return graph


def admit(packet, source, operation):
    c = source[0]
    c.closed(packet, ('schemaVersion', 'sourceHashes', 'credentials', 'review'))
    require(type(packet['schemaVersion']) is int and packet['schemaVersion'] == 1 and c.json_equal(packet['sourceHashes'], source[3]))
    graph = graph_for(source, packet['credentials'])
    review = packet['review']
    c.closed(review, ('reviewer', 'independent', 'passed', 'security_concerns', 'logic_errors', 'sourceHashes', 'packetSha256', 'graphSha256', 'gates', 'validUntilUnix'))
    c.closed(review['gates'], ('stage', 'activate', 'dispatch'))
    require(isinstance(review['reviewer'], str) and review['reviewer'].strip() and review['reviewer'] not in ('implementation-owner', 'master-owner'))
    require(review['independent'] is True and review['passed'] is True and review['security_concerns'] == [] and review['logic_errors'] == [])
    require(c.json_equal(review['sourceHashes'], source[3]) and review['graphSha256'] == c.digest(c.canonical(graph)))
    require(review['packetSha256'] == c.digest(c.canonical({key: value for key, value in packet.items() if key != 'review'})))
    require(review['gates'] == {'stage': True, 'activate': False, 'dispatch': False} and all(type(value) is bool for value in review['gates'].values()))
    require(type(review['validUntilUnix']) is int and (operation == 'readback' or time.time() < review['validUntilUnix']))
    return graph


def call(source, ports, method, path, body=None):
    require(allowed_operation(method, path))
    try:
        value = ports.api(method, path, body)
        source[0].reject_secret(value, ports.secrets)
        return value
    finally:
        check(source)


def absent(source, ports, graph):
    c = source[0]
    path = INVENTORY_QUERY
    identities, cursors = set(), set()
    total = 0
    for _ in range(32):
        row = call(source, ports, 'GET', path)
        c.closed(row, ('data', 'nextCursor'))
        require(isinstance(row['data'], list) and len(row['data']) <= 1)
        size = getattr(ports, 'last_response_bytes', None)
        size = len(c.canonical(row)) if size is None else size
        require(type(size) is int and 0 <= size <= 8388608, 'HOLD_INVENTORY_BODY_BOUND')
        total += size
        require(total <= 67108864, 'HOLD_INVENTORY_TOTAL_BOUND')
        for workflow in row['data']:
            require(isinstance(workflow, dict) and isinstance(workflow.get('id'), str) and re.fullmatch(r'[A-Za-z0-9_-]{1,64}', workflow['id']) is not None)
            require(workflow['id'] not in identities and isinstance(workflow.get('name'), str) and workflow['name'] and workflow['name'] != graph['name'])
            identities.add(workflow['id'])
        require(len(identities) <= 800)
        cursor = row['nextCursor']
        if cursor is None:
            return
        require(isinstance(cursor, str) and 1 <= len(cursor.encode()) <= 2048 and cursor not in cursors and row['data'])
        cursors.add(cursor)
        path = INVENTORY_QUERY + '&cursor=' + quote(cursor, safe='')
    raise ValueError('HOLD_INVENTORY_PAGE_BOUND')


def publish(operation, packet, source, journal, ports=None):
    c = source[0]
    graph = admit(packet, source, operation)
    scope = {'sourceHashes': source[3], 'graphSha256': c.digest(c.canonical(graph))}
    state = journal.load()
    if operation == 'stage':
        require(state is None, 'HOLD_CANONICAL_ATTEMPT_EXISTS')
    else:
        c.closed(state, ('scope', 'phase', 'dispatches', 'id', 'versionId'))
        require(c.json_equal(state['scope'], scope) and state['phase'] == 'STAGED_INACTIVE' and c.json_equal(state['dispatches'], {'create': 1, 'activate': 0}))
    if ports is None:
        ports = c.NativePorts({'n8nOrigin': 'https://n8n.srv1866578.hstgr.cloud'}, source[2])
    journal.secrets = ports.secrets
    c.reject_secret(packet, ports.secrets)
    try:
        ports.verify()
    finally:
        check(source)
    if operation == 'stage':
        absent(source, ports, graph)
        admit(packet, source, operation)
        check(source)
        state = {'scope': scope, 'phase': 'HOLD_CREATE_UNKNOWN', 'dispatches': {'create': 1, 'activate': 0}, 'id': None, 'versionId': None}
        journal.save(state, initial=True)
        row = call(source, ports, 'POST', 'workflows', graph)
        identity, version = c.validate_workflow(row, graph)
        state.update(id=identity, versionId=version)
        journal.save(state)
    row = call(source, ports, 'GET', 'workflows/' + state['id'])
    c.validate_workflow(row, graph, expected_id=state['id'], expected_version=state['versionId'])
    require('activeVersion' in row and row['activeVersion'] is None)
    state['phase'] = 'STAGED_INACTIVE'
    journal.save(state)
    check(source)
    result = {'ok': True, 'phase': state['phase'], 'id': state['id'], 'versionId': state['versionId'], 'active': False, 'runtimeProviderVerified': False}
    c.reject_secret(result, ports.secrets)
    journal.finish()
    return result


def main(argv=None, stdin=None, ports=None, journal=None):
    source = None
    failed = False
    try:
        args = sys.argv[1:] if argv is None else argv
        require(args in (['prepare'], ['stage', '--parent-stage-inactive'], ['readback']))
        source = acquire()
        if args == ['prepare']:
            result = {'schemaVersion': 1, 'sourceHashes': source[3], 'unboundGraph': graph_for(source), 'nativeReady': False, 'activationSupported': False}
        else:
            raw = (sys.stdin if stdin is None else stdin).read(1048577)
            require(len(raw.encode()) <= 1048576)
            packet = source[0].load_json(raw)
            operation = args[0]
            admit(packet, source, operation)
            if journal is None:
                require(JOURNAL_ROOT.parent.resolve() == JOURNAL_ROOT.parent)
                if operation == 'stage':
                    try:
                        JOURNAL_ROOT.mkdir(mode=0o700)
                        directory = os.open(JOURNAL_ROOT.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
                        try:
                            os.fsync(directory)
                        finally:
                            os.close(directory)
                    except FileExistsError:
                        pass
                meta = JOURNAL_ROOT.lstat()
                require(JOURNAL_ROOT.resolve() == JOURNAL_ROOT and stat.S_ISDIR(meta.st_mode) and meta.st_uid == os.geteuid() and stat.S_IMODE(meta.st_mode) == 0o700)
                target = JOURNAL_ROOT / 'attempt.json'
                require(operation != 'stage' or (not target.exists() and not target.is_symlink()), 'HOLD_CANONICAL_ATTEMPT_EXISTS')
                journal = source[0].NativeJournal(str(target))
            result = publish(operation, packet, source, journal, ports)
        check(source)
    except BaseException:
        failed = True
    finally:
        if journal is not None:
            try:
                journal.close()
            except BaseException:
                failed = True
        if source is not None:
            try:
                check(source)
            except BaseException:
                failed = True
    if failed:
        if source is not None and journal is not None and journal.closed:
            replacement = None
            try:
                replacement = source[0].NativeJournal(str(JOURNAL_ROOT / 'attempt.json'))
                replacement.secrets = journal.secrets
                state = replacement.load()
                if state is not None and state.get('phase') == 'STAGED_INACTIVE':
                    state['phase'] = 'HOLD_PUBLICATION_NO_RETRY'
                    replacement.save(state)
            except BaseException:
                pass
            finally:
                if replacement is not None:
                    replacement.close()
        print('HOLD_MASTER_PUBLICATION_NO_RETRY', file=sys.stderr)
        return 2
    print(json.dumps(result, ensure_ascii=False, allow_nan=False))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
