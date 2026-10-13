import argparse
import contextlib
import hashlib
import importlib.util
import json
import os
import io
from pathlib import Path
import re
import socket
import sys
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
EVIDENCE = Path('/Volumes/UG/MAM/opencode/mam-reporting-splice-evidence-20261012/finalizer-fix/version-conflict-fix/after-annual-integration/implementation')
ARCHIVED = Path('/Volumes/UG/MAM/opencode/mam-reporting-splice-evidence-20261012/finalizer-fix/f65-guard-supplement/clean-committed-apply/rehearsal.py')
SCRATCH = Path('/Users/nixon/.hermes/profiles/mam/cache/scratch')
ANNUAL = ROOT / 'supabase/migrations/20261013120000_annual_continuous_accrual.sql'
F65 = ROOT / 'supabase/migrations/20261012170000_employee_removal_reporting_splice.sql'


def measured_module(path, expected, name):
    raw = path.read_bytes()
    assert hashlib.sha256(raw).hexdigest() == expected
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec is not None
    module = importlib.util.module_from_spec(spec)
    exec(compile(raw, str(path), 'exec'), module.__dict__)
    return module


def controller():
    m = measured_module(ARCHIVED, 'd1a4c056205c4449c2e5d3e58c3ac29594d88ec9a0acb8aef29a38867486e27f', 'after_annual_archive_reader')
    m.ROOT, m.OUT = ROOT, EVIDENCE / 'native'
    return m


def deny_network(event, args):
    if event == 'socket.connect' and args[0].family != socket.AF_UNIX:
        raise RuntimeError('Synthetic after-annual rehearsal forbids non-Unix network')


def probe(m, major):
    directory = m.OUT / ('pg%s' % major)
    reg = json.loads((directory / 'started-registry.json').read_bytes())
    assert reg['major'] == major and Path(reg['socket']).parent == SCRATCH
    owner = {'owner': 'after-annual-offboarding-integration', 'major': major, 'registry': reg, 'syntheticOnly': True}
    m.save(Path(reg['socket']) / 'after-annual-owner.json', owner)
    m.save(directory / 'after-annual-owner.json', owner)
    helper = measured_module(ROOT / 'scripts/deploy-employee-removal-reporting-splice.py', '1beac990ddf17652b1e6d98d3d3594c4a311a597e134b99e9dd75b96bf099efc', 'after_annual_probe_legacy')
    source = F65.read_text()
    def state(db, label):
        value = m.json_result(m.native(reg, db, 'begin read only; set local search_path=\'\'; select ' + helper.state_expression(source) + '; rollback;', label, readonly=True))
        m.save(directory / (label + '.json'), value)
        return value
    original = state(reg['predecessor'], 'template-original-before')
    helper.validate_before(original, source)
    clone = 'mam_test_after_annual_pg%s' % major
    m.command([reg['bin'] + '/createdb', '-h', reg['socket'], '-p', '55439', '-U', 'postgres', '--owner=postgres', '--template=' + reg['predecessor'], clone], directory, 'create-after-annual-clone')
    m.save(directory / 'owned-clone.json', {'database': clone, 'template': reg['predecessor'], 'owner': owner['owner']})
    raw = ANNUAL.read_bytes()
    assert hashlib.sha256(raw).hexdigest() == '271c649221999cfce6f27ecbcd39dfbc5e95e581108a39b66f0f88ae182d2682'
    identity = m.json_result(m.native(reg, clone, "begin read only;select jsonb_build_object('database',current_database(),'current',current_user,'session',session_user,'major',current_setting('server_version_num')::int/10000,'superuser',rolsuper,'socketOnly',inet_server_addr() is null and current_setting('listen_addresses')='') from pg_roles where rolname=current_user;rollback;", 'actual-execution-identity', readonly=True))
    assert identity['database'] == clone and identity['current'] == identity['session'] == 'postgres' and identity['major'] == major and not identity['superuser'] and identity['socketOnly']
    m.save(directory / 'actual-execution-identity.json', identity)
    result = m.native(reg, clone, raw.decode(), 'published-annual-core')
    assert 'COMMIT' in result.stdout.decode().splitlines()
    m.native(reg, clone, 'insert into supabase_migrations.schema_migrations(version,name,statements) values(\'20261013120000\',\'annual_continuous_accrual\',ARRAY[' + helper.literal(raw.decode()) + ']::text[]);', 'synthetic-published-annual-ledger')
    current = state(clone, 'exact-native-after-annual')
    assert current['purgeMatches'] and current['predecessorExact'] and current['functions'] == original['functions'] and not current['targetExact']
    rejected = None
    try:
        helper.validate_before(current, source)
    except SystemExit as error:
        rejected = str(error)
    assert rejected == 'Latest predecessor or absent target differs'
    m.save(directory / 'native-legacy-red.json', {'status': 'RED_CONFIRMED', 'reason': rejected, 'nativeAnnualCommit': True, 'nativeBefore': m.pin(directory / 'exact-native-after-annual.json'), 'originalHelperUnchanged': True, 'publishedAnnualSourceSha256': hashlib.sha256(raw).hexdigest()})
    print(json.dumps({'major': major, 'nativeAnnualCore': 'COMMIT', 'legacyValidation': rejected, 'database': clone}), flush=True)


def model_adapter(phase):
    path = ROOT / 'scripts/deploy-offboarding-after-annual.py'
    module = measured_module(path, hashlib.sha256(path.read_bytes()).hexdigest(), 'after_annual_model_adapter')
    adapter = module.AfterAnnualAdapter.__new__(module.AfterAnnualAdapter)
    adapter.phase = phase
    adapter.head = 'de5bf28526bb676289392b50b010ece9f4b63d7a'
    adapter.pins = {ROOT / path: pin for path, pin in module.IMMUTABLE.items()}
    adapter.pins[path] = hashlib.sha256(path.read_bytes()).hexdigest()
    adapter.raw = {p: module.source_snapshot(p) for p in adapter.pins}
    adapter.load_components()
    return module, adapter


def setup(m, major):
    directory = m.OUT / ('pg%s' % major)
    reg = json.loads((directory / 'started-registry.json').read_bytes())
    db = json.loads((directory / 'owned-clone.json').read_bytes())['database']
    role = 'mam_test_aa%s_settings' % major
    m.native(reg, db, 'create role ' + role + ' nologin nosuperuser nobypassrls nocreatedb nocreaterole noreplication;', 'create-owned-settings-role')
    sql = "create schema aa_release_probe;grant usage on schema aa_release_probe to anon;create table aa_release_probe.sensitive(value integer);insert into aa_release_probe.sensitive values(1);grant select on aa_release_probe.sensitive to anon;alter table aa_release_probe.sensitive enable row level security;alter table aa_release_probe.sensitive force row level security;create policy scoped_deny on aa_release_probe.sensitive for select to anon using(false);"
    sql += "insert into supabase_migrations.schema_migrations(version,name,statements) values('19000101000001','synthetic_legacy_null_1',null),('19000101000002','synthetic_legacy_empty_1',array[]::text[]),('19000101000003','synthetic_legacy_bound_0',array_fill('select 1;'::text,array[1],array[0])),('19000101000004','synthetic_legacy_null_2',null),('19000101000005','synthetic_legacy_empty_2',array[]::text[]),('19000101000006','synthetic_legacy_null_3',null),('19000101000007','synthetic_legacy_empty_3',array[]::text[]);"
    sql += "insert into auth.users(id,email,email_confirmed_at) values('a7500000-0000-4000-8000-000000000001','aa-preservation@example.test',clock_timestamp());insert into public.profiles(id,full_name,app_role,login_name,credentials_valid_after) values('a7500000-0000-4000-8000-000000000001','Synthetic Annual Preservation','admin','aa-preservation@example.test',clock_timestamp()-interval '1 day');"
    sql += "insert into public.internal_org_people(id,full_name,company_key,position_title) values('a7500000-0000-4000-8000-000000000002','Synthetic Accounting Preservation','mam','Synthetic role');insert into private.annual_leave_day_accounting(person_id,service_date,state) values('a7500000-0000-4000-8000-000000000002',date '2000-01-01','{\"status\":\"current\"}');"
    sql += "insert into private.confirmed_test_identity_purges(id,person_id,auth_user_id,actor_user_id,company_key,manifest_hash,manifest,retained_audit,retired_identifiers,phase,completed_at) values('a7500000-0000-4000-8000-000000000099','a7500000-0000-4000-8000-000000000099',null,'a7500000-0000-4000-8000-000000000001','mam',repeat('b',64),'{\"synthetic\":true}','{\"retained\":true}',array['a7500000-0000-4000-8000-000000000099']::uuid[],'complete',clock_timestamp());"
    m.native(reg, db, sql, 'synthetic-seven-history-security-receipt-accounting-setup')
    settings = "insert into pg_catalog.pg_db_role_setting(setdatabase,setrole,setconfig) values(0,0,null),(0,(select oid from pg_roles where rolname='" + role + "'),array[]::text[]),((select oid from pg_database where datname='" + db + "'),0,array_fill('mam.synthetic_mode=fixture'::text,array[1],array[0]));"
    m.native(reg, db, settings, 'owned-settings-null-empty-bound-setup', user='fixture_bootstrap')
    m.save(directory / 'synthetic-fixture-setup.json', {'ownedRole': role, 'database': db, 'legacyRows': 7, 'realStaffData': False, 'hostedBusinessHashesBorrowed': False, 'databaseRoleSettingsAllRows': True, 'nullEmptyLowerBoundAndRoleZeroDatabaseZero': True, 'ledgerReconstructionClaimed': False, 'fingerprintReset': False})


def full_frame(m, reg, db, adapter, label, before=None):
    helper, source = adapter.helper, adapter.raw[adapter.core].decode()
    security = helper.source_function(source, adapter.prefix + '_security')
    reference = 'select to_regprocedure(signature) from ' + adapter.prefix + '_function_spec where to_regprocedure(signature) is not null'
    assert security.count(reference) == 1
    signatures = ','.join(helper.literal(sig) for sig in sorted(helper.SIGNATURES))
    security = security.replace(reference, 'select to_regprocedure(signature) from unnest(array[' + signatures + ']::text[]) signature where to_regprocedure(signature) is not null')
    data = helper.source_function(source, adapter.prefix + '_data')
    collector_query = "begin read only;select jsonb_build_object('definitionSha256',encode(extensions.digest(pg_get_functiondef(p.oid),'sha256'),'hex'),'body',prosrc) from pg_proc p where oid='private.confirmed_test_purge_schema_hash()'::regprocedure;rollback;"
    collector = m.json_result(m.native(reg, db, collector_query, label + '-collector', readonly=True))
    assert collector['definitionSha256'] == '3385d5a0140df3995e3196ffea442b4829f9a5357de3ccf5a8d521fbe9011a54'
    anchor = "select encode(extensions.digest(coalesce(string_agg(definition,E'\\n' order by definition),''),'sha256'),'hex') from ("
    assert collector['body'].count(anchor) == 1
    catalog = collector['body'].replace(anchor, 'select definition from (', 1).rstrip().removesuffix(';')
    ctes = 'catalog(definition) as (' + catalog + '),security(value) as (' + security + '),data(value) as (' + data + ')'
    normalized = ''
    if before is not None:
        initial = helper.literal(json.dumps(before['catalogEntries'], separators=(',', ':'))) + '::jsonb'
        prior_defs = [x['sha256'] for x in before['state']['functions'].values() if x is not None]
        old_defs = helper.literal(json.dumps(prior_defs)) + '::jsonb'
        new_signatures = ','.join(helper.literal(sig) for sig, spec in helper.function_spec(source).items() if spec['before'] is None)
        removed = "select encode(extensions.digest(pg_get_functiondef(to_regprocedure(signature)),'sha256'),'hex') from unnest(array[" + signatures + ']::text[]) signature'
        if new_signatures:
            removed += " union all select encode(extensions.digest(p.oid::regprocedure::text||':'||p.proowner::text||':'||coalesce(p.proacl::text,'default'),'sha256'),'hex') from unnest(array[" + new_signatures + ']::text[]) signature join pg_proc p on p.oid=to_regprocedure(signature)'
        ctes += ',original(value) as (select jsonb_array_elements_text(' + initial + ')),current_digests(value) as (select encode(extensions.digest(definition,\'sha256\'),\'hex\') from catalog),removed(value) as (' + removed + '),normalized(value) as ((select value collate "C" from current_digests except all select value collate "C" from removed) union all select jsonb_array_elements_text(' + old_defs + '))'
        normalized = ",'normalizedCatalog',jsonb_build_object('beforeOnly',(select coalesce(jsonb_agg(value),'[]'::jsonb) from (select value collate \"C\" from original except all select value collate \"C\" from normalized) r),'afterOnly',(select coalesce(jsonb_agg(value),'[]'::jsonb) from (select value collate \"C\" from normalized except all select value collate \"C\" from original) r))"
    query = "begin read only;set local search_path='';set local statement_timeout='30s';with " + ctes + " select jsonb_build_object('state'," + adapter.state_expression(source) + ", 'catalogCount',(select count(*) from catalog),'catalogEntries',(select coalesce(jsonb_agg(encode(extensions.digest(definition,'sha256'),'hex') order by definition collate \"C\"),'[]'::jsonb) from catalog),'catalogNativeHash',private.confirmed_test_purge_schema_hash(),'securityByKind',(select jsonb_object_agg(x.key,jsonb_build_object('sha256',encode(extensions.digest(x.value::text,'sha256'),'hex'),'count',case when jsonb_typeof(x.value)='array' then jsonb_array_length(x.value) else null end)) from security cross join lateral jsonb_each(security.value) x),'dataByTable',(select jsonb_object_agg(x.key,jsonb_build_object('sha256',encode(extensions.digest(x.value::text,'sha256'),'hex'),'count',jsonb_array_length(x.value))) from data cross join lateral jsonb_each(data.value) x),'ledgerNative',(select coalesce(jsonb_agg(jsonb_build_object('version',m.version,'name',m.name,'rowSha256',encode(extensions.digest(to_jsonb(m)::text,'sha256'),'hex'),'isNull',m.statements is null,'cardinality',cardinality(m.statements),'dimensions',array_dims(m.statements),'ndims',array_ndims(m.statements),'lower',array_lower(m.statements,1),'upper',array_upper(m.statements,1),'arraySha256',encode(extensions.digest(coalesce(m.statements::text,'<NULL>'),'sha256'),'hex'),'elements',(select coalesce(jsonb_agg(jsonb_build_object('ordinal',e.ordinality,'bytes',octet_length(e.value),'sha256',encode(extensions.digest(e.value,'sha256'),'hex')) order by e.ordinality),'[]'::jsonb) from unnest(m.statements) with ordinality e(value,ordinality))) order by m.version),'[]'::jsonb) from supabase_migrations.schema_migrations m),'fingerprintRows',(select jsonb_agg(jsonb_build_object('nonHashSha256',encode(extensions.digest((to_jsonb(f)-'schema_hash')::text,'sha256'),'hex'),'schemaHash',f.schema_hash,'singleton',f.singleton) order by f.singleton) from private.confirmed_test_purge_schema f),'receiptCount',(select count(*) from private.confirmed_test_identity_purges),'settingsRows',(select coalesce(jsonb_agg(jsonb_build_object('database',s.setdatabase,'role',s.setrole,'dimensions',array_dims(s.setconfig),'cardinality',cardinality(s.setconfig),'isNull',s.setconfig is null,'rowSha256',encode(extensions.digest(to_jsonb(s)::text,'sha256'),'hex')) order by s.setdatabase,s.setrole),'[]'::jsonb) from pg_db_role_setting s)" + normalized + ');rollback;'
    frame = m.json_result(m.native(reg, db, query, label, readonly=True))
    m.save(m.OUT / ('pg%s' % reg['major']) / (label + '.json'), frame)
    assert frame['catalogCount'] == len(frame['catalogEntries']) and frame['state']['purgeHash'] == frame['catalogNativeHash']
    return frame


def exact_after(before, after, adapter, catalog):
    source = adapter.raw[adapter.core].decode()
    adapter.verify_after(after['state'], before['state'], source, catalog)
    for field in ('securityByKind', 'dataByTable', 'settingsRows', 'receiptCount'):
        assert after[field] == before[field], field
    remaining = [row for row in after['ledgerNative'] if row['version'] != adapter.helper.VERSION]
    assert remaining == before['ledgerNative']
    target = next(row for row in after['ledgerNative'] if row['version'] == adapter.helper.VERSION)
    assert target['elements'] == [{'ordinal': 1, 'bytes': len(adapter.raw[adapter.core]), 'sha256': adapter.pins[adapter.core]}]
    assert target['dimensions'] == '[1:1]' and target['lower'] == target['upper'] == target['cardinality'] == 1
    assert after['fingerprintRows'] == [dict(before['fingerprintRows'][0], schemaHash=catalog)]
    assert after['normalizedCatalog'] == {'beforeOnly': [], 'afterOnly': []}


def execute(m, major):
    directory = m.OUT / ('pg%s' % major)
    reg = json.loads((directory / 'started-registry.json').read_bytes())
    db = json.loads((directory / 'owned-clone.json').read_bytes())['database']
    assert json.loads((Path(reg['socket']) / 'after-annual-owner.json').read_bytes())['registry'] == reg
    results = []
    for index, phase in enumerate(('reporting-splice', 'finalizer', 'version-conflict')):
        module, adapter = model_adapter(phase)
        source = adapter.raw[adapter.core].decode()
        stage = directory / phase
        stage.mkdir(mode=0o700, exist_ok=False)
        template = 'mam_test_aa%s_stage%s' % (major, index)
        m.command([reg['bin'] + '/createdb', '-h', reg['socket'], '-p', '55439', '-U', 'postgres', '--owner=postgres', '--template=' + db, template], directory, phase + '-template')
        before = full_frame(m, reg, db, adapter, phase + '-full-before')
        adapter.validate_before(before['state'], source)
        legacy_rejection = None
        try:
            adapter.helper.validate_before(before['state'], source)
        except SystemExit as error:
            legacy_rejection = str(error)
        assert legacy_rejection == 'Latest predecessor or absent target differs'
        writes, reads = [], []
        expected = None
        def integrity():
            assert all(module.source_snapshot(p) == raw for p, raw in adapter.raw.items())
        def fixture_api(value):
            assert value == ''
            return {'id': adapter.helper.PROJECT, 'organization_id': adapter.helper.ORGANISATION}
        def fixture_query(query):
            if query.startswith('begin read only;'):
                label = phase + '-model-read-%s' % len(reads)
                value = m.json_result(m.native(reg, db, query, label, readonly=True))
                reads.append(hashlib.sha256(query.encode()).hexdigest())
                return [{'state': value}]
            assert query == expected and not writes
            result = m.native(reg, db, query, phase + '-native-commit')
            assert result.stdout.decode().splitlines().count('COMMIT') == 1
            hashes = [line for line in result.stdout.decode().splitlines() if re.fullmatch('[0-9a-f]{64}', line)]
            assert len(hashes) == 1
            writes.append({'querySha256': hashlib.sha256(query.encode()).hexdigest(), 'nativeCommitTags': 1, 'catalog': hashes[0]})
            alias = {'reporting-splice': 'reportingSpliceResultingCatalogSha256', 'finalizer': 'archivedFinalizerResultingCatalogSha256', 'version-conflict': 'offboardingVersionConflictResultingCatalogSha256'}[phase]
            return [{alias: hashes[0]}]
        def arguments(action, snapshot_sha=None, attestation_sha=None):
            values = [action, '--phase', phase, '--head', adapter.head, '--adapter-sha', adapter.pins[module.ADAPTER], '--helper-sha', adapter.pins[adapter.helper_path], '--guarded-sha', adapter.pins[ROOT / 'scripts/deploy-reporting-splice-guarded.py'], '--transport-sha', adapter.pins[ROOT / 'scripts/deploy-staff-leave-calendar.py'], '--source-sha', adapter.pins[adapter.core], '--annual-sha', adapter.pins[module.ANNUAL], '--snapshot', str(stage / 'before.json')]
            if action != 'prepare':
                values += ['--snapshot-sha', snapshot_sha, '--dispatch', str(stage / 'dispatch.json'), '--attestation', str(stage / 'attestation.json')]
            if attestation_sha is not None:
                values += ['--attestation-sha', attestation_sha]
            return module.arguments(values)
        with patch.object(adapter, 'check_custody', integrity), patch.object(adapter.helper, 'api', fixture_api), patch.object(adapter.helper, 'query', fixture_query):
            stdout = io.StringIO()
            with contextlib.redirect_stdout(stdout):
                adapter.run(arguments('prepare'))
            m.save(stage / 'prepare-model.stdout', stdout.getvalue().encode())
            captured = adapter.helper.load_json((stage / 'before.json').read_bytes())
            assert captured == before['state']
            expected, original, changes = adapter.bind_query(source, captured)
            m.save(stage / 'public-query.sql', expected.encode())
            m.save(stage / 'legacy-validation-projection-query.sql', original.encode())
            restored = expected
            declared = []
            for old, new in reversed(changes):
                assert restored.count(new) == 1
                restored = restored.replace(new, old, 1)
            assert restored == original
            for old, new in changes:
                declared.append({'oldSha256': module.sha(old.encode()), 'newSha256': module.sha(new.encode()), 'oldBytes': len(old.encode()), 'newBytes': len(new.encode())})
            m.save(stage / 'query-reversal.json', {'exact': True, 'projectionUse': 'PURE_LEGACY_VALIDATION_ONLY_NEVER_NATIVE', 'publicQuerySha256': module.sha(expected.encode()), 'legacyQuerySha256': module.sha(original.encode()), 'reversedQuerySha256': module.sha(restored.encode()), 'changes': declared, 'fullAnnualIncludedNativeBeforeAndFinal': True})
            snap_sha = module.sha((stage / 'before.json').read_bytes())
            for action in ('inspect', 'apply'):
                stdout = io.StringIO()
                try:
                    with contextlib.redirect_stdout(stdout):
                        adapter.run(arguments(action, snap_sha))
                finally:
                    m.save(stage / (action + '-MODEL-entry.stdout'), stdout.getvalue().encode())
            assert len(writes) == 1
            after = full_frame(m, reg, db, adapter, phase + '-full-after', before)
            exact_after(before, after, adapter, writes[0]['catalog'])
            stdout = io.StringIO()
            with contextlib.redirect_stdout(stdout):
                adapter.run(arguments('apply', snap_sha, module.sha((stage / 'attestation.json').read_bytes())))
            m.save(stage / 'second-apply-MODEL-entry.stdout', stdout.getvalue().encode())
            assert len(writes) == 1 and '"readOnly": true' in stdout.getvalue()
            second = full_frame(m, reg, db, adapter, phase + '-full-second-after', before)
            assert second == after
        result = {'phase': phase, 'status': 'PASS', 'proofClass': 'MODEL_ENTRYPOINT_ACTUAL_NATIVE_GENERATED_TRANSACTION', 'actualCleanCommittedEntrypoint': 'PENDING_UNCOMMITTED', 'nativeCommitCount': len(writes), 'nativeReads': len(reads), 'legacyValidator': legacy_rejection, 'template': template, 'querySha256': writes[0]['querySha256'], 'catalogSha256': writes[0]['catalog'], 'completeNativeLedgerSecurityDataReceiptsSettingsReadback': True, 'sortedHistoricalInsertion': before['state']['ledger'][-1]['version'] > adapter.helper.VERSION, 'secondApplyWrites': 0}
        m.save(stage / 'result.json', result)
        results.append(result)
        print(json.dumps({'major': major, 'phase': phase, 'status': result['status'], 'nativeCommit': 1, 'secondApplyWrites': 0}), flush=True)
    m.save(directory / 'three-phase-results.json', {'results': results, 'pass': len(results), 'fail': 0, 'blocked': ['clean-committed-entry', 'independent-review', 'provider', 'hosted'], 'syntheticOnly': True})


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('action', choices=['restore', 'probe', 'setup', 'execute'])
    parser.add_argument('--major', choices=[16, 17], type=int, required=True)
    args = parser.parse_args()
    os.umask(0o077)
    os.environ['TMPDIR'] = str(SCRATCH)
    os.chdir(ROOT)
    sys.addaudithook(deny_network)
    with patch('urllib.request.urlopen', side_effect=AssertionError('No hosted/provider calls')):
        m = controller()
        if args.action == 'restore':
            m.OUT.mkdir(mode=0o700, exist_ok=True)
            reg = m.restore(args.major)
            print(json.dumps({'major': args.major, 'restoredOwnedSocket': reg['socket'], 'pid': reg['pid']}), flush=True)
        elif args.action == 'probe':
            probe(m, args.major)
        elif args.action == 'setup':
            setup(m, args.major)
        else:
            execute(m, args.major)


if __name__ == '__main__':
    main()
