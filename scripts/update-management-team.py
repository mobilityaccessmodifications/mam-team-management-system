import hashlib
import json
import os
from pathlib import Path
import re
import sys
import urllib.request
import uuid

PROJECT = 'xtwlrjqbusadghavchqm'
ORGANISATION = 'fwlmbmospuwoaosffvmw'
IDENTITIES = {
    '78c636a5ff162d2e5535d65b7410d5d5ce97433f1b194c47d7d925bd905dd9fa',
    '9babadff7685d8a1324ef3ff6ccd28ae4719ead3dfd7f12751f9350e0c02c67e',
    '9c4dc1356aaa312d4f7e953b1b2b43e9c72f7f73c6d2d65e3605bf0e43a7aaa2',
    '4422db73401f19076247d099a6cb5a52fc7b8285f8324eca0171713ab8aa6368',
    '751adf12122120ecbd28e696cbf6a5e75dc9869d62ffa172f022342ef10740cf',
    '58cb03b055e6e94ce570436378bb3313b3dfb5d266d0839f5f8be9f0e747bf94',
}
FINGERPRINT = "md5(jsonb_build_array(to_jsonb(p),to_jsonb(d),to_jsonb(a))::text)"


def literal(value):
    return 'null' if value is None else "'" + value.replace("'", "''") + "'"


def validate(rows):
    if len(rows) != 6 or len({r['id'] for r in rows}) != 6:
        raise ValueError('Exactly six unique identities required')
    for row in rows:
        if str(uuid.UUID(row['id'])) != row['id'] or not re.fullmatch('[0-9a-f]{32}', row['fingerprint']):
            raise ValueError('Invalid identity/version')
        if row['team_name'] not in ('Operation & Accounts', 'Management', 'Major', 'Minor', 'Warehouse', 'Equipsy', None):
            raise ValueError('Unexpected team')


def build_sql(rows):
    validate(rows)
    payload = literal(json.dumps(rows))
    return f"""begin;
set local lock_timeout='5s';
set local statement_timeout='75s';
select pg_advisory_xact_lock(hashtextextended('mam:management-team-update',0));
lock table public.internal_org_people, public.profiles, private.employee_directory_details in share row exclusive mode;
create temporary table management_expected on commit drop as
select * from jsonb_to_recordset({payload}::jsonb) as x(id uuid,fingerprint text,team_name text);
do $$ begin
if not exists(select 1 from supabase_migrations.schema_migrations where version='20260930120000')
or not exists(select 1 from pg_constraint where conrelid='private.employee_directory_details'::regclass and conname='employee_directory_details_canonical_team' and convalidated)
or not exists(select 1 from pg_trigger where tgrelid='private.employee_directory_details'::regclass and tgname='employee_directory_details_sync_employee_check_in_manager_email' and tgenabled='O') then
raise exception 'Required team schema or reminder trigger missing'; end if;
if (select count(*) from management_expected e join public.internal_org_people p on p.id=e.id
join private.employee_directory_details d on d.person_id=p.id left join public.profiles a on a.id=p.auth_user_id
where p.is_active and p.node_kind='person' and p.company_key='mam'
and {FINGERPRINT}=e.fingerprint and d.team_name is not distinct from e.team_name)<>6 then
raise exception 'Identity or version drift'; end if;
end $$;
create temporary table management_before on commit drop as
select p.id,d.version,d.team_name,to_jsonb(p) person,to_jsonb(a) profile,to_jsonb(d)-'team_name'-'updated_at'-'version' detail
from management_expected e join public.internal_org_people p on p.id=e.id
join private.employee_directory_details d on d.person_id=p.id left join public.profiles a on a.id=p.auth_user_id;
alter table private.employee_directory_details disable trigger employee_directory_details_sync_employee_check_in_manager_email;
with changed as (
update private.employee_directory_details d set team_name='Management'
from management_expected e where d.person_id=e.id and d.team_name is distinct from 'Management' returning d.person_id
)
insert into private.employee_directory_audit_events(person_id,event_type,changed_fields)
select person_id,'updated',array['team_name']::text[] from changed;
alter table private.employee_directory_details enable trigger employee_directory_details_sync_employee_check_in_manager_email;
do $$ begin
if (select count(*) from management_before b join public.internal_org_people p on p.id=b.id
join private.employee_directory_details d on d.person_id=p.id left join public.profiles a on a.id=p.auth_user_id
where d.team_name='Management' and to_jsonb(p)=b.person and to_jsonb(a) is not distinct from b.profile
and d.version=b.version+case when b.team_name='Management' then 0 else 1 end
and to_jsonb(d)-'team_name'-'updated_at'-'version'=b.detail)<>6 then raise exception 'Non-team data changed'; end if;
end $$;
commit;"""


def api(path, body=None):
    request = urllib.request.Request('https://api.supabase.com/v1/projects/' + PROJECT + path,
        headers={'Authorization': 'Bearer ' + os.environ['SUPABASE_ACCESS_TOKEN'], 'Content-Type': 'application/json', 'User-Agent': 'supabase-cli/2.54.11'},
        data=None if body is None else json.dumps(body).encode())
    with urllib.request.urlopen(request, timeout=90) as response:
        return json.load(response)


def query(sql):
    return api('/database/query', {'query': sql})


def snapshot(ids):
    return query(f"select p.id,{FINGERPRINT} fingerprint,d.team_name from public.internal_org_people p join private.employee_directory_details d on d.person_id=p.id left join public.profiles a on a.id=p.auth_user_id where p.is_active and p.node_kind='person' and p.company_key='mam' and p.id in (" + ','.join(literal(i) for i in ids) + ') order by p.id')


def main(args):
    if len(args) < 2 or args[0] not in ('prepare', 'inspect', 'apply'):
        raise ValueError('Use prepare <outside-repo-plan.json> <six IDs> --confirm-steve-is-steven --confirm-keiran-is-kieran; inspect <plan>; apply <plan> <plan-sha256> <helper-sha256>')
    mode, filename = args[:2]
    path = Path(filename).resolve()
    root = Path(__file__).resolve().parents[1]
    if path.is_relative_to(root):
        raise ValueError('Plan must remain outside repository')
    if mode == 'prepare':
        if len(args) != 10 or set(args[-2:]) != {'--confirm-steve-is-steven', '--confirm-keiran-is-kieran'}:
            raise ValueError('Both name aliases require explicit owner confirmation')
        ids = args[2:8]
        rows = None
        if path.exists():
            raise ValueError('Plan already exists')
    else:
        raw = path.read_bytes()
        if mode == 'apply' and (len(args) != 4 or hashlib.sha256(raw).hexdigest() != args[2] or hashlib.sha256(Path(__file__).read_bytes()).hexdigest() != args[3]):
            raise ValueError('Reviewed plan/helper differs')
        rows = json.loads(raw)
        validate(rows)
        ids = [r['id'] for r in rows]
    if len(ids) != 6 or {hashlib.sha256(i.encode()).hexdigest() for i in ids} != IDENTITIES:
        raise ValueError('Only the six reviewed candidate identities are permitted')
    project = api('')
    if project['id'] != PROJECT or project['organization_id'] != ORGANISATION:
        raise ValueError('MAM target mismatch')
    if mode == 'prepare':
        rows = snapshot(ids)
        validate(rows)
        with path.open('x') as output:
            os.chmod(path, 0o600)
            json.dump(rows, output, sort_keys=True)
        print(json.dumps({'plan_sha256': hashlib.sha256(path.read_bytes()).hexdigest(), 'identities': len(rows)}))
    elif mode == 'apply':
        query(build_sql(rows))
        actual = snapshot(ids)
        if len(actual) != 6 or any(r['team_name'] != 'Management' for r in actual):
            raise ValueError('Post-commit verification failed; inspect before retry')
        print(json.dumps({'verified_management': 6}))
    else:
        actual = snapshot(ids)
        print(json.dumps({'identities': len(actual), 'cas_matches': actual == rows, 'management_count': sum(r['team_name'] == 'Management' for r in actual)}))


if __name__ == '__main__':
    try:
        main(sys.argv[1:])
    except (ValueError, KeyError, OSError) as error:
        raise SystemExit(type(error).__name__ + ': ' + (str(error) if isinstance(error, ValueError) else 'Operation failed; no confidential response printed'))
