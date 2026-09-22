-- Supplements the existing minimal bridge harness; no production data.
create or replace function auth.uid() returns uuid language sql as $$
  select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid;
$$;
create or replace function auth.jwt() returns jsonb language sql as $$
  select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb;
$$;
alter table public.profiles add column app_role text not null default 'employee';
alter table public.profiles add column credentials_valid_after timestamptz not null default '-infinity';
create table private.portal_account_admins(auth_user_id uuid,revoked_at timestamptz);
alter table public.internal_org_people add column version bigint not null default 1;
alter table public.internal_org_people add column position_title text;
alter table public.internal_org_people add column parent_id uuid;
alter table public.internal_org_people add column updated_by uuid;
alter table private.employee_directory_details add column version bigint not null default 1;
alter table private.employee_directory_details add column first_name text;
alter table private.employee_directory_details add column last_name text;
alter table private.employee_directory_details add column team_name text;
alter table private.employee_directory_details add column work_email text;
alter table private.employee_directory_details add column personal_email text;
alter table private.employee_directory_details add column date_of_birth date;
alter table private.employee_directory_details add column created_by uuid;
alter table private.employee_directory_details add column updated_by uuid;
create table private.employee_directory_audit_events(person_id uuid,actor_user_id uuid,
  event_type text constraint employee_directory_audit_events_event_type_check check(event_type in ('created','updated')),
  changed_fields text[]);
-- Membership fixture only. The actual production self-edit RPC is loaded below.
create function private.is_internal_org_member() returns boolean language sql as $$
  select exists(select 1 from public.internal_org_people where auth_user_id=auth.uid() and is_active);
$$;
-- Drop the old bridge-only stub before installing the real self-profile helper.
drop function private.current_active_portal_employee_id();
grant usage on schema auth,private to authenticated,anon,service_role;
insert into public.profiles(id,login_name,account_status,app_role) values
 ('20000000-0000-4000-8000-000000000002','synthetic-two','active','employee'),
 ('20000000-0000-4000-8000-000000000003','synthetic-other-company','active','employee'),
 ('20000000-0000-4000-8000-000000000004','synthetic-archived','active','employee'),
 ('20000000-0000-4000-8000-000000000005','synthetic-disabled','disabled','employee'),
 ('20000000-0000-4000-8000-000000000099','synthetic-system-admin','active','system_admin');
insert into public.internal_org_people(id,auth_user_id,company_key,is_active,node_kind,full_name) values
 ('10000000-0000-4000-8000-000000000002','20000000-0000-4000-8000-000000000002','mam',true,'person','Synthetic Coworker'),
 ('10000000-0000-4000-8000-000000000003','20000000-0000-4000-8000-000000000003','equipsy',true,'person','Synthetic Other Company'),
 ('10000000-0000-4000-8000-000000000004','20000000-0000-4000-8000-000000000004','mam',false,'person','Synthetic Archived'),
 ('10000000-0000-4000-8000-000000000005','20000000-0000-4000-8000-000000000005','mam',true,'person','Synthetic Disabled');
insert into private.employee_directory_details(person_id,phone,country,employment_type)
 values('10000000-0000-4000-8000-000000000002','0400000002','Australia','full_time');
