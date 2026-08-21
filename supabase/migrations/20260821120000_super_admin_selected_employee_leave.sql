-- Super Admin Change Profile: allow the real Super Admin to exercise the
-- selected employee's leave submission flow without changing auth.uid().
-- The target employee is resolved from the live person↔portal link, while the
-- actor remains the authenticated Super Admin for audit events.

create or replace function public.submit_selected_employee_leave_request(
  p_person_id uuid,
  p_request_type_label text,
  p_start_date date,
  p_end_date date,
  p_start_time time without time zone default null,
  p_end_time time without time zone default null,
  p_employee_note text default null
)
returns table (id uuid, status text, approval_required boolean, assigned_reviewer_label text)
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_actor_user_id uuid := (select auth.uid());
  v_target_user_id uuid;
  v_request_type_label text := nullif(btrim(p_request_type_label), '');
  v_employee_note text := nullif(btrim(p_employee_note), '');
  v_leave_type text;
  v_business_days integer;
  v_hours numeric(7, 2);
  v_primary_reviewer_user_id uuid;
  v_primary_reviewer_label text;
  v_reviewer_count integer;
  v_request public.leave_requests%rowtype;
begin
  if v_actor_user_id is null
    or coalesce(((select auth.jwt()) ->> 'is_anonymous')::boolean, false)
    or not private.is_active_portal_account()
    or not private.is_system_portal_account_admin() then
    raise exception 'Only Super Admin may submit leave for a selected profile.' using errcode = '42501';
  end if;

  select person.auth_user_id into v_target_user_id
  from public.internal_org_people person
  join public.profiles target_profile
    on target_profile.id = person.auth_user_id
   and target_profile.account_status = 'active'
  where person.id = p_person_id
    and person.node_kind = 'person'
    and person.is_active = true
    and person.auth_user_id is not null;

  if v_target_user_id is null or not private.is_active_portal_account(v_target_user_id) then
    raise exception 'The selected profile is not an active linked employee.' using errcode = '42501';
  end if;

  if v_request_type_label is null or v_request_type_label not in ('Annual leave', 'Sick leave', 'Carer''s leave', 'Unpaid leave') then
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

  select count(*)::integer into v_business_days
  from generate_series(p_start_date, p_end_date, interval '1 day') day
  where extract(isodow from day) between 1 and 5;
  if v_business_days < 1 then
    raise exception 'Choose at least one weekday for this request.' using errcode = '22023';
  end if;

  if p_start_time is not null then
    if extract(isodow from p_start_date) not between 1 and 5
      or extract(isodow from p_end_date) not between 1 and 5
      or p_start_time < time '06:00' or p_start_time >= time '18:00'
      or p_end_time <= time '06:00' or p_end_time > time '18:00'
      or (p_start_date = p_end_date and p_end_time <= p_start_time)
      or extract(minute from p_start_time)::integer % 15 <> 0
      or extract(minute from p_end_time)::integer % 15 <> 0 then
      raise exception 'Times must use 15-minute intervals within 06:00 to 18:00.' using errcode = '22023';
    end if;
    select round(sum(case
      when day::date = p_start_date and day::date = p_end_date then (extract(epoch from (p_end_time - p_start_time)) / 3600)::numeric
      when day::date = p_start_date then (extract(epoch from (time '18:00' - p_start_time)) / 3600)::numeric
      when day::date = p_end_date then (extract(epoch from (p_end_time - time '06:00')) / 3600)::numeric
      else 12::numeric end), 2)
    into v_hours
    from generate_series(p_start_date, p_end_date, interval '1 day') day
    where extract(isodow from day) between 1 and 5;
    if v_hours is null or v_hours <= 0 then
      raise exception 'Choose a time range with working hours.' using errcode = '22023';
    end if;
  end if;

  perform pg_advisory_xact_lock(hashtextextended('internal_org_people_hierarchy', 0));
  perform pg_advisory_xact_lock(hashtextextended('leave_approval_grants', 0));
  select count(distinct candidate.reviewer_user_id)::integer into v_reviewer_count
  from private.resolve_leave_approval_grants(p_person_id) candidate
  where candidate.reviewer_user_id is distinct from v_target_user_id;
  if coalesce(v_reviewer_count, 0) < 1 then
    raise exception 'No authorised leave reviewer is configured for this employee.' using errcode = '42501';
  end if;

  select candidate.reviewer_user_id, candidate.reviewer_label
  into v_primary_reviewer_user_id, v_primary_reviewer_label
  from private.resolve_leave_approval_grants(p_person_id) candidate
  where candidate.reviewer_user_id is distinct from v_target_user_id
  order by case candidate.scope_kind when 'team' then 0 when 'subtree' then 1 else 2 end,
    candidate.scope_priority, candidate.scope_depth, candidate.grant_id
  limit 1;
  v_leave_type := case v_request_type_label
    when 'Annual leave' then 'annual'
    when 'Sick leave' then 'personal'
    when 'Carer''s leave' then 'personal'
    when 'Unpaid leave' then 'unpaid'
  end;

  insert into public.leave_requests (
    user_id, leave_type, request_type_label, start_date, end_date, start_time,
    end_time, business_days, hours, approval_required, manager_user_id,
    manager_name_snapshot, reason, status, submitted_at, decided_at, decided_by,
    created_at, updated_at
  ) values (
    v_target_user_id, v_leave_type, v_request_type_label, p_start_date, p_end_date,
    p_start_time, p_end_time, v_business_days, v_hours, true,
    v_primary_reviewer_user_id, v_primary_reviewer_label, v_employee_note,
    'submitted', clock_timestamp(), null, null, clock_timestamp(), clock_timestamp()
  ) returning * into v_request;

  with candidates as (
    select candidate.* from private.resolve_leave_approval_grants(p_person_id) candidate
    where candidate.reviewer_user_id is distinct from v_target_user_id
  ), distinct_reviewers as (
    select distinct on (candidate.reviewer_user_id) candidate.* from candidates candidate
    order by candidate.reviewer_user_id,
      case candidate.scope_kind when 'team' then 0 when 'subtree' then 1 else 2 end,
      candidate.scope_priority, candidate.scope_depth, candidate.grant_id
  ), ranked_reviewers as (
    select candidate.*, row_number() over (
      order by case candidate.scope_kind when 'team' then 0 when 'subtree' then 1 else 2 end,
        candidate.scope_priority, candidate.scope_depth, candidate.grant_id
    ) as route_rank from distinct_reviewers candidate
  )
  insert into private.leave_request_reviewer_assignments (
    leave_request_id, reviewer_user_id, source_grant_id, assignment_kind, reviewer_label, is_primary
  )
  select v_request.id, candidate.reviewer_user_id, candidate.grant_id,
    candidate.scope_kind, candidate.reviewer_label, candidate.route_rank = 1
  from ranked_reviewers candidate;

  insert into public.leave_request_events (leave_request_id, actor_user_id, event_type, note)
  values (v_request.id, v_actor_user_id, 'created', null),
    (v_request.id, v_actor_user_id, 'submitted', null);

  return query select v_request.id, 'Pending', v_request.approval_required, v_primary_reviewer_label;
end;
$$;

comment on function public.submit_selected_employee_leave_request(uuid, text, date, date, time without time zone, time without time zone, text)
is 'Super Admin-only Change Profile leave submission. The target employee is resolved from the live active person/account link and the actor is retained for audit.';
revoke all on function public.submit_selected_employee_leave_request(uuid, text, date, date, time without time zone, time without time zone, text) from public, anon, authenticated;
grant execute on function public.submit_selected_employee_leave_request(uuid, text, date, date, time without time zone, time without time zone, text) to authenticated;
