begin;

-- Address is an HR-only canonical employee field. Keeping it beside the
-- existing private contact record prevents a separate check-in register from
-- drifting away from the Directory.
alter table private.employee_directory_details
  add column address text
    check (
      address is null
      or (
        address = btrim(address)
        and char_length(address) between 1 and 500
      )
    );

comment on column private.employee_directory_details.address is
  'HR-only employee address. It is intentionally excluded from public organisation, employee self-profile and manager-notification DTOs.';

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
      'laptop_id', 'mouse_id', 'keyboard_id', 'asset_tags'
    ]::text[]
  );

-- The return shape changes to add address, so PostgreSQL requires a drop and
-- recreate. The RPC remains HR-authorised and has the same public name.
drop function public.list_employee_directory_records();

create function public.list_employee_directory_records()
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
  laptop_supplied text,
  laptop_id text,
  mouse_id text,
  keyboard_id text,
  asset_tags text[]
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not private.is_internal_org_hr() then
    raise exception 'Only an authorized HR user can access employee directory records.'
      using errcode = '42501';
  end if;

  return query
  select
    person.id,
    person.version,
    coalesce(detail.version, 0::bigint),
    person.company_key,
    person.is_active,
    detail.first_name,
    detail.last_name,
    person.full_name,
    person.position_title,
    detail.team_name,
    manager.manager_id,
    manager.manager_name,
    detail.work_email,
    detail.personal_email,
    detail.phone,
    detail.country,
    detail.address,
    detail.date_of_birth,
    person.started_date,
    detail.scheduled_employment_end_date,
    detail.laptop_supplied,
    detail.laptop_id,
    detail.mouse_id,
    detail.keyboard_id,
    coalesce(detail.asset_tags, array[]::text[])
  from public.internal_org_people person
  left join private.employee_directory_details detail
    on detail.person_id = person.id
  left join lateral private.resolve_internal_org_employee_manager(person.id) manager on true
  where person.node_kind = 'person'
    and person.is_active
  order by lower(person.full_name), person.id;
end;
$$;

create function public.update_employee_directory_address(
  p_person_id uuid,
  p_address text,
  p_expected_detail_version bigint
)
returns table (detail_version bigint)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_detail private.employee_directory_details%rowtype;
  v_address text;
begin
  if not private.is_internal_org_hr() then
    raise exception 'Only an authorized HR user can update employee directory records.'
      using errcode = '42501';
  end if;

  if p_person_id is null or p_expected_detail_version is null or p_expected_detail_version < 1 then
    raise exception 'The employee detail version is required.' using errcode = '22004';
  end if;

  select detail.*
  into v_detail
  from private.employee_directory_details detail
  join public.internal_org_people person on person.id = detail.person_id
  where detail.person_id = p_person_id
    and person.node_kind = 'person'
  for update;

  if not found then
    raise exception 'The employee detail does not exist.' using errcode = '23503';
  end if;

  if v_detail.version <> p_expected_detail_version then
    raise exception 'This employee detail changed since it was opened. Refresh and try again.'
      using errcode = '40001';
  end if;

  v_address := private.normalise_employee_directory_text(p_address, 500, false, 'Address');
  if v_detail.address is not distinct from v_address then
    return query select v_detail.version;
    return;
  end if;

  update private.employee_directory_details detail
  set address = v_address,
      updated_by = v_actor
  where detail.person_id = p_person_id
  returning * into v_detail;

  insert into private.employee_directory_audit_events (
    person_id, actor_user_id, event_type, changed_fields
  )
  values (p_person_id, v_actor, 'updated', array['address']::text[]);

  return query select v_detail.version;
end;
$$;

revoke all on function public.list_employee_directory_records()
  from public, anon, authenticated;
revoke all on function public.update_employee_directory_address(uuid, text, bigint)
  from public, anon, authenticated;
grant execute on function public.list_employee_directory_records() to authenticated;
grant execute on function public.update_employee_directory_address(uuid, text, bigint)
  to authenticated;

create table private.employee_check_in_reminders (
  id uuid primary key default gen_random_uuid(),
  person_id uuid not null references public.internal_org_people (id) on delete cascade,
  milestone text not null check (milestone in ('2_week', '1_month', '3_month', '5_month')),
  reminder_sequence text not null check (reminder_sequence in ('initial', 'final')),
  due_date date not null,
  notify_date date not null,
  delivery_status text not null default 'scheduled'
    check (delivery_status in ('scheduled', 'claimed', 'delivered', 'completed', 'needs_review', 'superseded', 'cancelled')),
  attempt_count integer not null default 0 check (attempt_count >= 0 and attempt_count <= 100),
  next_attempt_at timestamptz,
  claim_token uuid,
  claimed_at timestamptz,
  delivered_at timestamptz,
  provider_delivery_id text,
  -- Set only by the HR-only manual catch-up action. It permits one explicitly
  -- approved catch-up delivery after a due date; normal cron work never
  -- revives an overdue schedule automatically.
  manual_catch_up_requested_at timestamptz,
  needs_review_reason text
    check (needs_review_reason is null or needs_review_reason in (
      'historic_cutover', 'missing_manager_email', 'not_enrolled',
      'start_date_changed_after_delivery', 'context_changed', 'retry_exhausted',
      'missed_delivery'
    )),
  last_delivery_error_code text,
  last_delivery_error_at timestamptz,
  completed_at timestamptz,
  completed_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  unique (person_id, milestone, reminder_sequence, due_date),
  check (
    (reminder_sequence = 'final' and milestone = '5_month')
    or reminder_sequence = 'initial'
  ),
  check (notify_date <= due_date)
);

comment on table private.employee_check_in_reminders is
  'Private durable check-in reminder schedule/outbox. It stores delivery state and opaque provider IDs, never email bodies or employee private profile fields.';

alter table private.employee_check_in_reminders enable row level security;
revoke all on table private.employee_check_in_reminders from public, anon, authenticated;

create index employee_check_in_reminders_claim_idx
  on private.employee_check_in_reminders (delivery_status, notify_date, next_attempt_at, due_date)
  where delivery_status in ('scheduled', 'claimed');
create index employee_check_in_reminders_person_idx
  on private.employee_check_in_reminders (person_id, due_date, notify_date);

create table private.employee_check_in_reminder_events (
  id bigint generated always as identity primary key,
  reminder_id uuid not null references private.employee_check_in_reminders (id) on delete cascade,
  event_type text not null check (event_type in ('scheduled', 'needs_review', 'claimed', 'delivered', 'delivery_failed', 'completed', 'superseded', 'cancelled', 'catch_up_queued')),
  actor_user_id uuid references auth.users (id) on delete set null,
  error_code text,
  created_at timestamptz not null default clock_timestamp()
);

comment on table private.employee_check_in_reminder_events is
  'Append-only, value-minimised reminder audit history. It never records recipients, email contents, addresses, dates of birth, mobile numbers or personal emails.';

alter table private.employee_check_in_reminder_events enable row level security;
revoke all on table private.employee_check_in_reminder_events from public, anon, authenticated;

create index employee_check_in_reminder_events_reminder_idx
  on private.employee_check_in_reminder_events (reminder_id, created_at desc);

-- Existing staff are deliberately not automatically enrolled when this module
-- ships. HR must explicitly enable a person before future milestones may mail
-- their manager. New person rows created after this migration receive the
-- automatic mode through the narrow org-change trigger below.
create table private.employee_check_in_enrolments (
  person_id uuid primary key references public.internal_org_people (id) on delete cascade,
  delivery_mode text not null check (delivery_mode in ('automatic', 'needs_review')),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  enrolled_by uuid references auth.users (id) on delete set null
);

comment on table private.employee_check_in_enrolments is
  'Private cutover/enrolment control for check-in reminders. Existing roster people start needs_review so production activation cannot send a historic-staff flood.';

alter table private.employee_check_in_enrolments enable row level security;
revoke all on table private.employee_check_in_enrolments from public, anon, authenticated;

-- The source tracker uses exact day offsets, not calendar-month arithmetic.
-- "Business days" means Monday-Friday only until HR provides an approved
-- Victorian public-holiday calendar source.
create function private.employee_check_in_business_days_before(
  p_date date,
  p_business_days integer
)
returns date
language plpgsql
immutable
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
    if extract(isodow from v_cursor) between 1 and 5 then
      v_remaining := v_remaining - 1;
    end if;
  end loop;

  return v_cursor;
end;
$$;

create function private.sync_employee_check_in_reminders(
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
  v_manager_id uuid;
  v_manager_work_email text;
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

  if not found or v_person.node_kind <> 'person' or not v_person.is_active or v_person.started_date is null then
    with cancelled as (
      update private.employee_check_in_reminders reminder
      set delivery_status = 'cancelled',
          needs_review_reason = null,
          updated_at = clock_timestamp(),
          claim_token = null,
          claimed_at = null
      where reminder.person_id = p_person_id
        and reminder.delivery_status in ('scheduled', 'needs_review', 'claimed')
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

  select manager.manager_id, manager_detail.work_email
  into v_manager_id, v_manager_work_email
  from public.internal_org_people person
  left join lateral private.resolve_internal_org_employee_manager(person.id) manager on true
  left join private.employee_directory_details manager_detail on manager_detail.person_id = manager.manager_id
  where person.id = p_person_id;

  select exists (
    select 1 from private.employee_check_in_reminders reminder
    where reminder.person_id = p_person_id
      and reminder.delivery_status in ('delivered', 'completed')
  ) into v_has_delivery_history;

  if v_enrolment_mode is distinct from 'automatic' then
    v_schedule_status := 'needs_review';
    v_needs_review_reason := 'not_enrolled';
  elsif p_start_date_changed and v_has_delivery_history then
    v_schedule_status := 'needs_review';
    v_needs_review_reason := 'start_date_changed_after_delivery';
  elsif v_manager_id is null or nullif(btrim(v_manager_work_email), '') is null then
    v_schedule_status := 'needs_review';
    v_needs_review_reason := 'missing_manager_email';
  else
    v_schedule_status := 'scheduled';
    v_needs_review_reason := null;
  end if;

  if p_invalidate_claims then
    with invalidated as (
      update private.employee_check_in_reminders reminder
      set delivery_status = 'needs_review',
          needs_review_reason = 'context_changed',
          claim_token = null,
          claimed_at = null,
          updated_at = clock_timestamp()
      where reminder.person_id = p_person_id
        and reminder.delivery_status = 'claimed'
      returning reminder.id
    )
    insert into private.employee_check_in_reminder_events (reminder_id, event_type)
    select id, 'needs_review' from invalidated;
  end if;

  with desired(milestone, reminder_sequence, due_date, notify_date) as (
    values
      ('2_week'::text, 'initial'::text, v_person.started_date + 14, v_person.started_date + 11),
      ('1_month'::text, 'initial'::text, v_person.started_date + 30,
        private.employee_check_in_business_days_before(v_person.started_date + 30, 4)),
      ('3_month'::text, 'initial'::text, v_person.started_date + 90, v_person.started_date + 76),
      ('5_month'::text, 'initial'::text, v_person.started_date + 150, v_person.started_date + 136),
      ('5_month'::text, 'final'::text, v_person.started_date + 150, v_person.started_date + 143)
  ), superseded as (
    update private.employee_check_in_reminders reminder
    set delivery_status = 'superseded',
        needs_review_reason = null,
        updated_at = clock_timestamp(),
        claim_token = null,
        claimed_at = null
    where reminder.person_id = p_person_id
      and reminder.delivery_status in ('scheduled', 'needs_review')
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

  with refreshed as (
    update private.employee_check_in_reminders reminder
    set delivery_status = case
          when v_schedule_status = 'needs_review' and reminder.delivery_status = 'scheduled' then 'needs_review'
          when v_schedule_status = 'scheduled'
            and reminder.delivery_status = 'needs_review'
            and reminder.needs_review_reason in ('not_enrolled', 'missing_manager_email')
            and reminder.notify_date >= v_today then 'scheduled'
          else reminder.delivery_status
        end,
        needs_review_reason = case
          when v_schedule_status = 'needs_review' and reminder.delivery_status = 'scheduled' then v_needs_review_reason
          when v_schedule_status = 'scheduled'
            and reminder.delivery_status = 'needs_review'
            and reminder.needs_review_reason in ('not_enrolled', 'missing_manager_email')
            and reminder.notify_date >= v_today then null
          else reminder.needs_review_reason
        end,
        updated_at = clock_timestamp()
    where reminder.person_id = p_person_id
      and reminder.delivery_status in ('scheduled', 'needs_review')
      and (
        (v_schedule_status = 'needs_review' and reminder.delivery_status = 'scheduled')
        or (v_schedule_status = 'scheduled' and reminder.delivery_status = 'needs_review'
          and reminder.needs_review_reason in ('not_enrolled', 'missing_manager_email')
          and reminder.notify_date >= v_today)
      )
    returning reminder.id, reminder.delivery_status
  )
  insert into private.employee_check_in_reminder_events (reminder_id, event_type)
  select id, case when delivery_status = 'needs_review' then 'needs_review' else 'scheduled' end from refreshed;

  with desired(milestone, reminder_sequence, due_date, notify_date) as (
    values
      ('2_week'::text, 'initial'::text, v_person.started_date + 14, v_person.started_date + 11),
      ('1_month'::text, 'initial'::text, v_person.started_date + 30,
        private.employee_check_in_business_days_before(v_person.started_date + 30, 4)),
      ('3_month'::text, 'initial'::text, v_person.started_date + 90, v_person.started_date + 76),
      ('5_month'::text, 'initial'::text, v_person.started_date + 150, v_person.started_date + 136),
      ('5_month'::text, 'final'::text, v_person.started_date + 150, v_person.started_date + 143)
  ), inserted as (
    insert into private.employee_check_in_reminders (
      person_id, milestone, reminder_sequence, due_date, notify_date, delivery_status, needs_review_reason
    )
    select p_person_id, desired.milestone, desired.reminder_sequence, desired.due_date, desired.notify_date,
      case when desired.notify_date < v_today then 'needs_review' else v_schedule_status end,
      case
        when desired.notify_date < v_today then 'historic_cutover'
        else v_needs_review_reason
      end
    from desired
    on conflict (person_id, milestone, reminder_sequence, due_date) do nothing
    returning id, delivery_status
  )
  insert into private.employee_check_in_reminder_events (reminder_id, event_type)
  select id, case when delivery_status = 'needs_review' then 'needs_review' else 'scheduled' end from inserted;
end;
$$;

-- The initial historical roster is explicitly held for HR review. This runs
-- before the org trigger exists, so only future inserted people can enter
-- automatic mode without an HR enrolment action.
insert into private.employee_check_in_enrolments (person_id, delivery_mode)
select person.id, 'needs_review'
from public.internal_org_people person
where person.node_kind = 'person'
on conflict (person_id) do nothing;

select private.sync_employee_check_in_reminders(person.id, false)
from public.internal_org_people person
where person.node_kind = 'person';

create function private.sync_employee_check_in_reminders_after_org_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_person_id uuid;
  v_hierarchy_changed boolean;
begin
  if tg_op = 'INSERT' then
    if new.node_kind = 'person' then
      insert into private.employee_check_in_enrolments (person_id, delivery_mode)
      values (new.id, 'automatic') on conflict (person_id) do nothing;
      perform private.sync_employee_check_in_reminders(new.id, false, false);
    end if;
    return new;
  end if;

  -- A change to any hierarchy node can change the effective manager for its
  -- descendants. The roster is deliberately small, so revalidating every
  -- active person is safer than trying to infer a partial subtree while a
  -- reminder is claimed. Claimed rows are invalidated before a provider call.
  v_hierarchy_changed := new.parent_id is distinct from old.parent_id
    or new.node_kind is distinct from old.node_kind
    or new.is_active is distinct from old.is_active;

  if v_hierarchy_changed then
    for v_person_id in
      select person.id
      from public.internal_org_people person
      where person.node_kind = 'person'
        and person.is_active
    loop
      perform private.sync_employee_check_in_reminders(v_person_id, true, false);
    end loop;
  end if;

  if old.node_kind = 'person' then
    perform private.sync_employee_check_in_reminders(
      old.id,
      v_hierarchy_changed or new.started_date is distinct from old.started_date,
      new.started_date is distinct from old.started_date
    );
  elsif new.node_kind = 'person' then
    -- Converting an existing hierarchy node into a person is not treated as a
    -- newly hired record. HR must explicitly enrol it before mail can start.
    insert into private.employee_check_in_enrolments (person_id, delivery_mode)
    values (new.id, 'needs_review') on conflict (person_id) do nothing;
    perform private.sync_employee_check_in_reminders(new.id, true, true);
  end if;
  return new;
end;
$$;

create trigger internal_org_people_sync_employee_check_in_reminders
after insert or update of started_date, is_active, parent_id, node_kind
on public.internal_org_people
for each row execute function private.sync_employee_check_in_reminders_after_org_change();

create function private.sync_employee_check_in_reminders_after_manager_work_email_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_person_id uuid;
begin
  if tg_op = 'UPDATE' and new.work_email is not distinct from old.work_email then
    return new;
  end if;
  for v_person_id in
    select person.id
    from public.internal_org_people person
    join lateral private.resolve_internal_org_employee_manager(person.id) manager on true
    where person.node_kind = 'person'
      and manager.manager_id = new.person_id
  loop
    perform private.sync_employee_check_in_reminders(v_person_id, true);
  end loop;
  return new;
end;
$$;

create trigger employee_directory_details_sync_employee_check_in_manager_email
after insert or update of work_email on private.employee_directory_details
for each row execute function private.sync_employee_check_in_reminders_after_manager_work_email_change();

create function public.list_employee_check_in_register()
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
    raise exception 'Only an authorized HR user can access the employee check-in register.'
      using errcode = '42501';
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
    case
      when manager_detail.work_email is not null then 'manager_work_email'
      else 'missing'
    end,
    coalesce(enrolment.delivery_mode, 'needs_review'),
    coalesce(schedule.reminders, '[]'::jsonb)
  from public.internal_org_people person
  left join private.employee_directory_details detail on detail.person_id = person.id
  left join lateral private.resolve_internal_org_employee_manager(person.id) manager on true
  left join private.employee_directory_details manager_detail
    on manager_detail.person_id = manager.manager_id
  left join private.employee_check_in_enrolments enrolment
    on enrolment.person_id = person.id
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
        'needsReviewReason', reminder.needs_review_reason
      )
      order by reminder.due_date, reminder.notify_date, reminder.reminder_sequence
    ) as reminders
    from private.employee_check_in_reminders reminder
    where reminder.person_id = person.id
      and reminder.delivery_status not in ('superseded', 'cancelled')
  ) schedule on true
  where person.node_kind = 'person'
    and person.is_active
  order by person.company_key, lower(person.full_name), person.id;
end;
$$;

-- HR explicitly enrols legacy staff after checking the record. The initial
-- migration never enables this automatically, which prevents historic roster
-- records from generating a future reminder flood at rollout.
create function public.enrol_employee_check_in_reminders(p_person_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
begin
  if not private.is_internal_org_hr() then
    raise exception 'Only an authorized HR user can enrol check-in reminders.'
      using errcode = '42501';
  end if;

  if not exists (
    select 1
    from public.internal_org_people person
    where person.id = p_person_id
      and person.node_kind = 'person'
      and person.is_active
      and person.started_date is not null
  ) then
    raise exception 'An active employee with a start date is required.' using errcode = '23503';
  end if;

  insert into private.employee_check_in_enrolments (
    person_id, delivery_mode, enrolled_by, updated_at
  )
  values (p_person_id, 'automatic', v_actor, clock_timestamp())
  on conflict (person_id) do update
    set delivery_mode = 'automatic',
        enrolled_by = excluded.enrolled_by,
        updated_at = excluded.updated_at;

  perform private.sync_employee_check_in_reminders(p_person_id, false, false);
end;
$$;

create function public.complete_employee_check_in_reminder(p_reminder_id uuid)
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
    and person.is_active
  for update;

  if not found then
    raise exception 'The check-in reminder does not exist.' using errcode = '23503';
  end if;

  with completed as (
    update private.employee_check_in_reminders reminder
    set delivery_status = 'completed',
        completed_at = coalesce(reminder.completed_at, clock_timestamp()),
        completed_by = coalesce(reminder.completed_by, v_actor),
        updated_at = clock_timestamp(),
        claim_token = null,
        claimed_at = null
    where reminder.person_id = v_reminder.person_id
      and reminder.milestone = v_reminder.milestone
      and reminder.due_date = v_reminder.due_date
      and reminder.delivery_status in ('scheduled', 'claimed', 'delivered', 'needs_review')
    returning reminder.id
  )
  insert into private.employee_check_in_reminder_events (reminder_id, event_type, actor_user_id)
  select id, 'completed', v_actor from completed;
end;
$$;

create function public.queue_employee_check_in_catch_up(p_reminder_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_updated_count integer := 0;
begin
  if not private.is_internal_org_hr() then
    raise exception 'Only an authorized HR user can queue check-in catch-up reminders.'
      using errcode = '42501';
  end if;

  -- A catch-up is always an explicit HR decision. It resets the retry budget
  -- and marks the row so the cron may send even though its due date is past.
  with queued as (
    update private.employee_check_in_reminders reminder
    set delivery_status = 'scheduled',
        needs_review_reason = null,
        next_attempt_at = null,
        claim_token = null,
        claimed_at = null,
        attempt_count = 0,
        last_delivery_error_code = null,
        last_delivery_error_at = null,
        manual_catch_up_requested_at = clock_timestamp(),
        updated_at = clock_timestamp()
    from public.internal_org_people person
    join lateral private.resolve_internal_org_employee_manager(person.id) manager on true
    join private.employee_directory_details manager_detail
      on manager_detail.person_id = manager.manager_id
    where reminder.id = p_reminder_id
      and reminder.delivery_status = 'needs_review'
      and person.id = reminder.person_id
      and person.node_kind = 'person'
      and person.is_active
      and person.started_date is not null
      and manager.manager_id is not null
      and nullif(btrim(manager_detail.work_email), '') is not null
    returning reminder.id
  )
  insert into private.employee_check_in_reminder_events (reminder_id, event_type, actor_user_id)
  select id, 'catch_up_queued', v_actor from queued;

  get diagnostics v_updated_count = row_count;
  if v_updated_count = 0 then
    raise exception 'Only an eligible needs-review reminder with a current manager work email can be queued.'
      using errcode = '22023';
  end if;
end;
$$;

-- Service-role-only outbox claim. It derives the current manager and work
-- email inside the database; it never accepts employee or recipient data from
-- a browser, cron URL or n8n callback.
create function public.claim_due_employee_check_in_reminders(p_limit integer default 10)
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

  -- A request which timed out after n8n accepted a delivery is reclaimed with
  -- the same deterministic reminder ID at the HTTP layer. It then passes the
  -- stale/eligibility sweeps below before it can be claimed again.
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

  -- Never let an exhausted retry counter overflow the table constraint or
  -- keep retrying indefinitely. HR may explicitly requeue after remediation.
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

  -- A cron outage must not result in a late, surprising manager email. A
  -- non-manual row may only be delivered on its scheduled Melbourne date;
  -- anything later is held for HR. The sole exception is a row an HR user
  -- deliberately queued as catch-up.
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

  -- Fail closed when current employee context is no longer valid. This sweep
  -- deliberately happens before the candidate join so invalid rows cannot sit
  -- hidden as scheduled and mail later when data is repaired.
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
    insert into private.employee_check_in_reminder_events (reminder_id, event_type)
    select claimed.id, 'claimed' from claimed
    returning reminder_id
  )
  select claimed.id, claimed.claim_token from claimed;
end;
$$;

-- Re-resolve the employee and manager immediately before the outbound n8n
-- POST. The cron receives no payload from the claim RPC, so a reparenting,
-- deactivation or manager-email edit between claim and send cannot mail a
-- stale recipient.
create function public.prepare_employee_check_in_reminder_delivery(
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
    v_employee_is_current
  from public.internal_org_people person
  left join private.employee_directory_details detail on detail.person_id = person.id
  left join lateral private.resolve_internal_org_employee_manager(person.id) manager on true
  left join private.employee_directory_details manager_detail
    on manager_detail.person_id = manager.manager_id
  left join private.employee_check_in_enrolments enrolment
    on enrolment.person_id = person.id
  where person.id = v_reminder.person_id;

  if not found or not coalesce(v_employee_is_current, false)
    or nullif(btrim(v_first_name), '') is null
    or nullif(btrim(v_last_name), '') is null
    or nullif(btrim(v_role), '') is null
    or nullif(btrim(v_department), '') is null
    or nullif(btrim(v_manager_name), '') is null then
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

  return query
  select
    v_reminder.id,
    v_first_name,
    v_last_name,
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

create function public.complete_employee_check_in_reminder_delivery(
  p_reminder_id uuid,
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
  with delivered as (
    update private.employee_check_in_reminders reminder
    set delivery_status = 'delivered',
        delivered_at = clock_timestamp(),
        -- Do not store a provider response/error payload. A provider ID is
        -- optional and only retained when it is a compact opaque token.
        provider_delivery_id = case
          when p_provider_delivery_id ~ '^[A-Za-z0-9._:-]{1,200}$'
            then p_provider_delivery_id
          else null
        end,
        claim_token = null,
        claimed_at = null,
        updated_at = clock_timestamp()
    where reminder.id = p_reminder_id
      and reminder.delivery_status = 'claimed'
      and reminder.claim_token = p_claim_token
    returning reminder.id
  ), event_inserted as (
    insert into private.employee_check_in_reminder_events (reminder_id, event_type)
    select id, 'delivered' from delivered
    returning reminder_id
  )
  select exists (select 1 from delivered) into v_updated;

  return v_updated;
end;
$$;

create function public.fail_employee_check_in_reminder_delivery(
  p_reminder_id uuid,
  p_claim_token uuid,
  p_error_code text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_updated boolean := false;
  v_error_code text;
begin
  -- Accept only a small operational taxonomy. Raw webhook text can contain
  -- staff information and is never persisted in this audit/outbox schema.
  v_error_code := case lower(coalesce(nullif(btrim(p_error_code), ''), ''))
    when 'network_error' then 'network_error'
    when 'provider_timeout' then 'provider_timeout'
    when 'provider_rejected' then 'provider_rejected'
    when 'invalid_response' then 'invalid_response'
    when 'configuration_error' then 'configuration_error'
    else 'delivery_failed'
  end;

  with failed as (
    update private.employee_check_in_reminders reminder
    set delivery_status = 'scheduled',
        -- Retries remain within the scheduled Melbourne notification date;
        -- the claim sweep moves anything later to HR review.
        next_attempt_at = clock_timestamp() + interval '15 minutes',
        claim_token = null,
        claimed_at = null,
        last_delivery_error_code = v_error_code,
        last_delivery_error_at = clock_timestamp(),
        updated_at = clock_timestamp()
    where reminder.id = p_reminder_id
      and reminder.delivery_status = 'claimed'
      and reminder.claim_token = p_claim_token
    returning reminder.id
  ), event_inserted as (
    insert into private.employee_check_in_reminder_events (reminder_id, event_type, error_code)
    select id, 'delivery_failed', v_error_code from failed
    returning reminder_id
  )
  select exists (select 1 from failed) into v_updated;

  return v_updated;
end;
$$;

revoke all on function private.employee_check_in_business_days_before(date, integer)
  from public, anon, authenticated;
revoke all on function private.sync_employee_check_in_reminders(uuid, boolean, boolean)
  from public, anon, authenticated;
revoke all on function private.sync_employee_check_in_reminders_after_org_change()
  from public, anon, authenticated;
revoke all on function private.sync_employee_check_in_reminders_after_manager_work_email_change()
  from public, anon, authenticated;
revoke all on function public.list_employee_check_in_register()
  from public, anon, authenticated;
revoke all on function public.enrol_employee_check_in_reminders(uuid)
  from public, anon, authenticated;
revoke all on function public.complete_employee_check_in_reminder(uuid)
  from public, anon, authenticated;
revoke all on function public.queue_employee_check_in_catch_up(uuid)
  from public, anon, authenticated;
revoke all on function public.claim_due_employee_check_in_reminders(integer)
  from public, anon, authenticated;
revoke all on function public.prepare_employee_check_in_reminder_delivery(uuid, uuid)
  from public, anon, authenticated;
revoke all on function public.complete_employee_check_in_reminder_delivery(uuid, uuid, text)
  from public, anon, authenticated;
revoke all on function public.fail_employee_check_in_reminder_delivery(uuid, uuid, text)
  from public, anon, authenticated;

grant execute on function public.list_employee_check_in_register() to authenticated;
grant execute on function public.enrol_employee_check_in_reminders(uuid) to authenticated;
grant execute on function public.complete_employee_check_in_reminder(uuid) to authenticated;
grant execute on function public.queue_employee_check_in_catch_up(uuid) to authenticated;
grant execute on function public.claim_due_employee_check_in_reminders(integer) to service_role;
grant execute on function public.prepare_employee_check_in_reminder_delivery(uuid, uuid) to service_role;
grant execute on function public.complete_employee_check_in_reminder_delivery(uuid, uuid, text) to service_role;
grant execute on function public.fail_employee_check_in_reminder_delivery(uuid, uuid, text) to service_role;

commit;
