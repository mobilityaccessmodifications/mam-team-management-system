import atexit
import contextlib
import copy
import importlib.util
import io
import json
from pathlib import Path
import socket
import sys
import tempfile
import time
from urllib.parse import quote
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
path = ROOT / 'scripts/publish-performance-review-master-sync-workflow.py'
spec = importlib.util.spec_from_file_location('master_publisher_fixture', path)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
owned_source = tempfile.TemporaryDirectory(prefix='masterpubsource')
atexit.register(owned_source.cleanup)
module.NROOT = Path(owned_source.name) / 'n8n'
(module.NROOT / 'scripts').mkdir(parents=True)
(module.NROOT / 'scripts/verify.py').write_text("raise AssertionError('An inert fixture must never execute the native verifier')" + chr(10))
source = module.acquire()
c = source[0]
packet = {'schemaVersion': 1, 'sourceHashes': source[3], 'credentials': {
    'hub': {'id': 'synthetic-master-hub', 'name': 'Synthetic Master Hub Header'},
    'gateway': {'id': 'synthetic-master-gateway', 'name': 'Synthetic Master Gateway Header'}}}
graph = module.graph_for(source, packet['credentials'])
packet['review'] = {'reviewer': 'synthetic-independent-reviewer', 'independent': True, 'passed': True,
    'security_concerns': [], 'logic_errors': [], 'sourceHashes': source[3],
    'packetSha256': c.digest(c.canonical(packet)), 'graphSha256': c.digest(c.canonical(graph)),
    'gates': {'stage': True, 'activate': False, 'dispatch': False}, 'validUntilUnix': int(time.time()) + 3600}
assert 'active' not in graph and graph['nodes'][0]['disabled'] is True
assert module.graph_for(source)['nodes'][0]['disabled'] is True


class Ports:
    secrets = ('SYNTHETIC-SECRET-NEVER-PERSIST',)
    def __init__(self, unknown=False):
        self.unknown = unknown
        self.creates = self.activations = self.readbacks = self.verifies = 0
        self.body_faults = 0
    def verify(self):
        self.verifies += 1
    def api(self, method, path, body=None):
        assert path != 'workflows/activate'
        if method == 'POST':
            assert path == 'workflows' and body == graph and 'active' not in body
            self.creates += 1
            if self.unknown:
                raise TimeoutError(self.secrets[0])
            return {**copy.deepcopy(graph), 'id': 'synthetic-master-owned', 'versionId': 'd7200000-0000-4000-8000-000000000001', 'active': False, 'activeVersionId': None}
        assert method == 'GET'
        if path == 'workflows?limit=25':
            self.body_faults += 1
            raise ValueError('HOLD_HTTP_BODY_BOUND')
        if path == 'workflows?limit=1&name=' + quote(graph['name'], safe=''):
            return {'data': [], 'nextCursor': None}
        assert path == 'workflows/synthetic-master-owned'
        self.readbacks += 1
        return {**copy.deepcopy(graph), 'id': 'synthetic-master-owned', 'versionId': 'd7200000-0000-4000-8000-000000000001', 'active': False, 'activeVersionId': None, 'activeVersion': None}


def invoke(args, ports, value=packet, journal=None):
    out, err = io.StringIO(), io.StringIO()
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
        code = module.main(args, io.StringIO(json.dumps(value)), ports=ports, journal=journal)
    assert ports.secrets[0] not in out.getvalue() + err.getvalue()
    return code, out.getvalue(), err.getvalue()


def byte_cap_cases(root):
    def forbidden(*args, **kwargs):
        raise AssertionError('An inert fixture must never use network or native configuration')

    class Response(io.BytesIO):
        status = 200

    class MemoryOpener:
        def __init__(self, sizes):
            self.sizes = sizes
            self.inventory = self.wire = self.creates = self.readbacks = 0
        def open(self, request, timeout=20):
            method = request.get_method()
            path = request.full_url.split('/api/v1/', 1)[1]
            if method == 'GET' and path.startswith(module.INVENTORY_QUERY):
                number = self.inventory + 1
                assert number <= len(self.sizes)
                assert path == module.INVENTORY_QUERY + ('' if number == 1 else '&cursor=cursor-' + str(number - 1))
                row = {'data': [{'id': 'synthetic-other-' + str(number),
                    'name': module.NAME + ' - archived variant ' + str(number)}],
                    'nextCursor': 'cursor-' + str(number) if number < len(self.sizes) else None}
                raw = c.canonical(row)
                size = self.sizes[number - 1]
                if size is not None:
                    assert size >= len(raw)
                    raw += b' ' * (size - len(raw))
                self.inventory += 1
                self.wire += len(raw)
                return Response(raw)
            if method == 'POST':
                assert path == 'workflows' and c.json_equal(c.load_json(request.data), graph)
                self.creates += 1
                return Response(c.canonical({**copy.deepcopy(graph), 'id': 'synthetic-master-owned',
                    'versionId': 'd7200000-0000-4000-8000-000000000001', 'active': False, 'activeVersionId': None}))
            assert method == 'GET' and path == 'workflows/synthetic-master-owned'
            self.readbacks += 1
            return Response(c.canonical({**copy.deepcopy(graph), 'id': 'synthetic-master-owned',
                'versionId': 'd7200000-0000-4000-8000-000000000001', 'active': False,
                'activeVersionId': None, 'activeVersion': None}))

    class InertNativePorts(c.NativePorts):
        def __init__(self, sizes):
            self.origin = 'https://n8n.srv1866578.hstgr.cloud'
            self.key = 'SYNTHETIC-SECRET-NEVER-PERSIST'
            self.secrets = (self.key,)
            self.memory = MemoryOpener(sizes)
            self.opener = c.SafeOpener(self.memory, self.origin, self.secrets)
        def verify(self):
            pass

    class MetadataPorts(InertNativePorts):
        def __init__(self, size, missing=False):
            super().__init__([None])
            self.size, self.missing = size, missing
        def api(self, method, path, body=None):
            row = super().api(method, path, body)
            if path.startswith(module.INVENTORY_QUERY):
                if self.missing:
                    del self.last_response_bytes
                else:
                    self.last_response_bytes = self.size
            return row

    class OversizedFallbackPorts(Ports):
        def api(self, method, path, body=None):
            if path == module.INVENTORY_QUERY:
                return {'data': [{'id': 'synthetic-oversize', 'name': 'x' * 8388608}], 'nextCursor': None}
            return super().api(method, path, body)

    cases = [
        ('wire-exact-64m', InertNativePorts([8388608] * 8)),
        ('wire-over-64m', InertNativePorts([8388608] * 9)),
        ('wire-over-64m-by-one', InertNativePorts([8388608] * 7 + [8388608 - 1023, 1024])),
        ('wire-over-page', InertNativePorts([8388609])),
        *[('raw-' + name, MetadataPorts(size)) for name, size in (
            ('true', True), ('false', False), ('negative', -1), ('over-page', 8388609),
            ('float', 1.0), ('string', '1'), ('list', []), ('object', {}),
            ('zero', 0), ('exact-page', 8388608))],
        ('fallback-none', MetadataPorts(None)),
        ('fallback-missing', MetadataPorts(None, missing=True)),
        ('fallback-over-page', OversizedFallbackPorts()),
    ]
    original_socket, original_urlopen = socket.socket, urllib.request.urlopen
    socket.socket = urllib.request.urlopen = forbidden
    results = []
    try:
        for name, ports in cases:
            module.JOURNAL_ROOT = root / name
            code, out, err = invoke(['stage', '--parent-stage-inactive'], ports)
            state_path = module.JOURNAL_ROOT / 'attempt.json'
            state = c.load_json(state_path.read_bytes()) if state_path.exists() else None
            native = isinstance(ports, InertNativePorts)
            results.append({'case': name, 'exit': code,
                'creates': ports.memory.creates if native else ports.creates,
                'readbacks': ports.memory.readbacks if native else ports.readbacks,
                'inventoryPages': ports.memory.inventory if native else None,
                'inventoryWireBytes': ports.memory.wire if native else None,
                'phase': None if state is None else state['phase'],
                'lockExists': (module.JOURNAL_ROOT / 'attempt.json.lock').exists(),
                'stdout': out, 'stderr': err})
    finally:
        socket.socket, urllib.request.urlopen = original_socket, original_urlopen
    return results


if sys.argv[1:] == ['--byte-cap']:
    with tempfile.TemporaryDirectory(prefix='masterpubbytes') as value:
        print(json.dumps({'classification': 'ACTUAL_PUBLIC_ENTRY_NATIVE_API_SAFEOPENER_MEMORY_HTTP',
            'cases': byte_cap_cases(Path(value))}))
    raise SystemExit(0)
assert not sys.argv[1:]


with tempfile.TemporaryDirectory(prefix='masterpub') as value:
    root = Path(value)
    module.JOURNAL_ROOT = root / 'positive'
    ports = Ports()
    code, out, err = invoke(['stage', '--parent-stage-inactive'], ports)
    if code != 0:
        assert ports.body_faults == 1
    assert code == 0, ('Name-filtered inventory must avoid the observed 25-workflow body cap', code, out, err)
    receipt = json.loads(out)
    assert receipt['active'] is False and receipt['runtimeProviderVerified'] is False
    assert ports.creates == 1 and ports.readbacks == 1
    assert not (module.JOURNAL_ROOT / 'attempt.json.lock').exists()
    code, _, _ = invoke(['stage', '--parent-stage-inactive'], ports)
    assert code == 2 and ports.creates == 1
    code, out, err = invoke(['readback'], ports)
    assert code == 0, (code, out, err)
    assert ports.creates == 1 and ports.readbacks == 2
    assert invoke(['activate'], ports)[0] == 2 and ports.activations == 0
    module.JOURNAL_ROOT = root / 'unknown'
    unknown = Ports(unknown=True)
    assert invoke(['stage', '--parent-stage-inactive'], unknown)[0] == 2
    assert (module.JOURNAL_ROOT / 'attempt.json.lock').exists()
    state = json.loads((module.JOURNAL_ROOT / 'attempt.json').read_bytes())
    assert state['phase'] == 'HOLD_CREATE_UNKNOWN' and state['dispatches'] == {'create': 1, 'activate': 0}
    original = (module.JOURNAL_ROOT / 'attempt.json').read_bytes()
    assert invoke(['stage', '--parent-stage-inactive'], unknown)[0] == 2
    assert unknown.creates == 1 and unknown.readbacks == 0 and unknown.activations == 0
    assert (module.JOURNAL_ROOT / 'attempt.json').read_bytes() == original
    module.JOURNAL_ROOT = root / 'late-source'
    module.JOURNAL_ROOT.mkdir(mode=0o700)
    journal = c.NativeJournal(str(module.JOURNAL_ROOT / 'attempt.json'))
    original_finish, original_check = journal.finish, module.check
    def rejected_source(_):
        raise ValueError('HOLD_SOURCE_DRIFT')
    def late_source():
        original_finish()
        module.check = rejected_source
    journal.finish = late_source
    late = Ports()
    try:
        assert invoke(['stage', '--parent-stage-inactive'], late, journal=journal)[0] == 2
    finally:
        module.check = original_check
    assert (module.JOURNAL_ROOT / 'attempt.json.lock').exists(), 'Late source failure must remain durably fenced after finish'
    assert json.loads((module.JOURNAL_ROOT / 'attempt.json').read_bytes())['phase'] != 'STAGED_INACTIVE'
    print(json.dumps({'classification': 'MODEL_INERT_N8N_REAL_FSYNC_JOURNAL',
        'positive': {'creates': ports.creates, 'activations': ports.activations, 'readbacks': ports.readbacks},
        'unknown': {'creates': unknown.creates, 'activations': unknown.activations}}))
