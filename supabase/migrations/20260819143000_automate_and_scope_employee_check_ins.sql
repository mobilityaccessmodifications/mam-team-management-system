begin;

-- Check-in milestones are work events. Weekend milestones move forward to
-- Monday, while reminder emails move backward when a lead-time date lands on
-- a weekend. Public holidays are not inferred without an approved source.
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
    -- Lead time is measured from the actual Monday-Friday check-in date. If
    -- that advance date is itself a weekend, move it backward so the manager
    -- still receives the full agreed notice before the scheduled check-in.
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

comment on function private.employee_check_in_schedule(date) is
  'Canonical Mon-Fri milestone and notification schedule derived only from an employee start date.';

-- Replace the original scheduler with the canonical workday schedule. The
-- safety rules around missing managers, stale claims and historic email
-- delivery remain unchanged.
create or replace function private.sync_employee_check_in_reminders(
  p_person_id uuid,
  p_invalidate_claims boolean default false,
  p_start_date_changed boolean default false
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_person public.internal_org_people%rowtype;
  v_today date := (clock_timestamp() at time zone 'Australia/Melbourne')::date;
  v_enrolment_mode text;
  v_employee_first_name text;
  v_employee_role text;
  v_employee_department text;
  v_manager_name text;
  v_manager_id uuid;
  v_manager_work_email text;
  v_outbound_context_is_valid boolean;
  v_has_delivery_history boolean;
  v_schedule_status text;
  v_needs_review_reason text;
begin
  if p_person_id is null then
    return;
  end if;

  select person.* into v_person
  from public.internal_org_people person
  where person.id = p_person_id
  for key share;

  if not found or v_person.node_kind <> 'person' or not v_person.is_active then
    with cancelled as (
      update private.employee_check_in_reminders reminder
      set delivery_status = 'cancelled',
          needs_review_reason = null,
          updated_at = clock_timestamp(),
          claim_token = null,
          claimed_at = null
      where reminder.person_id = p_person_id
        and reminder.delivery_status in ('scheduled', 'needs_review')
      returning reminder.id
    )
    insert into private.employee_check_in_reminder_events (reminder_id, event_type)
    select id, 'cancelled' from cancelled;
    return;
  end if;

  -- Automatic delivery is the only active-roster mode. This upsert is part of
  -- every sync so a previously inactive person, or a converted org node, is
  -- automatically restored without an HR-only enrolment button.
  insert into private.employee_check_in_enrolments as enrolment (
    person_id,
    delivery_mode,
    updated_at,
    enrolled_by
  )
  values (p_person_id, 'automatic', clock_timestamp(), null)
  on conflict (person_id) do update
  set delivery_mode = 'automatic',
      updated_at = excluded.updated_at,
      enrolled_by = null
  where enrolment.delivery_mode is distinct from 'automatic';

  if v_person.started_date is null then
    with cancelled as (
      update private.employee_check_in_reminders reminder
      set delivery_status = 'cancelled',
          needs_review_reason = null,
          updated_at = clock_timestamp(),
          claim_token = null,
          claimed_at = null
      where reminder.person_id = p_person_id
        and reminder.delivery_status in ('scheduled', 'needs_review')
      returning reminder.id
    )
    insert into private.employee_check_in_reminder_events (reminder_id, event_type)
    select id, 'cancelled' from cancelled;
    return;
  end if;

  select enrolment.delivery_mode into v_enrolment_mode
  from private.employee_check_in_enrolments enrolment
  where enrolment.person_id = p_person_id
  for key share;

  select
    detail.first_name,
    person.position_title,
    detail.team_name,
    manager.manager_name,
    manager.manager_id,
    manager_detail.work_email
  into
    v_employee_first_name,
    v_employee_role,
    v_employee_department,
    v_manager_name,
    v_manager_id,
    v_manager_work_email
  from public.internal_org_people person
  left join private.employee_directory_details detail
    on detail.person_id = person.id
  left join lateral private.resolve_internal_org_employee_manager(person.id) manager on true
  left join private.employee_directory_details manager_detail
    on manager_detail.person_id = manager.manager_id
  where person.id = p_person_id;

  -- This one predicate is also the recovery gate for a context_changed row.
  -- A future reminder can return to scheduled only when every value required
  -- by the outbound manager message is currently usable.
  v_outbound_context_is_valid :=
    nullif(btrim(v_employee_first_name), '') is not null
    and nullif(btrim(v_employee_role), '') is not null
    and nullif(btrim(v_employee_department), '') is not null
    and nullif(btrim(v_manager_name), '') is not null
    and v_manager_id is not null
    and nullif(btrim(v_manager_work_email), '') is not null;

  -- Cutoff backfill rows have neither a provider delivery timestamp nor a
  -- completing actor. They are migration state, not real interaction history.
  select exists (
    select 1 from private.employee_check_in_reminders reminder
    where reminder.person_id = p_person_id
      and reminder.delivery_status in ('delivered', 'completed')
      and (
        reminder.delivered_at is not null
        or reminder.completed_by is not null
      )
  ) into v_has_delivery_history;

  if v_enrolment_mode is distinct from 'automatic' then
    v_schedule_status := 'needs_review';
    v_needs_review_reason := 'not_enrolled';
  elsif p_start_date_changed and v_has_delivery_history then
    v_schedule_status := 'needs_review';
    v_needs_review_reason := 'start_date_changed_after_delivery';
  elsif not v_outbound_context_is_valid then
    v_schedule_status := 'needs_review';
    v_needs_review_reason := case
      when v_manager_id is null or nullif(btrim(v_manager_work_email), '') is null
        then 'missing_manager_email'
      else 'context_changed'
    end;
  else
    v_schedule_status := 'scheduled';
    v_needs_review_reason := null;
  end if;

  -- A claimed row is a short-lived authorization lease. Preparation below
  -- re-resolves the latest employee and manager context; once it returns, that
  -- recipient is the immutable snapshot for this delivery. Org edits never
  -- clear an in-flight token after the provider may already have accepted it.
  -- A crashed lease is released by the claim timeout and revalidated before
  -- it can be claimed again. The parameter remains for signature compatibility.

  -- The July 2026 cutover is a permanent scheduling invariant, not merely a
  -- one-time migration update. Later reactivation or start-date corrections
  -- must never reopen an historical milestone as work for HR or a manager.
  with cutoff_completed as (
    update private.employee_check_in_reminders reminder
    set delivery_status = 'completed',
        completed_at = coalesce(reminder.completed_at, clock_timestamp()),
        completed_by = null,
        claim_token = null,
        claimed_at = null,
        next_attempt_at = null,
        manual_catch_up_requested_at = null,
        needs_review_reason = null,
        updated_at = clock_timestamp()
    where reminder.person_id = p_person_id
      and reminder.due_date < date '2026-07-01'
      and reminder.delivery_status in ('scheduled', 'needs_review', 'delivered')
      and exists (
        select 1
        from private.employee_check_in_schedule(v_person.started_date) desired
        where desired.milestone = reminder.milestone
          and desired.reminder_sequence = reminder.reminder_sequence
          and desired.due_date = reminder.due_date
          and desired.notify_date = reminder.notify_date
      )
    returning reminder.id
  )
  insert into private.employee_check_in_reminder_events (reminder_id, event_type)
  select id, 'completed' from cutoff_completed;

  with desired as (
    select * from private.employee_check_in_schedule(v_person.started_date)
  ), superseded as (
    update private.employee_check_in_reminders reminder
    set delivery_status = 'superseded',
        needs_review_reason = null,
        updated_at = clock_timestamp(),
        claim_token = null,
        claimed_at = null
    where reminder.person_id = p_person_id
      and (
        reminder.delivery_status in ('scheduled', 'needs_review')
        or (
          reminder.delivery_status = 'completed'
          and reminder.due_date < date '2026-07-01'
        )
      )
      and not exists (
        select 1 from desired
        where desired.milestone = reminder.milestone
          and desired.reminder_sequence = reminder.reminder_sequence
          and desired.due_date = reminder.due_date
          and desired.notify_date = reminder.notify_date
      )
    returning reminder.id
  )
  insert into private.employee_check_in_reminder_events (reminder_id, event_type)
  select id, 'superseded' from superseded;

  -- A recoverable context failure returns to the automatic schedule only when
  -- every outbound employee and manager field above is valid. The date guard
  -- prevents a repaired record from producing a late or surprise email.
  with refreshed as (
    update private.employee_check_in_reminders reminder
    set delivery_status = case
          when v_schedule_status = 'needs_review' and reminder.delivery_status = 'scheduled' then 'needs_review'
          when v_schedule_status = 'scheduled'
            and reminder.delivery_status = 'needs_review'
            and reminder.needs_review_reason in (
              'not_enrolled',
              'missing_manager_email',
              'historic_cutover',
              'context_changed'
            )
            and reminder.notify_date >= v_today then 'scheduled'
          else reminder.delivery_status
        end,
        needs_review_reason = case
          when v_schedule_status = 'needs_review' and reminder.delivery_status = 'scheduled' then v_needs_review_reason
          when v_schedule_status = 'scheduled'
            and reminder.delivery_status = 'needs_review'
            and reminder.needs_review_reason in (
              'not_enrolled',
              'missing_manager_email',
              'historic_cutover',
              'context_changed'
            )
            and reminder.notify_date >= v_today then null
          else reminder.needs_review_reason
        end,
        updated_at = clock_timestamp()
    where reminder.person_id = p_person_id
      and reminder.delivery_status in ('scheduled', 'needs_review')
      and (
        (v_schedule_status = 'needs_review' and reminder.delivery_status = 'scheduled')
        or (
          v_schedule_status = 'scheduled'
          and reminder.delivery_status = 'needs_review'
          and reminder.needs_review_reason in (
            'not_enrolled',
            'missing_manager_email',
            'historic_cutover',
            'context_changed'
          )
          and reminder.notify_date >= v_today
        )
      )
    returning reminder.id, reminder.delivery_status
  )
  insert into private.employee_check_in_reminder_events (reminder_id, event_type)
  select id, case when delivery_status = 'needs_review' then 'needs_review' else 'scheduled' end
  from refreshed;

  with desired as (
    select * from private.employee_check_in_schedule(v_person.started_date)
  ), inserted as (
    insert into private.employee_check_in_reminders as existing (
      person_id,
      milestone,
      reminder_sequence,
      due_date,
      notify_date,
      delivery_status,
      needs_review_reason,
      completed_at,
      completed_by
    )
    select
      p_person_id,
      desired.milestone,
      desired.reminder_sequence,
      desired.due_date,
      desired.notify_date,
      case
        when desired.due_date < date '2026-07-01' then 'completed'
        when desired.notify_date < v_today then 'needs_review'
        else v_schedule_status
      end,
      case
        when desired.due_date < date '2026-07-01' then null
        when desired.notify_date < v_today then 'historic_cutover'
        else v_needs_review_reason
      end,
      case when desired.due_date < date '2026-07-01' then clock_timestamp() else null end,
      null
    from desired
    on conflict (person_id, milestone, reminder_sequence, due_date) do update
    set notify_date = excluded.notify_date,
        delivery_status = excluded.delivery_status,
        needs_review_reason = excluded.needs_review_reason,
        attempt_count = 0,
        next_attempt_at = null,
        claim_token = null,
        claimed_at = null,
        delivered_at = null,
        provider_delivery_id = null,
        manual_catch_up_requested_at = null,
        last_delivery_error_code = null,
        last_delivery_error_at = null,
        completed_at = excluded.completed_at,
        completed_by = excluded.completed_by,
        updated_at = clock_timestamp()
    where existing.delivery_status in ('superseded', 'cancelled')
    returning id, delivery_status
  )
  insert into private.employee_check_in_reminder_events (reminder_id, event_type)
  select id, case delivery_status
    when 'needs_review' then 'needs_review'
    when 'completed' then 'completed'
    else 'scheduled'
  end
  from inserted;
end;
$$;

-- Keep automatic reminder state aligned with every organisation field used by
-- the outbound DTO. A title edit affects the employee's own message, while a
-- manager name or structural edit can affect current reports. The sync keeps
-- an already-claimed lease intact; preparation remains its final validation.
create or replace function private.sync_employee_check_in_reminders_after_org_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_person_id uuid;
  v_hierarchy_changed boolean;
  v_manager_name_changed boolean;
begin
  if tg_op = 'INSERT' then
    if new.node_kind = 'person' then
      insert into private.employee_check_in_enrolments (person_id, delivery_mode)
      values (new.id, 'automatic')
      on conflict (person_id) do update
      set delivery_mode = 'automatic',
          updated_at = clock_timestamp(),
          enrolled_by = null;

      perform private.sync_employee_check_in_reminders(new.id, false, false);
    end if;
    return new;
  end if;

  v_hierarchy_changed := new.parent_id is distinct from old.parent_id
    or new.node_kind is distinct from old.node_kind
    or new.is_active is distinct from old.is_active;
  v_manager_name_changed := new.full_name is distinct from old.full_name;

  if v_hierarchy_changed then
    -- Re-resolve the whole small active roster because a structural edit can
    -- change the closest person-manager for more than one subtree.
    for v_person_id in
      select person.id
      from public.internal_org_people person
      where person.node_kind = 'person'
        and person.is_active
    loop
      perform private.sync_employee_check_in_reminders(v_person_id, true, false);
    end loop;
  elsif v_manager_name_changed and new.node_kind = 'person' then
    -- Manager display name is sourced from the live organisation person.
    -- Resync only employees for whom this person is the current manager.
    for v_person_id in
      select person.id
      from public.internal_org_people person
      join lateral private.resolve_internal_org_employee_manager(person.id) manager on true
      where person.node_kind = 'person'
        and person.is_active
        and manager.manager_id = new.id
    loop
      perform private.sync_employee_check_in_reminders(v_person_id, true, false);
    end loop;
  end if;

  if old.node_kind = 'person' then
    -- This covers start date and position title repairs for the employee.
    perform private.sync_employee_check_in_reminders(
      old.id,
      v_hierarchy_changed or new.started_date is distinct from old.started_date,
      new.started_date is distinct from old.started_date
    );
  elsif new.node_kind = 'person' then
    insert into private.employee_check_in_enrolments (person_id, delivery_mode)
    values (new.id, 'automatic')
    on conflict (person_id) do update
    set delivery_mode = 'automatic',
        updated_at = clock_timestamp(),
        enrolled_by = null;

    perform private.sync_employee_check_in_reminders(new.id, true, true);
  end if;

  return new;
end;
$$;

drop trigger internal_org_people_sync_employee_check_in_reminders
  on public.internal_org_people;

create trigger internal_org_people_sync_employee_check_in_reminders
after insert or update of
  started_date,
  is_active,
  parent_id,
  node_kind,
  position_title,
  full_name
on public.internal_org_people
for each row execute function private.sync_employee_check_in_reminders_after_org_change();

-- Employee detail rows are commonly inserted after the public organisation
-- row. Resyncing after that insert closes the create-wrapper ordering gap.
-- Later first-name/department repairs resync the employee; manager work-email
-- repairs also resync every current report, preserving the previous behavior.
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
      or new.work_email is distinct from old.work_email then
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
after insert or update of first_name, team_name, work_email
on private.employee_directory_details
for each row execute function private.sync_employee_check_in_reminders_after_manager_work_email_change();

revoke all on function private.sync_employee_check_in_reminders_after_org_change()
  from public, anon, authenticated;
revoke all on function private.sync_employee_check_in_reminders_after_manager_work_email_change()
  from public, anon, authenticated;

-- Employee last name is optional in the canonical Directory. Preserve the
-- strict outbound contract for single-name employees with a minimal display
-- fallback instead of permanently rejecting their manager reminder.
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
      v_reminder.notify_date <> (clock_timestamp() at time zone 'Australia/Melbourne')::date
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
        reminder.notify_date < v_today
        or reminder.due_date < v_today
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
      and (reminder.notify_date = v_today or reminder.manual_catch_up_requested_at is not null)
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

-- Automatic mode is now the only active-roster mode. Missing start dates or
-- manager emails remain visible as data issues but never require an enrol or
-- catch-up button.
insert into private.employee_check_in_enrolments (
  person_id,
  delivery_mode,
  updated_at,
  enrolled_by
)
select person.id, 'automatic', clock_timestamp(), null
from public.internal_org_people person
where person.node_kind = 'person'
  and person.is_active
on conflict (person_id) do update
set delivery_mode = 'automatic',
    updated_at = excluded.updated_at,
    enrolled_by = null;

select private.sync_employee_check_in_reminders(person.id, true, false)
from public.internal_org_people person
where person.node_kind = 'person'
  and person.is_active;

-- The agreed cutover treats every milestone before July 2026 as complete.
-- This is an auditable status change and never sends an email.
with completed as (
  update private.employee_check_in_reminders reminder
  set delivery_status = 'completed',
      completed_at = coalesce(reminder.completed_at, clock_timestamp()),
      completed_by = null,
      claim_token = null,
      claimed_at = null,
      next_attempt_at = null,
      manual_catch_up_requested_at = null,
      needs_review_reason = null,
      updated_at = clock_timestamp()
  where private.employee_check_in_next_business_day(reminder.due_date) < date '2026-07-01'
    and reminder.delivery_status in ('scheduled', 'claimed', 'delivered', 'needs_review')
  returning reminder.id
)
insert into private.employee_check_in_reminder_events (reminder_id, event_type)
select completed.id, 'completed'
from completed;

-- Reviewer access is independent of job-title text and app roles. Exact MAM
-- account/person IDs are configured after target verification through the
-- Management API; no staff identity is committed in this migration.
create table private.employee_check_in_access_grants (
  id uuid primary key default gen_random_uuid(),
  reviewer_user_id uuid not null references public.profiles (id) on delete restrict,
  scope_kind text not null check (scope_kind in ('global', 'subtree')),
  scope_root_person_id uuid references public.internal_org_people (id) on delete restrict,
  created_at timestamptz not null default clock_timestamp(),
  created_by uuid references auth.users (id) on delete set null,
  revoked_at timestamptz,
  revoked_by uuid references auth.users (id) on delete set null,
  check (
    (scope_kind = 'global' and scope_root_person_id is null)
    or (scope_kind = 'subtree' and scope_root_person_id is not null)
  ),
  check ((revoked_at is null) = (revoked_by is null))
);

comment on table private.employee_check_in_access_grants is
  'Explicit global or reporting-subtree Check-in workspace access. Populate only with verified production UUIDs.';

alter table private.employee_check_in_access_grants enable row level security;
revoke all on table private.employee_check_in_access_grants from public, anon, authenticated;

create unique index employee_check_in_access_grants_active_scope_idx
  on private.employee_check_in_access_grants (
    reviewer_user_id,
    scope_kind,
    coalesce(scope_root_person_id::text, '')
  )
  where revoked_at is null;

create index employee_check_in_access_grants_active_reviewer_idx
  on private.employee_check_in_access_grants (reviewer_user_id)
  where revoked_at is null;

create function private.has_employee_check_in_workspace_access()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.has_current_portal_access()
    and (select auth.uid()) is not null
    and coalesce(((select auth.jwt()) ->> 'is_anonymous')::boolean, false) = false
    and (
      private.is_internal_org_hr()
      or (
        private.is_internal_org_member()
        and exists (
          select 1
          from private.employee_check_in_access_grants access_grant
          where access_grant.reviewer_user_id = (select auth.uid())
            and access_grant.revoked_at is null
            and private.is_active_portal_account(access_grant.reviewer_user_id)
            and (
              access_grant.scope_kind = 'global'
              or exists (
                select 1
                from public.internal_org_people root_person
                where root_person.id = access_grant.scope_root_person_id
                  and root_person.node_kind = 'person'
                  and root_person.is_active
                  and root_person.auth_user_id = access_grant.reviewer_user_id
              )
            )
        )
      )
    );
$$;

create function private.can_view_employee_check_in(p_person_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  with recursive target_ancestors as (
    select target.id, target.parent_id, 0::integer as depth
    from public.internal_org_people target
    where target.id = p_person_id
      and target.node_kind = 'person'
      and target.is_active

    union all

    select parent.id, parent.parent_id, target_ancestors.depth + 1
    from public.internal_org_people parent
    join target_ancestors on target_ancestors.parent_id = parent.id
    where parent.is_active
  )
  select private.has_employee_check_in_workspace_access()
    and exists (select 1 from target_ancestors where depth = 0)
    and (
      private.is_internal_org_hr()
      or exists (
        select 1
        from private.employee_check_in_access_grants access_grant
        where access_grant.reviewer_user_id = (select auth.uid())
          and access_grant.revoked_at is null
          and (
            access_grant.scope_kind = 'global'
            or (
              access_grant.scope_kind = 'subtree'
              and exists (
                select 1
                from public.internal_org_people root_person
                where root_person.id = access_grant.scope_root_person_id
                  and root_person.node_kind = 'person'
                  and root_person.is_active
                  and root_person.auth_user_id = access_grant.reviewer_user_id
              )
              and exists (
                select 1
                from target_ancestors ancestor
                where ancestor.id = access_grant.scope_root_person_id
                  and ancestor.depth > 0
              )
            )
          )
      )
    );
$$;

create function public.can_view_employee_check_in_workspace()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.has_employee_check_in_workspace_access();
$$;

-- This is the only shared Check-in workspace projection. It excludes address,
-- birth date, phone, email, recipient details and delivery-error metadata.
create function public.list_employee_check_in_workspace()
returns table (
  person_id uuid,
  full_name text,
  position_title text,
  company_key text,
  start_date date,
  reminders jsonb
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not private.has_employee_check_in_workspace_access() then
    raise exception 'Check-in workspace access is required.' using errcode = '42501';
  end if;

  return query
  select
    person.id,
    person.full_name,
    person.position_title,
    person.company_key,
    person.started_date,
    coalesce(schedule.reminders, '[]'::jsonb)
  from public.internal_org_people person
  left join lateral (
    select jsonb_agg(
      jsonb_build_object(
        'id', reminder.id,
        'milestone', reminder.milestone,
        'sequence', reminder.reminder_sequence,
        'dueDate', reminder.due_date,
        'notifyDate', reminder.notify_date,
        'status', reminder.delivery_status,
        'deliveredAt', reminder.delivered_at,
        'completedAt', reminder.completed_at
      )
      order by
        reminder.due_date,
        reminder.reminder_sequence
    ) as reminders
    from private.employee_check_in_reminders reminder
    where reminder.person_id = person.id
      and reminder.delivery_status not in ('superseded', 'cancelled')
  ) schedule on true
  where person.node_kind = 'person'
    and person.is_active
    and private.can_view_employee_check_in(person.id)
  order by lower(person.full_name), person.id;
end;
$$;

create or replace function public.complete_employee_check_in_reminder(p_reminder_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_reminder private.employee_check_in_reminders%rowtype;
begin
  if not private.is_internal_org_hr() then
    raise exception 'Only an authorized HR user can complete check-in reminders.'
      using errcode = '42501';
  end if;

  select reminder.*
  into v_reminder
  from private.employee_check_in_reminders reminder
  join public.internal_org_people person on person.id = reminder.person_id
  where reminder.id = p_reminder_id
    and person.node_kind = 'person'
    and person.is_active;

  if not found then
    raise exception 'The check-in reminder does not exist.' using errcode = '23503';
  end if;

  if v_reminder.due_date > (clock_timestamp() at time zone 'Australia/Melbourne')::date then
    raise exception 'A future check-in cannot be marked complete.' using errcode = '22023';
  end if;

  -- Lock the whole milestone in a stable order. This prevents either the
  -- initial or final 5-month row from being completed while the dispatcher is
  -- already delivering its paired reminder.
  perform 1
  from private.employee_check_in_reminders reminder
  where reminder.person_id = v_reminder.person_id
    and reminder.milestone = v_reminder.milestone
    and reminder.due_date = v_reminder.due_date
  order by reminder.id
  for update;

  if exists (
    select 1
    from private.employee_check_in_reminders reminder
    where reminder.person_id = v_reminder.person_id
      and reminder.milestone = v_reminder.milestone
      and reminder.due_date = v_reminder.due_date
      and reminder.delivery_status = 'claimed'
  ) then
    raise exception 'This check-in reminder is currently being delivered. Refresh and try again.'
      using errcode = '55000';
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
    where reminder.person_id = v_reminder.person_id
      and reminder.milestone = v_reminder.milestone
      and reminder.due_date = v_reminder.due_date
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
end;
$$;

create function public.complete_visible_employee_check_in_reminder(p_reminder_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_reminder private.employee_check_in_reminders%rowtype;
begin
  select reminder.*
  into v_reminder
  from private.employee_check_in_reminders reminder
  join public.internal_org_people person on person.id = reminder.person_id
  where reminder.id = p_reminder_id
    and person.node_kind = 'person'
    and person.is_active
  ;

  if not found then
    raise exception 'The check-in reminder does not exist.' using errcode = '23503';
  end if;

  if not private.can_view_employee_check_in(v_reminder.person_id) then
    raise exception 'This check-in is outside your access scope.' using errcode = '42501';
  end if;

  if v_reminder.due_date > (clock_timestamp() at time zone 'Australia/Melbourne')::date then
    raise exception 'A future check-in cannot be marked complete.' using errcode = '22023';
  end if;

  perform 1
  from private.employee_check_in_reminders reminder
  where reminder.person_id = v_reminder.person_id
    and reminder.milestone = v_reminder.milestone
    and reminder.due_date = v_reminder.due_date
  order by reminder.id
  for update;

  if not private.can_view_employee_check_in(v_reminder.person_id) then
    raise exception 'This check-in is outside your access scope.' using errcode = '42501';
  end if;

  if exists (
    select 1
    from private.employee_check_in_reminders reminder
    where reminder.person_id = v_reminder.person_id
      and reminder.milestone = v_reminder.milestone
      and reminder.due_date = v_reminder.due_date
      and reminder.delivery_status = 'claimed'
  ) then
    raise exception 'This check-in reminder is currently being delivered. Refresh and try again.'
      using errcode = '55000';
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
    where reminder.person_id = v_reminder.person_id
      and reminder.milestone = v_reminder.milestone
      and reminder.due_date = v_reminder.due_date
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
end;
$$;

-- Main Calendar uses this minimal projection for every signed-in user. An
-- account without Check-in workspace access receives an empty set rather than
-- an authorization error, so leave and birthday events continue to load.
create function public.list_employee_check_in_calendar_entries()
returns table (
  reminder_id uuid,
  person_id uuid,
  employee_name text,
  milestone text,
  sequence text,
  due_date date,
  status text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not private.has_employee_check_in_workspace_access() then
    return;
  end if;

  return query
  select
    reminder.id,
    person.id,
    person.full_name,
    reminder.milestone,
    reminder.reminder_sequence,
    reminder.due_date,
    reminder.delivery_status
  from private.employee_check_in_reminders reminder
  join public.internal_org_people person on person.id = reminder.person_id
  where person.node_kind = 'person'
    and person.is_active
    and reminder.reminder_sequence = 'initial'
    and reminder.delivery_status not in ('completed', 'superseded', 'cancelled')
    and private.can_view_employee_check_in(person.id)
  order by
    reminder.due_date,
    lower(person.full_name),
    reminder.milestone,
    reminder.reminder_sequence;
end;
$$;

revoke all on function private.employee_check_in_next_business_day(date)
  from public, anon, authenticated;
revoke all on function private.employee_check_in_business_day_on_or_before(date)
  from public, anon, authenticated;
revoke all on function private.employee_check_in_schedule(date)
  from public, anon, authenticated;
revoke all on function private.has_employee_check_in_workspace_access()
  from public, anon, authenticated;
revoke all on function private.can_view_employee_check_in(uuid)
  from public, anon, authenticated;

revoke all on function public.can_view_employee_check_in_workspace()
  from public, anon, authenticated;
revoke all on function public.list_employee_check_in_workspace()
  from public, anon, authenticated;
revoke all on function public.complete_visible_employee_check_in_reminder(uuid)
  from public, anon, authenticated;
revoke all on function public.list_employee_check_in_calendar_entries()
  from public, anon, authenticated;

grant execute on function public.can_view_employee_check_in_workspace()
  to authenticated;
grant execute on function public.list_employee_check_in_workspace()
  to authenticated;
grant execute on function public.complete_visible_employee_check_in_reminder(uuid)
  to authenticated;
grant execute on function public.list_employee_check_in_calendar_entries()
  to authenticated;

-- Address is part of the same HR save as every other Directory field. These
-- wrappers keep the existing, audited Directory functions as the single
-- validation implementation while making the subsequent address update part
-- of the same database transaction.
create function public.create_employee_directory_record_with_address(
  p_first_name text,
  p_last_name text,
  p_work_email text,
  p_personal_email text,
  p_phone text,
  p_position_title text,
  p_team_name text,
  p_manager_id uuid,
  p_country text,
  p_date_of_birth date,
  p_started_date date,
  p_scheduled_employment_end_date date,
  p_company_key text,
  p_is_active boolean,
  p_laptop_supplied text,
  p_laptop_id text,
  p_mouse_id text,
  p_keyboard_id text,
  p_asset_tags text[],
  p_address text,
  p_sort_order integer default 0
)
returns table (
  person_id uuid,
  person_version bigint,
  detail_version bigint
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_person_id uuid;
  v_person_version bigint;
  v_detail_version bigint;
  v_address_detail_version bigint;
begin
  select created.person_id, created.person_version, created.detail_version
  into v_person_id, v_person_version, v_detail_version
  from public.create_employee_directory_record(
    p_first_name,
    p_last_name,
    p_work_email,
    p_personal_email,
    p_phone,
    p_position_title,
    p_team_name,
    p_manager_id,
    p_country,
    p_date_of_birth,
    p_started_date,
    p_scheduled_employment_end_date,
    p_company_key,
    p_is_active,
    p_laptop_supplied,
    p_laptop_id,
    p_mouse_id,
    p_keyboard_id,
    p_asset_tags,
    p_sort_order
  ) created;

  select address_result.detail_version
  into v_address_detail_version
  from public.update_employee_directory_address(
    v_person_id,
    p_address,
    v_detail_version
  ) address_result;

  return query select v_person_id, v_person_version, v_address_detail_version;
end;
$$;

create function public.update_employee_directory_record_with_address(
  p_person_id uuid,
  p_first_name text,
  p_last_name text,
  p_work_email text,
  p_personal_email text,
  p_phone text,
  p_position_title text,
  p_team_name text,
  p_manager_id uuid,
  p_country text,
  p_date_of_birth date,
  p_started_date date,
  p_scheduled_employment_end_date date,
  p_company_key text,
  p_is_active boolean,
  p_expected_person_version bigint,
  p_expected_detail_version bigint,
  p_laptop_supplied text,
  p_laptop_id text,
  p_mouse_id text,
  p_keyboard_id text,
  p_asset_tags text[],
  p_address text,
  p_sort_order integer default null
)
returns table (
  person_id uuid,
  person_version bigint,
  detail_version bigint
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_person_id uuid;
  v_person_version bigint;
  v_detail_version bigint;
  v_address_detail_version bigint;
begin
  select updated.person_id, updated.person_version, updated.detail_version
  into v_person_id, v_person_version, v_detail_version
  from public.update_employee_directory_record(
    p_person_id,
    p_first_name,
    p_last_name,
    p_work_email,
    p_personal_email,
    p_phone,
    p_position_title,
    p_team_name,
    p_manager_id,
    p_country,
    p_date_of_birth,
    p_started_date,
    p_scheduled_employment_end_date,
    p_company_key,
    p_is_active,
    p_expected_person_version,
    p_expected_detail_version,
    p_laptop_supplied,
    p_laptop_id,
    p_mouse_id,
    p_keyboard_id,
    p_asset_tags,
    p_sort_order
  ) updated;

  select address_result.detail_version
  into v_address_detail_version
  from public.update_employee_directory_address(
    v_person_id,
    p_address,
    v_detail_version
  ) address_result;

  -- The base Directory update already touches the safe public row whenever a
  -- public or existing private field changed. If address was the only change,
  -- emit that same privacy-preserving Realtime invalidation now; no address is
  -- copied into the public projection.
  if v_address_detail_version <> v_detail_version
    and v_person_version = p_expected_person_version then
    update public.internal_org_people person
    set updated_by = (select auth.uid())
    where person.id = v_person_id
    returning person.version into v_person_version;
  end if;

  return query select v_person_id, v_person_version, v_address_detail_version;
end;
$$;

revoke all on function public.create_employee_directory_record_with_address(
  text, text, text, text, text, text, text, uuid, text, date, date, date,
  text, boolean, text, text, text, text, text[], text, integer
) from public, anon, authenticated;
revoke all on function public.update_employee_directory_record_with_address(
  uuid, text, text, text, text, text, text, text, uuid, text, date, date, date,
  text, boolean, bigint, bigint, text, text, text, text, text[], text, integer
) from public, anon, authenticated;
grant execute on function public.create_employee_directory_record_with_address(
  text, text, text, text, text, text, text, uuid, text, date, date, date,
  text, boolean, text, text, text, text, text[], text, integer
) to authenticated;
grant execute on function public.update_employee_directory_record_with_address(
  uuid, text, text, text, text, text, text, text, uuid, text, date, date, date,
  text, boolean, bigint, bigint, text, text, text, text, text[], text, integer
) to authenticated;

-- Enrolment and catch-up are no longer browser operations. Automatic roster
-- synchronization is authoritative for every active employee.
revoke all on function public.enrol_employee_check_in_reminders(uuid)
  from authenticated;
revoke all on function public.queue_employee_check_in_catch_up(uuid)
  from authenticated;

commit;
