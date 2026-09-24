begin;

do $$
begin
  if to_regclass('private.employee_check_in_reminders') is null
    or to_regclass('private.employee_check_in_reviews') is null
    or to_regclass('private.people_hub_release_flags') is null
    or to_regclass('private.employee_directory_details') is null
    or to_regprocedure('private.employee_check_in_schedule(date)') is null
    or to_regprocedure('private.sync_employee_check_in_reminders(uuid,boolean,boolean)') is null
    or to_regprocedure('public.claim_due_employee_check_in_reminders(integer)') is null
    or to_regprocedure('public.prepare_employee_check_in_reminder_delivery(uuid,uuid)') is null
    or to_regprocedure('public.prepare_employee_check_in_review_notification_delivery(uuid,uuid)') is null then
    raise exception '6-Month Casual Check-In prerequisites are missing.' using errcode = '55000';
  end if;
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'private'
      and table_name = 'employee_directory_details'
      and column_name = 'employment_type'
  ) then
    raise exception 'The employee employment-type field is missing.' using errcode = '55000';
  end if;
end;
$$;

insert into private.people_hub_release_flags (feature, enabled, enabled_at)
values ('six_month_casual_check_in', false, null);

alter table private.employee_check_in_reminders
  drop constraint if exists employee_check_in_reminders_milestone_check;
alter table private.employee_check_in_reminders
  add constraint employee_check_in_reminders_milestone_check
  check (milestone in ('2_week', '1_month', '2_month', '3_month', '5_month', '6_month', '6_month_casual'));

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
  with raw_schedule(milestone, reminder_sequence, day_offset, month_offset, lead_days) as (
    values
      ('2_week'::text, 'initial'::text, 14, null::integer, 3),
      ('1_month'::text, 'initial'::text, 30, null::integer, 3),
      ('2_month'::text, 'initial'::text, 60, null::integer, 3),
      ('3_month'::text, 'initial'::text, 90, null::integer, 5),
      ('5_month'::text, 'initial'::text, 150, null::integer, 5),
      ('6_month'::text, 'initial'::text, null::integer, 6, 5),
      ('6_month_casual'::text, 'initial'::text, null::integer, 6, 5)
  )
  select
    raw_schedule.milestone,
    raw_schedule.reminder_sequence,
    planned.due_date,
    private.employee_check_in_business_days_before(planned.due_date, raw_schedule.lead_days)
  from raw_schedule
  cross join lateral (
    select private.employee_check_in_next_business_day(
      case
        when raw_schedule.month_offset is not null
          then (p_start_date + make_interval(months => raw_schedule.month_offset))::date
        else p_start_date + raw_schedule.day_offset
      end
    ) as due_date
  ) planned
  where (raw_schedule.milestone <> '5_month' or coalesce((
    select release.enabled from private.people_hub_release_flags release
    where release.feature = 'five_month_no_surprises_review'
  ), false))
    and (raw_schedule.milestone <> '6_month' or coalesce((
      select release.enabled from private.people_hub_release_flags release
      where release.feature = 'six_month_check_in_review'
    ), false))
    and (raw_schedule.milestone <> '6_month_casual' or coalesce((
      select release.enabled from private.people_hub_release_flags release
      where release.feature = 'six_month_casual_check_in'
    ), false));
$$;

revoke all on function private.employee_check_in_schedule(date)
  from public, anon, authenticated, service_role;

do $$
declare
  v_definition text;
  v_anchor text := $anchor$select schedule.* from private.employee_check_in_schedule(v_person.started_date) schedule where schedule.milestone <> '6_month' or exists (select 1 from private.employee_check_in_contract_classifications classification where classification.person_id = p_person_id and classification.contract_type in ('permanent', 'fixed_term'))$anchor$;
  v_replacement text := $replacement$select schedule.* from private.employee_check_in_schedule(v_person.started_date) schedule where (schedule.milestone <> '6_month' or (exists (select 1 from private.employee_check_in_contract_classifications classification where classification.person_id = p_person_id and classification.contract_type in ('permanent', 'fixed_term')) and not exists (select 1 from private.employee_directory_details detail where detail.person_id = p_person_id and detail.employment_type = 'casual'))) and (schedule.milestone <> '6_month_casual' or exists (select 1 from private.employee_directory_details detail where detail.person_id = p_person_id and detail.employment_type = 'casual'))$replacement$;
  v_count integer;
begin
  v_definition := pg_get_functiondef('private.sync_employee_check_in_reminders(uuid,boolean,boolean)'::regprocedure);
  v_count := (length(v_definition) - length(replace(v_definition, v_anchor, ''))) / length(v_anchor);
  if v_count <> 2 then
    raise exception 'Check-In sync differs from the reviewed six-month baseline (% schedule projections found).', v_count
      using errcode = '55000';
  end if;
  execute replace(v_definition, v_anchor, v_replacement);
end;
$$;

do $$
declare
  v_definition text;
  v_anchor text := '      and detail.first_name is not null';
  v_replacement text := v_anchor || chr(10)
    || '      and (reminder.milestone <> ''6_month'' or not exists (select 1 from private.employee_directory_details casual_detail where casual_detail.person_id = reminder.person_id and casual_detail.employment_type = ''casual''))' || chr(10)
    || '      and (reminder.milestone <> ''6_month_casual'' or (exists (select 1 from private.people_hub_release_flags release where release.feature = ''six_month_casual_check_in'' and release.enabled) and exists (select 1 from private.employee_directory_details detail where detail.person_id = reminder.person_id and detail.employment_type = ''casual'')))';
  v_count integer;
begin
  v_definition := pg_get_functiondef('public.claim_due_employee_check_in_reminders(integer)'::regprocedure);
  v_count := (length(v_definition) - length(replace(v_definition, v_anchor, ''))) / length(v_anchor);
  if v_count <> 1 then
    raise exception 'Check-In claim function differs from the reviewed baseline.' using errcode = '55000';
  end if;
  execute replace(v_definition, v_anchor, v_replacement);
end;
$$;

do $$
declare
  v_definition text;
  v_anchor text;
  v_replacement text;
  v_count integer;
  v_email_anchor text := 'v_reminder.milestone in (''2_week'', ''1_month'', ''2_month'', ''3_month'', ''5_month'', ''6_month'')';
  v_email_replacement text := 'v_reminder.milestone in (''2_week'', ''1_month'', ''2_month'', ''3_month'', ''5_month'', ''6_month'', ''6_month_casual'')';
begin
  v_definition := pg_get_functiondef('public.prepare_employee_check_in_reminder_delivery(uuid,uuid)'::regprocedure);
  v_anchor := '  if v_reminder.milestone = ''5_month''' || chr(10) || '    and (';
  v_replacement := '  if (' || chr(10)
    || '    (v_reminder.milestone = ''6_month_casual'' and (' || chr(10)
    || '      not exists (select 1 from private.people_hub_release_flags release where release.feature = ''six_month_casual_check_in'' and release.enabled)' || chr(10)
    || '      or not exists (select 1 from private.employee_directory_details detail where detail.person_id = v_reminder.person_id and detail.employment_type = ''casual'')' || chr(10)
    || '    ))' || chr(10)
    || '    or (v_reminder.milestone = ''6_month'' and exists (' || chr(10)
    || '      select 1 from private.employee_directory_details detail' || chr(10)
    || '      where detail.person_id = v_reminder.person_id and detail.employment_type = ''casual''' || chr(10)
    || '    ))' || chr(10)
    || '  ) then' || chr(10)
    || '    with superseded as (' || chr(10)
    || '      update private.employee_check_in_reminders reminder' || chr(10)
    || '      set delivery_status = ''superseded'',' || chr(10)
    || '          needs_review_reason = null,' || chr(10)
    || '          claim_token = null,' || chr(10)
    || '          claimed_at = null,' || chr(10)
    || '          next_attempt_at = null,' || chr(10)
    || '          manual_catch_up_requested_at = null,' || chr(10)
    || '          updated_at = clock_timestamp()' || chr(10)
    || '      where reminder.id = p_reminder_id' || chr(10)
    || '        and reminder.delivery_status = ''claimed''' || chr(10)
    || '        and reminder.claim_token = p_claim_token' || chr(10)
    || '      returning reminder.id' || chr(10)
    || '    )' || chr(10)
    || '    insert into private.employee_check_in_reminder_events (reminder_id, event_type)' || chr(10)
    || '    select id, ''superseded'' from superseded;' || chr(10)
    || '    return;' || chr(10)
    || '  end if;' || chr(10) || chr(10) || v_anchor;
  v_count := (length(v_definition) - length(replace(v_definition, v_anchor, ''))) / length(v_anchor);
  if v_count <> 1 then
    raise exception 'Check-In delivery guard differs from the reviewed baseline.' using errcode = '55000';
  end if;
  v_definition := replace(v_definition, v_anchor, v_replacement);

  v_anchor := '  if v_reminder.milestone = ''6_month''' || chr(10) || '    and (';
  v_replacement := '  if v_reminder.milestone = ''6_month''' || chr(10)
    || '    and (' || chr(10)
    || '      not exists (select 1 from private.people_hub_release_flags release where release.feature = ''six_month_check_in_review'' and release.enabled)' || chr(10)
    || '      or not exists (select 1 from private.employee_check_in_contract_classifications classification where classification.person_id = v_reminder.person_id and classification.contract_type in (''permanent'', ''fixed_term''))' || chr(10)
    || '      or exists (select 1 from private.employee_directory_details detail where detail.person_id = v_reminder.person_id and detail.employment_type = ''casual'')' || chr(10)
    || '    ) then' || chr(10)
    || '    update private.employee_check_in_reminders reminder' || chr(10)
    || '    set delivery_status = ''superseded'',' || chr(10)
    || '        needs_review_reason = null,' || chr(10)
    || '        claim_token = null,' || chr(10)
    || '        claimed_at = null,' || chr(10)
    || '        next_attempt_at = null,' || chr(10)
    || '        manual_catch_up_requested_at = null,' || chr(10)
    || '        updated_at = clock_timestamp()' || chr(10)
    || '    where reminder.id = p_reminder_id' || chr(10)
    || '      and reminder.delivery_status = ''claimed''' || chr(10)
    || '      and reminder.claim_token = p_claim_token;' || chr(10)
    || '    return;' || chr(10)
    || '  end if;' || chr(10) || chr(10) || v_anchor;
  v_count := (length(v_definition) - length(replace(v_definition, v_anchor, ''))) / length(v_anchor);
  if v_count <> 1 then
    raise exception 'Permanent and Fixed-Term delivery guard differs from the reviewed baseline.' using errcode = '55000';
  end if;
  v_definition := replace(v_definition, v_anchor, v_replacement);

  v_count := (length(v_definition) - length(replace(v_definition, v_email_anchor, ''))) / length(v_email_anchor);
  if v_count <> 1 then
    raise exception 'Check-In recipient validation differs from the reviewed baseline.' using errcode = '55000';
  end if;
  execute replace(v_definition, v_email_anchor, v_email_replacement);
end;
$$;

do $$
declare
  v_definition text;
  v_anchor text := 'v_milestone not in (''2_week'', ''1_month'', ''2_month'', ''3_month'', ''5_month'', ''6_month'')';
  v_replacement text := 'v_milestone not in (''2_week'', ''1_month'', ''2_month'', ''3_month'', ''5_month'', ''6_month'', ''6_month_casual'')';
  v_count integer;
begin
  v_definition := pg_get_functiondef('public.prepare_employee_check_in_review_notification_delivery(uuid,uuid)'::regprocedure);
  v_count := (length(v_definition) - length(replace(v_definition, v_anchor, ''))) / length(v_anchor);
  if v_count <> 1 then
    raise exception 'People & Culture milestone validation differs from the reviewed baseline.' using errcode = '55000';
  end if;
  execute replace(v_definition, v_anchor, v_replacement);
end;
$$;

create function private.sync_employee_check_in_reminders_after_employment_type_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.employment_type is distinct from old.employment_type then
    perform private.sync_employee_check_in_reminders(new.person_id, true, false);
  end if;
  return new;
end;
$$;

create trigger employee_directory_details_sync_check_in_employment_type
after update of employment_type on private.employee_directory_details
for each row when (new.employment_type is distinct from old.employment_type)
execute function private.sync_employee_check_in_reminders_after_employment_type_change();

revoke all on function private.sync_employee_check_in_reminders_after_employment_type_change()
  from public, anon, authenticated, service_role;

create function private.activate_six_month_casual_check_in()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_person_id uuid;
  v_release_enabled boolean;
  v_today date := (clock_timestamp() at time zone 'Australia/Melbourne')::date;
begin
  select release.enabled
  into v_release_enabled
  from private.people_hub_release_flags release
  where release.feature = 'six_month_casual_check_in'
  for update;

  if not found then
    raise exception 'The 6-Month Casual release gate is missing.' using errcode = '55000';
  end if;

  if v_release_enabled then
    return;
  end if;

  lock table private.employee_check_in_reminders in access exclusive mode;

  if exists (
    select 1 from private.employee_check_in_reminders reminder
    where reminder.milestone in ('6_month', '6_month_casual')
      and reminder.delivery_status = 'claimed'
  ) then
    raise exception 'A six-month reminder delivery is in flight; retry activation after its lease clears.'
      using errcode = '55000';
  end if;

  update private.people_hub_release_flags release
  set enabled = true,
      enabled_at = coalesce(release.enabled_at, clock_timestamp())
  where release.feature = 'six_month_casual_check_in';

  for v_person_id in
    select person.id
    from public.internal_org_people person
    join private.employee_directory_details detail on detail.person_id = person.id
    where person.node_kind = 'person'
      and person.is_active
      and person.started_date is not null
      and detail.employment_type = 'casual'
    order by person.id
  loop
    perform private.sync_employee_check_in_reminders(v_person_id, false, false);
  end loop;

  if exists (
    select 1
    from private.employee_check_in_reminders reminder
    where reminder.milestone = '6_month_casual'
      and reminder.delivery_status = 'scheduled'
      and reminder.notify_date < v_today
  ) then
    raise exception 'An overdue casual reminder would be dispatched automatically.' using errcode = '55000';
  end if;

  if exists (
    select 1
    from public.internal_org_people person
    join private.employee_directory_details detail on detail.person_id = person.id
    cross join lateral private.employee_check_in_schedule(person.started_date) schedule
    where person.node_kind = 'person'
      and person.is_active
      and person.started_date is not null
      and detail.employment_type = 'casual'
      and schedule.milestone = '6_month_casual'
      and not exists (
        select 1
        from private.employee_check_in_reminders reminder
        where reminder.person_id = person.id
          and reminder.milestone = schedule.milestone
          and reminder.reminder_sequence = schedule.reminder_sequence
          and reminder.due_date = schedule.due_date
          and reminder.delivery_status not in ('superseded', 'cancelled')
      )
  ) then
    raise exception 'An eligible Casual employee is missing a six-month reminder.' using errcode = '55000';
  end if;

  if exists (
    select 1
    from private.employee_check_in_reminders reminder
    where reminder.milestone = '6_month_casual'
      and reminder.delivery_status in ('scheduled', 'claimed', 'needs_review')
      and not exists (
        select 1
        from private.employee_directory_details detail
        join public.internal_org_people person on person.id = detail.person_id
        where person.id = reminder.person_id
          and person.node_kind = 'person'
          and person.is_active
          and person.started_date is not null
          and detail.employment_type = 'casual'
      )
  ) then
    raise exception 'An ineligible employee has an open six-month Casual reminder.' using errcode = '55000';
  end if;
end;
$$;

revoke all on function private.activate_six_month_casual_check_in()
  from public, anon, authenticated, service_role;

do $$
begin
  if (select count(*) <> 1
      from private.people_hub_release_flags release
      where release.feature = 'six_month_casual_check_in')
    or coalesce((select release.enabled
      from private.people_hub_release_flags release
      where release.feature = 'six_month_casual_check_in'), true)
    or exists (
      select 1 from private.employee_check_in_schedule(date '2026-03-15') schedule
      where schedule.milestone = '6_month_casual'
    ) then
    raise exception 'The 6-Month Casual release must remain disabled until the app and live workflow are ready.';
  end if;
  if (select count(*) <> 1
      from private.people_hub_release_flags release
      where release.feature = 'six_month_check_in_review') then
    raise exception 'The existing Permanent and Fixed-Term six-month release gate is missing.';
  end if;
  if to_regprocedure('private.activate_six_month_casual_check_in()') is null
    or not exists (
      select 1 from pg_trigger trigger
      where trigger.tgrelid = 'private.employee_directory_details'::regclass
        and trigger.tgname = 'employee_directory_details_sync_check_in_employment_type'
        and not trigger.tgisinternal
    ) then
    raise exception 'The Casual activation or employment-type synchronization path is missing.';
  end if;
end;
$$;

commit;
