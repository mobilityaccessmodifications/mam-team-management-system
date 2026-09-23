begin;

do $$
begin
  if to_regclass('private.employee_check_in_reminders') is null
    or to_regprocedure('private.can_view_employee_check_in(uuid)') is null
    or to_regprocedure('public.list_employee_check_in_register()') is null
    or to_regprocedure('public.list_employee_check_in_workspace()') is null
    or to_regprocedure('public.list_employee_check_in_workspace_for_preview(uuid)') is null then
    raise exception 'Check-in review outcome prerequisites are missing.' using errcode = '55000';
  end if;
end;
$$;

create table private.employee_check_in_reviews (
  id uuid primary key default gen_random_uuid(),
  reminder_id uuid not null unique
    references private.employee_check_in_reminders (id) on delete restrict,
  outcome_code text not null
    check (outcome_code in ('on_track', 'follow_up_required', 'hr_review_required')),
  review_date date not null,
  notes text not null default ''
    check (notes = btrim(notes) and char_length(notes) <= 2000),
  version bigint not null default 1 check (version > 0),
  recorded_by_user_id uuid not null references auth.users (id) on delete restrict,
  updated_by_user_id uuid not null references auth.users (id) on delete restrict,
  recorded_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp()
);

comment on table private.employee_check_in_reviews is
  'One private structured review outcome per employee Check-in milestone. The canonical reminder is always the initial reminder for the milestone and due date.';

alter table private.employee_check_in_reviews enable row level security;
alter table private.employee_check_in_reviews force row level security;
revoke all on table private.employee_check_in_reviews from public, anon, authenticated, service_role;

create function public.record_employee_check_in_review(
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
  v_canonical_id uuid;
  v_existing private.employee_check_in_reviews%rowtype;
  v_saved private.employee_check_in_reviews%rowtype;
  v_notes text := btrim(coalesce(p_notes, ''));
  v_today date := (clock_timestamp() at time zone 'Australia/Melbourne')::date;
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
    raise exception 'This check-in reminder is currently being delivered. Refresh and try again.' using errcode = '55000';
  end if;

  if exists (
    select 1
    from private.employee_check_in_reminders reminder
    where reminder.person_id = v_selected.person_id
      and reminder.milestone = v_selected.milestone
      and reminder.due_date = v_selected.due_date
      and reminder.delivery_status in ('cancelled', 'superseded')
  ) then
    raise exception 'This check-in is no longer available.' using errcode = '55000';
  end if;

  select reminder.id
    into v_canonical_id
  from private.employee_check_in_reminders reminder
  where reminder.person_id = v_selected.person_id
    and reminder.milestone = v_selected.milestone
    and reminder.due_date = v_selected.due_date
    and reminder.reminder_sequence = 'initial'
  order by reminder.id
  limit 1;

  if v_canonical_id is null then
    raise exception 'The check-in record is incomplete.' using errcode = '55000';
  end if;

  select review.*
    into v_existing
  from private.employee_check_in_reviews review
  where review.reminder_id = v_canonical_id
  for update;

  if found then
    if v_existing.outcome_code = p_outcome_code
      and v_existing.review_date = p_review_date
      and v_existing.notes = v_notes then
      v_saved := v_existing;
    else
      if p_expected_version is null or p_expected_version <> v_existing.version then
        raise exception 'This review outcome changed. Refresh and try again.' using errcode = '40001';
      end if;

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
      v_canonical_id,
      p_outcome_code,
      p_review_date,
      v_notes,
      v_actor,
      v_actor
    )
    returning * into v_saved;
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
  'Records or updates one scoped Check-in review outcome and completes any still-open reminders for the same milestone.';

revoke all on function public.record_employee_check_in_review(uuid, text, date, text, bigint)
  from public, anon, authenticated, service_role;
grant execute on function public.record_employee_check_in_review(uuid, text, date, text, bigint)
  to authenticated;

create or replace function public.list_employee_check_in_register()
returns table (
  person_id uuid,
  company_key text,
  first_name text,
  last_name text,
  role text,
  department text,
  manager_name text,
  address text,
  date_of_birth date,
  mobile text,
  email text,
  start_date date,
  recipient_email text,
  recipient_source text,
  enrolment_mode text,
  reminders jsonb
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not private.is_internal_org_hr() then
    raise exception 'Only an authorized HR user can access the employee check-in register.' using errcode = '42501';
  end if;

  return query
  select
    person.id,
    person.company_key,
    detail.first_name,
    detail.last_name,
    person.position_title,
    detail.team_name,
    manager.manager_name,
    detail.address,
    detail.date_of_birth,
    detail.phone,
    detail.work_email,
    person.started_date,
    manager_detail.work_email,
    case when manager_detail.work_email is not null then 'manager_work_email' else 'missing' end,
    coalesce(enrolment.delivery_mode, 'needs_review'),
    coalesce(schedule.reminders, '[]'::jsonb)
  from public.internal_org_people person
  left join private.employee_directory_details detail on detail.person_id = person.id
  left join lateral private.resolve_internal_org_employee_manager(person.id) manager on true
  left join private.employee_directory_details manager_detail on manager_detail.person_id = manager.manager_id
  left join private.employee_check_in_enrolments enrolment on enrolment.person_id = person.id
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
        'completedAt', reminder.completed_at,
        'lastDeliveryErrorAt', reminder.last_delivery_error_at,
        'needsReviewReason', reminder.needs_review_reason,
        'reviewOutcome', review.outcome_code,
        'reviewDate', review.review_date,
        'reviewNotes', review.notes,
        'reviewVersion', review.version,
        'reviewRecordedAt', review.recorded_at
      )
      order by reminder.due_date, reminder.notify_date, reminder.reminder_sequence
    ) as reminders
    from private.employee_check_in_reminders reminder
    left join private.employee_check_in_reminders canonical
      on canonical.person_id = reminder.person_id
      and canonical.milestone = reminder.milestone
      and canonical.due_date = reminder.due_date
      and canonical.reminder_sequence = 'initial'
    left join private.employee_check_in_reviews review on review.reminder_id = canonical.id
    where reminder.person_id = person.id
      and reminder.delivery_status not in ('superseded', 'cancelled')
  ) schedule on true
  where person.node_kind = 'person'
    and person.is_active
  order by person.company_key, lower(person.full_name), person.id;
end;
$$;

create or replace function public.list_employee_check_in_workspace()
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
        'completedAt', reminder.completed_at,
        'needsReviewReason', reminder.needs_review_reason,
        'reviewOutcome', review.outcome_code,
        'reviewDate', review.review_date,
        'reviewNotes', review.notes,
        'reviewVersion', review.version,
        'reviewRecordedAt', review.recorded_at
      )
      order by reminder.due_date, reminder.reminder_sequence
    ) as reminders
    from private.employee_check_in_reminders reminder
    left join private.employee_check_in_reminders canonical
      on canonical.person_id = reminder.person_id
      and canonical.milestone = reminder.milestone
      and canonical.due_date = reminder.due_date
      and canonical.reminder_sequence = 'initial'
    left join private.employee_check_in_reviews review on review.reminder_id = canonical.id
    where reminder.person_id = person.id
      and reminder.delivery_status not in ('superseded', 'cancelled')
  ) schedule on true
  where person.node_kind = 'person'
    and person.is_active
    and private.can_view_employee_check_in(person.id)
  order by lower(person.full_name), person.id;
end;
$$;

create or replace function public.list_employee_check_in_workspace_for_preview(p_person_id uuid)
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
declare
  v_target_auth_user_id uuid;
  v_target_can_access boolean := false;
  v_target_is_global boolean := false;
begin
  if not private.is_system_portal_account_admin() then
    raise exception 'Only a Super Admin may preview check-in scope.' using errcode = '42501';
  end if;

  select person.auth_user_id into v_target_auth_user_id
  from public.internal_org_people person
  where person.id = p_person_id
    and person.node_kind = 'person'
    and person.is_active;

  if not found then
    raise exception 'The selected employee is unavailable.' using errcode = '23503';
  end if;

  select exists (
    select 1
    from public.profiles profile
    join public.internal_org_people target
      on target.auth_user_id = profile.id
    where profile.id = v_target_auth_user_id
      and profile.app_role in ('manager', 'system_admin')
      and profile.account_status = 'active'
      and profile.login_name is not null
      and target.id = p_person_id
      and target.node_kind = 'person'
      and target.is_active
      and private.is_active_linked_internal_employee(profile.id)
  ) into v_target_can_access;

  select exists (
    select 1
    from public.profiles profile
    where profile.id = v_target_auth_user_id
      and profile.app_role = 'system_admin'
      and profile.account_status = 'active'
      and profile.login_name is not null
  ) into v_target_is_global;

  return query
  with recursive descendants as (
    select person.id, person.parent_id, 0::integer as depth
    from public.internal_org_people person
    where person.id = p_person_id
      and person.node_kind = 'person'
      and person.is_active
    union all
    select child.id, child.parent_id, descendants.depth + 1
    from public.internal_org_people child
    join descendants on child.parent_id = descendants.id
    where child.is_active
  )
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
        'completedAt', reminder.completed_at,
        'needsReviewReason', reminder.needs_review_reason,
        'reviewOutcome', review.outcome_code,
        'reviewDate', review.review_date,
        'reviewNotes', review.notes,
        'reviewVersion', review.version,
        'reviewRecordedAt', review.recorded_at
      )
      order by reminder.due_date, reminder.reminder_sequence
    ) as reminders
    from private.employee_check_in_reminders reminder
    left join private.employee_check_in_reminders canonical
      on canonical.person_id = reminder.person_id
      and canonical.milestone = reminder.milestone
      and canonical.due_date = reminder.due_date
      and canonical.reminder_sequence = 'initial'
    left join private.employee_check_in_reviews review on review.reminder_id = canonical.id
    where reminder.person_id = person.id
      and reminder.delivery_status not in ('superseded', 'cancelled')
  ) schedule on true
  where v_target_can_access
    and person.node_kind = 'person'
    and person.is_active
    and (
      v_target_is_global
      or exists (
        select 1 from descendants
        where descendants.id = person.id and descendants.depth > 0
      )
    )
  order by lower(person.full_name), person.id;
end;
$$;

comment on function public.list_employee_check_in_workspace_for_preview(uuid) is
  'Super Admin-only Change Profile projection: selected manager gets their active subtree, selected System Admin gets global scope, other roles get no Check-in records, including private review outcomes.';

commit;
