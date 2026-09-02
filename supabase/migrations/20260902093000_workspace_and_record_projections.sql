begin;

do $$
begin
  perform pg_advisory_xact_lock(
    hashtextextended('mam:workspace-and-record-projections:20260902', 0)
  );

  if to_regprocedure('public.current_portal_account()') is null
    or to_regprocedure('public.can_manage_portal_accounts()') is null
    or to_regprocedure('public.can_access_non_roster_system_admin_workspace()') is null
    or to_regprocedure('public.can_view_employee_check_in_workspace()') is null
    or to_regprocedure('public.can_view_employee_directory()') is null
    or to_regprocedure('public.can_change_employee_view()') is null
    or to_regprocedure('public.can_view_subscription_register()') is null
    or to_regprocedure('public.can_access_own_subscriptions()') is null
    or to_regprocedure('private.can_view_archived_employee_profiles()') is null
    or to_regprocedure('private.resolve_internal_org_employee_manager(uuid)') is null
    or to_regprocedure('private.it_asset_register_projection()') is null
    or to_regprocedure('private.is_system_portal_account_admin()') is null
    or to_regprocedure('private.normalise_employee_directory_text(text,integer,boolean,text)') is null
    or to_regprocedure('private.normalise_employee_directory_email(text,text)') is null then
    raise exception 'Workspace projection prerequisites are missing.' using errcode = '55000';
  end if;
end;
$$;

-- One authenticated RPC replaces eight independent page-start capability
-- roundtrips while preserving each database-owned predicate.
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

comment on function public.get_portal_workspace_capabilities() is
  'Returns the active account identity and all page-start capabilities in one authenticated database roundtrip.';

-- Direct single-record projection used after HR directory mutations. It keeps
-- the same private DTO and authorization as the archive-aware list without
-- reloading every employee merely to find one row.
create function public.get_employee_directory_record_with_archive_visibility(
  p_person_id uuid
)
returns table (
  person_id uuid,
  person_version bigint,
  detail_version bigint,
  company_key text,
  is_active boolean,
  first_name text,
  last_name text,
  full_name text,
  position_title text,
  team_name text,
  manager_id uuid,
  manager_name text,
  work_email text,
  personal_email text,
  phone text,
  country text,
  address text,
  date_of_birth date,
  started_date date,
  scheduled_employment_end_date date,
  archive_reason text,
  laptop_supplied text,
  laptop_id text,
  mouse_id text,
  keyboard_id text,
  asset_tags text[]
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not private.can_view_archived_employee_profiles() then
    raise exception 'Only the active System Admin can access employee directory records.'
      using errcode = '42501';
  end if;

  if p_person_id is null then
    raise exception 'The employee record is invalid.' using errcode = '22023';
  end if;

  return query
  select
    person.id,
    person.version,
    coalesce(detail.version, 0::bigint),
    person.company_key,
    person.is_active,
    detail.first_name,
    detail.last_name,
    person.full_name,
    person.position_title,
    detail.team_name,
    manager.manager_id,
    manager.manager_name,
    detail.work_email,
    detail.personal_email,
    detail.phone,
    detail.country,
    detail.address,
    detail.date_of_birth,
    person.started_date,
    detail.scheduled_employment_end_date,
    detail.archive_reason,
    detail.laptop_supplied,
    detail.laptop_id,
    detail.mouse_id,
    detail.keyboard_id,
    coalesce(detail.asset_tags, array[]::text[])
  from public.internal_org_people person
  left join private.employee_directory_details detail
    on detail.person_id = person.id
  left join lateral private.resolve_internal_org_employee_manager(person.id) manager on true
  where person.id = p_person_id
    and person.node_kind = 'person'
  limit 1;
end;
$$;

comment on function public.get_employee_directory_record_with_archive_visibility(uuid) is
  'Returns one active or archived private employee-directory DTO to the active System Admin.';

-- Direct single-device projection used after create/reassign. The underlying
-- private projection already owns custody dates and retired-row filtering.
create function public.get_it_asset_with_custody(
  p_asset_id uuid
)
returns table (
  asset_id uuid,
  asset_code text,
  barcode_value text,
  asset_type text,
  manufacturer text,
  model text,
  serial_number text,
  asset_status text,
  assigned_person_id uuid,
  assigned_person_name text,
  assigned_person_title text,
  assigned_person_team text,
  assigned_on date,
  last_returned_on date,
  created_at timestamptz,
  version bigint
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not private.is_system_portal_account_admin() then
    raise exception 'You do not have permission to access IT assets.' using errcode = '42501';
  end if;

  if p_asset_id is null then
    raise exception 'The device record is invalid.' using errcode = '22023';
  end if;

  return query
  select projection.*
  from private.it_asset_register_projection() projection
  where projection.asset_id = p_asset_id
  limit 1;
end;
$$;

comment on function public.get_it_asset_with_custody(uuid) is
  'Returns one active System-Admin-only IT asset DTO with current and latest custody dates.';

-- Require a domain suffix at both application and database boundaries. These
-- work-email values feed notification routing, so accepting `name@host` would
-- create a durable but undeliverable address through direct RPC calls.
create or replace function private.normalise_employee_directory_email(
  p_value text,
  p_field_label text
)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_value text := private.normalise_employee_directory_text(p_value, 254, false, p_field_label);
begin
  if v_value is not null
    and v_value !~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$' then
    raise exception '% must be a valid email address.', p_field_label using errcode = '22023';
  end if;

  return v_value;
end;
$$;

revoke all on function public.get_portal_workspace_capabilities()
  from public, anon, authenticated;
revoke all on function public.get_employee_directory_record_with_archive_visibility(uuid)
  from public, anon, authenticated;
revoke all on function public.get_it_asset_with_custody(uuid)
  from public, anon, authenticated;

grant execute on function public.get_portal_workspace_capabilities()
  to authenticated;
grant execute on function public.get_employee_directory_record_with_archive_visibility(uuid)
  to authenticated;
grant execute on function public.get_it_asset_with_custody(uuid)
  to authenticated;

commit;
