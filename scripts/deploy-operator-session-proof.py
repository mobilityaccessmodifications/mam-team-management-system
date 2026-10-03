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
BASE_HEAD = '0ddad09c7382a1c9b512022a342bf91abc2c1a88'
VERSION = '20261003090000'
NAME = 'payroll_operator_session_proof'
MIGRATION = ROOT / 'supabase/migrations' / (VERSION + '_' + NAME + '.sql')
PINS = ROOT / 'scripts/operator-session-release-pins.json'
BASE_HELPER_SHA = '1b23644c10d4dddc04e5ca1d0238e01b1e4fcbdd2dfab84834ec7fcf9b541c98'
BASE_PINS_SHA = '07e59e20dbeb3943e8f3e3942c895ead83e8937166b432f1eb85e3f436913e3d'
NEW_FUNCTIONS = ['private.verify_payroll_operator_session(uuid)', 'public.verify_current_payroll_operator_session()']


def require(condition, message):
    if not condition:
        raise ValueError(message)


def digest(value):
    return hashlib.sha256(value.encode()).hexdigest()


def decode(raw):
    def unique(pairs):
        result = {}
        for key, value in pairs:
            require(key not in result, 'Duplicate JSON key')
            result[key] = value
        return result
    def invalid_constant(value):
        raise ValueError('Non-finite JSON number')
    return json.loads(raw, object_pairs_hook=unique, parse_constant=invalid_constant)


def base_helper():
    path = ROOT / 'scripts/deploy-payroll-closing-carryforward.py'
    require(hashlib.sha256(path.read_bytes()).hexdigest() == BASE_HELPER_SHA, 'Original approved helper changed')
    require(hashlib.sha256((ROOT / 'scripts/payroll-closing-release-pins.json').read_bytes()).hexdigest() == BASE_PINS_SHA, 'Original release pins changed')
    return runpy.run_path(str(path))


def literal(value):
    return "'" + value.replace("'", "''") + "'"


def read_pins(reviewed_sha):
    require(bool(re.fullmatch('[0-9a-f]{64}', reviewed_sha or '')), 'Explicit reviewed pin SHA256 required')
    raw = PINS.read_bytes()
    require(hashlib.sha256(raw).hexdigest() == reviewed_sha, 'Reviewed pin bytes differ')
    pins = decode(raw)
    validate_candidate(MIGRATION.read_bytes().decode('utf-8'), pins)
    return pins


def validate_candidate(sql, pins):
    require((pins['project'], pins['organization'], pins['version'], pins['baseHead']) == (PROJECT, ORG, VERSION, BASE_HEAD), 'Wrong authentication-only release target')
    require(digest(sql) == pins['migrationSha256'], 'Candidate raw bytes differ')
    base_helper()['transaction_body'](sql)
    declaration = re.findall(r"for signature,expected in select key,value from jsonb_each\('((?:[^']|'')*)'::jsonb\)", sql)
    require(len(declaration) == 1, 'Unsupported predecessor declaration')
    require(decode(declaration[0].replace("''", "'")) == pins['before']['functions'], 'Declared predecessor function pins differ')
    expected = decode((ROOT / 'scripts/payroll-closing-release-pins.json').read_bytes())['after']
    require(pins['before'] == expected, 'Unknown schema/ledger baseline; no automatic adoption')
    after = decode(json.dumps(pins['after']))
    require(set(after['functions']) == set(expected['functions']) | set(NEW_FUNCTIONS), 'Only two authentication functions admitted')
    for signature in NEW_FUNCTIONS:
        metadata = after['functions'].pop(signature)
        require(metadata['owner'] == 'postgres' and metadata['securityDefiner'] and metadata['config'] == ['search_path=""'], 'Wrong authentication function security')
        require(sql.count(metadata['sha256']) == 1, 'Resulting full-definition pin is not declared in candidate')
    require(after['ledger'] == expected['ledger'] + [dict(version=VERSION, name=NAME, sourceHash=digest(json.dumps([sql], ensure_ascii=False, separators=(',', ':'))))], 'Exact target raw ledger source differs')
    after['ledger'] = expected['ledger']
    require(after == expected, 'Undeclared non-authentication catalog delta')


def ledger_shapes_expression():
    return "(select coalesce(jsonb_agg(jsonb_build_object('version',version,'ndims',array_ndims(statements),'lower',array_lower(statements,1),'upper',array_upper(statements,1),'cardinality',cardinality(statements)) order by version),'[]'::jsonb) from supabase_migrations.schema_migrations)"


def catalog_expression(expected):
    return base_helper()['catalog_query'](list(expected['functions']), list(expected['tables'])).removeprefix('select ').removesuffix(' as catalog;')


def guard(expected, shapes):
    return "do $operator_proof_catalog$ begin if " + catalog_expression(expected) + ' is distinct from ' + literal(json.dumps(expected, separators=(',', ':'))) + '::jsonb or ' + ledger_shapes_expression() + ' is distinct from ' + literal(json.dumps(shapes, separators=(',', ':'))) + "::jsonb then raise exception 'Authentication-only release catalog or raw ledger-shape drift' using errcode='55000'; end if; end $operator_proof_catalog$;"


def full_security_expression(sql):
    expression = base_helper()['full_security_query']().removeprefix('SELECT ').removesuffix(' AS metadata;')
    require(sql.count(expression) == 2, 'Complete original security expression differs')
    return expression


def build_transaction(sql, pins):
    validate_candidate(sql, pins)
    security = full_security_expression(sql)
    receipts = "(select encode(sha256(convert_to(coalesce(jsonb_agg(to_jsonb(p) order by id),'[]')::text,'UTF8')),'hex') from private.confirmed_test_identity_purges p)"
    final = "do $operator_proof_final$ begin if private.confirmed_test_purge_schema_hash() is distinct from (select after_hash from pg_temp.operator_proof_transition) or (select schema_hash from private.confirmed_test_purge_schema where singleton) is distinct from (select after_hash from pg_temp.operator_proof_transition) or " + receipts + ' is distinct from (select receipts_hash from pg_temp.operator_proof_transition) or ' + security + " is distinct from (select extra_catalog from pg_temp.operator_proof_transition) then raise exception 'Authentication-only final schema/receipt/security drift' using errcode='55000'; end if; end $operator_proof_final$;"
    insert = 'insert into supabase_migrations.schema_migrations(version,name,statements) values(' + ','.join([literal(VERSION), literal(NAME), 'array[' + literal(sql) + ']']) + ');'
    return "begin; set local search_path=''; set local lock_timeout='3s'; set local statement_timeout='75s';\nlock table supabase_migrations.schema_migrations in share row exclusive mode nowait;\n" + guard(pins['before'], pins['beforeLedgerShapes']) + '\n' + base_helper()['transaction_body'](sql) + '\n' + insert + '\nset constraints all immediate;\n' + guard(pins['after'], pins['afterLedgerShapes']) + '\n' + final + "\nnotify pgrst,'reload schema';\ncommit;"


def validate_frame(frame, pins, recorded):
    require(frame['catalog'] == pins['after' if recorded else 'before'], 'Live authentication catalog differs; stop for review')
    require(frame['ledgerShapes'] == pins['afterLedgerShapes' if recorded else 'beforeLedgerShapes'], 'Live raw ledger dimensions/bounds differ')
    return True


def read_frame(pins, recorded):
    expected = pins['after' if recorded else 'before']
    query = "begin read only; set local search_path=''; select jsonb_build_object('catalog'," + catalog_expression(expected) + ",'ledgerShapes'," + ledger_shapes_expression() + ") as frame; rollback;"
    rows = base_helper()['query'](query)
    require(isinstance(rows, list) and len(rows) == 1 and set(rows[0]) == {'frame'}, 'Incomplete read-only metadata envelope')
    frame = rows[0]['frame']
    validate_frame(frame, pins, recorded)
    return frame


def validate_local_sources(expected):
    actual, versions = [], set()
    for path in sorted(MIGRATION.parent.glob('*.sql')):
        match = re.fullmatch(r'([0-9]{14})_([a-z0-9_]+)\.sql', path.name)
        require(match is not None, 'Malformed migration filename')
        assert match is not None
        version, name = match.groups()
        require(version not in versions, 'Duplicate local migration version')
        versions.add(version)
        if path == MIGRATION:
            continue
        require(version < VERSION, 'Later local-only migration is not authorised')
        actual.append(dict(file=path.name, version=version, name=name, sha256=hashlib.sha256(path.read_bytes()).hexdigest()))
    require(actual == expected, 'Local predecessor source drift')


def clean_source(head):
    require(bool(re.fullmatch('[0-9a-f]{40}', head or '')), 'Explicit reviewed full HEAD required')
    require(Path.cwd().resolve() == ROOT.resolve(), 'Apply only from approved repository root')
    git = lambda *args: subprocess.check_output(['git', *args], cwd=ROOT, text=True).strip()
    require(git('rev-parse', 'HEAD') == head and not git('status', '--porcelain'), 'Clean reviewed source HEAD required')
    require(git('remote', 'get-url', 'origin') == 'https://github.com/mobilityaccessmodifications/mam-team-management-system.git', 'Wrong MAM repository')
    require(git('show', '-s', '--format=%an <%ae>', 'HEAD') == 'mobilityaccessmodifications <310802599+mobilityaccessmodifications@users.noreply.github.com>', 'Wrong MAM commit author')
    require(subprocess.run(['git', 'merge-base', '--is-ancestor', BASE_HEAD, head], cwd=ROOT).returncode == 0, 'Reviewed main ancestry differs')
    for path in [MIGRATION, PINS, Path(__file__).resolve()]:
        require(subprocess.check_output(['git', 'show', head + ':' + str(path.relative_to(ROOT))], cwd=ROOT) == path.read_bytes(), 'Committed source bytes differ')


def main():
    require(len(sys.argv) in (4, 6) and sys.argv[1] in ('inspect', 'apply'), 'Use inspect CORE_SHA PINS_SHA or apply HEAD CORE_SHA PINS_SHA JOURNAL')
    applying = sys.argv[1] == 'apply'
    require(len(sys.argv) == (6 if applying else 4), 'Invalid authentication-only release arguments')
    core_sha, pins_sha = sys.argv[3:5] if applying else sys.argv[2:4]
    require(bool(re.fullmatch('[0-9a-f]{64}', core_sha or '')), 'Explicit reviewed raw migration SHA required')
    sql = MIGRATION.read_bytes().decode('utf-8')
    require(digest(sql) == core_sha, 'Reviewed raw migration differs')
    pins = read_pins(pins_sha)
    helper = base_helper()
    target = helper['api']()
    require(target.get('id') == PROJECT and target.get('organization_id') == ORG, 'Wrong MAM organization/project')
    rows = helper['query']('begin read only; select version from supabase_migrations.schema_migrations where version=' + literal(VERSION) + '; rollback;')
    require(isinstance(rows, list) and len(rows) <= 1, 'Malformed recorded-release response')
    recorded = bool(rows)
    read_frame(pins, recorded)
    if not applying:
        print(json.dumps(dict(targetVerified=True, readOnly=True, recorded=recorded, pinsMatch=True, version=VERSION)))
        return
    clean_source(sys.argv[2])
    validate_local_sources(pins['localPredecessors'])
    if not recorded:
        versions = [r['version'] for r in pins['before']['ledger']]
        require(versions and max(versions) < VERSION and len(versions) == len(set(versions)), 'Target is not newer than exact predecessor ledger')
        transaction = build_transaction(sql, pins)
        journal = Path(sys.argv[5]).resolve()
        approved = Path('/Users/nixon/.hermes/profiles/mam/cache/scratch').resolve()
        require(approved in journal.parents and journal.parent.is_dir(), 'Journal must be in an existing approved private evidence directory')
        fd = os.open(journal, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, 'w') as file:
            json.dump(dict(version=VERSION, project=PROJECT, organization=ORG, head=sys.argv[2], coreSha256=core_sha, pinsSha256=pins_sha, rawQuerySha256=digest(transaction), outcome='WRITE_NOT_YET_RECONCILED', automaticRetry=False), file)
            file.flush()
            os.fsync(file.fileno())
        helper['query'](transaction)
    read_frame(pins, True)
    print(json.dumps(dict(targetVerified=True, recorded=True, readOnlyReplay=recorded, readbackVerified=True, version=VERSION, migrationSha256=core_sha)))


if __name__ == '__main__':
    try:
        main()
    except urllib.error.HTTPError as error:
        raise SystemExit('Management API HTTP ' + str(error.code) + '; no automatic retry, inspect exact target')
    except (ValueError, KeyError, OSError) as error:
        raise SystemExit(str(error) if isinstance(error, ValueError) else 'Release verification unavailable; no automatic retry')
