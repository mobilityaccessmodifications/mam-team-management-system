import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import subprocess
import stat

ROOT = Path(__file__).resolve().parents[1]
PROJECT = 'xtwlrjqbusadghavchqm'
ORGANISATION = 'fwlmbmospuwoaosffvmw'
VERSION = '20261013200000'
NAME = 'day_one_reporting_splice_claims'
PREDECESSOR_VERSION = '20261013180000'
PREDECESSOR_NAME = 'leave_required_employee_note'
SIGNATURE = 'private.sync_new_starter_after_person_change()'
BEFORE_SHA = '88f9286ad032b1e62bdda9bb822faba73f6489dbea0c63cdaa3d19b7a970e300'
AFTER_SHA = 'f3385de926eaf08c78d25759bc948130a3410aeb0a2ee7725f044081e8699f52'
COLLECTOR_SHA = '3385d5a0140df3995e3196ffea442b4829f9a5357de3ccf5a8d521fbe9011a54'
MIGRATION = ROOT / 'supabase/migrations' / (VERSION + '_' + NAME + '.sql')
PREDECESSOR = MIGRATION.parent / (PREDECESSOR_VERSION + '_' + PREDECESSOR_NAME + '.sql')
TRANSPORT = ROOT / 'scripts/deploy-staff-leave-calendar.py'
PINS = {
 'scripts/deploy-staff-leave-calendar.py':'25e257bd80596247f4ae6fadf74e4283c6078a22ad9141d4f24b6614d38fb011',
 'supabase/migrations/20261013120000_annual_continuous_accrual.sql':'271c649221999cfce6f27ecbcd39dfbc5e95e581108a39b66f0f88ae182d2682',
 'supabase/migrations/20261013170000_subscription_review_tasks.sql':'6d342d3068c4d6e2eca7c17d573d7793fc78269db2bf0fa6976041c16c37f24e',
 'supabase/migrations/20261013180000_leave_required_employee_note.sql':'ef93a9df381fca2ce4bfa932ff5b9359fadd85ea2b413f0bc8ee8559b0fd9fc0',
 'supabase/migrations/20261012170000_employee_removal_reporting_splice.sql':'f65d043e18716538a6bc29bd0f5d0d95b9d58975de43334705972a0919a4e9e4',
 'supabase/migrations/20261013081500_archived_account_status_finalizer.sql':'7ac9fb016817e36d537e86f468e0383f377c3311e723d0f126cb2c1a228af76d',
 'supabase/migrations/20261013153500_offboarding_version_conflict_responses.sql':'fac3a9fe00bd4ba5f4fb5d1e6ac7f3fd786ac9e1bf2d452617f57e1891ba2e62',
}
ORIGINAL_VERSIONS = ('20261012170000','20261013081500','20261013153500')
INITIAL_FUNCTIONS = {
 'public.archive_employee_directory_record(uuid,bigint,bigint,date,text)':'9fbb4e10f6b99ebdcc6d773efdfadeea42b2b546687c32a73fdbb8ed42673fc8',
 'public.run_scheduled_employee_offboarding(uuid,timestamptz)':'0f3861f5253241454432fd6f2f7529187810d7ef7b58bd101700960548b9e8ab',
 'public.delete_employee_directory_record(uuid,bigint)':'b67bce74091067f4f8e85b97f0f360e9bc7ebfb2722a031b7bb709a3ce169f8a',
 'public.finalise_portal_account_status_change(uuid,uuid,uuid)':'61ba36c671f280728d474a191b3b6c24d3c578741d995af73b9d8d4929d28792',
}
ABSENT_FUNCTIONS = ('private.plan_employee_removal_reporting_splice(uuid)','private.apply_employee_removal_reporting_splice(uuid,uuid)','public.preflight_employee_removal_reporting_splice(uuid,bigint,bigint,date,text)')
CUSTODY = {}
INPUTS = {}
HEAD = None
ENTERED_WRITE = False
EXPECTED_QUERY = None
IDENTITY = None
DISPATCH = None


def require(condition, message):
    if not condition:
        raise SystemExit(message)


def source_snapshot(path, private=False):
    require(path.is_absolute() and not any(p.is_symlink() for p in (path,*path.parents)), 'Owned regular non-symlink source required')
    fd=os.open(str(path),os.O_RDONLY|os.O_NOFOLLOW)
    with os.fdopen(fd,'rb') as handle:
        before=os.fstat(handle.fileno())
        require(stat.S_ISREG(before.st_mode) and before.st_nlink==1 and before.st_uid==os.getuid() and not before.st_mode&0o022, 'Owned single-link source mode required')
        require(not private or stat.S_IMODE(before.st_mode)==0o600, 'Private retained input mode required')
        raw=handle.read()
        after=os.fstat(handle.fileno())
    fields=('st_dev','st_ino','st_mode','st_nlink','st_uid','st_size','st_mtime_ns','st_ctime_ns')
    require(all(getattr(before,k)==getattr(after,k)==getattr(os.stat(path,follow_symlinks=False),k) for k in fields), 'Source custody changed')
    return raw


TRANSPORT_RAW=source_snapshot(TRANSPORT)
require(hashlib.sha256(TRANSPORT_RAW).hexdigest()==PINS[str(TRANSPORT.relative_to(ROOT))], 'Reviewed transport differs')
SPEC=importlib.util.spec_from_file_location('day_one_splice_transport',TRANSPORT)
require(SPEC is not None, 'Missing measured transport specification')
SHARED=importlib.util.module_from_spec(SPEC)
exec(compile(TRANSPORT_RAW,str(TRANSPORT),'exec'),SHARED.__dict__)
literal,api,query=SHARED.literal,SHARED.api,SHARED.query


def dependency(path):
    require(path in CUSTODY and source_snapshot(path)==CUSTODY[path], 'Committed measured dependency required')
    return CUSTODY[path].decode('utf-8')


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def transaction_body(source):
    require(source.startswith('begin;\n') and source.endswith('\ncommit;\n'), 'Unsupported outer transaction boundaries')
    return source[len('begin;\n'):-len('commit;\n')]


def candidate(source_sha):
    require(re.fullmatch('[0-9a-f]{64}', source_sha or '') is not None, 'Explicit reviewed source SHA required')
    raw = source_snapshot(MIGRATION)
    require(sha(raw) == source_sha, 'Reviewed source bytes differ')
    source = raw.decode('utf-8')
    transaction_body(source)
    section = source.split('insert into day_one_splice_function_spec values\n', 1)[1].split('\ndo $day_one_splice_predecessor$', 1)[0]
    require(section == '(' + ','.join(literal(v) for v in (SIGNATURE, BEFORE_SHA, AFTER_SHA)) + ');', 'Exact singleton function delta required')
    return source


def source_function(source, name):
    start = "create function pg_temp." + name + "() returns jsonb language sql stable set search_path='' as $$\n"
    require(source.count(start) == 1, 'Unsupported exact core guard: ' + name)
    body = source.split(start, 1)[1].split('\n$$;', 1)[0]
    require(body.startswith('select ') and body.endswith(';'), 'Unsupported core expression: ' + name)
    if name=='day_one_splice_data':
        require(len(re.findall(r"select '(?:private|public)\.[^']+' name",body))==98, 'Exact 98-table data protection required')
    return body[:-1]


def published_expression():
    exact=[]
    for version,name in (('20261013120000','annual_continuous_accrual'),('20261013170000','subscription_review_tasks'),(PREDECESSOR_VERSION,PREDECESSOR_NAME)):
        raw=dependency(MIGRATION.parent/(version+'_'+name+'.sql'))
        exact.append("coalesce((select name="+literal(name)+" and array_dims(statements)='[1:1]' and cardinality(statements)=1 and statements=ARRAY["+literal(raw)+"]::text[] from supabase_migrations.schema_migrations where version="+literal(version)+"),false)")
    annual=dependency(MIGRATION.parent/'20261013120000_annual_continuous_accrual.sql')
    section=annual.split('insert into annual_continuous_function_spec(signature,before_sha256,after_sha256) values\n',1)[1].split('do $annual_continuous_functions$',1)[0]
    rows=re.findall(r"\('([^']+)',(?:null|'[0-9a-f]{64}'),'([0-9a-f]{64})'",section)
    require(len(rows)==len(dict(rows))==13, 'Exact annual definition map required')
    subscription=dependency(MIGRATION.parent/'20261013170000_subscription_review_tasks.sql')
    section=subscription.split('insert into subscription_review_function_spec values\n',1)[1].split('do $subscription_review_before$',1)[0]
    subs=re.findall(r"\('([^']+)',(?:true|false),(?:null|'[0-9a-f]{64}'),'([0-9a-f]{64})'",section)
    require(len(subs)==len(dict(subs))==5, 'Exact subscription definition map required')
    rows+=subs+[('private.enforce_leave_request_employment_policy()','129ff4a64cf0d48c021424e2f95562cee499b9c2baad32586885e6c29f03d4dc')]
    exact += ["coalesce(encode(extensions.digest(pg_get_functiondef(to_regprocedure("+literal(sig)+")),'sha256'),'hex')="+literal(pin)+",false)" for sig,pin in rows]
    exact += ["not exists(select 1 from supabase_migrations.schema_migrations where version="+literal(v)+")" for v in ORIGINAL_VERSIONS]
    exact += ["coalesce(encode(extensions.digest(pg_get_functiondef(to_regprocedure("+literal(sig)+")),'sha256'),'hex')="+literal(pin)+",false)" for sig,pin in INITIAL_FUNCTIONS.items()]
    exact += ["to_regprocedure("+literal(sig)+") is null" for sig in ABSENT_FUNCTIONS]
    return '('+' and '.join(exact)+')'


def state_expression(source):
    data=source_function(source,'day_one_splice_data')
    security=source_function(source,'day_one_splice_security')
    predecessor=dependency(PREDECESSOR)
    return f"""jsonb_build_object(
 'major',current_setting('server_version_num')::integer/10000,
 'dataHash',encode(extensions.digest(({data})::text,'sha256'),'hex'),
 'securityHash',encode(extensions.digest(({security})::text,'sha256'),'hex'),
 'receiptHash',(select encode(extensions.digest(coalesce(jsonb_agg(to_jsonb(r) order by id),'[]')::text,'sha256'),'hex') from private.confirmed_test_identity_purges r),
 'purgeHash',private.confirmed_test_purge_schema_hash(),
 'purgeMatches',(select count(*)=1 and bool_and(singleton and schema_hash=private.confirmed_test_purge_schema_hash()) from private.confirmed_test_purge_schema),
 'collectorSha256',encode(extensions.digest(pg_get_functiondef('private.confirmed_test_purge_schema_hash()'::regprocedure),'sha256'),'hex'),
 'predecessorExact',coalesce((select name={literal(PREDECESSOR_NAME)} and array_dims(statements)='[1:1]' and cardinality(statements)=1 and statements=ARRAY[{literal(predecessor)}]::text[] from supabase_migrations.schema_migrations where version={literal(PREDECESSOR_VERSION)}),false),
 'publishedAndInitialExact',{published_expression()},
 'targetExact',coalesce((select name={literal(NAME)} and array_dims(statements)='[1:1]' and cardinality(statements)=1 and statements=ARRAY[{literal(source)}]::text[] from supabase_migrations.schema_migrations where version={literal(VERSION)}),false),
 'functionSha256',encode(extensions.digest(pg_get_functiondef({literal(SIGNATURE)}::regprocedure),'sha256'),'hex'),
 'functionMetadata',(select (to_jsonb(p)-array['prosrc','prosqlbody','proargdefaults'])||jsonb_build_object('parameter_defaults',pg_get_expr(p.proargdefaults,0)) from pg_proc p where oid={literal(SIGNATURE)}::regprocedure),
 'functionPortableExact',(select pg_get_userbyid(p.proowner)='postgres' and p.proacl::text='{{postgres=X/postgres}}' and p.prosecdef and p.proconfig=ARRAY['search_path=""']::text[] from pg_proc p where oid={literal(SIGNATURE)}::regprocedure),
 'historicalLedgerHash',(select encode(extensions.digest(coalesce(jsonb_agg(to_jsonb(m) order by m.version),'[]')::text,'sha256'),'hex') from supabase_migrations.schema_migrations m where m.version<>{literal(VERSION)}),
 'ledger',(select coalesce(jsonb_agg(jsonb_build_object('version',m.version,'name',m.name,'dimensions',array_dims(m.statements),'cardinality',cardinality(m.statements),'sourceSha256',encode(extensions.digest(coalesce(m.statements::text,'<NULL>'),'sha256'),'hex')) order by m.version),'[]') from supabase_migrations.schema_migrations m))"""


def ledger_bound():
    return """do $day_one_splice_ledger_bound$ begin
 if (select count(*) from supabase_migrations.schema_migrations)>512
 or (select coalesce(sum(octet_length(statements::text)),0) from supabase_migrations.schema_migrations)>16777216 then
 raise exception 'Unsupported bounded migration ledger' using errcode='55000'; end if;
end $day_one_splice_ledger_bound$;"""


def read_state(source):
    result = port(query, "begin read only; set local search_path=''; set local lock_timeout='3s'; set local statement_timeout='30s';\n" + ledger_bound() + '\nselect ' + state_expression(source) + ' as state; rollback;')
    require(isinstance(result, list) and len(result) == 1 and set(result[0]) == {'state'} and isinstance(result[0]['state'], dict), 'Invalid bounded read-only state response')
    return result[0]['state']


def validate_before(before, source):
    require(isinstance(before, dict) and before.get('major') in (16, 17) and before.get('purgeMatches') is True and before.get('predecessorExact') is True and before.get('publishedAndInitialExact') is True and before.get('functionPortableExact') is True, 'Exact supported predecessor required')
    require(before.get('collectorSha256') == COLLECTOR_SHA and before.get('functionSha256') == BEFORE_SHA, 'Reviewed predecessor definitions differ')
    for field in ('dataHash', 'securityHash', 'receiptHash', 'purgeHash', 'historicalLedgerHash'):
        require(isinstance(before.get(field), str) and re.fullmatch('[0-9a-f]{64}', before[field]), 'Invalid predecessor hash: ' + field)
    ledger = before.get('ledger')
    require(isinstance(ledger, list) and 0 < len(ledger) <= 512, 'Unsupported bounded raw ledger')
    require(all(isinstance(row, dict) and set(row) == {'version', 'name', 'dimensions', 'cardinality', 'sourceSha256'} and isinstance(row['version'], str) and re.fullmatch('[0-9]{14}', row['version']) and isinstance(row['sourceSha256'], str) and re.fullmatch('[0-9a-f]{64}', row['sourceSha256']) for row in ledger), 'Unsupported exact raw ledger')
    for row in ledger:
        require(isinstance(row['name'],str), 'Unsupported raw ledger name')
        count,dimensions=row['cardinality'],row['dimensions']
        if count is None or type(count) is int and count==0:
            require(dimensions is None, 'Unsupported empty/NULL raw ledger array shape')
        else:
            require(type(count) is int and 1<=count<=16777216 and isinstance(dimensions,str), 'Unsupported finite raw ledger array shape')
            bounds=re.fullmatch(r'\[(-?[0-9]+):(-?[0-9]+)\]',dimensions)
            require(bounds is not None, 'Unsupported multidimensional raw ledger array')
            lower,upper=map(int,bounds.groups())
            require(-2147483648<=lower<=upper<=2147483647 and upper-lower+1==count, 'Raw ledger array bounds/cardinality differ')
    versions = [row['version'] for row in ledger]
    require(len(versions) == len(set(versions)) and versions == sorted(versions) and max(versions) == PREDECESSOR_VERSION and before.get('targetExact') is False, 'Latest predecessor or absent target differs')
    require(isinstance(before.get('functionMetadata'), dict), 'Missing exact function authority')
    require(candidate(sha(source.encode()))==source,'Exact measured phase source required')


def expected_ledger_row(source):
    return "jsonb_build_object('version'," + literal(VERSION) + ",'name'," + literal(NAME) + ",'dimensions','[1:1]','cardinality',1,'sourceSha256',encode(extensions.digest((ARRAY[" + literal(source) + "])::text,'sha256'),'hex'))"


def transaction(source, before):
    validate_before(before, source)
    expression = state_expression(source)
    expected = literal(json.dumps(before, separators=(',', ':'), allow_nan=False)) + '::jsonb'
    final = f"""set constraints all immediate;
select pg_temp.day_one_splice_assert_delta();
do $day_one_splice_release_final$ declare actual jsonb; expected jsonb:={expected}; begin
 actual:={expression};
 if (actual-array['purgeHash','purgeMatches','targetExact','functionSha256','ledger']) is distinct from (expected-array['purgeHash','purgeMatches','targetExact','functionSha256','ledger'])
 or pg_temp.day_one_splice_security() is distinct from (select value from pg_temp.day_one_splice_security_before)
 or actual->>'purgeHash' is distinct from (select value from pg_temp.day_one_splice_catalog_after)
 or actual->'purgeMatches' is distinct from 'true'::jsonb
 or actual->'targetExact' is distinct from 'true'::jsonb
 or actual->>'functionSha256' is distinct from {literal(AFTER_SHA)}
 or actual->'ledger' is distinct from (expected->'ledger')||jsonb_build_array({expected_ledger_row(source)}) then
 raise exception 'Day1 splice release final state differs' using errcode='55000'; end if;
end $day_one_splice_release_final$;
notify pgrst,'reload schema';
select value as "dayOneSpliceResultingCatalogSha256" from pg_temp.day_one_splice_catalog_after;"""
    insert = 'insert into supabase_migrations.schema_migrations(version,name,statements) values(' + ','.join([literal(VERSION), literal(NAME), 'ARRAY[' + literal(source) + ']::text[]']) + ');'
    return "begin;\nset local search_path=''; set local lock_timeout='3s'; set local statement_timeout='75s';\n" + \
        'lock table supabase_migrations.schema_migrations,private.confirmed_test_identity_purges,private.confirmed_test_purge_schema in access exclusive mode nowait;\n' + \
        ledger_bound() + '\n' + 'do $day_one_splice_release_before$ begin if (' + expression + ') is distinct from ' + expected + \
        " then raise exception 'Day1 splice release predecessor changed' using errcode='55000'; end if; end $day_one_splice_release_before$;\n" + \
        transaction_body(source) + '\n' + insert + '\n' + final + '\ncommit;'


def resulting_catalog(result):
    require(isinstance(result, list) and len(result) == 1 and isinstance(result[0], dict) and set(result[0]) == {'dayOneSpliceResultingCatalogSha256'}, 'Missing exact COMMIT attestation; reconcile read-only and do not retry')
    value = result[0]['dayOneSpliceResultingCatalogSha256']
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


def git(*args):
    allowed={'GIT_CONFIG_NOSYSTEM':'1','GIT_CONFIG_GLOBAL':os.devnull}
    require(all(not key.startswith('GIT_') or allowed.get(key)==value for key,value in os.environ.items()), 'Inherited Git override prohibited')
    environment={key:value for key,value in os.environ.items() if not key.startswith('GIT_')}
    environment.update(allowed,GIT_NO_REPLACE_OBJECTS='1')
    return subprocess.check_output(['git','-c','core.fsmonitor=false','-c','core.hooksPath='+os.devnull,*args],cwd=ROOT,env=environment)


def clean_git():
    require(Path.cwd().resolve()==ROOT and git('rev-parse','HEAD').decode().strip()==HEAD, 'Reviewed root/HEAD differs')
    require(not git('status','--porcelain').strip(), 'Release tree must be clean')
    require(git('remote','get-url','origin').decode().strip()=='https://github.com/mobilityaccessmodifications/mam-team-management-system.git', 'Wrong MAM Git remote')
    require(git('show','-s','--format=%an <%ae>','HEAD').decode().strip()=='mobilityaccessmodifications <310802599+mobilityaccessmodifications@users.noreply.github.com>', 'Wrong MAM source author')
    require(git('config','--local','--get','user.name').decode().strip()=='mobilityaccessmodifications' and git('config','--local','--get','user.email').decode().strip()=='310802599+mobilityaccessmodifications@users.noreply.github.com', 'Wrong repository-local MAM identity')


def check_inputs():
    clean_git()
    require(all(source_snapshot(path)==raw and git('show',HEAD+':'+str(path.relative_to(ROOT)))==raw for path,raw in CUSTODY.items()), 'Reviewed committed closure/custody differs')
    require(all(source_snapshot(path,private=True)==raw for path,raw in INPUTS.items()), 'Reviewed phase input custody changed')


def clean_source(head, source_sha, helper_sha):
    global HEAD
    require(re.fullmatch('[0-9a-f]{40}',head or ''), 'Full reviewed HEAD required')
    HEAD=head
    CUSTODY.clear(); INPUTS.clear()
    clean_git()
    paths={ROOT/path:pin for path,pin in PINS.items()}
    paths.update({MIGRATION:source_sha,Path(__file__).resolve():helper_sha})
    for path,expected in paths.items():
        require(re.fullmatch('[0-9a-f]{64}',expected or ''), 'Explicit reviewed source/helper SHA required')
        raw=source_snapshot(path)
        require(sha(raw)==expected and git('show',head+':'+str(path.relative_to(ROOT)))==raw, 'Reviewed committed bytes differ')
        CUSTODY[path]=raw
    require(CUSTODY[TRANSPORT]==TRANSPORT_RAW, 'Measured transport custody differs')
    check_inputs()


def port(function,value,writing=False):
    global ENTERED_WRITE
    check_inputs()
    if writing:
        require(value==EXPECTED_QUERY and load_json(source_snapshot(DISPATCH,private=True))==IDENTITY, 'Exact public query/spent journal required before dispatch')
        ENTERED_WRITE=True
    pending=None
    try:
        return function(value)
    except BaseException as error:
        pending=error
        raise
    finally:
        try:
            check_inputs()
        except BaseException:
            print(json.dumps({'sourceHold':True,'enteredWrite':ENTERED_WRITE,'retryAllowed':False}),flush=True)
            if pending is None:
                raise


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
    require(path.is_absolute() and ROOT not in path.parents and not any(p.is_symlink() for p in (path,*path.parents)), 'Private external artifact path required')
    require(path.parent.is_dir() and path.parent.stat().st_uid==os.getuid() and stat.S_IMODE(path.parent.stat().st_mode)==0o700, 'Owned existing private artifact directory required')
    descriptor=os.open(str(path),os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
    with os.fdopen(descriptor,'w') as handle:
        handle.write(json.dumps(value,sort_keys=True,indent=2,allow_nan=False)+'\n')
        handle.flush(); os.fsync(handle.fileno())
    descriptor=os.open(str(path.parent),os.O_RDONLY|os.O_NOFOLLOW)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
    INPUTS[path]=source_snapshot(path,private=True)
    check_inputs()


def main(argv=None):
    global ENTERED_WRITE, EXPECTED_QUERY, IDENTITY, DISPATCH
    ENTERED_WRITE=False; EXPECTED_QUERY=None; IDENTITY=None; DISPATCH=None
    parser = argparse.ArgumentParser()
    parser.add_argument('action', choices=('prepare', 'inspect', 'apply'))
    parser.add_argument('--source-sha', required=True)
    parser.add_argument('--snapshot', required=True, type=Path)
    parser.add_argument('--snapshot-sha')
    parser.add_argument('--head',required=True)
    parser.add_argument('--helper-sha',required=True)
    parser.add_argument('--attestation', type=Path)
    parser.add_argument('--attestation-sha')
    parser.add_argument('--dispatch', type=Path)
    args = parser.parse_args(argv)
    source = candidate(args.source_sha)
    clean_source(args.head, args.source_sha, args.helper_sha)
    before = None
    if args.action != 'prepare':
        raw=source_snapshot(args.snapshot,private=True)
        require(re.fullmatch('[0-9a-f]{64}', args.snapshot_sha or '') and sha(raw) == args.snapshot_sha, 'Explicit reviewed predecessor snapshot differs')
        INPUTS[args.snapshot]=raw
        before=load_json(raw)
        validate_before(before, source)
        EXPECTED_QUERY=transaction(source,before)
        IDENTITY={'project':PROJECT,'organization':ORGANISATION,'version':VERSION,'head':args.head,'sourceSha256':args.source_sha,'snapshotSha256':args.snapshot_sha,'transactionSha256':sha(EXPECTED_QUERY.encode())}
        DISPATCH=args.dispatch
        if args.dispatch is not None and args.dispatch.exists():
            raw=source_snapshot(args.dispatch,private=True)
            INPUTS[args.dispatch]=raw
            require(load_json(raw)==IDENTITY, 'Spent dispatch public query identity differs; reconcile read-only')
        if args.attestation_sha is not None:
            require(args.dispatch is not None and args.dispatch.exists() and args.attestation is not None, 'Exact spent dispatch/attestation required')
            raw=source_snapshot(args.attestation,private=True)
            require(re.fullmatch('[0-9a-f]{64}',args.attestation_sha) and sha(raw)==args.attestation_sha,'Reviewed COMMIT attestation bytes differ')
            receipt=load_json(raw)
            require(isinstance(receipt,dict),'Invalid retained COMMIT attestation')
            catalog=resulting_catalog([{'dayOneSpliceResultingCatalogSha256':receipt.get('resultingCatalogSha256')}])
            require(receipt==dict(IDENTITY,resultingCatalogSha256=catalog),'COMMIT attestation public query/target differs')
            INPUTS[args.attestation]=raw
    else:
        require(not args.snapshot.exists() and args.snapshot_sha is None and args.attestation is None and args.dispatch is None, 'Independent new phase capture required')
    target = port(api,'')
    require(isinstance(target, dict) and target.get('id') == PROJECT and target.get('organization_id') == ORGANISATION, 'Wrong MAM project/organization')
    actual = read_state(source)
    if args.action == 'prepare':
        validate_before(actual, source)
        retain(args.snapshot, actual)
        print(json.dumps({'readOnly': True, 'targetVerified': True, 'snapshotSha256': sha(source_snapshot(args.snapshot)), 'version': VERSION}))
        return
    release=EXPECTED_QUERY
    identity=IDENTITY
    if any(row['version'] == VERSION for row in actual['ledger']):
        require(args.attestation is not None and re.fullmatch('[0-9a-f]{64}', args.attestation_sha or ''), 'Reviewed exact COMMIT attestation required; do not retry')
        require(args.attestation in INPUTS,'Pinned reviewed COMMIT attestation required')
        raw=INPUTS[args.attestation]
        receipt = load_json(raw)
        catalog = resulting_catalog([{'dayOneSpliceResultingCatalogSha256': receipt.get('resultingCatalogSha256')}])
        require(receipt == dict(identity, resultingCatalogSha256=catalog), 'COMMIT attestation target/source differs')
        verify_after(actual, before, source, catalog)
        check_inputs()
        print(json.dumps({'readOnly': True, 'recorded': True, 'readbackVerified': True, 'version': VERSION}))
        return
    validate_before(actual, source)
    require(actual == before, 'Observed predecessor changed; do not adopt or retry')
    if args.action == 'inspect':
        check_inputs()
        print(json.dumps({'readOnly': True, 'targetAbsent': True, 'predecessorMatches': True, 'version': VERSION}))
        return
    require(args.attestation is not None and not args.attestation.exists() and args.attestation_sha is None, 'New retained COMMIT attestation path required')
    require(args.dispatch is not None and not args.dispatch.exists() and args.dispatch.resolve() not in (args.snapshot.resolve(), args.attestation.resolve()), 'Unspent exclusive dispatch path required; never retry an unknown write')
    retain(args.dispatch, identity)
    print(json.dumps({'operation': 'one exact transaction', 'querySha256': identity['transactionSha256'], 'version': VERSION}), flush=True)
    try:
        catalog = resulting_catalog(port(query,release,writing=True))
    except (Exception, SystemExit):
        try:
            reconciled = read_state(source)
            print(json.dumps({'readOnlyReconciliation': True, 'targetRecorded': any(row['version'] == VERSION for row in reconciled['ledger']), 'dispatchSpent': True}), flush=True)
        except (Exception, SystemExit):
            print(json.dumps({'readOnlyReconciliation': False, 'dispatchSpent': True}), flush=True)
        raise SystemExit('Write outcome unverified; retain dispatch and reconcile read-only, never retry') from None
    retain(args.attestation, dict(identity, resultingCatalogSha256=catalog))
    require(transaction(source,before)==release,'COMMIT public query identity differs')
    verify_after(read_state(source), before, source, catalog)
    check_inputs()
    print(json.dumps({'committed': True, 'readbackVerified': True, 'writeCount': 1, 'retryCount': 0,
                      'attestationSha256': sha(source_snapshot(args.attestation)), 'resultingCatalogSha256': catalog, 'version': VERSION}))


if __name__ == '__main__':
    main()
