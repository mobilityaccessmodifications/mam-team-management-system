begin;
select pg_advisory_xact_lock(hashtextextended('mam:staff-leave-calendar-details:20260929120000', 0));

-- Keep the shared employee/peer projection unchanged. This second projection
-- only enriches rows after the existing calendar scope has been evaluated.
create function private.staff_leave_calendar_entries(p_person_id uuid, p_user_id uuid, p_preview boolean)
returns table (
  id uuid, person_id uuid, employee_name text, company_key text,
  leave_type_label text, start_date date, end_date date,
  start_time time without time zone, end_time time without time zone,
  business_days integer, hours numeric, status text, team_name text,
  requested_at timestamptz, approved_by text, document_count bigint
)
language plpgsql stable security definer set search_path = '' as $$
declare
  v_all boolean := private.can_view_all_approved_leave_calendar_for(p_user_id);
begin
  if not private.is_calendar_manager(p_user_id) and not v_all then
    return;
  end if;

  return query
  with base as materialized (
    select entry.* from public.list_leave_calendar_entries_with_teams() entry
    where not p_preview
    union all
    select entry.* from public.list_leave_calendar_entries_with_teams_for_preview(p_person_id) entry
    where p_preview
  ), entries as (
    select base.id, base.person_id, base.employee_name, base.company_key,
      base.start_date, base.end_date, base.start_time, base.end_time,
      base.business_days, base.hours, base.status, base.team_name
    from base
    union all
    select request.id, employee.id, employee.full_name, employee.company_key,
      request.start_date, request.end_date, request.start_time, request.end_time,
      request.business_days, request.hours, 'Pending'::text,
      coalesce(nullif(btrim(detail.team_name), ''), 'Unassigned')
    from public.leave_requests request
    join public.internal_org_people employee
      on employee.id = request.employee_person_id and employee.node_kind = 'person' and employee.is_active
    left join private.employee_directory_details detail on detail.person_id = employee.id
    where v_all and request.status = 'submitted'
      and not exists (select 1 from base where base.id = request.id)
  )
  select entries.id, entries.person_id, entries.employee_name, entries.company_key,
    request.request_type_label, entries.start_date, entries.end_date,
    entries.start_time, entries.end_time, entries.business_days, entries.hours,
    entries.status, entries.team_name,
    coalesce(request.submitted_at, request.created_at),
    case when request.status = 'approved' then reviewer.full_name else null end,
    (select count(*) from public.leave_request_attachments attachment
      where attachment.leave_request_id = request.id)
  from entries
  join public.leave_requests request on request.id = entries.id
  left join public.internal_org_people reviewer on reviewer.auth_user_id = request.decided_by
    and reviewer.node_kind = 'person'
  order by entries.start_date, entries.id;
end;
$$;
revoke all on function private.staff_leave_calendar_entries(uuid,uuid,boolean)
  from public, anon, authenticated, service_role;

create function public.list_staff_leave_calendar_entries()
returns table (
  id uuid, person_id uuid, employee_name text, company_key text,
  leave_type_label text, start_date date, end_date date,
  start_time time without time zone, end_time time without time zone,
  business_days integer, hours numeric, status text, team_name text,
  requested_at timestamptz, approved_by text, document_count bigint
)
language plpgsql stable security definer set search_path = '' as $$
begin
  if (select auth.uid()) is null
    or coalesce(((select auth.jwt()) ->> 'is_anonymous')::boolean, false)
    or not private.is_active_portal_account() then
    raise exception 'An active portal account is required to view the calendar.' using errcode = '42501';
  end if;
  return query select * from private.staff_leave_calendar_entries(
    private.current_active_portal_employee_id(), (select auth.uid()), false
  );
end;
$$;
revoke all on function public.list_staff_leave_calendar_entries()
  from public, anon, authenticated, service_role;
grant execute on function public.list_staff_leave_calendar_entries() to authenticated;

create function public.list_staff_leave_calendar_entries_for_preview(p_person_id uuid)
returns table (
  id uuid, person_id uuid, employee_name text, company_key text,
  leave_type_label text, start_date date, end_date date,
  start_time time without time zone, end_time time without time zone,
  business_days integer, hours numeric, status text, team_name text,
  requested_at timestamptz, approved_by text, document_count bigint
)
language plpgsql stable security definer set search_path = '' as $$
declare
  v_target_user_id uuid;
begin
  if not private.is_internal_org_hr() then
    raise exception 'Only a Super Admin may preview Leave Calendar scope.' using errcode = '42501';
  end if;
  select person.auth_user_id into v_target_user_id
  from public.internal_org_people person
  join public.profiles profile on profile.id = person.auth_user_id
  where person.id = p_person_id and person.node_kind = 'person' and person.is_active
    and profile.account_status = 'active' and profile.login_name is not null
    and private.is_active_portal_account(profile.id);
  if v_target_user_id is null then
    raise exception 'The selected employee is unavailable.' using errcode = '23503';
  end if;
  return query select * from private.staff_leave_calendar_entries(p_person_id, v_target_user_id, true);
end;
$$;
revoke all on function public.list_staff_leave_calendar_entries_for_preview(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.list_staff_leave_calendar_entries_for_preview(uuid) to authenticated;
commit;
