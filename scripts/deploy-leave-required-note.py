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
VERSION = '20261013180000'
NAME = 'leave_required_employee_note'
PREDECESSOR_VERSION = '20261013170000'
PREDECESSOR_NAME = 'subscription_review_tasks'
SIGNATURE = 'private.enforce_leave_request_employment_policy()'
BEFORE_SHA = '6535b99e6244c42999825fd79262d29623e109f7af701810dcf4b6b410ff9819'
AFTER_SHA = '129ff4a64cf0d48c021424e2f95562cee499b9c2baad32586885e6c29f03d4dc'
COLLECTOR_SHA = '3385d5a0140df3995e3196ffea442b4829f9a5357de3ccf5a8d521fbe9011a54'
MIGRATION = ROOT / 'supabase/migrations' / (VERSION + '_' + NAME + '.sql')
PREDECESSOR = MIGRATION.parent / (PREDECESSOR_VERSION + '_' + PREDECESSOR_NAME + '.sql')
TRANSPORT = ROOT / 'scripts/deploy-staff-leave-calendar.py'
assert hashlib.sha256(TRANSPORT.read_bytes()).hexdigest() == '25e257bd80596247f4ae6fadf74e4283c6078a22ad9141d4f24b6614d38fb011', 'Reviewed transport differs'
SPEC = importlib.util.spec_from_file_location('required_note_transport', TRANSPORT)
assert SPEC is not None and SPEC.loader is not None
SHARED = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(SHARED)
require, literal, api, query = SHARED.require, SHARED.literal, SHARED.api, SHARED.query


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def transaction_body(source):
    require(source.startswith('begin;\n') and source.endswith('\ncommit;\n'), 'Unsupported outer transaction boundaries')
    return source[len('begin;\n'):-len('commit;\n')]


def candidate(source_sha):
    require(re.fullmatch('[0-9a-f]{64}', source_sha or '') is not None, 'Explicit reviewed source SHA required')
    raw = MIGRATION.read_bytes()
    require(sha(raw) == source_sha, 'Reviewed source bytes differ')
    source = raw.decode('utf-8')
    transaction_body(source)
    section = source.split('insert into required_note_function_spec values\n', 1)[1].split('\ndo $required_note_predecessor$', 1)[0]
    require(section == '(' + ','.join(literal(v) for v in (SIGNATURE, BEFORE_SHA, AFTER_SHA)) + ');', 'Exact singleton function delta required')
    return source


def source_function(source, name):
    start = "create function pg_temp." + name + "() returns jsonb language sql stable set search_path='' as $$\n"
    require(source.count(start) == 1, 'Unsupported exact core guard: ' + name)
    body = source.split(start, 1)[1].split('\n$$;', 1)[0]
    require(body.startswith('select ') and body.endswith(';'), 'Unsupported core expression: ' + name)
    return body[:-1]


def state_expression(source):
    data = source_function(source, 'required_note_data')
    security = source_function(source, 'required_note_security')
    predecessor = PREDECESSOR.read_bytes().decode('utf-8')
    return f"""jsonb_build_object(
 'major',current_setting('server_version_num')::integer/10000,
 'dataHash',encode(extensions.digest(({data})::text,'sha256'),'hex'),
 'securityHash',encode(extensions.digest(({security})::text,'sha256'),'hex'),
 'receiptHash',(select encode(extensions.digest(coalesce(jsonb_agg(to_jsonb(r) order by id),'[]')::text,'sha256'),'hex') from private.confirmed_test_identity_purges r),
 'purgeHash',private.confirmed_test_purge_schema_hash(),
 'purgeMatches',(select count(*)=1 and bool_and(singleton and schema_hash=private.confirmed_test_purge_schema_hash()) from private.confirmed_test_purge_schema),
 'collectorSha256',encode(extensions.digest(pg_get_functiondef('private.confirmed_test_purge_schema_hash()'::regprocedure),'sha256'),'hex'),
 'predecessorExact',coalesce((select name={literal(PREDECESSOR_NAME)} and array_dims(statements)='[1:1]' and statements=ARRAY[{literal(predecessor)}]::text[] from supabase_migrations.schema_migrations where version={literal(PREDECESSOR_VERSION)}),false),
 'targetExact',coalesce((select name={literal(NAME)} and array_dims(statements)='[1:1]' and statements=ARRAY[{literal(source)}]::text[] from supabase_migrations.schema_migrations where version={literal(VERSION)}),false),
 'functionSha256',encode(extensions.digest(pg_get_functiondef({literal(SIGNATURE)}::regprocedure),'sha256'),'hex'),
 'functionMetadata',(select to_jsonb(p)-array['prosrc','prosqlbody'] from pg_proc p where oid={literal(SIGNATURE)}::regprocedure),
 'ledger',(select coalesce(jsonb_agg(jsonb_build_object('version',m.version,'name',m.name,'dimensions',array_dims(m.statements),'cardinality',cardinality(m.statements),'sourceSha256',encode(extensions.digest(coalesce(m.statements::text,'<NULL>'),'sha256'),'hex')) order by m.version),'[]') from supabase_migrations.schema_migrations m))"""


def ledger_bound():
    return """do $required_note_ledger_bound$ begin
 if (select count(*) from supabase_migrations.schema_migrations)>512
 or (select coalesce(sum(octet_length(statements::text)),0) from supabase_migrations.schema_migrations)>16777216 then
 raise exception 'Unsupported bounded migration ledger' using errcode='55000'; end if;
end $required_note_ledger_bound$;"""


def read_state(source):
    result = query("begin read only; set local search_path=''; set local lock_timeout='3s'; set local statement_timeout='30s';\n" + ledger_bound() + '\nselect ' + state_expression(source) + ' as state; rollback;')
    require(isinstance(result, list) and len(result) == 1 and set(result[0]) == {'state'} and isinstance(result[0]['state'], dict), 'Invalid bounded read-only state response')
    return result[0]['state']


def validate_before(before, source):
    require(isinstance(before, dict) and before.get('major') in (16, 17) and before.get('purgeMatches') is True and before.get('predecessorExact') is True, 'Exact supported predecessor required')
    require(before.get('collectorSha256') == COLLECTOR_SHA and before.get('functionSha256') == BEFORE_SHA, 'Reviewed predecessor definitions differ')
    for field in ('dataHash', 'securityHash', 'receiptHash', 'purgeHash'):
        require(isinstance(before.get(field), str) and re.fullmatch('[0-9a-f]{64}', before[field]), 'Invalid predecessor hash: ' + field)
    ledger = before.get('ledger')
    require(isinstance(ledger, list) and 0 < len(ledger) <= 512, 'Unsupported bounded raw ledger')
    require(all(isinstance(row, dict) and set(row) == {'version', 'name', 'dimensions', 'cardinality', 'sourceSha256'} and isinstance(row['version'], str) and re.fullmatch('[0-9]{14}', row['version']) and isinstance(row['sourceSha256'], str) and re.fullmatch('[0-9a-f]{64}', row['sourceSha256']) for row in ledger), 'Unsupported exact raw ledger')
    versions = [row['version'] for row in ledger]
    require(len(versions) == len(set(versions)) and versions == sorted(versions) and max(versions) == PREDECESSOR_VERSION and before.get('targetExact') is False, 'Latest predecessor or absent target differs')
    require(isinstance(before.get('functionMetadata'), dict), 'Missing exact function authority')
    candidate(sha(source.encode()))


def expected_ledger_row(source):
    return "jsonb_build_object('version'," + literal(VERSION) + ",'name'," + literal(NAME) + ",'dimensions','[1:1]','cardinality',1,'sourceSha256',encode(extensions.digest((ARRAY[" + literal(source) + "])::text,'sha256'),'hex'))"


def transaction(source, before):
    validate_before(before, source)
    expression = state_expression(source)
    expected = literal(json.dumps(before, separators=(',', ':'), allow_nan=False)) + '::jsonb'
    final = f"""set constraints all immediate;
select pg_temp.required_note_assert_delta();
do $required_note_release_final$ declare actual jsonb; expected jsonb:={expected}; begin
 actual:={expression};
 if (actual-array['purgeHash','purgeMatches','targetExact','functionSha256','ledger']) is distinct from (expected-array['purgeHash','purgeMatches','targetExact','functionSha256','ledger'])
 or pg_temp.required_note_security() is distinct from (select value from pg_temp.required_note_security_before)
 or actual->>'purgeHash' is distinct from (select value from pg_temp.required_note_catalog_after)
 or actual->'purgeMatches' is distinct from 'true'::jsonb
 or actual->'targetExact' is distinct from 'true'::jsonb
 or actual->>'functionSha256' is distinct from {literal(AFTER_SHA)}
 or actual->'ledger' is distinct from (expected->'ledger')||jsonb_build_array({expected_ledger_row(source)}) then
 raise exception 'Required-note release final state differs' using errcode='55000'; end if;
end $required_note_release_final$;
notify pgrst,'reload schema';
select value as "requiredNoteResultingCatalogSha256" from pg_temp.required_note_catalog_after;"""
    insert = 'insert into supabase_migrations.schema_migrations(version,name,statements) values(' + ','.join([literal(VERSION), literal(NAME), 'ARRAY[' + literal(source) + ']::text[]']) + ');'
    return "begin;\nset local search_path=''; set local lock_timeout='3s'; set local statement_timeout='75s';\n" + \
        'lock table supabase_migrations.schema_migrations,private.confirmed_test_identity_purges,private.confirmed_test_purge_schema in access exclusive mode nowait;\n' + \
        ledger_bound() + '\n' + 'do $required_note_release_before$ begin if (' + expression + ') is distinct from ' + expected + \
        " then raise exception 'Required-note release predecessor changed' using errcode='55000'; end if; end $required_note_release_before$;\n" + \
        transaction_body(source) + '\n' + insert + '\n' + final + '\ncommit;'


def resulting_catalog(result):
    require(isinstance(result, list) and len(result) == 1 and isinstance(result[0], dict) and set(result[0]) == {'requiredNoteResultingCatalogSha256'}, 'Missing exact COMMIT attestation; reconcile read-only and do not retry')
    value = result[0]['requiredNoteResultingCatalogSha256']
    require(isinstance(value, str) and re.fullmatch('[0-9a-f]{64}', value), 'Invalid exact COMMIT attestation; do not retry')
    return value


def verify_after(actual, before, source, expected_catalog):
    validate_before(before, source)
    require(isinstance(expected_catalog, str) and re.fullmatch('[0-9a-f]{64}', expected_catalog) and actual.get('purgeHash') == expected_catalog, 'Attested catalog readback differs; do not retry')
    changing = {'purgeHash', 'purgeMatches', 'targetExact', 'functionSha256', 'ledger'}
    require({k: v for k, v in actual.items() if k not in changing} == {k: v for k, v in before.items() if k not in changing}, 'Protected readback differs')
    require(actual.get('purgeMatches') is True and actual.get('targetExact') is True and actual.get('functionSha256') == AFTER_SHA, 'Exact forward readback differs')
    ledger = actual.get('ledger', [])
    require(len(ledger) == len(before['ledger']) + 1 and ledger[:-1] == before['ledger'], 'Historical raw ledger readback differs')
    row = ledger[-1]
    require(row.get('version') == VERSION and row.get('name') == NAME and row.get('dimensions') == '[1:1]' and row.get('cardinality') == 1 and isinstance(row.get('sourceSha256'), str) and re.fullmatch('[0-9a-f]{64}', row['sourceSha256']), 'Unique exact target ledger differs')


def clean_source(head, source_sha, helper_sha):
    require(Path.cwd().resolve() == ROOT and re.fullmatch('[0-9a-f]{40}', head or ''), 'Exact approved root and full reviewed HEAD required')
    require(not any(key.startswith('GIT_') for key in os.environ), 'Inherited Git settings forbidden')
    def git(*args):
        return subprocess.check_output(['git', *args], cwd=ROOT)
    require(git('rev-parse', 'HEAD').decode().strip() == head, 'Reviewed HEAD differs')
    require(not git('status', '--porcelain').strip(), 'Release tree must be clean')
    require(git('remote', 'get-url', 'origin').decode().strip() == 'https://github.com/mobilityaccessmodifications/mam-team-management-system.git', 'Wrong MAM Git remote')
    require(git('show', '-s', '--format=%an <%ae>', 'HEAD').decode().strip() == 'mobilityaccessmodifications <310802599+mobilityaccessmodifications@users.noreply.github.com>', 'Wrong MAM source author')
    for path, expected in [(MIGRATION, source_sha), (Path(__file__).resolve(), helper_sha)]:
        require(re.fullmatch('[0-9a-f]{64}', expected or ''), 'Explicit reviewed source/helper SHA required')
        raw = path.read_bytes()
        require(sha(raw) == expected and git('show', head + ':' + str(path.relative_to(ROOT))) == raw, 'Reviewed committed bytes differ')
    for path in (PREDECESSOR, TRANSPORT):
        require(git('show', head + ':' + str(path.relative_to(ROOT))) == path.read_bytes(), 'Committed release dependency differs')


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
        require(re.fullmatch('[0-9a-f]{64}', args.snapshot_sha or '') and sha(args.snapshot.read_bytes()) == args.snapshot_sha, 'Explicit reviewed predecessor snapshot differs')
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
    release = transaction(source, before)
    identity = {'project': PROJECT, 'organization': ORGANISATION, 'version': VERSION, 'head': args.head,
                'sourceSha256': args.source_sha, 'snapshotSha256': args.snapshot_sha, 'transactionSha256': sha(release.encode())}
    if any(row['version'] == VERSION for row in actual['ledger']):
        require(args.attestation is not None and re.fullmatch('[0-9a-f]{64}', args.attestation_sha or ''), 'Reviewed exact COMMIT attestation required; do not retry')
        raw = args.attestation.read_bytes()
        require(sha(raw) == args.attestation_sha, 'Reviewed COMMIT attestation bytes differ')
        receipt = load_json(raw)
        catalog = resulting_catalog([{'requiredNoteResultingCatalogSha256': receipt.get('resultingCatalogSha256')}])
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
