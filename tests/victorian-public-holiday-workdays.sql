\set ON_ERROR_STOP on

do $$
declare
  v_due date;
  v_notify date;
begin
  if private.is_victorian_business_day(date '2026-09-25') then
    raise exception 'The AFL Grand Final holiday must not be a business day.';
  end if;

  if not private.is_victorian_business_day(date '2026-09-24') then
    raise exception 'The preceding Thursday must remain a business day.';
  end if;

  if private.next_victorian_business_day(date '2026-09-25') <> date '2026-09-28' then
    raise exception 'Holiday work must move to Monday 28 September 2026.';
  end if;

  if private.victorian_business_day_on_or_before(date '2026-12-28') <> date '2026-12-24' then
    raise exception 'The Christmas shutdown sequence must move reminder work to 24 December.';
  end if;

  if private.victorian_business_days_before(date '2027-01-04', 1) <> date '2026-12-31' then
    raise exception 'Business-day subtraction must skip New Year and the weekend.';
  end if;

  select schedule.due_date, schedule.notify_date
    into v_due, v_notify
  from private.employee_check_in_schedule(date '2026-09-11') schedule
  where schedule.milestone = '2_week'
    and schedule.reminder_sequence = 'initial';

  if v_due <> date '2026-09-28' or v_notify <> date '2026-09-24' then
    raise exception 'Check-in schedule did not move both work and notice off the public holiday: %, %.', v_due, v_notify;
  end if;

  if not exists (
    select 1
    from private.employee_check_in_reminders reminder
    where reminder.id = '31000000-0000-4000-8000-000000000001'
      and reminder.delivery_status = 'completed'
      and reminder.due_date = date '2026-09-28'
      and reminder.notify_date = date '2026-09-24'
  ) then
    raise exception 'Completed check-in history must move with the canonical schedule without reopening.';
  end if;

  if exists (
    select 1
    from private.employee_check_in_reminder_events event_row
    where event_row.reminder_id = '31000000-0000-4000-8000-000000000002'
  ) then
    raise exception 'Derived audit rows for a removed unsent duplicate must be removed with that duplicate.';
  end if;

  if not exists (
    select 1
    from private.employee_check_in_reminders reminder
    where reminder.id = '31000000-0000-4000-8000-000000000011'
      and reminder.delivery_status = 'completed'
      and reminder.due_date = date '2026-09-24'
      and reminder.notify_date = date '2026-09-21'
  ) then
    raise exception 'Terminal history from the employee''s earlier start date must remain unchanged.';
  end if;

  if not exists (
    select 1
    from private.employee_check_in_reminders reminder
    where reminder.id = '31000000-0000-4000-8000-000000000012'
      and reminder.delivery_status = 'needs_review'
      and reminder.needs_review_reason = 'start_date_changed_after_delivery'
      and reminder.due_date = date '2026-09-29'
      and reminder.notify_date = date '2026-09-24'
  ) then
    raise exception 'The start-date correction review must survive and move only its holiday notice date.';
  end if;

  if not exists (
    select 1
    from private.employee_check_in_reminder_events event_row
    where event_row.reminder_id = '31000000-0000-4000-8000-000000000012'
      and event_row.event_type = 'needs_review'
  ) then
    raise exception 'The start-date correction review audit history must remain attached.';
  end if;

  insert into private.employee_check_in_reminders (
    id,
    person_id,
    milestone,
    reminder_sequence,
    due_date,
    notify_date,
    delivery_status,
    claim_token,
    claimed_at
  )
  values (
    '31000000-0000-4000-8000-000000000003',
    '30000000-0000-4000-8000-000000000001',
    '1_month',
    'initial',
    date '2026-10-12',
    date '2026-10-06',
    'claimed',
    '33000000-0000-4000-8000-000000000001',
    clock_timestamp()
  );

  insert into private.employee_check_in_reminders (
    id,
    person_id,
    milestone,
    reminder_sequence,
    due_date,
    notify_date,
    delivery_status
  )
  values (
    '31000000-0000-4000-8000-000000000004',
    '30000000-0000-4000-8000-000000000001',
    '1_month',
    'initial',
    date '2026-10-13',
    date '2026-10-07',
    'needs_review'
  );

  if (
    select count(*)
    from private.employee_check_in_reminders reminder
    where reminder.person_id = '30000000-0000-4000-8000-000000000001'
      and reminder.milestone = '1_month'
      and reminder.reminder_sequence = 'initial'
  ) <> 2 then
    raise exception 'A claimed lease must allow its deferred canonical replacement.';
  end if;

  if private.birthday_reminder_date(date '2026-12-29') <> date '2026-12-24' then
    raise exception 'Birthday email must use the preceding Victorian business day.';
  end if;

  if (
    select evidence_due_date
    from public.leave_requests
    where id = '20000000-0000-4000-8000-000000000001'
  ) <> date '2026-06-09' then
    raise exception 'Sick-evidence work must move off the King''s Birthday holiday.';
  end if;

  if (select next_review_on from private.subscription_register where id = '10000000-0000-4000-8000-000000000001')
      <> date '2026-09-28' then
    raise exception 'Existing live subscription review was not moved off the holiday.';
  end if;

  if (select count(*) from private.subscription_audit_events where subscription_id = '10000000-0000-4000-8000-000000000001') <> 1 then
    raise exception 'Subscription review correction must retain one audit event.';
  end if;

  if not exists (
    select 1
    from pg_class relation
    join pg_namespace namespace on namespace.oid = relation.relnamespace
    where namespace.nspname = 'private'
      and relation.relname = 'victorian_public_holidays'
      and relation.relrowsecurity
  ) then
    raise exception 'The private holiday table must have RLS enabled.';
  end if;

  if has_table_privilege('authenticated', 'private.victorian_public_holidays', 'select')
    or has_function_privilege('authenticated', 'private.is_victorian_business_day(date)', 'execute') then
    raise exception 'Authenticated browser roles must not read the scheduling source directly.';
  end if;

  if not has_function_privilege('service_role', 'public.claim_due_payroll_balance_email_reminders(integer)', 'execute')
    or not has_function_privilege('service_role', 'public.claim_leave_priority_reminders(integer)', 'execute') then
    raise exception 'Service reminder boundaries lost their explicit execute grants.';
  end if;

  if position(
    'is_victorian_business_day'
    in pg_get_functiondef('public.claim_due_payroll_balance_email_reminders(integer)'::regprocedure)
  ) = 0 then
    raise exception 'Payroll email claims must be gated by the Victorian workday helper.';
  end if;

  if position(
    'is_victorian_business_day'
    in pg_get_functiondef('public.claim_leave_priority_reminders(integer)'::regprocedure)
  ) = 0 then
    raise exception 'Leave and birthday reminder claims must be gated by the Victorian workday helper.';
  end if;

  if position(
    'next_victorian_business_day'
    in pg_get_functiondef('private.payroll_balance_monthly_reminder_projection()'::regprocedure)
  ) = 0 then
    raise exception 'The monthly Calendar reminder must use the first Victorian business day.';
  end if;

  if position(
    'next_victorian_business_day'
    in pg_get_functiondef('private.set_leave_submission_details()'::regprocedure)
  ) = 0 then
    raise exception 'Sick-evidence deadlines must use the Victorian workday helper.';
  end if;
end;
$$;

select 'victorian public-holiday workday regression passed' as result;
