begin;

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
      ('2_week'::text, 'initial'::text, 14, 'business'::text, 3),
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
      when 'business' then private.employee_check_in_business_days_before(planned.due_date, raw_schedule.lead_days)
      else private.employee_check_in_business_day_on_or_before(planned.due_date - raw_schedule.lead_days)
    end
  from raw_schedule
  cross join lateral (
    select private.employee_check_in_next_business_day(p_start_date + raw_schedule.day_offset) as due_date
  ) planned;
$$;

comment on function private.employee_check_in_schedule(date) is
  'Canonical Victorian-business-day milestone schedule; the 2-Week email is sent three business days before the Check-In.';

select private.sync_employee_check_in_reminders(person.id, false, false)
from public.internal_org_people person
where person.node_kind = 'person' and person.is_active;

drop function public.prepare_employee_check_in_reminder_delivery(uuid, uuid);

create or replace function public.prepare_employee_check_in_reminder_delivery(
  p_reminder_id uuid,
  p_claim_token uuid
)
returns table (
  reminder_id uuid,
  employee_first_name text,
  employee_last_name text,
  employee_work_email text,
  employee_personal_email text,
  role text,
  department text,
  manager_name text,
  manager_email text,
  milestone text,
  reminder_sequence text,
  due_date date,
  notify_date date
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_reminder private.employee_check_in_reminders%rowtype;
  v_first_name text;
  v_last_name text;
  v_employee_work_email text;
  v_employee_personal_email text;
  v_role text;
  v_department text;
  v_manager_name text;
  v_manager_id uuid;
  v_manager_email text;
  v_delivery_mode text;
  v_employee_is_current boolean;
  v_expected_due_date date;
  v_expected_notify_date date;
  v_needs_review_reason text;
begin
  select reminder.*
  into v_reminder
  from private.employee_check_in_reminders reminder
  where reminder.id = p_reminder_id
    and reminder.delivery_status = 'claimed'
    and reminder.claim_token = p_claim_token
  for update;

  if not found then
    return;
  end if;

  select
    detail.first_name,
    detail.last_name,
    lower(nullif(btrim(detail.work_email), '')),
    lower(nullif(btrim(detail.personal_email), '')),
    person.position_title,
    detail.team_name,
    manager.manager_name,
    manager.manager_id,
    manager_detail.work_email,
    enrolment.delivery_mode,
    canonical.due_date,
    canonical.notify_date,
    (
      person.node_kind = 'person'
      and person.is_active
      and person.started_date is not null
    )
  into
    v_first_name,
    v_last_name,
    v_employee_work_email,
    v_employee_personal_email,
    v_role,
    v_department,
    v_manager_name,
    v_manager_id,
    v_manager_email,
    v_delivery_mode,
    v_expected_due_date,
    v_expected_notify_date,
    v_employee_is_current
  from public.internal_org_people person
  left join private.employee_directory_details detail on detail.person_id = person.id
  left join lateral private.resolve_internal_org_employee_manager(person.id) manager on true
  left join private.employee_directory_details manager_detail
    on manager_detail.person_id = manager.manager_id
  left join private.employee_check_in_enrolments enrolment
    on enrolment.person_id = person.id
  left join lateral private.employee_check_in_schedule(person.started_date) canonical
    on canonical.milestone = v_reminder.milestone
    and canonical.reminder_sequence = v_reminder.reminder_sequence
  where person.id = v_reminder.person_id;

  if not found or not coalesce(v_employee_is_current, false)
    or nullif(btrim(v_first_name), '') is null
    or nullif(btrim(v_role), '') is null
    or nullif(btrim(v_department), '') is null
    or nullif(btrim(v_manager_name), '') is null then
    v_needs_review_reason := 'context_changed';
  elsif v_expected_due_date is null
    or v_expected_notify_date is null
    or v_reminder.due_date is distinct from v_expected_due_date
    or v_reminder.notify_date is distinct from v_expected_notify_date then
    -- A claimed row from an obsolete start-date schedule must never be sent.
    -- The next sync supersedes it and creates the canonical workday row.
    v_needs_review_reason := 'context_changed';
  elsif v_delivery_mode is distinct from 'automatic'
    and v_reminder.manual_catch_up_requested_at is null then
    v_needs_review_reason := 'not_enrolled';
  elsif v_reminder.milestone = '2_week'
    and v_employee_work_email is null
    and v_employee_personal_email is null then
    v_needs_review_reason := 'context_changed';
  elsif v_manager_id is null or nullif(btrim(v_manager_email), '') is null then
    v_needs_review_reason := 'missing_manager_email';
  elsif v_reminder.manual_catch_up_requested_at is null
    and (
      v_reminder.notify_date > (clock_timestamp() at time zone 'Australia/Melbourne')::date
      or v_reminder.due_date < (clock_timestamp() at time zone 'Australia/Melbourne')::date
    ) then
    v_needs_review_reason := 'missed_delivery';
  end if;

  if v_needs_review_reason is not null then
    with invalidated as (
      update private.employee_check_in_reminders reminder
      set delivery_status = 'needs_review',
          needs_review_reason = v_needs_review_reason,
          claim_token = null,
          claimed_at = null,
          updated_at = clock_timestamp()
      where reminder.id = p_reminder_id
        and reminder.delivery_status = 'claimed'
        and reminder.claim_token = p_claim_token
      returning reminder.id
    )
    insert into private.employee_check_in_reminder_events (reminder_id, event_type, error_code)
    select id, 'needs_review', v_needs_review_reason from invalidated;
    return;
  end if;

  -- This is the final mutable-context check. Once returned, these values are
  -- the immutable recipient/content snapshot for this provider delivery.
  return query
  select
    v_reminder.id,
    btrim(v_first_name),
    coalesce(nullif(btrim(v_last_name), ''), '—'),
    v_employee_work_email,
    v_employee_personal_email,
    v_role,
    v_department,
    v_manager_name,
    v_manager_email,
    v_reminder.milestone,
    v_reminder.reminder_sequence,
    v_reminder.due_date,
    v_reminder.notify_date;
end;
$$;

comment on function public.prepare_employee_check_in_reminder_delivery(uuid, uuid) is
  'Service-only final context check for Check-In delivery; 2-Week messages include current employee work and personal email recipients.';

revoke all on function public.prepare_employee_check_in_reminder_delivery(uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.prepare_employee_check_in_reminder_delivery(uuid, uuid)
  to service_role;

do $$
declare
  v_due date;
  v_notify date;
begin
  select schedule.due_date, schedule.notify_date into v_due, v_notify
  from private.employee_check_in_schedule(date '2026-09-14') schedule
  where schedule.milestone = '2_week' and schedule.reminder_sequence = 'initial';

  if v_due <> date '2026-09-28' or v_notify <> date '2026-09-22' then
    raise exception '2-Week Check-In must notify three Victorian business days before the due date: %, %', v_due, v_notify;
  end if;

  if has_function_privilege('authenticated', 'public.prepare_employee_check_in_reminder_delivery(uuid,uuid)', 'execute')
    or not has_function_privilege('service_role', 'public.prepare_employee_check_in_reminder_delivery(uuid,uuid)', 'execute') then
    raise exception 'Check-In delivery preparation privileges are incorrect.';
  end if;
end;
$$;

commit;
