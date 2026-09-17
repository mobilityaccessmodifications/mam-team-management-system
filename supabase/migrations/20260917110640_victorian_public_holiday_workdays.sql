begin;

do $$
begin
  perform pg_advisory_xact_lock(
    hashtextextended('mam:victorian-public-holiday-workdays:20260917', 0)
  );

  if to_regclass('public.internal_org_people') is null
    or to_regclass('private.employee_check_in_reminders') is null
    or to_regclass('private.employee_check_in_reminder_events') is null
    or to_regclass('private.subscription_register') is null
    or to_regclass('private.subscription_audit_events') is null
    or to_regprocedure('private.employee_check_in_schedule(date)') is null
    or to_regprocedure('private.sync_employee_check_in_reminders(uuid,boolean,boolean)') is null
    or to_regprocedure('private.normalise_subscription_review_workday()') is null
    or to_regprocedure('private.set_leave_submission_details()') is null
    or to_regprocedure('private.payroll_balance_monthly_reminder_projection()') is null
    or to_regprocedure('private.claim_due_payroll_balance_email_reminders_at(integer,timestamp with time zone)') is null
    or to_regprocedure('private.prepare_payroll_balance_email_reminder_delivery_at(uuid,uuid,timestamp with time zone)') is null
    or to_regprocedure('private.fail_payroll_balance_email_reminder_delivery_at(uuid,uuid,text,timestamp with time zone)') is null
    or to_regprocedure('private.birthday_reminder_date(date)') is null
    or to_regprocedure('public.claim_leave_priority_reminders(integer)') is null then
    raise exception 'Victorian workday scheduling prerequisites are missing.' using errcode = '55000';
  end if;
end;
$$;

-- Operational work uses the same source-backed dates as the shared Calendar.
-- Keep leave dates and leave-duration calculations separate: this table moves
-- only work tasks and reminder delivery away from a published public holiday.
create table private.victorian_public_holidays (
  holiday_date date primary key,
  holiday_name text not null check (holiday_name = btrim(holiday_name) and holiday_name <> ''),
  source_url text not null check (source_url like 'https://business.vic.gov.au/%'),
  created_at timestamptz not null default clock_timestamp()
);

comment on table private.victorian_public_holidays is
  'Versioned Business Victoria public-holiday dates used to keep operational work and reminder delivery off Victorian public holidays.';

alter table private.victorian_public_holidays enable row level security;
revoke all on table private.victorian_public_holidays from public, anon, authenticated, service_role;

insert into private.victorian_public_holidays (holiday_date, holiday_name, source_url)
values
  ('2025-01-01', 'New Year''s Day', 'https://business.vic.gov.au/business-information/public-holidays/victorian-public-holidays-2025'),
  ('2025-01-27', 'Australia Day', 'https://business.vic.gov.au/business-information/public-holidays/victorian-public-holidays-2025'),
  ('2025-03-10', 'Labour Day', 'https://business.vic.gov.au/business-information/public-holidays/victorian-public-holidays-2025'),
  ('2025-04-18', 'Good Friday', 'https://business.vic.gov.au/business-information/public-holidays/victorian-public-holidays-2025'),
  ('2025-04-19', 'Saturday before Easter Sunday', 'https://business.vic.gov.au/business-information/public-holidays/victorian-public-holidays-2025'),
  ('2025-04-20', 'Easter Sunday', 'https://business.vic.gov.au/business-information/public-holidays/victorian-public-holidays-2025'),
  ('2025-04-21', 'Easter Monday', 'https://business.vic.gov.au/business-information/public-holidays/victorian-public-holidays-2025'),
  ('2025-04-25', 'ANZAC Day', 'https://business.vic.gov.au/business-information/public-holidays/victorian-public-holidays-2025'),
  ('2025-06-09', 'King''s Birthday', 'https://business.vic.gov.au/business-information/public-holidays/victorian-public-holidays-2025'),
  ('2025-09-26', 'Friday before the AFL Grand Final', 'https://business.vic.gov.au/business-information/public-holidays/victorian-public-holidays-2025'),
  ('2025-11-04', 'Melbourne Cup', 'https://business.vic.gov.au/business-information/public-holidays/victorian-public-holidays-2025'),
  ('2025-12-25', 'Christmas Day', 'https://business.vic.gov.au/business-information/public-holidays/victorian-public-holidays-2025'),
  ('2025-12-26', 'Boxing Day', 'https://business.vic.gov.au/business-information/public-holidays/victorian-public-holidays-2025'),
  ('2026-01-01', 'New Year''s Day', 'https://business.vic.gov.au/business-information/public-holidays/victorian-public-holidays-2026'),
  ('2026-01-26', 'Australia Day', 'https://business.vic.gov.au/business-information/public-holidays/victorian-public-holidays-2026'),
  ('2026-03-09', 'Labour Day', 'https://business.vic.gov.au/business-information/public-holidays/victorian-public-holidays-2026'),
  ('2026-04-03', 'Good Friday', 'https://business.vic.gov.au/business-information/public-holidays/victorian-public-holidays-2026'),
  ('2026-04-04', 'Saturday before Easter Sunday', 'https://business.vic.gov.au/business-information/public-holidays/victorian-public-holidays-2026'),
  ('2026-04-05', 'Easter Sunday', 'https://business.vic.gov.au/business-information/public-holidays/victorian-public-holidays-2026'),
  ('2026-04-06', 'Easter Monday', 'https://business.vic.gov.au/business-information/public-holidays/victorian-public-holidays-2026'),
  ('2026-04-25', 'ANZAC Day', 'https://business.vic.gov.au/business-information/public-holidays/victorian-public-holidays-2026'),
  ('2026-06-08', 'King''s Birthday', 'https://business.vic.gov.au/business-information/public-holidays/victorian-public-holidays-2026'),
  ('2026-09-25', 'Friday before the AFL Grand Final', 'https://business.vic.gov.au/business-information/public-holidays/victorian-public-holidays-2026'),
  ('2026-11-03', 'Melbourne Cup', 'https://business.vic.gov.au/business-information/public-holidays/victorian-public-holidays-2026'),
  ('2026-12-25', 'Christmas Day', 'https://business.vic.gov.au/business-information/public-holidays/victorian-public-holidays-2026'),
  ('2026-12-26', 'Boxing Day', 'https://business.vic.gov.au/business-information/public-holidays/victorian-public-holidays-2026'),
  ('2026-12-28', 'Additional Boxing Day public holiday', 'https://business.vic.gov.au/business-information/public-holidays/victorian-public-holidays-2026'),
  ('2027-01-01', 'New Year''s Day', 'https://business.vic.gov.au/business-information/public-holidays/victorian-public-holidays-2027'),
  ('2027-01-26', 'Australia Day', 'https://business.vic.gov.au/business-information/public-holidays/victorian-public-holidays-2027'),
  ('2027-03-08', 'Labour Day', 'https://business.vic.gov.au/business-information/public-holidays/victorian-public-holidays-2027'),
  ('2027-03-26', 'Good Friday', 'https://business.vic.gov.au/business-information/public-holidays/victorian-public-holidays-2027'),
  ('2027-03-27', 'Saturday before Easter Sunday', 'https://business.vic.gov.au/business-information/public-holidays/victorian-public-holidays-2027'),
  ('2027-03-28', 'Easter Sunday', 'https://business.vic.gov.au/business-information/public-holidays/victorian-public-holidays-2027'),
  ('2027-03-29', 'Easter Monday', 'https://business.vic.gov.au/business-information/public-holidays/victorian-public-holidays-2027'),
  ('2027-04-25', 'ANZAC Day', 'https://business.vic.gov.au/business-information/public-holidays/victorian-public-holidays-2027'),
  ('2027-06-14', 'King''s Birthday', 'https://business.vic.gov.au/business-information/public-holidays/victorian-public-holidays-2027'),
  ('2027-11-02', 'Melbourne Cup', 'https://business.vic.gov.au/business-information/public-holidays/victorian-public-holidays-2027'),
  ('2027-12-25', 'Christmas Day', 'https://business.vic.gov.au/business-information/public-holidays/victorian-public-holidays-2027'),
  ('2027-12-26', 'Boxing Day', 'https://business.vic.gov.au/business-information/public-holidays/victorian-public-holidays-2027'),
  ('2027-12-27', 'Additional Christmas Day public holiday', 'https://business.vic.gov.au/business-information/public-holidays/victorian-public-holidays-2027'),
  ('2027-12-28', 'Additional Boxing Day public holiday', 'https://business.vic.gov.au/business-information/public-holidays/victorian-public-holidays-2027'),
  ('2028-01-01', 'New Year''s Day', 'https://business.vic.gov.au/business-information/public-holidays/victorian-public-holidays-2028'),
  ('2028-01-03', 'Additional New Year''s Day public holiday', 'https://business.vic.gov.au/business-information/public-holidays/victorian-public-holidays-2028'),
  ('2028-01-26', 'Australia Day', 'https://business.vic.gov.au/business-information/public-holidays/victorian-public-holidays-2028'),
  ('2028-03-13', 'Labour Day', 'https://business.vic.gov.au/business-information/public-holidays/victorian-public-holidays-2028'),
  ('2028-04-14', 'Good Friday', 'https://business.vic.gov.au/business-information/public-holidays/victorian-public-holidays-2028'),
  ('2028-04-15', 'Saturday before Easter Sunday', 'https://business.vic.gov.au/business-information/public-holidays/victorian-public-holidays-2028'),
  ('2028-04-16', 'Easter Sunday', 'https://business.vic.gov.au/business-information/public-holidays/victorian-public-holidays-2028'),
  ('2028-04-17', 'Easter Monday', 'https://business.vic.gov.au/business-information/public-holidays/victorian-public-holidays-2028'),
  ('2028-04-25', 'ANZAC Day', 'https://business.vic.gov.au/business-information/public-holidays/victorian-public-holidays-2028'),
  ('2028-06-12', 'King''s Birthday', 'https://business.vic.gov.au/business-information/public-holidays/victorian-public-holidays-2028'),
  ('2028-11-07', 'Melbourne Cup', 'https://business.vic.gov.au/business-information/public-holidays/victorian-public-holidays-2028'),
  ('2028-12-25', 'Christmas Day', 'https://business.vic.gov.au/business-information/public-holidays/victorian-public-holidays-2028'),
  ('2028-12-26', 'Boxing Day', 'https://business.vic.gov.au/business-information/public-holidays/victorian-public-holidays-2028');

create function private.is_victorian_business_day(p_date date)
returns boolean
language sql
stable
strict
security definer
set search_path = ''
as $$
  select extract(isodow from p_date)::integer between 1 and 5
    and not exists (
      select 1
      from private.victorian_public_holidays holiday
      where holiday.holiday_date = p_date
    );
$$;

create function private.next_victorian_business_day(p_date date)
returns date
language plpgsql
stable
strict
security definer
set search_path = ''
as $$
declare
  v_cursor date := p_date;
  v_guard integer := 0;
begin
  while not private.is_victorian_business_day(v_cursor) loop
    v_cursor := v_cursor + 1;
    v_guard := v_guard + 1;
    if v_guard > 31 then
      raise exception 'No Victorian business day found after %.', p_date using errcode = '22023';
    end if;
  end loop;
  return v_cursor;
end;
$$;

create function private.victorian_business_day_on_or_before(p_date date)
returns date
language plpgsql
stable
strict
security definer
set search_path = ''
as $$
declare
  v_cursor date := p_date;
  v_guard integer := 0;
begin
  while not private.is_victorian_business_day(v_cursor) loop
    v_cursor := v_cursor - 1;
    v_guard := v_guard + 1;
    if v_guard > 31 then
      raise exception 'No Victorian business day found on or before %.', p_date using errcode = '22023';
    end if;
  end loop;
  return v_cursor;
end;
$$;

create function private.victorian_business_days_before(
  p_date date,
  p_business_days integer
)
returns date
language plpgsql
stable
security definer
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
    if private.is_victorian_business_day(v_cursor) then
      v_remaining := v_remaining - 1;
    end if;
  end loop;

  return v_cursor;
end;
$$;

comment on function private.is_victorian_business_day(date) is
  'True only for Monday-Friday dates that are not in the source-backed Victorian public-holiday table.';
comment on function private.next_victorian_business_day(date) is
  'Returns the supplied date or the next Monday-Friday date that is not a published Victorian public holiday.';
comment on function private.victorian_business_day_on_or_before(date) is
  'Returns the supplied date or the previous Monday-Friday date that is not a published Victorian public holiday.';
comment on function private.victorian_business_days_before(date, integer) is
  'Subtracts a bounded number of Victorian business days, excluding weekends and published public holidays.';

-- Sick leave remains recorded on its actual dates. Its follow-up evidence
-- deadline is operational work, so a Monday public holiday moves the deadline
-- forward to the next Victorian business day.
create or replace function private.set_leave_submission_details()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.record_origin <> 'historical_import' then
    new.submitted_by := auth.uid();
    if new.request_type_label = 'Sick leave' then
      new.evidence_due_date := private.next_victorian_business_day(
        new.end_date + (8 - extract(isodow from new.end_date)::integer)
      );
    end if;
  end if;
  return new;
end;
$$;

update public.leave_requests request
set evidence_due_date = private.next_victorian_business_day(request.evidence_due_date)
where request.record_origin = 'portal'
  and request.request_type_label = 'Sick leave'
  and request.status in ('submitted', 'approved')
  and request.evidence_due_date is not null
  and not private.is_victorian_business_day(request.evidence_due_date);

comment on function private.set_leave_submission_details() is
  'Snapshots the real submitter and places sick evidence on the following Monday, moving it forward only when that date is not a Victorian business day.';

-- Snapshot the exact pre-migration Mon-Fri schedule while the employee start
-- dates and reminder rows are stable. Reconciliation below may then prove a
-- date change came only from this public-holiday policy; an older terminal row
-- from a different start date must never displace a legitimate HR review.
lock table public.internal_org_people in share mode;
lock table private.employee_check_in_reminders in share row exclusive mode;

create temporary table victorian_workday_legacy_check_in_schedule
on commit drop
as
select
  person.id as person_id,
  schedule.milestone,
  schedule.reminder_sequence,
  schedule.due_date,
  schedule.notify_date
from public.internal_org_people person
cross join lateral private.employee_check_in_schedule(person.started_date) schedule
where person.node_kind = 'person'
  and person.is_active
  and person.started_date is not null;

alter table victorian_workday_legacy_check_in_schedule
  add primary key (person_id, milestone, reminder_sequence);

-- Keep the established check-in API names so every existing caller receives
-- the stronger Victorian workday rule without a parallel scheduling path.
create or replace function private.employee_check_in_next_business_day(p_date date)
returns date
language sql
stable
strict
set search_path = ''
as $$
  select private.next_victorian_business_day(p_date);
$$;

create or replace function private.employee_check_in_business_day_on_or_before(p_date date)
returns date
language sql
stable
strict
set search_path = ''
as $$
  select private.victorian_business_day_on_or_before(p_date);
$$;

create or replace function private.employee_check_in_business_days_before(
  p_date date,
  p_business_days integer
)
returns date
language sql
stable
set search_path = ''
as $$
  select private.victorian_business_days_before(p_date, p_business_days);
$$;

create or replace function private.employee_check_in_schedule(p_start_date date)
returns table (
  milestone text,
  reminder_sequence text,
  due_date date,
  notify_date date
)
language sql
stable
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

comment on function private.employee_check_in_next_business_day(date) is
  'Compatibility helper that moves check-in work to the next Victorian business day.';
comment on function private.employee_check_in_business_day_on_or_before(date) is
  'Compatibility helper that moves check-in notification work back to a Victorian business day.';
comment on function private.employee_check_in_business_days_before(date, integer) is
  'Subtracts Victorian business days for check-in notification lead time.';
comment on function private.employee_check_in_schedule(date) is
  'Canonical Victorian-business-day milestone and notification schedule derived only from an employee start date.';

-- Materialise only differences between the captured legacy schedule and the
-- new holiday-aware schedule. Every data mutation below must match both sides
-- of this mapping, which prevents an unrelated start-date correction from
-- being mistaken for a public-holiday-only shift.
create temporary table victorian_workday_check_in_schedule_shifts
on commit drop
as
select
  legacy.person_id,
  legacy.milestone,
  legacy.reminder_sequence,
  legacy.due_date as legacy_due_date,
  legacy.notify_date as legacy_notify_date,
  schedule.due_date as workday_due_date,
  schedule.notify_date as workday_notify_date
from pg_temp.victorian_workday_legacy_check_in_schedule legacy
join public.internal_org_people person on person.id = legacy.person_id
cross join lateral private.employee_check_in_schedule(person.started_date) schedule
where schedule.milestone = legacy.milestone
  and schedule.reminder_sequence = legacy.reminder_sequence
  and (
    schedule.due_date is distinct from legacy.due_date
    or schedule.notify_date is distinct from legacy.notify_date
  );

alter table victorian_workday_check_in_schedule_shifts
  add primary key (person_id, milestone, reminder_sequence);

-- Preserve current open state, including a start-date-correction review, when
-- that row exactly matches the captured current-start-date legacy schedule.
-- A conflicting target row is left untouched for the established synchroniser
-- to resolve; silently replacing either row would lose workflow state.
update private.employee_check_in_reminders reminder
set due_date = shift.workday_due_date,
    notify_date = shift.workday_notify_date,
    updated_at = clock_timestamp()
from pg_temp.victorian_workday_check_in_schedule_shifts shift
where reminder.person_id = shift.person_id
  and reminder.milestone = shift.milestone
  and reminder.reminder_sequence = shift.reminder_sequence
  and reminder.due_date = shift.legacy_due_date
  and reminder.notify_date = shift.legacy_notify_date
  and reminder.delivery_status in ('scheduled', 'needs_review')
  and not exists (
    select 1
    from private.employee_check_in_reminders conflicting
    where conflicting.person_id = reminder.person_id
      and conflicting.milestone = reminder.milestone
      and conflicting.reminder_sequence = reminder.reminder_sequence
      and conflicting.due_date = shift.workday_due_date
      and conflicting.id <> reminder.id
  );

-- If a derived open row already occupies the new key for an exact legacy
-- terminal row, remove only that proven public-holiday duplicate (and its
-- cascading derived events) before moving the real terminal history.
delete from private.employee_check_in_reminders duplicate
using pg_temp.victorian_workday_check_in_schedule_shifts shift
where duplicate.person_id = shift.person_id
  and duplicate.milestone = shift.milestone
  and duplicate.reminder_sequence = shift.reminder_sequence
  and duplicate.due_date = shift.workday_due_date
  and duplicate.notify_date = shift.workday_notify_date
  and (
    duplicate.delivery_status = 'scheduled'
    or (
      duplicate.delivery_status = 'needs_review'
      and duplicate.needs_review_reason is distinct from 'start_date_changed_after_delivery'
    )
  )
  and exists (
    select 1
    from private.employee_check_in_reminders history
    where history.person_id = shift.person_id
      and history.milestone = shift.milestone
      and history.reminder_sequence = shift.reminder_sequence
      and history.due_date = shift.legacy_due_date
      and history.notify_date = shift.legacy_notify_date
      and history.delivery_status in ('delivered', 'completed')
  );

update private.employee_check_in_reminders history
set due_date = shift.workday_due_date,
    notify_date = shift.workday_notify_date,
    updated_at = clock_timestamp()
from pg_temp.victorian_workday_check_in_schedule_shifts shift
where history.person_id = shift.person_id
  and history.milestone = shift.milestone
  and history.reminder_sequence = shift.reminder_sequence
  and history.due_date = shift.legacy_due_date
  and history.notify_date = shift.legacy_notify_date
  and history.delivery_status in ('delivered', 'completed')
  and not exists (
    select 1
    from private.employee_check_in_reminders conflicting
    where conflicting.person_id = history.person_id
      and conflicting.milestone = history.milestone
      and conflicting.reminder_sequence = history.reminder_sequence
      and conflicting.due_date = shift.workday_due_date
      and conflicting.id <> history.id
  );

do $$
begin
  if exists (
    select 1
    from private.employee_check_in_reminders reminder
    join pg_temp.victorian_workday_check_in_schedule_shifts shift
      on shift.person_id = reminder.person_id
     and shift.milestone = reminder.milestone
     and shift.reminder_sequence = reminder.reminder_sequence
     and shift.legacy_due_date = reminder.due_date
     and shift.legacy_notify_date = reminder.notify_date
    where reminder.delivery_status in ('scheduled', 'needs_review')
  ) then
    raise exception 'An unexpected check-in row blocks safe public-holiday workflow-state reconciliation.' using errcode = '55000';
  end if;

  if exists (
    select 1
    from private.employee_check_in_reminders history
    join pg_temp.victorian_workday_check_in_schedule_shifts shift
      on shift.person_id = history.person_id
     and shift.milestone = history.milestone
     and shift.reminder_sequence = history.reminder_sequence
     and shift.legacy_due_date = history.due_date
     and shift.legacy_notify_date = history.notify_date
    where history.delivery_status in ('delivered', 'completed')
  ) then
    raise exception 'A claimed or unexpected check-in row blocks safe public-holiday history reconciliation.' using errcode = '55000';
  end if;
end;
$$;

-- The pre-existing subscription trigger already calls the check-in workday
-- helper. Normalise only live paid work and retain an audit event for each
-- corrected future review date.
with updated as (
  update private.subscription_register subscription
  set next_review_on = private.next_victorian_business_day(subscription.next_review_on)
  where subscription.pricing_model = 'paid'
    and subscription.subscription_status in ('active', 'paused')
    and subscription.next_review_on is not null
    and not private.is_victorian_business_day(subscription.next_review_on)
  returning subscription.id
)
insert into private.subscription_audit_events (
  subscription_id,
  actor_user_id,
  event_type,
  changed_fields
)
select updated.id, null, 'updated', array['next_review_on']::text[]
from updated;

comment on function private.normalise_subscription_review_workday() is
  'Normalises subscription review dates to published Victorian business days using the shared check-in workday helper.';

-- Resynchronise only active employees. The existing routine preserves sent or
-- completed history and supersedes only open rows whose canonical dates move.
select private.sync_employee_check_in_reminders(person.id, false, false)
from public.internal_org_people person
where person.node_kind = 'person'
  and person.is_active;

create or replace function private.payroll_balance_monthly_reminder_projection()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with local_date as (
    select (clock_timestamp() at time zone 'Australia/Melbourne')::date as today
  ), cycle as (
    select
      local_date.today,
      date_trunc('month', local_date.today::timestamp)::date as reminder_month
    from local_date
  ), latest as (
    select
      max(imported.as_of) filter (where imported.company_key = 'mam' and imported.match_status = 'linked') as mam_as_of,
      max(imported.as_of) filter (where imported.company_key = 'equipsy' and imported.match_status = 'linked') as equipsy_as_of
    from private.payroll_balance_imports imported
  )
  select jsonb_build_object(
    'dueOn', private.next_victorian_business_day(cycle.reminder_month),
    'mamAsOf', latest.mam_as_of,
    'equipsyAsOf', latest.equipsy_as_of,
    'mamComplete', latest.mam_as_of >= cycle.reminder_month,
    'equipsyComplete', latest.equipsy_as_of >= cycle.reminder_month,
    'complete', latest.mam_as_of >= cycle.reminder_month
      and latest.equipsy_as_of >= cycle.reminder_month
  )
  from cycle, latest;
$$;

comment on function private.payroll_balance_monthly_reminder_projection() is
  'Returns the current payroll snapshot state with the Calendar due date on the first published Victorian business day of the month.';

-- The time-injectable private routines retain their audited delivery state.
-- These service-role boundaries add a final public-holiday gate before a row
-- can be claimed or resolved to an email address.
create or replace function public.claim_due_payroll_balance_email_reminders(
  p_limit integer default 10
)
returns table (
  reminder_id uuid,
  claim_token uuid
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_today date := (v_now at time zone 'Australia/Melbourne')::date;
begin
  if p_limit is null or p_limit not between 1 and 25 then
    raise exception 'Invalid payroll reminder claim request.' using errcode = '22023';
  end if;
  if not private.is_victorian_business_day(v_today) then
    return;
  end if;
  return query
  select *
  from private.claim_due_payroll_balance_email_reminders_at(p_limit, v_now);
end;
$$;

create or replace function public.prepare_payroll_balance_email_reminder_delivery(
  p_reminder_id uuid,
  p_claim_token uuid
)
returns table (
  reminder_id uuid,
  delivery_required boolean,
  recipient_name text,
  recipient_email text,
  reminder_month date,
  missing_companies text[]
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_today date := (v_now at time zone 'Australia/Melbourne')::date;
begin
  if not private.is_victorian_business_day(v_today) then
    return;
  end if;
  return query
  select *
  from private.prepare_payroll_balance_email_reminder_delivery_at(
    p_reminder_id,
    p_claim_token,
    v_now
  );
end;
$$;

create or replace function public.fail_payroll_balance_email_reminder_delivery(
  p_reminder_id uuid,
  p_claim_token uuid,
  p_error_code text
)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_today date := (v_now at time zone 'Australia/Melbourne')::date;
  v_updated boolean := false;
begin
  if private.is_victorian_business_day(v_today) then
    return private.fail_payroll_balance_email_reminder_delivery_at(
      p_reminder_id,
      p_claim_token,
      p_error_code,
      v_now
    );
  end if;

  with blocked as (
    update private.payroll_balance_email_reminders reminder
    set delivery_status = 'needs_review',
        needs_review_reason = 'missed_delivery',
        claim_token = null,
        claimed_at = null,
        next_attempt_at = null,
        updated_at = v_now
    where reminder.id = p_reminder_id
      and reminder.delivery_status = 'claimed'
      and reminder.claim_token = p_claim_token
    returning reminder.id
  ), audited as (
    insert into private.payroll_balance_email_reminder_events (
      reminder_id,
      event_type,
      error_code
    )
    select blocked.id, 'needs_review', 'missed_delivery'
    from blocked
    returning reminder_id
  )
  select exists (select 1 from blocked) into v_updated;

  return v_updated;
end;
$$;

comment on function public.claim_due_payroll_balance_email_reminders(integer) is
  'Service-only recurring claim: one email per published Victorian business day while a current-month company snapshot remains missing.';
comment on function public.prepare_payroll_balance_email_reminder_delivery(uuid, uuid) is
  'Rechecks the Victorian business day, outstanding snapshots and configured importer before resolving the current HR work email.';

-- Birthdays remain on their actual calendar date. Only the manager email is
-- moved to the preceding Victorian business day.
create or replace function private.birthday_reminder_date(p_birthday date)
returns date
language sql
stable
strict
set search_path = ''
as $$
  select private.victorian_business_day_on_or_before(p_birthday - 1);
$$;

comment on function private.birthday_reminder_date(date) is
  'Returns the Victorian business day immediately before a birthday occurrence.';

create or replace function public.claim_leave_priority_reminders(p_limit integer default 100)
returns table(delivery_id uuid,claim_token uuid,event text,source_id uuid,employee_name text,
  manager_email text,company text,leave_type text,start_date date,end_date date,status text)
language plpgsql security definer set search_path='' as $$
declare
  local_now timestamp := now() at time zone 'Australia/Melbourne';
  today date := local_now::date;
  local_hour integer := extract(hour from local_now);
begin
  if not private.is_victorian_business_day(today) or local_hour<7 or local_hour>=17 then return; end if;
  -- The 07:00 run is birthdays only. Leave reminders still start at 08:00.
  insert into private.leave_priority_reminder_deliveries(kind,source_id,notify_date)
  select 'leave-reminder',r.id,today from public.leave_requests r
  where local_hour>=8 and r.status='submitted' and r.record_origin='portal' and r.approval_required
    and exists(select 1 from public.internal_org_people p where p.id=r.employee_person_id and p.is_active)
    and not exists(select 1 from private.leave_balance_approvals a where a.request_id=r.id)
    and (select count(*) from generate_series((r.submitted_at at time zone 'Australia/Melbourne')::date+1,today,interval '1 day') d
      where private.is_victorian_business_day(d::date))>=3
  on conflict do nothing;
  -- One durable row per conditional request, retried across workdays with the same event key.
  insert into private.leave_priority_reminder_deliveries(kind,source_id,notify_date,balance_ready)
  select 'leave-reminder',a.request_id,today,true from private.leave_balance_approvals a
  where local_hour>=8 and private.leave_payroll_balance_sufficient(a.request_id)
    and not exists(select 1 from private.leave_priority_reminder_deliveries q where q.source_id=a.request_id and q.balance_ready)
  on conflict do nothing;
  insert into private.leave_priority_reminder_deliveries(kind,source_id,notify_date)
  select 'team-birthday',p.id,today
  from public.internal_org_people p join private.employee_directory_details d on d.person_id=p.id
  where p.is_active and p.node_kind='person' and d.date_of_birth is not null
    and exists(select 1 from generate_series(today+1,today+14,interval '1 day') occurrence
      where private.birthday_reminder_date(occurrence::date)=today
        and extract(month from occurrence)=extract(month from d.date_of_birth)
        and extract(day from occurrence)=extract(day from d.date_of_birth))
  on conflict do nothing;
  return query
  with candidates as (
    select q.id from private.leave_priority_reminder_deliveries q
    where (q.notify_date=today or (q.balance_ready and q.notify_date<=today)) and q.sent_at is null and (q.claimed_until is null or q.claimed_until<now())
      and (q.kind='team-birthday' or (local_hour>=8 and ((q.balance_ready and private.leave_payroll_balance_sufficient(q.source_id)) or (not q.balance_ready and exists (
        select 1 from public.leave_requests pending
        where pending.id=q.source_id and pending.status='submitted'
          and pending.record_origin='portal' and pending.approval_required
          and not exists(select 1 from private.leave_balance_approvals a where a.request_id=pending.id)
          and (select count(*) from generate_series(
            (pending.submitted_at at time zone 'Australia/Melbourne')::date+1,today,interval '1 day') d
            where private.is_victorian_business_day(d::date))>=3
      )))))
      -- Rows generated by an older birthday schedule cannot consume a lease.
      and (q.kind<>'team-birthday' or exists (
        select 1 from public.internal_org_people person
        join private.employee_directory_details detail on detail.person_id=person.id
        cross join generate_series(today+1,today+14,interval '1 day') occurrence
        where person.id=q.source_id and person.is_active
          and private.birthday_reminder_date(occurrence::date)=today
          and extract(month from occurrence)=extract(month from detail.date_of_birth)
          and extract(day from occurrence)=extract(day from detail.date_of_birth)
      ))
    order by q.id for update skip locked limit greatest(1,least(coalesce(p_limit,100),100))
  ), claimed as (
    update private.leave_priority_reminder_deliveries q set claim_token=gen_random_uuid(),claimed_until=now()+interval '25 minutes'
    from candidates c where c.id=q.id returning q.*
  )
  select q.id,q.claim_token,q.kind,q.source_id,p.full_name,
    case when q.kind='leave-reminder' then lm.manager_email else md.work_email end,
    p.company_key,coalesce(r.request_type_label,'Birthday'),
    case when q.kind='leave-reminder' then r.start_date else birthday.occurrence end,
    case when q.kind='leave-reminder' then r.end_date else birthday.occurrence end,
    case when a.request_id is not null then 'Approved – pending leave balance' else 'Pending' end
  from claimed q
  left join public.leave_requests r on q.kind='leave-reminder' and r.id=q.source_id
  join public.internal_org_people p on p.id=case when q.kind='team-birthday' then q.source_id else r.employee_person_id end and p.is_active
  left join private.leave_balance_approvals a on a.request_id=r.id
  left join lateral public.resolve_leave_notification_manager(r.id) lm on q.kind='leave-reminder'
  left join lateral private.resolve_internal_org_employee_manager(p.id) bm on q.kind='team-birthday'
  left join private.employee_directory_details md on md.person_id=bm.manager_id
  left join private.employee_directory_details pd on pd.person_id=p.id
  left join lateral (
    select occurrence::date from generate_series(today+1,today+14,interval '1 day') occurrence
    where private.birthday_reminder_date(occurrence::date)=today
      and extract(month from occurrence)=extract(month from pd.date_of_birth)
      and extract(day from occurrence)=extract(day from pd.date_of_birth) limit 1
  ) birthday on q.kind='team-birthday'
  where (q.kind='team-birthday' and birthday.occurrence is not null) or r.status='submitted';
end;
$$;

comment on function public.claim_leave_priority_reminders(integer) is
  'Claims leave and birthday reminders only on published Victorian business days; reminder ageing excludes weekends and public holidays.';

revoke all on function private.is_victorian_business_day(date) from public, anon, authenticated, service_role;
revoke all on function private.next_victorian_business_day(date) from public, anon, authenticated, service_role;
revoke all on function private.victorian_business_day_on_or_before(date) from public, anon, authenticated, service_role;
revoke all on function private.victorian_business_days_before(date, integer) from public, anon, authenticated, service_role;
revoke all on function private.set_leave_submission_details() from public, anon, authenticated, service_role;
revoke all on function private.employee_check_in_next_business_day(date) from public, anon, authenticated, service_role;
revoke all on function private.employee_check_in_business_day_on_or_before(date) from public, anon, authenticated, service_role;
revoke all on function private.employee_check_in_business_days_before(date, integer) from public, anon, authenticated, service_role;
revoke all on function private.employee_check_in_schedule(date) from public, anon, authenticated, service_role;
revoke all on function private.payroll_balance_monthly_reminder_projection() from public, anon, authenticated, service_role;
revoke all on function private.birthday_reminder_date(date) from public, anon, authenticated, service_role;
revoke all on function public.claim_due_payroll_balance_email_reminders(integer) from public, anon, authenticated, service_role;
revoke all on function public.prepare_payroll_balance_email_reminder_delivery(uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function public.fail_payroll_balance_email_reminder_delivery(uuid, uuid, text) from public, anon, authenticated, service_role;
revoke all on function public.claim_leave_priority_reminders(integer) from public, anon, authenticated, service_role;

grant execute on function public.claim_due_payroll_balance_email_reminders(integer) to service_role;
grant execute on function public.prepare_payroll_balance_email_reminder_delivery(uuid, uuid) to service_role;
grant execute on function public.fail_payroll_balance_email_reminder_delivery(uuid, uuid, text) to service_role;
grant execute on function public.claim_leave_priority_reminders(integer) to service_role;

do $$
begin
  if private.is_victorian_business_day(date '2026-09-25')
    or private.next_victorian_business_day(date '2026-09-25') <> date '2026-09-28'
    or private.victorian_business_day_on_or_before(date '2026-12-28') <> date '2026-12-24'
    or private.victorian_business_days_before(date '2027-01-04', 1) <> date '2026-12-31' then
    raise exception 'Victorian business-day migration verification failed.' using errcode = '55000';
  end if;
end;
$$;

commit;
