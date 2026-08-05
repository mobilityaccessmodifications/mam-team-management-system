begin;

alter table public.demo_leave_requests
  add column approval_required boolean not null default true;

alter table public.demo_leave_requests
  drop constraint demo_leave_requests_check2;

alter table public.demo_leave_requests
  add constraint demo_leave_requests_working_times_check
  check (
    start_time is null
    or (
      start_time >= time '06:00'
      and start_time < time '18:00'
      and end_time > time '06:00'
      and end_time <= time '18:00'
      and (start_date < end_date or end_time > start_time)
      and extract(minute from start_time)::integer % 15 = 0
      and extract(minute from end_time)::integer % 15 = 0
    )
  );

update public.demo_leave_requests request
set approval_required = false,
    status = 'Approved',
    manager_note = null,
    decided_at = coalesce(request.decided_at, request.submitted_at)
where request.employee_profile_id in (
  select profile.id
  from public.demo_profiles profile
  where profile.access_role = 'manager'
    and profile.is_synthetic
);

alter table public.demo_leave_requests
  add constraint demo_leave_requests_direct_entry_status_check
  check (approval_required or status = 'Approved');

create or replace function private.seed_demo_leave_requests()
returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.demo_leave_requests (
    id, employee_profile_id, manager_profile_id, leave_type,
    start_date, end_date, start_time, end_time, days, hours,
    approval_required, status, submitted_at, employee_note, manager_note, decided_at,
    created_at, updated_at
  )
  values
    ('MAM-2403', 'jordan', 'taylor', 'Annual leave',
      '2026-08-17', '2026-08-19', null, null, 3, null,
      true, 'Pending', '2026-08-04 08:42:00+10', 'Family trip booked interstate.', null, null,
      '2026-08-04 08:42:00+10', '2026-08-04 08:42:00+10'),
    ('MAM-2402', 'mia', 'riley', 'Sick leave',
      '2026-08-18', '2026-08-18', '09:00', '13:00', 1, 4,
      true, 'Pending', '2026-08-03 15:24:00+10', 'Personal appointment.', null, null,
      '2026-08-03 15:24:00+10', '2026-08-03 15:24:00+10'),
    ('MAM-2401', 'noah', 'taylor', 'Annual leave',
      '2026-08-18', '2026-08-20', null, null, 3, null,
      true, 'Approved', '2026-07-29 10:08:00+10', 'Planned annual leave.', 'Project handover is complete.', '2026-07-30 09:15:00+10',
      '2026-07-29 10:08:00+10', '2026-07-30 09:15:00+10'),
    ('MAM-2398', 'taylor', 'priya', 'Annual leave',
      '2026-09-07', '2026-09-11', null, null, 5, null,
      false, 'Approved', '2026-07-30 14:16:00+10', 'School holiday break.', null, '2026-07-30 14:16:00+10',
      '2026-07-30 14:16:00+10', '2026-07-30 14:16:00+10'),
    ('MAM-2397', 'riley', 'priya', 'Annual leave',
      '2026-09-14', '2026-09-18', null, null, 5, null,
      false, 'Approved', '2026-07-30 09:35:00+10', 'Planned annual leave.', null, '2026-07-30 09:35:00+10',
      '2026-07-30 09:35:00+10', '2026-07-30 09:35:00+10'),
    ('MAM-2396', 'taylor', 'priya', 'Annual leave',
      '2026-07-06', '2026-07-10', null, null, 5, null,
      false, 'Approved', '2026-06-22 16:16:00+10', 'Planned leave.', null, '2026-06-22 16:16:00+10',
      '2026-06-22 16:16:00+10', '2026-06-22 16:16:00+10'),
    ('MAM-2395', 'ava', 'priya', 'Unpaid leave',
      '2026-07-31', '2026-07-31', null, null, 1, null,
      true, 'Declined', '2026-07-28 13:14:00+10', 'Personal commitment.', 'Please choose another date due to payroll close.', '2026-07-28 15:30:00+10',
      '2026-07-28 13:14:00+10', '2026-07-28 15:30:00+10');
$$;

create or replace function public.submit_demo_leave_request(
  p_employee_profile_id text,
  p_leave_type text,
  p_start_date date,
  p_end_date date,
  p_start_time time default null,
  p_end_time time default null,
  p_employee_note text default null
)
returns public.demo_leave_requests
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_manager_profile_id text;
  v_access_role text;
  v_days numeric(5, 2);
  v_hours numeric(5, 2);
  v_approval_required boolean;
  v_status text;
  v_decided_at timestamptz;
  v_request public.demo_leave_requests;
begin
  select profile.manager_profile_id, profile.access_role
  into v_manager_profile_id, v_access_role
  from public.demo_profiles profile
  where profile.id = p_employee_profile_id
    and profile.is_synthetic;

  if not found or v_manager_profile_id is null then
    raise exception 'This synthetic profile cannot add leave.';
  end if;

  if p_leave_type not in ('Annual leave', 'Sick leave', 'Carer''s leave', 'Unpaid leave') then
    raise exception 'Choose a valid leave type.';
  end if;

  if p_end_date < p_start_date then
    raise exception 'End date must be on or after start date.';
  end if;

  if (p_start_time is null) <> (p_end_time is null) then
    raise exception 'Choose both times or neither.';
  end if;

  select count(*)::numeric(5, 2)
  into v_days
  from generate_series(p_start_date, p_end_date, interval '1 day') day
  where extract(isodow from day) between 1 and 5;

  if v_days < 1 then
    raise exception 'Choose at least one weekday.';
  end if;

  if p_start_time is not null then
    if extract(isodow from p_start_date) not between 1 and 5
      or extract(isodow from p_end_date) not between 1 and 5 then
      raise exception 'Timed leave must start and end on weekdays.';
    end if;

    if p_start_time < time '06:00'
      or p_start_time >= time '18:00'
      or p_end_time <= time '06:00'
      or p_end_time > time '18:00'
      or (p_start_date = p_end_date and p_end_time <= p_start_time)
      or extract(minute from p_start_time)::integer % 15 <> 0
      or extract(minute from p_end_time)::integer % 15 <> 0 then
      raise exception 'Times must use 15-minute intervals within 06:00 to 18:00.';
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

    if v_hours <= 0 then
      raise exception 'Choose a time range with working hours.';
    end if;
  end if;

  v_approval_required := v_access_role <> 'manager';
  v_status := case when v_approval_required then 'Pending' else 'Approved' end;
  v_decided_at := case when v_approval_required then null else now() end;

  insert into public.demo_leave_requests (
    employee_profile_id, manager_profile_id, leave_type,
    start_date, end_date, start_time, end_time,
    days, hours, approval_required, status, employee_note, decided_at
  )
  values (
    p_employee_profile_id, v_manager_profile_id, p_leave_type,
    p_start_date, p_end_date, p_start_time, p_end_time,
    v_days, v_hours, v_approval_required, v_status,
    coalesce(nullif(btrim(p_employee_note), ''), 'No note added.'), v_decided_at
  )
  returning * into v_request;

  return v_request;
end;
$$;

create or replace function public.decide_demo_leave_request(
  p_request_id text,
  p_actor_profile_id text,
  p_status text,
  p_manager_note text default null
)
returns public.demo_leave_requests
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_request public.demo_leave_requests;
begin
  if p_status not in ('Approved', 'Declined') then
    raise exception 'Choose Approved or Declined.';
  end if;

  if p_status = 'Declined' and nullif(btrim(p_manager_note), '') is null then
    raise exception 'A manager note is required when declining.';
  end if;

  update public.demo_leave_requests request
  set status = p_status,
      manager_note = coalesce(
        nullif(btrim(p_manager_note), ''),
        case when p_status = 'Approved' then 'Coverage checked and confirmed.' end
      ),
      decided_at = now()
  where request.id = p_request_id
    and request.manager_profile_id = p_actor_profile_id
    and request.approval_required
    and request.status = 'Pending'
  returning * into v_request;

  if not found then
    raise exception 'This request is not waiting for this synthetic manager.';
  end if;

  return v_request;
end;
$$;

revoke all on function private.seed_demo_leave_requests() from public, anon, authenticated;
revoke all on function public.submit_demo_leave_request(text, text, date, date, time, time, text) from public;
revoke all on function public.decide_demo_leave_request(text, text, text, text) from public;
grant execute on function public.submit_demo_leave_request(text, text, date, date, time, time, text) to anon, authenticated;
grant execute on function public.decide_demo_leave_request(text, text, text, text) to anon, authenticated;

commit;
