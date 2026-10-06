import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import subprocess

ROOT = Path(__file__).resolve().parents[1]
PROJECT = 'xtwlrjqbusadghavchqm'
ORG = 'fwlmbmospuwoaosffvmw'
VERSION = '20261006106000'
NAME = 'annual_leave_all_submitter_gate'
MIGRATION = ROOT / 'supabase/migrations' / (VERSION + '_' + NAME + '.sql')
PINS = ROOT / 'scripts/annual-leave-gate-release-pins.json'
SPEC = importlib.util.spec_from_file_location('closing_helpers', ROOT / 'scripts/deploy-payroll-closing-carryforward.py')
assert SPEC is not None and SPEC.loader is not None
SHARED = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(SHARED)
require, literal, query = SHARED.require, SHARED.literal, SHARED.query


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def candidate(source_sha):
    require(re.fullmatch('[0-9a-f]{64}', source_sha or '') is not None, 'Explicit reviewed source SHA required')
    raw = MIGRATION.read_bytes()
    require(sha(raw) == source_sha, 'Reviewed source bytes differ')
    source = raw.decode('utf-8')
    SHARED.transaction_body(source)
    return source


def state_expression(source):
    signatures = ','.join(literal(s) for s in json.loads(PINS.read_bytes())['afterFunctions'])
    start = "create function pg_temp.annual_gate_data_hash() returns text language sql stable set search_path='' as $$\n"
    require(source.count(start) == 1, 'Unsupported reviewed business-data guard')
    data = source.split(start, 1)[1].split('$$;', 1)[0].strip().removesuffix(';').removeprefix('select ')
    security = SHARED.full_security_query().removeprefix('SELECT ').removesuffix(' AS metadata;')
    return f"""jsonb_build_object(
      'major',current_setting('server_version_num')::integer/10000,
      'dataHash',({data}),
      'securityHash',encode(extensions.digest(({security})::text,'sha256'),'hex'),
      'receiptHash',(select encode(extensions.digest(coalesce(jsonb_agg(to_jsonb(r) order by id),'[]')::text,'sha256'),'hex') from private.confirmed_test_identity_purges r),
      'purgeHash',private.confirmed_test_purge_schema_hash(),
      'purgeMatches',(select count(*)=1 and bool_and(singleton and schema_hash=private.confirmed_test_purge_schema_hash()) from private.confirmed_test_purge_schema),
      'ledger',(select coalesce(jsonb_agg(jsonb_build_object('version',m.version,'name',m.name,'dimensions',array_dims(m.statements),
        'sourceSha256',encode(extensions.digest(coalesce(m.statements::text,'<NULL>'),'sha256'),'hex')) order by m.version),'[]') from supabase_migrations.schema_migrations m),
      'functions',(select jsonb_object_agg(signature,case when p.oid is null then 'null'::jsonb else jsonb_build_object(
        'sha256',encode(extensions.digest(pg_get_functiondef(p.oid),'sha256'),'hex'),'owner',pg_get_userbyid(p.proowner),'acl',p.proacl::text,
        'securityDefiner',p.prosecdef,'volatility',p.provolatile,'config',p.proconfig) end)
        from unnest(array[{signatures}]::text[]) signature left join pg_proc p on p.oid=to_regprocedure(signature)))"""


def read_state(source):
    return query("begin read only; set local search_path=''; select " + state_expression(source) + ' as state; rollback;')[0]['state']


def validate_before(state, pins):
    require(state['major'] in (16, 17) and state['purgeMatches'] is True, 'Unsupported server or purge predecessor')
    versions = [row['version'] for row in state['ledger']]
    require(versions and len(versions) == len(set(versions)) and all(re.fullmatch('[0-9]{14}', v) for v in versions), 'Unsupported raw migration ledger')
    require(max(versions) < VERSION and '20261006104000' in versions, 'Exact shared predecessor or absent target differs')
    require(all(state['functions'].get(signature, {}).get('sha256') == expected for signature, expected in pins['beforeFunctions'].items()), 'Reviewed predecessor definition differs')
    require(all(state['functions'].get(signature) is None for signature in pins['afterFunctions'] if signature not in pins['beforeFunctions']), 'Forward function already exists')


def transaction(source, before, pins):
    validate_before(before, pins)
    expression = state_expression(source)
    encoded = literal(json.dumps(before, separators=(',', ':')))
    insert = 'insert into supabase_migrations.schema_migrations(version,name,statements) values(' + ','.join([literal(VERSION), literal(NAME), 'ARRAY[' + literal(source) + ']']) + ');'
    expected_row = "jsonb_build_object('version'," + literal(VERSION) + ",'name'," + literal(NAME) + ",'dimensions','[1:1]','sourceSha256',encode(extensions.digest((ARRAY[" + literal(source) + "])::text,'sha256'),'hex'))"
    function_checks = []
    for signature, expected in pins['afterFunctions'].items():
        key = literal(signature)
        function_checks.append("actual->'functions'->" + key + "->>'sha256' is distinct from " + literal(expected))
        if signature in pins['beforeFunctions']:
            function_checks.append("((actual->'functions'->" + key + ")-'sha256') is distinct from ((expected->'functions'->" + key + ")-'sha256')")
    conditions = ' or '.join(function_checks)
    final = f"""do $annual_release$ declare actual jsonb; expected jsonb := {encoded}; begin
      actual := {expression};
      if actual->>'dataHash' is distinct from expected->>'dataHash'
        or actual->>'securityHash' is distinct from expected->>'securityHash'
        or actual->>'receiptHash' is distinct from expected->>'receiptHash'
        or actual->>'purgeHash' is distinct from (select value from pg_temp.annual_release_catalog)
        or actual->'purgeMatches' is distinct from 'true'::jsonb
        or actual->'ledger' is distinct from expected->'ledger'||jsonb_build_array({expected_row})
        or {conditions} then
        raise exception 'Annual leave release final state differs' using errcode='55000';
      end if;
    end $annual_release$;"""
    return "begin; set local search_path=''; set local lock_timeout='3s'; set local statement_timeout='75s';\n" + \
        'lock table supabase_migrations.schema_migrations,private.confirmed_test_identity_purges,private.confirmed_test_purge_schema in access exclusive mode nowait;\n' + \
        'do $annual_before$ begin if (' + expression + ') is distinct from ' + encoded + \
        "::jsonb then raise exception 'Annual leave release predecessor changed' using errcode='55000'; end if; end $annual_before$;\n" + \
        SHARED.transaction_body(source) + \
        "\ncreate temporary table annual_release_catalog on commit drop as select private.confirmed_test_purge_schema_hash() value;\n" + \
        insert + '\nset constraints all immediate;\n' + final + "\nnotify pgrst,'reload schema';\n" + \
        'select value as "annualGateResultingCatalogSha256" from pg_temp.annual_release_catalog;\ncommit;'


def resulting_catalog(result):
    require(isinstance(result, list) and len(result) == 1 and isinstance(result[0], dict), 'Missing exact COMMIT catalog attestation; retain write lock and do not retry')
    expected = result[0].get('annualGateResultingCatalogSha256')
    require(isinstance(expected, str) and re.fullmatch('[0-9a-f]{64}', expected) is not None, 'Invalid exact COMMIT catalog attestation; retain write lock and do not retry')
    return expected


def verify_after(actual, before, source, pins, expected_catalog):
    require(isinstance(expected_catalog, str) and re.fullmatch('[0-9a-f]{64}', expected_catalog) is not None, 'Explicit resulting catalog attestation required; retain write lock')
    observed = actual.get('purgeHash')
    require(isinstance(observed, str) and re.fullmatch('[0-9a-f]{64}', observed) is not None and observed == expected_catalog, 'Attested resulting catalog readback differs; retain write lock and do not retry')
    for field in ('dataHash', 'securityHash', 'receiptHash'):
        require(actual[field] == before[field], 'Unchanged protected readback differs: ' + field)
    require(actual['purgeMatches'] is True and len(actual['ledger']) == len(before['ledger']) + 1, 'Purge or unique ledger readback differs')
    require(actual['ledger'][:-1] == before['ledger'], 'Historical raw ledger changed')
    row = actual['ledger'][-1]
    require(row['version'] == VERSION and row['name'] == NAME and row['dimensions'] == '[1:1]', 'Exact target ledger differs')
    raw = query('begin read only; select statements[1]=' + literal(source) + ' as exact from supabase_migrations.schema_migrations where version=' + literal(VERSION) + '; rollback;')
    require(len(raw) == 1 and raw[0]['exact'] is True, 'Target source readback differs')
    for signature, expected in pins['afterFunctions'].items():
        value = actual['functions'].get(signature, {})
        require(value.get('sha256') == expected, 'Forward definition readback differs: ' + signature)
        if signature in pins['beforeFunctions']:
            require({k: v for k, v in value.items() if k != 'sha256'} == {k: v for k, v in before['functions'][signature].items() if k != 'sha256'}, 'Predecessor authority readback differs')
        else:
            owner = before['functions']['private.enforce_banked_annual_leave_request()']['owner']
            require(value['owner'] == owner and value['acl'] == '{' + owner + '=X/' + owner + '}' and value['securityDefiner'] is True and value['volatility'] == 'v', 'Private forward authority readback differs')


def clean_source(head, source_sha, helper_sha, pins_sha):
    require(Path.cwd().resolve() == ROOT and re.fullmatch('[0-9a-f]{40}', head or ''), 'Exact approved root and full HEAD required')
    def git(*args):
        return subprocess.check_output(['git', *args], cwd=ROOT)
    require(git('rev-parse', 'HEAD').decode().strip() == head, 'Reviewed HEAD differs')
    require(not git('status', '--porcelain').strip(), 'Release tree must be clean')
    require(git('remote', 'get-url', 'origin').decode().strip() == 'https://github.com/mobilityaccessmodifications/mam-team-management-system.git', 'Wrong MAM Git remote')
    require(git('show', '-s', '--format=%an <%ae>', 'HEAD').decode().strip() == 'mobilityaccessmodifications <310802599+mobilityaccessmodifications@users.noreply.github.com>', 'Wrong MAM source author')
    for path, expected in [(MIGRATION, source_sha), (Path(__file__).resolve(), helper_sha), (PINS, pins_sha)]:
        require(re.fullmatch('[0-9a-f]{64}', expected or '') is not None, 'Explicit reviewed file SHA required')
        raw = path.read_bytes()
        require(sha(raw) == expected and git('show', head + ':' + str(path.relative_to(ROOT))) == raw, 'Reviewed committed bytes differ')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('action', choices=('prepare', 'apply', 'inspect'))
    parser.add_argument('--source-sha', required=True)
    parser.add_argument('--snapshot', required=True, type=Path)
    parser.add_argument('--snapshot-sha')
    parser.add_argument('--head')
    parser.add_argument('--helper-sha')
    parser.add_argument('--pins-sha')
    parser.add_argument('--attestation', type=Path)
    parser.add_argument('--attestation-sha')
    args = parser.parse_args()
    source = candidate(args.source_sha)
    pins = json.loads(PINS.read_bytes())
    require(pins['version'] == VERSION and pins['project'] == PROJECT and pins['organization'] == ORG and pins['migrationSha256'] == args.source_sha, 'Wrong release pin target')
    if args.action == 'apply':
        clean_source(args.head, args.source_sha, args.helper_sha, args.pins_sha)
    target = SHARED.api()
    require(target.get('id') == PROJECT and target.get('organization_id') == ORG, 'Wrong MAM project/organization')
    actual = read_state(source)
    if args.action == 'prepare':
        validate_before(actual, pins)
        require(not args.snapshot.exists(), 'Preserve existing predecessor snapshot')
        args.snapshot.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        args.snapshot.write_text(json.dumps(actual, sort_keys=True, indent=2) + '\n')
        args.snapshot.chmod(0o600)
        print(json.dumps({'readOnly': True, 'targetVerified': True, 'targetAbsent': True, 'snapshotSha256': sha(args.snapshot.read_bytes()), 'version': VERSION}))
        return
    require(sha(args.snapshot.read_bytes()) == args.snapshot_sha, 'Explicit reviewed snapshot bytes differ')
    before = json.loads(args.snapshot.read_bytes())
    recorded = any(row['version'] == VERSION for row in actual['ledger'])
    if recorded:
        require(args.attestation is not None and re.fullmatch('[0-9a-f]{64}', args.attestation_sha or '') is not None, 'Reviewed exact COMMIT attestation required; retain write lock and reconcile read-only')
        assert args.attestation is not None
        raw_attestation = args.attestation.read_bytes()
        require(sha(raw_attestation) == args.attestation_sha, 'Reviewed COMMIT attestation bytes differ; retain write lock')
        attestation = json.loads(raw_attestation)
        expected_catalog = resulting_catalog([{'annualGateResultingCatalogSha256': attestation.get('resultingCatalogSha256')}])
        require(attestation == {
            'project': PROJECT, 'organization': ORG, 'version': VERSION, 'sourceSha256': args.source_sha,
            'snapshotSha256': args.snapshot_sha, 'transactionSha256': sha(transaction(source, before, pins).encode()),
            'resultingCatalogSha256': expected_catalog,
        }, 'Exact COMMIT attestation target or source differs; retain write lock')
        verify_after(actual, before, source, pins, expected_catalog)
        print(json.dumps({'readOnly': True, 'recorded': True, 'readbackVerified': True, 'version': VERSION}))
        return
    validate_before(actual, pins)
    require(actual == before, 'Observed predecessor changed; stop without adopting new state')
    if args.action == 'inspect':
        print(json.dumps({'readOnly': True, 'targetAbsent': True, 'pinsMatch': True, 'version': VERSION}))
        return
    require(args.attestation is not None and not args.attestation.exists() and args.attestation_sha is None, 'New retained COMMIT attestation path required before the one write')
    assert args.attestation is not None
    args.attestation.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    sql = transaction(source, before, pins)
    print(json.dumps({'operation': 'one exact transaction', 'querySha256': sha(sql.encode()), 'version': VERSION}), flush=True)
    expected_catalog = resulting_catalog(query(sql))
    attestation = {
        'project': PROJECT, 'organization': ORG, 'version': VERSION, 'sourceSha256': args.source_sha,
        'snapshotSha256': args.snapshot_sha, 'transactionSha256': sha(sql.encode()),
        'resultingCatalogSha256': expected_catalog,
    }
    with args.attestation.open('x') as retained:
        args.attestation.chmod(0o600)
        retained.write(json.dumps(attestation, sort_keys=True, indent=2) + '\n')
    print(json.dumps({'attestationSha256': sha(args.attestation.read_bytes()), 'resultingCatalogSha256': expected_catalog, 'version': VERSION}), flush=True)
    verify_after(read_state(source), before, source, pins, expected_catalog)
    print(json.dumps({'committed': True, 'writeCount': 1, 'retryCount': 0, 'readbackVerified': True, 'version': VERSION}))


if __name__ == '__main__':
    main()
