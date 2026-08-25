begin;

-- Managers need a useful team directory without inheriting the HR directory's
-- private/lifecycle surface. These helpers derive the scope from the current
-- database-backed portal identity and the canonical reporting tree; neither a
-- browser role nor a client-supplied manager identifier can widen real manager
-- access.
do $$
begin
  if to_regclass('public.profiles') is null
    or to_regclass('public.internal_org_people') is null
    or to_regclass('private.employee_directory_details') is null
    or to_regclass('private.employee_directory_audit_events') is null
    or to_regprocedure('private.has_current_portal_access()') is null
    or to_regprocedure('private.is_active_linked_internal_employee(uuid)') is null
    or to_regprocedure('private.is_system_portal_account_admin()') is null
    or to_regprocedure('private.normalise_employee_directory_text(text,integer,boolean,text)') is null
    or to_regprocedure('private.normalise_employee_directory_email(text,text)') is null
    or to_regprocedure('private.resolve_internal_org_employee_manager(uuid)') is null then
    raise exception 'Manager directory prerequisites are missing.' using errcode = '55000';
  end if;
end;
$$;

-- The exact manager role is stored in profiles.app_role. A reporting line or
-- job title alone never grants directory access.
create or replace function private.current_manager_employee_directory_person_id()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select person.id
  from public.internal_org_people person
  join public.profiles profile on profile.id = person.auth_user_id
  where (select auth.uid()) is not null
    and coalesce(((select auth.jwt()) ->> 'is_anonymous')::boolean, false) = false
    and private.has_current_portal_access()
    and private.is_active_linked_internal_employee((select auth.uid()))
    and person.auth_user_id = (select auth.uid())
    and person.node_kind = 'person'
    and person.is_active
    and profile.app_role = 'manager'
    and profile.account_status = 'active'
    and profile.login_name is not null
  limit 1;
$$;

comment on function private.current_manager_employee_directory_person_id() is
  'Returns only the current active linked manager person for manager-scoped Directory operations.';

create or replace function private.is_active_employee_directory_manager(
  p_person_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_person_id is not null
    and exists (
      select 1
      from public.internal_org_people person
      join public.profiles profile on profile.id = person.auth_user_id
      where person.id = p_person_id
        and person.node_kind = 'person'
        and person.is_active
        and person.auth_user_id is not null
        and private.is_active_linked_internal_employee(person.auth_user_id)
        and profile.app_role = 'manager'
        and profile.account_status = 'active'
        and profile.login_name is not null
    );
$$;

-- Traverse every active node so structural org-unit nodes remain supported,
-- while returning only active person descendants. The lineage array fails
-- closed if a malformed legacy hierarchy contains a cycle.
create or replace function private.list_active_manager_directory_descendants(
  p_manager_person_id uuid
)
returns table (person_id uuid)
language sql
stable
security definer
set search_path = ''
as $$
  with recursive descendants as (
    select
      root.id as node_id,
      array[root.id]::uuid[] as lineage,
      0::integer as depth
    from public.internal_org_people root
    where root.id = p_manager_person_id
      and root.node_kind = 'person'
      and root.is_active

    union all

    select
      child.id as node_id,
      descendants.lineage || child.id,
      descendants.depth + 1
    from descendants
    join public.internal_org_people child
      on child.parent_id = descendants.node_id
    where child.is_active
      and not child.id = any(descendants.lineage)
  )
  select person.id
  from descendants
  join public.internal_org_people person on person.id = descendants.node_id
  where descendants.depth > 0
    and person.node_kind = 'person'
    and person.is_active;
$$;

create or replace function public.can_manage_team_employee_directory()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.current_manager_employee_directory_person_id() is not null;
$$;

comment on function public.can_manage_team_employee_directory() is
  'Returns whether the current active linked manager may use the scoped team Directory. It never grants HR/admin Directory access.';

-- This is deliberately not the HR Directory DTO. It contains only work
-- identity and reporting context for a manager's active descendants.
create or replace function private.list_manager_employee_directory_records_for_scope(
  p_manager_person_id uuid
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
  manager_name text,
  work_email text
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    person.id,
    person.version,
    coalesce(detail.version, 0::bigint),
    person.company_key,
    person.is_active,
    coalesce(detail.first_name, person.full_name),
    coalesce(detail.last_name, ''::text),
    person.full_name,
    person.position_title,
    coalesce(detail.team_name, ''::text),
    coalesce(manager.manager_name, ''::text),
    coalesce(detail.work_email, ''::text)
  from private.list_active_manager_directory_descendants(p_manager_person_id) scope
  join public.internal_org_people person on person.id = scope.person_id
  left join private.employee_directory_details detail on detail.person_id = person.id
  left join lateral private.resolve_internal_org_employee_manager(person.id) manager on true
  order by lower(person.full_name), person.id;
$$;

create or replace function public.list_managed_employee_directory_records()
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
  manager_name text,
  work_email text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_manager_person_id uuid := private.current_manager_employee_directory_person_id();
begin
  if v_manager_person_id is null then
    raise exception 'Manager team-directory access is required.' using errcode = '42501';
  end if;

  return query
  select *
  from private.list_manager_employee_directory_records_for_scope(v_manager_person_id);
end;
$$;

comment on function public.list_managed_employee_directory_records() is
  'Returns the current manager''s active direct and indirect reports using a narrow work-directory projection.';

-- Super Admin Change profile may safely exercise the real manager experience.
-- The selected manager must itself be an active, linked manager; no caller may
-- choose an arbitrary root and a non-admin caller can never use this preview.
create or replace function public.list_managed_employee_directory_records_for_preview(
  p_manager_person_id uuid
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
  manager_name text,
  work_email text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not private.is_system_portal_account_admin() then
    raise exception 'Only a System Admin may preview a manager team directory.' using errcode = '42501';
  end if;

  if not private.is_active_employee_directory_manager(p_manager_person_id) then
    raise exception 'The selected manager profile is unavailable.' using errcode = '23503';
  end if;

  return query
  select *
  from private.list_manager_employee_directory_records_for_scope(p_manager_person_id);
end;
$$;

-- Central, narrow update path shared by real-manager and System Admin preview
-- wrappers. It never accepts reporting lines, company, lifecycle, start/end
-- dates, private contacts, DOB or asset identifiers.
create or replace function private.update_manager_scoped_employee_directory_record(
  p_manager_person_id uuid,
  p_person_id uuid,
  p_first_name text,
  p_last_name text,
  p_work_email text,
  p_position_title text,
  p_team_name text,
  p_expected_person_version bigint,
  p_expected_detail_version bigint
)
returns table (
  person_id uuid,
  person_version bigint,
  detail_version bigint
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_first_name text;
  v_last_name text;
  v_work_email text;
  v_position_title text;
  v_team_name text;
  v_full_name text;
  v_person public.internal_org_people%rowtype;
  v_updated_person public.internal_org_people%rowtype;
  v_detail private.employee_directory_details%rowtype;
  v_updated_detail private.employee_directory_details%rowtype;
  v_has_detail boolean;
  v_public_changed boolean;
  v_detail_changed boolean;
  v_changed_fields text[];
begin
  if not private.is_active_employee_directory_manager(p_manager_person_id) then
    raise exception 'The manager scope is unavailable.' using errcode = '42501';
  end if;

  if p_person_id is null then
    raise exception 'Choose an employee to update.' using errcode = '22004';
  end if;

  if p_expected_person_version is null or p_expected_person_version < 1 then
    raise exception 'The expected employee version is required.' using errcode = '22004';
  end if;

  if p_expected_detail_version is null or p_expected_detail_version < 0 then
    raise exception 'The expected employee detail version is required.' using errcode = '22004';
  end if;

  v_first_name := private.normalise_employee_directory_text(p_first_name, 80, true, 'First name');
  v_last_name := private.normalise_employee_directory_text(p_last_name, 120, false, 'Last name');
  v_work_email := private.normalise_employee_directory_email(p_work_email, 'Work email');
  v_position_title := private.normalise_employee_directory_text(p_position_title, 120, true, 'Job title');
  v_team_name := private.normalise_employee_directory_text(p_team_name, 120, false, 'Team');
  v_full_name := concat_ws(' ', v_first_name, v_last_name);

  if char_length(v_full_name) > 120 then
    raise exception 'First and last name together are too long.' using errcode = '22001';
  end if;

  -- Serialise hierarchy reads with tree changes before resolving descendants.
  perform pg_advisory_xact_lock(hashtextextended('internal_org_people_hierarchy', 0));

  select person.*
  into v_person
  from public.internal_org_people person
  where person.id = p_person_id
    and person.node_kind = 'person'
    and person.is_active
  for update;

  if not found then
    raise exception 'The active employee record is unavailable.' using errcode = '23503';
  end if;

  if not exists (
    select 1
    from private.list_active_manager_directory_descendants(p_manager_person_id) scope
    where scope.person_id = v_person.id
  ) then
    raise exception 'This employee is outside the manager team scope.' using errcode = '42501';
  end if;

  if v_person.version <> p_expected_person_version then
    raise exception 'This employee changed since it was opened. Refresh and try again.' using errcode = '40001';
  end if;

  select detail.*
  into v_detail
  from private.employee_directory_details detail
  where detail.person_id = v_person.id
  for update;
  v_has_detail := found;

  if v_has_detail and v_detail.version <> p_expected_detail_version then
    raise exception 'This employee detail changed since it was opened. Refresh and try again.' using errcode = '40001';
  end if;

  if not v_has_detail and p_expected_detail_version <> 0 then
    raise exception 'This employee detail changed since it was opened. Refresh and try again.' using errcode = '40001';
  end if;

  v_public_changed := v_person.full_name is distinct from v_full_name
    or v_person.position_title is distinct from v_position_title;
  v_detail_changed := not v_has_detail
    or v_detail.first_name is distinct from v_first_name
    or v_detail.last_name is distinct from v_last_name
    or v_detail.work_email is distinct from v_work_email
    or v_detail.team_name is distinct from v_team_name;

  select coalesce(array_agg(change.field_name order by change.sort_order), array[]::text[])
  into v_changed_fields
  from (
    values
      (1, 'first_name'::text, not v_has_detail or v_detail.first_name is distinct from v_first_name),
      (2, 'last_name'::text, not v_has_detail or v_detail.last_name is distinct from v_last_name),
      (3, 'work_email'::text, not v_has_detail or v_detail.work_email is distinct from v_work_email),
      (4, 'position_title'::text, v_person.position_title is distinct from v_position_title),
      (5, 'team_name'::text, not v_has_detail or v_detail.team_name is distinct from v_team_name)
  ) as change(sort_order, field_name, is_changed)
  where change.is_changed;

  if v_public_changed or v_detail_changed then
    -- Touching the safe public row invalidates affected organisation clients
    -- without publishing private detail data through Realtime.
    update public.internal_org_people person
    set full_name = v_full_name,
        position_title = v_position_title,
        updated_by = v_actor
    where person.id = v_person.id
    returning * into v_updated_person;

    if v_detail_changed then
      if v_has_detail then
        update private.employee_directory_details detail
        set first_name = v_first_name,
            last_name = v_last_name,
            work_email = v_work_email,
            team_name = v_team_name,
            updated_by = v_actor
        where detail.person_id = v_person.id
        returning * into v_updated_detail;
      else
        insert into private.employee_directory_details (
          person_id,
          first_name,
          last_name,
          work_email,
          team_name,
          created_by,
          updated_by
        )
        values (
          v_person.id,
          v_first_name,
          v_last_name,
          v_work_email,
          v_team_name,
          v_actor,
          v_actor
        )
        returning * into v_updated_detail;
      end if;
    else
      v_updated_detail := v_detail;
    end if;

    if v_person.auth_user_id is not null
      and v_person.full_name is distinct from v_full_name then
      update public.profiles profile
      set full_name = v_full_name,
          updated_at = clock_timestamp()
      where profile.id = v_person.auth_user_id;
    end if;

    insert into private.employee_directory_audit_events (
      person_id,
      actor_user_id,
      event_type,
      changed_fields
    )
    values (
      v_person.id,
      v_actor,
      'updated',
      v_changed_fields
    );
  else
    v_updated_person := v_person;
    v_updated_detail := v_detail;
  end if;

  return query select
    v_updated_person.id,
    v_updated_person.version,
    coalesce(v_updated_detail.version, 0::bigint);
end;
$$;

create or replace function public.update_managed_employee_directory_record(
  p_person_id uuid,
  p_first_name text,
  p_last_name text,
  p_work_email text,
  p_position_title text,
  p_team_name text,
  p_expected_person_version bigint,
  p_expected_detail_version bigint
)
returns table (
  person_id uuid,
  person_version bigint,
  detail_version bigint
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_manager_person_id uuid := private.current_manager_employee_directory_person_id();
begin
  if v_manager_person_id is null then
    raise exception 'Manager team-directory access is required.' using errcode = '42501';
  end if;

  return query
  select *
  from private.update_manager_scoped_employee_directory_record(
    v_manager_person_id,
    p_person_id,
    p_first_name,
    p_last_name,
    p_work_email,
    p_position_title,
    p_team_name,
    p_expected_person_version,
    p_expected_detail_version
  );
end;
$$;

comment on function public.update_managed_employee_directory_record(
  uuid, text, text, text, text, text, bigint, bigint
) is
  'Updates only approved work-directory fields for the current manager''s active direct or indirect reports.';

create or replace function public.update_managed_employee_directory_record_for_preview(
  p_manager_person_id uuid,
  p_person_id uuid,
  p_first_name text,
  p_last_name text,
  p_work_email text,
  p_position_title text,
  p_team_name text,
  p_expected_person_version bigint,
  p_expected_detail_version bigint
)
returns table (
  person_id uuid,
  person_version bigint,
  detail_version bigint
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not private.is_system_portal_account_admin() then
    raise exception 'Only a System Admin may preview a manager team directory.' using errcode = '42501';
  end if;

  if not private.is_active_employee_directory_manager(p_manager_person_id) then
    raise exception 'The selected manager profile is unavailable.' using errcode = '23503';
  end if;

  return query
  select *
  from private.update_manager_scoped_employee_directory_record(
    p_manager_person_id,
    p_person_id,
    p_first_name,
    p_last_name,
    p_work_email,
    p_position_title,
    p_team_name,
    p_expected_person_version,
    p_expected_detail_version
  );
end;
$$;

revoke all on function private.current_manager_employee_directory_person_id()
  from public, anon, authenticated;
revoke all on function private.is_active_employee_directory_manager(uuid)
  from public, anon, authenticated;
revoke all on function private.list_active_manager_directory_descendants(uuid)
  from public, anon, authenticated;
revoke all on function private.list_manager_employee_directory_records_for_scope(uuid)
  from public, anon, authenticated;
revoke all on function private.update_manager_scoped_employee_directory_record(
  uuid, uuid, text, text, text, text, text, bigint, bigint
) from public, anon, authenticated;

revoke all on function public.can_manage_team_employee_directory()
  from public, anon, authenticated;
revoke all on function public.list_managed_employee_directory_records()
  from public, anon, authenticated;
revoke all on function public.list_managed_employee_directory_records_for_preview(uuid)
  from public, anon, authenticated;
revoke all on function public.update_managed_employee_directory_record(
  uuid, text, text, text, text, text, bigint, bigint
) from public, anon, authenticated;
revoke all on function public.update_managed_employee_directory_record_for_preview(
  uuid, uuid, text, text, text, text, text, bigint, bigint
) from public, anon, authenticated;

grant execute on function public.can_manage_team_employee_directory() to authenticated;
grant execute on function public.list_managed_employee_directory_records() to authenticated;
grant execute on function public.list_managed_employee_directory_records_for_preview(uuid) to authenticated;
grant execute on function public.update_managed_employee_directory_record(
  uuid, text, text, text, text, text, bigint, bigint
) to authenticated;
grant execute on function public.update_managed_employee_directory_record_for_preview(
  uuid, uuid, text, text, text, text, text, bigint, bigint
) to authenticated;

comment on function public.list_managed_employee_directory_records_for_preview(uuid) is
  'System Admin-only preview of an active manager''s narrow team Directory.';
comment on function public.update_managed_employee_directory_record_for_preview(
  uuid, uuid, text, text, text, text, text, bigint, bigint
) is
  'System Admin-only manager-scope preview update. The selected manager scope and target descendant are verified in the database.';

commit;
