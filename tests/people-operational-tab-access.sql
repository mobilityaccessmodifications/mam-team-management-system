-- Disposable permission-boundary test for People operational tabs and the
-- employee-safe organisation projection.
\set ON_ERROR_STOP on

do $$
begin
  assert current_database() = 'people_operational_access_test', 'Synthetic database only';
end;
$$;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated; end if;
end;
$$;

create schema auth;
create schema private;
grant usage on schema auth, public to authenticated;

create function auth.uid()
returns uuid
language sql
stable
as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
$$;

create function auth.jwt()
returns jsonb
language sql
stable
as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb, '{}'::jsonb);
$$;

create table public.profiles (
  id uuid primary key,
  app_role text not null,
  account_status text not null default 'active',
  login_name text
);

create table public.internal_org_people (
  id uuid primary key,
  auth_user_id uuid unique,
  node_kind text not null,
  parent_id uuid references public.internal_org_people (id),
  is_active boolean not null default true
);

alter table public.internal_org_people enable row level security;
alter table public.internal_org_people force row level security;
grant select on public.internal_org_people to authenticated;

create function private.has_current_portal_access()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.profiles profile
    where profile.id = (select auth.uid())
      and profile.account_status = 'active'
      and profile.login_name is not null
  );
$$;

create function private.is_active_linked_internal_employee(p_user_id uuid default null)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.profiles profile
    join public.internal_org_people person on person.auth_user_id = profile.id
    where profile.id = coalesce(p_user_id, (select auth.uid()))
      and profile.account_status = 'active'
      and profile.login_name is not null
      and person.node_kind = 'person'
      and person.is_active
  );
$$;

create function private.is_system_portal_account_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.profiles profile
    where profile.id = (select auth.uid())
      and profile.app_role = 'system_admin'
      and profile.account_status = 'active'
      and profile.login_name is not null
  );
$$;

create function public.current_portal_account()
returns table (auth_user_id uuid, person_id uuid, account_status text)
language sql
stable
security definer
set search_path = ''
as $$
  select profile.id, person.id, profile.account_status
  from public.profiles profile
  left join public.internal_org_people person
    on person.auth_user_id = profile.id
    and person.node_kind = 'person'
    and person.is_active
  where profile.id = (select auth.uid())
    and profile.account_status = 'active'
    and profile.login_name is not null;
$$;

create function public.can_manage_portal_accounts() returns boolean language sql stable security definer set search_path = '' as $$ select private.is_system_portal_account_admin(); $$;
create function public.can_access_non_roster_system_admin_workspace() returns boolean language sql stable security definer set search_path = '' as $$ select private.is_system_portal_account_admin(); $$;
create function public.can_view_employee_check_in_workspace() returns boolean language sql stable security definer set search_path = '' as $$ select private.is_system_portal_account_admin(); $$;
create function public.can_view_employee_directory() returns boolean language sql stable security definer set search_path = '' as $$ select private.is_system_portal_account_admin(); $$;
create function public.can_change_employee_view() returns boolean language sql stable security definer set search_path = '' as $$ select private.is_system_portal_account_admin(); $$;
create function public.can_view_subscription_register() returns boolean language sql stable security definer set search_path = '' as $$ select private.is_system_portal_account_admin(); $$;
create function public.can_access_own_subscriptions() returns boolean language sql stable security definer set search_path = '' as $$ select private.has_current_portal_access(); $$;

create function public.get_portal_workspace_capabilities()
returns table (
  auth_user_id uuid,
  person_id uuid,
  account_status text,
  can_manage_accounts boolean,
  can_access_non_roster_system_admin_workspace boolean,
  can_view_check_in_workspace boolean,
  can_view_employee_directory boolean,
  can_change_employee_view boolean,
  can_view_subscription_register boolean,
  can_access_own_subscriptions boolean
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    account.auth_user_id,
    account.person_id,
    account.account_status,
    public.can_manage_portal_accounts(),
    public.can_access_non_roster_system_admin_workspace(),
    public.can_view_employee_check_in_workspace(),
    public.can_view_employee_directory(),
    public.can_change_employee_view(),
    public.can_view_subscription_register(),
    public.can_access_own_subscriptions()
  from public.current_portal_account() account;
$$;

create policy internal_org_people_select_member
  on public.internal_org_people for select
  to authenticated
  using (is_active);

insert into public.profiles (id, app_role, login_name) values
  ('10000000-0000-4000-8000-000000000001', 'manager', 'manager'),
  ('10000000-0000-4000-8000-000000000002', 'employee', 'employee'),
  ('10000000-0000-4000-8000-000000000003', 'employee', 'sibling'),
  ('10000000-0000-4000-8000-000000000004', 'manager', 'other-manager'),
  ('10000000-0000-4000-8000-000000000005', 'employee', 'outsider'),
  ('10000000-0000-4000-8000-000000000006', 'hr', 'hr'),
  ('10000000-0000-4000-8000-000000000007', 'system_admin', 'super-admin'),
  ('10000000-0000-4000-8000-000000000008', 'system_admin', 'penny'),
  ('10000000-0000-4000-8000-000000000009', 'system_admin', 'steven'),
  ('10000000-0000-4000-8000-000000000010', 'manager', 'unlinked-manager');

insert into public.internal_org_people (id, auth_user_id, node_kind, parent_id) values
  ('20000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'person', null),
  ('20000000-0000-4000-8000-000000000002', null, 'org_unit', '20000000-0000-4000-8000-000000000001'),
  ('20000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000002', 'person', '20000000-0000-4000-8000-000000000002'),
  ('20000000-0000-4000-8000-000000000004', '10000000-0000-4000-8000-000000000003', 'person', '20000000-0000-4000-8000-000000000002'),
  ('20000000-0000-4000-8000-000000000005', '10000000-0000-4000-8000-000000000004', 'person', null),
  ('20000000-0000-4000-8000-000000000006', '10000000-0000-4000-8000-000000000005', 'person', '20000000-0000-4000-8000-000000000005'),
  ('20000000-0000-4000-8000-000000000007', '10000000-0000-4000-8000-000000000006', 'person', '20000000-0000-4000-8000-000000000005'),
  ('20000000-0000-4000-8000-000000000008', '10000000-0000-4000-8000-000000000008', 'person', null),
  ('20000000-0000-4000-8000-000000000009', '10000000-0000-4000-8000-000000000009', 'person', null);

\ir ../supabase/migrations/20260917123501_people_operational_tab_access.sql

create or replace function pg_temp.set_test_actor(p_user_id uuid)
returns void
language plpgsql
as $$
declare
  v_role text;
begin
  select profile.app_role into strict v_role
  from public.profiles profile
  where profile.id = p_user_id;

  perform set_config('request.jwt.claim.sub', p_user_id::text, false);
  perform set_config(
    'request.jwt.claims',
    jsonb_build_object(
      'sub', p_user_id::text,
      'is_anonymous', false,
      'app_metadata', jsonb_build_object('org_role', v_role)
    )::text,
    false
  );
end;
$$;

select pg_temp.set_test_actor('10000000-0000-4000-8000-000000000002');
set role authenticated;
do $$
declare
  visible_ids uuid[];
  capability record;
begin
  assert not public.can_view_organisation_chart(), 'Ordinary employee must not receive Organisation';
  assert not public.can_view_subscription_register(), 'Ordinary employee must not receive the company subscription register';

  select array_agg(person.id order by person.id)
  into visible_ids
  from public.internal_org_people person;

  assert visible_ids = array[
    '20000000-0000-4000-8000-000000000002'::uuid,
    '20000000-0000-4000-8000-000000000003'::uuid,
    '20000000-0000-4000-8000-000000000004'::uuid
  ], 'Employee public organisation rows must stay inside the immediate team branch';

  select * into strict capability from public.get_portal_workspace_capabilities();
  assert capability.can_view_organisation_chart is false, 'Page-start DTO must deny employee Organisation';
  assert capability.can_view_subscription_register is false, 'Page-start DTO must deny employee Subscriptions';
end;
$$;
reset role;

select pg_temp.set_test_actor('10000000-0000-4000-8000-000000000001');
set role authenticated;
do $$
begin
  assert public.can_view_organisation_chart(), 'Active linked Manager must receive Organisation';
  assert public.can_view_subscription_register(), 'Active linked Manager must receive read-only Subscriptions';
  assert (select count(*) from public.internal_org_people) = 9, 'Manager must receive the complete active organisation projection';
end;
$$;
reset role;

select pg_temp.set_test_actor('10000000-0000-4000-8000-000000000006');
set role authenticated;
do $$
begin
  assert public.can_view_organisation_chart(), 'Active linked HR must receive Organisation';
  assert public.can_view_subscription_register(), 'Active linked HR must receive read-only Subscriptions';
end;
$$;
reset role;

select pg_temp.set_test_actor('10000000-0000-4000-8000-000000000007');
set role authenticated;
do $$
begin
  assert public.can_view_organisation_chart(), 'Non-roster Super Admin must receive Organisation';
  assert public.can_view_subscription_register(), 'Non-roster Super Admin must receive Subscriptions';
end;
$$;
reset role;

select pg_temp.set_test_actor('10000000-0000-4000-8000-000000000008');
set role authenticated;
do $$
begin
  assert public.can_view_organisation_chart(), 'Penny controlled System Admin role must receive Organisation';
  assert public.can_view_subscription_register(), 'Penny controlled System Admin role must receive Subscriptions';
end;
$$;
reset role;

select pg_temp.set_test_actor('10000000-0000-4000-8000-000000000009');
set role authenticated;
do $$
begin
  assert public.can_view_organisation_chart(), 'Steven controlled System Admin role must receive Organisation';
  assert public.can_view_subscription_register(), 'Steven controlled System Admin role must receive Subscriptions';
end;
$$;
reset role;

do $$
begin
  assert not has_function_privilege('authenticated', 'private.can_view_people_operational_tabs()', 'EXECUTE'), 'Private role helper must not be callable by staff';
  assert not has_function_privilege('authenticated', 'private.list_current_employee_people_branch_node_ids()', 'EXECUTE'), 'Private branch helper must not be callable by staff';
end;
$$;

select pg_temp.set_test_actor('10000000-0000-4000-8000-000000000010');
set role authenticated;
do $$
begin
  assert not public.can_view_organisation_chart(), 'Unlinked Manager must fail closed';
  assert not public.can_view_subscription_register(), 'Unlinked Manager must not receive Subscriptions';
end;
$$;
reset role;
