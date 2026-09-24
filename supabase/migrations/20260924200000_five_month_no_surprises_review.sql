begin;

do $$
begin
  if to_regclass('private.employee_check_in_reminders') is null
    or to_regclass('private.employee_check_in_reviews') is null
    or to_regprocedure('private.employee_check_in_schedule(date)') is null
    or to_regprocedure('private.sync_employee_check_in_reminders(uuid,boolean,boolean)') is null
    or to_regprocedure('private.resolve_internal_org_employee_manager(uuid)') is null
    or to_regprocedure('public.record_employee_check_in_review(uuid,text,date,text,bigint)') is null
    or to_regprocedure('private.notification_event_key_valid(text)') is null then
    raise exception '5-Month No-Surprises Review prerequisites are missing.' using errcode = '55000';
  end if;
end;
$$;

create table private.people_hub_release_flags (
  feature text primary key,
  enabled boolean not null default false,
  enabled_at timestamptz,
  check (
    (enabled and enabled_at is not null)
    or (not enabled and enabled_at is null)
  )
);

comment on table private.people_hub_release_flags is
  'Private deployment gates for staged People Hub releases. Browser and service roles have no direct access.';

alter table private.people_hub_release_flags enable row level security;
alter table private.people_hub_release_flags force row level security;
revoke all on table private.people_hub_release_flags
  from public, anon, authenticated, service_role;

insert into private.people_hub_release_flags (feature, enabled, enabled_at)
values ('five_month_no_surprises_review', false, null);

-- Serialize the one-reminder cutover with the reminder worker. If a legacy
-- five-month lease is already in flight, abort the whole migration before any
-- schema or schedule change is recorded. The deploy helper can retry after the
-- short lease completes or expires.
lock table private.employee_check_in_reminders in access exclusive mode;

do $$
begin
  if exists (
    select 1
    from private.employee_check_in_reminders reminder
    where reminder.milestone = '5_month'
      and reminder.delivery_status = 'claimed'
  ) then
    raise exception 'A 5-Month reminder delivery is in flight; retry the cutover after the lease clears.'
      using errcode = '55000';
  end if;
end;
$$;

-- Pause future five-month work until the app and the reviewed live n8n
-- workflow are both deployed. Historical initial deliveries remain visible;
-- every legacy final row is removed from active UI projections while its
-- append-only event history remains available for audit.
with superseded as (
  update private.employee_check_in_reminders reminder
  set delivery_status = 'superseded',
      needs_review_reason = null,
      claim_token = null,
      claimed_at = null,
      next_attempt_at = null,
      manual_catch_up_requested_at = null,
      updated_at = clock_timestamp()
  where reminder.milestone = '5_month'
    and reminder.delivery_status <> 'superseded'
    and (
      reminder.reminder_sequence = 'final'
      or reminder.delivery_status in ('scheduled', 'needs_review')
    )
  returning reminder.id
)
insert into private.employee_check_in_reminder_events (reminder_id, event_type)
select id, 'superseded' from superseded;

create or replace function private.notification_event_key_valid(p_key text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select coalesce(length(p_key) <= 160 and p_key ~ (
    '^(leave:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:' ||
    '(leave-submitted|leave-approved|leave-declined|leave-cancelled|leave-conditionally-approved|leave-reminder|team-birthday):[0-9a-f]{24}' ||
    '|payroll-balance:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:[0-9]{4}-(0[1-9]|1[0-2])' ||
    '|payroll-comparison:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' ||
    '|new-starter:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:day-one:(test|live)' ||
    '|checkin:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:(2-week|1-month|2-month|3-month|5-month):initial:(test|live)' ||
    '|checkin-review:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:hr:[1-9][0-9]*:(test|live))$'
  ), false)
$$;

revoke all on function private.notification_event_key_valid(text)
  from public, anon, authenticated, service_role;

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
  with raw_schedule(milestone, reminder_sequence, day_offset, lead_days) as (
    values
      ('2_week'::text, 'initial'::text, 14, 3),
      ('1_month'::text, 'initial'::text, 30, 3),
      ('2_month'::text, 'initial'::text, 60, 3),
      ('3_month'::text, 'initial'::text, 90, 5),
      ('5_month'::text, 'initial'::text, 150, 5)
  )
  select
    raw_schedule.milestone,
    raw_schedule.reminder_sequence,
    planned.due_date,
    private.employee_check_in_business_days_before(planned.due_date, raw_schedule.lead_days)
  from raw_schedule
  cross join lateral (
    select private.employee_check_in_next_business_day(p_start_date + raw_schedule.day_offset) as due_date
  ) planned
  where raw_schedule.milestone <> '5_month'
    or coalesce((
      select release.enabled
      from private.people_hub_release_flags release
      where release.feature = 'five_month_no_surprises_review'
    ), false);
$$;

comment on function private.employee_check_in_schedule(date) is
  'Canonical Victorian-business-day Check-In schedule. The 2-Week, 1-Month and 2-Month emails are sent three business days before; the 3-Month and released 5-Month reviews are sent five business days before.';

create or replace function private.employee_five_month_group_already_satisfied(
  p_person_id uuid,
  p_due_date date
)
returns boolean
language sql
stable
strict
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from private.employee_check_in_reminders final_reminder
    where final_reminder.person_id = p_person_id
      and final_reminder.milestone = '5_month'
      and final_reminder.reminder_sequence = 'final'
      and final_reminder.due_date = p_due_date
      and (
        final_reminder.delivered_at is not null
        or final_reminder.completed_by is not null
        or exists (
          select 1
          from private.employee_check_in_reminder_events event
          where event.reminder_id = final_reminder.id
            and (
              event.event_type = 'delivered'
              or (event.event_type = 'completed' and event.actor_user_id is not null)
            )
        )
      )
  );
$$;

comment on function private.employee_five_month_group_already_satisfied(uuid, date) is
  'True when a legacy final reminder has real delivery or manager-completion evidence for the same employee and due date.';

revoke all on function private.employee_five_month_group_already_satisfied(uuid, date)
  from public, anon, authenticated, service_role;

create or replace function private.prevent_legacy_satisfied_five_month_reactivation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.milestone = '5_month'
    and new.reminder_sequence = 'initial'
    and new.delivery_status in ('scheduled', 'claimed', 'needs_review')
    and private.employee_five_month_group_already_satisfied(new.person_id, new.due_date) then
    return null;
  end if;

  return new;
end;
$$;

create trigger employee_check_in_reminders_prevent_legacy_five_month_reactivation
before insert or update of person_id, milestone, reminder_sequence, due_date, delivery_status
on private.employee_check_in_reminders
for each row execute function private.prevent_legacy_satisfied_five_month_reactivation();

revoke all on function private.prevent_legacy_satisfied_five_month_reactivation()
  from public, anon, authenticated, service_role;

create or replace function private.activate_five_month_no_surprises_review()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_person_id uuid;
  v_release_enabled boolean;
begin
  select release.enabled
  into v_release_enabled
  from private.people_hub_release_flags release
  where release.feature = 'five_month_no_surprises_review'
  for update;

  if not found then
    raise exception 'The 5-Month release gate is missing.' using errcode = '55000';
  end if;

  if v_release_enabled then
    return;
  end if;

  lock table private.employee_check_in_reminders in access exclusive mode;

  if exists (
    select 1
    from private.employee_check_in_reminders reminder
    where reminder.milestone = '5_month'
      and reminder.delivery_status = 'claimed'
  ) then
    raise exception 'A 5-Month reminder delivery is in flight; retry activation after the lease clears.'
      using errcode = '55000';
  end if;

  update private.people_hub_release_flags release
  set enabled = true,
      enabled_at = coalesce(release.enabled_at, clock_timestamp())
  where release.feature = 'five_month_no_surprises_review';

  with superseded as (
    update private.employee_check_in_reminders final_reminder
    set delivery_status = 'superseded',
        needs_review_reason = null,
        claim_token = null,
        claimed_at = null,
        next_attempt_at = null,
        manual_catch_up_requested_at = null,
        updated_at = clock_timestamp()
    where final_reminder.milestone = '5_month'
      and final_reminder.reminder_sequence = 'final'
      and final_reminder.delivery_status not in ('superseded', 'cancelled')
    returning final_reminder.id
  )
  insert into private.employee_check_in_reminder_events (reminder_id, event_type)
  select id, 'superseded' from superseded;

  with superseded as (
    update private.employee_check_in_reminders initial_reminder
    set delivery_status = 'superseded',
        needs_review_reason = null,
        claim_token = null,
        claimed_at = null,
        next_attempt_at = null,
        manual_catch_up_requested_at = null,
        updated_at = clock_timestamp()
    where initial_reminder.milestone = '5_month'
      and initial_reminder.reminder_sequence = 'initial'
      and initial_reminder.delivery_status in ('scheduled', 'needs_review')
      and private.employee_five_month_group_already_satisfied(
        initial_reminder.person_id,
        initial_reminder.due_date
      )
    returning initial_reminder.id
  )
  insert into private.employee_check_in_reminder_events (reminder_id, event_type)
  select id, 'superseded' from superseded;

  for v_person_id in
    select person.id
    from public.internal_org_people person
    where person.node_kind = 'person'
      and person.is_active
      and person.started_date is not null
  loop
    perform private.sync_employee_check_in_reminders(v_person_id, false, false);
  end loop;

  if exists (
    select 1
    from private.employee_check_in_reminders initial_reminder
    where initial_reminder.milestone = '5_month'
      and initial_reminder.reminder_sequence = 'initial'
      and initial_reminder.delivery_status in ('scheduled', 'claimed', 'needs_review')
      and private.employee_five_month_group_already_satisfied(
        initial_reminder.person_id,
        initial_reminder.due_date
      )
  ) then
    raise exception 'A legacy-satisfied 5-Month group was reactivated.' using errcode = '55000';
  end if;
end;
$$;

comment on function private.activate_five_month_no_surprises_review() is
  'Atomically enables and backfills the 5-Month No-Surprises Review after the reviewed app and email receiver are live, while suppressing groups already satisfied by a real legacy final interaction.';

revoke all on function private.activate_five_month_no_surprises_review()
  from public, anon, authenticated, service_role;

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
      and reminder.due_date < v_today
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
      and (
        reminder.milestone <> '5_month'
        or exists (
          select 1
          from private.people_hub_release_flags release
          where release.feature = 'five_month_no_surprises_review'
            and release.enabled
          )
      )
      and not (
        reminder.milestone = '5_month'
        and reminder.reminder_sequence <> 'initial'
      )
      and not (
        reminder.milestone = '5_month'
        and reminder.reminder_sequence = 'initial'
        and private.employee_five_month_group_already_satisfied(
          reminder.person_id,
          reminder.due_date
        )
      )
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

revoke all on function public.claim_due_employee_check_in_reminders(integer)
  from public, anon, authenticated, service_role;
grant execute on function public.claim_due_employee_check_in_reminders(integer)
  to service_role;

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

  if v_reminder.milestone = '5_month'
    and (
      v_reminder.reminder_sequence <> 'initial'
      or not exists (
        select 1
        from private.people_hub_release_flags release
        where release.feature = 'five_month_no_surprises_review'
          and release.enabled
      )
      or (
        v_reminder.reminder_sequence = 'initial'
        and private.employee_five_month_group_already_satisfied(
          v_reminder.person_id,
          v_reminder.due_date
        )
      )
    ) then
    with superseded as (
      update private.employee_check_in_reminders reminder
      set delivery_status = 'superseded',
          needs_review_reason = null,
          claim_token = null,
          claimed_at = null,
          next_attempt_at = null,
          manual_catch_up_requested_at = null,
          updated_at = clock_timestamp()
      where reminder.id = p_reminder_id
        and reminder.delivery_status = 'claimed'
        and reminder.claim_token = p_claim_token
      returning reminder.id
    )
    insert into private.employee_check_in_reminder_events (reminder_id, event_type)
    select id, 'superseded' from superseded;
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
    v_needs_review_reason := 'context_changed';
  elsif v_delivery_mode is distinct from 'automatic'
    and v_reminder.manual_catch_up_requested_at is null then
    v_needs_review_reason := 'not_enrolled';
  elsif v_reminder.milestone in ('2_week', '1_month', '2_month', '3_month', '5_month')
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
  'Service-only final context check for Check-In delivery; every released milestone includes current employee work and personal email recipients.';

revoke all on function public.prepare_employee_check_in_reminder_delivery(uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.prepare_employee_check_in_reminder_delivery(uuid, uuid)
  to service_role;

create or replace function private.sync_employee_check_in_reminders_after_manager_work_email_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_person_id uuid;
  v_work_email_changed boolean;
begin
  if tg_op = 'INSERT' then
    perform private.sync_employee_check_in_reminders(new.person_id, true, false);
    v_work_email_changed := true;
  else
    if new.first_name is distinct from old.first_name
      or new.team_name is distinct from old.team_name
      or new.work_email is distinct from old.work_email
      or new.personal_email is distinct from old.personal_email then
      perform private.sync_employee_check_in_reminders(new.person_id, true, false);
    end if;
    v_work_email_changed := new.work_email is distinct from old.work_email;
  end if;

  if v_work_email_changed then
    for v_person_id in
      select person.id
      from public.internal_org_people person
      join lateral private.resolve_internal_org_employee_manager(person.id) manager on true
      where person.node_kind = 'person'
        and person.is_active
        and manager.manager_id = new.person_id
    loop
      perform private.sync_employee_check_in_reminders(v_person_id, true, false);
    end loop;
  end if;

  return new;
end;
$$;

drop trigger employee_directory_details_sync_employee_check_in_manager_email
  on private.employee_directory_details;

create trigger employee_directory_details_sync_employee_check_in_manager_email
after insert or update of first_name, team_name, work_email, personal_email
on private.employee_directory_details
for each row execute function private.sync_employee_check_in_reminders_after_manager_work_email_change();

revoke all on function private.sync_employee_check_in_reminders_after_manager_work_email_change()
  from public, anon, authenticated, service_role;

create table private.employee_check_in_review_notifications (
  id uuid primary key default gen_random_uuid(),
  review_id uuid not null
    references private.employee_check_in_reviews (id) on delete restrict,
  transition_version bigint not null check (transition_version > 0),
  status text not null default 'scheduled'
    check (status in ('scheduled', 'claimed', 'delivered', 'needs_review', 'cancelled')),
  failure_count integer not null default 0 check (failure_count between 0 and 8),
  next_attempt_at timestamptz not null default clock_timestamp(),
  claim_token uuid,
  claimed_at timestamptz,
  delivered_at timestamptz,
  provider_delivery_id text
    check (
      provider_delivery_id is null
      or (
        char_length(provider_delivery_id) between 1 and 200
        and provider_delivery_id ~ '^[A-Za-z0-9._:-]+$'
      )
    ),
  last_error_code text
    check (
      last_error_code is null
      or last_error_code in (
        'network_error',
        'provider_timeout',
        'provider_rejected',
        'invalid_response',
        'configuration_error',
        'retry_exhausted'
      )
    ),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  constraint employee_check_in_review_notifications_unique
    unique (review_id, transition_version),
  constraint employee_check_in_review_notification_claim_shape check (
    (status = 'claimed' and claim_token is not null and claimed_at is not null)
    or (status <> 'claimed' and claim_token is null and claimed_at is null)
  ),
  constraint employee_check_in_review_notification_delivery_shape check (
    (status = 'delivered' and delivered_at is not null)
    or (status <> 'delivered' and delivered_at is null)
  )
);

create index employee_check_in_review_notifications_due_idx
  on private.employee_check_in_review_notifications (next_attempt_at, created_at)
  where status = 'scheduled';

comment on table private.employee_check_in_review_notifications is
  'Durable, recipient-free outbox for People & Culture alerts when a Check-In enters the HR review pathway.';

alter table private.employee_check_in_review_notifications enable row level security;
alter table private.employee_check_in_review_notifications force row level security;
revoke all on table private.employee_check_in_review_notifications
  from public, anon, authenticated, service_role;

create function public.claim_due_employee_check_in_review_notifications(
  p_limit integer default 10
)
returns table (
  notification_id uuid,
  claim_token uuid
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := clock_timestamp();
begin
  if p_limit is null or p_limit not between 1 and 25 then
    raise exception 'Invalid review notification batch limit.' using errcode = '22023';
  end if;

  update private.employee_check_in_review_notifications notification
  set status = case when notification.failure_count + 1 >= 8 then 'needs_review' else 'scheduled' end,
      failure_count = least(8, notification.failure_count + 1),
      next_attempt_at = v_now,
      last_error_code = case
        when notification.failure_count + 1 >= 8 then 'retry_exhausted'
        else 'provider_timeout'
      end,
      claim_token = null,
      claimed_at = null,
      updated_at = v_now
  where notification.status = 'claimed'
    and notification.claimed_at < v_now - interval '30 minutes';

  return query
  with candidates as (
    select notification.id
    from private.employee_check_in_review_notifications notification
    where notification.status = 'scheduled'
      and notification.failure_count < 8
      and notification.next_attempt_at <= v_now
    order by notification.next_attempt_at, notification.created_at
    limit p_limit
    for update skip locked
  ), claimed as (
    update private.employee_check_in_review_notifications notification
    set status = 'claimed',
        claim_token = gen_random_uuid(),
        claimed_at = v_now,
        updated_at = v_now
    from candidates
    where notification.id = candidates.id
    returning notification.id, notification.claim_token
  )
  select claimed.id, claimed.claim_token from claimed;
end;
$$;

create function public.prepare_employee_check_in_review_notification_delivery(
  p_notification_id uuid,
  p_claim_token uuid
)
returns table (
  notification_id uuid,
  review_id uuid,
  review_version bigint,
  employee_name text,
  manager_name text,
  milestone text,
  review_date date,
  notes text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_notification private.employee_check_in_review_notifications%rowtype;
  v_review private.employee_check_in_reviews%rowtype;
  v_employee_name text;
  v_manager_name text;
  v_milestone text;
  v_person_active boolean;
begin
  select notification.*
  into v_notification
  from private.employee_check_in_review_notifications notification
  where notification.id = p_notification_id
    and notification.status = 'claimed'
    and notification.claim_token = p_claim_token
    and notification.claimed_at >= clock_timestamp() - interval '30 minutes'
  for update;

  if not found then
    return;
  end if;

  select review.*
  into v_review
  from private.employee_check_in_reviews review
  where review.id = v_notification.review_id;

  if not found or v_review.outcome_code <> 'hr_review_required' then
    update private.employee_check_in_review_notifications notification
    set status = 'cancelled',
        claim_token = null,
        claimed_at = null,
        updated_at = clock_timestamp()
    where notification.id = v_notification.id
      and notification.status = 'claimed'
      and notification.claim_token = p_claim_token;
    return;
  end if;

  select
    person.full_name,
    manager.manager_name,
    reminder.milestone,
    (person.node_kind = 'person' and person.is_active)
  into
    v_employee_name,
    v_manager_name,
    v_milestone,
    v_person_active
  from private.employee_check_in_reminders reminder
  join public.internal_org_people person on person.id = reminder.person_id
  left join lateral private.resolve_internal_org_employee_manager(person.id) manager on true
  where reminder.id = v_review.reminder_id;

  if not found
    or not coalesce(v_person_active, false)
    or nullif(btrim(v_employee_name), '') is null
    or nullif(btrim(v_manager_name), '') is null
    or v_milestone not in ('2_week', '1_month', '2_month', '3_month', '5_month')
    or nullif(btrim(v_review.notes), '') is null then
    update private.employee_check_in_review_notifications notification
    set status = 'needs_review',
        last_error_code = 'configuration_error',
        claim_token = null,
        claimed_at = null,
        updated_at = clock_timestamp()
    where notification.id = v_notification.id
      and notification.status = 'claimed'
      and notification.claim_token = p_claim_token;
    return;
  end if;

  return query
  select
    v_notification.id,
    v_review.id,
    v_notification.transition_version,
    btrim(v_employee_name),
    btrim(v_manager_name),
    v_milestone,
    v_review.review_date,
    v_review.notes;
end;
$$;

create function public.complete_employee_check_in_review_notification_delivery(
  p_notification_id uuid,
  p_claim_token uuid,
  p_provider_delivery_id text default null
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_updated boolean := false;
begin
  update private.employee_check_in_review_notifications notification
  set status = 'delivered',
      delivered_at = clock_timestamp(),
      provider_delivery_id = case
        when p_provider_delivery_id ~ '^[A-Za-z0-9._:-]{1,200}$' then p_provider_delivery_id
        else null
      end,
      last_error_code = null,
      claim_token = null,
      claimed_at = null,
      updated_at = clock_timestamp()
  where notification.id = p_notification_id
    and notification.status = 'claimed'
    and notification.claim_token = p_claim_token;

  v_updated := found;
  return v_updated;
end;
$$;

create function public.fail_employee_check_in_review_notification_delivery(
  p_notification_id uuid,
  p_claim_token uuid,
  p_error_code text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_notification private.employee_check_in_review_notifications%rowtype;
  v_error_code text;
  v_failure_count integer;
begin
  v_error_code := case lower(coalesce(nullif(btrim(p_error_code), ''), ''))
    when 'network_error' then 'network_error'
    when 'provider_timeout' then 'provider_timeout'
    when 'provider_rejected' then 'provider_rejected'
    when 'invalid_response' then 'invalid_response'
    when 'configuration_error' then 'configuration_error'
    else null
  end;

  if v_error_code is null then
    raise exception 'Invalid review notification error code.' using errcode = '22023';
  end if;

  select notification.*
  into v_notification
  from private.employee_check_in_review_notifications notification
  where notification.id = p_notification_id
    and notification.status = 'claimed'
    and notification.claim_token = p_claim_token
  for update;

  if not found then
    return false;
  end if;

  v_failure_count := v_notification.failure_count + 1;

  update private.employee_check_in_review_notifications notification
  set status = case when v_failure_count >= 8 then 'needs_review' else 'scheduled' end,
      failure_count = least(8, v_failure_count),
      next_attempt_at = clock_timestamp()
        + make_interval(mins => least(360, 5 * (2 ^ least(v_failure_count, 6))::integer)),
      last_error_code = case
        when v_failure_count >= 8 then 'retry_exhausted'
        else v_error_code
      end,
      claim_token = null,
      claimed_at = null,
      updated_at = clock_timestamp()
  where notification.id = v_notification.id;

  return true;
end;
$$;

revoke all on function public.claim_due_employee_check_in_review_notifications(integer)
  from public, anon, authenticated, service_role;
revoke all on function public.prepare_employee_check_in_review_notification_delivery(uuid, uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.complete_employee_check_in_review_notification_delivery(uuid, uuid, text)
  from public, anon, authenticated, service_role;
revoke all on function public.fail_employee_check_in_review_notification_delivery(uuid, uuid, text)
  from public, anon, authenticated, service_role;

grant execute on function public.claim_due_employee_check_in_review_notifications(integer)
  to service_role;
grant execute on function public.prepare_employee_check_in_review_notification_delivery(uuid, uuid)
  to service_role;
grant execute on function public.complete_employee_check_in_review_notification_delivery(uuid, uuid, text)
  to service_role;
grant execute on function public.fail_employee_check_in_review_notification_delivery(uuid, uuid, text)
  to service_role;

create or replace function public.record_employee_check_in_review(
  p_reminder_id uuid,
  p_outcome_code text,
  p_review_date date,
  p_notes text,
  p_expected_version bigint default null
)
returns table (
  review_id uuid,
  outcome_code text,
  review_date date,
  notes text,
  version bigint,
  recorded_at timestamptz,
  updated_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_selected private.employee_check_in_reminders%rowtype;
  v_canonical private.employee_check_in_reminders%rowtype;
  v_existing private.employee_check_in_reviews%rowtype;
  v_saved private.employee_check_in_reviews%rowtype;
  v_notes text := btrim(coalesce(p_notes, ''));
  v_today date := (clock_timestamp() at time zone 'Australia/Melbourne')::date;
  v_entered_hr_review boolean := false;
begin
  if v_actor is null or coalesce(((select auth.jwt()) ->> 'is_anonymous')::boolean, false) then
    raise exception 'An authenticated reviewer is required.' using errcode = '42501';
  end if;

  if p_reminder_id is null then
    raise exception 'A check-in is required.' using errcode = '22004';
  end if;

  if p_outcome_code is null
    or p_outcome_code not in ('on_track', 'follow_up_required', 'hr_review_required') then
    raise exception 'Choose a valid review outcome.' using errcode = '22023';
  end if;

  if p_review_date is null or p_review_date > v_today then
    raise exception 'The review date cannot be in the future.' using errcode = '22023';
  end if;

  if char_length(v_notes) > 2000 then
    raise exception 'Review notes must be 2000 characters or fewer.' using errcode = '22001';
  end if;

  if p_outcome_code <> 'on_track' and v_notes = '' then
    raise exception 'Add a short note for an outcome that needs follow-up.' using errcode = '22023';
  end if;

  select reminder.*
  into v_selected
  from private.employee_check_in_reminders reminder
  join public.internal_org_people person on person.id = reminder.person_id
  where reminder.id = p_reminder_id
    and person.node_kind = 'person'
    and person.is_active;

  if not found then
    raise exception 'The check-in does not exist.' using errcode = '23503';
  end if;

  if not private.can_view_employee_check_in(v_selected.person_id) then
    raise exception 'This check-in is outside your access scope.' using errcode = '42501';
  end if;

  if v_selected.due_date > v_today then
    raise exception 'A future check-in cannot be reviewed.' using errcode = '22023';
  end if;

  perform 1
  from private.employee_check_in_reminders reminder
  where reminder.person_id = v_selected.person_id
    and reminder.milestone = v_selected.milestone
    and reminder.due_date = v_selected.due_date
  order by reminder.id
  for update;

  if not private.can_view_employee_check_in(v_selected.person_id) then
    raise exception 'This check-in is outside your access scope.' using errcode = '42501';
  end if;

  if exists (
    select 1
    from private.employee_check_in_reminders reminder
    where reminder.person_id = v_selected.person_id
      and reminder.milestone = v_selected.milestone
      and reminder.due_date = v_selected.due_date
      and reminder.delivery_status = 'claimed'
  ) then
    raise exception 'This check-in reminder is currently being delivered. Refresh and try again.'
      using errcode = '55000';
  end if;

  select reminder.*
  into v_canonical
  from private.employee_check_in_reminders reminder
  where reminder.person_id = v_selected.person_id
    and reminder.milestone = v_selected.milestone
    and reminder.due_date = v_selected.due_date
    and reminder.reminder_sequence = 'initial'
  order by reminder.id
  limit 1;

  if not found then
    raise exception 'The check-in record is incomplete.' using errcode = '55000';
  end if;

  if v_canonical.delivery_status = 'claimed' then
    raise exception 'This check-in reminder is currently being delivered. Refresh and try again.' using errcode = '55000';
  end if;

  if v_canonical.delivery_status in ('cancelled', 'superseded') then
    raise exception 'This check-in is no longer available.' using errcode = '55000';
  end if;

  select review.*
  into v_existing
  from private.employee_check_in_reviews review
  where review.reminder_id = v_canonical.id
  for update;

  if found then
    perform 1
    from private.employee_check_in_review_notifications notification
    where notification.review_id = v_existing.id
    order by notification.id
    for update;

    if v_existing.outcome_code = 'hr_review_required'
      and p_outcome_code <> 'hr_review_required'
      and exists (
        select 1
        from private.employee_check_in_review_notifications notification
        where notification.review_id = v_existing.id
          and notification.status = 'claimed'
      ) then
      raise exception 'The People & Culture notification is currently being delivered. Refresh and try again.'
        using errcode = '55000';
    end if;

    if v_existing.outcome_code = p_outcome_code
      and v_existing.review_date = p_review_date
      and v_existing.notes = v_notes then
      v_saved := v_existing;
    else
      if p_expected_version is null or p_expected_version <> v_existing.version then
        raise exception 'This review outcome changed. Refresh and try again.' using errcode = '40001';
      end if;

      v_entered_hr_review := p_outcome_code = 'hr_review_required'
        and v_existing.outcome_code <> 'hr_review_required';

      update private.employee_check_in_reviews review
      set outcome_code = p_outcome_code,
          review_date = p_review_date,
          notes = v_notes,
          version = review.version + 1,
          updated_by_user_id = v_actor,
          updated_at = clock_timestamp()
      where review.id = v_existing.id
        and review.version = p_expected_version
      returning review.* into v_saved;

      if not found then
        raise exception 'This review outcome changed. Refresh and try again.' using errcode = '40001';
      end if;
    end if;
  else
    if p_expected_version is not null then
      raise exception 'This review outcome changed. Refresh and try again.' using errcode = '40001';
    end if;

    insert into private.employee_check_in_reviews (
      reminder_id,
      outcome_code,
      review_date,
      notes,
      recorded_by_user_id,
      updated_by_user_id
    ) values (
      v_canonical.id,
      p_outcome_code,
      p_review_date,
      v_notes,
      v_actor,
      v_actor
    )
    returning * into v_saved;

    v_entered_hr_review := p_outcome_code = 'hr_review_required';
  end if;

  if v_saved.outcome_code <> 'hr_review_required' then
    update private.employee_check_in_review_notifications notification
    set status = 'cancelled',
        claim_token = null,
        claimed_at = null,
        updated_at = clock_timestamp()
    where notification.review_id = v_saved.id
      and notification.status in ('scheduled', 'needs_review');
  elsif v_entered_hr_review then
    insert into private.employee_check_in_review_notifications (
      review_id,
      transition_version
    ) values (
      v_saved.id,
      v_saved.version
    )
    on conflict on constraint employee_check_in_review_notifications_unique do nothing;
  end if;

  with completed as (
    update private.employee_check_in_reminders reminder
    set delivery_status = 'completed',
        completed_at = coalesce(reminder.completed_at, clock_timestamp()),
        completed_by = coalesce(reminder.completed_by, v_actor),
        updated_at = clock_timestamp(),
        claim_token = null,
        claimed_at = null,
        next_attempt_at = null,
        manual_catch_up_requested_at = null,
        needs_review_reason = null
    where reminder.person_id = v_selected.person_id
      and reminder.milestone = v_selected.milestone
      and reminder.due_date = v_selected.due_date
      and reminder.delivery_status in ('scheduled', 'delivered', 'needs_review')
    returning reminder.id
  )
  insert into private.employee_check_in_reminder_events (
    reminder_id,
    event_type,
    actor_user_id
  )
  select completed.id, 'completed', v_actor
  from completed;

  return query
  select
    v_saved.id,
    v_saved.outcome_code,
    v_saved.review_date,
    v_saved.notes,
    v_saved.version,
    v_saved.recorded_at,
    v_saved.updated_at;
end;
$$;

comment on function public.record_employee_check_in_review(uuid, text, date, text, bigint) is
  'Records or updates one scoped Check-In outcome, completes the milestone and transactionally queues a recipient-free People & Culture alert when the outcome enters the HR review pathway.';

revoke all on function public.record_employee_check_in_review(uuid, text, date, text, bigint)
  from public, anon, authenticated, service_role;
grant execute on function public.record_employee_check_in_review(uuid, text, date, text, bigint)
  to authenticated;

do $$
begin
  if (select count(*) <> 1
      from private.people_hub_release_flags release
      where release.feature = 'five_month_no_surprises_review')
    or coalesce((select release.enabled
      from private.people_hub_release_flags release
      where release.feature = 'five_month_no_surprises_review'), true)
    or exists (
      select 1
      from private.employee_check_in_schedule(date '2026-09-14') schedule
      where schedule.milestone = '5_month'
    ) then
    raise exception 'The 5-Month release must remain disabled during the staged migration.';
  end if;
end;
$$;

update private.people_hub_release_flags
set enabled = true,
    enabled_at = clock_timestamp()
where feature = 'five_month_no_surprises_review';

do $$
declare
  v_due date;
  v_notify date;
  v_count integer;
begin
  select schedule.due_date, schedule.notify_date, count(*) over ()
  into v_due, v_notify, v_count
  from private.employee_check_in_schedule(date '2026-09-14') schedule
  where schedule.milestone = '5_month';

  if v_count <> 1
    or v_due <> date '2027-02-11'
    or v_notify <> date '2027-02-04' then
    raise exception '5-Month No-Surprises Review must have one five-business-day reminder: %, %, %',
      v_count, v_due, v_notify;
  end if;

  if exists (
    select 1
    from private.employee_check_in_schedule(date '2026-09-14') schedule
    where schedule.milestone = '5_month'
      and schedule.reminder_sequence <> 'initial'
  ) then
    raise exception '5-Month No-Surprises Review must not have a second reminder.';
  end if;

  if exists (
    select 1
    from private.employee_check_in_reminders reminder
    where reminder.milestone = '5_month'
      and reminder.delivery_status in ('scheduled', 'claimed', 'needs_review')
  ) then
    raise exception '5-Month reminders must remain paused until the reviewed live workflow is active.';
  end if;

  if exists (
    select 1
    from private.employee_check_in_reminders reminder
    where reminder.milestone = '5_month'
      and reminder.reminder_sequence = 'final'
      and reminder.delivery_status not in ('superseded', 'cancelled')
  ) then
    raise exception 'Legacy 5-Month final reminders remain active.';
  end if;

  if coalesce(position(
      'personal_email'
      in pg_get_triggerdef(
        (select oid from pg_trigger
         where tgname = 'employee_directory_details_sync_employee_check_in_manager_email'
           and not tgisinternal)
      )
    ), 0) = 0 then
    raise exception 'Personal-email recovery is missing from the Check-In resync trigger.';
  end if;

  if not private.notification_event_key_valid(
      'checkin:00000000-0000-4000-8000-000000000001:5-month:initial:live'
    )
    or not private.notification_event_key_valid(
      'checkin-review:00000000-0000-4000-8000-000000000001:hr:1:live'
    )
    or private.notification_event_key_valid(
      'checkin:00000000-0000-4000-8000-000000000001:5-month:final:live'
    ) then
    raise exception 'Check-In notification receipt key validation is incorrect.';
  end if;

  if not (
      select relrowsecurity and relforcerowsecurity
      from pg_class
      where oid = 'private.employee_check_in_review_notifications'::regclass
    )
    or has_table_privilege('authenticated', 'private.employee_check_in_review_notifications', 'select')
    or has_table_privilege('service_role', 'private.employee_check_in_review_notifications', 'select') then
    raise exception 'People & Culture notification outbox isolation is incorrect.';
  end if;

  if has_function_privilege(
      'authenticated',
      'public.claim_due_employee_check_in_review_notifications(integer)',
      'execute'
    )
    or not has_function_privilege(
      'service_role',
      'public.claim_due_employee_check_in_review_notifications(integer)',
      'execute'
    ) then
    raise exception 'People & Culture notification worker privileges are incorrect.';
  end if;

  if not (
      select relrowsecurity and relforcerowsecurity
      from pg_class
      where oid = 'private.people_hub_release_flags'::regclass
    )
    or has_table_privilege('authenticated', 'private.people_hub_release_flags', 'select')
    or has_table_privilege('service_role', 'private.people_hub_release_flags', 'select')
    or to_regprocedure('private.activate_five_month_no_surprises_review()') is null
    or to_regprocedure(
      'private.employee_five_month_group_already_satisfied(uuid,date)'
    ) is null
    or has_function_privilege(
      'authenticated',
      'private.activate_five_month_no_surprises_review()',
      'execute'
    )
    or has_function_privilege(
      'service_role',
      'private.activate_five_month_no_surprises_review()',
      'execute'
    )
    or not exists (
      select 1
      from pg_trigger trigger
      where trigger.tgrelid = 'private.employee_check_in_reminders'::regclass
        and trigger.tgname = 'employee_check_in_reminders_prevent_legacy_five_month_reactivation'
        and not trigger.tgisinternal
        and trigger.tgenabled <> 'D'
    )
    or position(
      'people_hub_release_flags'
      in pg_get_functiondef(
        'public.claim_due_employee_check_in_reminders(integer)'::regprocedure
      )
    ) = 0
    or position(
      'people_hub_release_flags'
      in pg_get_functiondef(
        'public.prepare_employee_check_in_reminder_delivery(uuid,uuid)'::regprocedure
      )
    ) = 0 then
    raise exception 'The staged 5-Month release gate isolation is incorrect.';
  end if;
end;
$$;

update private.people_hub_release_flags
set enabled = false,
    enabled_at = null
where feature = 'five_month_no_surprises_review';

do $$
begin
  if (select count(*) <> 1
      from private.people_hub_release_flags release
      where release.feature = 'five_month_no_surprises_review')
    or coalesce((select release.enabled
      from private.people_hub_release_flags release
      where release.feature = 'five_month_no_surprises_review'), true)
    or exists (
      select 1
      from private.employee_check_in_schedule(date '2026-09-14') schedule
      where schedule.milestone = '5_month'
    )
    or exists (
      select 1
      from private.employee_check_in_reminders reminder
      where reminder.milestone = '5_month'
        and reminder.delivery_status in ('scheduled', 'claimed', 'needs_review')
    ) then
    raise exception 'The 5-Month release was not durably paused after migration validation.';
  end if;
end;
$$;

commit;
