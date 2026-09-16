begin;

do $$
begin
  perform pg_advisory_xact_lock(
    hashtextextended('mam:optional-work-schedule-times:20260916', 0)
  );

  if to_regclass('private.employee_directory_details') is null
    or to_regclass('private.employee_work_schedule_change_requests') is null
    or to_regclass('private.employee_work_schedule_change_events') is null
    or to_regprocedure('private.normalise_employee_working_weekdays(smallint[])') is null
    or to_regprocedure('private.employee_work_schedule_workspace_json(uuid,boolean,uuid,boolean)') is null
    or to_regprocedure('private.submit_employee_work_schedule_change_request(uuid,smallint[],text)') is null
    or to_regprocedure('public.decide_employee_work_schedule_change_request(uuid,text,text)') is null
    or to_regprocedure('public.list_employee_directory_records_with_work_schedule(boolean)') is null
    or to_regprocedure('public.get_employee_directory_record_with_work_schedule(uuid)') is null then
    raise exception 'Optional work-schedule time prerequisites are missing.'
      using errcode = '55000';
  end if;
end;
$$;

create function private.valid_employee_working_day_times(
  p_working_weekdays smallint[],
  p_value jsonb
)
returns boolean
language plpgsql
immutable
parallel safe
set search_path = ''
as $$
declare
  v_item jsonb;
  v_weekday smallint;
  v_start_time text;
  v_end_time text;
  v_seen smallint[] := '{}'::smallint[];
begin
  if p_value is null
    or jsonb_typeof(p_value) <> 'array'
    or jsonb_array_length(p_value) > 7 then
    return false;
  end if;

  for v_item in select item.value from jsonb_array_elements(p_value) item(value)
  loop
    if jsonb_typeof(v_item) <> 'object'
      or not (v_item ?& array['weekday', 'start_time', 'end_time'])
      or exists (
        select 1
        from jsonb_object_keys(v_item) as item_key(key)
        where item_key.key not in ('weekday', 'start_time', 'end_time')
      )
      or coalesce(v_item ->> 'weekday', '') !~ '^[1-7]$' then
      return false;
    end if;

    v_weekday := (v_item ->> 'weekday')::smallint;
    v_start_time := v_item ->> 'start_time';
    v_end_time := v_item ->> 'end_time';

    if p_working_weekdays is null
      or not (v_weekday = any(p_working_weekdays))
      or v_weekday = any(v_seen)
      or coalesce(v_start_time, '') !~ '^([01][0-9]|2[0-3]):(00|15|30|45)$'
      or coalesce(v_end_time, '') !~ '^([01][0-9]|2[0-3]):(00|15|30|45)$'
      or v_end_time::time <= v_start_time::time then
      return false;
    end if;

    v_seen := array_append(v_seen, v_weekday);
  end loop;

  return true;
exception
  when others then return false;
end;
$$;

create function private.normalise_employee_working_day_times(
  p_working_weekdays smallint[],
  p_value jsonb
)
returns jsonb
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_value jsonb := coalesce(p_value, '[]'::jsonb);
  v_result jsonb;
begin
  if not private.valid_employee_working_day_times(p_working_weekdays, v_value) then
    raise exception 'Choose valid start and finish times in 15-minute intervals.'
      using errcode = '22023';
  end if;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'weekday', (item.value ->> 'weekday')::smallint,
        'start_time', item.value ->> 'start_time',
        'end_time', item.value ->> 'end_time'
      ) order by (item.value ->> 'weekday')::smallint
    ),
    '[]'::jsonb
  )
  into v_result
  from jsonb_array_elements(v_value) item(value);

  return v_result;
end;
$$;

create function private.retain_employee_working_day_times(
  p_working_weekdays smallint[],
  p_value jsonb
)
returns jsonb
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_filtered jsonb;
begin
  if p_working_weekdays is null then
    return '[]'::jsonb;
  end if;

  select coalesce(jsonb_agg(item.value), '[]'::jsonb)
  into v_filtered
  from jsonb_array_elements(coalesce(p_value, '[]'::jsonb)) item(value)
  where coalesce(item.value ->> 'weekday', '') ~ '^[1-7]$'
    and (item.value ->> 'weekday')::smallint = any(p_working_weekdays);

  return private.normalise_employee_working_day_times(
    p_working_weekdays,
    v_filtered
  );
end;
$$;

alter table private.employee_directory_details
  add column working_day_times jsonb not null default '[]'::jsonb,
  add column working_schedule_initial_setup_completed boolean not null default false;

update private.employee_directory_details
set working_schedule_initial_setup_completed = true
where working_weekdays is not null;

alter table private.employee_directory_details
  add constraint employee_directory_details_working_day_times_check
  check (
    private.valid_employee_working_day_times(
      working_weekdays,
      working_day_times
    )
  );

comment on column private.employee_directory_details.working_day_times is
  'Optional same-day start and finish times for selected usual work days. Canonical JSON uses weekday, start_time and end_time in 15-minute HH:MM intervals; an empty array means exact hours are not recorded.';

comment on column private.employee_directory_details.working_schedule_initial_setup_completed is
  'Monotonic marker preventing the employee-only first schedule shortcut from becoming available again after a recorded schedule is cleared.';

create function private.sync_employee_working_day_times()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    new.working_schedule_initial_setup_completed :=
      coalesce(new.working_schedule_initial_setup_completed, false)
      or new.working_weekdays is not null;
  else
    new.working_schedule_initial_setup_completed :=
      coalesce(old.working_schedule_initial_setup_completed, false)
      or coalesce(new.working_schedule_initial_setup_completed, false)
      or new.working_weekdays is not null;
  end if;

  new.working_day_times := private.retain_employee_working_day_times(
    new.working_weekdays,
    new.working_day_times
  );
  return new;
end;
$$;

create trigger employee_directory_details_sync_working_day_times
before insert or update of working_weekdays, working_schedule_initial_setup_completed
on private.employee_directory_details
for each row execute function private.sync_employee_working_day_times();

alter table private.employee_directory_audit_events
  drop constraint employee_directory_audit_events_changed_fields_check;

alter table private.employee_directory_audit_events
  add constraint employee_directory_audit_events_changed_fields_check
  check (
    changed_fields <@ array[
      'first_name', 'last_name', 'work_email', 'personal_email', 'phone',
      'position_title', 'team_name', 'manager_id', 'country', 'address',
      'date_of_birth', 'started_date', 'scheduled_employment_end_date',
      'company_key', 'is_active', 'sort_order', 'laptop_supplied',
      'laptop_id', 'mouse_id', 'keyboard_id', 'asset_tags',
      'employment_type', 'working_weekdays', 'working_day_times'
    ]::text[]
  );

alter table private.employee_work_schedule_change_requests
  add column original_working_day_times jsonb not null default '[]'::jsonb,
  add column requested_working_day_times jsonb not null default '[]'::jsonb;

alter table private.employee_work_schedule_change_requests
  add constraint employee_work_schedule_change_requests_original_times_check
    check (
      private.valid_employee_working_day_times(
        original_working_weekdays,
        original_working_day_times
      )
    ),
  add constraint employee_work_schedule_change_requests_requested_times_check
    check (
      private.valid_employee_working_day_times(
        requested_working_weekdays,
        requested_working_day_times
      )
    );

alter table private.employee_work_schedule_change_events
  add column from_working_day_times jsonb not null default '[]'::jsonb,
  add column to_working_day_times jsonb not null default '[]'::jsonb;

alter table private.employee_work_schedule_change_events
  add constraint employee_work_schedule_change_events_from_times_check
    check (
      private.valid_employee_working_day_times(
        from_working_weekdays,
        from_working_day_times
      )
    ),
  add constraint employee_work_schedule_change_events_to_times_check
    check (
      private.valid_employee_working_day_times(
        to_working_weekdays,
        to_working_day_times
      )
    );

create or replace function private.cancel_employee_work_schedule_request_on_archive()
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
    returning request.*
  )
  insert into private.employee_work_schedule_change_events (
    request_id,
    person_id,
    actor_user_id,
    event_type,
    from_working_weekdays,
    from_working_day_times,
    to_working_weekdays,
    to_working_day_times,
    reason
  )
  select
    request.id,
    request.person_id,
    v_actor_user_id,
    'cancelled',
    request.original_working_weekdays,
    request.original_working_day_times,
    request.requested_working_weekdays,
    request.requested_working_day_times,
    'Employee profile archived.'
  from cancelled_request request;

  return new;
end;
$$;

create or replace function private.employee_work_schedule_workspace_json(
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
      detail.working_weekdays,
      detail.working_day_times,
      detail.working_schedule_initial_setup_completed
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
          'original_working_day_times', request.original_working_day_times,
          'requested_working_weekdays', request.requested_working_weekdays,
          'requested_working_day_times', request.requested_working_day_times,
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
          'original_working_day_times', request.original_working_day_times,
          'requested_working_weekdays', request.requested_working_weekdays,
          'requested_working_day_times', request.requested_working_day_times,
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
    'working_day_times', coalesce(
      (select person.working_day_times from active_person person),
      '[]'::jsonb
    ),
    'initial_setup_available',
      not coalesce(p_is_profile_preview, false)
      and (select person.id from active_person person) is not null
      and (select person.working_weekdays from active_person person) is null
      and not coalesce(
        (select person.working_schedule_initial_setup_completed from active_person person),
        false
      )
      and not exists (
        select 1
        from private.employee_work_schedule_change_requests request
        where request.person_id = p_person_id
          and request.status = 'submitted'
      ),
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

create function private.submit_employee_work_schedule_change_v2(
  p_person_id uuid,
  p_requested_working_weekdays smallint[],
  p_requested_working_day_times jsonb,
  p_reason text,
  p_allow_initial_setup boolean,
  p_preserve_unspecified_times boolean
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_user_id uuid := (select auth.uid());
  v_current_working_weekdays smallint[];
  v_current_working_day_times jsonb;
  v_initial_setup_completed boolean;
  v_requested_working_weekdays smallint[];
  v_requested_working_day_times jsonb;
  v_reason text;
  v_request_id uuid;
  v_is_self boolean;
begin
  if not private.has_current_portal_access()
    or v_actor_user_id is null
    or coalesce(((select auth.jwt()) ->> 'is_anonymous')::boolean, false) then
    raise exception 'Sign in with an active account to update a work schedule.'
      using errcode = '42501';
  end if;

  v_requested_working_weekdays := private.normalise_employee_working_weekdays(
    p_requested_working_weekdays
  );
  if v_requested_working_weekdays is null then
    raise exception 'Choose at least one work day.' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('internal_org_people_hierarchy', 0));

  select
    detail.working_weekdays,
    detail.working_day_times,
    detail.working_schedule_initial_setup_completed,
    person.auth_user_id = v_actor_user_id
  into
    v_current_working_weekdays,
    v_current_working_day_times,
    v_initial_setup_completed,
    v_is_self
  from public.internal_org_people person
  join private.employee_directory_details detail on detail.person_id = person.id
  where person.id = p_person_id
    and person.node_kind = 'person'
    and person.is_active
  for update of detail;

  if not found then
    raise exception 'This employee profile is unavailable.' using errcode = '23503';
  end if;

  if coalesce(p_preserve_unspecified_times, false) then
    v_requested_working_day_times := private.retain_employee_working_day_times(
      v_requested_working_weekdays,
      v_current_working_day_times
    );
  else
    v_requested_working_day_times := private.normalise_employee_working_day_times(
      v_requested_working_weekdays,
      p_requested_working_day_times
    );
  end if;

  if exists (
    select 1
    from private.employee_work_schedule_change_requests request
    where request.person_id = p_person_id
      and request.status = 'submitted'
  ) then
    raise exception 'There is already a work schedule request waiting for review.'
      using errcode = '23505';
  end if;

  if coalesce(p_allow_initial_setup, false)
    and coalesce(v_is_self, false)
    and v_current_working_weekdays is null
    and not coalesce(v_initial_setup_completed, false) then
    update private.employee_directory_details detail
    set working_weekdays = v_requested_working_weekdays,
        working_day_times = v_requested_working_day_times,
        updated_by = v_actor_user_id
    where detail.person_id = p_person_id;

    update public.internal_org_people person
    set updated_by = v_actor_user_id
    where person.id = p_person_id;

    insert into private.employee_directory_audit_events (
      person_id,
      actor_user_id,
      event_type,
      changed_fields
    )
    values (
      p_person_id,
      v_actor_user_id,
      'updated',
      array['working_weekdays', 'working_day_times']::text[]
    );

    return jsonb_build_object('outcome', 'applied', 'request_id', null);
  end if;

  v_reason := private.normalise_employee_work_schedule_reason(p_reason, 'Reason');

  if v_current_working_weekdays is not distinct from v_requested_working_weekdays
    and v_current_working_day_times is not distinct from v_requested_working_day_times then
    raise exception 'Choose a work schedule that is different from the current schedule.'
      using errcode = '22023';
  end if;

  insert into private.employee_work_schedule_change_requests (
    person_id,
    submitted_by_user_id,
    original_working_weekdays,
    original_working_day_times,
    requested_working_weekdays,
    requested_working_day_times,
    request_reason
  )
  values (
    p_person_id,
    v_actor_user_id,
    v_current_working_weekdays,
    v_current_working_day_times,
    v_requested_working_weekdays,
    v_requested_working_day_times,
    v_reason
  )
  returning id into v_request_id;

  insert into private.employee_work_schedule_change_events (
    request_id,
    person_id,
    actor_user_id,
    event_type,
    from_working_weekdays,
    from_working_day_times,
    to_working_weekdays,
    to_working_day_times,
    reason
  )
  values (
    v_request_id,
    p_person_id,
    v_actor_user_id,
    'submitted',
    v_current_working_weekdays,
    v_current_working_day_times,
    v_requested_working_weekdays,
    v_requested_working_day_times,
    v_reason
  );

  return jsonb_build_object('outcome', 'submitted', 'request_id', v_request_id);
end;
$$;

create or replace function private.submit_employee_work_schedule_change_request(
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
  v_result jsonb;
begin
  v_result := private.submit_employee_work_schedule_change_v2(
    p_person_id,
    p_requested_working_weekdays,
    null,
    p_reason,
    false,
    true
  );
  return (v_result ->> 'request_id')::uuid;
end;
$$;

create function public.submit_my_employee_work_schedule_change_v2(
  p_requested_working_weekdays smallint[],
  p_requested_working_day_times jsonb,
  p_reason text
)
returns jsonb
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
    raise exception 'Sign in with an active account to update a work schedule.'
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

  return private.submit_employee_work_schedule_change_v2(
    v_person_id,
    p_requested_working_weekdays,
    p_requested_working_day_times,
    p_reason,
    true,
    false
  );
end;
$$;

comment on function public.submit_my_employee_work_schedule_change_v2(smallint[], jsonb, text) is
  'Saves an active employee own first recorded schedule immediately; later day or time changes become manager-reviewed requests.';

create function public.submit_selected_employee_work_schedule_change_v2(
  p_person_id uuid,
  p_requested_working_weekdays smallint[],
  p_requested_working_day_times jsonb,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not private.is_system_portal_account_admin() then
    raise exception 'Only the active System Admin can submit from Change profile.'
      using errcode = '42501';
  end if;

  return private.submit_employee_work_schedule_change_v2(
    p_person_id,
    p_requested_working_weekdays,
    p_requested_working_day_times,
    p_reason,
    false,
    false
  );
end;
$$;

comment on function public.submit_selected_employee_work_schedule_change_v2(uuid, smallint[], jsonb, text) is
  'Creates a day-and-time schedule request from Change profile while preserving the real System Admin audit identity and approval boundary.';

create or replace function public.decide_employee_work_schedule_change_request(
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
  v_current_working_day_times jsonb;
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
    select detail.working_weekdays, detail.working_day_times
    into v_current_working_weekdays, v_current_working_day_times
    from private.employee_directory_details detail
    where detail.person_id = v_request.person_id
    for update;

    if not found then
      raise exception 'This employee work schedule is unavailable.' using errcode = '23503';
    end if;
    if v_current_working_weekdays is distinct from v_request.original_working_weekdays
      or v_current_working_day_times is distinct from v_request.original_working_day_times then
      raise exception 'The work schedule changed after this request was sent. Refresh and review it again.'
        using errcode = '40001';
    end if;
    if exists (
      select 1
      from private.employee_directory_audit_events audit
      where audit.person_id = v_request.person_id
        and audit.created_at > v_request.submitted_at
        and audit.changed_fields && array['working_weekdays', 'working_day_times']::text[]
    ) then
      raise exception 'The work schedule changed after this request was sent. Refresh and review it again.'
        using errcode = '40001';
    end if;

    update private.employee_directory_details detail
    set working_weekdays = v_request.requested_working_weekdays,
        working_day_times = v_request.requested_working_day_times,
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
      array['working_weekdays', 'working_day_times']::text[]
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
    from_working_day_times,
    to_working_weekdays,
    to_working_day_times,
    reason
  )
  values (
    v_request.id,
    v_request.person_id,
    v_actor_user_id,
    v_decision,
    v_request.original_working_weekdays,
    v_request.original_working_day_times,
    v_request.requested_working_weekdays,
    v_request.requested_working_day_times,
    v_reason
  );
end;
$$;

create function public.list_employee_directory_records_with_work_schedule_times(
  p_include_archived boolean default false
)
returns table (
  person_id uuid,
  person_version bigint,
  detail_version bigint,
  company_key text,
  is_active boolean,
  first_name text,
  last_name text,
  full_name text,
  position_title text,
  team_name text,
  manager_id uuid,
  manager_name text,
  work_email text,
  personal_email text,
  phone text,
  country text,
  address text,
  date_of_birth date,
  started_date date,
  scheduled_employment_end_date date,
  archive_reason text,
  employment_type text,
  has_paid_leave_entitlement boolean,
  laptop_supplied text,
  laptop_id text,
  mouse_id text,
  keyboard_id text,
  asset_tags text[],
  working_weekdays smallint[],
  working_day_times jsonb
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    record.person_id,
    record.person_version,
    record.detail_version,
    record.company_key,
    record.is_active,
    record.first_name,
    record.last_name,
    record.full_name,
    record.position_title,
    record.team_name,
    record.manager_id,
    record.manager_name,
    record.work_email,
    record.personal_email,
    record.phone,
    record.country,
    record.address,
    record.date_of_birth,
    record.started_date,
    record.scheduled_employment_end_date,
    record.archive_reason,
    record.employment_type,
    record.has_paid_leave_entitlement,
    record.laptop_supplied,
    record.laptop_id,
    record.mouse_id,
    record.keyboard_id,
    record.asset_tags,
    record.working_weekdays,
    detail.working_day_times
  from public.list_employee_directory_records_with_work_schedule(
    p_include_archived
  ) record
  join private.employee_directory_details detail
    on detail.person_id = record.person_id;
$$;

create function public.get_employee_directory_record_with_work_schedule_times(
  p_person_id uuid
)
returns table (
  person_id uuid,
  person_version bigint,
  detail_version bigint,
  company_key text,
  is_active boolean,
  first_name text,
  last_name text,
  full_name text,
  position_title text,
  team_name text,
  manager_id uuid,
  manager_name text,
  work_email text,
  personal_email text,
  phone text,
  country text,
  address text,
  date_of_birth date,
  started_date date,
  scheduled_employment_end_date date,
  archive_reason text,
  employment_type text,
  has_paid_leave_entitlement boolean,
  laptop_supplied text,
  laptop_id text,
  mouse_id text,
  keyboard_id text,
  asset_tags text[],
  working_weekdays smallint[],
  working_day_times jsonb
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    record.person_id,
    record.person_version,
    record.detail_version,
    record.company_key,
    record.is_active,
    record.first_name,
    record.last_name,
    record.full_name,
    record.position_title,
    record.team_name,
    record.manager_id,
    record.manager_name,
    record.work_email,
    record.personal_email,
    record.phone,
    record.country,
    record.address,
    record.date_of_birth,
    record.started_date,
    record.scheduled_employment_end_date,
    record.archive_reason,
    record.employment_type,
    record.has_paid_leave_entitlement,
    record.laptop_supplied,
    record.laptop_id,
    record.mouse_id,
    record.keyboard_id,
    record.asset_tags,
    record.working_weekdays,
    detail.working_day_times
  from public.get_employee_directory_record_with_work_schedule(
    p_person_id
  ) record
  join private.employee_directory_details detail
    on detail.person_id = record.person_id;
$$;

create function public.create_employee_directory_record_with_work_schedule_times(
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
  p_employment_type text,
  p_working_weekdays smallint[],
  p_working_day_times jsonb,
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
  v_actor uuid := (select auth.uid());
  v_times jsonb := private.normalise_employee_working_day_times(
    private.normalise_employee_working_weekdays(p_working_weekdays),
    p_working_day_times
  );
  v_current_times jsonb;
  v_person_id uuid;
  v_person_version bigint;
  v_detail_version bigint;
begin
  select created.person_id, created.person_version, created.detail_version
  into v_person_id, v_person_version, v_detail_version
  from public.create_employee_directory_record_with_work_schedule(
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
    p_address,
    p_employment_type,
    p_working_weekdays,
    p_sort_order
  ) created;

  select detail.working_day_times
  into v_current_times
  from private.employee_directory_details detail
  where detail.person_id = v_person_id
    and detail.version = v_detail_version
  for update;

  if not found then
    raise exception 'This employee detail changed while it was being created. Refresh and try again.'
      using errcode = '40001';
  end if;

  if v_current_times is distinct from v_times then
    update private.employee_directory_details detail
    set working_day_times = v_times,
        updated_by = v_actor
    where detail.person_id = v_person_id
      and detail.version = v_detail_version
    returning detail.version into v_detail_version;

    update public.internal_org_people person
    set updated_by = v_actor
    where person.id = v_person_id
    returning person.version into v_person_version;

    insert into private.employee_directory_audit_events (
      person_id,
      actor_user_id,
      event_type,
      changed_fields
    ) values (
      v_person_id,
      v_actor,
      'updated',
      array['working_day_times']::text[]
    );
  end if;

  return query select v_person_id, v_person_version, v_detail_version;
end;
$$;

create function public.update_employee_directory_record_with_work_schedule_times(
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
  p_employment_type text,
  p_working_weekdays smallint[],
  p_working_day_times jsonb,
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
  v_actor uuid := (select auth.uid());
  v_times jsonb := private.normalise_employee_working_day_times(
    private.normalise_employee_working_weekdays(p_working_weekdays),
    p_working_day_times
  );
  v_current_times jsonb;
  v_person_id uuid;
  v_person_version bigint;
  v_detail_version bigint;
begin
  select updated.person_id, updated.person_version, updated.detail_version
  into v_person_id, v_person_version, v_detail_version
  from public.update_employee_directory_record_with_work_schedule(
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
    p_address,
    p_employment_type,
    p_working_weekdays,
    p_sort_order
  ) updated;

  select detail.working_day_times
  into v_current_times
  from private.employee_directory_details detail
  where detail.person_id = v_person_id
    and detail.version = v_detail_version
  for update;

  if not found then
    raise exception 'This employee detail changed while it was being saved. Refresh and try again.'
      using errcode = '40001';
  end if;

  if v_current_times is distinct from v_times then
    update private.employee_directory_details detail
    set working_day_times = v_times,
        updated_by = v_actor
    where detail.person_id = v_person_id
      and detail.version = v_detail_version
    returning detail.version into v_detail_version;

    update public.internal_org_people person
    set updated_by = v_actor
    where person.id = v_person_id
    returning person.version into v_person_version;

    insert into private.employee_directory_audit_events (
      person_id,
      actor_user_id,
      event_type,
      changed_fields
    ) values (
      v_person_id,
      v_actor,
      'updated',
      array['working_day_times']::text[]
    );
  end if;

  return query select v_person_id, v_person_version, v_detail_version;
end;
$$;

revoke all on function private.valid_employee_working_day_times(smallint[], jsonb)
  from public, anon, authenticated;
revoke all on function private.normalise_employee_working_day_times(smallint[], jsonb)
  from public, anon, authenticated;
revoke all on function private.retain_employee_working_day_times(smallint[], jsonb)
  from public, anon, authenticated;
revoke all on function private.sync_employee_working_day_times()
  from public, anon, authenticated;
revoke all on function private.submit_employee_work_schedule_change_v2(uuid, smallint[], jsonb, text, boolean, boolean)
  from public, anon, authenticated;

revoke all on function public.submit_my_employee_work_schedule_change_v2(smallint[], jsonb, text)
  from public, anon, authenticated;
revoke all on function public.submit_selected_employee_work_schedule_change_v2(uuid, smallint[], jsonb, text)
  from public, anon, authenticated;
revoke all on function public.list_employee_directory_records_with_work_schedule_times(boolean)
  from public, anon, authenticated;
revoke all on function public.get_employee_directory_record_with_work_schedule_times(uuid)
  from public, anon, authenticated;
revoke all on function public.create_employee_directory_record_with_work_schedule_times(
  text, text, text, text, text, text, text, uuid, text, date, date, date,
  text, boolean, text, text, text, text, text[], text, text, smallint[], jsonb,
  integer
) from public, anon, authenticated;
revoke all on function public.update_employee_directory_record_with_work_schedule_times(
  uuid, text, text, text, text, text, text, text, uuid, text, date, date, date,
  text, boolean, bigint, bigint, text, text, text, text, text[], text, text,
  smallint[], jsonb, integer
) from public, anon, authenticated;

grant execute on function public.submit_my_employee_work_schedule_change_v2(smallint[], jsonb, text)
  to authenticated;
grant execute on function public.submit_selected_employee_work_schedule_change_v2(uuid, smallint[], jsonb, text)
  to authenticated;
grant execute on function public.list_employee_directory_records_with_work_schedule_times(boolean)
  to authenticated;
grant execute on function public.get_employee_directory_record_with_work_schedule_times(uuid)
  to authenticated;
grant execute on function public.create_employee_directory_record_with_work_schedule_times(
  text, text, text, text, text, text, text, uuid, text, date, date, date,
  text, boolean, text, text, text, text, text[], text, text, smallint[], jsonb,
  integer
) to authenticated;
grant execute on function public.update_employee_directory_record_with_work_schedule_times(
  uuid, text, text, text, text, text, text, text, uuid, text, date, date, date,
  text, boolean, bigint, bigint, text, text, text, text, text[], text, text,
  smallint[], jsonb, integer
) to authenticated;

commit;
