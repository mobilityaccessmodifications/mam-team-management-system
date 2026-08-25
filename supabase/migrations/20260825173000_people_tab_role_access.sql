begin;

do $$
begin
  perform pg_advisory_xact_lock(
    hashtextextended('mam:people-tab-role-access:20260825', 0)
  );

  if to_regclass('public.profiles') is null
    or to_regclass('public.internal_org_people') is null
    or to_regprocedure('private.is_active_portal_account()') is null
    or to_regprocedure('private.is_active_linked_internal_employee(uuid)') is null
    or to_regprocedure('private.has_current_portal_access()') is null
    or to_regprocedure('private.is_system_portal_account_admin()') is null then
    raise exception 'People tab role-access prerequisites are missing.' using errcode = '55000';
  end if;
end;
$$;

-- A controlled System Admin is the only account-management and organisation
-- editor. Do not retain the legacy HR allowlist or portal-admin enrolment as
-- an alternate write path: it would let a role outside the approved admin
-- roster bypass the People UI.
create or replace function private.is_portal_account_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select (select auth.uid()) is not null
    and coalesce(((select auth.jwt()) ->> 'is_anonymous')::boolean, false) = false
    and private.is_active_portal_account()
    and exists (
      select 1
      from public.profiles profile
      where profile.id = (select auth.uid())
        and profile.app_role = 'system_admin'
        and profile.account_status = 'active'
        and profile.login_name is not null
    );
$$;

comment on function private.is_portal_account_admin() is
  'True only for the current active System Admin portal account; it is the write boundary for account and organisation administration.';

create or replace function private.is_system_portal_account_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.is_portal_account_admin();
$$;

comment on function private.is_system_portal_account_admin() is
  'True only for the current active, controlled System Admin portal account.';

-- Older People RPCs consistently delegate their sensitive-data check to this
-- predicate. Make that legacy boundary exact System Admin as well, so a
-- previous HR allowlist or an Auth claim can never bypass the new tab and
-- mutation policy through a direct Supabase RPC.
create or replace function private.is_internal_org_hr()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.is_system_portal_account_admin();
$$;

comment on function private.is_internal_org_hr() is
  'Legacy HR predicate retained for compatibility; it is now true only for the current active System Admin portal account.';

create or replace function public.can_manage_portal_accounts()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.is_system_portal_account_admin();
$$;

comment on function public.can_manage_portal_accounts() is
  'Returns whether the current active System Admin may manage portal login accounts.';

create or replace function public.can_edit_internal_org()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.is_system_portal_account_admin();
$$;

comment on function public.can_edit_internal_org() is
  'Returns whether the current active System Admin may edit the organisation tree.';

-- Full directory records include private contact, address, asset and
-- lifecycle fields, so their existing management capability remains System
-- Admin-only. Managers receive a separate public-org directory projection.
create or replace function private.can_view_archived_employee_profiles()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.is_system_portal_account_admin();
$$;

create or replace function public.can_manage_employee_directory()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.is_system_portal_account_admin();
$$;

comment on function public.can_manage_employee_directory() is
  'Returns whether the current active System Admin may read and edit private employee directory records.';

-- Managers can open the safe Directory tab, but this capability never grants
-- access to the private employee-directory RPCs. The UI uses only the public
-- organisation projection for this tab.
create or replace function public.can_view_employee_directory()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.is_system_portal_account_admin()
    or (
      private.has_current_portal_access()
      and private.is_active_linked_internal_employee((select auth.uid()))
      and exists (
        select 1
        from public.profiles profile
        where profile.id = (select auth.uid())
          and profile.app_role = 'manager'
          and profile.account_status = 'active'
          and profile.login_name is not null
      )
    );
$$;

comment on function public.can_view_employee_directory() is
  'Returns whether the current active System Admin or manager may view the safe public employee directory.';

-- Scope and role are intentionally different concepts. A manager without a
-- current subordinate must still be allowed to open Check-ins and Tasks, with
-- an empty result. Individual record visibility remains governed by
-- `private.list_visible_employee_check_in_person_ids()`, which returns only
-- active descendants (or the System Admin global scope).
create or replace function private.has_configured_global_employee_check_in_access(
  p_user_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_user_id is not null
    and exists (
      select 1
      from public.profiles profile
      where profile.id = p_user_id
        and profile.app_role = 'system_admin'
        and profile.account_status = 'active'
        and profile.login_name is not null
    );
$$;

create or replace function private.has_global_employee_check_in_scope()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.has_current_portal_access()
    and (select auth.uid()) is not null
    and coalesce(((select auth.jwt()) ->> 'is_anonymous')::boolean, false) = false
    and private.has_configured_global_employee_check_in_access((select auth.uid()));
$$;

create or replace function private.has_employee_check_in_workspace_access()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.has_global_employee_check_in_scope()
    or (
      private.has_current_portal_access()
      and (select auth.uid()) is not null
      and coalesce(((select auth.jwt()) ->> 'is_anonymous')::boolean, false) = false
      and private.is_active_linked_internal_employee((select auth.uid()))
      and exists (
        select 1
        from public.profiles profile
        where profile.id = (select auth.uid())
          and profile.app_role = 'manager'
          and profile.account_status = 'active'
          and profile.login_name is not null
      )
    );
$$;

comment on function private.has_configured_global_employee_check_in_access(uuid) is
  'Checks whether a supplied active System Admin has global Check-in scope. Manager grants never create global scope.';
comment on function private.has_global_employee_check_in_scope() is
  'Checks whether the current active System Admin has global Check-in scope.';
comment on function private.has_employee_check_in_workspace_access() is
  'Checks whether the active caller is a System Admin or manager; a manager without current reports receives an empty scoped workspace.';

-- Change profile needs a role projection for visual testing. Keep the role
-- lookup separately protected and return only one of the approved display
-- roles; it intentionally returns employee when the target lacks an active
-- linked account or a recognised application role.
create or replace function public.get_selected_employee_profile_access_role_for_preview(
  p_person_id uuid
)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_access_role text;
begin
  if not private.is_system_portal_account_admin() then
    raise exception 'Only the Super Admin can preview an employee profile role.'
      using errcode = '42501';
  end if;

  if p_person_id is null then
    raise exception 'Choose an employee profile.' using errcode = '22004';
  end if;

  select case
    when profile.app_role = 'system_admin'
      and profile.account_status = 'active'
      and profile.login_name is not null then 'system_admin'
    when profile.app_role = 'manager'
      and profile.account_status = 'active'
      and profile.login_name is not null then 'manager'
    else 'employee'
  end
  into v_access_role
  from public.internal_org_people person
  left join public.profiles profile on profile.id = person.auth_user_id
  where person.id = p_person_id
    and person.node_kind = 'person'
    and person.is_active;

  if not found then
    raise exception 'The selected employee profile is unavailable.' using errcode = '23503';
  end if;

  return coalesce(v_access_role, 'employee');
end;
$$;

comment on function public.get_selected_employee_profile_access_role_for_preview(uuid) is
  'Returns the selected active employee display role only to the Super Admin Change profile control.';

-- The tree mutation RPCs are exposed to authenticated clients, so their
-- function bodies must enforce the same System Admin-only rule rather than
-- relying on a hidden tab or the older HR allowlist.
create or replace function public.create_internal_org_node(
  p_company_key text,
  p_node_kind text,
  p_position_title text,
  p_full_name text default null,
  p_parent_id uuid default null,
  p_started_date date default null,
  p_sort_order integer default 0
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_node public.internal_org_people;
begin
  if not private.is_system_portal_account_admin() then
    raise exception 'Only a System Admin can edit the organisation tree.'
      using errcode = '42501';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('internal_org_people_hierarchy', 0));

  insert into public.internal_org_people (
    company_key, node_kind, position_title, full_name, parent_id,
    started_date, sort_order, auth_user_id, created_by, updated_by
  )
  values (
    lower(btrim(p_company_key)),
    lower(btrim(p_node_kind)),
    btrim(p_position_title),
    case when lower(btrim(p_node_kind)) = 'person' then nullif(btrim(p_full_name), '') else null end,
    p_parent_id,
    case when lower(btrim(p_node_kind)) = 'person' then p_started_date else null end,
    p_sort_order,
    null,
    (select auth.uid()),
    (select auth.uid())
  )
  returning * into v_node;

  return v_node.id;
end;
$$;

create or replace function public.update_internal_org_node(
  p_node_id uuid,
  p_company_key text,
  p_node_kind text,
  p_position_title text,
  p_full_name text default null,
  p_parent_id uuid default null,
  p_started_date date default null,
  p_sort_order integer default 0,
  p_is_active boolean default true,
  p_expected_version bigint default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_node public.internal_org_people%rowtype;
  v_updated_node public.internal_org_people%rowtype;
  v_node_kind text := lower(btrim(p_node_kind));
  v_company_key text := lower(btrim(p_company_key));
  v_full_name text := case
    when lower(btrim(p_node_kind)) = 'person' then nullif(btrim(p_full_name), '')
    else null
  end;
begin
  if not private.is_system_portal_account_admin() then
    raise exception 'Only a System Admin can edit the organisation tree.'
      using errcode = '42501';
  end if;

  if p_expected_version is null then
    raise exception 'The expected org node version is required.' using errcode = '22004';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('internal_org_people_hierarchy', 0));

  select node.*
  into v_node
  from public.internal_org_people node
  where node.id = p_node_id
  for update;

  if not found then
    raise exception 'The org node does not exist.' using errcode = '23503';
  end if;

  if v_node.version <> p_expected_version then
    raise exception 'This org node changed since it was opened. Refresh and try again.'
      using errcode = '40001';
  end if;

  if exists (
    select 1
    from private.employee_directory_details detail
    where detail.person_id = p_node_id
  ) and (
    v_node.full_name is distinct from v_full_name
    or v_node.node_kind is distinct from v_node_kind
  ) then
    raise exception 'Use the HR employee directory to change a detailed employee name or type.'
      using errcode = '42501';
  end if;

  if v_node_kind <> 'person' and v_node.auth_user_id is not null then
    raise exception 'Disable or relink the portal account before changing this person node.'
      using errcode = '23503';
  end if;

  if p_is_active is false
    and v_node.auth_user_id is not null
    and exists (
      select 1
      from public.profiles profile
      where profile.id = v_node.auth_user_id
        and profile.account_status = 'active'
    ) then
    raise exception 'Disable the portal account before archiving this person.'
      using errcode = '23503';
  end if;

  update public.internal_org_people node
  set company_key = v_company_key,
      node_kind = v_node_kind,
      position_title = btrim(p_position_title),
      full_name = v_full_name,
      parent_id = p_parent_id,
      started_date = case
        when v_node_kind = 'person' then coalesce(p_started_date, v_node.started_date)
        else null
      end,
      sort_order = p_sort_order,
      is_active = p_is_active,
      updated_by = v_actor
  where node.id = p_node_id
  returning * into v_updated_node;

  if v_node.auth_user_id is not null
    and v_node.full_name is distinct from v_full_name then
    update public.profiles profile
    set full_name = v_full_name,
        updated_at = clock_timestamp()
    where profile.id = v_node.auth_user_id;
  end if;

  return v_updated_node.id;
end;
$$;

comment on function public.create_internal_org_node(text, text, text, text, uuid, date, integer) is
  'Creates a public organisation node; only a System Admin can call it.';

comment on function public.update_internal_org_node(
  uuid, text, text, text, text, uuid, date, integer, boolean, bigint
) is
  'Updates a public organisation node; only a System Admin can call it and a null start date preserves the HR-owned value.';

revoke all on function private.is_portal_account_admin() from public, anon, authenticated;
revoke all on function private.is_system_portal_account_admin() from public, anon, authenticated;
revoke all on function private.is_internal_org_hr() from public, anon, authenticated;
revoke all on function private.can_view_archived_employee_profiles() from public, anon, authenticated;
revoke all on function private.has_configured_global_employee_check_in_access(uuid) from public, anon, authenticated;
revoke all on function private.has_global_employee_check_in_scope() from public, anon, authenticated;
revoke all on function private.has_employee_check_in_workspace_access() from public, anon, authenticated;
revoke all on function public.can_manage_portal_accounts() from public, anon, authenticated;
revoke all on function public.can_edit_internal_org() from public, anon, authenticated;
revoke all on function public.can_manage_employee_directory() from public, anon, authenticated;
revoke all on function public.can_view_employee_directory() from public, anon, authenticated;
revoke all on function public.get_selected_employee_profile_access_role_for_preview(uuid) from public, anon, authenticated;
revoke all on function public.create_internal_org_node(text, text, text, text, uuid, date, integer) from public, anon, authenticated;
revoke all on function public.update_internal_org_node(uuid, text, text, text, text, uuid, date, integer, boolean, bigint) from public, anon, authenticated;

grant execute on function public.can_manage_portal_accounts() to authenticated;
grant execute on function public.can_edit_internal_org() to authenticated;
grant execute on function public.can_manage_employee_directory() to authenticated;
grant execute on function public.can_view_employee_directory() to authenticated;
grant execute on function public.get_selected_employee_profile_access_role_for_preview(uuid) to authenticated;
grant execute on function public.create_internal_org_node(text, text, text, text, uuid, date, integer) to authenticated;
grant execute on function public.update_internal_org_node(uuid, text, text, text, text, uuid, date, integer, boolean, bigint) to authenticated;

commit;
