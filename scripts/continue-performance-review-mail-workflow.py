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

LOADED_CODE = sys._getframe().f_code
ROOT = Path(__file__).resolve().parents[1]
NROOT = Path('/Volumes/UG/MAM/opencode/n8n')
ORIGINAL_ROOT = Path('/Volumes/UG/MAM/opencode/.worktrees/mam-performance-prod-release-20261016')
Q = Path('/Volumes/UG/MAM/opencode/.worktrees/mam-performance-production-20261016/qa-evidence/performance-release-20261016')
ORIGIN_ROOT = NROOT / '.performance-review-mail-v1'
CHILD = 'successor-correction-v1'
SELF = 'scripts/continue-performance-review-mail-workflow.py'
PUBLISHER = 'scripts/publish-performance-review-mail-workflow.py'
PUBLISHER_SHA256 = 'e7e8fdc51aebfedc059054c42cffb09428057db9368627a39f0bf527ff159437'
OWN = (SELF, 'tests/performance-review-n8n-successor-fixture.py', 'tests/performance-review-n8n-successor.test.mjs',
       'tests/performance-review-n8n-successor-origin.fixture.gz', 'tests/performance-review-n8n-successor-static-data-fixture.cjs', 'docs/performance-review-mail-successor-continuation.md')
HISTORY = {
    'packet': (Q / 'production-mail-stage-review-r1/STAGE_PACKET.json', 'b9c57d99c50c01f4a3cad849616c54872c964ad02102c13880767e205289bbce'),
    'review': (Q / 'production-mail-stage-review-r1/REVIEW.json', 'e8d4ee93d51cd6cfe6fed16d951f8e1b07458255f0a26caf6766a1069bdf4d24'),
    'graph': (Q / 'production-mail-stage-r1/BOUND_GRAPH.json', '4c01188349fc044c00b7de017f2b8af0732a3a4ca31c8af4a893d90d2b0c6d68'),
    'journal': (Q / 'production-mail-stage-r1/workflow.json', '4c28515a20adceab929e51cefd8effc6664776a5955923712595e3939fbf1453'),
    'attempt': (ORIGIN_ROOT / 'attempt.json', 'de0af3bded3179822fe6ca6498348be5c7e9955533f7fdf92d57251646c16e1c'),
    'receipt': (Q / 'production-mail-stage-r1/stage.receipt.json', 'd5c6aeff81a0233bb724c8846bad741987f12fc3d945701c9349ff8182a5635f'),
    'prepared': (Q / 'production-mail-stage-r1/PREPARED_MANIFEST.json', 'fbe948bd887cef048facfcee6a27c9bbb3cf578e4a392ae5c75c66838fe21ee6'),
    'acceptance': (Q / 'production-mail-stage-r1/PARENT_STAGE_ACCEPTANCE.json', '6f19cc1174fad8b452863d42ba798255f2c249949320f9eb186c850d15ad36c9'),
    'readback': (Q / 'production-mail-stage-r1/INDEPENDENT_NATIVE_READBACK.json', '7ebcdebea976b27425555e9c59839f076766e6adcb493b59a534c8c8a63c8c0b'),
    'authority': (Q / 'deep-release-risk-r1/AUTHORITY.json', 'aee04da704a716e508aef2307ed6ec46c680c6d1d2e7f8739a10c92ff649fa5f'),
}
EXTERNAL = {'MAM_VERIFY': NROOT / 'scripts/verify.py', 'HTTP_SUPPLEMENT': Q / 'mail-http-interface-supplement-v1.json'}
SOURCE_ROOTS = (ROOT, ORIGINAL_ROOT, Q, NROOT / 'outputs')
RETAINED = ('staticData', 'shared', 'isArchived', 'description', 'pinData', 'nodeGroups', 'meta', 'parentFolder')
CLAIMS = ('baseline', 'mailMode', 'outboxPending', 'singleWriter', 'currentSource', 'publication', 'previousDeployment', 'deployment')
PROVIDER_CLAIMS = ('providerGraph', 'providerSupported', 'providerSources')
FAILURE_CODES = frozenset('''
    HOLD_ACTIVATE_REVIEW HOLD_ACTIVATION_ALREADY_ENTERED HOLD_ACTIVATION_FENCE HOLD_ACTIVE_READBACK_REVIEW
    HOLD_ACTUAL_CURRENT_PROVIDER_EVIDENCE HOLD_ALREADY_ACTIVATED HOLD_API_OPERATION HOLD_BASELINE_RETENTION
    HOLD_CANONICAL_ATTEMPT_EXISTS HOLD_CANONICAL_JOURNAL_BINDING HOLD_CANONICAL_OWNERSHIP HOLD_CANONICAL_ROOT
    HOLD_CLOSED_SCHEMA HOLD_CLOSURE_BINDING HOLD_CONTINUATION_DIRECTORY HOLD_CONTINUATION_EXISTS
    HOLD_CONTINUATION_OWNERSHIP HOLD_CREATION_EXIT HOLD_CREATION_GRAPH_REVIEW HOLD_CREATION_RECEIPT
    HOLD_CREATION_STREAM HOLD_CREDENTIAL_REFERENCE HOLD_CURRENT_REVIEW_EXPIRED HOLD_CURRENT_SAFETY
    HOLD_DUPLICATE_KEY HOLD_EVIDENCE_CONTRACT HOLD_EVIDENCE_POINTER HOLD_EVIDENCE_REFERENCE
    HOLD_EXACT_CURRENT_DEPLOYMENT HOLD_EXACT_WORKFLOW_READBACK HOLD_EXISTING_WORKFLOW_OR_PATH HOLD_EXPANDED_PUBLICATION
    HOLD_EXPECTED_RESOURCE HOLD_EXPECTED_VERSION HOLD_FINITE_STATIC_DATA_PRODUCER HOLD_FIXED_SUCCESSOR_GRAPH
    HOLD_FOREIGN_TARGET HOLD_HISTORICAL_ACCEPTANCE HOLD_HISTORICAL_READBACK HOLD_HTTP_BODY_BOUND
    HOLD_HTTP_DEADLINE HOLD_HTTP_STATUS HOLD_IMMUTABLE_STAGE HOLD_INACTIVE_PUBLICATION
    HOLD_INCOMPLETE_SOURCE_MAP HOLD_INDEPENDENT_CURRENT_REVIEW HOLD_INDEPENDENT_REVIEW HOLD_INPUT_BOUND
    HOLD_INSTALLED_ACQUISITION HOLD_INSTALLED_CAPTURE_BINDING HOLD_INSTALLED_PROTOCOL_CONTRACT HOLD_INSTALLED_PROTOCOL_SOURCE
    HOLD_INVENTORY_BODY_BOUND HOLD_INVENTORY_COMPLETENESS HOLD_INVENTORY_CURSOR HOLD_INVENTORY_NODE
    HOLD_INVENTORY_PAGE_BOUND HOLD_INVENTORY_ROW_BOUND HOLD_INVENTORY_TOTAL_BOUND HOLD_INVOCATION
    HOLD_JOURNAL_DIRECTORY HOLD_JOURNAL_EXISTS HOLD_JOURNAL_FILE HOLD_JOURNAL_PATH
    HOLD_JOURNAL_READBACK HOLD_JOURNAL_REQUIRED HOLD_JOURNAL_STATE HOLD_JOURNAL_WRITE
    HOLD_LOADED_PUBLISHER_SOURCE HOLD_LOADED_SUCCESSOR_SOURCE HOLD_MAM_CONFIG_KEY HOLD_MAM_CONFIG_TARGET
    HOLD_MAM_VERIFICATION HOLD_NESTED_PUBLICATION_IDENTITY HOLD_NONFINITE_JSON HOLD_NO_SUCCESSOR_DELTA
    HOLD_OPERATION_AUTHORITY HOLD_ORIGINAL_DIRECTORY HOLD_ORIGINAL_LOCK HOLD_ORIGINAL_PREPARATION
    HOLD_ORIGINAL_ROOT_BINDING HOLD_OWNERSHIP_STATE HOLD_PHASE_AUTHORITY HOLD_PROTECTED_SCHEDULE_HISTORY
    HOLD_PUBLICATION_PRESENCE HOLD_PUBLICATION_SOURCE HOLD_RAW_PIN HOLD_READBACK_REVIEW
    HOLD_REQUEST_BOUND HOLD_RETAINED_STATE HOLD_RETAINED_STATIC_DATA HOLD_REVIEW_GATE_SHAPE
    HOLD_RUNTIME_PROOF_SHAPE HOLD_SCHEDULE_CAPTURE_BINDING HOLD_SCHEDULE_GRAPH_CONTRACT HOLD_SCHEDULE_PRODUCER_SOURCE
    HOLD_SECRET_ECHO HOLD_SEND_RESPONSE_PROPERTY HOLD_SOURCE_BINDING HOLD_SOURCE_BOUND
    HOLD_SOURCE_DRIFT HOLD_SOURCE_FILE HOLD_SOURCE_KEY HOLD_SOURCE_PATH
    HOLD_STAGE_REVIEW HOLD_STATIC_DATA_BASELINE_TYPE HOLD_STATIC_DATA_RUNTIME_ORIGIN HOLD_SUCCESSOR_PARAMETER_SCOPE
    HOLD_SUCCESSOR_SCOPE HOLD_SUCCESSOR_VERSION_NOT_NEW HOLD_SUPPLIER_CONTRADICTION HOLD_TRANSPORT_TARGET
    HOLD_UNIFIED_SCOPE_AUTHORITY HOLD_VERIFIED_IDENTITY_REQUIRED
'''.split())
ENTERED_OPERATIONS = ('transport-initialize', 'verify', 'correct-inactive:GET', 'correct-inactive:PUT',
                      'correct-inactive:GET-readback', 'activate-successor:GET', 'activate-successor:POST',
                      'activate-successor:GET-readback', 'readback:GET')


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def read_bytes(path, limit=8388608):
    path = Path(path)
    if not path.is_absolute() or (path not in EXTERNAL.values() and path != ORIGIN_ROOT / 'attempt.json' and not any(root == path or root in path.parents for root in SOURCE_ROOTS)) or any(part in ('.ssh', '.git', 'Keychains') for part in path.parts) or (path.name.startswith('.env') and path.name != '.env.example') or path.suffix.lower() in ('.key', '.pem', '.p12', '.pfx') or path.resolve() != path:
        raise ValueError('HOLD_SOURCE_PATH')
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        meta = os.fstat(fd)
        if not stat.S_ISREG(meta.st_mode) or meta.st_nlink != 1 or meta.st_size > limit:
            raise ValueError('HOLD_SOURCE_FILE')
        parts = []
        size = 0
        while True:
            part = os.read(fd, min(65536, limit + 1 - size))
            if not part:
                break
            parts.append(part)
            size += len(part)
            if size > limit:
                raise ValueError('HOLD_SOURCE_BOUND')
        return b''.join(parts)
    finally:
        os.close(fd)


def module(raw, path, name):
    scope: dict = {'__name__': name, '__file__': str(path)}
    exec(compile(raw, str(path), 'exec', dont_inherit=True), scope)
    return scope


class Sources:
    def __init__(self, requested=None):
        self.source_hold = False
        self.raw = {}
        self.pins = {}
        self_raw = self.take(ROOT / SELF, None if requested is None else requested['sourceHashes'][SELF])
        if LOADED_CODE != compile(self_raw, str(ROOT / SELF), 'exec', dont_inherit=True):
            raise ValueError('HOLD_LOADED_SUCCESSOR_SOURCE')
        publisher = self.take(ROOT / PUBLISHER, PUBLISHER_SHA256)
        self.current = module(publisher, ROOT / PUBLISHER, 'successor_current_publisher_snapshot')
        self.minimum = set(self.current['RUNTIME']) | set(OWN)
        names = self.minimum if requested is None else set(requested['sourceHashes'])
        if not self.minimum <= names:
            raise ValueError('HOLD_INCOMPLETE_SOURCE_MAP')
        self.snapshot = {}
        for name in sorted(names):
            if not isinstance(name, str) or Path(name).is_absolute() or '..' in Path(name).parts:
                raise ValueError('HOLD_SOURCE_KEY')
            self.snapshot[name] = self.take(ROOT / name)
        if LOADED_CODE != compile(self.snapshot[SELF], str(ROOT / SELF), 'exec', dont_inherit=True):
            raise ValueError('HOLD_LOADED_SUCCESSOR_SOURCE')
        self.external = {name: self.take(path) for name, path in EXTERNAL.items()}
        self.closure = {'schemaVersion': 1, 'sourceHashes': {n: digest(b) for n, b in self.snapshot.items()},
                        'externalHashes': {n: digest(b) for n, b in self.external.items()}}
        if requested is not None and not self.current['json_equal'](requested, self.closure):
            raise ValueError('HOLD_SOURCE_BINDING')
        self.history_raw = {name: self.take(path, pin) for name, (path, pin) in HISTORY.items()}
        self.history = {name: self.current['load_json'](raw) for name, raw in self.history_raw.items()}
        old_raw = self.take(ORIGINAL_ROOT / PUBLISHER, self.history['packet']['closure']['sourceHashes'][PUBLISHER])
        self.old = module(old_raw, ORIGINAL_ROOT / PUBLISHER, 'successor_historical_publisher_snapshot')
        self.old_snapshot = {name: self.take(ORIGINAL_ROOT / name, pin) for name, pin in self.history['packet']['closure']['sourceHashes'].items()}
        self.original_graph = self.old['consume'](self.history['packet'], {'operation': 'stage'}, self.old_snapshot, self.external)
        self.bind_history()
        self.graph = self.current['bind_workflow']({key: self.snapshot[key] for key in self.current['RUNTIME']}, self.history['packet']['binding'])
        if self.current['json_equal'](self.graph, self.original_graph):
            raise ValueError('HOLD_NO_SUCCESSOR_DELTA')
        old_shape = [{k: v for k, v in node.items() if k != 'parameters'} for node in self.original_graph['nodes']]
        new_shape = [{k: v for k, v in node.items() if k != 'parameters'} for node in self.graph['nodes']]
        if not self.current['json_equal'](old_shape, new_shape) or any(not self.current['json_equal'](self.graph[k], self.original_graph[k]) for k in ('name', 'connections', 'settings')):
            raise ValueError('HOLD_SUCCESSOR_SCOPE')
        for original, successor in zip(self.original_graph['nodes'], self.graph['nodes']):
            permitted = {'jsCode'} if original['name'] == 'Validate Payload' else {'sendBody', 'contentType', 'specifyBody', 'jsonBody', 'body', 'rawContentType'} if original['name'] in ('Begin Delivery', 'Finish Delivery', 'Send Word to Careers') else set()
            before = {key: value for key, value in original['parameters'].items() if key not in permitted}
            after = {key: value for key, value in successor['parameters'].items() if key not in permitted}
            if original['name'] == 'Send Word to Careers':
                before = self.current['load_json'](self.current['canonical'](before))
                after = self.current['load_json'](self.current['canonical'](after))
                response = after['options']['response']['response']
                if 'outputPropertyName' in response:
                    if response['outputPropertyName'] != 'body':
                        raise ValueError('HOLD_SEND_RESPONSE_PROPERTY')
                    response.pop('outputPropertyName')
                before['options']['response']['response'].pop('outputPropertyName', None)
            if not self.current['json_equal'](before, after):
                raise ValueError('HOLD_SUCCESSOR_PARAMETER_SCOPE')
        self.check()

    def take(self, path, pin=None):
        path = Path(path)
        raw = read_bytes(path)
        if pin is not None and (not isinstance(pin, str) or not re.fullmatch('[0-9a-f]{64}', pin) or digest(raw) != pin):
            raise ValueError('HOLD_RAW_PIN')
        if path in self.raw and self.raw[path] != raw:
            raise ValueError('HOLD_SOURCE_DRIFT')
        self.raw[path] = raw
        self.pins[str(path)] = digest(raw)
        return raw

    def check(self):
        try:
            for path, raw in self.raw.items():
                if read_bytes(path) != raw:
                    raise ValueError('HOLD_SOURCE_DRIFT')
        except BaseException:
            self.source_hold = True
            raise

    def bind_history(self):
        c = self.current
        h = self.history
        authority = h['authority']
        if authority['authoritySource']['exactUserResponse'] != '你再深度检查一遍，看看系统现在上线有没有风险。呃，有的话就改正改成没风险的再上线吧。' or authority['interpretation']['deepRiskReviewAndNecessarySameScopeCorrectionAuthorized'] is not True or authority['interpretation']['unattributedRiskWaiverAccepted'] is not False or authority['interpretation']['enableOnlyAfterRequiredTechnicalGates'] is not True:
            raise ValueError('HOLD_UNIFIED_SCOPE_AUTHORITY')
        packet = h['packet']
        if not c['json_equal'](h['review'], packet['review']) or not c['json_equal'](h['graph'], self.original_graph):
            raise ValueError('HOLD_CREATION_GRAPH_REVIEW')
        state = h['journal']
        self.identity = state['id']
        self.original_version = state['versionId']
        prepared = h['prepared']
        if prepared['publisherSourceRoot'] != str(ORIGINAL_ROOT) or prepared['head'] != '5c59adb4882485b1164650df0ad4fb2501213f3c' or prepared['bindingSha256'] != state['bindingSha256'] or prepared['graphSha256'] != state['graphSha256'] or prepared['activationAllowed'] is not False:
            raise ValueError('HOLD_ORIGINAL_PREPARATION')
        class HistoricalJournal:
            def load(self):
                return state
        self.old['owned_state'](HistoricalJournal(), self.original_graph, packet,
                                {'--expected-id': self.identity, '--expected-version': self.original_version})
        if type(state['schemaVersion']) is not int or state['schemaVersion'] != 1 or state['phase'] != 'STAGED_INACTIVE' or state['dispatches'] != {'create': 1, 'activate': 0} or packet['binding']['runtimeProviderVerified'] is not False or packet['review']['gates'] != {'stage': True, 'activate': False}:
            raise ValueError('HOLD_IMMUTABLE_STAGE')
        expected_scope = {'origin': packet['binding']['n8nOrigin'], 'name': self.original_graph['name'],
                          'paths': ['mam-people-hub-performance-review-mail-v1', 'mam-people-hub-performance-review-mail-v1-ready'],
                          'journal': str(HISTORY['journal'][0]), 'closureSha256': state['closureSha256'],
                          'graphSha256': state['graphSha256'], 'identityBindingSha256': state['identityBindingSha256']}
        if not c['json_equal'](h['attempt'], {'schemaVersion': 1, 'scope': expected_scope, 'state': state}):
            raise ValueError('HOLD_ORIGINAL_ROOT_BINDING')
        for path in (HISTORY['journal'][0], HISTORY['attempt'][0]):
            if Path(str(path) + '.lock').exists() or Path(str(path) + '.pending').exists():
                raise ValueError('HOLD_ORIGINAL_LOCK')
        receipt = h['receipt']
        if type(receipt['exit']) is not int or receipt['exit'] != 0 or receipt['packetSha256'] != HISTORY['packet'][1] or receipt['activationRequested'] is not False or receipt['businessWebhookInvoked'] is not False or type(receipt['actualEmails']) is not int or receipt['actualEmails'] != 0:
            raise ValueError('HOLD_CREATION_RECEIPT')
        for ref in receipt['streams'].values():
            raw = self.take(Path(ref['path']), ref['sha256'])
            if type(ref['bytes']) is not int or len(raw) != ref['bytes']:
                raise ValueError('HOLD_CREATION_STREAM')
        if not c['json_equal'](c['load_json'](self.raw[Path(receipt['streams']['stdout']['path'])]),
                               {'ok': True, 'phase': 'STAGED_INACTIVE', 'id': self.identity, 'versionId': self.original_version, 'active': False, 'runtimeProviderVerified': False}) or self.raw[Path(receipt['streams']['stderr']['path'])] != b'':
            raise ValueError('HOLD_CREATION_EXIT')
        acceptance = h['acceptance']
        if acceptance['reviewSha256'] != HISTORY['review'][1] or acceptance['packetSha256'] != HISTORY['packet'][1] or acceptance['stageAllowed'] is not True or acceptance['activateAllowed'] is not False or acceptance['runtimeProviderVerified'] is not False:
            raise ValueError('HOLD_HISTORICAL_ACCEPTANCE')
        rb = h['readback']
        if type(rb['httpStatus']) is not int or rb['httpStatus'] != 200 or rb['id'] != self.identity or rb['versionId'] != self.original_version or rb['active'] is not False or 'activeVersionId' not in rb or rb['activeVersionId'] is not None or rb['fullReviewedGraphAndSettingsExact'] is not True or type(rb['nodeCount']) is not int or rb['nodeCount'] != len(self.original_graph['nodes']) or rb['graphSha256'] != state['graphSha256'] or rb['journalLockAbsent'] is not True:
            raise ValueError('HOLD_HISTORICAL_READBACK')
        self.origin_sha = digest(c['canonical']({name: pin for name, (_, pin) in HISTORY.items()}))


def pointer(value, path):
    if not isinstance(path, str) or (path and not path.startswith('/')):
        raise ValueError('HOLD_EVIDENCE_POINTER')
    for key in path.split('/')[1:] if path else []:
        key = key.replace('~1', '/').replace('~0', '~')
        if not isinstance(value, dict) or key not in value:
            raise ValueError('HOLD_EVIDENCE_POINTER')
        value = value[key]
    return value


def activation_static_data(src, baseline, values, pins, manifest):
    c = src.current
    for key in ('schedule-source', 'schedule-generic', 'workflow-static-source', 'workflow-runtime-metadata'):
        if key not in values:
            raise ValueError('HOLD_SCHEDULE_PRODUCER_SOURCE')
    for key, role in (('nodes-base/dist/nodes/Schedule/ScheduleTrigger.node.js', 'schedule-source'), ('nodes-base/dist/nodes/Schedule/GenericFunctions.js', 'schedule-generic')):
        ref = manifest['files'][key]
        if ref['sha256'] != pins[role] or type(ref['bytes']) is not int or ref['bytes'] != len(values[role]):
            raise ValueError('HOLD_SCHEDULE_CAPTURE_BINDING')
    metadata = c['load_json'](values['workflow-runtime-metadata'])
    if metadata.get('n8nVersion') != manifest['n8nVersion'] or metadata.get('containerMatchedConfiguredMAMHostRoutingLabel') is not True or metadata.get('readOnly') is not True or not isinstance(metadata.get('containerId'), str) or not re.fullmatch('[0-9a-f]{12,64}', metadata['containerId']) or not manifest['containerId'].startswith(metadata['containerId']):
        raise ValueError('HOLD_STATIC_DATA_RUNTIME_ORIGIN')
    for role, fragments in (('schedule-source', ("this.getWorkflowStaticData('node')", 'staticData.recurrenceRules = [];', 'staticData.recurrenceRuleSignatures = [];', 'resetStaleRecurrence)(staticData, rules)')), ('schedule-generic', ('let recurrence = { activated: false };', 'staticData.recurrenceRules.length = rules.length;', 'staticData.recurrenceRuleSignatures.length = rules.length;')), ('workflow-static-source', ('parameters.staticData || {}', 'key = `node:${node.name}`;', 'this.staticData[key] = ObservableObject.create({}, this.staticData);'))):
        if not all(fragment in values[role].decode() for fragment in fragments):
            raise ValueError('HOLD_FINITE_STATIC_DATA_PRODUCER')
    schedules = [node for node in src.graph['nodes'] if node['type'] == 'n8n-nodes-base.scheduleTrigger']
    if len(schedules) != 1 or not c['json_equal'](schedules[0]['typeVersion'], 1.2) or not c['json_equal'](schedules[0]['parameters'], {'rule': {'interval': [{'field': 'minutes', 'minutesInterval': 5}]}}):
        raise ValueError('HOLD_SCHEDULE_GRAPH_CONTRACT')
    original = baseline['staticData']
    if original is not None and not isinstance(original, dict):
        raise ValueError('HOLD_STATIC_DATA_BASELINE_TYPE')
    generated = c['load_json'](c['canonical']({} if original is None else original))
    key = 'node:' + schedules[0]['name']
    slot = generated.get(key, {})
    if not isinstance(slot, dict):
        raise ValueError('HOLD_PROTECTED_SCHEDULE_HISTORY')
    for field in ('recurrenceRules', 'recurrenceRuleSignatures'):
        if field in slot and not any(c['json_equal'](slot[field], expected) for expected in ([], [None])):
            raise ValueError('HOLD_PROTECTED_SCHEDULE_HISTORY')
        slot[field] = [None]
    generated[key] = slot
    return (original, generated)


def review_admission(packet, operation, src, pins):
    c = src.current
    review = packet['review']
    c['closed'](review, ('schemaVersion', 'reviewer', 'independent', 'passed', 'security_concerns', 'logic_errors', 'sourceHashes', 'evidenceHashes', 'packetSha256', 'gates', 'expectedWorkflow', 'validUntilUnix'))
    source_pins = {**packet['closure']['sourceHashes'], **{'external:' + k: v for k, v in packet['closure']['externalHashes'].items()}, '$closure': digest(c['canonical'](packet['closure']))}
    body = {key: value for key, value in packet.items() if key != 'review'}
    if type(review['schemaVersion']) is not int or review['schemaVersion'] != 1 or review['independent'] is not True or review['passed'] is not True or not isinstance(review['reviewer'], str) or not review['reviewer'].strip() or review['reviewer'] in ('implementation-owner', 'n8n-owner', 'successor-owner') or review['security_concerns'] != [] or review['logic_errors'] != [] or not c['json_equal'](review['sourceHashes'], source_pins) or not c['json_equal'](review['evidenceHashes'], pins) or review['packetSha256'] != digest(c['canonical'](body)):
        raise ValueError('HOLD_INDEPENDENT_CURRENT_REVIEW')
    if type(review['validUntilUnix']) is not int or time.time() >= review['validUntilUnix']:
        raise ValueError('HOLD_CURRENT_REVIEW_EXPIRED')
    c['closed'](review['gates'], ('correct-inactive', 'activate-successor', 'readback', 'create', 'reset', 'dispatch'))
    if any(type(value) is not bool for value in review['gates'].values()) or any(review['gates'][key] is not False for key in ('create', 'reset', 'dispatch')) or review['gates'][operation] is not True:
        raise ValueError('HOLD_OPERATION_AUTHORITY')
    expected = review['expectedWorkflow']
    c['closed'](expected, ('id', 'versionId'))
    if expected['id'] != src.identity or not isinstance(expected['versionId'], str) or not re.fullmatch(r'[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}', expected['versionId']) or (operation == 'correct-inactive' and expected['versionId'] != src.original_version):
        raise ValueError('HOLD_EXPECTED_VERSION')
    return review


def admission(packet, operation, src):
    c = src.current
    c['closed'](packet, ('schemaVersion', 'closure', 'originSha256', 'expectedGraph', 'evidence', 'review'))
    if type(packet['schemaVersion']) is not int or packet['schemaVersion'] != 1 or packet['originSha256'] != src.origin_sha or not c['json_equal'](packet['expectedGraph'], src.graph):
        raise ValueError('HOLD_FIXED_SUCCESSOR_GRAPH')
    evidence = packet['evidence']
    c['closed'](evidence, ('files', 'claims'))
    files, claims = evidence['files'], evidence['claims']
    if not isinstance(files, dict) or not isinstance(claims, dict) or not set(CLAIMS) <= set(claims) or not set(claims) <= set(CLAIMS + PROVIDER_CLAIMS):
        raise ValueError('HOLD_EVIDENCE_CONTRACT')
    declared_pins = {}
    for key, ref in files.items():
        c['closed'](ref, ('path', 'sha256'))
        if not isinstance(key, str) or not isinstance(ref['path'], str) or not isinstance(ref['sha256'], str) or not re.fullmatch('[0-9a-f]{64}', ref['sha256']):
            raise ValueError('HOLD_EVIDENCE_REFERENCE')
        declared_pins[key] = ref['sha256']
    review_admission(packet, operation, src, declared_pins)
    values = {}
    pins = {}
    for key, ref in files.items():
        c['closed'](ref, ('path', 'sha256'))
        raw = src.take(Path(ref['path']), ref['sha256'])
        pins[key] = digest(raw)
        values[key] = raw
    result = {}
    for key, claim in claims.items():
        c['closed'](claim, ('file', 'pointer', 'expected'))
        actual = pointer(c['load_json'](values[claim['file']]), claim['pointer'])
        if not c['json_equal'](actual, claim['expected']):
            raise ValueError('HOLD_SUPPLIER_CONTRADICTION')
        result[key] = actual
    for key in ('installed-openapi', 'installed-handler', 'installed-service', 'installed-manifest', 'installed-core-manifest'):
        if key not in values:
            raise ValueError('HOLD_INSTALLED_PROTOCOL_SOURCE')
    runtime_manifest = c['load_json'](values['installed-manifest'])
    core_manifest = c['load_json'](values['installed-core-manifest'])
    if runtime_manifest.get('exactMamRouterVerified') is not True or core_manifest.get('configuredMAMTargetVerified') is not True or not isinstance(runtime_manifest.get('n8nVersion'), str) or not re.fullmatch(r'\d+\.\d+\.\d+', runtime_manifest['n8nVersion']) or type(runtime_manifest.get('fileCount')) is not int or runtime_manifest['fileCount'] != len(runtime_manifest['files']) or not isinstance(runtime_manifest.get('containerId'), str) or not re.fullmatch('[0-9a-f]{64}', runtime_manifest['containerId']) or not isinstance(core_manifest.get('container'), str) or not re.fullmatch('[0-9a-f]{12,64}', core_manifest['container']) or not runtime_manifest['containerId'].startswith(core_manifest['container']):
        raise ValueError('HOLD_INSTALLED_ACQUISITION')
    for manifest, key, role in ((runtime_manifest, 'app/dist/public-api/v1/openapi.yml', 'installed-openapi'), (runtime_manifest, 'app/dist/public-api/v1/handlers/workflows/workflows.handler.js', 'installed-handler'), (core_manifest, 'dist/workflows/workflow.service.js', 'installed-service')):
        pin = manifest['files'][key]
        if pin['sha256'] != pins[role] or type(pin['bytes']) is not int or pin['bytes'] != len(values[role]):
            raise ValueError('HOLD_INSTALLED_CAPTURE_BINDING')
    handler, service, schema = (values[key].decode() for key in ('installed-handler', 'installed-service', 'installed-openapi'))
    if not all(text in handler for text in ('updateWorkflow:', 'forceSave: true', 'publicApi: true', 'publishIfActive: true', 'includeActiveVersion: true', 'const { versionId, name, description } = req.body')) or not all(text in service for text in ('async update(', "'staticData'", '...workflow.settings,', '...workflowUpdateData.settings,', 'workflow.activeVersionId && publishIfActive', 'return updatedWorkflow;', 'options?.versionId ?? workflow.versionId', "relations: ['activeVersion']")) or not all(text in schema for text in ('x-eov-operation-id: updateWorkflow', 'staticData:', 'versionId:')):
        raise ValueError('HOLD_INSTALLED_PROTOCOL_CONTRACT')
    if result['mailMode'] != 'disabled' or type(result['outboxPending']) is not int or result['outboxPending'] != 0 or result['singleWriter'] is not True or not c['json_equal'](result['currentSource'], packet['closure']['sourceHashes']):
        raise ValueError('HOLD_CURRENT_SAFETY')
    for name in ('publication', 'previousDeployment', 'deployment'):
        value = result[name]
        if not isinstance(value, dict) or not isinstance(value.get('head'), str) or not re.fullmatch('[0-9a-f]{40}', value['head']):
            raise ValueError('HOLD_PUBLICATION_SOURCE')
    publication, deployed = result['publication'], result['deployment']
    if publication.get('repository') != 'mobilityaccessmodifications/mam-team-management-system' or publication.get('branch') != 'main' or publication.get('verified') is not True or not isinstance(publication.get('publicationId'), str) or not publication['publicationId'] or deployed.get('head') != publication['head'] or deployed.get('project') != 'ai-7033s-projects/mam-team-management-system' or deployed.get('origin') != src.history['packet']['binding']['hubOrigin'] or deployed.get('state') != 'READY' or not isinstance(deployed.get('deploymentId'), str) or not deployed['deploymentId'] or not c['json_equal'](deployed.get('sourceHashes'), result['currentSource']):
        raise ValueError('HOLD_EXACT_CURRENT_DEPLOYMENT')
    baseline = result['baseline']
    c['validate_workflow'](baseline, src.original_graph, expected_id=src.identity, expected_version=src.original_version)
    if 'staticData' not in baseline or not isinstance(baseline.get('shared'), list) or not baseline['shared'] or baseline.get('isArchived') is not False or baseline.get('activeVersion') is not None or 'activeVersion' not in baseline:
        raise ValueError('HOLD_BASELINE_RETENTION')
    review = packet['review']
    if operation == 'activate-successor' and (not set(PROVIDER_CLAIMS) <= set(result) or result['providerSupported'] is not True or result['providerGraph'] != digest(c['canonical'](src.graph)) or not isinstance(result['providerSources'], dict) or not result['providerSources'] or any(key not in pins or pin != pins[key] for key, pin in result['providerSources'].items())):
        raise ValueError('HOLD_ACTUAL_CURRENT_PROVIDER_EVIDENCE')
    src.active_static_data = (baseline['staticData'],) if operation == 'correct-inactive' else activation_static_data(src, baseline, values, pins, runtime_manifest)
    src.check()
    return baseline


def parse_args(argv):
    if argv == ['prepare']:
        return 'prepare'
    if argv == ['correct-inactive', '--parent-correct-inactive']:
        return 'correct-inactive'
    if argv == ['activate-successor', '--parent-activate-successor']:
        return 'activate-successor'
    if argv == ['readback']:
        return 'readback'
    raise ValueError('HOLD_INVOCATION')


def parse_packet(raw):
    def unique(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError('HOLD_DUPLICATE_KEY')
            result[key] = value
        return result
    def invalid(value):
        raise ValueError('HOLD_NONFINITE_JSON')
    def finite(value):
        result = float(value)
        return result if math.isfinite(result) else invalid(value)
    return json.loads(raw, object_pairs_hook=unique, parse_constant=invalid, parse_float=finite)


def scope_for(src, baseline):
    c = src.current
    return {'originSha256': src.origin_sha, 'closureSha256': digest(c['canonical'](src.closure)),
            'graphSha256': digest(c['canonical'](src.graph)), 'identityBindingSha256': src.history['journal']['identityBindingSha256'],
            'retainedSha256': digest(c['canonical']({key: baseline[key] for key in RETAINED if key in baseline})),
            'id': src.identity, 'originalVersionId': src.original_version}


def open_journal(src, operation):
    meta = ORIGIN_ROOT.lstat()
    if ORIGIN_ROOT.resolve() != ORIGIN_ROOT or not stat.S_ISDIR(meta.st_mode) or meta.st_uid != os.geteuid() or stat.S_IMODE(meta.st_mode) != 0o700:
        raise ValueError('HOLD_ORIGINAL_DIRECTORY')
    parent = os.open(ORIGIN_ROOT, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        if operation == 'correct-inactive':
            os.mkdir(CHILD, mode=0o700, dir_fd=parent)
            os.fsync(parent)
        child = ORIGIN_ROOT / CHILD
        metadata = child.lstat()
        if child.resolve() != child or not stat.S_ISDIR(metadata.st_mode) or stat.S_IMODE(metadata.st_mode) != 0o700 or metadata.st_uid != os.geteuid():
            raise ValueError('HOLD_CONTINUATION_DIRECTORY')
        return src.current['NativeJournal'](str(child / 'attempt.json'))
    finally:
        os.close(parent)


def make_ports(src, journal):
    c = src.current
    identity = src.identity
    def allowed(method, path):
        return (method == 'GET' and path in ('workflows?limit=1', 'workflows/' + identity)) or (method == 'PUT' and path == 'workflows/' + identity) or (method == 'POST' and path == 'workflows/' + identity + '/activate')
    c['allowed_operation'] = allowed
    original_loader = c['load_verifier']
    def load_verifier(external):
        verifier = original_loader(external)
        original_config = verifier['load_local_env']
        def load_config():
            config = original_config()
            key = config.get('N8N_API_KEY') if isinstance(config, dict) else None
            journal.secrets = (key,) if isinstance(key, str) and key else ()
            return config
        verifier['load_local_env'] = load_config
        return verifier
    c['load_verifier'] = load_verifier
    try:
        return c['NativePorts'](src.history['packet']['binding'], src.external)
    finally:
        c['load_verifier'] = original_loader


def retained_equal(row, baseline, c, receipt=False, static_candidates=None):
    for key in RETAINED:
        if key == 'staticData' and static_candidates is not None:
            if key not in row or not any(c['json_equal'](row[key], candidate) for candidate in static_candidates):
                raise ValueError('HOLD_RETAINED_STATIC_DATA')
            continue
        if key == 'shared' and receipt and key not in row:
            continue
        if (key in row) != (key in baseline) or (key in baseline and not c['json_equal'](row[key], baseline[key])):
            raise ValueError('HOLD_RETAINED_STATE')


def exact(row, graph, baseline, src, version=None, active=False, receipt=False):
    c = src.current
    identity, saved = c['validate_workflow'](row, graph, active=active, expected_id=src.identity, expected_version=version)
    retained_equal(row, baseline, c, receipt, src.active_static_data if active else None)
    if 'activeVersion' not in row:
        raise ValueError('HOLD_PUBLICATION_PRESENCE')
    publication = row['activeVersion']
    if not active:
        if publication is not None:
            raise ValueError('HOLD_INACTIVE_PUBLICATION')
    else:
        if not isinstance(publication, dict) or any(key not in publication or not c['json_equal'](publication[key], graph[key]) for key in ('nodes', 'connections')):
            raise ValueError('HOLD_EXPANDED_PUBLICATION')
        for key, expected in (('versionId', saved), ('workflowId', identity)):
            if key in publication and (not isinstance(publication[key], str) or publication[key] != expected):
                raise ValueError('HOLD_NESTED_PUBLICATION_IDENTITY')
        for key in ('settings', 'name'):
            if key in publication and not c['json_equal'](publication[key], graph[key]):
                raise ValueError('HOLD_EXPANDED_PUBLICATION')
    return saved


def call(src, ports, method, path, body=None):
    try:
        value = ports.api(method, path, body)
        src.current['reject_secret'](value, ports.secrets)
    except BaseException:
        try:
            src.check()
        except BaseException:
            pass
        raise
    else:
        src.check()
        return value


def failure_projection(error, operation, src, journal):
    if journal is not None and journal.secrets is None:
        return None
    kind = type(error)
    label = {SystemExit: 'SystemExit', KeyboardInterrupt: 'KeyboardInterrupt', TimeoutError: 'TimeoutError',
             ValueError: 'ValueError', OSError: 'OSError', TypeError: 'TypeError', KeyError: 'KeyError',
             RuntimeError: 'RuntimeError'}.get(kind, 'UnknownError')
    code = None
    if kind is SystemExit and type(error.code) is int and error.code in (0, 1, 2, 73):
        code = error.code
    elif kind is ValueError and len(error.args) == 1 and type(error.args[0]) is str and error.args[0] in FAILURE_CODES:
        code = error.args[0]
    value = {'type': label, 'code': code, 'operation': operation if operation in ENTERED_OPERATIONS else None}
    if journal is not None:
        for key in value:
            try:
                src.current['reject_secret'](value[key], journal.secrets)
            except BaseException:
                value[key] = 'UnknownError' if key == 'type' else None
    return value


def main(argv=None, stdin=None):
    src = journal = ports = None
    state = None
    result = None
    failed = False
    failure = None
    entered = None
    try:
        operation = parse_args(sys.argv[1:] if argv is None else argv)
        if operation == 'prepare':
            src = Sources()
            result = {'schemaVersion': 1, 'closure': src.closure, 'originSha256': src.origin_sha, 'expectedGraph': src.graph,
                      'graphSha256': digest(src.current['canonical'](src.graph)), 'id': src.identity,
                      'originalVersionId': src.original_version, 'nativeReady': False}
        else:
            raw = (sys.stdin if stdin is None else stdin).read(1048577)
            if len(raw.encode()) > 1048576:
                raise ValueError('HOLD_INPUT_BOUND')
            packet = parse_packet(raw)
            src = Sources(packet['closure'])
            baseline = admission(packet, operation, src)
            journal = open_journal(src, operation)
            scope = scope_for(src, baseline)
            if operation == 'correct-inactive':
                if journal.load() is not None:
                    raise ValueError('HOLD_CONTINUATION_EXISTS')
                state = {'schemaVersion': 2, 'scope': scope, 'phase': 'HOLD_NOT_ENTERED', 'versionId': src.original_version,
                         'dispatches': {'correct': 0, 'activate': 0}, 'originalFailure': None,
                         'lastEnteredOperation': None, 'sourceHold': False}
                journal.save(state, initial=True)
            else:
                state = journal.load()
                src.current['closed'](state, ('schemaVersion', 'scope', 'phase', 'versionId', 'dispatches', 'originalFailure', 'lastEnteredOperation', 'sourceHold'))
                src.current['closed'](state['dispatches'], ('correct', 'activate'))
                if type(state['schemaVersion']) is not int or state['schemaVersion'] != 2 or state['originalFailure'] is not None or state['sourceHold'] is not False or state['lastEnteredOperation'] not in ('correct-inactive:GET-readback', 'activate-successor:GET-readback', 'readback:GET') or not src.current['json_equal'](state['scope'], scope) or state['phase'] not in ('CORRECTED_INACTIVE_VERIFIED', 'ACTIVATED_VERIFIED') or type(state['dispatches']['correct']) is not int or state['dispatches']['correct'] != 1 or type(state['dispatches']['activate']) is not int or state['dispatches']['activate'] != (1 if state['phase'] == 'ACTIVATED_VERIFIED' else 0) or state['versionId'] != packet['review']['expectedWorkflow']['versionId']:
                    raise ValueError('HOLD_CONTINUATION_OWNERSHIP')
                if operation == 'activate-successor' and state['phase'] != 'CORRECTED_INACTIVE_VERIFIED':
                    raise ValueError('HOLD_ACTIVATION_ALREADY_ENTERED')
            src.check()
            try:
                entered = 'transport-initialize'
                journal.secrets = None
                ports = make_ports(src, journal)
                journal.secrets = ports.secrets
                src.current['reject_secret'](packet, ports.secrets)
                entered = 'verify'
                ports.verify()
            except BaseException:
                try:
                    src.check()
                except BaseException:
                    pass
                raise
            else:
                src.check()
            active = state['phase'] == 'ACTIVATED_VERIFIED'
            graph = src.original_graph if operation == 'correct-inactive' else src.graph
            path = 'workflows/' + src.identity
            entered = operation + ':GET'
            row = call(src, ports, 'GET', path)
            exact(row, graph, baseline, src, state['versionId'], active)
            if operation != 'readback':
                review_admission(packet, operation, src, packet['review']['evidenceHashes'])
            if operation == 'correct-inactive':
                state['phase'] = 'HOLD_CORRECT_UNKNOWN'
                state['dispatches']['correct'] = 1
                journal.save(state)
                payload = {**src.graph, 'staticData': baseline['staticData']}
                entered = 'correct-inactive:PUT'
                row = call(src, ports, 'PUT', path, payload)
                version = exact(row, src.graph, baseline, src, receipt=True)
                if version == src.original_version:
                    raise ValueError('HOLD_SUCCESSOR_VERSION_NOT_NEW')
                state['versionId'] = version
                journal.save(state)
                entered = 'correct-inactive:GET-readback'
                exact(call(src, ports, 'GET', path), src.graph, baseline, src, version)
                state['phase'] = 'CORRECTED_INACTIVE_VERIFIED'
                state['lastEnteredOperation'] = entered
                journal.save(state)
            elif operation == 'activate-successor':
                state['phase'] = 'HOLD_ACTIVATE_UNKNOWN'
                state['dispatches']['activate'] = 1
                journal.save(state)
                entered = 'activate-successor:POST'
                row = call(src, ports, 'POST', path + '/activate', {'versionId': state['versionId']})
                exact(row, src.graph, baseline, src, state['versionId'], True, receipt=True)
                entered = 'activate-successor:GET-readback'
                exact(call(src, ports, 'GET', path), src.graph, baseline, src, state['versionId'], True)
                state['phase'] = 'ACTIVATED_VERIFIED'
                state['lastEnteredOperation'] = entered
                journal.save(state)
            else:
                state['lastEnteredOperation'] = entered
                journal.save(state)
            result = {'ok': True, 'phase': state['phase'], 'id': src.identity, 'versionId': state['versionId'],
                      'active': state['phase'] == 'ACTIVATED_VERIFIED', 'runtimeProviderVerified': operation == 'activate-successor'}
    except BaseException as error:
        failed = True
        failure = failure_projection(error, entered, src, journal)
    finally:
        if src is not None:
            try:
                src.check()
            except BaseException as error:
                failed = True
                if failure is None:
                    failure = failure_projection(error, entered, src, journal)
        if journal is not None:
            try:
                if failed:
                    if state is not None and failure is not None:
                        state['phase'] = 'HOLD_CONTINUATION_NO_RETRY'
                        state['originalFailure'] = failure
                        state['lastEnteredOperation'] = failure['operation']
                        state['sourceHold'] = state.get('sourceHold') is True or src.source_hold
                        journal.save(state)
                else:
                    src.current['reject_secret'](result, ports.secrets)
                    journal.finish()
                    src.check()
            except BaseException as error:
                failed = True
                if failure is None:
                    failure = failure_projection(error, entered, src, journal)
                if journal.closed:
                    try:
                        journal = src.current['NativeJournal'](str(ORIGIN_ROOT / CHILD / 'attempt.json'))
                        journal.secrets = ports.secrets
                    except BaseException:
                        pass
                if state is not None and failure is not None and not journal.closed:
                    try:
                        state['phase'] = 'HOLD_CONTINUATION_NO_RETRY'
                        state['originalFailure'] = failure
                        state['lastEnteredOperation'] = failure['operation']
                        state['sourceHold'] = state.get('sourceHold') is True or src.source_hold
                        journal.save(state)
                    except BaseException:
                        pass
            finally:
                try:
                    journal.close()
                except BaseException:
                    failed = True
    if failed:
        print('HOLD_CONTINUATION_NO_RETRY', file=sys.stderr)
        return 2
    print(json.dumps(result, ensure_ascii=False, allow_nan=False))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
