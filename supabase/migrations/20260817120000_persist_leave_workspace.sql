begin;

-- This migration deliberately starts a new durable workflow. It must never
-- guess labels, working durations or approvers for historic leave. If any
-- legacy record exists, stop before making a partial schema change and have it
-- reviewed in a separate, explicitly approved data migration.
do $$
begin
  if exists (select 1 from public.leave_requests) then
    raise exception 'Cannot enable the durable leave workspace while legacy leave_requests exist. Review and migrate those records explicitly first.'
      using errcode = 'P0001';
  end if;
end;
$$;

-- The original leave table is the durable record. These columns carry the
-- calendar and approval facts that were previously held only in the browser.
-- The empty-table preflight above makes these required fields safe without
-- inventing values for an existing leave record.
alter table public.leave_requests
  add column request_type_label text not null,
  add column start_time time without time zone,
  add column end_time time without time zone,
  add column business_days integer not null,
  add column hours numeric(7, 2),
  add column approval_required boolean not null default true,
  add column manager_user_id uuid references public.profiles (id) on delete set null,
  add column manager_name_snapshot text,
  add column manager_note text;

alter table public.leave_requests
  add constraint leave_requests_request_type_label_check
    check (request_type_label in (
      'Annual leave',
      'Sick leave',
      'Carer''s leave',
      'Unpaid leave',
      'Other leave'
    )),
  add constraint leave_requests_business_days_check
    check (business_days > 0),
  add constraint leave_requests_hours_check
    check (hours is null or hours > 0),
  add constraint leave_requests_working_times_check
    check (
      (start_time is null and end_time is null)
      or (
        start_time >= time '06:00'
        and start_time < time '18:00'
        and end_time > time '06:00'
        and end_time <= time '18:00'
        and (start_date < end_date or end_time > start_time)
        and extract(minute from start_time)::integer % 15 = 0
        and extract(minute from end_time)::integer % 15 = 0
      )
    ),
  add constraint leave_requests_manager_note_length_check
    check (manager_note is null or char_length(manager_note) <= 2000);

create index leave_requests_manager_user_status_dates_idx
  on public.leave_requests (manager_user_id, status, start_date);

-- Resolve the nearest active, managed portal account above an employee without
-- accepting an identity from the client. Keep climbing past an unlinked or
-- inactive person. The result is captured on insert and never re-derived for
-- an existing request.
create function private.current_leave_manager(p_employee_user_id uuid)
returns table (
  person_id uuid,
  auth_user_id uuid,
  full_name text
)
language sql
stable
security definer
set search_path = ''
as $$
  with recursive ancestors as (
    select
      parent.id,
      parent.parent_id,
      parent.auth_user_id,
      parent.full_name,
      parent.node_kind,
      parent.is_active,
      1 as depth
    from public.internal_org_people employee
    join public.internal_org_people parent
      on parent.id = employee.parent_id
    where employee.auth_user_id = p_employee_user_id
      and employee.node_kind = 'person'
      and employee.is_active

    union all

    select
      parent.id,
      parent.parent_id,
      parent.auth_user_id,
      parent.full_name,
      parent.node_kind,
      parent.is_active,
      ancestors.depth + 1
    from public.internal_org_people parent
    join ancestors
      on parent.id = ancestors.parent_id
  )
  select
    ancestor.id,
    ancestor.auth_user_id,
    ancestor.full_name
  from ancestors ancestor
  where ancestor.node_kind = 'person'
    and ancestor.is_active
    and ancestor.auth_user_id is not null
    and private.is_active_portal_account(ancestor.auth_user_id)
  order by ancestor.depth
  limit 1;
$$;

comment on function private.current_leave_manager(uuid) is
  'Returns the nearest active managed portal account above a linked employee. It is a private helper used only to capture a leave approver at submission time.';

-- Reviewer access previously relied on the deprecated team-membership model.
-- Keep HR/system-admin visibility, and align manager review only to the named
-- approver captured when the request was submitted. Hierarchy edits after a
-- request is submitted must not change who can access that leave record.
create or replace function private.can_review_leave_request(p_leave_request_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.has_current_portal_access()
    and (select auth.uid()) is not null
    and (
      private.is_internal_org_hr()
      or exists (
        select 1
        from public.leave_requests request
        where request.id = p_leave_request_id
          and request.manager_user_id = (select auth.uid())
      )
    );
$$;

drop policy leave_requests_select_reviewer on public.leave_requests;
create policy leave_requests_select_reviewer
  on public.leave_requests for select
  to authenticated
  using (
    (select private.has_current_portal_access())
    and private.can_review_leave_request(id)
  );

-- Submit leaves through a server-authorised RPC only. The caller never supplies
-- their own employee ID, company, manager, status, duration, or approver.
create function public.submit_my_leave_request(
  p_request_type_label text,
  p_start_date date,
  p_end_date date,
  p_start_time time without time zone default null,
  p_end_time time without time zone default null,
  p_employee_note text default null
)
returns table (
  id uuid,
  status text,
  approval_required boolean,
  manager_name text
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor_user_id uuid := (select auth.uid());
  v_actor_person_id uuid;
  v_request_type_label text := nullif(btrim(p_request_type_label), '');
  v_leave_type text;
  v_employee_note text := nullif(btrim(p_employee_note), '');
  v_business_days integer;
  v_hours numeric(7, 2);
  v_manager_person_id uuid;
  v_manager_user_id uuid;
  v_manager_name text;
  v_approval_required boolean;
  v_status text;
  v_request public.leave_requests%rowtype;
begin
  if v_actor_user_id is null
    or coalesce(((select auth.jwt()) ->> 'is_anonymous')::boolean, false)
    or not private.is_active_portal_account() then
    raise exception 'An active portal account is required to submit leave.'
      using errcode = '42501';
  end if;

  v_actor_person_id := private.current_active_portal_employee_id();
  if v_actor_person_id is null then
    raise exception 'An active linked employee account is required to submit leave.'
      using errcode = '42501';
  end if;

  if v_request_type_label is null or v_request_type_label not in (
    'Annual leave',
    'Sick leave',
    'Carer''s leave',
    'Unpaid leave'
  ) then
    raise exception 'Choose a valid leave type.' using errcode = '22023';
  end if;

  if p_start_date is null or p_end_date is null or p_end_date < p_start_date then
    raise exception 'End date must be on or after start date.' using errcode = '22023';
  end if;

  if (p_start_time is null) <> (p_end_time is null) then
    raise exception 'Choose both times or neither.' using errcode = '22023';
  end if;

  if v_employee_note is not null and char_length(v_employee_note) > 2000 then
    raise exception 'Leave note is too long.' using errcode = '22001';
  end if;

  select count(*)::integer
  into v_business_days
  from generate_series(p_start_date, p_end_date, interval '1 day') day
  where extract(isodow from day) between 1 and 5;

  if v_business_days < 1 then
    raise exception 'Choose at least one weekday for this request.' using errcode = '22023';
  end if;

  if p_start_time is not null then
    if extract(isodow from p_start_date) not between 1 and 5
      or extract(isodow from p_end_date) not between 1 and 5
      or p_start_time < time '06:00'
      or p_start_time >= time '18:00'
      or p_end_time <= time '06:00'
      or p_end_time > time '18:00'
      or (p_start_date = p_end_date and p_end_time <= p_start_time)
      or extract(minute from p_start_time)::integer % 15 <> 0
      or extract(minute from p_end_time)::integer % 15 <> 0 then
      raise exception 'Times must use 15-minute intervals within 06:00 to 18:00.'
        using errcode = '22023';
    end if;

    select round(sum(
      case
        when day::date = p_start_date and day::date = p_end_date then
          (extract(epoch from (p_end_time - p_start_time)) / 3600)::numeric
        when day::date = p_start_date then
          (extract(epoch from (time '18:00' - p_start_time)) / 3600)::numeric
        when day::date = p_end_date then
          (extract(epoch from (p_end_time - time '06:00')) / 3600)::numeric
        else 12::numeric
      end
    ), 2)
    into v_hours
    from generate_series(p_start_date, p_end_date, interval '1 day') day
    where extract(isodow from day) between 1 and 5;

    if v_hours is null or v_hours <= 0 then
      raise exception 'Choose a time range with working hours.' using errcode = '22023';
    end if;
  end if;

  select manager.person_id, manager.auth_user_id, manager.full_name
  into v_manager_person_id, v_manager_user_id, v_manager_name
  from private.current_leave_manager(v_actor_user_id) manager;

  -- Do not infer a self-approval rule from a title, team, or direct reports.
  -- Until the named approver rules are confirmed, every leave request remains
  -- pending. A valid nearest manager is captured when available; otherwise HR
  -- can see and route the pending request without silently approving it.
  v_approval_required := true;
  if v_manager_person_id is null
    or v_manager_user_id is null
    or not private.is_active_portal_account(v_manager_user_id) then
    v_manager_user_id := null;
    v_manager_name := null;
  end if;

  v_leave_type := case v_request_type_label
    when 'Annual leave' then 'annual'
    when 'Sick leave' then 'personal'
    when 'Carer''s leave' then 'personal'
    when 'Unpaid leave' then 'unpaid'
  end;
  v_status := 'submitted';

  insert into public.leave_requests (
    user_id,
    leave_type,
    request_type_label,
    start_date,
    end_date,
    start_time,
    end_time,
    business_days,
    hours,
    approval_required,
    manager_user_id,
    manager_name_snapshot,
    reason,
    status,
    submitted_at,
    decided_at,
    decided_by,
    created_at,
    updated_at
  )
  values (
    v_actor_user_id,
    v_leave_type,
    v_request_type_label,
    p_start_date,
    p_end_date,
    p_start_time,
    p_end_time,
    v_business_days,
    v_hours,
    v_approval_required,
    v_manager_user_id,
    v_manager_name,
    v_employee_note,
    v_status,
    clock_timestamp(),
    null,
    null,
    clock_timestamp(),
    clock_timestamp()
  )
  returning * into v_request;

  insert into public.leave_request_events (
    leave_request_id,
    actor_user_id,
    event_type,
    note
  )
  values
    (v_request.id, v_actor_user_id, 'created', null),
    (v_request.id, v_actor_user_id, 'submitted', null);

  return query
  select
    v_request.id,
    'Pending',
    v_request.approval_required,
    v_request.manager_name_snapshot;
end;
$$;

comment on function public.submit_my_leave_request(text, date, date, time without time zone, time without time zone, text) is
  'Creates one leave request for the authenticated linked employee. Identity, duration, manager and approval route are derived and validated in the database.';

create function public.decide_my_managed_leave_request(
  p_request_id uuid,
  p_status text,
  p_manager_note text default null
)
returns table (
  id uuid,
  status text
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor_user_id uuid := (select auth.uid());
  v_manager_note text := nullif(btrim(p_manager_note), '');
  v_request public.leave_requests%rowtype;
begin
  if v_actor_user_id is null
    or coalesce(((select auth.jwt()) ->> 'is_anonymous')::boolean, false)
    or not private.is_active_portal_account() then
    raise exception 'An active portal account is required to decide leave.'
      using errcode = '42501';
  end if;

  if p_request_id is null or p_status is null or p_status not in ('Approved', 'Declined') then
    raise exception 'Choose a valid leave decision.' using errcode = '22023';
  end if;

  if p_status = 'Declined' and v_manager_note is null then
    raise exception 'A manager note is required when declining this request.'
      using errcode = '22023';
  end if;

  if v_manager_note is not null and char_length(v_manager_note) > 2000 then
    raise exception 'Manager note is too long.' using errcode = '22001';
  end if;

  select request.*
  into v_request
  from public.leave_requests request
  where request.id = p_request_id
  for update;

  if not found
    or not v_request.approval_required
    or v_request.status <> 'submitted' then
    raise exception 'This leave request is not awaiting a decision.' using errcode = '42501';
  end if;

  -- The requester may never decide their own leave, including when they are
  -- HR. The interim workflow remains pending until a different authorised
  -- reviewer acts.
  if v_request.user_id = v_actor_user_id then
    raise exception 'You cannot decide your own leave request.' using errcode = '42501';
  end if;

  if not private.is_internal_org_hr()
    and v_request.manager_user_id is distinct from v_actor_user_id then
    raise exception 'Only the assigned manager can decide this leave request.'
      using errcode = '42501';
  end if;

  update public.leave_requests request
  set status = case when p_status = 'Approved' then 'approved' else 'rejected' end,
      manager_note = coalesce(v_manager_note, 'Coverage checked and confirmed.'),
      decided_at = clock_timestamp(),
      decided_by = v_actor_user_id,
      updated_at = clock_timestamp()
  where request.id = v_request.id
  returning * into v_request;

  insert into public.leave_request_events (
    leave_request_id,
    actor_user_id,
    event_type,
    note
  )
  values (
    v_request.id,
    v_actor_user_id,
    case when p_status = 'Approved' then 'approved' else 'rejected' end,
    v_request.manager_note
  );

  return query
  select
    v_request.id,
    case v_request.status
      when 'approved' then 'Approved'
      else 'Declined'
    end;
end;
$$;

comment on function public.decide_my_managed_leave_request(uuid, text, text) is
  'Records an approval or decline only for the assigned manager or HR override. The target request and reviewer authority are always re-read in the database.';

-- Full leave records are returned only to their owner, their named manager, or
-- authorised HR. The browser never supplies an employee identifier to widen
-- this result.
create function public.list_leave_workspace_requests()
returns table (
  id uuid,
  employee_name text,
  company_key text,
  leave_type_label text,
  start_date date,
  end_date date,
  start_time time without time zone,
  end_time time without time zone,
  business_days integer,
  hours numeric,
  approval_required boolean,
  status text,
  submitted_at timestamptz,
  manager_name text,
  can_decide boolean,
  employee_note text,
  manager_note text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_actor_user_id uuid := (select auth.uid());
  v_actor_is_hr boolean := private.is_internal_org_hr();
begin
  if v_actor_user_id is null
    or coalesce(((select auth.jwt()) ->> 'is_anonymous')::boolean, false)
    or not private.is_active_portal_account() then
    raise exception 'An active portal account is required to view leave.'
      using errcode = '42501';
  end if;

  if not v_actor_is_hr and private.current_active_portal_employee_id() is null then
    raise exception 'An active linked employee account is required to view leave.'
      using errcode = '42501';
  end if;

  return query
  select
    request.id,
    coalesce(employee.full_name, profile.full_name),
    coalesce(employee.company_key, 'mam'),
    request.request_type_label,
    request.start_date,
    request.end_date,
    request.start_time,
    request.end_time,
    request.business_days,
    request.hours,
    request.approval_required,
    case request.status
      when 'approved' then 'Approved'
      when 'rejected' then 'Declined'
      else 'Pending'
    end,
    request.submitted_at,
    request.manager_name_snapshot,
    (
      request.user_id <> v_actor_user_id
      and request.approval_required
      and request.status = 'submitted'
      and (
        v_actor_is_hr
        or request.manager_user_id = v_actor_user_id
      )
    ),
    request.reason,
    request.manager_note
  from public.leave_requests request
  join public.profiles profile
    on profile.id = request.user_id
  left join lateral (
    select person.full_name, person.company_key
    from public.internal_org_people person
    where person.auth_user_id = request.user_id
      and person.node_kind = 'person'
    order by person.is_active desc, person.updated_at desc
    limit 1
  ) employee on true
  where request.status in ('submitted', 'approved', 'rejected', 'changes_requested')
    and (
      v_actor_is_hr
      or request.user_id = v_actor_user_id
      or request.manager_user_id = v_actor_user_id
    )
  order by request.start_date desc, request.created_at desc, request.id;
end;
$$;

comment on function public.list_leave_workspace_requests() is
  'Returns private leave details only for the authenticated employee, their named manager, or authorised HR. It is the leave-register DTO for the portal.';

-- Calendar entries use a separate safe DTO. It deliberately excludes reason,
-- manager note, attachments, account identifiers and all HR contact fields;
-- peers receive a generic Away label rather than a leave type.
create function public.list_leave_calendar_entries()
returns table (
  id uuid,
  employee_name text,
  company_key text,
  leave_type_label text,
  start_date date,
  end_date date,
  start_time time without time zone,
  end_time time without time zone,
  business_days integer,
  hours numeric,
  status text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_actor_user_id uuid := (select auth.uid());
  v_actor_is_hr boolean := private.is_internal_org_hr();
  v_actor_person_id uuid;
  v_actor_company_key text;
begin
  if v_actor_user_id is null
    or coalesce(((select auth.jwt()) ->> 'is_anonymous')::boolean, false)
    or not private.is_active_portal_account() then
    raise exception 'An active portal account is required to view the calendar.'
      using errcode = '42501';
  end if;

  if not v_actor_is_hr then
    v_actor_person_id := private.current_active_portal_employee_id();
    if v_actor_person_id is null then
      raise exception 'An active linked employee account is required to view the calendar.'
        using errcode = '42501';
    end if;

    select person.company_key
    into v_actor_company_key
    from public.internal_org_people person
    where person.id = v_actor_person_id
      and person.auth_user_id = v_actor_user_id
      and person.node_kind = 'person'
      and person.is_active;

    if v_actor_company_key is null then
      raise exception 'An active linked employee account is required to view the calendar.'
        using errcode = '42501';
    end if;
  end if;

  return query
  select
    request.id,
    coalesce(employee.full_name, profile.full_name),
    coalesce(employee.company_key, 'mam'),
    case
      when v_actor_is_hr
        or request.user_id = v_actor_user_id
        or request.manager_user_id = v_actor_user_id
        then request.request_type_label
      else 'Away'
    end,
    request.start_date,
    request.end_date,
    request.start_time,
    request.end_time,
    request.business_days,
    request.hours,
    case request.status
      when 'approved' then 'Approved'
      else 'Pending'
    end
  from public.leave_requests request
  join public.profiles profile
    on profile.id = request.user_id
  left join lateral (
    select person.full_name, person.company_key
    from public.internal_org_people person
    where person.auth_user_id = request.user_id
      and person.node_kind = 'person'
      and person.is_active
    order by person.updated_at desc
    limit 1
  ) employee on true
  where request.status in ('submitted', 'approved')
    and (v_actor_is_hr or employee.company_key = v_actor_company_key)
  order by request.start_date, request.created_at, request.id;
end;
$$;

comment on function public.list_leave_calendar_entries() is
  'Returns availability-only leave entries. Employees receive their company calendar; other employees'' leave types are masked as Away. Authorised HR receives all companies. Private leave details are never returned.';

-- All application mutations now go through the validating RPCs above. Select
-- remains RLS-controlled for the existing evidence workflow and Realtime,
-- while direct DML cannot bypass manager derivation or audit events.
revoke insert, update, delete on table public.leave_requests from authenticated;
revoke insert on table public.leave_request_events from authenticated;

-- Cross-account calendar refreshes use the event only as an invalidation
-- signal; the browser re-fetches the two DTO RPCs and ignores raw row data.
do $$
begin
  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'leave_requests'
  ) then
    alter publication supabase_realtime add table public.leave_requests;
  end if;
end;
$$;

revoke all on function private.current_leave_manager(uuid)
  from public, anon, authenticated;
revoke all on function private.can_review_leave_request(uuid)
  from public, anon, authenticated;
revoke all on function public.submit_my_leave_request(text, date, date, time without time zone, time without time zone, text)
  from public, anon, authenticated;
revoke all on function public.decide_my_managed_leave_request(uuid, text, text)
  from public, anon, authenticated;
revoke all on function public.list_leave_workspace_requests()
  from public, anon, authenticated;
revoke all on function public.list_leave_calendar_entries()
  from public, anon, authenticated;

-- Existing RLS policies for the private evidence tables call this helper.
-- Keep authenticated execution after replacing its implementation above.
grant execute on function private.can_review_leave_request(uuid)
  to authenticated;
grant execute on function public.submit_my_leave_request(text, date, date, time without time zone, time without time zone, text)
  to authenticated;
grant execute on function public.decide_my_managed_leave_request(uuid, text, text)
  to authenticated;
grant execute on function public.list_leave_workspace_requests()
  to authenticated;
grant execute on function public.list_leave_calendar_entries()
  to authenticated;

commit;
