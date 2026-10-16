import base64
import io
import hashlib
import json
import os
import socket
import stat
import sys
import tempfile
from contextlib import redirect_stdout, redirect_stderr
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
input_data = json.load(sys.stdin)
fixture_temp_base = tempfile.gettempdir() if (input_data.get('scenario') or '').startswith('native-') else None
owned_artifacts = None
TARGET = ROOT / 'scripts/publish-performance-review-mail-workflow.py'
if not TARGET.is_file():
    print(json.dumps({'missingEntrypoint': True}))
    raise SystemExit(0)
source = TARGET.read_bytes()
forbidden = {'credentialFile': 0, 'socket': 0, 'environment': 0}
native_metrics = {'configLoads': 0, 'compiledVerifier': [], 'fsyncs': [], 'safeRequests': 0, 'cliEntered': False}


def audit(event, args):
    if event == 'compile' and args[1] == '/Volumes/UG/MAM/opencode/n8n/scripts/verify.py':
        native_metrics['compiledVerifier'].append(hashlib.sha256(args[0]).hexdigest())
    if event == 'open' and isinstance(args[0], (str, bytes)):
        path = os.fsdecode(args[0])
        if Path(path).name in ('.env', '.env.local') or 'Keychains' in path or '/.ssh/' in path:
            forbidden['credentialFile'] += 1
            raise AssertionError('FORBIDDEN_CREDENTIAL_FILE')
    if event in ('os.mkdir', 'os.remove', 'os.rename') and isinstance(args[0], (str, bytes)) and os.fsdecode(args[0]).startswith('/Volumes/UG/MAM/opencode/n8n/'):
        forbidden['credentialFile'] += 1
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
original_read_bytes = Path.read_bytes
portable = ROOT / 'tests/performance-review-n8n-portable'
external_sources = {
    '/Volumes/UG/MAM/opencode/n8n/scripts/verify.py': ('mam-verify.py', '6303d22c62b88c0fe80412be20987b7fb98b5c534e7447df1a950732a7516d8e'),
    '/Volumes/UG/MAM/opencode/.worktrees/mam-performance-production-20261016/qa-evidence/performance-release-20261016/mail-http-interface-supplement-v1.json': ('http-supplement.json', '0161974b76742648c1861c942411f59849217255606ba46b6cc4723e78ee2236'),
}
external_bytes = {}
for original, (filename, pin) in external_sources.items():
    raw = original_read_bytes(portable / filename)
    if filename == 'mam-verify.py':
        raw += b'\n'
    assert hashlib.sha256(raw).hexdigest() == pin
    external_bytes[original] = raw


def portable_read_bytes(self):
    return external_bytes[str(self)] if str(self) in external_bytes else original_read_bytes(self)


Path.read_bytes = portable_read_bytes
namespace: dict = {'__name__': 'performance_publisher_fixture', '__file__': str(TARGET)}
exec(compile(source, str(TARGET), 'exec'), namespace)
out = io.StringIO()
err = io.StringIO()
calls = []
state = None


class MemoryJournal:
    def __init__(self, value=None):
        self.value = value

    def load(self):
        return self.value

    def save(self, value, initial=False):
        if initial and self.value is not None:
            raise ValueError('HOLD_JOURNAL_EXISTS')
        self.value = json.loads(json.dumps(value))


class InertPorts:
    def __init__(self, graph, scenario):
        self.graph = graph
        self.scenario = scenario

    def verify(self):
        calls.append(['VERIFY', 'MAM'])

    def api(self, method, path, body=None):
        calls.append([method, path])
        if path.startswith('workflows?'):
            return {'data': [], 'nextCursor': None}
        row = {**self.graph, 'id': 'syntheticOwnedW1', 'active': getattr(self, 'active', False), 'versionId': '740f0100-0000-4000-8000-000000000001', 'activeVersionId': '740f0100-0000-4000-8000-000000000001' if getattr(self, 'active', False) else None}
        if method == 'POST' and path == 'workflows':
            assert set(body) == {'name', 'nodes', 'connections', 'settings'}
            assert body == self.graph
            if self.scenario == 'create-timeout': raise TimeoutError('synthetic unknown create')
            if self.scenario == 'create-active': row['active'] = True
            if self.scenario == 'create-id-shape': row['id'] = '../../foreign'
        if method == 'GET' and path.startswith('workflows/'):
            if self.scenario in ('first-readback-version', 'activate-pre-version'): row['versionId'] = '740f0100-0000-4000-8000-000000000002'
            if self.scenario == 'first-readback-id': row['id'] = 'differentOwnedID'
            if self.scenario == 'first-readback-graph': row['connections'] = {}
            if self.scenario == 'activate-already-active': row['active'] = True
        if method == 'POST' and path.endswith('/activate'):
            assert body == {'versionId': '740f0100-0000-4000-8000-000000000001'}
            self.active = True
            row['active'] = True; row['activeVersionId'] = row['versionId']
            if self.scenario == 'activate-timeout': raise TimeoutError('synthetic unknown activation')
            if self.scenario == 'activate-post-version': row['activeVersionId'] = '740f0100-0000-4000-8000-000000000002'
        return row


scenario = input_data.get('scenario')
argv = input_data['argv']
stdin = input_data.get('stdin', '')
ports = None
memory = None
journal_path = None
journal_root = None
binding = {}
review = {}
packet = {}
external = {}
snapshot = {}
marker = ''
if scenario:
    snapshot, external = namespace['acquire']()
    closure = namespace['closure_for'](snapshot, external)
    binding = {
        'schemaVersion': 1, 'n8nOrigin': 'https://n8n.srv1866578.hstgr.cloud', 'hubOrigin': 'https://mam-team-management-system-ten.vercel.app',
        'performanceHeader': {'id': 'syntheticHeader01', 'name': 'Synthetic task header', 'headerName': 'X-MAM-Performance-Secret'},
        'outlook': {'id': 'syntheticOutlook01', 'name': 'Synthetic Outlook', 'httpMeSender': 'synthetic-sender@mobilityaccess.com.au', 'identityVerified': True},
        'cron': {'id': 'syntheticCron01', 'name': 'Synthetic cron', 'identityVerified': True},
        'runtimeProviderVerified': False,
        'activationFence': {'hubMailModeDisabled': True, 'newOutboxEmpty': True, 'singleWriterVerified': True},
    }
    graph = namespace.get('bind_workflow', lambda *args: {})(snapshot, binding)
    review_hashes = {**closure['sourceHashes'], **{'external:' + key: value for key, value in closure['externalHashes'].items()}, '$closure': namespace['digest'](namespace['canonical'](closure))}
    review = {'schemaVersion': 1, 'independent': True, 'reviewer': 'synthetic-independent-review-port', 'passed': True,
              'security_concerns': [], 'logic_errors': [], 'sourceHashes': review_hashes,
              'bindingSha256': namespace['digest'](namespace['canonical'](binding)), 'graphSha256': namespace['digest'](namespace['canonical'](graph)),
              'gates': {'stage': True, 'activate': False}, 'expectedWorkflow': None, 'runtimeProviderVerified': False}
    packet = {'closure': closure, 'binding': binding, 'review': review}
    if scenario in ('wrong-source', 'native-wrong-source'): packet['closure']['sourceHashes'].pop(next(iter(packet['closure']['sourceHashes'])))
    if scenario == 'missing-self-pin': review['sourceHashes'].pop('$closure')
    if scenario == 'foreign-target': binding['n8nOrigin'] = 'https://synthetic.invalid'
    if scenario in ('false-review', 'native-false-review'): review['independent'] = False
    if scenario == 'placeholder': binding['outlook']['id'] = '__PARENT_OUTLOOK_ID__'
    stdin = json.dumps(packet)
    ports = InertPorts(graph, scenario)
    memory = MemoryJournal()
if scenario and (scenario.startswith('activate-') or scenario == 'readback-positive'):
    ports.scenario = 'stage-positive'
    with redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
        stage_exit = namespace['main'](['stage', '--parent-stage'], io.StringIO(stdin), ports, memory)
    assert stage_exit == 0
    calls.clear()
    ports.scenario = scenario
    binding['runtimeProviderVerified'] = True
    review['runtimeProviderVerified'] = True
    review['bindingSha256'] = namespace['digest'](namespace['canonical'](binding))
    review['gates']['activate'] = True
    review['expectedWorkflow'] = {'id': 'syntheticOwnedW1', 'versionId': '740f0100-0000-4000-8000-000000000001'}
    if scenario == 'activate-runtime-unverified':
        binding['runtimeProviderVerified'] = False
        review['runtimeProviderVerified'] = False
        review['bindingSha256'] = namespace['digest'](namespace['canonical'](binding))
    if scenario == 'activate-no-review': review['gates']['activate'] = False
    stdin = json.dumps(packet)
if scenario and scenario.startswith('native-'):
    import urllib.request
    from urllib.response import addinfourl
    from email.message import Message
    original_loader = namespace['load_verifier']
    native_active = False
    original_fsync = os.fsync
    fault_enabled = True
    marker = '740f0100-0000-4000-8000-000000000099' if scenario == 'native-secret-version' else 'synthetic-api-key-for-inert-fixture'

    def fsync(fd):
        native_metrics['fsyncs'].append('directory' if stat.S_ISDIR(os.fstat(fd).st_mode) else 'file')
        if fault_enabled and scenario.startswith('native-fsync-') and len(native_metrics['fsyncs']) == int(scenario.split('-')[-1]):
            raise OSError('synthetic fsync uncertainty')
        return original_fsync(fd)

    os.fsync = fsync

    class InertHTTPS(urllib.request.HTTPSHandler):
        def https_open(self, request):
            global native_active
            calls.append([request.get_method(), request.full_url])
            assert request.get_header('X-n8n-api-key') == marker
            assert request.full_url.startswith('https://n8n.srv1866578.hstgr.cloud/api/v1/')
            assert 0 < request.timeout <= 20
            native_metrics['safeRequests'] += 1
            headers = Message()
            status = 200
            data = {'data': [], 'nextCursor': None}
            role = 'verify' if request.full_url.endswith('workflows?limit=1') else 'inventory'
            if request.full_url.endswith('/api/v1/workflows'):
                role = 'create'
                native_metrics['createAtFsync'] = len(native_metrics['fsyncs'])
                assert request.get_method() == 'POST'
                assert json.loads(request.data) == graph
                if scenario == 'native-create-timeout': raise TimeoutError('synthetic unknown create')
                if scenario == 'native-create-interrupt': raise KeyboardInterrupt()
                data = {**graph, 'id': 'syntheticOwnedW1', 'active': False, 'versionId': '740f0100-0000-4000-8000-000000000001', 'activeVersionId': None}
                if scenario in ('native-secret-echo', 'native-secret-key'): data['id'] = marker
                if scenario == 'native-secret-version': data['versionId'] = marker
                if scenario == 'native-secret-key': data[marker] = 'synthetic value'
            elif request.full_url.endswith('/api/v1/workflows/syntheticOwnedW1/activate'):
                role = 'activate'
                assert request.get_method() == 'POST' and json.loads(request.data) == {'versionId': '740f0100-0000-4000-8000-000000000001'}
                native_active = True
                if scenario == 'native-activate-timeout': raise TimeoutError('synthetic unknown activation')
                data = {**graph, 'id': 'syntheticOwnedW1', 'active': True, 'versionId': '740f0100-0000-4000-8000-000000000001', 'activeVersionId': '740f0100-0000-4000-8000-000000000001'}
            elif request.full_url.endswith('/api/v1/workflows/syntheticOwnedW1'):
                role = 'readback'
                data = {**graph, 'id': 'syntheticOwnedW1', 'active': native_active, 'versionId': '740f0100-0000-4000-8000-000000000001', 'activeVersionId': '740f0100-0000-4000-8000-000000000001' if native_active else None}
                if scenario == 'native-readback-version': data['versionId'] = '740f0100-0000-4000-8000-000000000002'
            if fault_enabled and 'redirect-' in scenario:
                parts = scenario.split('-')
                position = parts.index('redirect') + 1
                redirect_role = parts[position] if parts[position] in ('verify', 'create', 'readback', 'activate') else 'inventory'
                if role == redirect_role:
                    status = int(parts[-2])
                    headers['Location'] = request.full_url if parts[-1] == 'same' else 'https://synthetic.invalid/steal' if parts[-1] == 'foreign' else 'http://n8n.srv1866578.hstgr.cloud/api/v1/workflows'
            body = json.dumps(data).encode()
            if role == 'create' and scenario.startswith('native-secret-'):
                body = body.replace(marker.encode(), ''.join('\\u%04x' % ord(char) for char in marker).encode())
                assert marker.encode() not in body
            if role == 'inventory' and scenario == 'native-body-bound': body = b' ' * 8388609
            if role == 'inventory' and scenario == 'native-http-error': status = 503
            response = addinfourl(io.BytesIO(body), headers, request.full_url, status)
            response.msg = 'Synthetic response'
            return response

    def opener(*handlers):
        import ssl
        return urllib.request.build_opener(urllib.request.ProxyHandler({}), *handlers, InertHTTPS(context=ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)))

    def verifier_loader(*args):
        result = original_loader(*args)
        config = {'N8N_INSTANCE_LABEL': 'MAM', 'N8N_BASE_URL': 'https://n8n.srv1866578.hstgr.cloud', 'N8N_API_KEY': marker}
        variants = {'http': 'http://n8n.srv1866578.hstgr.cloud', 'userinfo': 'https://@n8n.srv1866578.hstgr.cloud', 'query': 'https://n8n.srv1866578.hstgr.cloud?', 'fragment': 'https://n8n.srv1866578.hstgr.cloud#', 'path': 'https://n8n.srv1866578.hstgr.cloud/other', 'port': 'https://n8n.srv1866578.hstgr.cloud:443', 'foreign': 'https://synthetic.invalid'}
        if scenario == 'native-foreign-config': config['N8N_BASE_URL'] = variants['foreign']
        if scenario.startswith('native-config-'): config['N8N_BASE_URL'] = variants[scenario.split('-')[-1]]

        def config_loader():
            native_metrics['configLoads'] += 1
            return config.copy()

        result['load_local_env'] = config_loader
        result['build_opener'] = opener
        return result

    namespace['load_verifier'] = verifier_loader
    namespace['build_opener'] = opener
    ports = None
    owned_artifacts = tempfile.TemporaryDirectory(prefix='mam-performance-n8n-', dir=fixture_temp_base)
    journal_root = Path(owned_artifacts.name).resolve()
    assert journal_root != ROOT and ROOT not in journal_root.parents
    journal_path = journal_root / ('inert-' + scenario + '-' + str(os.getpid()) + '-' + str(namespace['time'].monotonic_ns()) + '.json')
    namespace['ATTEMPT_ROOT'] = journal_root / (journal_path.stem + '-SYNTHETIC-CANONICAL')
    assert not journal_path.exists()
    if scenario == 'native-journal-fifo':
        os.mkfifo(journal_path, 0o600)
    if scenario == 'native-journal-symlink':
        target = journal_path.with_name(journal_path.name + '.synthetic-target')
        target.write_text('synthetic protected bytes\n')
        journal_path.symlink_to(target)
    argv = [*argv, '--journal', str(journal_path)]
    memory = None
    if scenario.startswith('native-activate-') or scenario in ('native-cli-activate', 'native-readback-positive'):
        fault_enabled = False
        with redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
            seed_exit = namespace['main'](['stage', '--parent-stage', '--journal', str(journal_path)], io.StringIO(stdin))
        assert seed_exit == 0
        calls.clear()
        native_metrics['fsyncs'].clear()
        native_metrics['safeRequests'] = 0
        fault_enabled = True
        binding['runtimeProviderVerified'] = True
        review['runtimeProviderVerified'] = True
        review['bindingSha256'] = namespace['digest'](namespace['canonical'](binding))
        review['gates']['activate'] = True
        review['expectedWorkflow'] = {'id': 'syntheticOwnedW1', 'versionId': '740f0100-0000-4000-8000-000000000001'}
        stdin = json.dumps(packet)


def invoke_main():
    if scenario not in ('native-cli-stage', 'native-cli-activate'):
        return namespace['main'](argv, io.StringIO(stdin), ports, memory)
    saved_argv, saved_stdin = sys.argv, sys.stdin
    sys.argv, sys.stdin = [str(TARGET), *argv], io.StringIO(stdin)

    def trace(frame, event, arg):
        if event == 'call' and frame.f_code.co_filename == str(TARGET) and frame.f_code.co_name == 'main':
            assert all(frame.f_locals[key] is None for key in ('argv', 'stdin', 'ports', 'journal'))
            frame.f_globals['load_verifier'] = verifier_loader
            frame.f_globals['build_opener'] = opener
            frame.f_globals['ATTEMPT_ROOT'] = namespace['ATTEMPT_ROOT']
            native_metrics['cliEntered'] = True
            sys.settrace(None)
        return trace

    try:
        sys.settrace(trace)
        exec(compile(source, str(TARGET), 'exec'), {'__name__': '__main__', '__file__': str(TARGET)})
    except SystemExit as result:
        return result.code
    finally:
        sys.settrace(None)
        sys.argv, sys.stdin = saved_argv, saved_stdin


with redirect_stdout(out), redirect_stderr(err):
    exit_code = invoke_main()
native_metrics['firstAttemptFsyncs'] = list(native_metrics['fsyncs'])
retry_exit = None
if scenario in ('create-timeout', 'create-active', 'create-id-shape', 'first-readback-version', 'first-readback-id', 'first-readback-graph', 'activate-timeout', 'activate-post-version'):
    before_retry = len(calls)
    ports.scenario = 'stage-positive'
    with redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
        retry_exit = namespace['main'](argv, io.StringIO(stdin), ports, memory)
    assert len(calls) == before_retry
if scenario and scenario.startswith('native-') and exit_code != 0:
    before_retry = len(calls)
    before_config = native_metrics['configLoads']
    with redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
        retry_exit = namespace['main'](argv, io.StringIO(stdin))
    assert len(calls) == before_retry
    assert native_metrics['configLoads'] == before_config
journal_value = memory.value if memory else None
native_metrics['retryFsyncs'] = native_metrics['fsyncs'][len(native_metrics['firstAttemptFsyncs']):]


def artifact_info(path):
    try:
        return path.lstat()
    except FileNotFoundError:
        return None


journal_info = artifact_info(journal_path) if journal_path is not None else None
if journal_path is not None and journal_info is not None and stat.S_ISREG(journal_info.st_mode):
    journal_value = json.loads(journal_path.read_text())
if journal_path is not None:
    native_metrics['outputLock'] = journal_path.with_name(journal_path.name + '.lock').exists()
    native_metrics['canonicalLock'] = (namespace['ATTEMPT_ROOT'] / 'attempt.json.lock').exists()
    native_metrics['stickyLock'] = native_metrics['outputLock'] or native_metrics['canonicalLock']
    native_metrics['journalMode'] = oct(stat.S_IMODE(journal_info.st_mode)) if journal_info is not None else None
    native_metrics['secretInJournal'] = any(marker.encode() in path.read_bytes() for path in (journal_path, journal_path.with_name(journal_path.name + '.pending'), namespace['ATTEMPT_ROOT'] / 'attempt.json', namespace['ATTEMPT_ROOT'] / 'attempt.json.pending') if (info := artifact_info(path)) is not None and stat.S_ISREG(info.st_mode))
    native_metrics['expectedVerifierHash'] = namespace['digest'](external['MAM_VERIFY'])
case_result = {'missingEntrypoint': False, 'exit': exit_code, 'retryExit': retry_exit, 'stdout': out.getvalue(), 'stderr': err.getvalue(), 'forbidden': forbidden, 'calls': calls, 'journal': journal_value, 'native': native_metrics}
if owned_artifacts is not None:
    assert journal_root is not None
    captured = []

    def capture_artifact(path):
        info = path.lstat()
        row = {'path': str(path.relative_to(journal_root)), 'mode': oct(stat.S_IMODE(info.st_mode)), 'inode': info.st_ino, 'device': info.st_dev, 'bytes': info.st_size}
        if stat.S_ISDIR(info.st_mode):
            row['type'] = 'directory'
        elif stat.S_ISLNK(info.st_mode):
            row.update(type='symlink', target=os.readlink(path))
        elif stat.S_ISFIFO(info.st_mode):
            row['type'] = 'fifo'
        elif stat.S_ISREG(info.st_mode):
            raw = path.read_bytes()
            row.update(type='regular', sha256=hashlib.sha256(raw).hexdigest())
            if marker.encode() not in raw:
                row['contentBase64'] = base64.b64encode(raw).decode('ascii')
            else:
                row['secretContentWithheld'] = True
        else:
            raise AssertionError('UNEXPECTED_SYNTHETIC_ARTIFACT_TYPE')
        captured.append(row)
        if row['type'] == 'directory':
            for child in sorted(path.iterdir()):
                capture_artifact(child)

    try:
        capture_artifact(journal_root)
        case_result['fixtureArtifacts'] = {'classification': 'SYNTHETIC_INERT_TYPED_CAPTURE_BEFORE_OWNED_CLEANUP', 'root': str(journal_root), 'entries': captured, 'argv': argv, 'publisherSha256': hashlib.sha256(source).hexdigest(), 'closure': namespace['closure_for'](snapshot, external), 'capturedAfterRetry': retry_exit, 'logicalStickyLockBeforeCleanup': native_metrics['stickyLock']}
    finally:
        owned_artifacts.cleanup()
    case_result['fixtureArtifacts']['cleanupComplete'] = artifact_info(journal_root) is None
    assert case_result['fixtureArtifacts']['cleanupComplete']
print(json.dumps(case_result))
