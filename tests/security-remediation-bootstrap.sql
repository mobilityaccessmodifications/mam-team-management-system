-- ONLY a new disposable PostgreSQL database; never run against a portal database.
\set ON_ERROR_STOP on
do $$ begin
  if exists(select 1 from pg_namespace where nspname in ('private','auth')) then
    raise exception 'Use a NEW disposable database, not an application database';
  end if;
  if not exists(select 1 from pg_roles where rolname='anon') then create role anon; end if;
  if not exists(select 1 from pg_roles where rolname='authenticated') then create role authenticated; end if;
  if not exists(select 1 from pg_roles where rolname='service_role') then create role service_role; end if;
end $$;
create schema private;
create schema auth;
create function auth.uid() returns uuid language sql as $$ select nullif(current_setting('test.actor',true),'')::uuid $$;
create table public.internal_org_people(id uuid primary key,full_name text,company_key text);
create table public.leave_requests(id uuid primary key,employee_person_id uuid,record_origin text default 'portal',status text,
  request_type_label text default 'Annual leave',start_date date default '2026-09-14',end_date date default '2026-09-15',
  start_time time,end_time time,business_days numeric default 2,hours numeric,reason text,manager_note text);
create table public.leave_request_events(leave_request_id uuid,event_type text);
create table private.leave_balance_approvals(request_id uuid);
create function public.leave_notification_was_approved(p_request_id uuid) returns boolean language sql stable as $$
  select exists(select 1 from public.leave_request_events where leave_request_id=p_request_id and event_type='approved')
    or exists(select 1 from private.leave_balance_approvals where request_id=p_request_id)
$$;
create table private.subscription_credential_access_grants(auth_user_id uuid primary key,person_id uuid,granted_by uuid);
create function public.resolve_leave_notification_manager(uuid) returns table(manager_email text)
  language sql as $$ select 'manager@example.test'::text $$;
create function public.resolve_leave_notification_employee_recipients(uuid) returns table(employee_emails text[])
  language sql as $$ select array['employee@example.test'] $$;
