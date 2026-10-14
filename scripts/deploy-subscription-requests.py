import argparse
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
TRANSPORT = ROOT / 'scripts/deploy-staff-leave-calendar.py'
CORE = ROOT / 'supabase/migrations/20261008160000_subscription_requests_milestone1.sql'
MAIL = ROOT / 'supabase/migrations/20261014100000_subscription_request_mail.sql'
PREDECESSOR = ROOT / 'supabase/migrations/20261013223556_task_follow_up_notes.sql'
TARGETS = ((CORE, '20261008160000', 'subscription_requests_milestone1'),
           (MAIL, '20261014100000', 'subscription_request_mail'))


def require(condition, message):
    if not condition:
        raise SystemExit(message)


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def literal(value):
    return "'" + value.replace("'", "''") + "'"


def body(source):
    require(source.startswith('begin;\n') and source.endswith('\ncommit;\n'), 'Unsupported transaction boundaries')
    return source[len('begin;\n'):-len('commit;\n')]


def inventory(source):
    start = source.index('  return query\n', source.index('create function pg_temp.sr_inventory()')) + len('  return query\n')
    end = source.index('\nend;\n$catalog$;', start)
    return source[start:end].strip().removesuffix(';')


def catalog_expression(core):
    return "(select encode(extensions.digest(coalesce(jsonb_agg(to_jsonb(c) order by c.kind collate \"C\",c.object_identity collate \"C\"),'[]'::jsonb)::text,'sha256'),'hex') from (" + inventory(core) + ') c(kind,object_identity,definition))'


def data_expression(relations):
    entries = []
    for relation in relations:
        require(re.fullmatch(r'(auth|public|private|storage)\.[a-z_][a-z0-9_]*', relation) is not None, 'Unsupported protected relation')
        entries.append('(' + literal(relation) + ",(select encode(extensions.digest(coalesce(string_agg(to_jsonb(t)::text,E'\\n' order by to_jsonb(t)::text collate \"C\"),''),'sha256'),'hex') from " + relation + ' t))')
    require(entries and len(relations) == len(set(relations)), 'Unique protected relations required')
    return "(select encode(extensions.digest(jsonb_object_agg(d.name,d.hash)::text,'sha256'),'hex') from (values " + ','.join(entries) + ') d(name,hash))'


def ledger_expression():
    return "(select coalesce(jsonb_agg(jsonb_build_object('version',version,'name',name,'dimensions',array_dims(statements),'sourceSha256',encode(extensions.digest(coalesce(statements::text,'<NULL>'),'sha256'),'hex')) order by version),'[]'::jsonb) from supabase_migrations.schema_migrations)"


def exact_record(version, name, source):
    return "coalesce((select name=" + literal(name) + " and array_dims(statements)='[1:1]' and statements=ARRAY[" + literal(source) + ']::text[] from supabase_migrations.schema_migrations where version=' + literal(version) + '),false)'


def state_expression(held, relations):
    core, mail, predecessor = (held[path].decode() for path in (CORE, MAIL, PREDECESSOR))
    return "jsonb_build_object('major',current_setting('server_version_num')::integer/10000,'role',current_user," \
        "'superuser',(select rolsuper from pg_roles where rolname=current_user),'catalog'," + catalog_expression(core) + \
        ",'data'," + data_expression(relations) + ",'ledger'," + ledger_expression() + \
        ",'purgeHash',private.confirmed_test_purge_schema_hash(),'purgeMatches'," \
        "(select count(*)=1 and bool_and(singleton and schema_hash=private.confirmed_test_purge_schema_hash()) from private.confirmed_test_purge_schema)," \
        "'collectorHash',encode(extensions.digest(pg_get_functiondef('private.confirmed_test_purge_schema_hash()'::regprocedure),'sha256'),'hex')," \
        "'predecessorExact'," + exact_record('20261013223556', 'task_follow_up_notes', predecessor) + \
        ",'coreExact'," + exact_record('20261008160000', 'subscription_requests_milestone1', core) + \
        ",'mailExact'," + exact_record('20261014100000', 'subscription_request_mail', mail) + \
        ",'corePresent',to_regclass('private.subscription_request_config') is not null," \
        "'mailPresent',to_regclass('private.subscription_request_mail_deliveries') is not null)"


def read_state(held, relations, query):
    rows = query("begin read only;set local search_path='';set local statement_timeout='60s';select " + state_expression(held, relations) + ' state;rollback;')
    require(isinstance(rows, list) and len(rows) == 1 and isinstance(rows[0].get('state'), dict), 'Invalid read-only state')
    return rows[0]['state']


def validate_before(state):
    require(state['major'] in (16, 17) and state['role'] == 'postgres', 'Unsupported release role/platform')
    require(state['purgeMatches'] and state['collectorHash'] == '3385d5a0140df3995e3196ffea442b4829f9a5357de3ccf5a8d521fbe9011a54', 'Unreviewed predecessor collector')
    versions = [row['version'] for row in state['ledger']]
    require(versions and len(versions) == len(set(versions)) and max(versions) == '20261013223556' and state['predecessorExact'], 'Latest published predecessor differs')
    require(not state['corePresent'] and not state['mailPresent'] and not state['coreExact'] and not state['mailExact'], 'Partial or existing installation; reconcile read-only')
    require(not any(version in versions for version in ('20261008160000', '20261014100000')), 'Target history already exists')


def transaction(held, relations, before):
    expression = state_expression(held, relations)
    expected = literal(json.dumps(before, separators=(',', ':'))) + '::jsonb'
    core, mail = (held[path].decode() for path in (CORE, MAIL))
    additions, records = [], []
    for path, version, name in TARGETS:
        source = held[path].decode()
        additions.append("insert into supabase_migrations.schema_migrations(version,name,statements) values(" + literal(version) + ',' + literal(name) + ',ARRAY[' + literal(source) + ']::text[]);')
        records.append("jsonb_build_object('version'," + literal(version) + ",'name'," + literal(name) + ",'dimensions','[1:1]','sourceSha256',encode(extensions.digest((ARRAY[" + literal(source) + "])::text,'sha256'),'hex'))")
    ledger = "(select jsonb_agg(value order by value->>'version') from jsonb_array_elements((" + expected + "->'ledger')||jsonb_build_array(" + ','.join(records) + ')))'
    return "begin;set local search_path='';set local lock_timeout='2s';set local statement_timeout='60s';lock table supabase_migrations.schema_migrations in share row exclusive mode nowait;" \
        "do $release_before$ begin if (" + expression + ') is distinct from ' + expected + " then raise exception 'Requests release predecessor drift' using errcode='55000';end if;end $release_before$;\n" + \
        body(core) + '\n' + body(mail) + "\nselect set_config('mam.requests.release.catalog'," + catalog_expression(core) + ",true);\n" + '\n'.join(additions) + \
        "\nset constraints all immediate;do $release_final$ declare actual jsonb:=" + expression + '; expected jsonb:=' + expected + ";begin\n" \
        "if actual->>'catalog' is distinct from current_setting('mam.requests.release.catalog') or actual->>'data' is distinct from expected->>'data'" \
        " or actual->'ledger' is distinct from " + ledger + " or not (actual->>'purgeMatches')::boolean" \
        " or not (actual->>'predecessorExact')::boolean or not (actual->>'coreExact')::boolean or not (actual->>'mailExact')::boolean" \
        " or actual->'major' is distinct from expected->'major' or actual->'role' is distinct from expected->'role'" \
        " or actual->'superuser' is distinct from expected->'superuser' or actual->'collectorHash' is distinct from expected->'collectorHash'" \
        " or (select count(*)<>1 or not bool_and(singleton and not enabled and approver_user_id is null and approver_person_id is null) from private.subscription_request_config)" \
        " or exists(select 1 from private.subscription_requests) or exists(select 1 from private.subscription_request_events)" \
        " or exists(select 1 from private.subscription_request_notifications) or exists(select 1 from private.subscription_request_mail_deliveries)" \
        " then raise exception 'Requests release final state differs' using errcode='55000';end if;end $release_final$;\nselect " + expression + ' receipt;commit;'


def clean_source(head, held):
    compiled = compile(held[HELPER], str(HELPER), 'exec', dont_inherit=True)
    require(LOADED_CODE == compiled, 'Loaded helper differs')
    for code in compiled.co_consts:
        if isinstance(code, types.CodeType):
            function = globals().get(code.co_name)
            require(isinstance(function, types.FunctionType) and function.__code__ == code, 'Loaded helper callable differs')
    require(Path.cwd().resolve() == ROOT, 'Run from exact MAM source root')
    environment = {key: value for key, value in os.environ.items() if not key.startswith('GIT_')}
    environment.update(GIT_CONFIG_NOSYSTEM='1', GIT_CONFIG_GLOBAL='/dev/null', GIT_CONFIG_SYSTEM='/dev/null', GIT_NO_REPLACE_OBJECTS='1', GIT_OPTIONAL_LOCKS='0')
    def git(*args):
        return subprocess.check_output(['git', '-c', 'core.fsmonitor=false', *args], cwd=ROOT, env=environment, stderr=subprocess.PIPE)
    require(git('rev-parse', 'HEAD').decode().strip() == head and not git('status', '--porcelain').strip(), 'Clean reviewed HEAD required')
    require(git('remote', 'get-url', 'origin').decode().strip() == 'https://github.com/mobilityaccessmodifications/mam-team-management-system.git', 'Wrong MAM repository')
    require(git('show', '-s', '--format=%an <%ae>', 'HEAD').decode().strip() == 'mobilityaccessmodifications <310802599+mobilityaccessmodifications@users.noreply.github.com>', 'Wrong MAM source author')
    for path, raw in held.items():
        require(not path.is_symlink() and git('show', 'HEAD:' + str(path.relative_to(ROOT))) == raw == path.read_bytes(), 'Committed source custody differs')


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument('mode', choices=('prepare', 'inspect', 'apply'))
    parser.add_argument('--head', required=True)
    for name in ('helper', 'transport', 'core', 'mail', 'predecessor'):
        parser.add_argument('--' + name + '-sha', required=True)
    parser.add_argument('--snapshot', required=True)
    parser.add_argument('--snapshot-sha')
    args = parser.parse_args(argv)
    require(re.fullmatch('[0-9a-f]{40}', args.head) is not None, 'Full reviewed HEAD required')
    paths = (HELPER, TRANSPORT, CORE, MAIL, PREDECESSOR)
    held = {}
    for path, pin in zip(paths, (args.helper_sha, args.transport_sha, args.core_sha, args.mail_sha, args.predecessor_sha)):
        require(re.fullmatch('[0-9a-f]{64}', pin) is not None and path.is_file() and not path.is_symlink(), 'Explicit regular source pin required')
        raw = path.read_bytes()
        require(sha(raw) == pin, 'Source pin differs')
        held[path] = raw
    clean_source(args.head, held)
    snapshot = Path(args.snapshot)
    require(snapshot.is_absolute() and not snapshot.is_symlink() and not snapshot.resolve().is_relative_to(ROOT), 'Private external snapshot required')
    require(snapshot.parent.stat().st_uid == os.getuid() and snapshot.parent.stat().st_mode & 0o077 == 0, 'Task-private snapshot directory required')
    transport = types.ModuleType('requests_transport')
    transport.__file__ = str(TRANSPORT)
    exec(compile(held[TRANSPORT], str(TRANSPORT), 'exec', dont_inherit=True), transport.__dict__)
    bindings = dict(transport.__dict__)
    functions = [(value, value.__code__, value.__defaults__) for value in bindings.values() if isinstance(value, types.FunctionType)]
    def check():
        clean_source(args.head, held)
        require(set(transport.__dict__) == set(bindings) and all(transport.__dict__[key] is value for key, value in bindings.items()), 'Loaded transport binding differs')
        require(all(function.__code__ == code and function.__defaults__ == defaults for function, code, defaults in functions), 'Loaded transport callable differs')
    phase = 'preflight'
    try:
        target = transport.api('')
        check()
        require(isinstance(target, dict) and target.get('id') == 'xtwlrjqbusadghavchqm' and target.get('organization_id') == 'fwlmbmospuwoaosffvmw', 'Wrong MAM target')
        if args.mode == 'prepare':
            rows = transport.query("begin read only;select 'auth.users' name union all select format('%I.%I',n.nspname,c.relname) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname in ('public','private','storage') and c.relkind in ('r','p') and c.oid<>'private.confirmed_test_purge_schema'::regclass;rollback;")
            check()
            relations = sorted(row['name'] for row in rows)
            before = read_state(held, relations, transport.query)
            check()
            validate_before(before)
            raw = json.dumps({'head': args.head, 'pins': {str(path.relative_to(ROOT)): sha(value) for path, value in held.items()}, 'relations': relations, 'before': before}, sort_keys=True).encode()
            descriptor = os.open(snapshot, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(descriptor, 'wb') as stream:
                stream.write(raw)
            print(json.dumps({'readOnly': True, 'targetVerified': True, 'snapshotSha256': sha(raw)}))
            return
        require(re.fullmatch('[0-9a-f]{64}', args.snapshot_sha or '') is not None and snapshot.stat().st_uid == os.getuid() and snapshot.stat().st_mode & 0o077 == 0, 'Explicit private snapshot pin required')
        raw = snapshot.read_bytes()
        require(sha(raw) == args.snapshot_sha, 'Snapshot pin differs')
        saved = json.loads(raw)
        require(saved['head'] == args.head and saved['pins'] == {str(path.relative_to(ROOT)): sha(value) for path, value in held.items()}, 'Snapshot source binding differs')
        before, relations = saved['before'], saved['relations']
        validate_before(before)
        current = read_state(held, relations, transport.query)
        check()
        if args.mode == 'inspect':
            print(json.dumps({'readOnly': True, 'targetVerified': True, 'predecessorMatches': current == before, 'targetsExact': current['coreExact'] and current['mailExact']}))
            return
        require(current == before, 'Live predecessor drift; prepare and review a fresh snapshot')
        release = transaction(held, relations, before)
        check()
        phase = 'dispatch'
        rows = transport.query(release)
        check()
        require(isinstance(rows, list) and len(rows) == 1 and isinstance(rows[0].get('receipt'), dict), 'Missing COMMIT receipt')
        receipt = rows[0]['receipt']
        phase = 'readback'
        after = read_state(held, relations, transport.query)
        check()
        require(after == receipt and after['coreExact'] and after['mailExact'] and after['purgeMatches'] and after['data'] == before['data'], 'Independent COMMIT readback differs')
        print(json.dumps({'committed': True, 'readbackVerified': True, 'transactionSha256': sha(release.encode()), 'catalogSha256': after['catalog']}))
    except BaseException:
        if phase in ('dispatch', 'readback'):
            raise SystemExit('Requests release outcome unverified during ' + phase + '; use read-only inspect; never blindly retry.') from None
        raise


if __name__ == '__main__':
    main()
