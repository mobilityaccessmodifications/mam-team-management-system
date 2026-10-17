import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import types

LOADED_CODE = sys._getframe().f_code
HELPER = Path(__file__).resolve()
ROOT = HELPER.parents[1]
VERSION = '20261017103000'
NAME = 'performance_review_completion_guards'
PREDECESSOR_VERSION = '20261016150000'
PREDECESSOR_NAME = 'performance_reviews_and_mail'
MIGRATION = ROOT / 'supabase/migrations' / (VERSION + '_' + NAME + '.sql')
PREDECESSOR = MIGRATION.parent / (PREDECESSOR_VERSION + '_' + PREDECESSOR_NAME + '.sql')
TRANSPORT = ROOT / 'scripts/deploy-staff-leave-calendar.py'
BASE_LOCAL_SHA256 = '0772c4009cd9b3b5f516d9aa8c0e8369c348d73dfa8a65867ed681d767e91146'
BASE_LEDGER_SHA256 = '85927554e51acee968502af5fd6c02526abd0ee760f6189d91a095406c9aa0dc'

SOURCE_CLOSURE_SHA256 = {'scripts/deploy-performance-reviews.py': 'c15e422fc7b95833b225d5a7f018f896d3ea75bb28b8ee51ad7280696f29a2c6', 'src/lib/performance-review-rules.ts': 'a79091dc94ea529a679375859ef618e76b0a5b40888fb1b0e546353022d15e76', 'src/lib/performance-review-word.mjs': 'b0486a433a1e6abdb40ad0082004d4296aa3d075f870d5ee920397257109b56a', 'src/lib/performance-review-questions.mjs': '9af2edc812ec465fe14a4d865e68606cee04d4fb122c5dcbf0ba9b94ebcdf561', 'src/lib/performance-review-document.ts': '8d2ddc8c8a63e462bd34d9b991c64583e757e4b6509a05957ec8d121490e6d15', 'src/lib/performance-review-types.ts': '2a582598026a6f263beab0bd865094a3cb8276ec2b8041e5cd5fe1a9e1782bf2', 'src/lib/performance-review-auth.ts': 'd2e09f37ab8539560c56e648c98b8c03943b5c9d7b6bb9543ae30fed2b6ed7b9', 'src/app/performance-reviews/actions.ts': '8ffd4b5acd702cb0ccac1c7311b0a5990b460b3f4686002ccc28742a0de0f92c', 'package.json': '03cbda82e367c7414e60c69813493fede7fc9232964545545b42848911abff9f', 'package-lock.json': 'cd5912ad3877f756529cc0d5a81cd17daacf9a1ed5990eb9f202be511886e490'}


def require(condition, message):
    if not condition:
        raise SystemExit(message)


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def literal(value):
    return "'" + value.replace("'", "''") + "'"


def encoded(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), allow_nan=False)


def load_json(raw):
    def pairs(items):
        result = {}
        for key, value in items:
            require(key not in result, 'Duplicate JSON key')
            result[key] = value
        return result
    def invalid(value):
        raise SystemExit('Non-finite JSON value')
    return json.loads(raw, object_pairs_hook=pairs, parse_constant=invalid)


def transaction_body(source):
    require(source.startswith('begin;\n') and source.endswith('\ncommit;\n') and '\r' not in source, 'Unsupported raw migration boundaries')
    return source[len('begin;\n'):-len('commit;\n')]


def expressions(source):
    result = {}
    for field in ('security', 'data', 'metadata'):
        marker = '$performance_' + field + '$'
        require(source.count(marker) == 2, 'Migration inspection expression differs')
        body = source.split(marker)[1]
        require(body.startswith('\n') and body.endswith(';\n'), 'Migration expression boundaries differ')
        result[field] = body[1:-2]
    match = re.search(r'\$performance_expected\$(.*?)\$performance_expected\$', source, re.S)
    require(match is not None, 'Missing exact feature specification')
    variants = load_json(match.group(1))
    require(isinstance(variants, dict) and set(variants) == {'16', '17'}, 'Exact supported feature metadata variants required')
    result['expected'] = variants['17']
    before = re.search(r'\$completion_before\$(.*?)\$completion_before\$', source, re.S)
    require(before is not None, 'Missing exact completion predecessor metadata')
    result['beforeExpected'] = load_json(before.group(1))['17']
    match = re.search(r"anchors jsonb; expected jsonb:='(.*?)'::jsonb;", source, re.S)
    require(match is not None, 'Missing authorization predecessor pins')
    result['anchorsExpected'] = load_json(match.group(1).replace("''", "'"))
    start = source.index(' anchors:=(') + len(' anchors:=(')
    end = source.index(');\n select jsonb_object_agg', start)
    result['anchors'] = source[start:end]
    return result


def local_migrations():
    rows = []
    versions = set()
    for path in sorted(MIGRATION.parent.glob('*.sql')):
        match = re.fullmatch(r'([0-9]{14})_([a-z][a-z0-9_]*)\.sql', path.name)
        require(match is not None and not path.is_symlink() and path.is_file(), 'Malformed migration filename or source')
        version, name = match.groups()
        require(version not in versions, 'Duplicate local migration version')
        versions.add(version)
        rows.append({'version': version, 'name': name, 'sha256': sha(path.read_bytes())})
    require(1 <= len(rows) <= 512, 'Unbounded local migration set')
    historical = [row for row in rows if row['version'] <= PREDECESSOR_VERSION]
    require(sha(encoded(historical).encode()) == BASE_LOCAL_SHA256, 'Historical local migration source drift')
    require([row['version'] for row in rows if row['version'] > PREDECESSOR_VERSION] == [VERSION], 'Later or unrelated pending local migration')
    return rows


def state_expression(source, predecessor):
    e = expressions(source)
    return f"""jsonb_build_object(
'major',current_setting('server_version_num')::integer/10000,'actor',current_user,'session',session_user,'readOnly',current_setting('transaction_read_only'),
'securityHash',encode(extensions.digest(({e['security']})::text,'sha256'),'hex'),
'dataHash',encode(extensions.digest(({e['data']})::text,'sha256'),'hex'),
'catalogHash',private.confirmed_test_purge_schema_hash(),
'catalogMatches',(select count(*)=1 and bool_and(singleton and schema_hash=private.confirmed_test_purge_schema_hash()) from private.confirmed_test_purge_schema),
'predecessorExact',coalesce((select name={literal(PREDECESSOR_NAME)} and array_dims(statements)='[1:1]' and statements=ARRAY[{literal(predecessor)}]::text[] from supabase_migrations.schema_migrations where version={literal(PREDECESSOR_VERSION)}),false),
'targetExact',coalesce((select name={literal(NAME)} and array_dims(statements)='[1:1]' and statements=ARRAY[{literal(source)}]::text[] from supabase_migrations.schema_migrations where version={literal(VERSION)}),false),
'ledger',(select coalesce(jsonb_agg(jsonb_build_object('version',m.version,'name',m.name,'dimensions',array_dims(m.statements),'statementCount',cardinality(m.statements),
'isNull',m.statements is null,'ndims',array_ndims(m.statements),'lower',array_lower(m.statements,1),'upper',array_upper(m.statements,1),
'sourceArraySha256',encode(extensions.digest(coalesce(m.statements::text,'<NULL>'),'sha256'),'hex'),
'sourceRoundtrip',m.statements is not distinct from (m.statements::text)::text[],
'rowSha256',encode(extensions.digest(to_jsonb(m)::text,'sha256'),'hex'),
'elements',(select coalesce(jsonb_agg(jsonb_build_object('subscript',i,'isNull',m.statements[i] is null,'sha256',encode(extensions.digest(m.statements[i],'sha256'),'hex'),'bytes',octet_length(m.statements[i])) order by i),'[]') from generate_subscripts(m.statements,1) i)) order by m.version),'[]') from supabase_migrations.schema_migrations m),
'anchors',(select jsonb_object_agg(key,value-'acl') from jsonb_each(({e['anchors']}))),
'feature',({e['metadata']}))"""


def read_state(source, predecessor, query):
    result = query("begin read only; set local search_path=''; set local lock_timeout='3s'; set local statement_timeout='30s';\nselect " + state_expression(source, predecessor) + ' as state; rollback;')
    require(isinstance(result, list) and len(result) == 1 and isinstance(result[0], dict) and set(result[0]) == {'state'} and isinstance(result[0]['state'], dict), 'Invalid metadata response shape')
    return result[0]['state']


def validate_common(state, source):
    require(type(state.get('major')) is int and state['major'] == 17, 'Exact reviewed PostgreSQL major 17 required')
    require(state.get('actor') == state.get('session') == 'postgres' and state.get('readOnly') == 'on', 'Exact read-only management actor required')
    require(state.get('catalogMatches') is True and state.get('predecessorExact') is True, 'Exact predecessor source or captured purge catalog differs')
    for field in ('catalogHash', 'securityHash', 'dataHash'):
        require(isinstance(state.get(field), str) and re.fullmatch('[0-9a-f]{64}', state[field]) is not None, 'Invalid metadata digest')
    require(state.get('anchors') == expressions(source)['anchorsExpected'], 'Authorization predecessor definition differs')
    ledger = state.get('ledger')
    require(isinstance(ledger, list) and 1 <= len(ledger) <= 512, 'Invalid bounded native ledger')
    versions = []
    for row in ledger:
        require(isinstance(row, dict) and set(row) == {'version','name','dimensions','statementCount','isNull','ndims','lower','upper','sourceArraySha256','sourceRoundtrip','rowSha256','elements'}, 'Invalid native ledger row shape')
        require(isinstance(row['version'], str) and re.fullmatch('[0-9]{14}', row['version']) is not None and isinstance(row['name'], str) and re.fullmatch('[a-zA-Z0-9_]+', row['name']) is not None, 'Invalid native version or name')
        require(row['sourceRoundtrip'] is True and type(row['isNull']) is bool, 'Native source array does not roundtrip')
        for field in ('sourceArraySha256','rowSha256'):
            require(isinstance(row[field], str) and re.fullmatch('[0-9a-f]{64}', row[field]) is not None, 'Invalid native ledger hash')
        count = row['statementCount']
        if row['isNull']:
            require(count is None and row['dimensions'] is None and row['ndims'] is None and row['lower'] is None and row['upper'] is None and row['elements'] == [], 'NULL native array shape differs')
        elif count == 0:
            require(type(count) is int and row['dimensions'] is None and row['ndims'] is None and row['lower'] is None and row['upper'] is None and row['elements'] == [], 'Empty native array shape differs')
        else:
            require(type(count) is int and 1 <= count <= 1024 and type(row['ndims']) is int and row['ndims'] == 1 and type(row['lower']) is int and type(row['upper']) is int and row['upper']-row['lower']+1 == count and row['dimensions'] == '['+str(row['lower'])+':'+str(row['upper'])+']', 'Unsupported native source array bounds')
            require(isinstance(row['elements'], list) and len(row['elements']) == count, 'Missing native source array elements')
            for index, element in enumerate(row['elements'], row['lower']):
                require(isinstance(element, dict) and set(element) == {'subscript','isNull','sha256','bytes'} and type(element['subscript']) is int and element['subscript'] == index and type(element['isNull']) is bool, 'Invalid native source element')
                if element['isNull']:
                    require(element['sha256'] is None and element['bytes'] is None, 'NULL source element differs')
                else:
                    require(isinstance(element['sha256'], str) and re.fullmatch('[0-9a-f]{64}', element['sha256']) is not None and type(element['bytes']) is int and 0 <= element['bytes'] <= 2097152, 'Invalid source element digest or byte count')
        versions.append(row['version'])
    require(versions == sorted(versions) and len(set(versions)) == len(versions), 'Duplicate or unordered native migration version')
    base = [{key: row[key] for key in ('version','name','dimensions','statementCount','sourceArraySha256')} for row in ledger if row['version'] != VERSION]
    require(sha(encoded(base).encode()) == BASE_LEDGER_SHA256, 'Native historical ledger source or alias drift')
    return ledger


def validate_before(state, source):
    ledger = validate_common(state, source)
    require(ledger[-1]['version'] == PREDECESSOR_VERSION and state.get('targetExact') is False, 'Latest unrecorded predecessor differs')
    feature = state.get('feature')
    expected = expressions(source)['expected']
    require(feature == expressions(source)['beforeExpected'], 'Exact performance completion predecessor definitions ACLs or RLS differ')


def validate_target(state, source):
    ledger = validate_common(state, source)
    require(state.get('targetExact') is True and ledger[-1]['version'] == VERSION and ledger[-1]['name'] == NAME, 'Recorded target name or exact source differs; HOLD')
    row = ledger[-1]
    require(row['dimensions'] == '[1:1]' and row['elements'] == [{'subscript': 1, 'isNull': False, 'sha256': sha(source.encode()), 'bytes': len(source.encode())}], 'Recorded raw migration element differs; HOLD')
    require(state.get('feature') == expressions(source)['expected'], 'Exact performance definitions, ACLs or RLS differ; HOLD')


def clean_source(reviewed_head, held):
    compiled = compile(held[HELPER], str(HELPER), 'exec', dont_inherit=True)
    require(LOADED_CODE == compiled, 'Loaded helper differs from reviewed bytes')
    for code in compiled.co_consts:
        if isinstance(code, types.CodeType):
            function = globals().get(code.co_name)
            require(isinstance(function, types.FunctionType) and function.__code__ == code, 'Loaded helper callable differs')
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
    for path, raw in held.items():
        require(git('show', 'HEAD:' + str(path.relative_to(ROOT))) == raw == path.read_bytes(), 'Committed release bytes differ')


def private_path(value):
    path = Path(value)
    require(path.is_absolute() and path.parent.resolve() == path.parent and not path.is_symlink() and ROOT not in path.parents, 'Absolute private operator path outside source required')
    directory = path.parent.stat()
    require(directory.st_uid == os.getuid() and directory.st_mode & 0o777 == 0o700, 'Existing owner-only operator directory required')
    return path


def retain(value, data):
    path = private_path(value)
    raw = (encoded(data) + '\n').encode()
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        with os.fdopen(descriptor, 'wb') as stream:
            stream.write(raw)
            stream.flush()
            os.fsync(stream.fileno())
        directory = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    except BaseException:
        raise SystemExit('Private receipt write uncertain; preserve existing artifact') from None
    return sha(raw)


def read_private(value, pin=None):
    path = private_path(value)
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(descriptor, 'rb') as stream:
        metadata = os.fstat(stream.fileno())
        require(metadata.st_uid == os.getuid() and metadata.st_mode & 0o177777 == 0o100600 and metadata.st_nlink == 1 and 0 < metadata.st_size <= 8388608, 'Regular owner-only bounded private receipt required')
        raw = stream.read(8388609)
    require(len(raw) == metadata.st_size and (pin is None or sha(raw) == pin), 'Private receipt bytes differ')
    return raw


def validate_preserved(after, before, source, catalog=None):
    validate_target(after, source)
    for field in ('major', 'actor', 'session', 'readOnly', 'securityHash', 'dataHash', 'predecessorExact', 'anchors'):
        require(after.get(field) == before.get(field), 'Preserved readback differs: ' + field + '; HOLD')
    require(len(after['ledger']) == len(before['ledger']) + 1 and after['ledger'][:-1] == before['ledger'], 'Historical native ledger readback differs; HOLD')
    if catalog is not None:
        require(after['catalogHash'] == catalog, 'Attested catalog readback differs; HOLD')


def transaction(source, before, predecessor):
    validate_before(before, source)
    expected = literal(encoded(before)) + '::jsonb'
    expression = state_expression(source, predecessor)
    feature = literal(encoded(expressions(source)['expected'])) + '::jsonb'
    return "begin;\nset local search_path=''; set local lock_timeout='3s'; set local statement_timeout='75s';\n" + \
        "do $performance_release_lock$ declare item record; total integer:=0; begin\n" + \
        " if not pg_try_advisory_xact_lock(hashtextextended('mam:directory-role-control',0)) then raise exception 'Performance role control busy' using errcode='55P03'; end if;\n" + \
        " for item in select n.nspname,c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname in('public','private') and c.relkind in('r','p') order by n.nspname,c.relname loop\n" + \
        " total:=total+1; if total>256 then raise exception 'Unbounded protected relation set' using errcode='55000'; end if; execute format('lock table %I.%I in share row exclusive mode nowait',item.nspname,item.relname); end loop;\n" + \
        "end $performance_release_lock$;\n" + \
        'lock table supabase_migrations.schema_migrations in access exclusive mode nowait;\n' + \
        'do $performance_release_before$ declare actual jsonb:=' + expression + '; begin\n' + \
        " if actual->>'readOnly' is distinct from 'off' or (actual||jsonb_build_object('readOnly','on')) is distinct from " + expected + \
        " then raise exception 'Performance release locked predecessor changed' using errcode='55000'; end if; end $performance_release_before$;\n" + \
        transaction_body(source) + '\n' + \
        'create temporary table performance_release_catalog on commit drop as select private.confirmed_test_purge_schema_hash() as hash;\n' + \
        'insert into supabase_migrations.schema_migrations(version,name,statements) values(' + literal(VERSION) + ',' + literal(NAME) + ',ARRAY[' + literal(source) + ']::text[]);\n' + \
        'set constraints all immediate;\nselect pg_temp.performance_release_assert();\n' + \
        'do $performance_release_final$ declare actual jsonb:=' + expression + '; expected jsonb:=' + expected + '; begin\n' + \
        " if actual->'major' is distinct from '17'::jsonb or actual->>'actor' is distinct from 'postgres' or actual->>'session' is distinct from 'postgres' or actual->>'readOnly' is distinct from 'off'\n" + \
        " or (actual-array['readOnly','catalogHash','catalogMatches','targetExact','ledger','feature']) is distinct from (expected-array['readOnly','catalogHash','catalogMatches','targetExact','ledger','feature'])\n" + \
        " or actual->'catalogMatches' is distinct from 'true'::jsonb or actual->'targetExact' is distinct from 'true'::jsonb\n" + \
        " or actual->>'catalogHash' is distinct from (select hash from pg_temp.performance_release_catalog)\n" + \
        " or actual->'feature' is distinct from " + feature + \
        " or jsonb_array_length(actual->'ledger')<>jsonb_array_length(expected->'ledger')+1 or ((actual->'ledger')-jsonb_array_length(expected->'ledger')) is distinct from expected->'ledger'\n" + \
        " or actual->'ledger'->-1->>'version' is distinct from " + literal(VERSION) + \
        " then raise exception 'Performance release final preservation differs' using errcode='55000'; end if; end $performance_release_final$;\n" + \
        "notify pgrst,'reload schema';\nselect hash as \"resultingCatalogSha256\" from pg_temp.performance_release_catalog;\ncommit;"


def main(argv=None):
    args = sys.argv[1:] if argv is None else argv
    require(args and ((args[0] == 'inspect' and len(args) == 6) or (args[0] == 'snapshot' and len(args) == 7) or (args[0] in ('apply', 'readback') and len(args) == 8)), 'Usage: inspect|snapshot|apply|readback <reviewed-head> <helper-sha256> <transport-sha256> <migration-sha256> <predecessor-sha256> [private-snapshot-path [snapshot-sha256]]')
    require(re.fullmatch('[0-9a-f]{40}', args[1]) is not None and all(re.fullmatch('[0-9a-f]{64}', value) is not None for value in args[2:6]), 'Explicit full source pins required')
    held = {}
    for path, pin in zip((HELPER, TRANSPORT, MIGRATION, PREDECESSOR), args[2:6]):
        require(path.is_file() and not path.is_symlink(), 'Regular reviewed source required')
        raw = path.read_bytes()
        require(sha(raw) == pin, 'Reviewed raw source differs: ' + str(path.relative_to(ROOT)))
        held[path] = raw
    for name, pin in SOURCE_CLOSURE_SHA256.items():
        path = ROOT / name
        require(path.is_file() and not path.is_symlink(), 'Regular completion source dependency required')
        raw = path.read_bytes()
        require(sha(raw) == pin, 'Completion source dependency differs: ' + name)
        held[path] = raw
    clean_source(args[1], held)
    local = local_migrations()
    source = held[MIGRATION].decode('utf-8')
    transaction_body(source)
    predecessor = held[PREDECESSOR].decode('utf-8')
    frame = None
    snapshot_raw = None
    if args[0] in ('apply', 'readback'):
        require(re.fullmatch('[0-9a-f]{64}', args[7]) is not None, 'Explicit snapshot hash required')
        snapshot_raw = read_private(args[6], args[7])
        frame = load_json(snapshot_raw)
        require(isinstance(frame, dict) and set(frame) == {'version','project','organization','reviewedHead','sourceHashes','localMigrations','before'}, 'Invalid private snapshot shape')
        require(frame['version'] == VERSION and frame['project'] == 'xtwlrjqbusadghavchqm' and frame['organization'] == 'fwlmbmospuwoaosffvmw' and frame['reviewedHead'] == args[1] and frame['sourceHashes'] == args[2:6] and frame['localMigrations'] == local, 'Private snapshot source binding differs')
        validate_before(frame['before'], source)
    transport = types.ModuleType('performance_release_transport')
    transport.__file__ = str(TRANSPORT)
    exec(compile(held[TRANSPORT], str(TRANSPORT), 'exec', dont_inherit=True), transport.__dict__)
    bindings = dict(transport.__dict__)
    functions = [(value, value.__code__, value.__defaults__) for value in bindings.values() if isinstance(value, types.FunctionType)]
    def check():
        clean_source(args[1], held)
        require(local_migrations() == local, 'Local migration set changed')
        require(set(transport.__dict__) == set(bindings) and all(transport.__dict__[key] is value for key, value in bindings.items()), 'Loaded transport binding differs')
        require(all(function.__code__ == code and function.__defaults__ == defaults for function, code, defaults in functions), 'Loaded transport callable differs')
        if snapshot_raw is not None:
            require(read_private(args[6], args[7]) == snapshot_raw, 'Private snapshot changed')
    phase = 'preflight'
    entered = False
    try:
        check()
        target = transport.api('')
        check()
        require(isinstance(target, dict) and target.get('id') == 'xtwlrjqbusadghavchqm' and target.get('organization_id') == 'fwlmbmospuwoaosffvmw', 'Wrong MAM organization/project')
        state = read_state(source, predecessor, transport.query)
        check()
        require(type(state.get('targetExact')) is bool, 'Missing target source predicate')
        if frame is not None:
            release = transaction(source, frame['before'], predecessor)
            binding = {'version': VERSION, 'snapshotSha256': args[7], 'querySha256': sha(release.encode())}
            directory = private_path(args[6]).parent
            journal = directory / (VERSION + '.entered.json')
            attestation = directory / (VERSION + '.attested.json')
            verified = directory / (VERSION + '.verified.json')
            catalog = None
            if attestation.exists():
                attested = load_json(read_private(str(attestation)))
                require(isinstance(attested, dict) and set(attested) == set(binding) | {'resultingCatalogSha256'} and all(attested.get(key) == value for key, value in binding.items()) and isinstance(attested['resultingCatalogSha256'], str) and re.fullmatch('[0-9a-f]{64}', attested['resultingCatalogSha256']) is not None, 'Private attestation binding differs; HOLD')
                catalog = attested['resultingCatalogSha256']
            if args[0] == 'apply' and (journal.exists() or journal.is_symlink()):
                entry = load_json(read_private(str(journal)))
                require(entry == dict(binding, enteredMutation=True), 'Entered journal binding differs; HOLD')
                require(verified.exists(), 'Entered journal is spent; HOLD; inspect/readback only, never retry or reset')
                require(load_json(read_private(str(verified))) == dict(binding, readbackVerified=True, resultingCatalogSha256=catalog), 'Verified journal binding differs; HOLD')
            if state['targetExact']:
                require(catalog is not None and journal.exists(), 'Recorded completion requires its exact COMMIT attestation; HOLD')
                require(load_json(read_private(str(journal))) == dict(binding, enteredMutation=True), 'Recorded completion intent binding differs; HOLD')
                validate_preserved(state, frame['before'], source, catalog)
                receipt = {'readOnly': True, 'recorded': True, 'readbackVerified': True, 'version': VERSION, 'major': 17}
            else:
                validate_before(state, source)
                require(args[0] == 'apply', 'Target is not recorded; HOLD; inspect only, no retry')
                require(state == frame['before'], 'Current predecessor differs from private snapshot')
                require(not attestation.exists() and not verified.exists(), 'Prior release receipts exist; HOLD')
                check()
                retain(str(journal), dict(binding, enteredMutation=True))
                entered = True
                phase = 'dispatch'
                check()
                result = transport.query(release)
                check()
                require(isinstance(result, list) and len(result) == 1 and isinstance(result[0], dict) and set(result[0]) == {'resultingCatalogSha256'} and isinstance(result[0]['resultingCatalogSha256'], str) and re.fullmatch('[0-9a-f]{64}', result[0]['resultingCatalogSha256']) is not None, 'Missing transaction attestation; HOLD')
                catalog = result[0]['resultingCatalogSha256']
                retain(str(attestation), dict(binding, resultingCatalogSha256=catalog))
                phase = 'readback'
                after = read_state(source, predecessor, transport.query)
                check()
                validate_preserved(after, frame['before'], source, catalog)
                retain(str(verified), dict(binding, readbackVerified=True, resultingCatalogSha256=catalog))
                receipt = {'committed': True, 'readbackVerified': True, 'writeCount': 1, 'version': VERSION, 'major': 17}
        elif state['targetExact']:
            validate_target(state, source)
            receipt = {'readOnly': True, 'recorded': True, 'readbackVerified': False, 'preservationVerified': False, 'version': VERSION, 'major': 17}
        else:
            validate_before(state, source)
            remote_versions = {row['version'] for row in state['ledger']}
            local_versions = {row['version'] for row in local if row['version'] != VERSION}
            receipt = {'readOnly': True, 'targetAbsent': True, 'predecessorVerified': True, 'version': VERSION, 'major': 17, 'historicalLocalOnly': len(local_versions-remote_versions), 'historicalRemoteOnly': len(remote_versions-local_versions), 'historyRepair': False}
        if args[0] == 'snapshot':
            require(not state['targetExact'], 'Cannot replace a before frame with recorded target state')
            frame = {'version': VERSION, 'project': 'xtwlrjqbusadghavchqm', 'organization': 'fwlmbmospuwoaosffvmw', 'reviewedHead': args[1], 'sourceHashes': args[2:6], 'localMigrations': local, 'before': state}
            receipt['snapshotSha256'] = retain(args[6], frame)
        check()
        print(json.dumps(receipt))
    except BaseException:
        source_hold = False
        try:
            check()
        except BaseException:
            source_hold = True
        if entered:
            raise SystemExit('Performance release ' + phase + ' unverified; HOLD; preserve entered journal; inspect/readback only, never retry or reset; sourceHold=' + str(source_hold).lower()) from None
        if source_hold:
            raise SystemExit('Performance release source changed; HOLD; no mutation authorized') from None
        raise


if __name__ == '__main__':
    main()
