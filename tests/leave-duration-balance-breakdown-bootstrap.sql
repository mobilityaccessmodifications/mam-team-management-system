\set ON_ERROR_STOP on
do $$begin assert current_database() = 'leave_duration_balance_test', 'Disposable database only'; end$$;

do $$begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role; end if;
end$$;

create schema private;

create table public.internal_org_people (
  id uuid primary key,
  full_name text,
  company_key text
);

create table private.employee_directory_details (
  person_id uuid primary key references public.internal_org_people(id),
  employment_type text
);

create table public.leave_requests (
  id uuid primary key,
  employee_person_id uuid references public.internal_org_people(id),
  status text,
  request_type_label text,
  start_date date,
  end_date date,
  start_time time,
  end_time time,
  business_days integer,
  hours numeric,
  employment_type_snapshot text,
  reason text,
  manager_note text
);

create table private.leave_notification_outbox (
  request_id uuid,
  event text,
  payload jsonb,
  unique(request_id, event)
);

insert into public.internal_org_people(id, full_name, company_key)
values ('10000000-0000-4000-8000-000000000001', 'Synthetic Employee', 'mam');

insert into private.employee_directory_details(person_id, employment_type)
values ('10000000-0000-4000-8000-000000000001', 'full_time');

insert into public.leave_requests(
  id, employee_person_id, status, request_type_label, start_date, end_date,
  start_time, end_time, business_days, hours, employment_type_snapshot
)
values
  ('20000000-0000-4000-8000-000000000010', '10000000-0000-4000-8000-000000000001', 'approved', 'Annual leave', '2026-10-12', '2026-10-13', null, null, 2, null, 'full_time'),
  ('20000000-0000-4000-8000-000000000011', '10000000-0000-4000-8000-000000000001', 'approved', 'Annual leave', '2026-10-14', '2026-10-14', '12:00', '16:00', 1, 4, 'full_time'),
  ('20000000-0000-4000-8000-000000000012', '10000000-0000-4000-8000-000000000001', 'approved', 'Annual leave', '2026-09-01', '2026-09-01', null, null, 1, null, 'full_time'),
  ('20000000-0000-4000-8000-000000000013', '10000000-0000-4000-8000-000000000001', 'submitted', 'Annual leave', '2026-10-20', '2026-10-20', null, null, 1, null, 'full_time'),
  ('20000000-0000-4000-8000-000000000014', '10000000-0000-4000-8000-000000000001', 'approved', 'Sick leave', '2026-10-15', '2026-10-15', null, null, 1, null, 'full_time'),
  ('20000000-0000-4000-8000-000000000015', '10000000-0000-4000-8000-000000000001', 'approved', 'Annual leave', '2026-10-16', '2026-10-16', null, null, 1, 3.5, 'full_time'),
  ('20000000-0000-4000-8000-000000000016', '10000000-0000-4000-8000-000000000001', 'approved', 'Annual leave', '2026-09-30', '2026-10-01', null, null, 2, 8, 'full_time');

create function public.get_leave_priority_workspace(uuid default null)
returns jsonb
language sql
stable
as $$
  select jsonb_build_object(
    'people', jsonb_build_array(jsonb_build_object(
      'personId', '10000000-0000-4000-8000-000000000001',
      'name', 'Synthetic Employee',
      'paidLeave', true,
      'canViewBalance', true,
      'hours', 31.2,
      'asOf', '2026-09-30',
      'annualPayrollHours', 30.8,
      'annualPayrollDate', '2026-09-30',
      'canViewSickBalance', true,
      'sickHours', 42.1,
      'sickAsOf', '2026-09-30',
      'sickPayrollHours', 42.1,
      'sickPayrollDate', '2026-09-30'
    )),
    'requests', jsonb_build_array(jsonb_build_object(
      'id', '20000000-0000-4000-8000-000000000013',
      'pendingBalance', false,
      'evidenceDueDate', null,
      'canAttach', true
    )),
    'pendingBalanceCalendarIds', '[]'::jsonb,
    'canManageBalances', false
  );
$$;

create function private.enqueue_leave_notification(uuid, text, boolean)
returns void language sql as $$ select; $$;

create function private.leave_notification_balance_snapshot(uuid, text)
returns jsonb language sql as $$ select jsonb_build_object('hours', 999); $$;
