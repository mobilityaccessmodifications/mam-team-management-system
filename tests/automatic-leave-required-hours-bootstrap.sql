\set ON_ERROR_STOP on
do $$begin assert current_database() = 'automatic_leave_hours_test', 'Disposable database only'; end$$;

do $$begin
  if not exists(select 1 from pg_roles where rolname = 'anon') then create role anon; end if;
  if not exists(select 1 from pg_roles where rolname = 'authenticated') then create role authenticated; end if;
  if not exists(select 1 from pg_roles where rolname = 'service_role') then create role service_role; end if;
end$$;

create schema auth;
create schema private;

create function auth.uid()
returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
$$;

create function auth.jwt()
returns jsonb language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb, '{}'::jsonb);
$$;

create table public.profiles (
  id uuid primary key,
  full_name text not null
);

create table public.internal_org_people (
  id uuid primary key,
  full_name text not null,
  auth_user_id uuid references public.profiles(id),
  is_active boolean not null default true
);

create table private.employee_directory_details (
  person_id uuid primary key references public.internal_org_people(id),
  employment_type text
);

create table public.leave_requests (
  id uuid primary key,
  user_id uuid references public.profiles(id),
  employee_person_id uuid references public.internal_org_people(id),
  approval_required boolean not null default true,
  record_origin text not null default 'portal',
  status text not null default 'submitted',
  request_type_label text not null default 'Annual leave',
  business_days integer not null,
  hours numeric,
  employment_type_snapshot text,
  manager_note text,
  updated_at timestamptz not null default clock_timestamp()
);

create table private.leave_balance_approvals (
  request_id uuid primary key references public.leave_requests(id),
  approved_by uuid not null references public.profiles(id),
  approved_at timestamptz not null default clock_timestamp(),
  required_hours numeric(12,4)
);

create table private.employee_annual_leave_balances (
  person_id uuid primary key references public.internal_org_people(id),
  hours numeric(12,4) not null,
  as_of date not null,
  is_example boolean not null default false,
  updated_at timestamptz not null default clock_timestamp()
);

create table public.leave_request_events (
  leave_request_id uuid not null references public.leave_requests(id),
  actor_user_id uuid references public.profiles(id),
  event_type text not null,
  note text
);

create table private.test_accrual_state (
  person_id uuid primary key,
  payload jsonb not null
);

create table private.test_approved_commitments (
  person_id uuid,
  end_date date not null,
  hours numeric not null
);

create function private.is_active_portal_account()
returns boolean language sql stable as $$ select auth.uid() is not null; $$;

create function private.can_review_leave_request(uuid)
returns boolean language sql stable as $$
  select auth.uid() = '10000000-0000-4000-8000-000000000001'::uuid;
$$;

create function public.decide_my_managed_leave_request(uuid, text, text)
returns table(id uuid, status text)
language sql as $$ select null::uuid, null::text where false; $$;

create function private.calculate_employee_leave_accrual(p_person_id uuid, p_through date)
returns jsonb language sql stable as $$
  select state.payload from private.test_accrual_state state where state.person_id = p_person_id;
$$;

create function private.approved_leave_hours_after(p_person_id uuid, p_types text[], p_after date)
returns numeric language sql stable as $$
  select coalesce(sum(commitment.hours), 0) from private.test_approved_commitments commitment
  where commitment.person_id = p_person_id and commitment.end_date > p_after;
$$;

insert into public.profiles(id, full_name) values
  ('10000000-0000-4000-8000-000000000001', 'Synthetic Manager'),
  ('10000000-0000-4000-8000-000000000002', 'Full-time Employee'),
  ('10000000-0000-4000-8000-000000000003', 'Part-time Employee'),
  ('10000000-0000-4000-8000-000000000004', 'Legacy Employee');

insert into public.internal_org_people(id, full_name, auth_user_id) values
  ('10000000-0000-4000-8000-000000000002', 'Full-time Employee', '10000000-0000-4000-8000-000000000002'),
  ('10000000-0000-4000-8000-000000000003', 'Part-time Employee', '10000000-0000-4000-8000-000000000003'),
  ('10000000-0000-4000-8000-000000000004', 'Legacy Employee', '10000000-0000-4000-8000-000000000004');

insert into private.employee_directory_details(person_id, employment_type) values
  ('10000000-0000-4000-8000-000000000002', 'full_time'),
  ('10000000-0000-4000-8000-000000000003', 'part_time'),
  ('10000000-0000-4000-8000-000000000004', 'full_time');

insert into public.leave_requests(
  id, user_id, employee_person_id, business_days, hours, employment_type_snapshot
) values
  ('20000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000002', 1, null, 'full_time'),
  ('20000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000002', 1, 3.25, 'full_time'),
  ('20000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000003', 2, null, 'part_time'),
  ('20000000-0000-4000-8000-000000000004', '10000000-0000-4000-8000-000000000004', '10000000-0000-4000-8000-000000000004', 1, null, null),
  ('20000000-0000-4000-8000-000000000005', '10000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000002', 1, null, 'full_time');

insert into private.leave_balance_approvals(request_id, approved_by, approved_at) values
  ('20000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', clock_timestamp() - interval '1 hour'),
  ('20000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000001', clock_timestamp() - interval '1 hour'),
  ('20000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000001', clock_timestamp() - interval '1 hour'),
  ('20000000-0000-4000-8000-000000000004', '10000000-0000-4000-8000-000000000001', clock_timestamp() - interval '1 hour');

insert into private.employee_annual_leave_balances(person_id, hours, as_of, updated_at)
values(
  '10000000-0000-4000-8000-000000000002',
  28.4621,
  (now() at time zone 'Australia/Melbourne')::date,
  clock_timestamp()
);

insert into private.test_accrual_state(person_id, payload)
values(
  '10000000-0000-4000-8000-000000000002',
  jsonb_build_object(
    'status', 'current',
    'annualAsOf', (now() at time zone 'Australia/Melbourne')::date,
    'annualExactHours', 28.4621
  )
);

insert into private.test_approved_commitments(person_id, end_date, hours) values
  ('10000000-0000-4000-8000-000000000002', (now() at time zone 'Australia/Melbourne')::date + 30, 22.8),
  ('10000000-0000-4000-8000-000000000002', (now() at time zone 'Australia/Melbourne')::date, 7.6);
