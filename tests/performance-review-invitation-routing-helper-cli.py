import contextlib
import copy
import hashlib
import io
import json
import os
from pathlib import Path
import runpy
import shutil
import subprocess
import sys
import tempfile
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
mode = sys.argv[1]
base = Path(tempfile.mkdtemp(prefix='pr-routing-cli-')).resolve()
root = base / 'source'
root.mkdir()
private = base / 'operator'
private.mkdir(mode=0o700)
paths = [
    'scripts/deploy-performance-review-invitation-routing.py',
    'scripts/deploy-staff-leave-calendar.py',
    'scripts/performance-review-invitation-routing-catalog-20261020235553.pg17.json',
    'supabase/migrations/20261001130000_confirmed_test_identity_cleanup.sql',
    'supabase/migrations/20261020232835_performance_review_meeting_invitation_status.sql',
    'supabase/migrations/20261020235553_performance_review_invitation_manager_routing.sql',
]
for name in paths:
    path = root / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes((ROOT / name).read_bytes())
helper = root / paths[0]
m = runpy.run_path(str(helper))
source = m['MIGRATION'].read_text()
predecessor = m['PREDECESSOR'].read_text()
expected = m['expected_catalog'](source)
pre_catalog = dict(expected)
pre_catalog[m['SIGNATURES'][-1]] = None
sha = lambda value: hashlib.sha256(value).hexdigest()
ledger = [{'version': m['PREDECESSOR_VERSION'], 'name': m['PREDECESSOR_NAME'], 'rowSha256': '4' * 64, 'sourceArraySha256': '5' * 64}]
state = {'major': 17, 'actor': 'postgres', 'session': 'postgres', 'readOnly': 'on', 'catalogHash': 'a' * 64, 'preservedHash': 'b' * 64, 'storedHash': 'a' * 64, 'purgeRows': 1, 'predecessorExact': True, 'predecessorFunctionsExact': True, 'targetPresent': False, 'targetExact': False, 'ledger': ledger, 'featureCatalog': pre_catalog, 'bodies': m['predecessor_bodies'](source), 'ready': False}
counts = {'projectReads': 0, 'metadataReads': 0, 'mutationDispatches': 0}
active_fault = None
class Response:
    def __init__(self, value):
        self.buffer = io.BytesIO(json.dumps(value).encode())
    def __enter__(self):
        return self
    def __exit__(self, *args):
        pass
    def read(self, *args):
        return self.buffer.read(*args)
def api(request, **kwargs):
    global state
    if request.full_url == 'https://api.supabase.com/v1/projects/xtwlrjqbusadghavchqm' and request.data is None:
        counts['projectReads'] += 1
        if active_fault == 'source-race':
            helper.write_bytes(helper.read_bytes() + b'\n')
        return Response({'id': 'foreign-project' if mode == 'wrong-project' else m['PROJECT'], 'organization_id': 'foreign-org' if mode == 'wrong-org' else m['ORGANIZATION']})
    assert request.full_url == 'https://api.supabase.com/v1/projects/xtwlrjqbusadghavchqm/database/query'
    body = json.loads(request.data)
    assert set(body) == {'query'}
    sql = body['query']
    if sql.startswith('begin read only;'):
        counts['metadataReads'] += 1
        if active_fault == 'readback-error' and counts['mutationDispatches']:
            raise TimeoutError('synthetic-provider-detail')
        return Response([{'state': copy.deepcopy(state)}])
    counts['mutationDispatches'] += 1
    journal = json.loads((private / (m['VERSION'] + '.entered.json')).read_text())
    assert journal['enteredMutation'] is True and journal['querySha256'] == sha(sql.encode())
    assert 'lock table supabase_migrations.schema_migrations in access exclusive mode nowait;' in sql
    assert 'insert into supabase_migrations.schema_migrations' in sql and m['literal'](predecessor) in sql and m['literal'](source) in sql
    if active_fault == 'unknown-before':
        raise TimeoutError('synthetic-provider-detail')
    state = copy.deepcopy(state)
    state.update(targetPresent=True, targetExact=True, catalogHash='d' * 64, storedHash='d' * 64, featureCatalog=copy.deepcopy(expected), bodies=m['expected_bodies'](source), ready=True)
    state['ledger'].append({'version': m['VERSION'], 'name': m['NAME'], 'rowSha256': '6' * 64, 'sourceArraySha256': '7' * 64})
    if active_fault == 'unknown-after':
        raise TimeoutError('synthetic-provider-detail')
    if active_fault == 'malformed-attestation':
        return Response([{'resultingCatalogSha256': 'd' * 64, 'unexpected': True}])
    if active_fault == 'drift-ledger':
        state['ledger'][0]['rowSha256'] = '9' * 64
    if active_fault == 'drift-catalog':
        state['featureCatalog'][m['SIGNATURES'][-1]]['securityDefiner'] = True
    return Response([{'resultingCatalogSha256': 'd' * 64}])
git_binary = shutil.which('git')
assert git_binary is not None
safe_env = {'PATH': os.defpath, 'LANG': 'C', 'LC_ALL': 'C', 'GIT_CONFIG_NOSYSTEM': '1', 'GIT_CONFIG_GLOBAL': '/dev/null', 'GIT_CONFIG_SYSTEM': '/dev/null'}
def git(*args):
    return subprocess.check_output([git_binary, '-c', 'core.hooksPath=/dev/null', *args], cwd=root, env=safe_env, stderr=subprocess.PIPE)
git('init', '--quiet', '--template=')
git('config', '--local', 'user.name', 'mobilityaccessmodifications')
git('config', '--local', 'user.email', '310802599+mobilityaccessmodifications@users.noreply.github.com')
git('remote', 'add', 'origin', 'https://github.com/mobilityaccessmodifications/mam-team-management-system.git')
git('add', '--', *paths)
git('commit', '--quiet', '-m', 'Synthetic invitation routing source')
head = git('rev-parse', 'HEAD').decode().strip()
args = [head] + [sha(path.read_bytes()) for path in (helper, m['TRANSPORT'], m['MIGRATION'], m['PREDECESSOR'])]
def invoke(command, extra=()):
    out, err = io.StringIO(), io.StringIO()
    old_cwd, old_argv = Path.cwd(), sys.argv
    try:
        os.chdir(root)
        sys.argv = [str(helper), command] + args + list(extra)
        with patch('urllib.request.urlopen', api), patch.dict(os.environ, {'SUPABASE_ACCESS_TOKEN': 'synthetic-inert-only', 'CODEX_COMPANY_PROFILE': 'mam', 'PATH': os.defpath}, clear=True), contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            try:
                runpy.run_path(str(helper), run_name='__main__')
                code = 0
            except SystemExit as error:
                code = error.code if isinstance(error.code, int) else 1
                err.write(str(error.code))
        return {'exit': code, 'stdout': out.getvalue(), 'stderr': err.getvalue()}
    finally:
        os.chdir(old_cwd)
        sys.argv = old_argv
try:
    if mode in ('wrong-project', 'wrong-org', 'bad-pin', 'dirty-source', 'wrong-origin', 'wrong-author', 'bad-predecessor', 'duplicate-ledger', 'wrong-major'):
        if mode == 'bad-pin':
            args[1] = '9' * 64
        if mode == 'dirty-source':
            helper.write_bytes(helper.read_bytes() + b'\n')
        if mode == 'wrong-origin':
            git('remote', 'set-url', 'origin', 'https://github.com/foreign-company/foreign.git')
        if mode == 'wrong-author':
            git('config', '--local', 'user.name', 'Synthetic foreign author')
            git('commit', '--quiet', '--amend', '--no-edit', '--reset-author')
            args[0] = git('rev-parse', 'HEAD').decode().strip()
        if mode == 'bad-predecessor':
            state['predecessorExact'] = False
        if mode == 'duplicate-ledger':
            state['ledger'].append(copy.deepcopy(state['ledger'][0]))
        if mode == 'wrong-major':
            state['major'] = 16
        result = invoke('inspect')
        assert result['exit'] != 0, result
        assert counts['mutationDispatches'] == 0 and not list(private.iterdir())
    else:
        result = invoke('snapshot', [str(private / 'before.json')])
        assert result['exit'] == 0, result
        pin = sha((private / 'before.json').read_bytes())
        if mode == 'inspect':
            assert json.loads(result['stdout'])['predecessorVerified'] is True
            assert counts['mutationDispatches'] == 0
        else:
            active_fault = None if mode == 'apply' else mode
            result = invoke('apply', [str(private / 'before.json'), pin])
            if mode == 'apply':
                assert result['exit'] == 0, result
                assert json.loads(result['stdout'])['readbackVerified'] is True
                for command in ('apply', 'readback'):
                    again = invoke(command, [str(private / 'before.json'), pin])
                    assert again['exit'] == 0 and json.loads(again['stdout'])['recorded'] is True, again
            elif mode == 'source-race':
                assert result['exit'] != 0 and counts['mutationDispatches'] == 0, result
            else:
                assert result['exit'] != 0 and 'HOLD' in result['stderr'] and 'synthetic-provider-detail' not in result['stderr'], result
                journal = (private / (m['VERSION'] + '.entered.json')).read_bytes()
                active_fault = None
                again = invoke('apply', [str(private / 'before.json'), pin])
                assert again['exit'] != 0 and counts['mutationDispatches'] == 1 and (private / (m['VERSION'] + '.entered.json')).read_bytes() == journal, again
                readback = invoke('readback', [str(private / 'before.json'), pin])
                assert (readback['exit'] == 0) == (mode in ('unknown-after', 'malformed-attestation', 'readback-error')), readback
            assert counts['mutationDispatches'] == (0 if mode == 'source-race' else 1)
    print(json.dumps({'classification': 'MODEL_CLI_INERT_MANAGEMENT_REAL_GIT', 'scenario': mode, 'counts': counts}))
finally:
    shutil.rmtree(base)
