import gzip
import hashlib
import io
import json
import os
import socket
import ssl
import stat
import sys
import time
import urllib.request
from contextlib import redirect_stdout, redirect_stderr
from email.message import Message
from pathlib import Path
from urllib.response import addinfourl

ROOT = Path(__file__).resolve().parents[1]
SCENARIO = sys.argv[1]
OWNED = Path(sys.argv[2]).resolve()
TARGET = ROOT / 'scripts/continue-performance-review-mail-workflow.py'
forbidden = {'credential': 0, 'environment': 0, 'network': 0, 'subprocess': 0, 'realMutation': 0}
loaded = []
expected_compile = {}

def audit(event, args):
    if event == 'compile' and args[1] in expected_compile and isinstance(args[0], (str, bytes)):
        raw = args[0].encode() if isinstance(args[0], str) else args[0]
        loaded.append({'path': args[1], 'sha256': hashlib.sha256(raw).hexdigest(), 'expected': expected_compile[args[1]]})
    if event == 'open' and isinstance(args[0], (str, bytes)):
        p = Path(os.fsdecode(args[0]))
        if p.name in ('.env', '.env.local') or 'Keychains' in str(p) or '/.ssh/' in str(p):
            forbidden['credential'] += 1
            raise AssertionError('FORBIDDEN_CREDENTIAL')
    if event.startswith('socket.'):
        forbidden['network'] += 1
        raise AssertionError('FORBIDDEN_NETWORK')
    if event in ('subprocess.Popen', 'os.system', 'os.posix_spawn'):
        forbidden['subprocess'] += 1
        raise AssertionError('FORBIDDEN_SUBPROCESS')
    if event in ('os.mkdir', 'os.rename', 'os.remove') and isinstance(args[0], (str, bytes)) and str(args[0]).startswith('/Volumes/UG/MAM/opencode/n8n/'):
        forbidden['realMutation'] += 1
        raise AssertionError('FORBIDDEN_REAL_MUTATION')

class EnvironmentTrap:
    def __getitem__(self, key):
        forbidden['environment'] += 1
        raise AssertionError('FORBIDDEN_ENVIRONMENT')
    get = __getitem__
    def __iter__(self):
        return self.__getitem__('enumeration')

sys.addaudithook(audit)
os.environ = EnvironmentTrap()
if not TARGET.is_file():
    print(json.dumps({'missingEntrypoint': True, 'forbidden': forbidden}))
    raise SystemExit(0)

def sha(raw):
    return hashlib.sha256(raw).hexdigest()

def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False, allow_nan=False).encode()

def save(path, value):
    raw = canonical(value) + b'\n'
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(raw)
    return path, sha(raw)

try:
    oracle = json.load(sys.stdin)
    bundle = json.loads(gzip.decompress((ROOT / 'tests/performance-review-n8n-successor-origin.fixture.gz').read_bytes()))
    oldroot = OWNED / 'historical-source'
    for name, text in bundle['source'].items():
        p = oldroot / name
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(text)
        expected_compile[str(p)] = sha(text.encode())
    successor = json.loads(gzip.decompress((ROOT / 'tests/performance-review-n8n-successor-runtime.fixture.gz').read_bytes()))
    runtime = {} if SCENARIO == 'current-runtime-scope' else {str(ROOT / name): text.encode() for name, text in successor['source'].items()}
    external = {k: v.encode() for k, v in bundle['external'].items()}
    external_paths = {
        '/Volumes/UG/MAM/opencode/n8n/scripts/verify.py': external['MAM_VERIFY'],
        '/Volumes/UG/MAM/opencode/.worktrees/mam-performance-production-20261016/qa-evidence/performance-release-20261016/mail-http-interface-supplement-v1.json': external['HTTP_SUPPLEMENT'],
    }
    expected_compile.update({p: sha(b) for p, b in external_paths.items()})
    original_read = Path.read_bytes
    def portable_read(self):
        return external_paths[str(self)] if str(self) in external_paths else original_read(self)
    Path.read_bytes = portable_read
    oldfile = oldroot / 'scripts/publish-performance-review-mail-workflow.py'
    old: dict = {'__name__': 'synthetic_origin_publisher', '__file__': str(oldfile)}
    exec(compile(oldfile.read_bytes(), str(oldfile), 'exec'), old)
    old_snapshot, old_external = old['acquire']()
    binding = {
        'schemaVersion': 1, 'n8nOrigin': 'https://n8n.srv1866578.hstgr.cloud', 'hubOrigin': 'https://mam-team-management-system-ten.vercel.app',
        'performanceHeader': {'id': 'syntheticHeader01', 'name': 'Synthetic header', 'headerName': 'X-MAM-Performance-Secret'},
        'outlook': {'id': 'syntheticOutlook01', 'name': 'Synthetic Outlook', 'httpMeSender': 'synthetic-sender@mobilityaccess.com.au', 'identityVerified': True},
        'cron': {'id': 'syntheticCron01', 'name': 'Synthetic cron', 'identityVerified': True},
        'runtimeProviderVerified': False, 'activationFence': {'hubMailModeDisabled': True, 'newOutboxEmpty': True, 'singleWriterVerified': True},
    }
    oldgraph = old['bind_workflow'](old_snapshot, binding)
    closure = old['closure_for'](old_snapshot, old_external)
    oldreview = {'schemaVersion': 1, 'independent': True, 'reviewer': 'synthetic-historical-independent-review', 'passed': True, 'security_concerns': [], 'logic_errors': [],
                 'sourceHashes': {**closure['sourceHashes'], **{'external:' + k: v for k, v in closure['externalHashes'].items()}, '$closure': sha(canonical(closure))},
                 'bindingSha256': sha(canonical(binding)), 'graphSha256': sha(canonical(oldgraph)), 'gates': {'stage': True, 'activate': False}, 'expectedWorkflow': None, 'runtimeProviderVerified': False}
    oldpacket = {'closure': closure, 'binding': binding, 'review': oldreview}
    ID = 'syntheticOwnedW1'
    OLD = '740f0100-0000-4000-8000-000000000001'
    NEW = '740f0100-0000-4000-8000-000000000002'
    origin = OWNED / 'SYNTHETIC_CANONICAL_ROOT'
    origin.mkdir(mode=0o700)
    hroot = OWNED / 'historical-evidence'
    history = {}
    for key, value in [('packet', oldpacket), ('review', oldreview), ('graph', oldgraph)]:
        history[key] = save(hroot / (key + '.json'), value)
    state = {'schemaVersion': 1, 'owner': 'mam-performance-review-mail-v1', 'phase': 'STAGED_INACTIVE', 'closureSha256': sha(canonical(closure)), 'bindingSha256': sha(canonical(binding)),
             'identityBindingSha256': sha(canonical(binding)), 'graphSha256': sha(canonical(oldgraph)), 'dispatches': {'create': 1, 'activate': 0}, 'id': ID, 'versionId': OLD}
    history['journal'] = save(hroot / 'workflow.json', state)
    os.chmod(history['journal'][0], 0o600)
    scope = {'origin': binding['n8nOrigin'], 'name': oldgraph['name'], 'paths': ['mam-people-hub-performance-review-mail-v1', 'mam-people-hub-performance-review-mail-v1-ready'],
             'journal': str(history['journal'][0]), 'closureSha256': state['closureSha256'], 'graphSha256': state['graphSha256'], 'identityBindingSha256': state['identityBindingSha256']}
    history['attempt'] = save(origin / 'attempt.json', {'schemaVersion': 1, 'scope': scope, 'state': state})
    os.chmod(history['attempt'][0], 0o600)
    stdout = hroot / 'stage.stdout'
    stdout.write_bytes(canonical({'ok': True, 'phase': 'STAGED_INACTIVE', 'id': ID, 'versionId': OLD, 'active': False, 'runtimeProviderVerified': False}) + b'\n')
    stderr = hroot / 'stage.stderr'
    stderr.write_bytes(b'')
    receipt = {'exit': 0, 'packetSha256': history['packet'][1], 'activationRequested': False, 'businessWebhookInvoked': False, 'actualEmails': 0,
               'streams': {n: {'path': str(p), 'sha256': sha(p.read_bytes()), 'bytes': len(p.read_bytes())} for n, p in [('stdout', stdout), ('stderr', stderr)]}}
    history['receipt'] = save(hroot / 'receipt.json', receipt)
    history['prepared'] = save(hroot / 'prepared.json', {'publisherSourceRoot': str(oldroot), 'head': '5c59adb4882485b1164650df0ad4fb2501213f3c', 'bindingSha256': state['bindingSha256'], 'graphSha256': state['graphSha256'], 'activationAllowed': False})
    history['acceptance'] = save(hroot / 'acceptance.json', {'reviewSha256': history['review'][1], 'packetSha256': history['packet'][1], 'stageAllowed': True, 'activateAllowed': False, 'runtimeProviderVerified': False})
    history['readback'] = save(hroot / 'readback.json', {'httpStatus': 200, 'id': ID, 'versionId': OLD, 'active': False, 'activeVersionId': None, 'fullReviewedGraphAndSettingsExact': True, 'nodeCount': 16, 'graphSha256': state['graphSha256'], 'journalLockAbsent': True})
    authority = {'authoritySource': {'exactUserResponse': '你再深度检查一遍，看看系统现在上线有没有风险。呃，有的话就改正改成没风险的再上线吧。'},
                 'interpretation': {'deepRiskReviewAndNecessarySameScopeCorrectionAuthorized': True, 'unattributedRiskWaiverAccepted': False, 'enableOnlyAfterRequiredTechnicalGates': True}}
    if SCENARIO == 'historical-authority-waiver': authority['interpretation']['unattributedRiskWaiverAccepted'] = True
    history['authority'] = save(hroot / 'authority.json', authority)
    if SCENARIO == 'historical-prepared-graph':
        history['prepared'] = save(hroot / 'prepared.json', {'publisherSourceRoot': str(oldroot), 'head': '5c59adb4882485b1164650df0ad4fb2501213f3c', 'bindingSha256': state['bindingSha256'], 'graphSha256': '0' * 64, 'activationAllowed': False})
    if SCENARIO == 'historical-boolean-schema':
        state['schemaVersion'] = True
        history['journal'] = save(hroot / 'workflow.json', state)
        os.chmod(history['journal'][0], 0o600)
        history['attempt'] = save(origin / 'attempt.json', {'schemaVersion': 1, 'scope': scope, 'state': state})
        os.chmod(history['attempt'][0], 0o600)
    history_before = {str(p): p.read_bytes() for p, pin in history.values()}
    if SCENARIO in ('old-stage-denied', 'old-activate-denied', 'old-reset-denied'):
        denied = json.loads(json.dumps(oldpacket))
        denied['review']['gates'] = {'stage': False, 'activate': False}
        argv = ['stage', '--parent-stage'] if SCENARIO == 'old-stage-denied' else ['activate', '--parent-activate', '--expected-id', ID, '--expected-version', OLD] if SCENARIO == 'old-activate-denied' else ['reset']
        out, err = io.StringIO(), io.StringIO()
        with redirect_stdout(out), redirect_stderr(err):
            code = old['main'](argv, io.StringIO(json.dumps(denied)))
        result = {'exits': [code], 'calls': [], 'outputs': [{'stdout': out.getvalue(), 'stderr': err.getvalue()}], 'configLoads': 0,
                  'state': None, 'historyUnchanged': all(p.read_bytes() == history_before[str(p)] for p, pin in history.values()), 'forbidden': forbidden, 'loaded': loaded}
        save(OWNED / 'result.json', result)
        print(json.dumps(result))
        raise SystemExit(0)
    for p in ROOT.glob('scripts/*performance-review*py'):
        expected_compile[str(p)] = sha(runtime.get(str(p), p.read_bytes()))
    expected_compile[str(TARGET)] = sha(TARGET.read_bytes())
    ns: dict = {'__name__': 'performance_successor_fixture', '__file__': str(TARGET)}
    exec(compile(TARGET.read_bytes(), str(TARGET), 'exec'), ns)
    ns['HISTORY'] = history
    ns['ORIGINAL_ROOT'] = oldroot
    ns['ORIGIN_ROOT'] = origin
    ns['SOURCE_ROOTS'] = (ROOT, OWNED)
    native_read = ns['read_bytes']
    source_drift = False
    source_fault_reads = 0
    real_time = time.time
    source_fault_enabled = SCENARIO == 'prepare-publisher-escape'
    def snapshot_read(path, limit=8388608):
        global source_drift, source_fault_reads
        if source_final_failure and Path(path) == TARGET:
            raise SystemExit(73)
        if SCENARIO == 'full-source-map-positive' and str(path) == str(ROOT / 'deploy/n8n/synthetic-unrelated/validate-payload.js'):
            return b'throw new Error("SYNTHETIC_UNRELATED_WORKFLOW_SOURCE");\n'
        raw = external_paths[str(path)] if str(path) in external_paths else runtime[str(path)] if str(path) in runtime else native_read(path, limit)
        if Path(path) == ROOT / 'scripts/build-performance-review-mail-workflow.py':
            if SCENARIO == 'scope-webhook-path': raw = raw.replace(b"POST_PATH = 'mam-people-hub-performance-review-mail-v1'", b"POST_PATH = 'synthetic-unapproved-path'")
            if SCENARIO == 'scope-sender-url': raw = raw.replace(b'https://graph.microsoft.com/v1.0/me/sendMail', b'https://graph.microsoft.com/v1.0/users/synthetic-other/sendMail')
        if source_drift and Path(path) == TARGET:
            source_fault_reads += 1
            if SCENARIO in ('activate-ack-systemexit-source-once', 'init-type-collision-source-once'): source_drift = False
            return raw + b'\n'
        if source_fault_enabled and SCENARIO in ('load-before-pin', 'prepare-publisher-escape') and Path(path) == ROOT / 'scripts/publish-performance-review-mail-workflow.py':
            return raw + b'\nPath("/Volumes/UG/MAM/opencode/n8n/.env").read_text()\n'
        return raw
    ns['read_bytes'] = snapshot_read
    fsyncs = []
    native_fsync = os.fsync
    sync_fault_entered = False
    diagnostic_fault_enabled = False
    source_final_failure = False
    def fsync(fd):
        global sync_fault_entered, source_drift, source_final_failure
        fsyncs.append('directory' if stat.S_ISDIR(os.fstat(fd).st_mode) else 'file')
        ledger = origin / ns['CHILD'] / 'attempt.json'
        if SCENARIO in ('finish-fsync', 'finish-systemexit', 'finish-interrupt') and not sync_fault_entered and ledger.exists() and not Path(str(ledger) + '.lock').exists():
            sync_fault_entered = True
            if SCENARIO == 'finish-systemexit': raise SystemExit(73)
            if SCENARIO == 'finish-interrupt': raise KeyboardInterrupt()
            raise OSError('synthetic final directory sync failure')
        if diagnostic_fault_enabled and SCENARIO == 'activate-ack-systemexit-persist-fsync' and stat.S_ISREG(os.fstat(fd).st_mode):
            raise OSError('synthetic diagnostic file sync failure')
        if diagnostic_fault_enabled and SCENARIO == 'activate-ack-systemexit-hold-fsync' and not sync_fault_entered and stat.S_ISDIR(os.fstat(fd).st_mode):
            sync_fault_entered = True
            raise OSError('synthetic diagnostic directory sync failure')
        result = native_fsync(fd)
        if SCENARIO == 'source-drift-on-finish' and ledger.exists() and not Path(str(ledger) + '.lock').exists(): source_drift = True
        if SCENARIO == 'source-final-systemexit' and ledger.exists() and not Path(str(ledger) + '.lock').exists(): source_final_failure = True
        return result
    os.fsync = fsync
    calls = []
    metrics = {'configLoads': 0, 'putAtFsync': 0, 'postAtFsync': 0}
    baseline = {**oldgraph, 'id': ID, 'versionId': OLD, 'active': False, 'activeVersionId': None, 'activeVersion': None,
                'staticData': {'syntheticHistory': {'kept': 3}}, 'shared': [{'workflowId': ID, 'projectId': 'syntheticProject', 'role': 'workflow:owner'}], 'isArchived': False}
    if SCENARIO == 'native-schedule-initialization': baseline['staticData'] = None
    row = json.loads(json.dumps(baseline))
    marker = '740f0100-0000-4000-8000-000000000099' if SCENARIO == 'correct-ack-secret-version' else 'synthetic-key-for-inert-successor-native'
    if SCENARIO == 'activate-ack-code-secret-source': marker = 'HOLD_RETAINED_STATIC_DATA'
    if SCENARIO == 'activate-ack-operation-secret-source': marker = 'activate-successor:POST'
    if SCENARIO == 'activate-ack-type-secret-source': marker = 'KeyboardInterrupt'
    if SCENARIO.startswith('init-code-collision'): marker = 'HOLD_MAM_CONFIG_TARGET'
    if SCENARIO.startswith('init-type-collision'): marker = 'KeyboardInterrupt'
    if SCENARIO.startswith('init-operation-collision'): marker = 'transport-initialize'
    stage = 'prepare'
    operation_gets = 0
    fault_entered = []
    fault_enabled = True
    class InertHTTPS(urllib.request.HTTPSHandler):
        def https_open(self, request):
            global row, operation_gets, source_drift, diagnostic_fault_enabled
            path = request.full_url.split('/api/v1/', 1)[1]
            method = request.get_method()
            body = None if request.data is None else json.loads(request.data)
            assert request.get_header('X-n8n-api-key') == marker
            assert 0 < request.timeout <= 20
            assert request.full_url.startswith(binding['n8nOrigin'] + '/api/v1/')
            calls.append({'method': method, 'path': path, 'body': body})
            if path == 'workflows?limit=1':
                data = {'data': [], 'nextCursor': None}
            elif method == 'GET':
                assert path == 'workflows/' + ID
                operation_gets += 1
                if SCENARIO == 'review-expired-preput' and stage == 'correct-inactive': ns['time'].time = lambda: real_time() + 601
                data = row
            elif method == 'PUT':
                assert path == 'workflows/' + ID
                assert set(body) == {'name', 'nodes', 'connections', 'settings', 'staticData'}
                assert body['staticData'] == baseline['staticData']
                metrics['putAtFsync'] = len(fsyncs)
                row = {**row, **body, 'versionId': NEW}
                if SCENARIO in ('source-drift-on-put', 'source-drift-on-put-timeout'):
                    source_drift = True
                    if SCENARIO.endswith('timeout'): raise TimeoutError('synthetic unknown update with source drift')
                data = {k: v for k, v in row.items() if k != 'shared'}
            else:
                assert method == 'POST' and path == 'workflows/' + ID + '/activate' and body == {'versionId': NEW}
                metrics['postAtFsync'] = len(fsyncs)
                row['active'] = True
                row['activeVersionId'] = NEW
                row['activeVersion'] = {'workflowId': ID, 'versionId': NEW, 'nodes': row['nodes'], 'connections': row['connections']}
                if SCENARIO == 'native-schedule-initialization':
                    assert oracle['registered'] == 1 and oracle['emitted'] == 0
                    row['staticData'] = oracle['staticData']
                data = {k: v for k, v in row.items() if k != 'shared'}
            data = json.loads(json.dumps(data))
            point = 'correct-pre' if stage == 'correct-inactive' and method == 'GET' and operation_gets == 1 else 'correct-first' if stage == 'correct-inactive' and method == 'GET' else 'correct-ack' if method == 'PUT' else 'activate-pre' if stage == 'activate-successor' and method == 'GET' and operation_gets == 1 else 'activate-first' if stage == 'activate-successor' and method == 'GET' else 'activate-ack' if method == 'POST' else 'readback'
            if path == 'workflows?limit=1': point = 'verify'
            if fault_enabled and SCENARIO.startswith(point + '-'):
                fault = SCENARIO[len(point) + 1:]
                fault_entered.append(point + '-' + fault)
                if fault == 'timeout': raise TimeoutError('synthetic committed unknown mutation')
                if fault == 'interrupt': raise KeyboardInterrupt()
                if fault == 'systemexit-source':
                    source_drift = True
                    raise SystemExit(73)
                if fault == 'systemexit-only': raise SystemExit(73)
                if fault in ('systemexit-source-once', 'systemexit-zero-source', 'systemexit-one-source', 'systemexit-two-source'):
                    source_drift = True
                    raise SystemExit({'systemexit-source-once': 73, 'systemexit-zero-source': 0, 'systemexit-one-source': 1, 'systemexit-two-source': 2}[fault])
                if fault in ('systemexit-hold-fsync', 'systemexit-persist-fsync'):
                    diagnostic_fault_enabled = True
                    raise SystemExit(73)
                if fault in ('interrupt-source', 'known-code-source', 'unknown-code-source', 'unknown-class-source', 'systemexit-string-source', 'systemexit-bool-source', 'systemexit-unknown-number-source', 'code-secret-source', 'operation-secret-source', 'type-secret-source'):
                    source_drift = True
                    if fault in ('interrupt-source', 'type-secret-source'): raise KeyboardInterrupt()
                    if fault == 'known-code-source': raise ValueError('HOLD_RETAINED_STATIC_DATA')
                    if fault in ('unknown-code-source', 'code-secret-source'): raise ValueError(marker)
                    if fault == 'unknown-class-source': raise type(marker, (Exception,), {})(marker)
                    if fault == 'systemexit-string-source': raise SystemExit(marker)
                    if fault == 'systemexit-bool-source': raise SystemExit(True)
                    if fault == 'systemexit-unknown-number-source': raise SystemExit(987654)
                    raise SystemExit(73)
                if fault == 'id': data['id'] = 'syntheticForeignID'
                if fault == 'version': data['versionId'] = '740f0100-0000-4000-8000-000000000003'
                if fault == 'same-version': data['versionId'] = OLD
                if fault == 'boolean-version': data['versionId'] = True
                if fault == 'active': data['active'] = not data['active']
                if fault == 'boolean-active': data['active'] = 1
                if fault == 'publication': data['activeVersionId'] = '740f0100-0000-4000-8000-000000000003'
                if fault == 'missing-publication': data.pop('activeVersionId', None)
                if fault == 'connections': data['connections'] = {}
                if fault == 'settings': data['settings']['saveManualExecutions'] = 0
                if fault == 'static': data['staticData'] = {'syntheticHistory': {'kept': 4}}
                if fault == 'raw-static': data['staticData'] = json.dumps(data['staticData'])
                if fault == 'missing-static': data.pop('staticData', None)
                if fault == 'shared': data['shared'] = [{'projectId': 'syntheticForeignProject', 'role': 'workflow:owner', 'workflowId': ID}]
                if fault == 'inner-version': data['activeVersion']['versionId'] = OLD
                if fault == 'inner-id': data['activeVersion']['workflowId'] = 'syntheticForeignID'
                if fault == 'inner-null': data['activeVersion']['versionId'] = None
                if fault == 'inner-bool': data['activeVersion']['versionId'] = True
                if fault == 'publication-graph': data['activeVersion']['nodes'] = oldgraph['nodes']
                if fault == 'secret-key': data[marker] = 'synthetic unused'
                if fault == 'secret-nested': data['unused'] = {'nested': [marker]}
                if fault == 'secret-version': data['versionId'] = marker
            if SCENARIO == 'publication-inner-omitted' and data.get('activeVersion'):
                data['activeVersion'].pop('versionId', None)
                data['activeVersion'].pop('workflowId', None)
            raw = canonical(data)
            if 'secret-' in SCENARIO:
                raw = raw.replace(marker.encode(), ''.join('\\u%04x' % ord(c) for c in marker).encode())
            response = addinfourl(io.BytesIO(raw), Message(), request.full_url, 200)
            response.msg = 'Synthetic'
            return response
    def opener(*handlers):
        global source_drift
        if SCENARIO in ('init-type-collision', 'init-operation-collision', 'init-clean-interrupt', 'init-operation-collision-systemexit', 'init-clean-systemexit', 'init-type-collision-source-once'):
            fault_entered.append(SCENARIO)
            if SCENARIO.endswith('-source-once'): source_drift = True
            if SCENARIO.endswith('-systemexit'): raise SystemExit(73)
            raise KeyboardInterrupt()
        return urllib.request.build_opener(urllib.request.ProxyHandler({}), *handlers, InertHTTPS(context=ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)))
    original_module = ns['module']
    def measured_module(raw, path, name):
        value = original_module(raw, path, name)
        if name == 'successor_current_publisher_snapshot':
            real_loader = value['load_verifier']
            def loader(external):
                if SCENARIO == 'init-loader-interrupt':
                    fault_entered.append(SCENARIO)
                    raise KeyboardInterrupt()
                verifier = real_loader(external)
                def config():
                    metrics['configLoads'] += 1
                    if SCENARIO == 'init-config-interrupt':
                        fault_entered.append(SCENARIO)
                        raise KeyboardInterrupt()
                    if SCENARIO in ('init-code-collision', 'init-clean-reject', 'init-clean-reject-replay'):
                        fault_entered.append(SCENARIO)
                    return {'N8N_INSTANCE_LABEL': 'SYNTHETIC_WRONG_LABEL' if SCENARIO in ('init-code-collision', 'init-clean-reject', 'init-clean-reject-replay') else 'MAM', 'N8N_BASE_URL': binding['n8nOrigin'], 'N8N_API_KEY': marker}
                verifier['load_local_env'] = config
                verifier['build_opener'] = opener
                return verifier
            value['load_verifier'] = loader
            value['build_opener'] = opener
        return value
    ns['module'] = measured_module
    exits = []
    outputs = []
    def invoke(argv, packet=None):
        global stage, operation_gets
        stage = argv[0]
        operation_gets = 0
        out, err = io.StringIO(), io.StringIO()
        raw = '' if packet is None else json.dumps(packet)
        if packet is not None and SCENARIO == 'duplicate-json': raw = raw.replace('"schemaVersion": 1', '"schemaVersion": 1, "schemaVersion": 1', 1)
        if packet is not None and SCENARIO == 'nonfinite-json': raw = raw.replace('"schemaVersion": 1', '"schemaVersion": NaN', 1)
        if packet is not None and SCENARIO == 'overflow-json': raw = raw.replace('"schemaVersion": 1', '"schemaVersion": 1e999', 1)
        with redirect_stdout(out), redirect_stderr(err):
            code = ns['main'](argv, io.StringIO(raw))
        exits.append(code)
        outputs.append({'argv': argv, 'exit': code, 'stdout': out.getvalue(), 'stderr': err.getvalue()})
        save(OWNED / ('operation-' + str(len(exits)) + '.json'), outputs[-1])
        return None if code else json.loads(out.getvalue())
    prepared = invoke(['prepare'])
    if prepared is None:
        result = {'exits': exits, 'calls': calls, 'outputs': outputs, 'state': None, 'historyUnchanged': True,
                  'forbidden': forbidden, 'loaded': loaded, 'fsyncs': fsyncs, **metrics}
        save(OWNED / 'result.json', result)
        print(json.dumps(result))
        raise SystemExit(0)
    assert calls == [] and metrics['configLoads'] == 0
    if SCENARIO == 'full-source-map-positive':
        prepared['closure']['sourceHashes']['deploy/n8n/synthetic-unrelated/validate-payload.js'] = sha(b'throw new Error("SYNTHETIC_UNRELATED_WORKFLOW_SOURCE");\n')
    files = {}
    for key, info in bundle['installed'].items():
        p = OWNED / (key + '.source')
        p.write_text(info['source'])
        assert sha(p.read_bytes()) == info['sha256']
        files[key] = {'path': str(p), 'sha256': info['sha256']}
    runtime_manifest = {'n8nVersion': '2.32.6', 'containerId': 'e' * 64, 'exactMamRouterVerified': True,
                        'fileCount': 2, 'files': {key: {'sha256': files[role]['sha256'], 'bytes': len(Path(files[role]['path']).read_bytes())} for key, role in [('app/dist/public-api/v1/openapi.yml', 'installed-openapi'), ('app/dist/public-api/v1/handlers/workflows/workflows.handler.js', 'installed-handler')]}}
    core_manifest = {'container': 'e' * 12, 'configuredMAMTargetVerified': True,
                     'files': {'dist/workflows/workflow.service.js': {'sha256': files['installed-service']['sha256'], 'bytes': len(Path(files['installed-service']['path']).read_bytes())}}}
    for key, role in [('nodes-base/dist/nodes/Schedule/ScheduleTrigger.node.js', 'schedule-source'), ('nodes-base/dist/nodes/Schedule/GenericFunctions.js', 'schedule-generic')]:
        runtime_manifest['files'][key] = {'sha256': files[role]['sha256'], 'bytes': len(Path(files[role]['path']).read_bytes())}
    runtime_manifest['fileCount'] = len(runtime_manifest['files'])
    metadata = {'n8nVersion': '2.32.6', 'containerId': 'e' * 12, 'containerMatchedConfiguredMAMHostRoutingLabel': True, 'readOnly': True}
    p, pin = save(OWNED / 'workflow-runtime-metadata.json', metadata)
    files['workflow-runtime-metadata'] = {'path': str(p), 'sha256': pin}
    for key, value in [('installed-manifest', runtime_manifest), ('installed-core-manifest', core_manifest)]:
        p, pin = save(OWNED / (key + '.json'), value)
        files[key] = {'path': str(p), 'sha256': pin}
    facts = {'baseline': baseline, 'mailMode': 'disabled', 'outboxPending': 0, 'singleWriter': True, 'currentSource': prepared['closure']['sourceHashes'],
             'publication': {'repository': 'mobilityaccessmodifications/mam-team-management-system', 'branch': 'main', 'head': '1' * 40, 'publicationId': 'synthetic-publication-successor', 'verified': True},
             'previousDeployment': {'head': '2' * 40, 'deploymentId': 'synthetic-previous-deployment'},
             'deployment': {'head': '1' * 40, 'deploymentId': 'synthetic-successor-deployment', 'project': 'ai-7033s-projects/mam-team-management-system', 'origin': binding['hubOrigin'], 'state': 'READY', 'sourceHashes': prepared['closure']['sourceHashes']},
             'providerGraph': prepared['graphSha256'], 'providerSupported': True, 'providerSources': {key: value['sha256'] for key, value in files.items()}}
    p, pin = save(OWNED / 'synthetic-supplier.json', facts)
    files['synthetic-supplier'] = {'path': str(p), 'sha256': pin}
    evidence = {'files': files, 'claims': {k: {'file': 'synthetic-supplier', 'pointer': '/' + k, 'expected': v} for k, v in facts.items()}}
    packet = {k: prepared[k] for k in ('schemaVersion', 'closure', 'originSha256', 'expectedGraph')}
    packet['evidence'] = evidence
    def approve(operation, version):
        packet.pop('review', None)
        packet['review'] = {'schemaVersion': 1, 'reviewer': 'synthetic-independent-current-review', 'independent': True, 'passed': True, 'security_concerns': [], 'logic_errors': [],
                            'sourceHashes': {**prepared['closure']['sourceHashes'], **{'external:' + k: v for k, v in prepared['closure']['externalHashes'].items()}, '$closure': sha(canonical(prepared['closure']))},
                            'evidenceHashes': {k: v['sha256'] for k, v in files.items()}, 'packetSha256': sha(canonical(packet)),
                            'gates': {k: k == operation for k in ('correct-inactive', 'activate-successor', 'readback', 'create', 'reset', 'dispatch')}, 'expectedWorkflow': {'id': ID, 'versionId': version}}
        packet['review']['validUntilUnix'] = int(time.time()) + (-1 if SCENARIO == 'review-deadline-expired' else 600)
    approve('correct-inactive', OLD)
    if SCENARIO == 'wrong-graph': packet['expectedGraph']['connections'] = {}
    if SCENARIO == 'stale-source': packet['closure']['sourceHashes']['scripts/build-performance-review-mail-workflow.py'] = '0' * 64
    if SCENARIO == 'source-after-deployment': facts['deployment']['sourceHashes'] = {'synthetic-unrelated-source': '0' * 64}
    if SCENARIO == 'boolean-outbox': facts['outboxPending'] = False
    if SCENARIO == 'missing-grant': packet['review']['gates'].pop('correct-inactive')
    if SCENARIO == 'boolean-grant': packet['review']['gates']['correct-inactive'] = 1
    if SCENARIO == 'false-review': packet['review']['passed'] = False
    if SCENARIO == 'evidence-child-escape': files['installed-service']['path'] = '/Users/nixon/.ssh/synthetic-must-not-open-key'
    if SCENARIO == 'unbound-installed-source':
        runtime_manifest['files']['app/dist/public-api/v1/openapi.yml']['sha256'] = '0' * 64
        p, pin = save(OWNED / 'installed-manifest.json', runtime_manifest)
        files['installed-manifest']['sha256'] = pin
        approve('correct-inactive', OLD)
    if SCENARIO == 'foreign-expected-id': packet['review']['expectedWorkflow']['id'] = 'syntheticForeignID'
    if SCENARIO == 'foreign-expected-version': packet['review']['expectedWorkflow']['versionId'] = NEW
    if SCENARIO in ('source-after-deployment', 'boolean-outbox'):
        p, pin = save(OWNED / 'synthetic-supplier.json', facts)
        files['synthetic-supplier']['sha256'] = pin
        evidence['claims'] = {k: {'file': 'synthetic-supplier', 'pointer': '/' + k, 'expected': v} for k, v in facts.items()}
        approve('correct-inactive', OLD)
    if SCENARIO == 'existing-child': (origin / ns['CHILD']).mkdir(mode=0o700)
    if SCENARIO == 'child-symlink': (origin / ns['CHILD']).symlink_to(OWNED, target_is_directory=True)
    if SCENARIO == 'review-deadline-boolean': packet['review']['validUntilUnix'] = True
    if SCENARIO == 'review-deadline-missing': packet['review'].pop('validUntilUnix')
    source_fault_enabled = True
    corrected = invoke(['correct-inactive', '--parent-correct-inactive'], packet)
    if SCENARIO == 'init-clean-reject-replay':
        invoke(['correct-inactive', '--parent-correct-inactive'], packet)
    if corrected is not None and SCENARIO in ('inactive-readback', 'inactive-readback-reactivate'):
        approve('readback', NEW)
        invoke(['readback'], packet)
        if SCENARIO == 'inactive-readback': corrected = None
    if corrected is not None:
        if SCENARIO.startswith('journal-'):
            ledger = origin / ns['CHILD'] / 'attempt.json'
            retained = json.loads(ledger.read_bytes())
            field, value = {'journal-schema-old': ('schemaVersion', 1), 'journal-source-boolean': ('sourceHold', 0), 'journal-source-held': ('sourceHold', True), 'journal-primary-held': ('originalFailure', {'type': 'SystemExit', 'code': 73, 'operation': 'correct-inactive:PUT'}), 'journal-extra': ('extra', 'synthetic-unapproved'), 'journal-last-operation': ('lastEnteredOperation', 'synthetic-unapproved')}[SCENARIO]
            retained[field] = value
            ledger.write_bytes(canonical(retained) + b'\n')
        approve('activate-successor', NEW)
        if SCENARIO == 'activation-no-provider':
            packet['evidence']['claims'].pop('providerSupported')
            approve('activate-successor', NEW)
        activated = invoke(['activate-successor', '--parent-activate-successor'], packet)
        if activated is not None:
            approve('readback', NEW)
            invoke(['readback'], packet)
        elif SCENARIO.startswith('activate-') and not any(SCENARIO.endswith('-' + fault) for fault in ('systemexit-source', 'systemexit-only', 'interrupt-source', 'known-code-source', 'unknown-code-source', 'unknown-class-source', 'systemexit-string-source', 'systemexit-bool-source', 'systemexit-unknown-number-source', 'code-secret-source', 'operation-secret-source', 'type-secret-source', 'systemexit-hold-fsync', 'systemexit-persist-fsync', 'systemexit-source-once', 'systemexit-zero-source', 'systemexit-one-source', 'systemexit-two-source')):
            fault_enabled = False
            invoke(['activate-successor', '--parent-activate-successor'], packet)
    elif SCENARIO.startswith('correct-') and not any(SCENARIO.endswith('-' + fault) for fault in ('systemexit-source', 'systemexit-only', 'interrupt-source')):
        fault_enabled = False
        invoke(['correct-inactive', '--parent-correct-inactive'], packet)
    ledger = origin / ns['CHILD'] / 'attempt.json'
    result = {'exits': exits, 'calls': calls, 'outputs': outputs, 'state': json.loads(ledger.read_bytes()) if ledger.exists() else None,
              'historyUnchanged': all(p.read_bytes() == history_before[str(p)] for p, pin in history.values()),
              'forbidden': forbidden, 'loaded': loaded, 'fsyncs': fsyncs, 'faultEntered': fault_entered,
              'lockRetained': Path(str(ledger) + '.lock').exists(), 'pendingRetained': Path(str(ledger) + '.pending').exists(), 'sourceFaultReads': source_fault_reads, 'sourceDriftRestored': not source_drift, 'secretPersisted': any(marker in p.read_text() for p in ledger.parent.glob('*.json')) if ledger.parent.is_dir() else False, **metrics}
    save(OWNED / 'result.json', result)
    print(json.dumps(result))
except Exception as exc:
    failure = {'setupFailure': type(exc).__name__, 'message': str(exc)[:1200], 'forbidden': forbidden, 'loaded': loaded}
    save(OWNED / 'setup-failure.json', failure)
    print(json.dumps(failure))
    raise SystemExit(1)
