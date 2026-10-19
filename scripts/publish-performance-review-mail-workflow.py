import hashlib
import io
import json
import math
import os
import re
import stat
import sys
import time
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from urllib.parse import quote
from urllib.request import ProxyHandler, Request, build_opener

LOADED_CODE = sys._getframe().f_code
ROOT = Path(__file__).resolve().parents[1]
NROOT = Path('/Volumes/UG/MAM/opencode/n8n')
ATTEMPT_ROOT = NROOT / '.performance-review-mail-v1'
SUPPLEMENT = Path('/Volumes/UG/MAM/opencode/.worktrees/mam-performance-production-20261016/qa-evidence/performance-release-20261016/mail-http-interface-supplement-v1.json')
RUNTIME = (
    'scripts/build-performance-review-mail-workflow.py', 'scripts/publish-performance-review-mail-workflow.py',
    'deploy/n8n/performance-review-mail-v1/validate-payload.js', 'deploy/n8n/performance-review-mail-v1/gate-begin.js',
    'deploy/n8n/performance-review-mail-v1/return-held.js', 'deploy/n8n/performance-review-mail-v1/classify-send.js',
    'deploy/n8n/performance-review-mail-v1/validate-finish.js', 'deploy/n8n/performance-review-mail-v1/validate-readiness.js',
    'docs/performance-review-production-mail-contract-v1.md', 'docs/performance-review-production-scope-20261016.md',
    'tests/performance-review-n8n-workflow.test.mjs', 'tests/performance-review-n8n-publisher.test.mjs',
    'tests/performance-review-n8n-publisher-fixture.py', 'tests/performance-review-n8n-runner.mjs', 'tests/performance-review-n8n-fixtures.mjs',
    'tests/performance-review-n8n-portable/mam-verify.py', 'tests/performance-review-n8n-portable/http-supplement.json',
    'tests/performance-review-n8n-repair-fixture.py', 'tests/performance-review-n8n-repair.test.mjs',
    'src/lib/performance-review-word.mjs', 'src/lib/performance-review-questions.mjs',
    'deploy/n8n/performance-review-mail-v1/OPERATOR.md',
)
EXTERNAL = {'MAM_VERIFY': NROOT / 'scripts/verify.py', 'HTTP_SUPPLEMENT': SUPPLEMENT}


def digest(value):
    return hashlib.sha256(value).hexdigest()


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False, allow_nan=False).encode()


def acquire():
    snapshot = {name: (ROOT / name).read_bytes() for name in RUNTIME}
    name = 'scripts/publish-performance-review-mail-workflow.py'
    if LOADED_CODE != compile(snapshot[name], str(ROOT / name), 'exec', dont_inherit=True):
        raise ValueError('HOLD_LOADED_PUBLISHER_SOURCE')
    external = {name: path.read_bytes() for name, path in EXTERNAL.items()}
    return snapshot, external


def closure_for(snapshot, external):
    return {'schemaVersion': 1, 'sourceHashes': {name: digest(value) for name, value in snapshot.items()},
            'externalHashes': {name: digest(value) for name, value in external.items()}}


def closed(value, keys):
    if not isinstance(value, dict) or set(value) != set(keys):
        raise ValueError('HOLD_CLOSED_SCHEMA')


def parse_args(argv):
    if not argv or argv[0] not in ('stage', 'activate', 'readback'):
        raise ValueError('HOLD_INVOCATION')
    result = {'operation': argv[0]}
    index = 1
    while index < len(argv):
        key = argv[index]
        if key in result:
            raise ValueError('HOLD_INVOCATION')
        if key in ('--parent-stage', '--parent-activate', '--readiness'):
            result[key] = True
            index += 1
        elif key in ('--journal', '--expected-id', '--expected-version') and index + 1 < len(argv) and not argv[index + 1].startswith('--'):
            result[key] = argv[index + 1]
            index += 2
        else:
            raise ValueError('HOLD_INVOCATION')
    operation = result['operation']
    if (operation == 'stage' and (result.get('--parent-stage') is not True or '--parent-activate' in result or '--expected-id' in result or '--expected-version' in result or '--readiness' in result)) or (operation == 'activate' and (result.get('--parent-activate') is not True or '--parent-stage' in result or '--readiness' in result)) or (operation == 'readback' and ('--parent-stage' in result or '--parent-activate' in result)):
        raise ValueError('HOLD_PHASE_AUTHORITY')
    if operation != 'stage' and (not result.get('--expected-id') or not result.get('--expected-version')):
        raise ValueError('HOLD_EXPECTED_RESOURCE')
    return result


def pairs_unique(pairs):
    value = {}
    for key, item in pairs:
        if key in value:
            raise ValueError('HOLD_DUPLICATE_KEY')
        value[key] = item
    return value


def invalid_constant(value):
    raise ValueError('HOLD_NONFINITE_JSON')


def finite_float(value):
    number = float(value)
    if not math.isfinite(number):
        raise ValueError('HOLD_NONFINITE_JSON')
    return number


def load_json(raw):
    return json.loads(raw, object_pairs_hook=pairs_unique, parse_constant=invalid_constant, parse_float=finite_float)


def reject_secret(value, secrets):
    if isinstance(value, str):
        if any(secret in value for secret in secrets):
            raise ValueError('HOLD_SECRET_ECHO')
    elif isinstance(value, dict):
        for key, item in value.items():
            reject_secret(key, secrets)
            reject_secret(item, secrets)
    elif isinstance(value, list):
        for item in value:
            reject_secret(item, secrets)


def load_verifier(external):
    scope: dict = {'__name__': 'performance_mam_verifier_snapshot', '__file__': str(EXTERNAL['MAM_VERIFY'])}
    exec(compile(external['MAM_VERIFY'], str(EXTERNAL['MAM_VERIFY']), 'exec'), scope)
    return scope


def allowed_operation(method, path):
    return isinstance(path, str) and ((method == 'GET' and re.fullmatch(r'workflows(?:\?limit=1|\?limit=25(?:&cursor=(?:[A-Za-z0-9._~-]|%[0-9A-F]{2}){1,6144})?|/[A-Za-z0-9_-]{1,64})', path)) or (method == 'POST' and (path == 'workflows' or re.fullmatch(r'workflows/[A-Za-z0-9_-]{1,64}/activate', path))))


class SafeOpener:
    def __init__(self, opener, origin, secrets):
        self.opener = opener
        self.origin = origin
        self.secrets = secrets

    def open(self, request, timeout=20):
        prefix = self.origin + '/api/v1/'
        if not request.full_url.startswith(prefix) or not allowed_operation(request.get_method(), request.full_url[len(prefix):]):
            raise ValueError('HOLD_TRANSPORT_TARGET')
        deadline = time.monotonic() + min(timeout, 20)
        with self.opener.open(request, timeout=min(timeout, 20)) as response:
            if type(response.status) is not int or response.status not in (200, 201):
                raise ValueError('HOLD_HTTP_STATUS')
            parts = []
            size = 0
            reader = getattr(response, 'read1', response.read)
            while True:
                if time.monotonic() >= deadline:
                    raise ValueError('HOLD_HTTP_DEADLINE')
                chunk = reader(min(65536, 8388609 - size))
                if not chunk:
                    break
                size += len(chunk)
                if size > 8388608:
                    raise ValueError('HOLD_HTTP_BODY_BOUND')
                parts.append(chunk)
            if time.monotonic() >= deadline:
                raise ValueError('HOLD_HTTP_DEADLINE')
        raw = b''.join(parts)
        value = load_json(raw)
        reject_secret(value, self.secrets)
        return io.BytesIO(raw)


class NativePorts:
    def __init__(self, binding, external):
        self.verifier = load_verifier(external)
        config = self.verifier['load_local_env']()
        if not isinstance(config, dict) or config.get('N8N_INSTANCE_LABEL') != 'MAM' or config.get('N8N_BASE_URL') != binding['n8nOrigin'] or binding['n8nOrigin'] != 'https://n8n.srv1866578.hstgr.cloud':
            raise ValueError('HOLD_MAM_CONFIG_TARGET')
        key = config.get('N8N_API_KEY')
        if not isinstance(key, str) or not re.fullmatch(r'[!-~]{16,4096}', key) or key == 'replace_with_mam_n8n_api_key':
            raise ValueError('HOLD_MAM_CONFIG_KEY')
        self.origin = config['N8N_BASE_URL']
        self.secrets = (key,)
        self.key = key
        reject_secret(binding, self.secrets)
        safe_config = {name: config[name] for name in ('N8N_INSTANCE_LABEL', 'N8N_BASE_URL', 'N8N_API_KEY')}
        self.verifier['load_local_env'] = lambda: safe_config.copy()
        no_redirect = self.verifier['NoRedirect']
        verifier_opener = self.verifier['build_opener']
        self.verifier['build_opener'] = lambda *handlers: SafeOpener(verifier_opener(ProxyHandler({}), *handlers), self.origin, self.secrets)
        self.opener = SafeOpener(build_opener(ProxyHandler({}), no_redirect()), self.origin, self.secrets)

    def verify(self):
        with redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
            status = self.verifier['main']()
        if status != 0:
            raise ValueError('HOLD_MAM_VERIFICATION')

    def api(self, method, path, body=None):
        if not allowed_operation(method, path):
            raise ValueError('HOLD_API_OPERATION')
        payload = None if body is None else canonical(body)
        if payload is not None and len(payload) > 1048576:
            raise ValueError('HOLD_REQUEST_BOUND')
        request = Request(self.origin + '/api/v1/' + path, data=payload, method=method,
                          headers={'X-N8N-API-KEY': self.key, 'Accept': 'application/json', 'Content-Type': 'application/json'})
        with self.opener.open(request, timeout=20) as response:
            raw = response.read()
            self.last_response_bytes = len(raw)
            return load_json(raw)


class NativeJournal:
    def __init__(self, filename):
        path = Path(filename)
        if not path.is_absolute() or path.suffix != '.json' or path.parent.resolve() != path.parent or not path.parent.is_dir():
            raise ValueError('HOLD_JOURNAL_PATH')
        self.directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        self.name = path.name
        self.lock = self.name + '.lock'
        self.secrets: tuple[str, ...] = ()
        self.fence = None
        self.closed = False
        try:
            metadata = os.fstat(self.directory)
            if metadata.st_uid != os.geteuid() or metadata.st_mode & 0o022:
                raise ValueError('HOLD_JOURNAL_DIRECTORY')
            fd = os.open(self.lock, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=self.directory)
            try:
                os.write(fd, b'HOLD_PUBLICATION_NO_RETRY\n')
                os.fsync(fd)
                os.fsync(self.directory)
            finally:
                os.close(fd)
        except BaseException:
            os.close(self.directory)
            self.closed = True
            raise

    def load(self):
        try:
            fd = os.open(self.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=self.directory)
        except FileNotFoundError:
            return None
        try:
            metadata = os.fstat(fd)
            if not stat.S_ISREG(metadata.st_mode) or metadata.st_uid != os.geteuid() or stat.S_IMODE(metadata.st_mode) != 0o600 or metadata.st_nlink != 1 or metadata.st_size > 65536:
                raise ValueError('HOLD_JOURNAL_FILE')
            raw = os.read(fd, 65537)
        finally:
            os.close(fd)
        value = load_json(raw)
        reject_secret(value, self.secrets)
        return value

    def save(self, value, initial=False):
        reject_secret(value, self.secrets)
        raw = canonical(value) + b'\n'
        if len(raw) > 65536 or (initial and self.load() is not None):
            raise ValueError('HOLD_JOURNAL_STATE')
        pending = self.name + '.pending'
        fd = os.open(pending, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=self.directory)
        try:
            view = memoryview(raw)
            while view:
                count = os.write(fd, view)
                if count <= 0:
                    raise ValueError('HOLD_JOURNAL_WRITE')
                view = view[count:]
            os.fsync(fd)
        finally:
            os.close(fd)
        os.replace(pending, self.name, src_dir_fd=self.directory, dst_dir_fd=self.directory)
        os.fsync(self.directory)
        if canonical(self.load()) + b'\n' != raw:
            raise ValueError('HOLD_JOURNAL_READBACK')
        if self.fence is not None:
            self.fence.save(value)

    def finish(self):
        try:
            os.unlink(self.lock, dir_fd=self.directory)
            os.fsync(self.directory)
        except BaseException:
            try:
                fd = os.open(self.lock, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=self.directory)
                os.close(fd)
            except FileExistsError:
                pass
            raise
        self.close()

    def close(self):
        if not self.closed:
            os.close(self.directory)
            self.closed = True


class AttemptFence:
    def __init__(self, args, packet, graph):
        if ATTEMPT_ROOT.parent.resolve() != ATTEMPT_ROOT.parent:
            raise ValueError('HOLD_CANONICAL_ROOT')
        created = False
        try:
            ATTEMPT_ROOT.mkdir(mode=0o700)
            created = True
        except FileExistsError:
            pass
        metadata = ATTEMPT_ROOT.lstat()
        if not stat.S_ISDIR(metadata.st_mode) or metadata.st_uid != os.geteuid() or stat.S_IMODE(metadata.st_mode) != 0o700:
            raise ValueError('HOLD_CANONICAL_ROOT')
        self.storage = NativeJournal(str(ATTEMPT_ROOT / 'attempt.json'))
        try:
            if created:
                parent = os.open(ATTEMPT_ROOT.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
                try:
                    os.fsync(parent)
                finally:
                    os.close(parent)
            self.scope = {'origin': 'https://n8n.srv1866578.hstgr.cloud', 'name': graph['name'],
                          'paths': ['mam-people-hub-performance-review-mail-v1', 'mam-people-hub-performance-review-mail-v1-ready'],
                          'journal': args['--journal'], 'closureSha256': digest(canonical(packet['closure'])),
                          'graphSha256': digest(canonical(graph)), 'identityBindingSha256': digest(canonical({**packet['binding'], 'runtimeProviderVerified': False}))}
            self.record = self.storage.load()
            if args['operation'] == 'stage':
                if self.record is not None:
                    raise ValueError('HOLD_CANONICAL_ATTEMPT_EXISTS')
                self.record = {'schemaVersion': 1, 'scope': self.scope, 'state': {'phase': 'HOLD_NOT_ENTERED', 'dispatches': {'create': 0, 'activate': 0}}}
                self.storage.save(self.record, initial=True)
            else:
                closed(self.record, ('schemaVersion', 'scope', 'state'))
                if type(self.record['schemaVersion']) is not int or self.record['schemaVersion'] != 1 or not json_equal(self.record['scope'], self.scope) or not isinstance(self.record['state'], dict) or self.record['state'].get('phase') not in ('STAGED_INACTIVE', 'ACTIVATED_VERIFIED'):
                    raise ValueError('HOLD_CANONICAL_OWNERSHIP')
        except BaseException:
            self.storage.close()
            raise

    def save(self, value):
        self.record['state'] = value
        self.storage.save(self.record)


def validate_binding(binding):
    closed(binding, ('schemaVersion', 'n8nOrigin', 'hubOrigin', 'performanceHeader', 'outlook', 'cron', 'runtimeProviderVerified', 'activationFence'))
    if type(binding['schemaVersion']) is not int or binding['schemaVersion'] != 1 or binding['n8nOrigin'] != 'https://n8n.srv1866578.hstgr.cloud' or binding['hubOrigin'] != 'https://mam-team-management-system-ten.vercel.app':
        raise ValueError('HOLD_FOREIGN_TARGET')
    for name, keys in (('performanceHeader', ('id', 'name', 'headerName')), ('outlook', ('id', 'name', 'httpMeSender', 'identityVerified')), ('cron', ('id', 'name', 'identityVerified'))):
        ref = binding[name]
        closed(ref, keys)
        if not isinstance(ref['id'], str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,64}', ref['id']) or '__PARENT' in ref['id'] or not isinstance(ref['name'], str) or not ref['name'].strip() or len(ref['name']) > 200 or '__PARENT' in ref['name']:
            raise ValueError('HOLD_CREDENTIAL_REFERENCE')
    if binding['performanceHeader']['headerName'] != 'X-MAM-Performance-Secret' or binding['outlook']['identityVerified'] is not True or binding['cron']['identityVerified'] is not True or not isinstance(binding['outlook']['httpMeSender'], str) or not re.fullmatch(r'[a-z0-9._+-]+@mobilityaccess\.com\.au', binding['outlook']['httpMeSender']):
        raise ValueError('HOLD_VERIFIED_IDENTITY_REQUIRED')
    if type(binding['runtimeProviderVerified']) is not bool:
        raise ValueError('HOLD_RUNTIME_PROOF_SHAPE')
    closed(binding['activationFence'], ('hubMailModeDisabled', 'newOutboxEmpty', 'singleWriterVerified'))
    if any(value is not True for value in binding['activationFence'].values()):
        raise ValueError('HOLD_ACTIVATION_FENCE')


def bind_workflow(snapshot, binding):
    validate_binding(binding)
    name = 'scripts/build-performance-review-mail-workflow.py'
    scope = {'__name__': 'performance_builder_snapshot', '__file__': str(ROOT / name),
             '_SOURCE_TEXTS': {Path(key).name: value.decode() for key, value in snapshot.items() if key.startswith('deploy/n8n/') and key.endswith('.js')}}
    exec(compile(snapshot[name], str(ROOT / name), 'exec'), scope)
    graph = scope['build_workflow']()
    for node in graph['nodes']:
        if 'credentials' in node:
            kind = next(iter(node['credentials']))
            ref = binding['outlook'] if kind == 'microsoftOutlookOAuth2Api' else binding['cron'] if node['name'] == 'Dispatch New Performance Queue' else binding['performanceHeader']
            node['credentials'] = {kind: {'id': ref['id'], 'name': ref['name']}}
    return graph


def check_custody(snapshot, external):
    current, other = acquire()
    if current != snapshot or other != external:
        raise ValueError('HOLD_SOURCE_DRIFT')


def consume(packet, args, snapshot, external):
    closed(packet, ('closure', 'binding', 'review'))
    closure = closure_for(snapshot, external)
    if packet['closure'] != closure:
        raise ValueError('HOLD_CLOSURE_BINDING')
    binding = packet['binding']
    graph = bind_workflow(snapshot, binding)
    review = packet['review']
    closed(review, ('schemaVersion', 'independent', 'reviewer', 'passed', 'security_concerns', 'logic_errors', 'sourceHashes', 'bindingSha256', 'graphSha256', 'gates', 'expectedWorkflow', 'runtimeProviderVerified'))
    hashes = {**closure['sourceHashes'], **{'external:' + key: value for key, value in closure['externalHashes'].items()}, '$closure': digest(canonical(closure))}
    if type(review['schemaVersion']) is not int or review['schemaVersion'] != 1 or review['independent'] is not True or review['passed'] is not True or not isinstance(review['reviewer'], str) or not review['reviewer'].strip() or review['reviewer'] in ('n8n-owner', 'implementation-owner') or review['security_concerns'] != [] or review['logic_errors'] != [] or review['sourceHashes'] != hashes or review['bindingSha256'] != digest(canonical(binding)) or review['graphSha256'] != digest(canonical(graph)):
        raise ValueError('HOLD_INDEPENDENT_REVIEW')
    closed(review['gates'], ('stage', 'activate'))
    if any(type(value) is not bool for value in review['gates'].values()) or type(review['runtimeProviderVerified']) is not bool or review['runtimeProviderVerified'] != binding['runtimeProviderVerified']:
        raise ValueError('HOLD_REVIEW_GATE_SHAPE')
    if args['operation'] == 'stage' and (review['gates']['stage'] is not True or review['expectedWorkflow'] is not None):
        raise ValueError('HOLD_STAGE_REVIEW')
    if args['operation'] == 'activate' and (review['gates']['activate'] is not True or review['runtimeProviderVerified'] is not True or review['expectedWorkflow'] != {'id': args['--expected-id'], 'versionId': args['--expected-version']}):
        raise ValueError('HOLD_ACTIVATE_REVIEW')
    if args['operation'] == 'readback' and (not any(review['gates'].values()) or review['expectedWorkflow'] != {'id': args['--expected-id'], 'versionId': args['--expected-version']}):
        raise ValueError('HOLD_READBACK_REVIEW')
    check_custody(snapshot, external)
    return graph


def json_equal(left, right):
    if (isinstance(left, float) and not math.isfinite(left)) or (isinstance(right, float) and not math.isfinite(right)):
        return False
    if type(left) in (int, float) and type(right) in (int, float):
        return left == right
    if type(left) is not type(right):
        return False
    if isinstance(left, dict):
        return set(left) == set(right) and all(json_equal(value, right[key]) for key, value in left.items())
    if isinstance(left, list):
        return len(left) == len(right) and all(json_equal(a, b) for a, b in zip(left, right))
    return left == right


def validate_workflow(row, graph, active=False, expected_id=None, expected_version=None):
    if not isinstance(row, dict) or not isinstance(row.get('id'), str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,64}', row['id']) or not isinstance(row.get('versionId'), str) or not re.fullmatch(r'[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}', row['versionId']) or row.get('active') is not active or any(key not in row or not json_equal(row[key], value) for key, value in graph.items()) or (expected_id is not None and row['id'] != expected_id) or (expected_version is not None and row['versionId'] != expected_version) or 'activeVersionId' not in row or (active and row['activeVersionId'] != row['versionId']) or (not active and row['activeVersionId'] is not None):
        raise ValueError('HOLD_EXACT_WORKFLOW_READBACK')
    return row['id'], row['versionId']


def inventory_empty(ports, graph):
    paths = {'mam-people-hub-performance-review-mail-v1', 'mam-people-hub-performance-review-mail-v1-ready'}
    path = 'workflows?limit=25'
    seen_ids, seen_cursors = set(), set()
    total_bytes = 0
    for page in range(32):
        response = ports.api('GET', path)
        closed(response, ('data', 'nextCursor'))
        size = getattr(ports, 'last_response_bytes', None)
        size = len(canonical(response)) if size is None else size
        if type(size) is not int or not 0 <= size <= 8388608:
            raise ValueError('HOLD_INVENTORY_BODY_BOUND')
        total_bytes += size
        if total_bytes > 67108864:
            raise ValueError('HOLD_INVENTORY_TOTAL_BOUND')
        if not isinstance(response['data'], list) or len(response['data']) > 25:
            raise ValueError('HOLD_INVENTORY_COMPLETENESS')
        for row in response['data']:
            if not isinstance(row, dict) or not isinstance(row.get('id'), str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,64}', row['id']) or row['id'] in seen_ids or not isinstance(row.get('nodes'), list) or not isinstance(row.get('name'), str) or not row['name'] or row['name'] == graph['name']:
                raise ValueError('HOLD_EXISTING_WORKFLOW_OR_PATH')
            seen_ids.add(row['id'])
            for node in row['nodes']:
                if not isinstance(node, dict) or not isinstance(node.get('type'), str):
                    raise ValueError('HOLD_INVENTORY_NODE')
                if node['type'] == 'n8n-nodes-base.webhook':
                    parameters = node.get('parameters')
                    if not isinstance(parameters, dict) or not isinstance(parameters.get('path'), str) or parameters['path'] in paths:
                        raise ValueError('HOLD_EXISTING_WORKFLOW_OR_PATH')
        if len(seen_ids) > 800:
            raise ValueError('HOLD_INVENTORY_ROW_BOUND')
        cursor = response['nextCursor']
        if cursor is None:
            return
        if not isinstance(cursor, str) or not 1 <= len(cursor.encode('utf-8')) <= 2048 or cursor in seen_cursors or not response['data']:
            raise ValueError('HOLD_INVENTORY_CURSOR')
        seen_cursors.add(cursor)
        path = 'workflows?limit=25&cursor=' + quote(cursor, safe='')
    raise ValueError('HOLD_INVENTORY_PAGE_BOUND')


def stage(graph, packet, ports, journal, snapshot, external):
    if journal.load() is not None:
        raise ValueError('HOLD_JOURNAL_EXISTS')
    ports.verify()
    inventory_empty(ports, graph)
    check_custody(snapshot, external)
    state = {'schemaVersion': 1, 'owner': 'mam-performance-review-mail-v1', 'phase': 'HOLD_CREATE_UNKNOWN',
             'closureSha256': digest(canonical(packet['closure'])), 'bindingSha256': digest(canonical(packet['binding'])), 'identityBindingSha256': digest(canonical({**packet['binding'], 'runtimeProviderVerified': False})), 'graphSha256': digest(canonical(graph)),
             'dispatches': {'create': 1, 'activate': 0}, 'id': None, 'versionId': None}
    journal.save(state, initial=True)
    row = ports.api('POST', 'workflows', graph)
    identity, version = validate_workflow(row, graph)
    state.update({'id': identity, 'versionId': version})
    journal.save(state)
    readback = ports.api('GET', 'workflows/' + identity)
    validate_workflow(readback, graph, expected_id=identity, expected_version=version)
    check_custody(snapshot, external)
    state['phase'] = 'STAGED_INACTIVE'
    journal.save(state)
    return {'ok': True, 'phase': state['phase'], 'id': identity, 'versionId': version, 'active': False, 'runtimeProviderVerified': packet['binding']['runtimeProviderVerified']}


def owned_state(journal, graph, packet, args):
    state = journal.load()
    closed(state, ('schemaVersion', 'owner', 'phase', 'closureSha256', 'bindingSha256', 'identityBindingSha256', 'graphSha256', 'dispatches', 'id', 'versionId'))
    closed(state['dispatches'], ('create', 'activate'))
    if state['schemaVersion'] != 1 or state['owner'] != 'mam-performance-review-mail-v1' or state['phase'] not in ('STAGED_INACTIVE', 'ACTIVATED_VERIFIED') or state['closureSha256'] != digest(canonical(packet['closure'])) or state['identityBindingSha256'] != digest(canonical({**packet['binding'], 'runtimeProviderVerified': False})) or state['graphSha256'] != digest(canonical(graph)) or state['id'] != args['--expected-id'] or state['versionId'] != args['--expected-version'] or type(state['dispatches']['create']) is not int or state['dispatches']['create'] != 1 or type(state['dispatches']['activate']) is not int or state['dispatches']['activate'] != (1 if state['phase'] == 'ACTIVATED_VERIFIED' else 0):
        raise ValueError('HOLD_OWNERSHIP_STATE')
    return state


def activate(graph, packet, args, ports, journal, snapshot, external):
    state = owned_state(journal, graph, packet, args)
    if state['phase'] != 'STAGED_INACTIVE':
        raise ValueError('HOLD_ALREADY_ACTIVATED')
    ports.verify()
    row = ports.api('GET', 'workflows/' + state['id'])
    validate_workflow(row, graph, expected_id=state['id'], expected_version=state['versionId'])
    check_custody(snapshot, external)
    state['phase'] = 'HOLD_ACTIVATE_UNKNOWN'
    state['dispatches']['activate'] = 1
    journal.save(state)
    row = ports.api('POST', 'workflows/' + state['id'] + '/activate', {'versionId': state['versionId']})
    validate_workflow(row, graph, active=True, expected_id=state['id'], expected_version=state['versionId'])
    readback = ports.api('GET', 'workflows/' + state['id'])
    validate_workflow(readback, graph, active=True, expected_id=state['id'], expected_version=state['versionId'])
    check_custody(snapshot, external)
    state['phase'] = 'ACTIVATED_VERIFIED'
    journal.save(state)
    return {'ok': True, 'phase': state['phase'], 'id': state['id'], 'versionId': state['versionId'], 'active': True, 'runtimeProviderVerified': True}


def readback(graph, packet, args, ports, journal, snapshot, external):
    state = owned_state(journal, graph, packet, args)
    active = state['phase'] == 'ACTIVATED_VERIFIED'
    if active and (packet['review']['gates']['activate'] is not True or packet['review']['runtimeProviderVerified'] is not True):
        raise ValueError('HOLD_ACTIVE_READBACK_REVIEW')
    ports.verify()
    row = ports.api('GET', 'workflows/' + state['id'])
    validate_workflow(row, graph, active=active, expected_id=state['id'], expected_version=state['versionId'])
    check_custody(snapshot, external)
    return {'ok': True, 'phase': state['phase'], 'id': state['id'], 'versionId': state['versionId'], 'active': active}


def main(argv=None, stdin=None, ports=None, journal=None):
    argv = sys.argv[1:] if argv is None else argv
    native_journal = None
    attempt = None
    try:
        if argv == ['prepare']:
            snapshot, external = acquire()
            print(json.dumps({'closure': closure_for(snapshot, external), 'integrationReady': False, 'stageIntent': 'create-new-owned-inactive-only'}))
            return 0
        args = parse_args(argv)
        stream = sys.stdin if stdin is None else stdin
        body = stream.read(1048577)
        if len(body.encode()) > 1048576:
            raise ValueError('HOLD_INPUT_BOUND')
        packet = load_json(body)
        snapshot, external = acquire()
        graph = consume(packet, args, snapshot, external)
        if journal is None:
            if '--journal' not in args:
                raise ValueError('HOLD_JOURNAL_REQUIRED')
            attempt = AttemptFence(args, packet, graph)
            native_journal = NativeJournal(args['--journal'])
            retained = native_journal.load()
            if args['operation'] != 'stage' and not json_equal(retained, attempt.record['state']):
                raise ValueError('HOLD_CANONICAL_JOURNAL_BINDING')
            native_journal.fence = attempt
            journal = native_journal
        if ports is None:
            ports = NativePorts(packet['binding'], external)
        if native_journal is not None:
            native_journal.secrets = ports.secrets
            attempt.storage.secrets = ports.secrets
        if args['operation'] == 'stage':
            result = stage(graph, packet, ports, journal, snapshot, external)
        elif args['operation'] == 'activate':
            result = activate(graph, packet, args, ports, journal, snapshot, external)
        else:
            result = readback(graph, packet, args, ports, journal, snapshot, external)
        if native_journal is not None:
            reject_secret(result, native_journal.secrets)
            attempt.storage.finish()
            native_journal.finish()
        print(json.dumps(result))
        return 0
    except (Exception, KeyboardInterrupt, SystemExit):
        print('HOLD_PUBLICATION_NO_RETRY', file=sys.stderr)
        return 2
    finally:
        if native_journal is not None:
            native_journal.close()
        if attempt is not None:
            attempt.storage.close()


if __name__ == '__main__':
    raise SystemExit(main())
