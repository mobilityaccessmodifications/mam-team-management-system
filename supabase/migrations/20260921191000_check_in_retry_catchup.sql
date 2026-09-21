-- Recover missed reminder days while the check-in is still upcoming.
-- Past-due and historic-cutover records remain explicit review items, never
-- automatically replayed as a burst of historic emails.
begin;
create or replace function public.prepare_employee_check_in_reminder_delivery(
  p_reminder_id uuid,
  p_claim_token uuid
)
returns table (
  reminder_id uuid,
  employee_first_name text,
  employee_last_name text,
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

-- PostgreSQL treats RETURNS TABLE column names as PL/pgSQL variables. The
-- original claim function returned an unqualified reminder_id from its event
-- insert, which is ambiguous at runtime. Keep the established delivery rules
-- and qualify that target explicitly so the automatic dispatcher can claim.
create or replace function public.claim_due_employee_check_in_reminders(p_limit integer default 10)
returns table (
  reminder_id uuid,
  claim_token uuid
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_today date := (clock_timestamp() at time zone 'Australia/Melbourne')::date;
begin
  if p_limit is null or p_limit not between 1 and 25 then
    raise exception 'Invalid reminder batch limit.' using errcode = '22023';
  end if;

  if not private.is_victorian_business_day(v_today) then return; end if;

  with timed_out as (
    update private.employee_check_in_reminders reminder
    set delivery_status = 'scheduled',
        claim_token = null,
        claimed_at = null,
        updated_at = clock_timestamp()
    where reminder.delivery_status = 'claimed'
      and reminder.claimed_at < clock_timestamp() - interval '30 minutes'
    returning reminder.id
  )
  insert into private.employee_check_in_reminder_events (reminder_id, event_type, error_code)
  select id, 'delivery_failed', 'claim_timeout' from timed_out;

  with exhausted as (
    update private.employee_check_in_reminders reminder
    set delivery_status = 'needs_review',
        needs_review_reason = 'retry_exhausted',
        claim_token = null,
        claimed_at = null,
        updated_at = clock_timestamp()
    where reminder.delivery_status = 'scheduled'
      and reminder.attempt_count >= 100
    returning reminder.id
  )
  insert into private.employee_check_in_reminder_events (reminder_id, event_type, error_code)
  select id, 'needs_review', 'retry_exhausted' from exhausted;

  with overdue as (
    update private.employee_check_in_reminders reminder
    set delivery_status = 'needs_review',
        needs_review_reason = 'missed_delivery',
        claim_token = null,
        claimed_at = null,
        updated_at = clock_timestamp()
    where reminder.delivery_status = 'scheduled'
      and (
        reminder.due_date < v_today
      )
      and reminder.manual_catch_up_requested_at is null
    returning reminder.id
  )
  insert into private.employee_check_in_reminder_events (reminder_id, event_type, error_code)
  select id, 'needs_review', 'missed_delivery' from overdue;

  with invalid_context as (
    update private.employee_check_in_reminders reminder
    set delivery_status = 'needs_review',
        needs_review_reason = 'context_changed',
        claim_token = null,
        claimed_at = null,
        updated_at = clock_timestamp()
    where reminder.delivery_status = 'scheduled'
      and not exists (
        select 1
        from public.internal_org_people person
        left join private.employee_check_in_enrolments enrolment
          on enrolment.person_id = person.id
        join private.employee_directory_details detail on detail.person_id = person.id
        where person.id = reminder.person_id
          and person.node_kind = 'person'
          and person.is_active
          and person.started_date is not null
          and nullif(btrim(detail.first_name), '') is not null
          and (
            enrolment.delivery_mode = 'automatic'
            or reminder.manual_catch_up_requested_at is not null
          )
      )
    returning reminder.id
  )
  insert into private.employee_check_in_reminder_events (reminder_id, event_type, error_code)
  select id, 'needs_review', 'context_changed' from invalid_context;

  with missing_recipient as (
    update private.employee_check_in_reminders reminder
    set delivery_status = 'needs_review',
        needs_review_reason = 'missing_manager_email',
        claim_token = null,
        claimed_at = null,
        updated_at = clock_timestamp()
    where reminder.delivery_status = 'scheduled'
      and not exists (
        select 1
        from public.internal_org_people person
        join lateral private.resolve_internal_org_employee_manager(person.id) manager on true
        join private.employee_directory_details manager_detail
          on manager_detail.person_id = manager.manager_id
        where person.id = reminder.person_id
          and manager.manager_id is not null
          and nullif(btrim(manager_detail.work_email), '') is not null
      )
    returning reminder.id
  )
  insert into private.employee_check_in_reminder_events (reminder_id, event_type, error_code)
  select id, 'needs_review', 'missing_manager_email' from missing_recipient;

  return query
  with candidates as (
    select reminder.id
    from private.employee_check_in_reminders reminder
    join public.internal_org_people person on person.id = reminder.person_id
    left join private.employee_check_in_enrolments enrolment
      on enrolment.person_id = person.id
    left join lateral private.resolve_internal_org_employee_manager(person.id) manager on true
    left join private.employee_directory_details detail
      on detail.person_id = person.id
    left join private.employee_directory_details manager_detail
      on manager_detail.person_id = manager.manager_id
    where reminder.delivery_status = 'scheduled'
      and (reminder.notify_date <= v_today or reminder.manual_catch_up_requested_at is not null)
      and (reminder.due_date >= v_today or reminder.manual_catch_up_requested_at is not null)
      and (reminder.next_attempt_at is null or reminder.next_attempt_at <= clock_timestamp())
      and reminder.attempt_count < 100
      and person.node_kind = 'person'
      and person.is_active
      and person.started_date is not null
      and (
        enrolment.delivery_mode = 'automatic'
        or reminder.manual_catch_up_requested_at is not null
      )
      and detail.first_name is not null
      and manager.manager_id is not null
      and nullif(btrim(manager_detail.work_email), '') is not null
    order by reminder.notify_date, reminder.due_date, reminder.created_at
    for update of reminder skip locked
    limit p_limit
  ), claimed as (
    update private.employee_check_in_reminders reminder
    set delivery_status = 'claimed',
        claim_token = gen_random_uuid(),
        claimed_at = clock_timestamp(),
        attempt_count = reminder.attempt_count + 1,
        updated_at = clock_timestamp(),
        last_delivery_error_code = null,
        last_delivery_error_at = null
    from candidates
    where reminder.id = candidates.id
    returning reminder.*
  ), claimed_events as (
    insert into private.employee_check_in_reminder_events as event (reminder_id, event_type)
    select claimed.id, 'claimed' from claimed
    returning event.reminder_id
  )
  select claimed.id, claimed.claim_token from claimed;
end;
$$;

revoke all on function public.claim_due_employee_check_in_reminders(integer) from public,anon,authenticated;
revoke all on function public.prepare_employee_check_in_reminder_delivery(uuid,uuid) from public,anon,authenticated;
grant execute on function public.claim_due_employee_check_in_reminders(integer) to service_role;
grant execute on function public.prepare_employee_check_in_reminder_delivery(uuid,uuid) to service_role;
commit;
