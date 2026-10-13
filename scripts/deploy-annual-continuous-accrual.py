import copy
import hashlib
import json
import os
from pathlib import Path
import re
import runpy
import subprocess
import sys
import urllib.error

ROOT = Path(__file__).resolve().parents[1]
PROJECT = 'xtwlrjqbusadghavchqm'
ORG = 'fwlmbmospuwoaosffvmw'
BASE_HEAD = '15c89c42eb94270edeedfbe531948b41bece91fd'
VERSION = '20261013120000'
NAME = 'annual_continuous_accrual'
MIGRATION = ROOT / 'supabase/migrations' / (VERSION + '_' + NAME + '.sql')
MIGRATION_SHA = 'b69aa9d06338ac30063df25ca73f286b9ae5fd62250a607b8f31721a4e165c37'
PINS = ROOT / 'scripts/annual-continuous-accrual-release-pins.json'
BASE_HELPER = ROOT / 'scripts/deploy-annual-source-bank.py'
BASE_HELPER_SHA = 'd9607a1866b207e8d40124f0895d3e1c96f4d7301336e3bcbe498c3b3641f1cf'
SCOPE = ROOT / 'scripts/annual-source-bank-release-pins.json'
SCOPE_SHA = '2c7a2c15e43113c555799c4fa2db7a955aa997a74d4d55bcde871f96d21605ce'
EXISTING = {
    'private.calculate_leave_entitlement(uuid,text,date)',
    'private.project_annual_leave_balance(uuid,date)',
    'public.refresh_employee_leave_accrual()',
    'private.leave_request_quantity(uuid,date,date,time,time,numeric)',
    'private.leave_payroll_day_hours(uuid,date)',
    'private.payroll_request_hours_after(uuid,date)',
    'private.payroll_request_unconsumed_hours(uuid,date,date)',
    'private.enforce_banked_annual_leave_request()',
    'private.approved_leave_hours_after(uuid,text[],date)',
}
NEW = {
    'private.annual_leave_retained_usage(uuid)',
    'private.annual_leave_accounting_day(uuid,date)',
    'private.capture_annual_leave_accounting(uuid,date,date,boolean)',
    'private.retain_completed_annual_leave_accounting()',
}


def require(condition, message):
    if not condition:
        raise ValueError(message)


def digest(value):
    return hashlib.sha256(value.encode('utf-8')).hexdigest()


def byte_digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def base_helper():
    require(byte_digest(BASE_HELPER) == BASE_HELPER_SHA, 'Reviewed source-bank helper changed')
    return runpy.run_path(str(BASE_HELPER))


def decode(raw):
    return base_helper()['decode'](raw)


def literal(value):
    return "'" + value.replace("'", "''") + "'"


def transaction_body(sql):
    return base_helper()['base_helper']()['transaction_body'](sql)


def function_specs(sql):
    first = sql.split('insert into annual_continuous_function_spec(signature,before_sha256,after_sha256) values\n', 1)
    require(len(first) == 2, 'Missing exact existing function scope')
    existing, rest = first[1].split('insert into annual_continuous_function_spec values\n', 1)
    added = rest.split('do $annual_continuous_functions$', 1)[0]
    specs = {}
    for block, is_new in [(existing, False), (added, True)]:
        lines = block.strip().splitlines()
        pattern = r"\('([^']+)',null,'([0-9a-f]{64})','((?:[^']|'')+)'::jsonb\)([,;])" if is_new else r"\('([^']+)','([0-9a-f]{64})','([0-9a-f]{64})'\)([,;])"
        for index, line in enumerate(lines):
            m = re.fullmatch(pattern, line)
            require(m is not None and m[4] == (';' if index == len(lines) - 1 else ','), 'Unsupported exact function specification')
            signature = m[1]
            require(signature not in specs, 'Duplicate function specification')
            specs[signature] = {'before': None if is_new else m[2], 'after': m[2] if is_new else m[3],
                                'metadata': decode(m[3].replace("''", "'")) if is_new else None}
    require(set(s for s, item in specs.items() if item['before'] is not None) == EXISTING and set(specs) == EXISTING | NEW, 'Unexpected migration function scope')
    return specs


def validate_migration(sql):
    require(digest(sql) == MIGRATION_SHA, 'Exact reviewed raw migration bytes required')
    transaction_body(sql)
    function_specs(sql)
    require(sql.count('create function pg_temp.annual_continuous_security()') == 1
            and sql.count('create temporary table annual_continuous_security_before ') == 1
            and sql.count('create function pg_temp.annual_continuous_assert_delta()') == 1,
            'Missing full security or final delta boundary')


def read_migration():
    sql = MIGRATION.read_bytes().decode('utf-8')
    validate_migration(sql)
    return sql


def scope(sql):
    require(byte_digest(SCOPE) == SCOPE_SHA, 'Reviewed catalog scope changed')
    old = decode(SCOPE.read_bytes())['after']
    functions = sorted(set(old['functions']) | EXISTING | {'private.confirmed_test_purge_schema_hash()'})
    tables = sorted(set(old['tables']) | {'private.leave_accrual_calculations', 'supabase_migrations.schema_migrations'})
    require(NEW.isdisjoint(functions) and 'private.annual_leave_day_accounting' not in tables, 'Invalid predecessor scope')
    return functions, tables


def catalog_expression(functions, tables):
    query_text = base_helper()['base_helper']()['catalog_query'](functions, tables)
    require(query_text.startswith('select ') and query_text.endswith(' as catalog;'), 'Unsupported catalog collector')
    return query_text[len('select '):-len(' as catalog;')]


def ledger_expression():
    return base_helper()['ledger_expression']()


def row_expression(sql):
    return "(select jsonb_build_object('version',version,'name',name,'statementHashes',jsonb_build_array(encode(sha256(convert_to(source,'UTF8')),'hex')),'ndims',1,'lower',1,'upper',1,'cardinality',1,'isNull',false,'rawHash',encode(sha256(convert_to(row(version,name,array[source])::text,'UTF8')),'hex')) from (values(" + ','.join(map(literal, [VERSION, NAME, sql])) + ')) entry(version,name,source))'


def api():
    return base_helper()['base_helper']()['api']()


def query(sql):
    return base_helper()['base_helper']()['query'](sql)


def validate_predecessors(sql, before):
    for signature, item in function_specs(sql).items():
        require(item['before'] is None or before['functions'].get(signature, {}).get('sha256') == item['before'],
                'Core predecessor definition differs: ' + signature)
    require(before['functions'].get('private.confirmed_test_purge_schema_hash()', {}).get('sha256') == '3385d5a0140df3995e3196ffea442b4829f9a5357de3ccf5a8d521fbe9011a54', 'Reviewed purge collector changed')


def read_frame(sql, recorded=False):
    functions, tables = scope(sql)
    if recorded:
        functions = sorted(set(functions) | NEW)
        tables += ['private.annual_leave_day_accounting']
    text = "begin read only; set local search_path=''; set local lock_timeout='3s'; set local statement_timeout='30s'; select jsonb_build_object('catalog'," + catalog_expression(functions, tables) + ",'rawLedger'," + ledger_expression() + ",'serverMajor',current_setting('server_version_num')::integer/10000,'targetRow'," + row_expression(sql) + ') as frame; rollback;'
    rows = query(text)
    require(isinstance(rows, list) and len(rows) == 1 and set(rows[0]) == {'frame'}, 'Incomplete read-only metadata response')
    frame = rows[0]['frame']
    require(isinstance(frame, dict) and set(frame) == {'catalog', 'rawLedger', 'serverMajor', 'targetRow'}, 'Incomplete live metadata frame')
    require(type(frame['serverMajor']) is int and frame['serverMajor'] in (16, 17), 'Unreviewed PostgreSQL major')
    base_helper()['validate_ledger'](frame['rawLedger'])
    return frame


def local_predecessors():
    rows = []
    for path in sorted(MIGRATION.parent.glob('*.sql')):
        match = re.fullmatch(r'([0-9]{14})_([a-z0-9_]+)\.sql', path.name)
        require(match is not None, 'Malformed local migration name')
        if path == MIGRATION:
            continue
        require(match[1] < VERSION, 'Later local migration requires independent review')
        rows.append(dict(file=path.name, version=match[1], name=match[2], sha256=byte_digest(path)))
    return rows


def resulting_catalog(sql, before, major):
    result = copy.deepcopy(before)
    specs = function_specs(sql)
    for signature, item in specs.items():
        if item['before'] is not None:
            result['functions'][signature]['sha256'] = item['after']
        else:
            m = item['metadata']
            result['functions'][signature] = dict(sha256=item['after'], owner=m['owner'], acl=m['acl'], securityDefiner=m['security_definer'], config=m['config'])
    for table in result['tables'].values():
        for trigger in table['triggers']:
            signature = trigger['definition'].split('EXECUTE FUNCTION ')[-1]
            if signature in specs:
                trigger['functionHash'] = specs[signature]['after']
    match = re.search(r"\('private\.annual_leave_day_accounting','((?:[^']|'')+)'::jsonb\),", sql)
    require(match is not None, 'Missing exact new relation specification')
    m = decode(match[1].replace("''", "'"))
    triggers = [dict(name=t['name'], enabled=t['enabled'], definition=t['definition'], functionHash=t['function_sha256']) for t in m['triggers']]
    result['tables']['private.annual_leave_day_accounting'] = dict(owner=m['owner'], acl='{postgres=arwdDxtm/postgres}' if major == 17 else m['acl'], rls=m['rls'], forceRls=m['force_rls'], sequenceAcl=[],
        columns=[dict(name=c['name'], type=c['type'], notNull=c['not_null'], identity=c['identity'], columnAcl=c['acl'], default=c['default']) for c in m['columns']],
        constraints=[dict(name=c['name'], type=c['type'], definition=c['definition']) for c in m['constraints']], policies=m['policies'], triggers=triggers)
    trigger = dict(name='ab_retain_completed_annual_leave_accounting', enabled='O', definition='CREATE TRIGGER ab_retain_completed_annual_leave_accounting BEFORE DELETE OR UPDATE ON public.leave_requests FOR EACH ROW EXECUTE FUNCTION private.retain_completed_annual_leave_accounting()', functionHash=specs['private.retain_completed_annual_leave_accounting()']['after'])
    result['tables']['public.leave_requests']['triggers'] = sorted(result['tables']['public.leave_requests']['triggers'] + [trigger], key=lambda value: value['name'])
    result['ledger'].append(dict(version=VERSION, name=NAME, sourceHash=digest(json.dumps([sql], ensure_ascii=False, separators=(',', ':')))))
    return result


def prepare_pins(sql, frame):
    functions, tables = scope(sql)
    before = frame['catalog']
    require(set(before['functions']) == set(functions) and set(before['tables']) == set(tables), 'Incomplete catalog scope')
    require(before['purgeGuard'] == {'rows': 1, 'matches': True}, 'Live protected schema fingerprint does not match')
    validate_predecessors(sql, before)
    require(frame['rawLedger'] and max(r['version'] for r in frame['rawLedger']) < VERSION, 'Target already recorded or ledger is newer')
    pins = dict(project=PROJECT, organization=ORG, baseHead=BASE_HEAD, version=VERSION, migrationSha256=digest(sql), helperSha256=byte_digest(Path(__file__)), serverMajor=frame['serverMajor'],
                before=before, after=resulting_catalog(sql, before, frame['serverMajor']), beforeLedger=frame['rawLedger'], afterLedger=frame['rawLedger'] + [frame['targetRow']], localPredecessors=local_predecessors())
    validate_candidate(sql, pins)
    return pins


def validate_candidate(sql, pins):
    validate_migration(sql)
    required = {'project', 'organization', 'baseHead', 'version', 'migrationSha256', 'helperSha256', 'serverMajor', 'before', 'after', 'beforeLedger', 'afterLedger', 'localPredecessors'}
    require(isinstance(pins, dict) and set(pins) == required, 'Incomplete exact release pins')
    require((pins['project'], pins['organization'], pins['baseHead'], pins['version'], pins['migrationSha256'], pins['helperSha256']) == (PROJECT, ORG, BASE_HEAD, VERSION, MIGRATION_SHA, byte_digest(Path(__file__))), 'Wrong release target or source binding')
    require(type(pins['serverMajor']) is int and pins['serverMajor'] in (16, 17), 'Unsupported pinned PostgreSQL major')
    functions, tables = scope(sql)
    require(set(pins['before']['functions']) == set(functions) and set(pins['before']['tables']) == set(tables), 'Incomplete predecessor catalog pins')
    validate_predecessors(sql, pins['before'])
    require(pins['before']['purgeGuard'] == {'rows': 1, 'matches': True}, 'Invalid predecessor protection baseline')
    require(pins['after'] == resulting_catalog(sql, pins['before'], pins['serverMajor']), 'Resulting catalog is not the exact declared delta')
    helper = base_helper()
    helper['validate_ledger'](pins['beforeLedger'])
    helper['validate_ledger'](pins['afterLedger'])
    require(pins['afterLedger'][:-1] == pins['beforeLedger'] and max(r['version'] for r in pins['beforeLedger']) < VERSION, 'Historical ledger mutation is not authorized')
    new = pins['afterLedger'][-1]
    require((new['version'], new['name'], new['statementHashes'], new['ndims'], new['lower'], new['upper'], new['cardinality'], new['isNull']) == (VERSION, NAME, [MIGRATION_SHA], 1, 1, 1, 1, False), 'Exact singleton target source/shape required')
    require(pins['localPredecessors'] == local_predecessors(), 'Local predecessor source changed')


def read_candidate(core_sha, pins_sha):
    require(isinstance(core_sha, str) and re.fullmatch('[0-9a-f]{64}', core_sha), 'Explicit reviewed migration SHA256 required')
    require(isinstance(pins_sha, str) and re.fullmatch('[0-9a-f]{64}', pins_sha), 'Explicit reviewed pins SHA256 required')
    sql = read_migration()
    require(core_sha == MIGRATION_SHA, 'Reviewed migration hash differs')
    require(byte_digest(PINS) == pins_sha, 'Reviewed raw pin bytes differ')
    pins = decode(PINS.read_bytes())
    validate_candidate(sql, pins)
    return sql, pins


def validate_frame(frame, pins, recorded):
    require(frame['serverMajor'] == pins['serverMajor'] and frame['catalog'] == pins['after' if recorded else 'before']
            and frame['rawLedger'] == pins['afterLedger' if recorded else 'beforeLedger']
            and frame['targetRow'] == pins['afterLedger'][-1], 'Exact live catalog, source, ledger or array-bound drift; stop for review')


def guard(sql, pins, recorded):
    expected = pins['after' if recorded else 'before']
    ledger = pins['afterLedger' if recorded else 'beforeLedger']
    return "do $annual_continuous_release$ begin if current_setting('server_version_num')::integer/10000<>" + str(pins['serverMajor']) + ' or ' + catalog_expression(sorted(expected['functions']), sorted(expected['tables'])) + ' is distinct from ' + literal(json.dumps(expected, separators=(',', ':'))) + '::jsonb or ' + ledger_expression() + ' is distinct from ' + literal(json.dumps(ledger, separators=(',', ':'))) + "::jsonb then raise exception 'Annual continuous release catalog or raw ledger drift' using errcode='55000'; end if; end $annual_continuous_release$;"


def build_transaction(sql, pins):
    validate_candidate(sql, pins)
    locks = ','.join(sorted(set(pins['before']['tables']) | {'supabase_migrations.schema_migrations'}))
    insert = 'insert into supabase_migrations.schema_migrations(version,name,statements) values(' + ','.join([literal(VERSION), literal(NAME), 'array[' + literal(sql) + ']']) + ');'
    final = "do $annual_continuous_release_final$ begin perform pg_temp.annual_continuous_assert_delta(); if pg_temp.annual_continuous_security() is distinct from (select value from pg_temp.annual_continuous_security_before) then raise exception 'Annual continuous final complete security drift' using errcode='55000'; end if; end $annual_continuous_release_final$;"
    return "begin; set local search_path=''; set local lock_timeout='3s'; set local statement_timeout='90s';\nlock table " + locks + ' in share row exclusive mode nowait;\n' + guard(sql, pins, False) + '\n' + transaction_body(sql) + '\n' + insert + '\nset constraints all immediate;\n' + guard(sql, pins, True) + '\n' + final + "\nnotify pgrst,'reload schema';\ncommit;"


def clean_source():
    require(Path.cwd().resolve() == ROOT.resolve(), 'Apply only from the approved repository root')
    require(not any(k.startswith('GIT_') and k != 'GIT_PAGER' for k in os.environ), 'Inherited Git overrides are not allowed')
    env = {'PATH': os.environ.get('PATH', ''), 'LC_ALL': 'C', 'LANG': 'C', 'HOME': os.environ.get('HOME', '')}
    def git(*args):
        return subprocess.check_output(['git', *args], cwd=ROOT, env=env)
    head = git('rev-parse', 'HEAD').decode().strip()
    require(re.fullmatch('[0-9a-f]{40}', head) and not git('status', '--porcelain').strip(), 'Clean reviewed release checkout required')
    require(git('remote', 'get-url', 'origin').decode().strip() == 'https://github.com/mobilityaccessmodifications/mam-team-management-system.git', 'Wrong MAM repository')
    require(git('show', '-s', '--format=%an <%ae>', 'HEAD').decode().strip() == 'mobilityaccessmodifications <310802599+mobilityaccessmodifications@users.noreply.github.com>', 'Wrong MAM commit author')
    require(subprocess.run(['git', 'merge-base', '--is-ancestor', BASE_HEAD, head], cwd=ROOT, env=env, capture_output=True).returncode == 0, 'Wrong reviewed predecessor ancestry')
    dependencies = [MIGRATION, PINS, Path(__file__).resolve(), BASE_HELPER, SCOPE, ROOT / 'scripts/deploy-payroll-closing-carryforward.py']
    for path in dependencies:
        require(git('show', head + ':' + str(path.relative_to(ROOT))) == path.read_bytes(), 'Committed release bytes differ')
    return head


def dispatch_journal(sql, core_sha, pins_sha, head):
    directory_name = os.environ.get('MAM_ANNUAL_CONTINUOUS_JOURNAL_DIR')
    require(isinstance(directory_name, str) and bool(directory_name), 'An external private dispatch-journal directory is required')
    parent = Path(directory_name).resolve()
    require(parent.is_dir() and parent.stat().st_uid == os.getuid() and parent.stat().st_mode & 0o077 == 0
            and ROOT.resolve() not in (parent, *parent.parents), 'Journal must be in an owned private directory outside the repository')
    path = parent / (VERSION + '-' + pins_sha + '.dispatch.json')
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w') as file:
        json.dump(dict(project=PROJECT, organization=ORG, version=VERSION, head=head, migrationSha256=core_sha, pinsSha256=pins_sha, rawQuerySha256=digest(sql), outcome='WRITE_NOT_YET_RECONCILED', automaticRetry=False), file)
        file.flush()
        os.fsync(file.fileno())
    directory = os.open(path.parent, os.O_RDONLY)
    try:
        os.fsync(directory)
    finally:
        os.close(directory)


def main():
    require(len(sys.argv) in (2, 4) and sys.argv[1] in ('inspect', 'apply'), 'Use inspect or apply <migration-sha256> <pins-sha256>')
    applying = sys.argv[1] == 'apply'
    require(len(sys.argv) == (4 if applying else 2), 'Invalid exact release arguments')
    sql, pins = read_candidate(sys.argv[2], sys.argv[3]) if applying else (read_migration(), None)
    head = clean_source() if applying else None
    target = api()
    require(isinstance(target, dict) and target.get('id') == PROJECT and target.get('organization_id') == ORG, 'Wrong MAM organization/project')
    rows = query('begin read only; set local statement_timeout=\'30s\'; select version from supabase_migrations.schema_migrations where version=' + literal(VERSION) + '; rollback;')
    require(isinstance(rows, list) and len(rows) <= 1 and all(row == {'version': VERSION} for row in rows), 'Malformed recorded-release response')
    recorded = bool(rows)
    frame = read_frame(sql, recorded)
    if not applying:
        if recorded:
            require(PINS.is_file(), 'Target already recorded: recover the original reviewed pins; never recapture a new baseline')
            pins = decode(PINS.read_bytes())
            validate_candidate(sql, pins)
            validate_frame(frame, pins, True)
            print(json.dumps(dict(targetVerified=True, readOnly=True, recorded=True, readbackVerified=True, version=VERSION)))
        else:
            print(json.dumps(prepare_pins(sql, frame), indent=2))
        return
    validate_frame(frame, pins, recorded)
    if not recorded:
        transaction = build_transaction(sql, pins)
        dispatch_journal(transaction, sys.argv[2], sys.argv[3], head)
        query(transaction)
    validate_frame(read_frame(sql, True), pins, True)
    print(json.dumps(dict(targetVerified=True, readOnly=recorded, recorded=True, readbackVerified=True, version=VERSION, migrationSha256=MIGRATION_SHA)))


if __name__ == '__main__':
    try:
        main()
    except urllib.error.HTTPError as error:
        raise SystemExit('Management API HTTP ' + str(error.code) + '; no automatic retry; inspect the exact target')
    except (ValueError, KeyError, OSError, subprocess.SubprocessError) as error:
        raise SystemExit(str(error) if isinstance(error, ValueError) else 'Release verification unavailable; no automatic retry; inspect the exact target')
