import hashlib
import importlib.util
import json
from pathlib import Path
import re
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
VERSION = '20261013170000'
NAME = 'subscription_review_tasks'
PREDECESSOR_VERSION = '20261013120000'
PREDECESSOR_NAME = 'annual_continuous_accrual'
MIGRATION = ROOT / 'supabase/migrations' / (VERSION + '_' + NAME + '.sql')
PREDECESSOR = MIGRATION.parent / (PREDECESSOR_VERSION + '_' + PREDECESSOR_NAME + '.sql')
TRANSPORT = ROOT / 'scripts/deploy-staff-leave-calendar.py'
SPEC = importlib.util.spec_from_file_location('subscription_review_transport', TRANSPORT)
assert SPEC is not None and SPEC.loader is not None
SHARED = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(SHARED)
require, literal, api, query = SHARED.require, SHARED.literal, SHARED.api, SHARED.query
SIGNATURES = {
    'private.record_subscription_review(uuid,bigint)',
    'public.mark_subscription_reviewed_v2(uuid,bigint)',
    'public.list_my_subscription_review_tasks()',
    'public.list_subscription_review_tasks_for_preview(uuid)',
    'public.complete_my_subscription_review_task(uuid,bigint)',
}


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def transaction_body(source):
    require(source.startswith('begin;\n') and source.endswith('\ncommit;\n'), 'Unsupported migration transaction boundaries')
    return source[len('begin;\n'):-len('commit;\n')]


def function_spec(source):
    section = source.split('insert into subscription_review_function_spec values\n', 1)[1].split('\ndo $subscription_review_before$', 1)[0]
    rows = re.findall(r"\('([^']+)',(true|false),(null|'[0-9a-f]{64}'),'([0-9a-f]{64})',(null|'(?:[^']|'')+'::jsonb)\)[,;]", section)
    require(len(rows) == 5 and {r[0] for r in rows} == SIGNATURES, 'Exact reviewed function specification required')
    return {signature: {'before': None if before == 'null' else before[1:-1], 'after': after,
                        'portable': None if metadata == 'null' else json.loads(metadata[1:-8].replace("''", "'"))}
            for signature, existing, before, after, metadata in rows}


def candidate(reviewed_sha):
    require(re.fullmatch('[0-9a-f]{64}', reviewed_sha or '') is not None, 'Explicit reviewed SHA256 required')
    raw = MIGRATION.read_bytes()
    require(sha(raw) == reviewed_sha, 'Reviewed migration bytes differ')
    source = raw.decode('utf-8')
    transaction_body(source)
    function_spec(source)
    return source


def source_expression(source, name):
    start = "create function pg_temp.subscription_review_" + name + "() returns jsonb language sql stable set search_path='' as $$\n"
    require(source.count(start) == 1, 'Unsupported core expression: ' + name)
    expression = source.split(start, 1)[1].split('\n$$;', 1)[0]
    require(expression.startswith('select ') and expression.endswith(';'), 'Unsupported core expression')
    return expression[:-1]


def state_expression(source):
    signatures = ','.join(literal(s) for s in sorted(SIGNATURES))
    security = source_expression(source, 'security').replace('subscription_review_function_spec s', '(select unnest(array[' + signatures + ']::text[]) signature) s')
    data = source_expression(source, 'data')
    return f"""jsonb_build_object(
 'major',current_setting('server_version_num')::integer/10000,
 'securityHash',encode(extensions.digest(({security})::text,'sha256'),'hex'),
 'dataHash',encode(extensions.digest(({data})::text,'sha256'),'hex'),
 'catalogHash',private.confirmed_test_purge_schema_hash(),
 'catalogMatches',(select count(*)=1 and bool_and(singleton and schema_hash=private.confirmed_test_purge_schema_hash()) from private.confirmed_test_purge_schema),
 'predecessorExact',coalesce((select name={literal(PREDECESSOR_NAME)} and array_dims(statements)='[1:1]' and statements=ARRAY[{literal(PREDECESSOR.read_bytes().decode('utf-8'))}]::text[] from supabase_migrations.schema_migrations where version={literal(PREDECESSOR_VERSION)}),false),
 'targetExact',coalesce((select name={literal(NAME)} and array_dims(statements)='[1:1]' and statements=ARRAY[{literal(source)}]::text[] from supabase_migrations.schema_migrations where version={literal(VERSION)}),false),
 'ledger',(select coalesce(jsonb_agg(jsonb_build_object('version',m.version,'name',m.name,'dimensions',array_dims(m.statements),'sourceSha256',encode(extensions.digest(coalesce(m.statements::text,'<NULL>'),'sha256'),'hex')) order by m.version),'[]') from supabase_migrations.schema_migrations m),
 'functions',(select jsonb_object_agg(signature,case when p.oid is null then 'null'::jsonb else jsonb_build_object(
 'sha256',encode(extensions.digest(pg_get_functiondef(p.oid),'sha256'),'hex'),
 'metadata',(to_jsonb(p)-array['prosrc','prosqlbody','proargdefaults'])||jsonb_build_object('parameter_defaults',pg_get_expr(p.proargdefaults,0)),
 'portable',jsonb_build_object('owner',pg_get_userbyid(p.proowner),'acl',p.proacl::text,'security_definer',p.prosecdef,'config',p.proconfig)) end)
 from unnest(array[{signatures}]::text[]) signature left join pg_proc p on p.oid=to_regprocedure(signature)))"""


def read_state(source):
    result = query("begin read only; set local search_path=''; set local lock_timeout='3s'; set local statement_timeout='30s';\nselect " + state_expression(source) + ' as state; rollback;')
    require(isinstance(result, list) and len(result) == 1 and isinstance(result[0].get('state'), dict), 'Invalid read-only metadata response')
    return result[0]['state']


def validate_before(state, source):
    require(state.get('major') in (16, 17) and state.get('catalogMatches') is True and state.get('predecessorExact') is True, 'Exact supported predecessor required')
    ledger = state.get('ledger', [])
    versions = [row['version'] for row in ledger]
    require(versions and len(versions) <= 512 and len(versions) == len(set(versions)) and versions == sorted(versions), 'Unsupported bounded migration ledger')
    require(max(versions) == PREDECESSOR_VERSION and state.get('targetExact') is False, 'Latest predecessor or absent target differs')
    for signature, spec in function_spec(source).items():
        value = state.get('functions', {}).get(signature)
        require(value is None if spec['before'] is None else isinstance(value, dict) and value.get('sha256') == spec['before'], 'Predecessor function differs: ' + signature)


def validate_target(state, source):
    require(state.get('catalogMatches') is True and state.get('targetExact') is True and state.get('predecessorExact') is True, 'Exact target ledger or catalog readback differs; do not retry')
    for signature, spec in function_spec(source).items():
        value = state.get('functions', {}).get(signature)
        require(isinstance(value, dict) and value.get('sha256') == spec['after'], 'Resulting function differs: ' + signature)
        if spec['portable'] is not None:
            require(value.get('portable') == spec['portable'], 'Resulting function ACL/security differs: ' + signature)


def transaction(source, before):
    expected = literal(json.dumps(before, separators=(',', ':'), allow_nan=False)) + '::jsonb'
    expression = state_expression(source)
    insert = 'insert into supabase_migrations.schema_migrations(version,name,statements) values(' + literal(VERSION) + ',' + literal(NAME) + ',ARRAY[' + literal(source) + ']::text[]);'
    row = "jsonb_build_object('version'," + literal(VERSION) + ",'name'," + literal(NAME) + ",'dimensions','[1:1]','sourceSha256',encode(extensions.digest((ARRAY[" + literal(source) + "])::text,'sha256'),'hex'))"
    return "begin;\nset local search_path=''; set local lock_timeout='3s'; set local statement_timeout='75s';\n" + \
        'lock table supabase_migrations.schema_migrations in access exclusive mode nowait;\n' + \
        'do $subscription_review_release_before$ begin if (' + expression + ') is distinct from ' + expected + \
        " then raise exception 'Subscription review release predecessor changed' using errcode='55000'; end if; end $subscription_review_release_before$;\n" + \
        transaction_body(source) + '\n' + insert + f"""
set constraints all immediate;
select pg_temp.subscription_review_assert_delta();
do $subscription_review_release_final$ declare actual jsonb; expected jsonb:={expected}; begin
 actual:={expression};
 if actual->>'securityHash' is distinct from expected->>'securityHash'
 or actual->>'dataHash' is distinct from expected->>'dataHash'
 or actual->'catalogMatches' is distinct from 'true'::jsonb
 or actual->'predecessorExact' is distinct from 'true'::jsonb
 or actual->'targetExact' is distinct from 'true'::jsonb
 or actual->'ledger' is distinct from (expected->'ledger')||jsonb_build_array({row}) then
 raise exception 'Subscription review release final state differs' using errcode='55000'; end if;
end $subscription_review_release_final$;
notify pgrst,'reload schema';
select private.confirmed_test_purge_schema_hash() as "resultingCatalogSha256";
commit;"""


def clean_source():
    require(Path.cwd().resolve() == ROOT, 'Run from the exact MAM repository root')
    def git(*args):
        return subprocess.check_output(['git', *args], cwd=ROOT)
    require(not git('status', '--porcelain').strip(), 'Release tree must be clean')
    require(git('remote', 'get-url', 'origin').decode().strip() == 'https://github.com/mobilityaccessmodifications/mam-team-management-system.git', 'Wrong MAM repository')
    require(git('show', '-s', '--format=%an <%ae>', 'HEAD').decode().strip() == 'mobilityaccessmodifications <310802599+mobilityaccessmodifications@users.noreply.github.com>', 'Wrong MAM source author')
    for path in (MIGRATION, PREDECESSOR, Path(__file__).resolve(), TRANSPORT):
        require(git('show', 'HEAD:' + str(path.relative_to(ROOT))) == path.read_bytes(), 'Committed release bytes differ')


def main(argv=None):
    args = sys.argv[1:] if argv is None else argv
    require(args == ['inspect'] or (len(args) == 2 and args[0] == 'apply'), 'Usage: inspect | apply <reviewed-sha256>')
    source = candidate(args[1] if args[0] == 'apply' else sha(MIGRATION.read_bytes()))
    if args[0] == 'apply':
        clean_source()
    target = api('')
    require(isinstance(target, dict) and target.get('id') == SHARED.PROJECT and target.get('organization_id') == SHARED.ORGANISATION, 'Wrong MAM organization/project')
    before = read_state(source)
    recorded = any(row['version'] == VERSION for row in before.get('ledger', []))
    if recorded:
        validate_target(before, source)
        print(json.dumps({'readOnly': True, 'recorded': True, 'readbackVerified': True, 'version': VERSION}))
        return
    validate_before(before, source)
    if args[0] == 'inspect':
        print(json.dumps({'readOnly': True, 'targetVerified': True, 'predecessorVerified': True, 'targetAbsent': True, 'version': VERSION, 'migrationSha256': sha(source.encode())}))
        return
    try:
        result = query(transaction(source, before))
        require(isinstance(result, list) and len(result) == 1 and set(result[0]) == {'resultingCatalogSha256'} and re.fullmatch('[0-9a-f]{64}', result[0]['resultingCatalogSha256'] or '') is not None, 'Missing COMMIT attestation')
    except (Exception, SystemExit):
        raise SystemExit('Migration outcome unverified. Reconcile with inspect; never blindly retry.') from None
    after = read_state(source)
    validate_target(after, source)
    require(after['catalogHash'] == result[0]['resultingCatalogSha256'], 'Attested catalog readback differs; do not retry')
    for field in ('major', 'securityHash', 'dataHash', 'predecessorExact'):
        require(after[field] == before[field], 'Preserved readback differs: ' + field)
    require(len(after['ledger']) == len(before['ledger']) + 1 and after['ledger'][:-1] == before['ledger'], 'Historical ledger readback differs')
    admin = 'public.mark_subscription_reviewed_v2(uuid,bigint)'
    require(after['functions'][admin]['metadata'] == before['functions'][admin]['metadata'], 'Existing review authority differs')
    print(json.dumps({'committed': True, 'readbackVerified': True, 'writeCount': 1, 'version': VERSION}))


if __name__ == '__main__':
    main()
