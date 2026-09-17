\set ON_ERROR_STOP on

set check_function_bodies = off;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin;
  end if;
end;
$$;
create schema private;

create table public.internal_org_people (
  id uuid primary key,
  node_kind text not null,
  is_active boolean not null,
  started_date date
);

create table private.employee_check_in_reminders (
  id uuid primary key,
  person_id uuid not null references public.internal_org_people (id),
  milestone text not null,
  reminder_sequence text not null,
  due_date date not null,
  notify_date date not null,
  delivery_status text not null,
  needs_review_reason text,
  claim_token uuid,
  claimed_at timestamptz,
  delivered_at timestamptz,
  completed_by uuid,
  updated_at timestamptz not null default clock_timestamp(),
  unique (person_id, milestone, reminder_sequence, due_date)
);

create table private.employee_check_in_reminder_events (
  reminder_id uuid not null references private.employee_check_in_reminders (id) on delete cascade,
  event_type text not null
);

create table private.subscription_register (
  id uuid primary key,
  pricing_model text not null,
  subscription_status text not null,
  next_review_on date
);

create table private.subscription_audit_events (
  subscription_id uuid not null,
  actor_user_id uuid,
  event_type text not null,
  changed_fields text[] not null
);

create table private.payroll_balance_imports (
  as_of date,
  company_key text,
  match_status text
);

create table public.leave_requests (
  id uuid primary key,
  record_origin text not null,
  request_type_label text not null,
  status text not null,
  end_date date not null,
  submitted_by uuid,
  evidence_due_date date
);

-- Production enters the migration with the original Monday-Friday-only
-- check-in schedule. The migration snapshots this exact contract before
-- replacing it with the Victorian public-holiday-aware implementation.
create function private.employee_check_in_next_business_day(p_date date)
returns date
language sql
immutable
strict
set search_path = ''
as $$
  select case extract(isodow from p_date)::integer
    when 6 then p_date + 2
    when 7 then p_date + 1
    else p_date
  end;
$$;

create function private.employee_check_in_business_day_on_or_before(p_date date)
returns date
language sql
immutable
strict
set search_path = ''
as $$
  select case extract(isodow from p_date)::integer
    when 6 then p_date - 1
    when 7 then p_date - 2
    else p_date
  end;
$$;

create function private.employee_check_in_business_days_before(
  p_date date,
  p_business_days integer
)
returns date
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_cursor date := p_date;
  v_remaining integer := p_business_days;
begin
  if p_date is null or p_business_days is null or p_business_days < 0 or p_business_days > 30 then
    raise exception 'Invalid business-day offset.' using errcode = '22023';
  end if;

  while v_remaining > 0 loop
    v_cursor := v_cursor - 1;
    if extract(isodow from v_cursor) between 1 and 5 then
      v_remaining := v_remaining - 1;
    end if;
  end loop;

  return v_cursor;
end;
$$;

create function private.employee_check_in_schedule(p_start_date date)
returns table (
  milestone text,
  reminder_sequence text,
  due_date date,
  notify_date date
)
language sql
immutable
strict
set search_path = ''
as $$
  with raw_schedule(milestone, reminder_sequence, day_offset, lead_kind, lead_days) as (
    values
      ('2_week'::text, 'initial'::text, 14, 'calendar'::text, 3),
      ('1_month'::text, 'initial'::text, 30, 'business'::text, 4),
      ('3_month'::text, 'initial'::text, 90, 'calendar'::text, 14),
      ('5_month'::text, 'initial'::text, 150, 'calendar'::text, 14),
      ('5_month'::text, 'final'::text, 150, 'calendar'::text, 7)
  )
  select
    raw_schedule.milestone,
    raw_schedule.reminder_sequence,
    planned.due_date,
    case raw_schedule.lead_kind
      when 'business' then private.employee_check_in_business_days_before(
        planned.due_date,
        raw_schedule.lead_days
      )
      else private.employee_check_in_business_day_on_or_before(
        planned.due_date - raw_schedule.lead_days
      )
    end
  from raw_schedule
  cross join lateral (
    select private.employee_check_in_next_business_day(
      p_start_date + raw_schedule.day_offset
    ) as due_date
  ) planned;
$$;

create function private.sync_employee_check_in_reminders(uuid, boolean, boolean)
returns void language sql as $$ select; $$;

create function private.normalise_subscription_review_workday()
returns trigger language plpgsql as $$ begin return new; end; $$;

create function private.set_leave_submission_details()
returns trigger language plpgsql as $$ begin return new; end; $$;

create function private.payroll_balance_monthly_reminder_projection()
returns jsonb language sql as $$ select '{}'::jsonb; $$;

create function private.claim_due_payroll_balance_email_reminders_at(integer, timestamptz)
returns table (reminder_id uuid, claim_token uuid)
language sql as $$ select null::uuid, null::uuid where false; $$;

create function private.prepare_payroll_balance_email_reminder_delivery_at(uuid, uuid, timestamptz)
returns table (
  reminder_id uuid,
  delivery_required boolean,
  recipient_name text,
  recipient_email text,
  reminder_month date,
  missing_companies text[]
)
language sql as $$
  select null::uuid, false, null::text, null::text, null::date, null::text[] where false;
$$;

create function private.fail_payroll_balance_email_reminder_delivery_at(uuid, uuid, text, timestamptz)
returns boolean language sql as $$ select false; $$;

create function private.birthday_reminder_date(date)
returns date language sql immutable strict as $$ select $1 - 1; $$;

create function public.claim_leave_priority_reminders(integer default 100)
returns table (
  delivery_id uuid,
  claim_token uuid,
  event text,
  source_id uuid,
  employee_name text,
  manager_email text,
  company text,
  leave_type text,
  start_date date,
  end_date date,
  status text
)
language sql as $$
  select null::uuid, null::uuid, null::text, null::uuid, null::text, null::text,
    null::text, null::text, null::date, null::date, null::text where false;
$$;

insert into public.internal_org_people (id, node_kind, is_active, started_date)
values
  (
    '30000000-0000-4000-8000-000000000001',
    'person',
    true,
    date '2026-09-11'
  ),
  (
    '30000000-0000-4000-8000-000000000002',
    'person',
    true,
    date '2026-09-15'
  );

insert into private.employee_check_in_reminders (
  id,
  person_id,
  milestone,
  reminder_sequence,
  due_date,
  notify_date,
  delivery_status,
  delivered_at,
  completed_by
)
values (
  '31000000-0000-4000-8000-000000000001',
  '30000000-0000-4000-8000-000000000001',
  '2_week',
  'initial',
  date '2026-09-25',
  date '2026-09-22',
  'completed',
  timestamptz '2026-09-22 00:00:00+00',
  '32000000-0000-4000-8000-000000000001'
), (
  '31000000-0000-4000-8000-000000000002',
  '30000000-0000-4000-8000-000000000001',
  '2_week',
  'initial',
  date '2026-09-28',
  date '2026-09-24',
  'scheduled',
  null,
  null
), (
  '31000000-0000-4000-8000-000000000011',
  '30000000-0000-4000-8000-000000000002',
  '2_week',
  'initial',
  date '2026-09-24',
  date '2026-09-21',
  'completed',
  timestamptz '2026-09-21 00:00:00+00',
  '32000000-0000-4000-8000-000000000002'
), (
  '31000000-0000-4000-8000-000000000012',
  '30000000-0000-4000-8000-000000000002',
  '2_week',
  'initial',
  date '2026-09-29',
  date '2026-09-25',
  'needs_review',
  null,
  null
);

update private.employee_check_in_reminders
set needs_review_reason = 'start_date_changed_after_delivery'
where id = '31000000-0000-4000-8000-000000000012';

insert into private.employee_check_in_reminder_events (reminder_id, event_type)
values
  ('31000000-0000-4000-8000-000000000002', 'scheduled'),
  ('31000000-0000-4000-8000-000000000012', 'needs_review');

insert into private.subscription_register (
  id,
  pricing_model,
  subscription_status,
  next_review_on
)
values (
  '10000000-0000-4000-8000-000000000001',
  'paid',
  'active',
  date '2026-09-25'
);

insert into public.leave_requests (
  id,
  record_origin,
  request_type_label,
  status,
  end_date,
  evidence_due_date
)
values (
  '20000000-0000-4000-8000-000000000001',
  'portal',
  'Sick leave',
  'submitted',
  date '2026-06-05',
  date '2026-06-08'
);
