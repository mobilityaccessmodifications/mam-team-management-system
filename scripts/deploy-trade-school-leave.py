import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import subprocess

ROOT = Path(__file__).resolve().parents[1]
PROJECT = 'xtwlrjqbusadghavchqm'
ORGANISATION = 'fwlmbmospuwoaosffvmw'
VERSION = '20261012110000'
NAME = 'trade_school_leave'
PREDECESSOR_VERSION = '20261008150000'
PREDECESSOR_NAME = 'annual_source_bank_reconciliation'
MIGRATION = ROOT / 'supabase/migrations' / (VERSION + '_' + NAME + '.sql')
PREDECESSOR = MIGRATION.parent / (PREDECESSOR_VERSION + '_' + PREDECESSOR_NAME + '.sql')
SPEC = importlib.util.spec_from_file_location('trade_school_transport', ROOT / 'scripts/deploy-staff-leave-calendar.py')
assert SPEC is not None and SPEC.loader is not None
SHARED = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(SHARED)
require, literal, api, query = SHARED.require, SHARED.literal, SHARED.api, SHARED.query
SIGNATURES = {
    'public.list_trade_school_leave_entitlements(uuid)',
    'public.submit_my_leave_request(text,date,date,time,time,text)',
    'private.enforce_leave_request_employment_policy()',
    'public.submit_selected_employee_leave_request(uuid,text,date,date,time,time,text)',
    'private.enforce_trade_school_leave()',
}
CONSTRAINTS = {
    'leave_requests_pay_treatment_check', 'leave_requests_request_type_label_check',
    'leave_requests_trade_school_classification_check',
}
TRIGGER = 'CREATE TRIGGER zz_leave_requests_trade_school_policy BEFORE INSERT OR UPDATE ON public.leave_requests FOR EACH ROW EXECUTE FUNCTION private.enforce_trade_school_leave()'


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def transaction_body(source):
    require(source.startswith('begin;\n') and source.endswith(('\ncommit;', '\ncommit;\n')), 'Unsupported outer transaction boundaries')
    end = len(source) - (len('commit;\n') if source.endswith('commit;\n') else len('commit;'))
    return source[len('begin;\n'):end]


def candidate(source_sha):
    require(re.fullmatch('[0-9a-f]{64}', source_sha or '') is not None, 'Explicit reviewed source SHA required')
    raw = MIGRATION.read_bytes()
    require(sha(raw) == source_sha, 'Reviewed source bytes differ')
    source = raw.decode('utf-8')
    transaction_body(source)
    function_spec(source)
    return source


def function_spec(source):
    start = 'insert into trade_school_function_spec values\n'
    require(source.count(start) == 1, 'Unsupported function specification')
    section = source.split(start, 1)[1].split('\ncreate temporary table trade_school_constraint_spec', 1)[0]
    rows = re.findall(r"\('([^']+)',(true|false),(null|'[0-9a-f]{64}'),'([0-9a-f]{64})',(null|'(?:[^']|'')+'::jsonb)\)[,;]", section)
    require(len(rows) == 5 and {row[0] for row in rows} == SIGNATURES, 'Exact five function specifications required')
    result = {}
    for signature, existing, before, after, metadata in rows:
        require((existing == 'true') == (before != 'null') and (existing == 'true') == (metadata == 'null'), 'Invalid function specification')
        result[signature] = {
            'before': None if before == 'null' else before[1:-1], 'after': after,
            'portable': None if metadata == 'null' else json.loads(metadata[1:-8].replace("''", "'")),
        }
    return result


def source_function(source, name):
    start = "create function pg_temp." + name + "() returns jsonb language sql stable set search_path='' as $$\n"
    require(source.count(start) == 1, 'Unsupported exact core guard: ' + name)
    body = source.split(start, 1)[1].split('\n$$;', 1)[0]
    require(body.startswith('select ') and body.endswith(';'), 'Unsupported core expression: ' + name)
    return body[:-1]


def constraint_spec(source):
    start = 'insert into trade_school_constraint_spec values\n'
    require(source.count(start) == 1, 'Unsupported constraint specification')
    section = source.split(start, 1)[1].split('\ndo $trade_school_functions_before$', 1)[0]
    rows = re.findall(r"\('([^']+)',(null|'(?:[^']|'')+'),'((?:[^']|'')+)'\)[,;]", section)
    require(len(rows) == 3 and {row[0] for row in rows} == CONSTRAINTS, 'Exact three constraint specifications required')
    return {name: {'definition': after.replace("''", "'"), 'validated': True, 'deferrable': False, 'deferred': False, 'noinherit': False, 'kind': 'c'} for name, before, after in rows}


def state_expression(source):
    signatures = ','.join(literal(s) for s in sorted(SIGNATURES))
    security = source_function(source, 'trade_school_security')
    reference = 'select name from trade_school_constraint_spec'
    require(security.count(reference) == 1, 'Unsupported core security constraint scope')
    security = security.replace(reference, ','.join(literal(s) for s in sorted(CONSTRAINTS)))
    data = source_function(source, 'trade_school_data')
    predecessor = PREDECESSOR.read_bytes().decode('utf-8')
    constraints = ','.join(literal(s) for s in sorted(CONSTRAINTS))
    return f"""jsonb_build_object(
 'major',current_setting('server_version_num')::integer/10000,
 'dataHash',encode(extensions.digest(({data})::text,'sha256'),'hex'),
 'securityHash',encode(extensions.digest(({security})::text,'sha256'),'hex'),
 'receiptHash',(select encode(extensions.digest(coalesce(jsonb_agg(to_jsonb(r) order by id),'[]')::text,'sha256'),'hex') from private.confirmed_test_identity_purges r),
 'purgeHash',private.confirmed_test_purge_schema_hash(),
 'purgeMatches',(select count(*)=1 and bool_and(singleton and schema_hash=private.confirmed_test_purge_schema_hash()) from private.confirmed_test_purge_schema),
 'predecessorExact',coalesce((select name={literal(PREDECESSOR_NAME)} and array_dims(statements)='[1:1]' and statements=ARRAY[{literal(predecessor)}]::text[] from supabase_migrations.schema_migrations where version={literal(PREDECESSOR_VERSION)}),false),
 'targetExact',coalesce((select name={literal(NAME)} and array_dims(statements)='[1:1]' and statements=ARRAY[{literal(source)}]::text[] from supabase_migrations.schema_migrations where version={literal(VERSION)}),false),
 'ledger',(select coalesce(jsonb_agg(jsonb_build_object('version',m.version,'name',m.name,'dimensions',array_dims(m.statements),'cardinality',cardinality(m.statements),'sourceSha256',encode(extensions.digest(coalesce(m.statements::text,'<NULL>'),'sha256'),'hex')) order by m.version),'[]') from supabase_migrations.schema_migrations m),
 'functions',(select jsonb_object_agg(signature,case when p.oid is null then 'null'::jsonb else jsonb_build_object(
 'sha256',encode(extensions.digest(pg_get_functiondef(p.oid),'sha256'),'hex'),
 'metadata',(to_jsonb(p)-array['prosrc','prosqlbody','proargdefaults'])||jsonb_build_object('parameter_defaults',pg_get_expr(p.proargdefaults,0)),
 'portable',jsonb_build_object('owner',pg_get_userbyid(p.proowner),'acl',p.proacl::text,'security_definer',p.prosecdef,'config',p.proconfig)) end)
 from unnest(array[{signatures}]::text[]) signature left join pg_proc p on p.oid=to_regprocedure(signature)),
 'columnValid',exists(select 1 from pg_attribute a join pg_attrdef d on d.adrelid=a.attrelid and d.adnum=a.attnum where a.attrelid='private.employee_directory_details'::regclass and a.attname='trade_school_enabled' and a.atttypid='boolean'::regtype and a.atttypmod=-1 and a.attnotnull and a.atthasdef and a.atthasmissing and a.attmissingval::text='{{f}}' and a.attacl is null and a.attidentity='' and a.attgenerated='' and a.attcollation=0 and not a.attisdropped and pg_get_expr(d.adbin,d.adrelid)='false'),
 'enabledCount',(select count(*) from private.employee_directory_details d where coalesce((to_jsonb(d)->>'trade_school_enabled')::boolean,false)),
 'trigger',(select jsonb_build_object('definition',pg_get_triggerdef(oid),'enabled',tgenabled) from pg_trigger where tgrelid='public.leave_requests'::regclass and tgname='zz_leave_requests_trade_school_policy' and not tgisinternal),
 'constraints',(select coalesce(jsonb_object_agg(conname,jsonb_build_object('definition',pg_get_constraintdef(oid),'validated',convalidated,'deferrable',condeferrable,'deferred',condeferred,'noinherit',connoinherit,'kind',contype)),'{{}}') from pg_constraint where conrelid='public.leave_requests'::regclass and conname in ({constraints})))"""


def ledger_bound():
    return """do $trade_school_ledger_bound$ begin
 if (select count(*) from supabase_migrations.schema_migrations)>512
 or (select coalesce(sum(octet_length(statements::text)),0) from supabase_migrations.schema_migrations)>16777216 then
 raise exception 'Unsupported bounded migration ledger' using errcode='55000'; end if;
end $trade_school_ledger_bound$;"""


def read_state(source):
    result = query("begin read only; set local search_path=''; set local lock_timeout='3s'; set local statement_timeout='30s';\n" + ledger_bound() + '\nselect ' + state_expression(source) + ' as state; rollback;')
    require(isinstance(result, list) and len(result) == 1 and isinstance(result[0].get('state'), dict), 'Invalid bounded read-only state response')
    return result[0]['state']


def validate_before(before, source):
    require(before.get('major') in (16, 17) and before.get('purgeMatches') is True and before.get('predecessorExact') is True, 'Exact supported predecessor required')
    ledger = before.get('ledger', [])
    versions = [row['version'] for row in ledger]
    require(versions and len(versions) <= 512 and len(versions) == len(set(versions)) and versions == sorted(versions) and all(re.fullmatch('[0-9]{14}', v) for v in versions), 'Unsupported exact raw ledger')
    require(max(versions) == PREDECESSOR_VERSION and before.get('targetExact') is False, 'Latest predecessor or absent target differs')
    for signature, spec in function_spec(source).items():
        value = before.get('functions', {}).get(signature)
        require(value is None if spec['before'] is None else isinstance(value, dict) and value.get('sha256') == spec['before'], 'Exact predecessor function differs: ' + signature)
    require(before.get('columnValid') is False and before.get('enabledCount') == 0 and before.get('trigger') is None, 'Unexpected feature predecessor state')


def expected_ledger_row(source):
    return "jsonb_build_object('version'," + literal(VERSION) + ",'name'," + literal(NAME) + ",'dimensions','[1:1]','cardinality',1,'sourceSha256',encode(extensions.digest((ARRAY[" + literal(source) + "])::text,'sha256'),'hex'))"


def transaction(source, before):
    validate_before(before, source)
    expression = state_expression(source)
    expected = literal(json.dumps(before, separators=(',', ':'), allow_nan=False)) + '::jsonb'
    checks = []
    for signature, spec in function_spec(source).items():
        value = "actual->'functions'->" + literal(signature)
        checks.append('(' + value + ")->>'sha256' is distinct from " + literal(spec['after']))
        if spec['before'] is not None:
            checks.append('((' + value + ")-'sha256') is distinct from ((expected->'functions'->" + literal(signature) + ")-'sha256')")
        else:
            checks.append('(' + value + ")->'portable' is distinct from " + literal(json.dumps(spec['portable'])) + '::jsonb')
    constraints = literal(json.dumps(constraint_spec(source))) + '::jsonb'
    final = f"""set constraints all immediate;
select pg_temp.trade_school_assert_delta();
do $trade_school_release_final$ declare actual jsonb; expected jsonb:={expected}; begin
 actual:={expression};
 if actual->>'dataHash' is distinct from expected->>'dataHash'
 or actual->>'securityHash' is distinct from expected->>'securityHash'
 or actual->>'receiptHash' is distinct from expected->>'receiptHash'
 or pg_temp.trade_school_security() is distinct from (select value from pg_temp.trade_school_security_before)
 or actual->>'purgeHash' is distinct from (select value from pg_temp.trade_school_catalog_after)
 or actual->'purgeMatches' is distinct from 'true'::jsonb
 or actual->'predecessorExact' is distinct from 'true'::jsonb
 or actual->'targetExact' is distinct from 'true'::jsonb
 or actual->'ledger' is distinct from (expected->'ledger')||jsonb_build_array({expected_ledger_row(source)})
 or actual->'columnValid' is distinct from 'true'::jsonb or actual->'enabledCount' is distinct from '0'::jsonb
 or actual->'constraints' is distinct from {constraints}
 or actual->'trigger' is distinct from jsonb_build_object('definition',{literal(TRIGGER)},'enabled','O')
 or {' or '.join(checks)} then
 raise exception 'Trade-school release final state differs' using errcode='55000'; end if;
end $trade_school_release_final$;
notify pgrst,'reload schema';
select value as "tradeSchoolResultingCatalogSha256" from pg_temp.trade_school_catalog_after;"""
    insert = 'insert into supabase_migrations.schema_migrations(version,name,statements) values(' + ','.join([literal(VERSION), literal(NAME), 'ARRAY[' + literal(source) + ']::text[]']) + ');'
    return "begin;\nset local search_path=''; set local lock_timeout='3s'; set local statement_timeout='75s';\n" + \
        'lock table supabase_migrations.schema_migrations,private.confirmed_test_identity_purges,private.confirmed_test_purge_schema in access exclusive mode nowait;\n' + \
        ledger_bound() + '\n' + 'do $trade_school_release_before$ begin if (' + expression + ') is distinct from ' + expected + \
        " then raise exception 'Trade-school release predecessor changed' using errcode='55000'; end if; end $trade_school_release_before$;\n" + \
        transaction_body(source) + '\n' + insert + '\n' + final + '\ncommit;'


def resulting_catalog(result):
    require(isinstance(result, list) and len(result) == 1 and isinstance(result[0], dict) and set(result[0]) == {'tradeSchoolResultingCatalogSha256'}, 'Missing exact COMMIT attestation; reconcile read-only and do not retry')
    value = result[0]['tradeSchoolResultingCatalogSha256']
    require(isinstance(value, str) and re.fullmatch('[0-9a-f]{64}', value) is not None, 'Invalid exact COMMIT attestation; do not retry')
    return value


def verify_after(actual, before, source, expected_catalog):
    validate_before(before, source)
    require(isinstance(expected_catalog, str) and re.fullmatch('[0-9a-f]{64}', expected_catalog) is not None and actual.get('purgeHash') == expected_catalog, 'Attested catalog readback differs; do not retry')
    for field in ('major', 'dataHash', 'securityHash', 'receiptHash', 'predecessorExact', 'enabledCount'):
        require(actual.get(field) == before[field], 'Protected readback differs: ' + field)
    require(actual.get('purgeMatches') is True and actual.get('targetExact') is True and actual.get('columnValid') is True, 'Exact target readback differs')
    ledger = actual.get('ledger', [])
    require(len(ledger) == len(before['ledger']) + 1 and ledger[:-1] == before['ledger'], 'Historical raw ledger readback differs')
    row = ledger[-1]
    require(row.get('version') == VERSION and row.get('name') == NAME and row.get('dimensions') == '[1:1]' and row.get('cardinality') == 1 and re.fullmatch('[0-9a-f]{64}', row.get('sourceSha256', '')) is not None, 'Unique exact target ledger differs')
    require(actual.get('constraints') == constraint_spec(source) and actual.get('trigger') == {'definition': TRIGGER, 'enabled': 'O'}, 'Exact constraints or trigger readback differ')
    for signature, spec in function_spec(source).items():
        value = actual.get('functions', {}).get(signature)
        require(isinstance(value, dict) and value.get('sha256') == spec['after'], 'Forward definition readback differs: ' + signature)
        if spec['before'] is None:
            require(value.get('portable') == spec['portable'], 'New function authority differs: ' + signature)
        else:
            require({k: v for k, v in value.items() if k != 'sha256'} == {k: v for k, v in before['functions'][signature].items() if k != 'sha256'}, 'Preserved function authority differs: ' + signature)


def clean_source(head, source_sha, helper_sha):
    require(Path.cwd().resolve() == ROOT and re.fullmatch('[0-9a-f]{40}', head or '') is not None, 'Exact approved root and full reviewed HEAD required')
    def git(*args):
        return subprocess.check_output(['git', *args], cwd=ROOT)
    require(git('rev-parse', 'HEAD').decode().strip() == head, 'Reviewed HEAD differs')
    require(not git('status', '--porcelain').strip(), 'Release tree must be clean')
    require(git('remote', 'get-url', 'origin').decode().strip() == 'https://github.com/mobilityaccessmodifications/mam-team-management-system.git', 'Wrong MAM Git remote')
    require(git('show', '-s', '--format=%an <%ae>', 'HEAD').decode().strip() == 'mobilityaccessmodifications <310802599+mobilityaccessmodifications@users.noreply.github.com>', 'Wrong MAM source author')
    for path, expected in [(MIGRATION, source_sha), (Path(__file__).resolve(), helper_sha)]:
        require(re.fullmatch('[0-9a-f]{64}', expected or '') is not None, 'Explicit reviewed source/helper SHA required')
        raw = path.read_bytes()
        require(sha(raw) == expected and git('show', head + ':' + str(path.relative_to(ROOT))) == raw, 'Reviewed committed bytes differ')
    require(git('show', head + ':' + str(PREDECESSOR.relative_to(ROOT))) == PREDECESSOR.read_bytes(), 'Committed predecessor bytes differ')


def load_json(raw):
    def pairs(items):
        result = {}
        for key, value in items:
            require(key not in result, 'Duplicate JSON key')
            result[key] = value
        return result
    def constant(value):
        raise SystemExit('Non-finite JSON value')
    return json.loads(raw, object_pairs_hook=pairs, parse_constant=constant)


def retain(path, value):
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    descriptor = os.open(str(path), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, 'w') as handle:
        handle.write(json.dumps(value, sort_keys=True, indent=2, allow_nan=False) + '\n')
        handle.flush()
        os.fsync(handle.fileno())


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument('action', choices=('prepare', 'inspect', 'apply'))
    parser.add_argument('--source-sha', required=True)
    parser.add_argument('--snapshot', required=True, type=Path)
    parser.add_argument('--snapshot-sha')
    parser.add_argument('--head')
    parser.add_argument('--helper-sha')
    parser.add_argument('--attestation', type=Path)
    parser.add_argument('--attestation-sha')
    parser.add_argument('--dispatch', type=Path)
    args = parser.parse_args(argv)
    source = candidate(args.source_sha)
    if args.action == 'apply':
        clean_source(args.head, args.source_sha, args.helper_sha)
    before = None
    if args.action != 'prepare':
        require(re.fullmatch('[0-9a-f]{64}', args.snapshot_sha or '') is not None and sha(args.snapshot.read_bytes()) == args.snapshot_sha, 'Explicit reviewed predecessor snapshot differs')
        before = load_json(args.snapshot.read_bytes())
        validate_before(before, source)
    else:
        require(not args.snapshot.exists(), 'Preserve existing predecessor snapshot')
    target = api('')
    require(isinstance(target, dict) and target.get('id') == PROJECT and target.get('organization_id') == ORGANISATION, 'Wrong MAM project/organization')
    actual = read_state(source)
    if args.action == 'prepare':
        validate_before(actual, source)
        retain(args.snapshot, actual)
        print(json.dumps({'readOnly': True, 'targetVerified': True, 'snapshotSha256': sha(args.snapshot.read_bytes()), 'version': VERSION}))
        return
    assert before is not None
    release = transaction(source, before)
    identity = {'project': PROJECT, 'organization': ORGANISATION, 'version': VERSION, 'head': args.head,
                'sourceSha256': args.source_sha, 'snapshotSha256': args.snapshot_sha, 'transactionSha256': sha(release.encode())}
    recorded = any(row['version'] == VERSION for row in actual['ledger'])
    if recorded:
        require(args.attestation is not None and re.fullmatch('[0-9a-f]{64}', args.attestation_sha or '') is not None, 'Reviewed exact COMMIT attestation required; reconcile read-only and do not retry')
        raw = args.attestation.read_bytes()
        require(sha(raw) == args.attestation_sha, 'Reviewed COMMIT attestation bytes differ')
        receipt = load_json(raw)
        catalog = resulting_catalog([{'tradeSchoolResultingCatalogSha256': receipt.get('resultingCatalogSha256')}])
        require(receipt == dict(identity, resultingCatalogSha256=catalog), 'COMMIT attestation target/source differs')
        verify_after(actual, before, source, catalog)
        print(json.dumps({'readOnly': True, 'recorded': True, 'readbackVerified': True, 'version': VERSION}))
        return
    validate_before(actual, source)
    require(actual == before, 'Observed predecessor changed; do not adopt or retry')
    if args.action == 'inspect':
        print(json.dumps({'readOnly': True, 'targetAbsent': True, 'predecessorMatches': True, 'version': VERSION}))
        return
    require(args.attestation is not None and not args.attestation.exists() and args.attestation_sha is None, 'New retained COMMIT attestation path required')
    require(args.dispatch is not None and not args.dispatch.exists() and args.dispatch.resolve() not in (args.snapshot.resolve(), args.attestation.resolve()), 'Unspent exclusive dispatch path required; never retry an unknown write')
    retain(args.dispatch, identity)
    print(json.dumps({'operation': 'one exact transaction', 'querySha256': identity['transactionSha256'], 'version': VERSION}), flush=True)
    try:
        catalog = resulting_catalog(query(release))
    except (Exception, SystemExit):
        try:
            reconciled = read_state(source)
            print(json.dumps({'readOnlyReconciliation': True, 'targetRecorded': any(row['version'] == VERSION for row in reconciled['ledger']), 'dispatchSpent': True}), flush=True)
        except (Exception, SystemExit):
            print(json.dumps({'readOnlyReconciliation': False, 'dispatchSpent': True}), flush=True)
        raise SystemExit('Write outcome unverified; retain dispatch and reconcile read-only, never retry') from None
    retain(args.attestation, dict(identity, resultingCatalogSha256=catalog))
    verify_after(read_state(source), before, source, catalog)
    print(json.dumps({'committed': True, 'readbackVerified': True, 'writeCount': 1, 'retryCount': 0,
                      'attestationSha256': sha(args.attestation.read_bytes()), 'resultingCatalogSha256': catalog, 'version': VERSION}))


if __name__ == '__main__':
    main()
