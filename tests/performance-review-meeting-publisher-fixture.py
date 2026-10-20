import copy
import importlib.util
import json
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('meeting_publisher', ROOT / 'scripts/publish-performance-review-meeting-workflows.py')
p = importlib.util.module_from_spec(spec)
spec.loader.exec_module(p)
V1 = '720f0200-0000-4000-8000-000000000001'
V2 = '720f0200-0000-4000-8000-000000000002'


class Fake:
    def __init__(self, kind='calendar', fault=None):
        self.rows = {}
        self.calls = []
        self.fault = fault
        if kind == 'notifications':
            baseline = copy.deepcopy(p.load_builder(kind))
            baseline['nodes'][1]['parameters']['jsCode'] = 'synthetic reviewed predecessor'
            p.PREDECESSOR['sha256'] = p.digest(baseline)
            self.rows[p.PREDECESSOR['id']] = {**baseline, 'id': p.PREDECESSOR['id'], 'versionId': p.PREDECESSOR['versionId'],
                                            'activeVersionId': p.PREDECESSOR['versionId'], 'active': True}

    def api(self, method, path, body=None):
        self.calls.append((method, path, copy.deepcopy(body)))
        if method == 'GET' and path.startswith('workflows?'):
            return {'data': copy.deepcopy(list(self.rows.values())), 'nextCursor': None}
        if method == 'GET' and path.startswith('executions?'):
            if self.fault == 'busy':
                return {'data': [{'id': 'synthetic-running'}]}
            return {'data': [], 'nextCursor': None}
        if method == 'POST' and path == 'workflows':
            if self.fault == 'create-before':
                raise RuntimeError('synthetic unknown before create')
            row = {**copy.deepcopy(body), 'id': 'calendar-owned', 'versionId': V1, 'active': False, 'activeVersionId': None}
            self.rows[row['id']] = row
            if self.fault == 'create-after':
                raise RuntimeError('synthetic unknown after create')
            return copy.deepcopy(row)
        identity = path.split('/')[1]
        row = self.rows[identity]
        if method == 'GET':
            return copy.deepcopy(row)
        if path.endswith('/deactivate'):
            if self.fault == 'pause-before':
                raise RuntimeError('synthetic unknown before pause')
            row.update(active=False, activeVersionId=None)
            if self.fault == 'pause-after':
                raise RuntimeError('synthetic unknown after pause')
        elif method == 'PUT':
            if self.fault == 'update-before':
                raise RuntimeError('synthetic unknown before update')
            row.update(copy.deepcopy(body), versionId=V2)
            if self.fault == 'update-after':
                raise RuntimeError('synthetic unknown after update')
        elif path.endswith('/activate'):
            assert body == {'versionId': row['versionId']}
            row.update(active=True, activeVersionId=row['versionId'])
            if self.fault == 'activate-after':
                raise RuntimeError('synthetic unknown after activation')
        else:
            raise AssertionError((method, path))
        return copy.deepcopy(row)

    def writes(self):
        return [call for call in self.calls if call[0] != 'GET']


def held(fn):
    try:
        fn()
    except RuntimeError:
        return
    raise AssertionError('Expected operation to hold')


count = 0
secret = 'synthetic-notification-readiness-' + '0' * 32
assert p.readiness_headers(secret) == {'X-MAM-Notification-Secret': secret}
for invalid in (None, '', 'x' * 31, 'x' * 513, secret + '\r\n', secret + '\x00'):
    held(lambda: p.readiness_headers(invalid))
count += 1
with tempfile.TemporaryDirectory(prefix='mam-meeting-publisher-') as directory:
    base = Path(directory)
    f = Fake()
    journal = base / 'calendar.json'
    staged = p.operate('stage', 'calendar', journal, None, None, f.api)
    assert staged['phase'] == 'staged' and len(f.writes()) == 1
    assert journal.stat().st_mode & 0o777 == 0o600
    held(lambda: p.operate('stage', 'calendar', journal, None, None, f.api))
    assert len(f.writes()) == 1
    active = p.operate('activate', 'calendar', journal, staged['id'], staged['versionId'], f.api)
    assert active['phase'] == 'active'
    readiness = []
    p.operate('readiness', 'calendar', journal, active['id'], active['versionId'], f.api,
              ready=lambda kind: readiness.append(kind) or {'ok': True, 'ready': True})
    assert readiness == ['calendar'] and len(f.writes()) == 2
    held(lambda: p.operate('activate', 'calendar', journal, active['id'], active['versionId'], f.api))
    assert len(f.writes()) == 2
    count += 1

    for fault in ('create-before', 'create-after'):
        f = Fake(fault=fault)
        journal = base / (fault + '.json')
        held(lambda: p.operate('stage', 'calendar', journal, None, None, f.api))
        held(lambda: p.operate('stage', 'calendar', journal, None, None, f.api))
        assert len(f.writes()) == 1
        if fault == 'create-after':
            result = p.operate('readback', 'calendar', journal, None, None, f.api)
            assert result['id'] == 'calendar-owned' and result['phase'] == 'staged'
        else:
            held(lambda: p.operate('readback', 'calendar', journal, None, None, f.api))
        assert len(f.writes()) == 1
        count += 1

    f = Fake()
    journal = base / 'activate-lost.json'
    staged = p.operate('stage', 'calendar', journal, None, None, f.api)
    f.fault = 'activate-after'
    held(lambda: p.operate('activate', 'calendar', journal, staged['id'], staged['versionId'], f.api))
    result = p.operate('readback', 'calendar', journal, staged['id'], staged['versionId'], f.api)
    assert result['phase'] == 'active'
    assert len(f.writes()) == 2
    count += 1

    for fault in ('wrong-id', 'wrong-version', 'graph-differs', 'published-differs'):
        f = Fake('notifications')
        journal = base / (fault + '.json')
        row = f.rows[p.PREDECESSOR['id']]
        if fault == 'graph-differs':
            row['settings']['executionTimeout'] = 999
        if fault == 'published-differs':
            row['activeVersionId'] = V1
        held(lambda: p.operate('stage', 'notifications', journal,
             'other' if fault == 'wrong-id' else p.PREDECESSOR['id'],
             'wrong' if fault == 'wrong-version' else p.PREDECESSOR['versionId'], f.api))
        assert not f.writes() and not journal.exists()
        count += 1

    for fault in (None, 'update-after', 'busy'):
        f = Fake('notifications', fault=fault)
        journal = base / ('notifications-' + str(fault) + '.json')
        invoke = lambda: p.operate('stage', 'notifications', journal, p.PREDECESSOR['id'], p.PREDECESSOR['versionId'], f.api, pause=lambda _: None)
        if fault in ('update-after', 'busy'):
            held(invoke)
            if fault == 'update-after':
                result = p.operate('readback', 'notifications', journal, None, None, f.api)
                assert result['phase'] == 'staged' and result['versionId'] == V2
                assert len(f.writes()) == 2
            else:
                assert len(f.writes()) == 1
                assert f.rows[p.PREDECESSOR['id']]['active'] is False
                assert not any(call[0] == 'PUT' for call in f.calls)
        else:
            result = invoke()
            assert result['phase'] == 'staged'
            assert [call[0] for call in f.writes()] == ['POST', 'PUT']
            assert not f.rows[p.PREDECESSOR['id']]['active']
            p.operate('activate', 'notifications', journal, result['id'], result['versionId'], f.api)
            assert f.rows[p.PREDECESSOR['id']]['active']
        count += 1

    for fault in ('pause-before', 'pause-after', 'update-before', 'busy'):
        f = Fake('notifications', fault=fault)
        journal = base / ('continued-' + fault + '.json')
        held(lambda: p.operate('stage', 'notifications', journal, p.PREDECESSOR['id'], p.PREDECESSOR['versionId'], f.api, pause=lambda _: None))
        writes = len(f.writes())
        result = p.operate('readback', 'notifications', journal, None, None, f.api)
        assert result['phase'] == ('pause_required' if fault == 'pause-before' else 'paused')
        assert len(f.writes()) == writes
        f.fault = None
        result = p.operate('continue', 'notifications', journal, result['id'], result['versionId'], f.api, pause=lambda _: None)
        assert result['phase'] == 'staged' and result['versionId'] == V2
        assert sum(call[0] == 'PUT' for call in f.calls) == (2 if fault == 'update-before' else 1)
        assert not f.rows[p.PREDECESSOR['id']]['active']
        p.operate('activate', 'notifications', journal, result['id'], result['versionId'], f.api)
        assert f.rows[p.PREDECESSOR['id']]['active']
        count += 1

    f = Fake()
    journal = base / 'target-bound.json'
    result = p.operate('stage', 'calendar', journal, None, None, f.api, target_origin='https://mam.synthetic.invalid')
    calls = len(f.calls)
    held(lambda: p.operate('readback', 'calendar', journal, None, None, f.api, target_origin='https://other.synthetic.invalid'))
    assert len(f.calls) == calls
    assert p.operate('readback', 'calendar', journal, None, None, f.api, target_origin='https://mam.synthetic.invalid')['phase'] == 'staged'
    count += 1

    f = Fake()
    journal = base / 'readiness-held.json'
    staged = p.operate('stage', 'calendar', journal, None, None, f.api)
    held(lambda: p.operate('readiness', 'calendar', journal, staged['id'], staged['versionId'], f.api,
                          ready=lambda _: {'ok': True, 'ready': True}))
    p.operate('activate', 'calendar', journal, staged['id'], staged['versionId'], f.api)
    for evidence in ({'ok': False, 'ready': False}, {'ok': True, 'ready': True, 'extra': 'PRIVATE'}):
        held(lambda: p.operate('readiness', 'calendar', journal, staged['id'], staged['versionId'], f.api, ready=lambda _: evidence))
    assert len(f.writes()) == 2
    count += 1

print(json.dumps({'ok': True, 'cases': count, 'providerCalls': 0, 'realN8nCalls': 0}))
