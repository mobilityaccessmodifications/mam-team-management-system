begin;

do $$
begin
  perform pg_advisory_xact_lock(
    hashtextextended('mam:employee-work-schedule-change-requests:20260904', 0)
  );

  if to_regclass('public.profiles') is null
    or to_regclass('public.internal_org_people') is null
    or to_regclass('private.employee_directory_details') is null
    or to_regclass('private.employee_directory_audit_events') is null
    or to_regprocedure('private.valid_employee_working_weekdays(smallint[])') is null
    or to_regprocedure('private.normalise_employee_working_weekdays(smallint[])') is null
    or to_regprocedure('private.resolve_internal_org_employee_manager(uuid)') is null
    or to_regprocedure('private.is_system_portal_account_admin()') is null
    or to_regprocedure('private.has_current_portal_access()') is null
    or to_regprocedure('private.is_active_portal_account(uuid)') is null then
    raise exception 'Employee work-schedule request prerequisites are missing.'
      using errcode = '55000';
  end if;
end;
$$;

create table private.employee_work_schedule_change_requests (
  id uuid primary key default gen_random_uuid(),
  person_id uuid not null
    references public.internal_org_people (id) on delete restrict,
  submitted_by_user_id uuid not null
    references auth.users (id) on delete restrict,
  original_working_weekdays smallint[]
    check (private.valid_employee_working_weekdays(original_working_weekdays)),
  requested_working_weekdays smallint[] not null
    check (
      private.valid_employee_working_weekdays(requested_working_weekdays)
      and cardinality(requested_working_weekdays) between 1 and 7
    ),
  request_reason text not null
    check (
      request_reason = btrim(request_reason)
      and char_length(request_reason) between 1 and 1000
    ),
  status text not null default 'submitted'
    check (status in ('submitted', 'approved', 'declined', 'cancelled')),
  submitted_at timestamptz not null default clock_timestamp(),
  decided_at timestamptz,
  decided_by_user_id uuid references auth.users (id) on delete restrict,
  reviewer_name text
    check (
      reviewer_name is null
      or (
        reviewer_name = btrim(reviewer_name)
        and char_length(reviewer_name) between 1 and 160
      )
    ),
  decision_reason text
    check (
      decision_reason is null
      or (
        decision_reason = btrim(decision_reason)
        and char_length(decision_reason) between 1 and 1000
      )
    ),
  constraint employee_work_schedule_change_requests_decision_check check (
    (
      status = 'submitted'
      and decided_at is null
      and decided_by_user_id is null
      and reviewer_name is null
      and decision_reason is null
    )
    or (
      status in ('approved', 'declined', 'cancelled')
      and decided_at is not null
      and decided_by_user_id is not null
      and reviewer_name is not null
      and decision_reason is not null
    )
  )
);

comment on table private.employee_work_schedule_change_requests is
  'Private employee work-schedule requests. Employees see only their own safe history; current managers see only pending requests in their live reporting scope.';

alter table private.employee_work_schedule_change_requests enable row level security;
alter table private.employee_work_schedule_change_requests force row level security;
revoke all on table private.employee_work_schedule_change_requests from public, anon, authenticated;

create unique index employee_work_schedule_change_requests_one_submitted_idx
  on private.employee_work_schedule_change_requests (person_id)
  where status = 'submitted';

create index employee_work_schedule_change_requests_person_history_idx
  on private.employee_work_schedule_change_requests (person_id, submitted_at desc, id desc);

create index employee_work_schedule_change_requests_status_submitted_idx
  on private.employee_work_schedule_change_requests (status, submitted_at, id);

create table private.employee_work_schedule_change_events (
  id bigint generated always as identity primary key,
  request_id uuid not null
    references private.employee_work_schedule_change_requests (id) on delete restrict,
  person_id uuid not null
    references public.internal_org_people (id) on delete restrict,
  actor_user_id uuid not null
    references auth.users (id) on delete restrict,
  event_type text not null
    check (event_type in ('submitted', 'approved', 'declined', 'cancelled')),
  from_working_weekdays smallint[]
    check (private.valid_employee_working_weekdays(from_working_weekdays)),
  to_working_weekdays smallint[] not null
    check (
      private.valid_employee_working_weekdays(to_working_weekdays)
      and cardinality(to_working_weekdays) between 1 and 7
    ),
  reason text not null
    check (
      reason = btrim(reason)
      and char_length(reason) between 1 and 1000
    ),
  created_at timestamptz not null default clock_timestamp()
);

comment on table private.employee_work_schedule_change_events is
  'Append-only audit events for work-schedule requests and decisions. Values are exposed only through scoped workspace RPCs.';

alter table private.employee_work_schedule_change_events enable row level security;
alter table private.employee_work_schedule_change_events force row level security;
revoke all on table private.employee_work_schedule_change_events from public, anon, authenticated;

create index employee_work_schedule_change_events_request_created_idx
  on private.employee_work_schedule_change_events (request_id, created_at, id);

create index employee_work_schedule_change_events_person_created_idx
  on private.employee_work_schedule_change_events (person_id, created_at desc, id desc);

create function private.prevent_employee_work_schedule_change_event_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'Work-schedule audit events are append-only.' using errcode = '42501';
end;
$$;

create trigger employee_work_schedule_change_events_append_only
before update or delete on private.employee_work_schedule_change_events
for each row execute function private.prevent_employee_work_schedule_change_event_mutation();

create function private.normalise_employee_work_schedule_reason(
  p_value text,
  p_label text
)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_result text := btrim(coalesce(p_value, ''));
begin
  if char_length(v_result) not between 1 and 1000 then
    raise exception '% must contain between 1 and 1,000 characters.', p_label
      using errcode = '22023';
  end if;

  return v_result;
end;
$$;

create function private.cancel_employee_work_schedule_request_on_archive()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_user_id uuid := coalesce(
    (select auth.uid()),
    case when new.updated_by is distinct from old.updated_by then new.updated_by end
  );
  v_actor_name text;
begin
  if not old.is_active or new.is_active or not exists (
    select 1
    from private.employee_work_schedule_change_requests request
    where request.person_id = new.id
      and request.status = 'submitted'
  ) then
    return new;
  end if;

  if v_actor_user_id is null then
    raise exception 'Close the pending work-schedule request with an authenticated administrator before archiving this employee.'
      using errcode = '42501';
  end if;

  select coalesce(person.full_name, profile.full_name, 'System administrator')
  into v_actor_name
  from public.profiles profile
  left join public.internal_org_people person
    on person.auth_user_id = profile.id
    and person.node_kind = 'person'
  where profile.id = v_actor_user_id;

  v_actor_name := coalesce(v_actor_name, 'System administrator');

  with cancelled_request as (
    update private.employee_work_schedule_change_requests request
    set status = 'cancelled',
        decided_at = clock_timestamp(),
        decided_by_user_id = v_actor_user_id,
        reviewer_name = v_actor_name,
        decision_reason = 'Employee profile archived.'
    where request.person_id = new.id
      and request.status = 'submitted'
    returning
      request.id,
      request.person_id,
      request.original_working_weekdays,
      request.requested_working_weekdays
  )
  insert into private.employee_work_schedule_change_events (
    request_id,
    person_id,
    actor_user_id,
    event_type,
    from_working_weekdays,
    to_working_weekdays,
    reason
  )
  select
    request.id,
    request.person_id,
    v_actor_user_id,
    'cancelled',
    request.original_working_weekdays,
    request.requested_working_weekdays,
    'Employee profile archived.'
  from cancelled_request request;

  return new;
end;
$$;

create trigger internal_org_people_cancel_work_schedule_request_on_archive
after update of is_active on public.internal_org_people
for each row
when (old.is_active and not new.is_active)
execute function private.cancel_employee_work_schedule_request_on_archive();

create function private.employee_work_schedule_workspace_json(
  p_person_id uuid,
  p_is_profile_preview boolean,
  p_review_person_id uuid,
  p_global_reviews boolean
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with active_person as (
    select
      person.id,
      person.full_name,
      detail.working_weekdays
    from public.internal_org_people person
    join private.employee_directory_details detail
      on detail.person_id = person.id
    where person.id = p_person_id
      and person.node_kind = 'person'
      and person.is_active
  ), own_history as (
    select coalesce(
      jsonb_agg(
        jsonb_build_object(
          'id', request.id,
          'original_working_weekdays', request.original_working_weekdays,
          'requested_working_weekdays', request.requested_working_weekdays,
          'request_reason', request.request_reason,
          'submitted_by_name', coalesce(
            (
              select submitter.full_name
              from public.internal_org_people submitter
              where submitter.auth_user_id = request.submitted_by_user_id
                and submitter.node_kind = 'person'
              limit 1
            ),
            (
              select submitter_profile.full_name
              from public.profiles submitter_profile
              where submitter_profile.id = request.submitted_by_user_id
            ),
            'System administrator'
          ),
          'status', request.status,
          'submitted_at', request.submitted_at,
          'decided_at', request.decided_at,
          'reviewer_name', request.reviewer_name,
          'decision_reason', request.decision_reason
        ) order by request.submitted_at desc, request.id desc
      ),
      '[]'::jsonb
    ) as items
    from private.employee_work_schedule_change_requests request
    where request.person_id = p_person_id
  ), scoped_reviews as (
    select coalesce(
      jsonb_agg(
        jsonb_build_object(
          'id', request.id,
          'person_id', request.person_id,
          'employee_name', person.full_name,
          'original_working_weekdays', request.original_working_weekdays,
          'requested_working_weekdays', request.requested_working_weekdays,
          'request_reason', request.request_reason,
          'submitted_by_name', coalesce(
            (
              select submitter.full_name
              from public.internal_org_people submitter
              where submitter.auth_user_id = request.submitted_by_user_id
                and submitter.node_kind = 'person'
              limit 1
            ),
            (
              select submitter_profile.full_name
              from public.profiles submitter_profile
              where submitter_profile.id = request.submitted_by_user_id
            ),
            'System administrator'
          ),
          'status', request.status,
          'submitted_at', request.submitted_at,
          'decided_at', request.decided_at,
          'reviewer_name', request.reviewer_name,
          'decision_reason', request.decision_reason
        ) order by request.submitted_at, request.id
      ),
      '[]'::jsonb
    ) as items
    from private.employee_work_schedule_change_requests request
    join public.internal_org_people person
      on person.id = request.person_id
      and person.node_kind = 'person'
      and person.is_active
    left join lateral private.resolve_internal_org_employee_manager(request.person_id) manager
      on true
    where request.status = 'submitted'
      and request.person_id is distinct from p_review_person_id
      and request.submitted_by_user_id is distinct from (select auth.uid())
      and (
        coalesce(p_global_reviews, false)
        or (
          p_review_person_id is not null
          and manager.manager_id = p_review_person_id
        )
      )
  )
  select jsonb_build_object(
    'active_person_id', (select person.id from active_person person),
    'active_person_name', (select person.full_name from active_person person),
    'working_weekdays', (select person.working_weekdays from active_person person),
    'can_request_change',
      (select person.id from active_person person) is not null
      and not exists (
        select 1
        from private.employee_work_schedule_change_requests request
        where request.person_id = p_person_id
          and request.status = 'submitted'
      ),
    'is_profile_preview', coalesce(p_is_profile_preview, false),
    'history', (select history.items from own_history history),
    'reviews', (select reviews.items from scoped_reviews reviews)
  );
$$;

create function private.submit_employee_work_schedule_change_request(
  p_person_id uuid,
  p_requested_working_weekdays smallint[],
  p_reason text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_user_id uuid := (select auth.uid());
  v_current_working_weekdays smallint[];
  v_requested_working_weekdays smallint[];
  v_reason text;
  v_request_id uuid;
begin
  if not private.has_current_portal_access()
    or v_actor_user_id is null
    or coalesce(((select auth.jwt()) ->> 'is_anonymous')::boolean, false) then
    raise exception 'Sign in with an active account to request a work-schedule change.'
      using errcode = '42501';
  end if;

  v_requested_working_weekdays := private.normalise_employee_working_weekdays(
    p_requested_working_weekdays
  );
  if v_requested_working_weekdays is null then
    raise exception 'Choose at least one work day.' using errcode = '22023';
  end if;
  v_reason := private.normalise_employee_work_schedule_reason(p_reason, 'Reason');

  -- Serialize submissions with controlled reporting-line and employment-status
  -- mutations so an employee cannot be archived between the active check and
  -- the pending-request insert.
  perform pg_advisory_xact_lock(hashtextextended('internal_org_people_hierarchy', 0));

  select detail.working_weekdays
  into v_current_working_weekdays
  from public.internal_org_people person
  join private.employee_directory_details detail on detail.person_id = person.id
  where person.id = p_person_id
    and person.node_kind = 'person'
    and person.is_active
  for share of detail;

  if not found then
    raise exception 'This employee profile is unavailable.' using errcode = '23503';
  end if;

  if v_current_working_weekdays is not distinct from v_requested_working_weekdays then
    raise exception 'Choose a work schedule that is different from the current schedule.'
      using errcode = '22023';
  end if;

  insert into private.employee_work_schedule_change_requests (
    person_id,
    submitted_by_user_id,
    original_working_weekdays,
    requested_working_weekdays,
    request_reason
  )
  values (
    p_person_id,
    v_actor_user_id,
    v_current_working_weekdays,
    v_requested_working_weekdays,
    v_reason
  )
  returning id into v_request_id;

  insert into private.employee_work_schedule_change_events (
    request_id,
    person_id,
    actor_user_id,
    event_type,
    from_working_weekdays,
    to_working_weekdays,
    reason
  )
  values (
    v_request_id,
    p_person_id,
    v_actor_user_id,
    'submitted',
    v_current_working_weekdays,
    v_requested_working_weekdays,
    v_reason
  );

  return v_request_id;
end;
$$;

create function public.get_my_employee_work_schedule_workspace()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_actor_user_id uuid := (select auth.uid());
  v_actor_role text;
  v_person_id uuid;
begin
  if not private.has_current_portal_access()
    or v_actor_user_id is null
    or coalesce(((select auth.jwt()) ->> 'is_anonymous')::boolean, false) then
    raise exception 'Sign in with an active account to view a work schedule.'
      using errcode = '42501';
  end if;

  select profile.app_role
  into v_actor_role
  from public.profiles profile
  where profile.id = v_actor_user_id
    and profile.account_status = 'active'
    and profile.login_name is not null;

  select person.id
  into v_person_id
  from public.internal_org_people person
  where person.auth_user_id = v_actor_user_id
    and person.node_kind = 'person'
    and person.is_active
  limit 1;

  if v_actor_role is distinct from 'system_admin' and v_person_id is null then
    raise exception 'This account is not linked to an active employee profile.'
      using errcode = '42501';
  end if;

  return private.employee_work_schedule_workspace_json(
    v_person_id,
    false,
    case when v_actor_role in ('manager', 'system_admin') then v_person_id else null end,
    v_actor_role = 'system_admin'
  );
end;
$$;

comment on function public.get_my_employee_work_schedule_workspace() is
  'Returns the current employee schedule/history and any live manager review queue authorised for the signed-in account.';

create function public.get_selected_employee_work_schedule_workspace(
  p_person_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_actor_user_id uuid := (select auth.uid());
  v_actor_person_id uuid;
begin
  if not private.is_system_portal_account_admin() then
    raise exception 'Only the active System Admin can preview another work-schedule workspace.'
      using errcode = '42501';
  end if;

  if p_person_id is null or not exists (
    select 1
    from public.internal_org_people person
    join private.employee_directory_details detail on detail.person_id = person.id
    where person.id = p_person_id
      and person.node_kind = 'person'
      and person.is_active
  ) then
    raise exception 'The selected employee profile is unavailable.' using errcode = '23503';
  end if;

  select person.id
  into v_actor_person_id
  from public.internal_org_people person
  where person.auth_user_id = v_actor_user_id
    and person.node_kind = 'person'
    and person.is_active
  limit 1;

  return private.employee_work_schedule_workspace_json(
    p_person_id,
    true,
    v_actor_person_id,
    true
  );
end;
$$;

comment on function public.get_selected_employee_work_schedule_workspace(uuid) is
  'System Admin-only Change profile projection. The selected employee controls the self schedule while real System Admin review authority and audit identity remain active.';

create function public.submit_my_employee_work_schedule_change_request(
  p_requested_working_weekdays smallint[],
  p_reason text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_user_id uuid := (select auth.uid());
  v_person_id uuid;
begin
  if not private.has_current_portal_access()
    or v_actor_user_id is null
    or coalesce(((select auth.jwt()) ->> 'is_anonymous')::boolean, false) then
    raise exception 'Sign in with an active account to request a work-schedule change.'
      using errcode = '42501';
  end if;

  select person.id
  into v_person_id
  from public.internal_org_people person
  where person.auth_user_id = v_actor_user_id
    and person.node_kind = 'person'
    and person.is_active
  limit 1;

  if v_person_id is null then
    raise exception 'This account is not linked to an active employee profile.'
      using errcode = '42501';
  end if;

  return private.submit_employee_work_schedule_change_request(
    v_person_id,
    p_requested_working_weekdays,
    p_reason
  );
end;
$$;

comment on function public.submit_my_employee_work_schedule_change_request(smallint[], text) is
  'Creates one work-schedule request for the active employee linked to the signed-in account. It accepts no target employee id.';

create function public.submit_selected_employee_work_schedule_change_request(
  p_person_id uuid,
  p_requested_working_weekdays smallint[],
  p_reason text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not private.is_system_portal_account_admin() then
    raise exception 'Only the active System Admin can submit from Change profile.'
      using errcode = '42501';
  end if;

  return private.submit_employee_work_schedule_change_request(
    p_person_id,
    p_requested_working_weekdays,
    p_reason
  );
end;
$$;

comment on function public.submit_selected_employee_work_schedule_change_request(uuid, smallint[], text) is
  'Creates a request from the selected Change profile employee while attributing the action to the real System Admin.';

create function public.decide_employee_work_schedule_change_request(
  p_request_id uuid,
  p_decision text,
  p_reason text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_user_id uuid := (select auth.uid());
  v_actor_person_id uuid;
  v_actor_name text;
  v_decision text := lower(btrim(coalesce(p_decision, '')));
  v_reason text;
  v_manager_id uuid;
  v_current_working_weekdays smallint[];
  v_request private.employee_work_schedule_change_requests%rowtype;
begin
  if not private.has_current_portal_access()
    or v_actor_user_id is null
    or coalesce(((select auth.jwt()) ->> 'is_anonymous')::boolean, false) then
    raise exception 'Sign in with an active account to review a work-schedule request.'
      using errcode = '42501';
  end if;

  if v_decision not in ('approved', 'declined') then
    raise exception 'Choose Approve or Decline.' using errcode = '22023';
  end if;
  v_reason := private.normalise_employee_work_schedule_reason(
    p_reason,
    'Decision reason'
  );

  perform pg_advisory_xact_lock(hashtextextended('internal_org_people_hierarchy', 0));

  select request.*
  into v_request
  from private.employee_work_schedule_change_requests request
  where request.id = p_request_id
  for update;

  if not found then
    raise exception 'This work-schedule request is unavailable.' using errcode = '23503';
  end if;
  if v_request.status <> 'submitted' then
    raise exception 'This work-schedule request has already been reviewed.'
      using errcode = '40001';
  end if;

  if v_request.submitted_by_user_id = v_actor_user_id then
    raise exception 'A work-schedule request must be reviewed by a different account.'
      using errcode = '42501';
  end if;

  select
    person.id,
    coalesce(person.full_name, profile.full_name, 'System administrator')
  into v_actor_person_id, v_actor_name
  from public.profiles profile
  left join public.internal_org_people person
    on person.auth_user_id = profile.id
    and person.node_kind = 'person'
    and person.is_active
  where profile.id = v_actor_user_id
    and profile.account_status = 'active'
    and profile.login_name is not null;

  if v_actor_person_id = v_request.person_id then
    raise exception 'You cannot review your own work-schedule request.'
      using errcode = '42501';
  end if;

  select manager.manager_id
  into v_manager_id
  from private.resolve_internal_org_employee_manager(v_request.person_id) manager;

  if not private.is_system_portal_account_admin()
    and (v_actor_person_id is null or v_manager_id is distinct from v_actor_person_id) then
    raise exception 'Only the employee''s current manager can review this request.'
      using errcode = '42501';
  end if;

  if not exists (
    select 1
    from public.internal_org_people person
    where person.id = v_request.person_id
      and person.node_kind = 'person'
      and person.is_active
  ) then
    raise exception 'This employee profile is no longer active.' using errcode = '23503';
  end if;

  if v_decision = 'approved' then
    select detail.working_weekdays
    into v_current_working_weekdays
    from private.employee_directory_details detail
    where detail.person_id = v_request.person_id
    for update;

    if not found then
      raise exception 'This employee work schedule is unavailable.' using errcode = '23503';
    end if;
    if v_current_working_weekdays is distinct from v_request.original_working_weekdays then
      raise exception 'The work schedule changed after this request was sent. Refresh and review it again.'
        using errcode = '40001';
    end if;
    if exists (
      select 1
      from private.employee_directory_audit_events audit
      where audit.person_id = v_request.person_id
        and audit.created_at > v_request.submitted_at
        and audit.changed_fields @> array['working_weekdays']::text[]
    ) then
      raise exception 'The work schedule changed after this request was sent. Refresh and review it again.'
        using errcode = '40001';
    end if;

    update private.employee_directory_details detail
    set working_weekdays = v_request.requested_working_weekdays,
        updated_by = v_actor_user_id
    where detail.person_id = v_request.person_id;

    update public.internal_org_people person
    set updated_by = v_actor_user_id
    where person.id = v_request.person_id;

    insert into private.employee_directory_audit_events (
      person_id,
      actor_user_id,
      event_type,
      changed_fields
    )
    values (
      v_request.person_id,
      v_actor_user_id,
      'updated',
      array['working_weekdays']::text[]
    );
  end if;

  update private.employee_work_schedule_change_requests request
  set status = v_decision,
      decided_at = clock_timestamp(),
      decided_by_user_id = v_actor_user_id,
      reviewer_name = v_actor_name,
      decision_reason = v_reason
  where request.id = v_request.id;

  insert into private.employee_work_schedule_change_events (
    request_id,
    person_id,
    actor_user_id,
    event_type,
    from_working_weekdays,
    to_working_weekdays,
    reason
  )
  values (
    v_request.id,
    v_request.person_id,
    v_actor_user_id,
    v_decision,
    v_request.original_working_weekdays,
    v_request.requested_working_weekdays,
    v_reason
  );
end;
$$;

revoke all on function private.prevent_employee_work_schedule_change_event_mutation()
  from public, anon, authenticated;
revoke all on function private.normalise_employee_work_schedule_reason(text, text)
  from public, anon, authenticated;
revoke all on function private.cancel_employee_work_schedule_request_on_archive()
  from public, anon, authenticated;
revoke all on function private.employee_work_schedule_workspace_json(uuid, boolean, uuid, boolean)
  from public, anon, authenticated;
revoke all on function private.submit_employee_work_schedule_change_request(uuid, smallint[], text)
  from public, anon, authenticated;

revoke all on function public.get_my_employee_work_schedule_workspace()
  from public, anon, authenticated;
revoke all on function public.get_selected_employee_work_schedule_workspace(uuid)
  from public, anon, authenticated;
revoke all on function public.submit_my_employee_work_schedule_change_request(smallint[], text)
  from public, anon, authenticated;
revoke all on function public.submit_selected_employee_work_schedule_change_request(uuid, smallint[], text)
  from public, anon, authenticated;
revoke all on function public.decide_employee_work_schedule_change_request(uuid, text, text)
  from public, anon, authenticated;

grant execute on function public.get_my_employee_work_schedule_workspace()
  to authenticated;
grant execute on function public.get_selected_employee_work_schedule_workspace(uuid)
  to authenticated;
grant execute on function public.submit_my_employee_work_schedule_change_request(smallint[], text)
  to authenticated;
grant execute on function public.submit_selected_employee_work_schedule_change_request(uuid, smallint[], text)
  to authenticated;
grant execute on function public.decide_employee_work_schedule_change_request(uuid, text, text)
  to authenticated;

commit;
