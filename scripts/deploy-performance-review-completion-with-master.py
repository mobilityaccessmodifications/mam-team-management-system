import hashlib
import os
from pathlib import Path
import re
import subprocess
import sys
import types

LOADED_CODE = sys._getframe().f_code
HELPER = Path(__file__).resolve()
ROOT = HELPER.parents[1]
BASE_PATH = ROOT / 'scripts/deploy-performance-review-completion.py'
BASE_SHA256 = '5096c972577704d0dcbc6054dc4d871148ab63da99ff545c1e776da2b5f358bb'
MASTER = 'supabase/migrations/20261019000000_performance_review_master_sync.sql'
MASTER_SHA256 = '9e551d7776b791b2ac7c2913bc298ee4f609ace9d3f317d9575834e4cf621757'


def require(condition, message):
    if not condition:
        raise SystemExit(message)


raw = BASE_PATH.read_bytes()
require(not BASE_PATH.is_symlink() and hashlib.sha256(raw).hexdigest() == BASE_SHA256, 'Reviewed completion helper differs')
BASE = types.ModuleType('performance_completion_with_master_base')
BASE.__file__ = str(BASE_PATH)
exec(compile(raw, str(BASE_PATH), 'exec', dont_inherit=True), BASE.__dict__)


def local_migrations():
    rows = []
    versions = set()
    for path in sorted(BASE.MIGRATION.parent.glob('*.sql')):
        match = re.fullmatch(r'([0-9]{14})_([a-z][a-z0-9_]*)\.sql', path.name)
        require(match is not None and not path.is_symlink() and path.is_file(), 'Malformed migration filename or source')
        version, name = match.groups()
        require(version not in versions, 'Duplicate local migration version')
        versions.add(version)
        rows.append({'version': version, 'name': name, 'sha256': BASE.sha(path.read_bytes())})
    require(1 <= len(rows) <= 512, 'Unbounded local migration set')
    historical = [row for row in rows if row['version'] <= '20261016150000']
    require(BASE.sha(BASE.encoded(historical).encode()) == BASE.BASE_LOCAL_SHA256, 'Historical local migration source drift')
    pending = [row for row in rows if row['version'] > '20261016150000']
    require([row['version'] for row in pending] == ['20261017103000', '20261019000000'], 'Later or unrelated pending local migration')
    require(pending[1] == {'version': '20261019000000', 'name': 'performance_review_master_sync', 'sha256': MASTER_SHA256}, 'Reviewed pending Master source differs')
    return rows


def clean_source(reviewed_head, held):
    compiled = compile(held[HELPER], str(HELPER), 'exec', dont_inherit=True)
    require(LOADED_CODE == compiled, 'Loaded continuation differs from reviewed bytes')
    for code in compiled.co_consts:
        if isinstance(code, types.CodeType):
            function = globals().get(code.co_name)
            require(isinstance(function, types.FunctionType) and function.__code__ == code, 'Loaded continuation callable differs')
    require(set(BASE.__dict__) == set(BINDINGS) and all(BASE.__dict__[key] is value for key, value in BINDINGS.items()), 'Loaded completion binding differs')
    require(all(function.__code__ == code and function.__defaults__ == defaults for function, code, defaults in CALLABLES), 'Loaded completion callable differs')
    require(BASE.SOURCE_CLOSURE_SHA256 == CLOSURE, 'Completion dependency binding differs')
    require(Path.cwd().resolve() == ROOT, 'Run from the exact MAM repository root')
    environment = {key: value for key, value in os.environ.items() if not key.startswith('GIT_')}
    environment.update(GIT_CONFIG_NOSYSTEM='1', GIT_CONFIG_GLOBAL='/dev/null', GIT_CONFIG_SYSTEM='/dev/null', GIT_NO_REPLACE_OBJECTS='1', GIT_OPTIONAL_LOCKS='0')
    def git(*args):
        return subprocess.check_output(['git', '-c', 'core.fsmonitor=false', *args], cwd=ROOT, env=environment, stderr=subprocess.PIPE)
    require(Path(git('rev-parse', '--show-toplevel').decode().strip()).resolve() == ROOT, 'Wrong Git source root')
    require(git('rev-parse', 'HEAD').decode().strip() == reviewed_head, 'Reviewed HEAD differs')
    require(not git('status', '--porcelain').strip(), 'Release tree must be clean')
    require(git('remote', 'get-url', 'origin').decode().strip() == 'https://github.com/mobilityaccessmodifications/mam-team-management-system.git', 'Wrong MAM repository')
    require(git('show', '-s', '--format=%an <%ae>', 'HEAD').decode().strip() == 'mobilityaccessmodifications <310802599+mobilityaccessmodifications@users.noreply.github.com>', 'Wrong MAM source author')
    for path, data in held.items():
        require(git('show', 'HEAD:' + str(path.relative_to(ROOT))) == data == path.read_bytes(), 'Committed release bytes differ')


COMPLETION_EXPRESSIONS = BASE.expressions
COMPLETION_COMMON = BASE.validate_common
COMPLETION_TRANSACTION = BASE.transaction
COMPLETION_PATH = ROOT / 'supabase/migrations/20261017103000_performance_review_completion_guards.sql'
COMPLETION_SHA256 = '875b2b462822f20a7c78b97fb65079c82ad38de61fe31c5a5e1428cb9e31a961'


def master_expressions(source):
    completion = COMPLETION_PATH.read_bytes()
    require(BASE.sha(completion) == COMPLETION_SHA256, 'Reviewed completion predecessor differs')
    result = COMPLETION_EXPRESSIONS(completion.decode())
    for field in ('security', 'data', 'metadata'):
        marker = '$performance_' + field + '$'
        require(source.count(marker) == 2, 'Master inspection expression differs')
        body = source.split(marker)[1]
        require(body.startswith('\n') and body.endswith(';\n'), 'Master expression boundaries differ')
        result[field] = body[1:-2]
    ledger = "array['private.confirmed_test_purge_schema']"
    require(result['data'].count(ledger) == 1, 'Master complete data expression differs')
    result['data'] = result['data'].replace(ledger, "array['private.confirmed_test_purge_schema','supabase_migrations.schema_migrations']")
    absent = {'functions': {}, 'relations': {name: None for name in ('private.performance_review_master_targets', 'private.performance_review_master_queue', 'private.performance_review_master_attempts')}, 'sequences': None}
    result['metadata'] = "select case when metadata=" + BASE.literal(BASE.encoded(absent)) + "::jsonb then to_jsonb('absent'::text) else to_jsonb(encode(extensions.digest(metadata::text,'sha256'),'hex')) end from (select (" + result['metadata'] + ') metadata) master_feature'
    marker = '$master_feature_pins$'
    require(source.count(marker) == 2, 'Master complete feature pins differ')
    variants = BASE.load_json(source.split(marker)[1])
    require(set(variants) == {'16', '17'} and re.fullmatch('[0-9a-f]{64}', variants['17']) is not None, 'Master major-specific feature pin required')
    result['expected'] = variants['17']
    result['beforeExpected'] = 'absent'
    return result


def master_validate_common(state, source):
    ledger = state.get('ledger')
    require(isinstance(ledger, list) and 1 <= len(ledger) <= 512, 'Invalid bounded native ledger')
    require(all(isinstance(row, dict) and isinstance(row.get('version'), str) for row in ledger), 'Invalid native ledger row')
    versions = [row['version'] for row in ledger]
    require(versions == sorted(set(versions)), 'Duplicate or unordered native migration version')
    completion = [row for row in ledger if row['version'] == '20261017103000']
    require(len(completion) == 1, 'Exact completion predecessor ledger required')
    row = completion[0]
    require(set(row) == {'version', 'name', 'dimensions', 'statementCount', 'isNull', 'ndims', 'lower', 'upper', 'sourceArraySha256', 'sourceRoundtrip', 'rowSha256', 'elements'}, 'Invalid completion ledger row shape')
    require(row['name'] == 'performance_review_completion_guards' and row['dimensions'] == '[1:1]' and row['isNull'] is False and row['sourceRoundtrip'] is True, 'Completion predecessor native array differs')
    require(all(type(row[key]) is int and row[key] == 1 for key in ('statementCount', 'ndims', 'lower', 'upper')), 'Completion predecessor native bounds differ')
    require(all(isinstance(row[key], str) and re.fullmatch('[0-9a-f]{64}', row[key]) is not None for key in ('sourceArraySha256', 'rowSha256')), 'Completion predecessor native digest differs')
    require(row['elements'] == [{'subscript': 1, 'isNull': False, 'sha256': COMPLETION_SHA256, 'bytes': len(COMPLETION_PATH.read_bytes())}], 'Completion predecessor exact raw element differs')
    COMPLETION_COMMON(dict(state, ledger=[item for item in ledger if item['version'] != '20261017103000']), source)
    return ledger


def master_transaction(source, before, predecessor):
    query = COMPLETION_TRANSACTION(source, before, predecessor)
    start, end = 'do $master_preservation_final$', 'end $master_preservation_final$;'
    require(source.count(start) == 1 and source.count(end) == 1, 'Master final assertion boundaries differ')
    final = source[source.index(start):source.index(end) + len(end)]
    data = '\n  or pg_temp.master_preserve_data() is distinct from (select data from master_preservation_before)'
    require(final.count(data) == 1, 'Master data assertion differs')
    final = final.replace(data, '')
    marker = '\nset constraints all immediate;\nselect pg_temp.performance_release_assert();\ndo $performance_release_final$'
    require(query.count(marker) == 1, 'Master outer envelope assertion boundary differs')
    return query.replace(marker, '\nset constraints all immediate;\n' + final + '\ndo $performance_release_final$')


MASTER_PHASE = len(sys.argv) > 1 and sys.argv[1] == 'master'
if MASTER_PHASE:
    BASE.VERSION = '20261019000000'
    BASE.NAME = 'performance_review_master_sync'
    BASE.PREDECESSOR_VERSION = '20261017103000'
    BASE.PREDECESSOR_NAME = 'performance_review_completion_guards'
    BASE.MIGRATION = ROOT / MASTER
    BASE.PREDECESSOR = COMPLETION_PATH
    BASE.expressions = master_expressions
    BASE.validate_common = master_validate_common
    BASE.transaction = master_transaction

BASE.HELPER = HELPER
BASE.local_migrations = local_migrations
BASE.clean_source = clean_source
BASE.SOURCE_CLOSURE_SHA256 = {**BASE.SOURCE_CLOSURE_SHA256, str(BASE_PATH.relative_to(ROOT)): BASE_SHA256, MASTER: MASTER_SHA256, str(COMPLETION_PATH.relative_to(ROOT)): COMPLETION_SHA256}
CLOSURE = dict(BASE.SOURCE_CLOSURE_SHA256)
BINDINGS = dict(BASE.__dict__)
CALLABLES = []
for value in BINDINGS.values():
    if isinstance(value, types.FunctionType):
        CALLABLES.append((value, value.__code__, value.__defaults__))

if __name__ == '__main__':
    BASE.main(sys.argv[2:] if MASTER_PHASE else None)
