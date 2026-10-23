import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import urllib.error
import urllib.request
import uuid

ROOT = Path(__file__).resolve().parents[1]
PROJECT = 'xtwlrjqbusadghavchqm'
ORG = 'fwlmbmospuwoaosffvmw'
ORIGIN = 'https://github.com/mobilityaccessmodifications/mam-team-management-system.git'
VERSION = '20261023041242'
NAME = 'employee_lifecycle_mail'
MIGRATION = ROOT / 'supabase/migrations' / f'{VERSION}_{NAME}.sql'
SLOTS = {'hr', 'accounts', 'bookkeeper', 'reporting', 'it', 'minor', 'major', 'warehouse', 'equipsy'}
TEAMS = {'minor': ('mam', 'Minor'), 'major': ('mam', 'Major'), 'warehouse': ('mam', 'Warehouse'), 'equipsy': ('equipsy', 'Equipsy')}


def literal(value):
    return "'" + value.replace("'", "''") + "'"


def bundle_hash():
    return hashlib.sha256(Path(__file__).read_bytes() + b'\0' + MIGRATION.read_bytes()).hexdigest()


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *_args, **_kwargs):
        return None


def api(path, body=None):
    request = urllib.request.Request('https://api.supabase.com/v1/projects/' + PROJECT + path,
        headers={'Authorization': 'Bearer ' + os.environ['SUPABASE_ACCESS_TOKEN'], 'Content-Type': 'application/json'},
        data=None if body is None else json.dumps(body).encode())
    with urllib.request.build_opener(NoRedirect).open(request, timeout=90) as response:
        return json.load(response)


def query(sql):
    return api('/database/query', {'query': sql})


def verify_target():
    origin = subprocess.run(['git', 'remote', 'get-url', 'origin'], cwd=ROOT,
        check=True, capture_output=True, text=True).stdout.strip()
    if origin != ORIGIN or os.environ.get('CODEX_COMPANY_PROFILE') != 'mam':
        raise ValueError('Use the verified MAM origin and project credential exec wrapper; markerless worktrees need CODEX_COMPANY_PROFILE=mam.')
    project = api('')
    if project.get('id') != PROJECT or project.get('organization_id') != ORG:
        raise ValueError('MAM Supabase target mismatch')


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError('Duplicate configuration property')
        result[key] = value
    return result


def parse_config(raw):
    entries = json.loads(raw, object_pairs_hook=unique_object)
    if not isinstance(entries, list) or len(entries) != 9:
        raise ValueError('Exactly nine lifecycle recipient configurations required')
    slots = set()
    for entry in entries:
        if not isinstance(entry, dict) or set(entry) != {'slot', 'personId', 'approvedEmail', 'companyKey', 'teamName'}:
            raise ValueError('Unexpected lifecycle configuration fields')
        slot = entry['slot']
        if not isinstance(slot, str) or slot not in SLOTS or slot in slots:
            raise ValueError('Unexpected or duplicate lifecycle recipient slot')
        slots.add(slot)
        address = entry['approvedEmail']
        if not isinstance(address, str) or len(address) > 254 or address != address.lower().strip() \
                or not re.fullmatch(r'[^\s@,;\x00-\x1f\x7f]+@[^\s@,;\x00-\x1f\x7f]+\.[^\s@,;\x00-\x1f\x7f]+', address):
            raise ValueError('Invalid approved lifecycle address')
        if slot == 'it':
            if entry['personId'] is not None:
                raise ValueError('External IT must not bind an employee profile')
        else:
            try:
                if str(uuid.UUID(entry['personId'])) != entry['personId']:
                    raise ValueError()
            except (ValueError, TypeError, AttributeError):
                raise ValueError('Invalid configured lifecycle person identifier') from None
        if (entry['companyKey'], entry['teamName']) != TEAMS.get(slot, (None, None)):
            raise ValueError('Lifecycle company/team mapping differs')
    return sorted(entries, key=lambda entry: entry['slot'])


def read_config(filename, digest):
    path = Path(filename)
    if not path.is_absolute() or path.is_symlink() or not path.is_file() or path.stat().st_mode & 0o077 \
            or path.resolve().is_relative_to(ROOT) or path.stat().st_size > 16_384:
        raise ValueError('Use a private absolute runtime configuration file outside the repository')
    raw = path.read_bytes()
    if hashlib.sha256(raw).hexdigest() != digest:
        raise ValueError('Reviewed lifecycle configuration hash differs')
    return parse_config(raw)


def transaction(body):
    return "begin;set local search_path='';set local lock_timeout='5s';set local statement_timeout='75s';\n" + body + '\ncommit;'


def config_relation(entries):
    return 'jsonb_to_recordset(' + literal(json.dumps(entries, separators=(',', ':'))) + \
        '::jsonb) as c(slot text,"personId" uuid,"approvedEmail" text,"companyKey" text,"teamName" text)'


def expected_config_sql(entries):
    return 'select slot,"personId" person_id,"approvedEmail" approved_email,"companyKey" company_key,"teamName" team_name from ' + config_relation(entries)


def config_matches_sql(entries):
    expected = expected_config_sql(entries)
    return 'not exists((' + expected + ' except all select * from private.employee_lifecycle_mail_recipients) union all (select * from private.employee_lifecycle_mail_recipients except all ' + expected + '))'


def configure_sql(entries):
    return transaction("""select pg_advisory_xact_lock(hashtextextended('mam:directory-role-control',0));
select pg_advisory_xact_lock(hashtextextended('internal_org_people_hierarchy',0));
do $configure$ begin
  if (select enabled from private.employee_lifecycle_mail_control where singleton for update) is distinct from false then
    raise exception 'Disable lifecycle mail before configuring recipients'; end if;
  delete from private.employee_lifecycle_mail_recipients;
  insert into private.employee_lifecycle_mail_recipients(slot,person_id,approved_email,company_key,team_name)
""" + expected_config_sql(entries) + """;
  if (select count(*) from private.employee_lifecycle_mail_recipients)<>9 or exists(select 1 from private.employee_lifecycle_mail_recipients c where not private.employee_lifecycle_mail_recipient_valid(c)) then
    raise exception 'Configured recipients do not match active approved profiles'; end if;
end $configure$;""")


def enable_sql(entries):
    return transaction("""select pg_advisory_xact_lock(hashtextextended('mam:directory-role-control',0));
select pg_advisory_xact_lock(hashtextextended('internal_org_people_hierarchy',0));
lock table private.employee_lifecycle_mail_recipients in share mode;
do $activate$ begin
  if not (""" + config_matches_sql(entries) + """) then raise exception 'Lifecycle activation configuration differs'; end if;
end $activate$;
select public.set_employee_lifecycle_mail_enabled(true) as activation;""")


def installed_exact():
    rows = query('begin read only;select name,statements from supabase_migrations.schema_migrations where version=' + literal(VERSION) + ';commit;')
    if rows and (len(rows) != 1 or rows[0]['name'] != NAME or rows[0]['statements'] != [MIGRATION.read_text()]):
        raise ValueError('Recorded lifecycle migration differs')
    return bool(rows)


def apply_migration():
    if installed_exact():
        return
    source = MIGRATION.read_text()
    if not source.startswith('begin;\n') or source.count('\ncommit;') != 1 or not source.rstrip().endswith('commit;'):
        raise ValueError('Unexpected lifecycle migration transaction')
    history = 'insert into supabase_migrations.schema_migrations(version,name,statements) values (' + \
        literal(VERSION) + ',' + literal(NAME) + ',ARRAY[' + literal(source) + ']);'
    query(source.replace('\ncommit;', '\n' + history + "\nnotify pgrst,'reload schema';\ncommit;"))
    if not installed_exact():
        raise ValueError('Lifecycle migration read-back missing; inspect before retry')
    state = status()
    if state['enabled'] or state['activated_at'] is not None or state['recipient_count'] != 0 or state['outbox_count'] != 0:
        raise ValueError('New lifecycle migration must be disabled and empty')


def status():
    rows = query("""begin read only;
select enabled,activated_at,
 (select count(*) from private.employee_lifecycle_mail_recipients) recipient_count,
 (select count(*) from private.employee_lifecycle_mail_recipients c where not private.employee_lifecycle_mail_recipient_valid(c)) invalid_recipient_count,
 (select count(*) from private.employee_lifecycle_mail_outbox) outbox_count,
 (select schema_hash=private.confirmed_test_purge_schema_hash() from private.confirmed_test_purge_schema where singleton) purge_catalog_current
from private.employee_lifecycle_mail_control where singleton;commit;""")
    if len(rows) != 1:
        raise ValueError('Lifecycle singleton missing')
    return rows[0]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('operation', choices=['hash', 'status', 'apply', 'configure', 'enable', 'disable'])
    parser.add_argument('--reviewed-sha256')
    parser.add_argument('--reviewed-head')
    parser.add_argument('--config')
    parser.add_argument('--config-sha256')
    args = parser.parse_args()
    if args.operation == 'hash':
        print(bundle_hash())
        return
    if args.operation != 'status' and args.reviewed_sha256 != bundle_hash():
        raise ValueError('Reviewed lifecycle release bundle differs')
    if args.operation != 'status':
        head = subprocess.run(['git', 'rev-parse', 'HEAD'], cwd=ROOT, check=True, capture_output=True, text=True).stdout.strip()
        dirty = subprocess.run(['git', 'status', '--porcelain', '--', str(Path(__file__).relative_to(ROOT)), str(MIGRATION.relative_to(ROOT))],
            cwd=ROOT, check=True, capture_output=True, text=True).stdout.strip()
        if args.reviewed_head != head or dirty:
            raise ValueError('Committed lifecycle source must match the reviewed Git head')

    entries = None
    if args.operation in ('configure', 'enable'):
        if not args.config or not args.config_sha256:
            raise ValueError('Reviewed private lifecycle runtime configuration required')
        entries = read_config(args.config, args.config_sha256)
    verify_target()
    if args.operation == 'apply':
        apply_migration()
    elif not installed_exact():
        raise ValueError('Exact lifecycle migration is not installed')
    result = None
    if args.operation == 'configure':
        query(configure_sql(entries))
        if query('begin read only;select ' + config_matches_sql(entries) + ' as matches;commit;') != [{'matches': True}]:
            raise ValueError('Lifecycle recipient configuration read-back differs')
    elif args.operation == 'enable':
        result = query(enable_sql(entries))
    elif args.operation == 'disable':
        result = query(transaction('select public.set_employee_lifecycle_mail_enabled(false) as activation;'))
    state = status()
    if args.operation in ('enable', 'disable', 'configure') and state['enabled'] != (args.operation == 'enable'):
        raise ValueError('Lifecycle activation read-back differs; inspect before retry')
    print(json.dumps({'operation': args.operation, 'version': VERSION, 'verified': True, 'state': state, 'result': result}))


if __name__ == '__main__':
    try:
        main()
    except (urllib.error.URLError, subprocess.CalledProcessError):
        raise SystemExit('MAM provider verification/request unavailable; no automatic retries; inspect before continuing')
    except (ValueError, KeyError) as error:
        raise SystemExit(str(error) if isinstance(error, ValueError) else 'Required MAM release configuration unavailable')
