import importlib.util
import json
import subprocess

spec = importlib.util.spec_from_file_location('management', 'scripts/update-management-team.py')
assert spec is not None and spec.loader is not None
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)


def sql(text, succeeds=True):
    result = subprocess.run(['psql', '-X', '-v', 'ON_ERROR_STOP=1', '-h', '127.0.0.1', '-p', '55483', '-U', 'postgres', '-d', 'management_team_test', '-At'], input=text, text=True, capture_output=True)
    assert (result.returncode == 0) == succeeds, result.stderr
    return result.stdout


sql("""
create schema private;
create schema supabase_migrations;
create table supabase_migrations.schema_migrations(version text);
insert into supabase_migrations.schema_migrations values('20260930120000');
create table public.profiles(id uuid primary key,app_role text);
create table public.internal_org_people(id uuid primary key,auth_user_id uuid,is_active boolean,node_kind text,company_key text);
create table private.employee_directory_details(person_id uuid primary key,team_name text,version bigint default 1,updated_at timestamptz default now(),work_email text,
constraint employee_directory_details_canonical_team check(team_name in ('Major','Management')));
create table private.employee_directory_audit_events(person_id uuid,event_type text,changed_fields text[]);
create function private.fail_reminder() returns trigger language plpgsql as $$ begin raise exception 'Reminder touched'; end $$;
create trigger employee_directory_details_sync_employee_check_in_manager_email after update on private.employee_directory_details for each row execute function private.fail_reminder();
create function private.bump_version() returns trigger language plpgsql as $$ begin new.version=old.version+1; new.updated_at=clock_timestamp(); return new; end $$;
create trigger bump_version before update on private.employee_directory_details for each row execute function private.bump_version();
insert into public.profiles select ('00000000-0000-4000-8000-'||lpad(i::text,12,'0'))::uuid,case when i=1 then 'system_admin' else 'manager' end from generate_series(1,7) i;
insert into public.internal_org_people select id,id,true,'person','mam' from public.profiles;
insert into private.employee_directory_details(person_id,team_name,work_email) select id,'Major','synthetic@example.test' from public.profiles;
""")
rows = json.loads(sql(f"select json_agg(row_to_json(r)) from (select p.id,{helper.FINGERPRINT} fingerprint,d.team_name from public.internal_org_people p join private.employee_directory_details d on d.person_id=p.id left join public.profiles a on a.id=p.auth_user_id order by p.id limit 6) r;"))
wrong = [dict(row) for row in rows]
wrong[0]['fingerprint'] = '0'*32
sql(helper.build_sql(wrong), False)
assert sql("select count(*) from private.employee_directory_audit_events;").strip() == '0'
sql(helper.build_sql(rows))
assert sql("select count(*) from private.employee_directory_details where team_name='Management';").strip() == '6'
assert sql("select count(*) from private.employee_directory_details where team_name='Major';").strip() == '1'
assert sql("select count(*) from private.employee_directory_details where version=2;").strip() == '6'
assert sql("select count(*) from public.profiles where app_role='system_admin';").strip() == '1'
assert sql("select count(*) from private.employee_directory_audit_events where changed_fields=array['team_name']::text[];").strip() == '6'
sql(helper.build_sql(rows), False)
assert sql("select count(*) from private.employee_directory_audit_events;").strip() == '6'
assert sql("select tgenabled from pg_trigger where tgname='employee_directory_details_sync_employee_check_in_manager_email';").strip() == 'O'
print('Synthetic SQL verified: six-only audited update, version increments, stale CAS rollback, roles preserved, reminder trigger restored; seventh person untouched')
