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
BASE_HEAD = '9ff635a92568eee29b58192405bcfa0b45cce8f2'
NAME = 'annual_source_bank_reconciliation'
PINS = ROOT / 'scripts/annual-source-bank-release-pins.json'
BASE_HELPER = ROOT / 'scripts/deploy-payroll-closing-carryforward.py'
BASE_HELPER_SHA = '1b23644c10d4dddc04e5ca1d0238e01b1e4fcbdd2dfab84834ec7fcf9b541c98'


def require(condition, message):
    if not condition:
        raise ValueError(message)


def digest(value):
    return hashlib.sha256(value.encode('utf-8')).hexdigest()


def decode(raw):
    def unique(pairs):
        result = {}
        for key, value in pairs:
            require(key not in result, 'Duplicate pin key')
            result[key] = value
        return result

    def invalid_constant(value):
        raise ValueError('Non-finite pin number')

    return json.loads(raw, object_pairs_hook=unique, parse_constant=invalid_constant)


def literal(value):
    return "'" + value.replace("'", "''") + "'"


def base_helper():
    require(hashlib.sha256(BASE_HELPER.read_bytes()).hexdigest() == BASE_HELPER_SHA,
            'Reviewed catalog helper changed')
    return runpy.run_path(str(BASE_HELPER))


def ledger_expression():
    return """(select coalesce(jsonb_agg(jsonb_build_object(
      'version',version,'name',name,'statementHashes',case when statements is null then null else coalesce((select jsonb_agg(case when value is null then null else encode(sha256(convert_to(value,'UTF8')),'hex') end order by position) from unnest(statements) with ordinality source(value,position)),'[]'::jsonb) end,
      'ndims',array_ndims(statements),'lower',array_lower(statements,1),
      'upper',array_upper(statements,1),'cardinality',cardinality(statements),
      'isNull',statements is null,
      'rawHash',encode(sha256(convert_to(row(version,name,statements)::text,'UTF8')),'hex'))
      order by version),'[]'::jsonb) from supabase_migrations.schema_migrations)"""


def validate_ledger(rows):
    require(isinstance(rows, list) and rows, 'Explicit nonempty raw ledger required')
    versions = []
    fields = {'version', 'name', 'statementHashes', 'ndims', 'lower', 'upper', 'cardinality', 'isNull', 'rawHash'}
    for row in rows:
        require(isinstance(row, dict) and set(row) == fields, 'Incomplete raw ledger row')
        require(isinstance(row['version'], str) and re.fullmatch('[0-9]{14}', row['version']), 'Malformed ledger version')
        require(row['name'] is None or isinstance(row['name'], str), 'Malformed ledger name')
        require(isinstance(row['rawHash'], str) and re.fullmatch('[0-9a-f]{64}', row['rawHash']), 'Native raw ledger hash required')
        require(type(row['isNull']) is bool, 'Explicit ledger NULL flag required')
        if row['isNull']:
            require(all(row[key] is None for key in ['statementHashes', 'ndims', 'lower', 'upper', 'cardinality']), 'Malformed NULL ledger array')
        else:
            statements = row['statementHashes']
            require(isinstance(statements, list) and all(x is None or (isinstance(x, str) and re.fullmatch('[0-9a-f]{64}', x)) for x in statements), 'Unsupported raw statements array')
            require(type(row['cardinality']) is int and row['cardinality'] == len(statements), 'Ledger array cardinality differs')
            if not statements:
                require(all(row[key] is None for key in ['ndims', 'lower', 'upper']), 'Malformed empty ledger array')
            else:
                require(type(row['ndims']) is int and row['ndims'] == 1 and type(row['lower']) is int and type(row['upper']) is int
                        and row['upper'] - row['lower'] + 1 == len(statements), 'Unsupported raw ledger dimensions/bounds')
        versions.append(row['version'])
    require(versions == sorted(set(versions)), 'Duplicate or unordered raw ledger versions')


def migration_path(pins):
    version = pins.get('version')
    require(isinstance(version, str) and re.fullmatch('[0-9]{14}', version), 'Explicit migration version required')
    return ROOT / 'supabase/migrations' / (version + '_' + NAME + '.sql')


def validate_function_specs(sql, pins):
    blocks = re.findall(r'insert into annual_source_function_spec values\n(.*?)\ncreate temporary table annual_source_relation_spec', sql, re.S)
    require(len(blocks) == 1, 'Missing exact core function scope')
    rows = blocks[0].splitlines()
    pattern = re.compile(r"\('([^']+)',(true|false),(null|'([0-9a-f]{64})'),'([0-9a-f]{64})',(null|'(?:[^']|'')*'::jsonb)\)([,;])")
    specs = {}
    for index, row in enumerate(rows):
        match = pattern.fullmatch(row)
        require(match is not None and match[7] == (';' if index == len(rows) - 1 else ','), 'Unsupported core function specification')
        signature, existing, before_sha, after_sha = match[1], match[2] == 'true', match[4], match[5]
        require(signature not in specs and signature.startswith(('private.', 'public.')), 'Duplicate or invalid core function specification')
        require((existing and before_sha is not None) or (not existing and before_sha is None), 'Incomplete core function predecessor hash')
        specs[signature] = (existing, before_sha, after_sha)
    existing = {signature for signature, value in specs.items() if value[0]}
    new = set(specs) - existing
    require(len(existing) == 19 and len(new) == 7, 'Unexpected core function scope')
    before, after = pins['before']['functions'], pins['after']['functions']
    require(existing <= set(before) and new.isdisjoint(before) and set(after) == set(before) | new, 'Core and catalog function scope differ')
    for signature, (is_existing, before_sha, after_sha) in specs.items():
        require(not is_existing or before[signature].get('sha256') == before_sha, 'Core predecessor definition pin differs: ' + signature)
        require(after[signature].get('sha256') == after_sha, 'Core resulting definition pin differs: ' + signature)
    require(all(before[signature] == after[signature] for signature in set(before) - existing), 'Unlisted protected function change')


def validate_candidate(sql, pins):
    require((pins.get('project'), pins.get('organization'), pins.get('baseHead')) == (PROJECT, ORG, BASE_HEAD), 'Wrong source-bank release target')
    migration_path(pins)
    require(pins.get('migrationSha256') == digest(sql), 'Reviewed raw migration differs')
    base_helper()['transaction_body'](sql)
    require(len(re.findall(r'create\s+(?:or\s+replace\s+)?function\s+pg_temp\.annual_source_security\s*\(', sql, re.I)) == 1,
            'Missing core security snapshot function')
    require(len(re.findall(r'create\s+(?:temporary|temp)\s+table\s+(?:pg_temp\.)?annual_source_security_before\b', sql, re.I)) == 1,
            'Missing core security predecessor snapshot')
    require(not re.search(r'drop\s+function\s+(?:if\s+exists\s+)?pg_temp\.annual_source_security\b', sql, re.I), 'Core must retain final-envelope security function')
    before, after = pins.get('before'), pins.get('after')
    require(isinstance(before, dict) and isinstance(after, dict) and set(before) == set(after), 'Incomplete catalog pins')
    require(isinstance(before.get('functions'), dict) and before['functions']
            and isinstance(after.get('functions'), dict) and set(before['functions']) <= set(after['functions']), 'Protected function pins omitted')
    require(isinstance(before.get('tables'), dict) and before['tables']
            and isinstance(after.get('tables'), dict) and set(before['tables']) <= set(after['tables']), 'Protected table pins omitted')
    validate_function_specs(sql, pins)
    require(before.get('purgeGuard') == {'rows': 1, 'matches': True}
            and after.get('purgeGuard') == {'rows': 1, 'matches': True}, 'Protected collector consistency pins required')
    validate_ledger(pins.get('beforeLedger'))
    validate_ledger(pins.get('afterLedger'))
    require(pins['afterLedger'][:-1] == pins['beforeLedger'], 'Historical raw ledger changes are not authorized')
    new = pins['afterLedger'][-1]
    require(new['version'] == pins['version'] and new['name'] == NAME and new['statementHashes'] == [digest(sql)]
            and (new['ndims'], new['lower'], new['upper'], new['cardinality'], new['isNull']) == (1, 1, 1, 1, False),
            'Exact singleton target source/shape required')
    require(max(row['version'] for row in pins['beforeLedger']) < pins['version'], 'Target must be newer than the exact predecessor')
    require(after.get('ledger') == before.get('ledger', []) + [dict(version=pins['version'], name=NAME,
            sourceHash=digest(json.dumps([sql], ensure_ascii=False, separators=(',', ':'))))], 'Catalog target source differs')


def read_candidate(core_sha, pins_sha):
    require(isinstance(core_sha, str) and re.fullmatch('[0-9a-f]{64}', core_sha), 'Explicit reviewed migration SHA256 required')
    require(isinstance(pins_sha, str) and re.fullmatch('[0-9a-f]{64}', pins_sha), 'Explicit reviewed pins SHA256 required')
    raw = PINS.read_bytes()
    require(hashlib.sha256(raw).hexdigest() == pins_sha, 'Reviewed pin bytes differ')
    pins = decode(raw)
    sql = migration_path(pins).read_bytes().decode('utf-8')
    require(digest(sql) == core_sha, 'Reviewed raw migration differs')
    validate_candidate(sql, pins)
    return sql, pins


def catalog_expression(expected):
    return base_helper()['catalog_query'](list(expected['functions']), list(expected['tables'])).removeprefix('select ').removesuffix(' as catalog;')


def guard(expected, ledger):
    return "do $annual_source_release$ begin if " + catalog_expression(expected) + ' is distinct from ' + literal(json.dumps(expected, separators=(',', ':'))) + '::jsonb or ' + ledger_expression() + ' is distinct from ' + literal(json.dumps(ledger, separators=(',', ':'))) + "::jsonb then raise exception 'Source-bank release catalog or raw ledger drift' using errcode='55000'; end if; end $annual_source_release$;"


def validate_frame(frame, pins, recorded):
    require(isinstance(frame, dict) and set(frame) == {'catalog', 'rawLedger'}, 'Incomplete release metadata envelope')
    require(frame['catalog'] == pins['after' if recorded else 'before'], 'Live source-bank catalog differs; stop for review')
    require(frame['rawLedger'] == pins['afterLedger' if recorded else 'beforeLedger'], 'Live raw ledger/source/dimensions/bounds differ')
    return True


def read_frame(pins, recorded):
    expected = pins['after' if recorded else 'before']
    sql = "begin read only; set local search_path=''; set local statement_timeout='30s'; select jsonb_build_object('catalog'," + catalog_expression(expected) + ",'rawLedger'," + ledger_expression() + ') as frame; rollback;'
    rows = base_helper()['query'](sql)
    require(isinstance(rows, list) and len(rows) == 1 and set(rows[0]) == {'frame'}, 'Incomplete read-only response')
    validate_frame(rows[0]['frame'], pins, recorded)
    return rows[0]['frame']


def build_transaction(sql, pins):
    validate_candidate(sql, pins)
    require(all(re.fullmatch(r'(?:public|private)\.[a-z_][a-z0-9_]*', name) for name in pins['before']['tables']), 'Unsupported locked relation')
    locks = ','.join(['supabase_migrations.schema_migrations'] + sorted(pins['before']['tables']))
    receipts = "(select encode(sha256(convert_to(coalesce(jsonb_agg(to_jsonb(p) order by id),'[]')::text,'UTF8')),'hex') from private.confirmed_test_identity_purges p)"
    capture = 'create temporary table annual_source_release_receipts on commit drop as select ' + receipts + ' as value;'
    insert = 'insert into supabase_migrations.schema_migrations(version,name,statements) values(' + ','.join([literal(pins['version']), literal(NAME), 'array[' + literal(sql) + ']']) + ');'
    final = "do $annual_source_release_final$ begin perform pg_temp.annual_source_assert_delta(); if pg_temp.annual_source_security() is distinct from (select value from pg_temp.annual_source_security_before) or " + receipts + " is distinct from (select value from pg_temp.annual_source_release_receipts) or private.confirmed_test_purge_schema_hash() is distinct from (select schema_hash from private.confirmed_test_purge_schema where singleton) then raise exception 'Source-bank final security, collector or receipt drift' using errcode='55000'; end if; end $annual_source_release_final$;"
    return "begin; set local search_path=''; set local lock_timeout='3s'; set local statement_timeout='90s';\nlock table " + locks + " in share row exclusive mode nowait;\n" + guard(pins['before'], pins['beforeLedger']) + '\n' + capture + '\n' + base_helper()['transaction_body'](sql) + '\n' + insert + '\nset constraints all immediate;\n' + guard(pins['after'], pins['afterLedger']) + '\n' + final + "\ndrop function pg_temp.annual_source_assert_delta();\ndrop function pg_temp.annual_source_catalog();\ndrop function pg_temp.annual_source_table_metadata(oid);\ndrop function pg_temp.annual_source_index_metadata(oid);\ndrop function pg_temp.annual_source_data();\ndrop function pg_temp.annual_source_security();\nnotify pgrst,'reload schema';\ncommit;"


def validate_local_sources(pins):
    actual = []
    for path in sorted((ROOT / 'supabase/migrations').glob('*.sql')):
        match = re.fullmatch(r'([0-9]{14})_([a-z0-9_]+)\.sql', path.name)
        require(match is not None, 'Malformed migration filename')
        if path == migration_path(pins):
            continue
        version, name = match.groups()
        require(version < pins['version'], 'Later local-only migration is not authorized')
        actual.append(dict(file=path.name, version=version, name=name, sha256=hashlib.sha256(path.read_bytes()).hexdigest()))
    require(actual == pins.get('localPredecessors'), 'Local predecessor source differs')


def clean_source(head, pins):
    require(isinstance(head, str) and re.fullmatch('[0-9a-f]{40}', head), 'Explicit reviewed full HEAD required')
    require(Path.cwd().resolve() == ROOT.resolve(), 'Apply only from the approved repository root')
    git = lambda *args: subprocess.check_output(['git', *args], cwd=ROOT, text=True).strip()
    require(git('rev-parse', 'HEAD') == head and not git('status', '--porcelain'), 'Clean reviewed source HEAD required')
    require(git('remote', 'get-url', 'origin') == 'https://github.com/mobilityaccessmodifications/mam-team-management-system.git', 'Wrong MAM repository')
    require(git('show', '-s', '--format=%an <%ae>', 'HEAD') == 'mobilityaccessmodifications <310802599+mobilityaccessmodifications@users.noreply.github.com>', 'Wrong MAM commit author')
    require(subprocess.run(['git', 'merge-base', '--is-ancestor', BASE_HEAD, head], cwd=ROOT).returncode == 0, 'Reviewed main ancestry differs')
    for path in [migration_path(pins), PINS, BASE_HELPER, Path(__file__).resolve()]:
        require(subprocess.check_output(['git', 'show', head + ':' + str(path.relative_to(ROOT))], cwd=ROOT) == path.read_bytes(), 'Committed release bytes differ')
    validate_local_sources(pins)


def create_journal(path, head, core_sha, pins_sha, transaction, version):
    journal = Path(path).resolve()
    parent = journal.parent
    require(parent.is_dir() and parent.stat().st_uid == os.getuid() and parent.stat().st_mode & 0o077 == 0,
            'Journal requires an owned private existing directory')
    fd = os.open(journal, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w') as file:
        json.dump(dict(version=version, project=PROJECT, organization=ORG, head=head,
                       migrationSha256=core_sha, pinsSha256=pins_sha, rawQuerySha256=digest(transaction),
                       outcome='WRITE_NOT_YET_RECONCILED', automaticRetry=False), file)
        file.flush()
        os.fsync(file.fileno())


def main():
    require(len(sys.argv) in (4, 6) and sys.argv[1] in ('inspect', 'apply'),
            'Use inspect CORE_SHA PINS_SHA or apply HEAD CORE_SHA PINS_SHA JOURNAL')
    applying = sys.argv[1] == 'apply'
    require(len(sys.argv) == (6 if applying else 4), 'Invalid release arguments')
    core_sha, pins_sha = sys.argv[3:5] if applying else sys.argv[2:4]
    sql, pins = read_candidate(core_sha, pins_sha)
    if applying:
        clean_source(sys.argv[2], pins)
    helper = base_helper()
    target = helper['api']()
    require(target.get('id') == PROJECT and target.get('organization_id') == ORG, 'Wrong MAM organization/project')
    rows = helper['query']('begin read only; select version from supabase_migrations.schema_migrations where version=' + literal(pins['version']) + '; rollback;')
    require(isinstance(rows, list) and len(rows) <= 1, 'Malformed recorded-release response')
    recorded = bool(rows)
    read_frame(pins, recorded)
    if applying and not recorded:
        transaction = build_transaction(sql, pins)
        create_journal(sys.argv[5], sys.argv[2], core_sha, pins_sha, transaction, pins['version'])
        helper['query'](transaction)
        read_frame(pins, True)
    print(json.dumps(dict(targetVerified=True, readOnly=not applying or recorded, recorded=recorded or applying,
                          readbackVerified=applying, pinsMatch=True, version=pins['version'])))


if __name__ == '__main__':
    try:
        main()
    except urllib.error.HTTPError as error:
        raise SystemExit('Management API HTTP ' + str(error.code) + '; no automatic retry, inspect exact target')
    except (ValueError, KeyError, OSError) as error:
        raise SystemExit(str(error) if isinstance(error, ValueError) else 'Release verification unavailable; no automatic retry')
