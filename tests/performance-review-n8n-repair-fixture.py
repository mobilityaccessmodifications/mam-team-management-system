import copy
import hashlib
import io
import json
import os
from pathlib import Path
import stat
import sys
import time
from contextlib import redirect_stderr, redirect_stdout
from email.message import Message
from urllib.parse import parse_qs, quote, urlsplit
from urllib.request import HTTPSHandler, ProxyHandler, build_opener
from urllib.response import addinfourl

ROOT = Path(__file__).resolve().parents[1]
TARGET = ROOT / 'scripts/publish-performance-review-mail-workflow.py'
try:
    CASE = sys.argv[1]
    scratch = Path(sys.argv[2])
    if not scratch.is_absolute():
        raise ValueError
    scratch = scratch.resolve(strict=True)
    if not scratch.is_dir() or scratch == ROOT or ROOT in scratch.parents or not CASE or Path(CASE).name != CASE or '\0' in CASE:
        raise ValueError
except (IndexError, OSError, ValueError, RuntimeError):
    print('INVALID_FIXTURE_OUTPUT', file=sys.stderr)
    raise SystemExit(2)
OUT = scratch / ('performance-review-n8n-repair-' + str(os.getpid()) + '-' + str(time.monotonic_ns())) / (CASE + '-' + str(os.getpid()) + '-' + str(time.monotonic_ns()))
OUT.parent.mkdir(mode=0o700)
OUT.mkdir(parents=True, mode=0o700)
(OUT / 'SYNTHETIC_ONLY').write_text('INERT OWNED NAMESPACE; NO NETWORK OR REAL CONFIG\n')
source = TARGET.read_bytes()
original_read_bytes = Path.read_bytes
original_fsync = os.fsync
forbidden = {'credentialFile': 0, 'socket': 0, 'environment': 0, 'privateSource': 0}
metrics = {'configLoads': 0, 'mainDefaultEntrances': 0, 'compiledVerifier': [], 'fsyncs': [], 'requestTimeouts': [], 'acquisitions': 0}
external_paths = {
    '/Volumes/UG/MAM/opencode/n8n/scripts/verify.py': ('mam-verify.py', '6303d22c62b88c0fe80412be20987b7fb98b5c534e7447df1a950732a7516d8e'),
    '/Volumes/UG/MAM/opencode/.worktrees/mam-performance-production-20261016/qa-evidence/performance-release-20261016/mail-http-interface-supplement-v1.json': ('http-supplement.json', '0161974b76742648c1861c942411f59849217255606ba46b6cc4723e78ee2236'),
}
external_bytes = {}
for original, (name, pin) in external_paths.items():
    raw = original_read_bytes(ROOT / 'tests/performance-review-n8n-portable' / name)
    if name == 'mam-verify.py':
        raw += b'\n'
    assert hashlib.sha256(raw).hexdigest() == pin
    external_bytes[original] = raw


def read_bytes(self):
    return external_bytes[str(self)] if str(self) in external_bytes else original_read_bytes(self)


def audit(event, args):
    if event == 'compile' and args[1] == str(TARGET) and sys._getframe(1).f_code.co_name == 'acquire':
        metrics['acquisitions'] += 1
    if event == 'compile' and args[1] == '/Volumes/UG/MAM/opencode/n8n/scripts/verify.py':
        metrics['compiledVerifier'].append(hashlib.sha256(args[0]).hexdigest())
    if event == 'open' and isinstance(args[0], (str, bytes)):
        path = os.fsdecode(args[0])
        if Path(path).name in ('.env', '.env.local') or '/.ssh/' in path or 'Keychains' in path:
            forbidden['credentialFile'] += 1
            raise AssertionError('FORBIDDEN_CREDENTIAL_FILE')
        if path in external_paths:
            forbidden['privateSource'] += 1
            raise AssertionError('FORBIDDEN_PRIVATE_SOURCE')
    if event in ('os.mkdir', 'os.remove', 'os.rename') and isinstance(args[0], (str, bytes)) and os.fsdecode(args[0]).startswith('/Volumes/UG/MAM/opencode/n8n/'):
        forbidden['privateSource'] += 1
        raise AssertionError('FORBIDDEN_REAL_MAM_FILE_OPERATION')
    if event in ('socket.__new__', 'socket.connect', 'socket.bind', 'socket.getaddrinfo'):
        forbidden['socket'] += 1
        raise AssertionError('FORBIDDEN_SOCKET')


class EnvironmentTrap:
    def __getitem__(self, key):
        forbidden['environment'] += 1
        raise AssertionError('FORBIDDEN_ENVIRONMENT')

    get = __getitem__

    def __iter__(self):
        forbidden['environment'] += 1
        raise AssertionError('FORBIDDEN_ENVIRONMENT')


sys.addaudithook(audit)
os.environ = EnvironmentTrap()
Path.read_bytes = read_bytes


def fsync(fd):
    metrics['fsyncs'].append('directory' if stat.S_ISDIR(os.fstat(fd).st_mode) else 'file')
    if CASE.startswith('fsync-') and CASE != 'fsync-control' and len(metrics['fsyncs']) == int(CASE.split('-')[-1]):
        raise OSError('SYNTHETIC_FSYNC_UNCERTAINTY')
    return original_fsync(fd)


os.fsync = fsync
scope = {'__name__': 'inert_repair_fixture', '__file__': str(TARGET)}
exec(compile(source, str(TARGET), 'exec'), scope)
binding = {'schemaVersion': 1, 'n8nOrigin': 'https://n8n.srv1866578.hstgr.cloud', 'hubOrigin': 'https://mam-team-management-system-ten.vercel.app',
    'performanceHeader': {'id': 'syntheticHeader01', 'name': 'Synthetic header', 'headerName': 'X-MAM-Performance-Secret'},
    'outlook': {'id': 'syntheticOutlook01', 'name': 'Synthetic Outlook', 'httpMeSender': 'synthetic-sender@mobilityaccess.com.au', 'identityVerified': True},
    'cron': {'id': 'syntheticCron01', 'name': 'Synthetic Cron', 'identityVerified': True}, 'runtimeProviderVerified': False,
    'activationFence': {'hubMailModeDisabled': True, 'newOutboxEmpty': True, 'singleWriterVerified': True}}
snapshot, external = scope['acquire']()
closure = scope['closure_for'](snapshot, external)
graph = scope['bind_workflow'](snapshot, binding)
sha = lambda raw: hashlib.sha256(raw).hexdigest()
review = {'schemaVersion': 1, 'independent': True, 'reviewer': 'SYNTHETIC_ONLY_NOT_EXECUTION_ADMISSION', 'passed': True,
    'security_concerns': [], 'logic_errors': [], 'sourceHashes': {**closure['sourceHashes'], **{'external:' + k: v for k, v in closure['externalHashes'].items()}, '$closure': sha(scope['canonical'](closure))},
    'bindingSha256': sha(scope['canonical'](binding)), 'graphSha256': sha(scope['canonical'](graph)), 'gates': {'stage': True, 'activate': False}, 'expectedWorkflow': None, 'runtimeProviderVerified': False}
packet = {'closure': closure, 'binding': binding, 'review': review}
if CASE == 'false-source':
    review['passed'] = False
    review['independent'] = False
    review['gates'] = {'stage': False, 'activate': False}
marker = 'synthetic-repair-inert-not-real-api-key'
identifier = 'syntheticRepairOwned1'
version = '740f0100-0000-4000-8000-000000000001'
active = False
phase = 'stage'
calls = []
faults = []
fault_enabled = True
EXEC_TARGET = TARGET
loaded = source
tokens = {'nan': 'NaN', 'inf': 'Infinity', 'negative': '-Infinity', 'overflow': '1e999', 'duplicate': '0,"syntheticMetadata":1'}
inventory_responses = []
activation_bodies = []


def cursor(page):
    return 'opaque ' + str(page) + '+/=雪 %'


def inventory_page(url):
    query = parse_qs(urlsplit(url).query, strict_parsing=True)
    assert set(query) in ({'limit'}, {'limit', 'cursor'})
    limit = int(query['limit'][0])
    assert limit in (25, 250)
    page = 1 if 'cursor' not in query else {cursor(n): n for n in range(2, 40)}[query['cursor'][0]]
    if limit == 250:
        rows = range(1, 132)
    else:
        rows = range((page - 1) * 25 + 1, min(page * 25, 131) + 1)
        if CASE in ('inventory-pages', 'inventory-bytes'):
            rows = range((page - 1) * 25 + 1, page * 25 + 1)
    value = {'data': [{'id': 'syntheticInventory' + str(n), 'name': 'Synthetic inventory ' + str(n), 'nodes': []} for n in rows],
             'nextCursor': cursor(page + 1) if limit == 25 and (page < 6 or CASE in ('inventory-pages', 'inventory-bytes')) else None}
    terminal = page == 6 or limit == 250
    if terminal and CASE.startswith('inventory-') and CASE not in ('inventory-positive', 'inventory-pages', 'inventory-bytes'):
        fault = CASE.removeprefix('inventory-')
        faults.append('inventory-' + fault)
        if fault == 'duplicate': value['data'][0]['id'] = 'syntheticInventory1'
        elif fault == 'name': value['data'][0]['name'] = graph['name']
        elif fault in ('path', 'ready'):
            value['data'][0]['nodes'] = [{'type': 'n8n-nodes-base.webhook', 'parameters': {'path': 'mam-people-hub-performance-review-mail-v1' + ('-ready' if fault == 'ready' else '')}}]
        elif fault == 'missingcursor': value.pop('nextCursor')
        elif fault == 'missingdata': value.pop('data')
        elif fault == 'extra': value['unexpected'] = True
        elif fault == 'error': value = {'error': 'synthetic failure'}
        elif fault == 'badrows': value['data'] = {}
        elif fault == 'badid': value['data'][0]['id'] = False
        elif fault == 'badnode': value['data'][0]['nodes'] = [False]
        elif fault == 'emptycursor': value['nextCursor'] = ''
        elif fault == 'cursorbool': value['nextCursor'] = True
        elif fault == 'cursorlong': value['nextCursor'] = 'x' * 2049
        elif fault == 'secret': value['data'][0]['name'] = marker
        elif fault == 'manyrows': value['data'] = [{'id': 'syntheticOversize' + str(n), 'name': 'Synthetic row', 'nodes': []} for n in range(26)]
        elif fault in ('body', 'cycle') or fault.startswith('redirect'): pass
        else: raise AssertionError('UNKNOWN_INVENTORY_FAULT')
    if CASE == 'inventory-cycle' and page == 2:
        faults.append('inventory-cycle')
        value['nextCursor'] = cursor(2)
    raw = json.dumps(value, ensure_ascii=True).encode()
    if CASE == 'inventory-positive':
        size = 17450164 if limit == 250 else (3437301, 2720541, 1329416, 2387320, 5819378, 1756208)[page - 1]
        raw += b' ' * (size - len(raw))
    if CASE == 'inventory-body' and terminal: raw += b' ' * (8388609 - len(raw))
    if CASE == 'inventory-bytes': raw += b' ' * (7340032 - len(raw))
    if CASE == 'inventory-secret' and terminal:
        raw = raw.replace(marker.encode(), ''.join('\\u%04x' % ord(char) for char in marker).encode())
    inventory_responses.append({'page': page, 'limit': limit, 'bytes': len(raw), 'rows': len(value['data']) if isinstance(value.get('data'), list) else None, 'cursor': query.get('cursor')})
    return raw, terminal


class InertHTTPS(HTTPSHandler):
    def https_open(self, request):
        global active
        assert request.get_header('X-n8n-api-key') == marker
        assert request.full_url.startswith(binding['n8nOrigin'] + '/api/v1/')
        metrics['requestTimeouts'].append(request.timeout)
        role = 'verify' if request.full_url.endswith('?limit=1') else 'inventory'
        value = {'data': [], 'nextCursor': None}
        if request.full_url.endswith('/api/v1/workflows'):
            role = 'create'
            assert request.get_method() == 'POST' and json.loads(request.data) == graph
        elif request.full_url.endswith('/' + identifier + '/activate'):
            role = 'ack'
            assert request.get_method() == 'POST'
            activation_bodies.append(json.loads(request.data) if request.data is not None else None)
            active = True
        elif request.full_url.endswith('/' + identifier):
            role = 'final' if active else 'preactivate' if phase == 'activate' else 'first'
        calls.append({'method': request.get_method(), 'role': role, 'url': request.full_url})
        if role == 'create': metrics['createAtFsync'] = len(metrics['fsyncs'])
        if fault_enabled and CASE.startswith('fence-unknown') and role == 'create':
            faults.append(role)
            raise TimeoutError('SYNTHETIC_UNKNOWN_CREATE')
        if fault_enabled and CASE == 'fence-not-entered' and role == 'inventory':
            faults.append(role)
            raise TimeoutError('SYNTHETIC_NOT_ENTERED')
        if role in ('create', 'first', 'preactivate', 'ack', 'final'):
            value = {**copy.deepcopy(graph), 'id': identifier, 'versionId': version, 'active': active, 'activeVersionId': version if active else None}
        if CASE == 'activation-pinned-version' and role == 'ack' and request.data is None:
            value['versionId'] = value['activeVersionId'] = '740f0100-0000-4000-8000-000000000002'
        if CASE.startswith('exact-'):
            _, target_role, fault = CASE.split('-', 2)
            if role == target_role:
                faults.append(role)
                if fault == 'missing': value.pop('activeVersionId')
                elif fault == 'publication': value['activeVersionId'] = None if active else '740f0100-0000-4000-8000-000000000002'
                elif fault == 'settings': value['settings']['saveManualExecutions'] = 0
                elif fault == 'node': value['nodes'][0]['retryOnFail'] = 0
                elif fault == 'true': next(n for n in value['nodes'] if n['type'] == 'n8n-nodes-base.if')['parameters']['conditions']['conditions'][0]['rightValue'] = 1
                else: raise AssertionError('UNKNOWN_FAULT')
        raw = json.dumps(value).encode()
        if CASE == 'number-control':
            raw = json.dumps(json.loads(raw, parse_float=lambda number: int(float(number)) if float(number).is_integer() else float(number))).encode()
        status, headers = 200, Message()
        if CASE.startswith('inventory-') and role == 'inventory':
            raw, terminal = inventory_page(request.full_url)
            if terminal and CASE.startswith('inventory-redirect'):
                _, _, code, destination = CASE.split('-')
                status = int(code)
                headers['Location'] = request.full_url if destination == 'same' else 'https://synthetic.invalid/steal'
        if CASE.startswith('json-'):
            _, target_role, token = CASE.split('-', 2)
            if role == target_role:
                faults.append(role)
                raw = raw[:-1] + b',"syntheticMetadata":' + tokens[token].encode() + b'}'
        response = addinfourl(io.BytesIO(raw), headers, request.full_url, status)
        response.msg = 'Synthetic inert response'
        return response


def opener(*handlers):
    return build_opener(ProxyHandler({}), *handlers, InertHTTPS())


def patch_entry(frame, event, arg):
    if event == 'call' and frame.f_code.co_filename == str(EXEC_TARGET) and frame.f_code.co_name == 'main':
        assert all(frame.f_locals[k] is None for k in ('argv', 'stdin', 'ports', 'journal'))
        metrics['mainDefaultEntrances'] += 1
        unit = frame.f_globals
        loader = unit['load_verifier']

        def measured_loader(raw):
            verifier = loader(raw)

            def config_loader():
                metrics['configLoads'] += 1
                return {'N8N_INSTANCE_LABEL': 'MAM', 'N8N_BASE_URL': binding['n8nOrigin'], 'N8N_API_KEY': marker}

            verifier['load_local_env'] = config_loader
            verifier['build_opener'] = opener
            return verifier

        unit['load_verifier'] = measured_loader
        unit['build_opener'] = opener
        unit['ATTEMPT_ROOT'] = OUT / 'SYNTHETIC_CANONICAL_MAM_ROOT'
        sys.settrace(None)
    return patch_entry


def invoke(operation, path):
    args = [operation]
    if operation != 'readback': args.append('--parent-' + operation)
    args += ['--journal', str(path)]
    if operation != 'stage': args += ['--expected-id', identifier, '--expected-version', version]
    saved = sys.argv, sys.stdin
    wire = json.dumps(packet)
    if CASE == 'artifact-nonadmission':
        artifact = Path(sys.argv[3])
        assert ROOT in artifact.parents and artifact.name.endswith('.json')
        wire = artifact.read_text()
    if CASE.startswith('json-input-'):
        token = CASE.split('-')[-1]
        wire = wire.replace('"schemaVersion": 1', '"schemaVersion": ' + ('1,"schemaVersion":1' if token == 'duplicate' else tokens[token]), 1)
    sys.argv, sys.stdin = [str(EXEC_TARGET), *args], io.StringIO(wire)
    out, err = io.StringIO(), io.StringIO()
    before_calls, before_config, before_acquire = len(calls), metrics['configLoads'], metrics['acquisitions']
    try:
        with redirect_stdout(out), redirect_stderr(err):
            sys.settrace(patch_entry)
            try:
                exec(compile(loaded, str(EXEC_TARGET), 'exec'), {'__name__': '__main__', '__file__': str(EXEC_TARGET)})
            except SystemExit as exc:
                status = exc.code
    finally:
        sys.settrace(None)
        sys.argv, sys.stdin = saved
    return {'exit': status, 'stdout': out.getvalue(), 'stderr': err.getvalue(), 'calls': copy.deepcopy(calls[before_calls:]), 'configLoads': metrics['configLoads'] - before_config, 'acquisitions': metrics['acquisitions'] - before_acquire,
        'executedPath': str(EXEC_TARGET), 'executedSha256': sha(loaded), 'onDiskSha256': sha(original_read_bytes(EXEC_TARGET)), 'stdinSha256': sha(wire.encode()),
        'lockRetained': path.with_name(path.name + '.lock').exists(), 'canonicalLockRetained': (OUT / 'SYNTHETIC_CANONICAL_MAM_ROOT/attempt.json.lock').exists(), 'journal': json.loads(path.read_text(), parse_constant=lambda value: 'SYNTHETIC_NONFINITE', parse_float=lambda value: value) if path.is_file() else None}


if CASE == 'loaded-mismatch':
    fragment = b'with self.opener.open(request, timeout=20) as response:'
    assert source.count(fragment) == 1
    loaded = source.replace(fragment, b'with self.opener.open(request, timeout=19) as response:')
    (OUT / 'loaded-timeout19.py').write_bytes(loaded)
path = OUT / 'attempt.json'
steps = [invoke('stage', path)]
if (CASE in ('control', 'number-control', 'activation-pinned-version') or CASE.startswith(('exact-preactivate-', 'exact-ack-', 'exact-final-', 'json-preactivate-', 'json-ack-', 'json-final-', 'json-journal-'))) and (CASE != 'number-control' or steps[0]['exit'] == 0):
    assert steps[0]['exit'] == 0, 'VALID_STAGE_PREREQUISITE'
    phase = 'activate'
    binding['runtimeProviderVerified'] = True
    review.update(runtimeProviderVerified=True, bindingSha256=sha(scope['canonical'](binding)), gates={'stage': False, 'activate': True}, expectedWorkflow={'id': identifier, 'versionId': version})
    if CASE.startswith('json-journal-'):
        token = '"synthetic","bindingSha256":"synthetic"' if CASE.endswith('-duplicate') else tokens[CASE.split('-')[-1]]
        for file in (path, OUT / 'SYNTHETIC_CANONICAL_MAM_ROOT/attempt.json'):
            raw = file.read_text()
            old = '"bindingSha256":"' + sha(scope['canonical']({**binding, 'runtimeProviderVerified': False})) + '"'
            assert old in raw
            file.write_text(raw.replace(old, '"bindingSha256":' + token))
    steps.append(invoke('activate', path))
if CASE.startswith(('exact-', 'json-')):
    steps.append(invoke('activate' if phase == 'activate' else 'stage', path))
if CASE.startswith('fsync-') and CASE != 'fsync-control':
    steps.append(invoke('stage', path))
    steps.append(invoke('stage', OUT / 'alternate.json'))
if CASE.startswith('fence-'):
    fault_enabled = False
    if CASE == 'fence-unknown-unlock':
        lock = OUT / 'SYNTHETIC_CANONICAL_MAM_ROOT/attempt.json.lock'
        if lock.exists(): lock.unlink()
    steps.append(invoke('stage', path))
    steps.append(invoke('stage', OUT / 'alternate.json'))
    other = OUT / 'other-output'
    other.mkdir(mode=0o700)
    steps.append(invoke('stage', other / 'attempt.json'))
    scratch = Path(sys.argv[2]) / OUT.name
    assert scratch.parent.is_absolute() and scratch.parent.is_dir()
    scratch.mkdir(mode=0o700)
    alias = scratch / 'checkout-alias'
    alias.symlink_to(ROOT, target_is_directory=True)
    EXEC_TARGET = alias / TARGET.relative_to(ROOT)
    steps.append(invoke('stage', other / 'alias.json'))
    clone = scratch / 'SYNTHETIC_OTHER_CHECKOUT'
    for name, raw in snapshot.items():
        destination = clone / name
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(raw)
    EXEC_TARGET = clone / TARGET.relative_to(ROOT)
    steps.append(invoke('stage', other / 'checkout.json'))
    loaded = source + b'\n'
    EXEC_TARGET.write_bytes(loaded)
    alternate_scope = {'__name__': 'synthetic_revised_source', '__file__': str(EXEC_TARGET)}
    exec(compile(loaded, str(EXEC_TARGET), 'exec'), alternate_scope)
    alternate_snapshot, alternate_external = alternate_scope['acquire']()
    packet['closure'] = alternate_scope['closure_for'](alternate_snapshot, alternate_external)
    review['sourceHashes'] = {**packet['closure']['sourceHashes'], **{'external:' + k: v for k, v in packet['closure']['externalHashes'].items()}, '$closure': sha(scope['canonical'](packet['closure']))}
    steps.append(invoke('stage', other / 'revised-source.json'))
    (OUT / 'synthetic-checkout-transfer.json').write_text(json.dumps({'root': str(clone), 'originalClosure': closure, 'revisedClosure': packet['closure'], 'revisedRootSha256': sha(loaded)}, indent=2) + '\n')
assert all(value == 0 for value in forbidden.values())
assert marker not in json.dumps(steps)
serializer_rejected = None
if CASE.startswith('json-serializer-'):
    number = {'nan': float('nan'), 'inf': float('inf'), 'negative': float('-inf')}[CASE.split('-')[-1]]
    try:
        scope['canonical']({'metadata': number})
        serializer_rejected = False
    except ValueError:
        serializer_rejected = True
result = {'case': CASE, 'steps': steps, 'faults': faults, 'metrics': metrics, 'forbidden': forbidden, 'sourceSha256': sha(source), 'executedSha256': sha(loaded), 'closure': closure,
    'serializerRejected': serializer_rejected, 'nonfiniteEquality': scope['json_equal'](float('inf'), float('inf')),
    'inventoryResponses': inventory_responses,
    'activationBodies': activation_bodies,
    'namespace': str(OUT), 'classification': 'SYNTHETIC_ACTUAL_PUBLIC_MAIN_NO_NATIVE_ACCEPTANCE', 'actualStageAllowed': False, 'actualActivateAllowed': False, 'actualEmails': 0}
(OUT / 'result.json').write_text(json.dumps(result, indent=2) + '\n')
print(json.dumps(result))
