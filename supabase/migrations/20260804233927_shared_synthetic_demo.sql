begin;

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

create table public.demo_profiles (
  id text primary key
    check (id ~ '^[a-z][a-z0-9_]{1,31}$'),
  full_name text not null
    check (char_length(full_name) between 1 and 80),
  initials text not null
    check (initials ~ '^[A-Z]{2}$'),
  access_role text not null
    check (access_role in ('hr', 'manager', 'employee')),
  role_label text not null
    check (char_length(role_label) between 1 and 80),
  team text not null
    check (char_length(team) between 1 and 80),
  manager_profile_id text references public.demo_profiles (id) on delete restrict,
  sort_order smallint not null unique,
  is_synthetic boolean not null default true
    check (is_synthetic)
);

create sequence public.demo_leave_request_number_seq start with 2500;

create table public.demo_leave_requests (
  id text primary key default ('MAM-' || nextval('public.demo_leave_request_number_seq')::text)
    check (id ~ '^MAM-[0-9]+$'),
  employee_profile_id text not null references public.demo_profiles (id) on delete restrict,
  manager_profile_id text not null references public.demo_profiles (id) on delete restrict,
  leave_type text not null
    check (leave_type in ('Annual leave', 'Sick leave', 'Carer''s leave', 'Unpaid leave')),
  start_date date not null,
  end_date date not null,
  start_time time,
  end_time time,
  days numeric(5, 2) not null check (days > 0),
  hours numeric(5, 2) check (hours is null or hours > 0),
  status text not null default 'Pending'
    check (status in ('Pending', 'Approved', 'Declined')),
  submitted_at timestamptz not null default now(),
  employee_note text not null default 'No note added.'
    check (char_length(employee_note) <= 500),
  manager_note text
    check (manager_note is null or char_length(manager_note) <= 500),
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  is_synthetic boolean not null default true
    check (is_synthetic),
  check (end_date >= start_date),
  check ((start_time is null) = (end_time is null)),
  check (
    start_time is null
    or (
      start_date = end_date
      and start_time >= time '06:00'
      and end_time <= time '18:00'
      and end_time > start_time
      and extract(minute from start_time)::integer % 15 = 0
      and extract(minute from end_time)::integer % 15 = 0
    )
  ),
  check (
    (start_time is null and hours is null)
    or (start_time is not null and hours is not null)
  ),
  check (
    (status = 'Pending' and decided_at is null)
    or (status <> 'Pending' and decided_at is not null)
  )
);

create index demo_leave_requests_employee_dates_idx
  on public.demo_leave_requests (employee_profile_id, start_date, end_date);
create index demo_leave_requests_manager_status_idx
  on public.demo_leave_requests (manager_profile_id, status, start_date);

create function private.set_demo_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger demo_leave_requests_set_updated_at
before update on public.demo_leave_requests
for each row execute function private.set_demo_updated_at();

insert into public.demo_profiles (
  id, full_name, initials, access_role, role_label, team, manager_profile_id, sort_order
)
values
  ('priya', 'Priya Singh', 'PS', 'hr', 'HR & People', 'People & Culture', null, 1),
  ('taylor', 'Taylor Morgan', 'TM', 'manager', 'Major Mod manager', 'Major Modifications', 'priya', 2),
  ('riley', 'Riley Brooks', 'RB', 'manager', 'Minor Mod manager', 'Minor Modifications', 'priya', 3),
  ('jordan', 'Jordan Patel', 'JP', 'employee', 'Accessibility technician', 'Major Modifications', 'taylor', 4),
  ('noah', 'Noah Williams', 'NW', 'employee', 'Project coordinator', 'Major Modifications', 'taylor', 5),
  ('alex', 'Alex King', 'AK', 'employee', 'Accessibility carpenter', 'Major Modifications', 'taylor', 6),
  ('mia', 'Mia Chen', 'MC', 'employee', 'Modifications coordinator', 'Minor Modifications', 'riley', 7),
  ('sam', 'Sam Rivera', 'SR', 'employee', 'Modifications tradesperson', 'Minor Modifications', 'riley', 8),
  ('ava', 'Ava Thompson', 'AT', 'employee', 'Accounts officer', 'Accounts', 'priya', 9);

create function private.seed_demo_leave_requests()
returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.demo_leave_requests (
    id, employee_profile_id, manager_profile_id, leave_type,
    start_date, end_date, start_time, end_time, days, hours,
    status, submitted_at, employee_note, manager_note, decided_at,
    created_at, updated_at
  )
  values
    ('MAM-2403', 'jordan', 'taylor', 'Annual leave',
      '2026-08-17', '2026-08-19', null, null, 3, null,
      'Pending', '2026-08-04 08:42:00+10', 'Family trip booked interstate.', null, null,
      '2026-08-04 08:42:00+10', '2026-08-04 08:42:00+10'),
    ('MAM-2402', 'mia', 'riley', 'Sick leave',
      '2026-08-18', '2026-08-18', '09:00', '13:00', 1, 4,
      'Pending', '2026-08-03 15:24:00+10', 'Personal appointment.', null, null,
      '2026-08-03 15:24:00+10', '2026-08-03 15:24:00+10'),
    ('MAM-2401', 'noah', 'taylor', 'Annual leave',
      '2026-08-18', '2026-08-20', null, null, 3, null,
      'Approved', '2026-07-29 10:08:00+10', 'Planned annual leave.', 'Project handover is complete.', '2026-07-30 09:15:00+10',
      '2026-07-29 10:08:00+10', '2026-07-30 09:15:00+10'),
    ('MAM-2398', 'taylor', 'priya', 'Annual leave',
      '2026-09-07', '2026-09-11', null, null, 5, null,
      'Pending', '2026-07-30 14:16:00+10', 'School holiday break.', null, null,
      '2026-07-30 14:16:00+10', '2026-07-30 14:16:00+10'),
    ('MAM-2397', 'riley', 'priya', 'Annual leave',
      '2026-09-14', '2026-09-18', null, null, 5, null,
      'Pending', '2026-07-30 09:35:00+10', 'Planned annual leave.', null, null,
      '2026-07-30 09:35:00+10', '2026-07-30 09:35:00+10'),
    ('MAM-2396', 'taylor', 'priya', 'Annual leave',
      '2026-07-06', '2026-07-10', null, null, 5, null,
      'Approved', '2026-06-22 16:16:00+10', 'Planned leave.', 'Operations cover confirmed.', '2026-06-23 10:00:00+10',
      '2026-06-22 16:16:00+10', '2026-06-23 10:00:00+10'),
    ('MAM-2395', 'ava', 'priya', 'Unpaid leave',
      '2026-07-31', '2026-07-31', null, null, 1, null,
      'Declined', '2026-07-28 13:14:00+10', 'Personal commitment.', 'Please choose another date due to payroll close.', '2026-07-28 15:30:00+10',
      '2026-07-28 13:14:00+10', '2026-07-28 15:30:00+10');
$$;

select private.seed_demo_leave_requests();

create function public.submit_demo_leave_request(
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
  v_days numeric(5, 2);
  v_hours numeric(5, 2);
  v_request public.demo_leave_requests;
begin
  select profile.manager_profile_id
  into v_manager_profile_id
  from public.demo_profiles profile
  where profile.id = p_employee_profile_id
    and profile.is_synthetic;

  if v_manager_profile_id is null then
    raise exception 'This synthetic profile cannot submit a leave request.';
  end if;

  if p_leave_type not in ('Annual leave', 'Sick leave', 'Carer''s leave', 'Unpaid leave') then
    raise exception 'Choose a valid leave type.';
  end if;

  if p_end_date < p_start_date then
    raise exception 'End date must be on or after start date.';
  end if;

  if (p_start_time is null) <> (p_end_time is null) then
    raise exception 'Choose both part-day times or neither.';
  end if;

  if p_start_time is not null then
    if p_start_date <> p_end_date
      or p_start_time < time '06:00'
      or p_end_time > time '18:00'
      or p_end_time <= p_start_time
      or extract(minute from p_start_time)::integer % 15 <> 0
      or extract(minute from p_end_time)::integer % 15 <> 0 then
      raise exception 'Part-day times must be 15-minute intervals between 06:00 and 18:00 on one date.';
    end if;

    v_hours := round((extract(epoch from (p_end_time - p_start_time)) / 3600)::numeric, 2);
    v_days := 1;
  else
    select count(*)::numeric(5, 2)
    into v_days
    from generate_series(p_start_date, p_end_date, interval '1 day') day
    where extract(isodow from day) between 1 and 5;

    if v_days < 1 then
      raise exception 'Choose at least one weekday.';
    end if;
  end if;

  insert into public.demo_leave_requests (
    employee_profile_id, manager_profile_id, leave_type,
    start_date, end_date, start_time, end_time,
    days, hours, employee_note
  )
  values (
    p_employee_profile_id, v_manager_profile_id, p_leave_type,
    p_start_date, p_end_date, p_start_time, p_end_time,
    v_days, v_hours, coalesce(nullif(btrim(p_employee_note), ''), 'No note added.')
  )
  returning * into v_request;

  return v_request;
end;
$$;

create function public.decide_demo_leave_request(
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
    and request.status = 'Pending'
  returning * into v_request;

  if not found then
    raise exception 'This request is not waiting for this synthetic manager.';
  end if;

  return v_request;
end;
$$;

create function public.reset_demo_leave_requests()
returns setof public.demo_leave_requests
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from public.demo_leave_requests;
  perform setval('public.demo_leave_request_number_seq', 2500, false);
  perform private.seed_demo_leave_requests();

  return query
  select request.*
  from public.demo_leave_requests request
  order by request.submitted_at desc, request.id desc;
end;
$$;

alter table public.demo_profiles enable row level security;
alter table public.demo_leave_requests enable row level security;
alter table public.demo_profiles force row level security;
alter table public.demo_leave_requests force row level security;

create policy demo_profiles_read_synthetic
  on public.demo_profiles for select
  to anon, authenticated
  using (is_synthetic);

create policy demo_leave_requests_read_synthetic
  on public.demo_leave_requests for select
  to anon, authenticated
  using (is_synthetic);

revoke all on table public.demo_profiles from anon, authenticated;
revoke all on table public.demo_leave_requests from anon, authenticated;
revoke all on sequence public.demo_leave_request_number_seq from anon, authenticated;
grant usage on schema public to anon, authenticated;
grant select on table public.demo_profiles to anon, authenticated;
grant select on table public.demo_leave_requests to anon, authenticated;

revoke all on function private.set_demo_updated_at() from public, anon, authenticated;
revoke all on function private.seed_demo_leave_requests() from public, anon, authenticated;
revoke all on function public.submit_demo_leave_request(text, text, date, date, time, time, text) from public;
revoke all on function public.decide_demo_leave_request(text, text, text, text) from public;
revoke all on function public.reset_demo_leave_requests() from public;
grant execute on function public.submit_demo_leave_request(text, text, date, date, time, time, text) to anon, authenticated;
grant execute on function public.decide_demo_leave_request(text, text, text, text) to anon, authenticated;
grant execute on function public.reset_demo_leave_requests() to anon, authenticated;

do $$
begin
  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'demo_leave_requests'
  ) then
    alter publication supabase_realtime add table public.demo_leave_requests;
  end if;
end;
$$;

commit;
