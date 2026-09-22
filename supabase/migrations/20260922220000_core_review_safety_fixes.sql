begin;

-- Core review fixes F02/R01/S02/S03. Generated with Supabase CLI, ordered
-- after the existing 20260922200000 baseline; no historical migration edits.

-- Non-manager requests belong to the nearest eligible reporting-chain manager
-- plus the explicit global reviewers. Manager requests keep their fixed group.
create or replace function private.resolve_leave_approval_grants(p_person_id uuid)
returns table (
  grant_id uuid,
  reviewer_user_id uuid,
  reviewer_label text,
  scope_kind text,
  scope_priority integer,
  scope_depth integer
)
language sql
stable
security definer
set search_path = ''
as $$
  with recursive ancestors as (
    select person.id, person.parent_id, 0::integer as depth
    from public.internal_org_people person
    where person.id = p_person_id
      and person.node_kind = 'person'
      and person.is_active

    union all

    select parent.id, parent.parent_id, ancestors.depth + 1
    from public.internal_org_people parent
    join ancestors on ancestors.parent_id = parent.id
    where parent.is_active
  ), candidates(grant_id, reviewer_user_id, reviewer_label, scope_kind, scope_priority, scope_depth) as (
  select
    approval_grant.id,
    approval_grant.reviewer_user_id,
    approval_grant.reviewer_label,
    approval_grant.scope_kind,
    approval_grant.priority::integer,
    coalesce(
      (
        select min(ancestor.depth)
        from ancestors ancestor
        where ancestor.id = approval_grant.scope_root_person_id
      ),
      2147483647
    )
  from private.leave_approval_grants approval_grant
  where approval_grant.revoked_at is null
    and private.is_active_portal_account(approval_grant.reviewer_user_id)
    and (
      not private.is_manager_leave_person(p_person_id)
      or (approval_grant.scope_kind = 'global' and exists(
        select 1 from private.manager_leave_reviewers configured
        where configured.reviewer_user_id=approval_grant.reviewer_user_id))
    )
    and approval_grant.reviewer_user_id is distinct from
      (select p.auth_user_id from public.internal_org_people p where p.id=p_person_id)
    and (
      approval_grant.scope_kind = 'global'
      or (
        approval_grant.scope_kind = 'subtree'
        and exists (
          select 1
          from public.internal_org_people root_person
          join public.profiles manager_profile
            on manager_profile.id = root_person.auth_user_id
          where root_person.id = approval_grant.scope_root_person_id
            and root_person.node_kind = 'person'
            and root_person.is_active
            and root_person.auth_user_id = approval_grant.reviewer_user_id
            and manager_profile.app_role = 'manager'
            and manager_profile.account_status = 'active'
            and manager_profile.login_name is not null
        )
        and exists (
          select 1
          from ancestors ancestor
          where ancestor.id = approval_grant.scope_root_person_id
        )
      )
    )
  )
  select candidate.*
  from candidates candidate
  where candidate.scope_kind = 'global'
    or candidate.scope_depth = (
      select min(nearest.scope_depth) from candidates nearest where nearest.scope_kind = 'subtree'
    );
$$;

create or replace function private.is_current_leave_request_reviewer(
  p_leave_request_id uuid,
  p_reviewer_user_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_reviewer_user_id is not null
    and private.is_active_portal_account(p_reviewer_user_id)
    and exists (
      select 1 from public.leave_requests request
      where request.id=p_leave_request_id
        and request.user_id is distinct from p_reviewer_user_id
        and (not private.is_manager_leave_person(request.employee_person_id)
          or exists(select 1 from private.manager_leave_reviewers configured
            where configured.reviewer_user_id=p_reviewer_user_id))
    )
    and exists (
      select 1
      from private.leave_request_reviewer_assignments assignment
      left join private.leave_approval_grants approval_grant
        on approval_grant.id = assignment.source_grant_id
      where assignment.leave_request_id = p_leave_request_id
        and assignment.reviewer_user_id = p_reviewer_user_id
        and (
          (
            assignment.assignment_kind = 'legacy'
            and (
              exists (
                select 1
                from public.profiles manager_profile
                where manager_profile.id = p_reviewer_user_id
                  and manager_profile.app_role = 'manager'
                  and manager_profile.account_status = 'active'
              )
              or exists (
                select 1
                from private.leave_approval_grants global_grant
                where global_grant.reviewer_user_id = p_reviewer_user_id
                  and global_grant.scope_kind = 'global'
                  and global_grant.revoked_at is null
              )
            )
          )
          or (
            approval_grant.id is not null
            and approval_grant.revoked_at is null
            and approval_grant.reviewer_user_id = p_reviewer_user_id
            and approval_grant.scope_kind = assignment.assignment_kind
            -- Stale ancestor assignments must not retain decision authority.
            and (approval_grant.scope_kind <> 'subtree' or exists (
              select 1 from public.leave_requests request
              cross join lateral private.resolve_leave_approval_grants(request.employee_person_id) current_grant
              where request.id = p_leave_request_id
                and current_grant.grant_id = approval_grant.id
                and current_grant.reviewer_user_id = p_reviewer_user_id
            ))
            and (
              approval_grant.scope_kind = 'global'
              or exists (
                select 1
                from public.profiles manager_profile
                where manager_profile.id = p_reviewer_user_id
                  and manager_profile.app_role = 'manager'
                  and manager_profile.account_status = 'active'
              )
            )
          )
        )
    );
$$;

-- Bound enumeration before any generate_series call, including the private
-- OpenClaw submit copy. Keep all current authorization/actor/trigger behavior.
create function private.assert_leave_date_range(p_start_date date, p_end_date date)
returns void language plpgsql immutable set search_path = '' as $$
begin
  if p_start_date is null or p_end_date is null
    or not isfinite(p_start_date) or not isfinite(p_end_date)
    or p_start_date < date '0001-01-01' or p_end_date > date '9999-12-31' then
    raise exception 'Choose valid leave dates.' using errcode = '22023';
  end if;
  if p_end_date < p_start_date then
    raise exception 'End date must be on or after start date.' using errcode = '22023';
  end if;
  if p_end_date - p_start_date + 1 > 366 then
    raise exception 'A leave request cannot span more than 366 days.' using errcode = '22023';
  end if;
end;
$$;
revoke all on function private.assert_leave_date_range(date,date) from public,anon,authenticated,service_role;

-- Patch only the reviewed date guard, retaining the effective selected-person
-- delegation patch and private OpenClaw actor handling. Fail closed on drift.
do $migration$
declare
  signature text; original text; definition text;
  anchor constant text := '  if p_start_date is null or p_end_date is null or p_end_date < p_start_date then';
begin
  foreach signature in array array[
    'public.submit_my_leave_request(text,date,date,time,time,text)',
    'public.submit_selected_employee_leave_request(uuid,text,date,date,time,time,text)',
    'private.openclaw_submit_self(uuid,text,date,date,time,time,text)'
  ] loop
    original := pg_get_functiondef(signature::regprocedure);
    if (length(original)-length(replace(original,anchor,'')))/length(anchor) <> 1
      or position(anchor in original) > position('generate_series(p_start_date' in original)
      or position('generate_series(p_start_date' in original) = 0 then
      raise exception 'Leave date validation differs from reviewed baseline: %', signature;
    end if;
    definition := replace(original,anchor,
      '  perform private.assert_leave_date_range(p_start_date, p_end_date);' || chr(10) || anchor);
    execute definition;
  end loop;
end;
$migration$;

-- Recover repaired context within the upcoming check-in's delivery window.
-- Historic cutover and missed/past-due cases still require explicit review.
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
  -- An upcoming check-in can return to scheduled only when every value required
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
  -- allows catch-up through the due date but never revives historic/past-due work.
  with refreshed as (
    update private.employee_check_in_reminders reminder
    set delivery_status = case
          when v_schedule_status = 'needs_review' and reminder.delivery_status = 'scheduled' then 'needs_review'
          when v_schedule_status = 'scheduled'
            and reminder.delivery_status = 'needs_review'
            and reminder.needs_review_reason in (
              'not_enrolled',
              'missing_manager_email',
              'context_changed'
            )
            and reminder.due_date >= v_today then 'scheduled'
          else reminder.delivery_status
        end,
        needs_review_reason = case
          when v_schedule_status = 'needs_review' and reminder.delivery_status = 'scheduled' then v_needs_review_reason
          when v_schedule_status = 'scheduled'
            and reminder.delivery_status = 'needs_review'
            and reminder.needs_review_reason in (
              'not_enrolled',
              'missing_manager_email',
              'context_changed'
            )
            and reminder.due_date >= v_today then null
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
            'context_changed'
          )
          and reminder.due_date >= v_today
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

-- The legacy work-email endpoint must use the same current org scope as the UI.
create or replace function public.get_internal_org_work_email(p_person_id uuid)
returns table (
  person_id uuid,
  work_email text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if p_person_id is null then
    raise exception 'An organisation person is required.' using errcode = '22004';
  end if;

  -- Do not rely on the client tree state for authorisation. This check also
  -- applies when the function is called directly through the Data API.
  if not private.is_internal_org_member() then
    raise exception 'Not authorised.' using errcode = '42501';
  end if;

  return query
  select
    person.id,
    detail.work_email
  from public.internal_org_people person
  left join private.employee_directory_details detail
    on detail.person_id = person.id
  where person.id = p_person_id
    and person.node_kind = 'person'
    and person.is_active
    and public.can_view_internal_org_node(person.id);
end;
$$;
comment on function public.get_internal_org_work_email(uuid) is
  'Returns work email only for active people within the authenticated member''s current organisation scope.';
revoke all on function public.get_internal_org_work_email(uuid) from public,anon,authenticated,service_role;
grant execute on function public.get_internal_org_work_email(uuid) to authenticated;

commit;
