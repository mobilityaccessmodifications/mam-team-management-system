begin;

do $$
begin
  perform pg_advisory_xact_lock(
    hashtextextended('mam:private-team-calendar-birthdays:20260916140000', 0)
  );

  if to_regclass('public.internal_org_people') is null
    or to_regclass('public.profiles') is null
    or to_regclass('private.employee_directory_details') is null
    or to_regprocedure('private.is_active_portal_account(uuid)') is null
    or to_regprocedure('private.current_active_portal_employee_id()') is null
    or to_regprocedure('public.list_calendar_birthdays()') is null then
    raise exception 'Private team birthday prerequisites are missing.' using errcode = '55000';
  end if;
end;
$$;

-- Birthday visibility follows the selected employee's controlled portal role,
-- never a browser-supplied title or team label. Employees receive themselves,
-- Managers receive themselves plus every active person in their reporting
-- subtree, and System Admin receives every active person. Traversal includes
-- active org-unit nodes so nested employees are not accidentally omitted.
create function private.list_calendar_birthday_person_ids_for(
  p_person_id uuid
)
returns table (person_id uuid)
language sql
stable
security definer
set search_path = ''
as $$
  with recursive target as (
    select
      person.id as person_id,
      profile.app_role
    from public.internal_org_people person
    join public.profiles profile on profile.id = person.auth_user_id
    where person.id = p_person_id
      and person.node_kind = 'person'
      and person.is_active
      and profile.account_status = 'active'
      and profile.login_name is not null
    limit 1
  ), descendants as (
    select target.person_id as node_id, 0::integer as depth
    from target

    union all

    select child.id, descendants.depth + 1
    from descendants
    join public.internal_org_people child
      on child.parent_id = descendants.node_id
    where child.is_active
  )
  select person.id
  from target
  join public.internal_org_people person
    on person.node_kind = 'person'
   and person.is_active
  where target.app_role = 'system_admin'
    or person.id = target.person_id
    or (
      target.app_role = 'manager'
      and exists (
        select 1
        from descendants
        where descendants.node_id = person.id
          and descendants.depth > 0
      )
    );
$$;

comment on function private.list_calendar_birthday_person_ids_for(uuid) is
  'Returns the selected active portal employee birthday scope: self for employees, self plus active reporting descendants for managers, or all active people for System Admin.';

revoke all on function private.list_calendar_birthday_person_ids_for(uuid)
  from public, anon, authenticated, service_role;

create or replace function public.list_calendar_birthdays()
returns table (
  employee_name text,
  birthday_month smallint,
  birthday_day smallint
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_actor_user_id uuid := (select auth.uid());
  v_actor_person_id uuid;
  v_actor_role text;
begin
  if v_actor_user_id is null
    or coalesce(((select auth.jwt()) ->> 'is_anonymous')::boolean, false)
    or not private.is_active_portal_account(v_actor_user_id) then
    raise exception 'An active portal account is required to view calendar birthdays.'
      using errcode = '42501';
  end if;

  select profile.app_role
    into v_actor_role
  from public.profiles profile
  where profile.id = v_actor_user_id
    and profile.account_status = 'active'
    and profile.login_name is not null;

  if not found then
    raise exception 'An active portal account is required to view calendar birthdays.'
      using errcode = '42501';
  end if;

  v_actor_person_id := private.current_active_portal_employee_id();

  -- A System Admin may intentionally sit outside the employee roster. No
  -- other unlinked account receives birthday data.
  if v_actor_person_id is null and v_actor_role <> 'system_admin' then
    raise exception 'An active linked employee account is required to view calendar birthdays.'
      using errcode = '42501';
  end if;

  return query
  select
    person.full_name,
    extract(month from detail.date_of_birth)::smallint,
    extract(day from detail.date_of_birth)::smallint
  from public.internal_org_people person
  join private.employee_directory_details detail
    on detail.person_id = person.id
  where person.node_kind = 'person'
    and person.is_active
    and person.full_name is not null
    and detail.date_of_birth is not null
    and (
      (v_actor_person_id is null and v_actor_role = 'system_admin')
      or person.id in (
        select visible.person_id
        from private.list_calendar_birthday_person_ids_for(v_actor_person_id) visible
      )
    )
  order by
    extract(month from detail.date_of_birth),
    extract(day from detail.date_of_birth),
    lower(person.full_name),
    person.id;
end;
$$;

comment on function public.list_calendar_birthdays() is
  'Returns only the caller-authorised active birthdays: self for employees, self plus active reporting descendants for managers, or all active people for System Admin. The DTO remains limited to name and recurring month/day.';

revoke all on function public.list_calendar_birthdays()
  from public, anon, authenticated;
grant execute on function public.list_calendar_birthdays()
  to authenticated;

-- Change Profile is a System Admin-only test projection. The selected
-- employee's real role and reporting subtree determine the simulated birthday
-- scope; the caller's own global authority never leaks into that projection.
create function public.list_calendar_birthdays_for_preview(
  p_person_id uuid
)
returns table (
  employee_name text,
  birthday_month smallint,
  birthday_day smallint
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_actor_user_id uuid := (select auth.uid());
begin
  if v_actor_user_id is null
    or coalesce(((select auth.jwt()) ->> 'is_anonymous')::boolean, false)
    or not private.is_active_portal_account(v_actor_user_id)
    or not exists (
      select 1
      from public.profiles profile
      where profile.id = v_actor_user_id
        and profile.app_role = 'system_admin'
        and profile.account_status = 'active'
        and profile.login_name is not null
    ) then
    raise exception 'Only an active System Admin may preview birthday scope.'
      using errcode = '42501';
  end if;

  if not exists (
    select 1
    from public.internal_org_people person
    join public.profiles profile on profile.id = person.auth_user_id
    where person.id = p_person_id
      and person.node_kind = 'person'
      and person.is_active
      and profile.account_status = 'active'
      and profile.login_name is not null
  ) then
    raise exception 'The selected employee is unavailable.' using errcode = '23503';
  end if;

  return query
  select
    person.full_name,
    extract(month from detail.date_of_birth)::smallint,
    extract(day from detail.date_of_birth)::smallint
  from private.list_calendar_birthday_person_ids_for(p_person_id) visible
  join public.internal_org_people person on person.id = visible.person_id
  join private.employee_directory_details detail
    on detail.person_id = person.id
  where person.full_name is not null
    and detail.date_of_birth is not null
  order by
    extract(month from detail.date_of_birth),
    extract(day from detail.date_of_birth),
    lower(person.full_name),
    person.id;
end;
$$;

comment on function public.list_calendar_birthdays_for_preview(uuid) is
  'System Admin-only Change Profile projection of the selected employee’s own/team birthday scope. Returns name and recurring month/day only.';

revoke all on function public.list_calendar_birthdays_for_preview(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.list_calendar_birthdays_for_preview(uuid)
  to authenticated;

commit;
