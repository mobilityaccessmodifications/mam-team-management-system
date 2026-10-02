import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
PROJECT = 'xtwlrjqbusadghavchqm'
ORG = 'fwlmbmospuwoaosffvmw'
BASE_HEAD = '827171257eccbd810de9e8c33bd7e587d519ac2c'
VERSION = '20261001150000'
NAME = 'payroll_closing_carryforward'
MIGRATION = ROOT / 'supabase/migrations' / (VERSION + '_' + NAME + '.sql')
PINS = ROOT / 'scripts/payroll-closing-release-pins.json'
BEFORE_FUNCTIONS = [
    'private.is_active_portal_account(uuid)', 'private.is_portal_account_admin()',
    'private.is_system_portal_account_admin()', 'private.approved_leave_hours_after(uuid,text[],date)',
    'private.calculate_employee_leave_accrual(uuid,date)', 'private.project_annual_leave_balance(uuid,date)',
    'private.leave_payroll_balance_sufficient(uuid)', 'public.get_leave_priority_workspace(uuid)',
    'public.set_employee_annual_leave_balance(uuid,numeric,date,boolean)',
    'public.set_employee_sick_leave_balance(uuid,numeric,date)',
    'public.review_employee_leave_accrual_day(uuid,date,numeric,numeric,numeric,numeric,text)',
    'public.stage_payroll_balance_import(uuid,text,jsonb,jsonb)',
    'public.commit_payroll_balance_import(uuid,bigint)', 'private.enforce_banked_annual_leave_request()',
    'private.leave_accrual_request_fingerprint(uuid,date)', 'public.preview_annual_leave_balance(uuid,date,uuid)',
    'public.stage_payroll_balance_import_before_comparison(uuid,text,jsonb,jsonb)',
    'public.commit_payroll_balance_import_before_comparison(uuid,bigint)',
    'private.reconcile_payroll_balance_import_batch(uuid)', 'private.payroll_balance_import_batch_projection(uuid)',
    'private.has_payroll_balance_import_access()', 'private.has_payroll_balance_import_access_for(uuid)',
    'private.payroll_comparison_only(uuid)', 'public.can_import_payroll_balances()',
    'public.can_import_payroll_balances_for_preview(uuid)', 'public.decide_leave_with_balance(uuid,text,text)',
    'private.confirmed_test_purge_schema_hash()',
    'private.confirmed_test_purge_census(uuid,uuid)',
    'public.get_confirmed_test_identity_purge(uuid)',
    'private.reject_retired_test_identity_reference()',
    'private.confirmed_test_has_reference(jsonb,uuid[])',
    'public.complete_confirmed_test_identity_purge(uuid)',
    'private.confirmed_test_retained_leave_receipt(jsonb)',
    'public.claim_confirmed_test_identity_auth_delete(uuid)',
    'public.preview_confirmed_test_identity_purge(uuid,uuid,text,text,text,bigint,bigint)',
    'public.prepare_confirmed_test_identity_purge(uuid,uuid,text,text,text,bigint,bigint,text,boolean,boolean)',
]
BEFORE_TABLES = [
    'public.profiles', 'private.portal_account_admins', 'public.internal_org_people',
    'private.employee_directory_details', 'public.leave_requests', 'private.leave_accrual_policies',
    'private.leave_accrual_day_reviews', 'private.employee_annual_leave_balances',
    'private.employee_sick_leave_balances', 'private.annual_leave_balance_history',
    'private.sick_leave_balance_history', 'private.payroll_balance_imports',
    'private.payroll_balance_import_grants', 'private.payroll_comparison_only_importers',
    'private.leave_balance_approvals',
    'private.portal_account_test_sessions',
    'private.confirmed_test_purge_schema', 'private.confirmed_test_identity_purges',
]
NEW_TABLES = ['private.payroll_closing_receipts', 'private.payroll_carryforward_events', 'private.payroll_closing_write_claims']


def require(condition, message):
    if not condition:
        raise ValueError(message)


def literal(value):
    return "'" + value.replace("'", "''") + "'"


def digest(value):
    return hashlib.sha256(value.encode()).hexdigest()


def transaction_body(sql):
    require(sql.startswith('begin;\n') and sql.rstrip().endswith('\ncommit;'), 'Unexpected outer migration transaction')
    return sql[len('begin;\n'):sql.rstrip().rindex('\ncommit;')].strip()


def load_candidate(reviewed_sha):
    require(bool(re.fullmatch('[0-9a-f]{64}', reviewed_sha or '')), 'Explicit reviewed migration SHA256 required')
    sql = MIGRATION.read_bytes().decode('utf-8')
    require(digest(sql) == reviewed_sha, 'Reviewed migration bytes differ')
    transaction_body(sql)
    return sql


def full_security_query(sql=None):
    reviewed = 'c0662cadbc822ef759b9088b1fd39b777cbab09bb27a2bda024b4cd033de6143'
    if sql is None:
        pins = json.loads(PINS.read_bytes())
        require(pins['migrationSha256'] == reviewed, 'Unreviewed full security metadata source')
        sql = load_candidate(reviewed)
    require(digest(sql) == reviewed, 'Unreviewed full security metadata source')
    start, end = '      (select jsonb_build_object(\n', ' as extra_catalog;'
    require(sql.count(start) == 1 and sql.count(end) == 1, 'Unsupported reviewed full security metadata shape')
    expression = '(select jsonb_build_object(\n' + sql.split(start,1)[1].split(end,1)[0]
    require(sql.count(expression) == 3, 'Unsupported reviewed full security metadata shape')
    return 'SELECT ' + expression + ' AS metadata;'


def validate_core_predecessor_pins(sql, before):
    block = sql.split('do $payroll_purge_before$',1)
    require(len(block)==2 and 'end $payroll_purge_before$;' in block[1], 'Unsupported reviewed purge predecessor guard')
    pins = re.findall(r"\('([^']+)','([0-9a-f]{64})'\)",block[1].split('end $payroll_purge_before$;',1)[0])
    signatures = {s for s in BEFORE_FUNCTIONS if 'confirmed_test' in s or 'retired_test' in s} | {
        'private.approved_leave_hours_after(uuid,text[],date)', 'private.leave_payroll_balance_sufficient(uuid)',
        'private.project_annual_leave_balance(uuid,date)', 'public.get_leave_priority_workspace(uuid)',
    }
    require(len(pins)==14 and {s for s,_ in pins}==signatures, 'Unsupported reviewed core predecessor pin set')
    require(all(before['functions'].get(s,{}).get('sha256')==sha for s,sha in pins), 'Core predecessor definition pin drift; stop for review')


def catalog_query(functions=None, tables=None):
    functions = BEFORE_FUNCTIONS if functions is None else functions
    tables = BEFORE_TABLES if tables is None else tables
    fs = ','.join(literal(x) for x in functions)
    ts = ','.join(literal(x) for x in tables)
    return f"""select jsonb_build_object(
      'purgeGuard',jsonb_build_object('rows',(select count(*) from private.confirmed_test_purge_schema),
        'matches',coalesce((select bool_and(singleton and schema_hash=private.confirmed_test_purge_schema_hash()) from private.confirmed_test_purge_schema),false)),
      'roles',(select jsonb_agg(jsonb_build_object('name',rolname,'superuser',rolsuper,'bypassRls',rolbypassrls,
        'inherit',rolinherit,'createRole',rolcreaterole,'createDb',rolcreatedb,'replication',rolreplication) order by rolname)
        from pg_roles where rolname in ('postgres','anon','authenticated','service_role')),
      'schemas',(select jsonb_agg(jsonb_build_object('name',nspname,'owner',pg_get_userbyid(nspowner),'acl',nspacl::text) order by nspname)
        from pg_namespace where nspname in ('private','public')),
      'defaultAcl',(select coalesce(jsonb_agg(jsonb_build_object('owner',pg_get_userbyid(defaclrole),'schema',n.nspname,
        'kind',defaclobjtype,'acl',defaclacl::text) order by defaclrole,n.nspname,defaclobjtype),'[]')
        from pg_default_acl d left join pg_namespace n on n.oid=d.defaclnamespace where defaclrole=(select oid from pg_roles where rolname=current_user)),
      'ledger',(select coalesce(jsonb_agg(jsonb_build_object('version',version,'name',name,
        'sourceHash',encode(sha256(convert_to(coalesce(array_to_json(statements)::text,'<NULL>'),'UTF8')),'hex')) order by version),'[]')
        from supabase_migrations.schema_migrations),
      'functions',(select jsonb_object_agg(signature,jsonb_build_object('sha256',encode(sha256(convert_to(pg_get_functiondef(p.oid),'UTF8')),'hex'),
        'owner',pg_get_userbyid(p.proowner),'acl',p.proacl::text,'securityDefiner',p.prosecdef,'config',p.proconfig))
        from unnest(array[{fs}]::text[]) signature left join pg_proc p on p.oid=to_regprocedure(signature)),
      'tables',(select jsonb_object_agg(relation,jsonb_build_object('owner',pg_get_userbyid(c.relowner),'acl',c.relacl::text,
        'rls',c.relrowsecurity,'forceRls',c.relforcerowsecurity,
        'sequenceAcl',(select coalesce(jsonb_agg(jsonb_build_object('name',s.oid::regclass::text,'owner',pg_get_userbyid(s.relowner),'acl',s.relacl::text) order by s.relname),'[]')
          from pg_depend d join pg_class s on s.oid=d.objid and s.relkind='S' where d.refobjid=c.oid and d.deptype in ('a','i')),
        'columns',(select coalesce(jsonb_agg(jsonb_build_object('name',a.attname,'type',format_type(a.atttypid,a.atttypmod),'notNull',a.attnotnull,
          'identity',a.attidentity,'columnAcl',a.attacl::text,'default',pg_get_expr(d.adbin,d.adrelid)) order by a.attnum),'[]') from pg_attribute a
          left join pg_attrdef d on d.adrelid=a.attrelid and d.adnum=a.attnum where a.attrelid=c.oid and a.attnum>0 and not a.attisdropped),
        'constraints',(select coalesce(jsonb_agg(jsonb_build_object('name',conname,'type',contype,'definition',pg_get_constraintdef(oid)) order by conname),'[]') from pg_constraint where conrelid=c.oid),
        'policies',(select coalesce(jsonb_agg(jsonb_build_object('name',polname,'permissive',polpermissive,'command',polcmd,
          'roles',array(select rolname from pg_roles where oid=any(polroles) order by rolname),'using',pg_get_expr(polqual,polrelid),
          'check',pg_get_expr(polwithcheck,polrelid)) order by polname),'[]') from pg_policy where polrelid=c.oid),
        'triggers',(select coalesce(jsonb_agg(jsonb_build_object('name',t.tgname,'enabled',t.tgenabled,'definition',pg_get_triggerdef(t.oid),
          'functionHash',encode(sha256(convert_to(pg_get_functiondef(t.tgfoid),'UTF8')),'hex')) order by t.tgname),'[]')
          from pg_trigger t where t.tgrelid=c.oid and not t.tgisinternal)))
        from unnest(array[{ts}]::text[]) relation left join pg_class c on c.oid=to_regclass(relation))) as catalog;"""


def validate_baseline(actual, expected):
    require(actual == expected, 'Predecessor ledger/function/ACL/FK/RLS/trigger drift; stop for review')
    versions = [row['version'] for row in actual['ledger']]
    require(versions and len(versions) == len(set(versions)) and max(versions) < VERSION, 'Migration version is not strictly newer than the validated ledger')
    require(all(re.fullmatch('[0-9]{14}', v) for v in versions), 'Unsupported ledger version')


def guard(expected, functions, tables):
    expression = catalog_query(functions, tables).removeprefix('select ').removesuffix(' as catalog;')
    return "do $closing_release$ begin if (select " + expression + ') is distinct from ' + literal(json.dumps(expected, separators=(',', ':'))) + "::jsonb then raise exception 'Payroll closing release catalog drift' using errcode='55000'; end if; end $closing_release$;"


def validate_local_predecessors(expected):
    actual = []
    for path in sorted(MIGRATION.parent.glob('*.sql')):
        if path == MIGRATION:
            continue
        version, name = path.stem.split('_', 1)
        require(bool(re.fullmatch('[0-9]{14}', version)) and version < VERSION, 'Unsupported local predecessor version')
        actual.append(dict(file=path.name, version=version, name=name, sha256=hashlib.sha256(path.read_bytes()).hexdigest()))
    require(actual and actual == expected, 'Local predecessor source/catalog drift; stop for review')


def build_transaction(sql, before, after):
    validate_baseline(before, before)
    validate_core_predecessor_pins(sql, before)
    require(after['ledger'] == before['ledger'] + [{'version': VERSION, 'name': NAME, 'sourceHash': digest(json.dumps([sql], ensure_ascii=False, separators=(',', ':')))}], 'Target ledger pin does not match candidate bytes')
    locks = ','.join(['supabase_migrations.schema_migrations'] + list(before['tables']))
    insert = 'insert into supabase_migrations.schema_migrations(version,name,statements) values(' + ','.join([literal(VERSION), literal(NAME), 'ARRAY[' + literal(sql) + ']']) + ');'
    receipts = "(select encode(sha256(convert_to(coalesce(jsonb_agg(to_jsonb(p) order by id),'[]')::text,'UTF8')),'hex') from private.confirmed_test_identity_purges p)"
    security = full_security_query(sql).removeprefix('SELECT ').removesuffix(' AS metadata;')
    capture = 'create temporary table closing_release_purge_receipts_hash on commit drop as select ' + receipts + ' as receipts_hash,NULL::text as closing_release_purge_catalog_hash;'
    transitioned = 'update pg_temp.closing_release_purge_receipts_hash set closing_release_purge_catalog_hash=private.confirmed_test_purge_schema_hash();'
    recheck = "do $closing_release_purge$ begin if " + receipts + " is distinct from (select receipts_hash from pg_temp.closing_release_purge_receipts_hash) or private.confirmed_test_purge_schema_hash() is distinct from (select closing_release_purge_catalog_hash from pg_temp.closing_release_purge_receipts_hash) or " + security + " is distinct from (select extra_catalog from pg_temp.payroll_purge_transition) then raise exception 'Payroll closing release catalog drift: Purge receipt or post-transition catalog drift or complete security metadata drift' using errcode='55000'; end if; end $closing_release_purge$;"
    return "begin; set local search_path=''; set local lock_timeout='3s'; set local statement_timeout='75s';\nlock table " + locks + " in access exclusive mode nowait;\n" + guard(before, list(before['functions']), list(before['tables'])) + '\n' + capture + '\n' + transaction_body(sql) + '\n' + transitioned + '\n' + insert + '\nset constraints all immediate;\n' + guard(after, list(after['functions']), list(after['tables'])) + '\n' + recheck + "\nnotify pgrst,'reload schema';\ncommit;"


def api(path='', body=None):
    request = urllib.request.Request('https://api.supabase.com/v1/projects/' + PROJECT + path,
        headers={'Authorization': 'Bearer ' + os.environ['SUPABASE_ACCESS_TOKEN'], 'Content-Type': 'application/json', 'User-Agent': 'supabase-cli/2.54.11'},
        data=None if body is None else json.dumps(body).encode())
    with urllib.request.urlopen(request, timeout=90) as response:
        return json.load(response)


def query(sql):
    return api('/database/query', {'query': sql})


def read_catalog(expected):
    return query("begin read only; set local search_path='';\n" + catalog_query(list(expected['functions']), list(expected['tables'])) + '\nrollback;')[0]['catalog']


def main():
    require(len(sys.argv) >= 2 and sys.argv[1] in ('inspect', 'apply'), 'Use inspect or apply <reviewed-full-head> <migration-sha256> <pins-sha256>')
    target = api()
    require(target.get('id') == PROJECT and target.get('organization_id') == ORG, 'Wrong MAM organization/project')
    pins = json.loads(PINS.read_text())
    require(pins['version'] == VERSION and pins['project'] == PROJECT and pins['organization'] == ORG and pins['baseHead'] == BASE_HEAD, 'Wrong release pin target')
    before, after = pins['before'], pins['after']
    validate_core_predecessor_pins(load_candidate(pins['migrationSha256']), before)
    recorded = query('begin read only; select version from supabase_migrations.schema_migrations where version=' + literal(VERSION) + '; rollback;')
    current = read_catalog(after if recorded else before)
    if sys.argv[1] == 'inspect':
        require(len(sys.argv) == 2, 'Inspect takes no data or write arguments')
        require(current == (after if recorded else before), 'Live release pins differ; stop for review')
        print(json.dumps({'targetVerified': True, 'readOnly': True, 'recorded': bool(recorded), 'pinsMatch': True, 'version': VERSION}))
        return
    require(len(sys.argv) == 5 and re.fullmatch('[0-9a-f]{40}', sys.argv[2]), 'Full reviewed release HEAD required')
    require(Path.cwd().resolve() == ROOT.resolve(), 'Apply only from the approved repository root')
    require(subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip() == sys.argv[2], 'Reviewed HEAD differs')
    require(subprocess.run(['git', 'merge-base', '--is-ancestor', BASE_HEAD, sys.argv[2]], cwd=ROOT).returncode == 0, 'Release is not based on reviewed main')
    require(not subprocess.check_output(['git', 'status', '--porcelain'], cwd=ROOT, text=True).strip(), 'Release checkout must be clean and reviewed')
    require(re.fullmatch('[0-9a-f]{64}', sys.argv[4]) and hashlib.sha256(PINS.read_bytes()).hexdigest() == sys.argv[4], 'Reviewed pin manifest differs')
    sql = load_candidate(sys.argv[3])
    require(pins['migrationSha256'] == digest(sql), 'Candidate is not the pinned tested migration')
    validate_local_predecessors(pins['localPredecessors'])
    if recorded:
        require(current == after, 'Recorded release source or effective schema differs; never replay')
    else:
        validate_baseline(current, before)
        query(build_transaction(sql, before, after))
    require(read_catalog(after) == after, 'Release readback differs; do not retry the migration')
    print(json.dumps({'targetVerified': True, 'recorded': True, 'readbackVerified': True, 'version': VERSION, 'migrationSha256': digest(sql)}))


if __name__ == '__main__':
    try:
        main()
    except urllib.error.HTTPError as error:
        raise SystemExit('Management API HTTP ' + str(error.code) + '; operation is not automatically retried')
    except (ValueError, KeyError, OSError) as error:
        raise SystemExit(str(error) if isinstance(error, ValueError) else 'Release verification unavailable; no automatic retry')
