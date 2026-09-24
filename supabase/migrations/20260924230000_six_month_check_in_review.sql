begin;

do $$
begin
  if to_regclass('private.employee_check_in_reminders') is null
    or to_regclass('private.employee_check_in_reviews') is null
    or to_regclass('private.people_hub_release_flags') is null
    or to_regprocedure('private.employee_check_in_schedule(date)') is null
    or to_regprocedure('private.sync_employee_check_in_reminders(uuid,boolean,boolean)') is null
    or to_regprocedure('public.record_employee_check_in_review(uuid,text,date,text,bigint)') is null
    or to_regprocedure('public.list_employee_check_in_register()') is null
    or to_regprocedure('public.list_employee_check_in_workspace()') is null
    or to_regprocedure('public.list_employee_check_in_workspace_for_preview(uuid)') is null then
    raise exception '6-Month Check-In prerequisites are missing.' using errcode = '55000';
  end if;
end;
$$;

create table private.employee_check_in_contract_classifications (
  person_id uuid primary key references public.internal_org_people (id) on delete cascade,
  contract_type text not null check (contract_type in ('permanent', 'fixed_term')),
  updated_by_user_id uuid not null references auth.users (id) on delete restrict,
  updated_at timestamptz not null default clock_timestamp()
);

comment on table private.employee_check_in_contract_classifications is
  'HR-only Permanent or Fixed-Term classification used to determine eligibility for the six-month Check-In.';

alter table private.employee_check_in_contract_classifications enable row level security;
alter table private.employee_check_in_contract_classifications force row level security;
revoke all on table private.employee_check_in_contract_classifications
  from public, anon, authenticated, service_role;

insert into private.people_hub_release_flags (feature, enabled, enabled_at)
values ('six_month_check_in_review', false, null);

alter table private.employee_check_in_reminders
  drop constraint if exists employee_check_in_reminders_milestone_check;
alter table private.employee_check_in_reminders
  add constraint employee_check_in_reminders_milestone_check
  check (milestone in ('2_week', '1_month', '2_month', '3_month', '5_month', '6_month'));

alter table private.employee_check_in_reviews
  drop constraint if exists employee_check_in_reviews_outcome_code_check;
alter table private.employee_check_in_reviews
  add constraint employee_check_in_reviews_outcome_code_check
  check (outcome_code in (
    'on_track', 'follow_up_required', 'hr_review_required',
    'probation_extension_pending_hr', 'non_confirmation_pending_hr'
  ));
alter table private.employee_check_in_reviews
  add column people_culture_approved_version bigint,
  add column people_culture_approved_by_user_id uuid references auth.users (id) on delete restrict,
  add column people_culture_approved_at timestamptz,
  add constraint employee_check_in_reviews_people_culture_approval_check
    check (
      (people_culture_approved_version is null
        and people_culture_approved_by_user_id is null
        and people_culture_approved_at is null)
      or (people_culture_approved_version = version
        and people_culture_approved_by_user_id is not null
        and people_culture_approved_at is not null)
    );

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
      ('6_month'::text, 'initial'::text, null::integer, 6, 5)
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
    ), false));
$$;

comment on function private.employee_check_in_schedule(date) is
  'Canonical Victorian-business-day Check-In schedule. The 2-Week, 1-Month and 2-Month emails are sent three business days before; released 3-Month, 5-Month and 6-Month reviews are sent five business days before.';

revoke all on function private.employee_check_in_schedule(date)
  from public, anon, authenticated, service_role;

do $$
declare
  v_definition text;
  v_anchor text := 'select * from private.employee_check_in_schedule(v_person.started_date)';
  v_replacement text := 'select schedule.* from private.employee_check_in_schedule(v_person.started_date) schedule where schedule.milestone <> ''6_month'' or exists (select 1 from private.employee_check_in_contract_classifications classification where classification.person_id = p_person_id and classification.contract_type in (''permanent'', ''fixed_term''))';
  v_count integer;
begin
  v_definition := pg_get_functiondef('private.sync_employee_check_in_reminders(uuid,boolean,boolean)'::regprocedure);
  v_count := (length(v_definition) - length(replace(v_definition, v_anchor, ''))) / length(v_anchor);
  if v_count <> 2 then
    raise exception 'Check-In sync differs from the reviewed baseline (% schedule projections found).', v_count
      using errcode = '55000';
  end if;
  execute replace(v_definition, v_anchor, v_replacement);
end;
$$;

do $$
declare
  v_definition text;
  v_anchor text := '      and detail.first_name is not null';
  v_replacement text := v_anchor || chr(10) || '      and (' || chr(10) || '        reminder.milestone <> ''6_month''' || chr(10) || '        or (' || chr(10) || '          exists (select 1 from private.people_hub_release_flags release where release.feature = ''six_month_check_in_review'' and release.enabled)' || chr(10) || '          and exists (select 1 from private.employee_check_in_contract_classifications classification where classification.person_id = reminder.person_id and classification.contract_type in (''permanent'', ''fixed_term''))' || chr(10) || '        )' || chr(10) || '      )';
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
  v_anchor text := '  if v_reminder.milestone = ''5_month''' || chr(10) || '    and (';
  v_replacement text := '  if v_reminder.milestone = ''6_month''' || chr(10) || '    and (' || chr(10) || '      not exists (select 1 from private.people_hub_release_flags release where release.feature = ''six_month_check_in_review'' and release.enabled)' || chr(10) || '      or not exists (select 1 from private.employee_check_in_contract_classifications classification where classification.person_id = v_reminder.person_id and classification.contract_type in (''permanent'', ''fixed_term''))' || chr(10) || '    ) then' || chr(10) || '    update private.employee_check_in_reminders reminder' || chr(10) || '    set delivery_status = ''superseded'',' || chr(10) || '        needs_review_reason = null,' || chr(10) || '        claim_token = null,' || chr(10) || '        claimed_at = null,' || chr(10) || '        next_attempt_at = null,' || chr(10) || '        manual_catch_up_requested_at = null,' || chr(10) || '        updated_at = clock_timestamp()' || chr(10) || '    where reminder.id = p_reminder_id' || chr(10) || '      and reminder.delivery_status = ''claimed''' || chr(10) || '      and reminder.claim_token = p_claim_token;' || chr(10) || '    return;' || chr(10) || '  end if;' || chr(10) || chr(10) || v_anchor;
  v_count integer;
  v_email_anchor text := 'v_reminder.milestone in (''2_week'', ''1_month'', ''2_month'', ''3_month'', ''5_month'')';
  v_email_replacement text := 'v_reminder.milestone in (''2_week'', ''1_month'', ''2_month'', ''3_month'', ''5_month'', ''6_month'')';
begin
  v_definition := pg_get_functiondef('public.prepare_employee_check_in_reminder_delivery(uuid,uuid)'::regprocedure);
  v_count := (length(v_definition) - length(replace(v_definition, v_anchor, ''))) / length(v_anchor);
  if v_count <> 1 then
    raise exception 'Check-In prepare function differs from the reviewed baseline.' using errcode = '55000';
  end if;
  v_definition := replace(v_definition, v_anchor, v_replacement);
  v_count := (length(v_definition) - length(replace(v_definition, v_email_anchor, ''))) / length(v_email_anchor);
  if v_count <> 1 then
    raise exception 'Check-In recipient validation differs from the reviewed baseline.' using errcode = '55000';
  end if;
  execute replace(v_definition, v_email_anchor, v_email_replacement);
end;
$$;

create or replace function public.can_approve_employee_check_in_employment_decision()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.is_internal_org_hr();
$$;

revoke all on function public.can_approve_employee_check_in_employment_decision()
  from public, anon, authenticated, service_role;
grant execute on function public.can_approve_employee_check_in_employment_decision()
  to authenticated;

create function public.list_employee_check_in_contract_classifications()
returns table (person_id uuid, contract_type text)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not public.can_manage_employee_directory() then
    raise exception 'Only an authorized System Admin can access employee contract classifications.' using errcode = '42501';
  end if;

  return query
  select classification.person_id, classification.contract_type
  from private.employee_check_in_contract_classifications classification
  order by classification.person_id;
end;
$$;

create function public.set_employee_check_in_contract_classification(
  p_person_id uuid,
  p_contract_type text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
begin
  if v_actor is null or coalesce(((select auth.jwt()) ->> 'is_anonymous')::boolean, false)
    or not public.can_manage_employee_directory() then
    raise exception 'Only an authorized System Admin can change employee contract classifications.' using errcode = '42501';
  end if;

  if p_person_id is null then
    raise exception 'An employee is required.' using errcode = '22004';
  end if;
  if p_contract_type is not null and p_contract_type not in ('permanent', 'fixed_term') then
    raise exception 'Choose Permanent or Fixed-Term.' using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.internal_org_people person
    where person.id = p_person_id and person.node_kind = 'person'
  ) then
    raise exception 'The employee does not exist.' using errcode = '23503';
  end if;

  if p_contract_type is null then
    delete from private.employee_check_in_contract_classifications classification
    where classification.person_id = p_person_id;
  else
    insert into private.employee_check_in_contract_classifications as classification (
      person_id, contract_type, updated_by_user_id, updated_at
    ) values (
      p_person_id, p_contract_type, v_actor, clock_timestamp()
    )
    on conflict (person_id) do update
    set contract_type = excluded.contract_type,
        updated_by_user_id = excluded.updated_by_user_id,
        updated_at = excluded.updated_at
    where classification.contract_type is distinct from excluded.contract_type;
  end if;

  perform private.sync_employee_check_in_reminders(p_person_id, false, false);
end;
$$;

revoke all on function public.list_employee_check_in_contract_classifications()
  from public, anon, authenticated, service_role;
revoke all on function public.set_employee_check_in_contract_classification(uuid,text)
  from public, anon, authenticated, service_role;
grant execute on function public.list_employee_check_in_contract_classifications()
  to authenticated;
grant execute on function public.set_employee_check_in_contract_classification(uuid,text)
  to authenticated;

do $$
declare
  v_signature text;
  v_definition text;
  v_anchor text := '''reviewRecordedAt'', review.recorded_at';
  v_replacement text := '''reviewRecordedAt'', review.recorded_at,' || chr(10) || '        ''peopleCultureApproved'', coalesce(review.people_culture_approved_version = review.version, false)';
  v_count integer;
begin
  foreach v_signature in array array[
    'public.list_employee_check_in_register()',
    'public.list_employee_check_in_workspace()',
    'public.list_employee_check_in_workspace_for_preview(uuid)'
  ] loop
    v_definition := pg_get_functiondef(v_signature::regprocedure);
    v_count := (length(v_definition) - length(replace(v_definition, v_anchor, ''))) / length(v_anchor);
    if v_count <> 1 then
      raise exception 'Check-In review projection differs from the reviewed baseline: %.', v_signature
        using errcode = '55000';
    end if;
    execute replace(v_definition, v_anchor, v_replacement);
  end loop;
end;
$$;

do $$
declare
  v_definition text;
  v_anchor text;
  v_replacement text;
  v_count integer;
begin
  v_definition := pg_get_functiondef('public.record_employee_check_in_review(uuid,text,date,text,bigint)'::regprocedure);

  v_anchor := 'p_outcome_code not in (''on_track'', ''follow_up_required'', ''hr_review_required'')';
  v_replacement := 'p_outcome_code not in (''on_track'', ''follow_up_required'', ''hr_review_required'', ''probation_extension_pending_hr'', ''non_confirmation_pending_hr'')';
  v_count := (length(v_definition) - length(replace(v_definition, v_anchor, ''))) / length(v_anchor);
  if v_count <> 1 then raise exception 'Check-In outcome validator differs from the reviewed baseline.' using errcode = '55000'; end if;
  v_definition := replace(v_definition, v_anchor, v_replacement);

  v_anchor := '  if v_selected.due_date > v_today then';
  v_replacement := '  if p_outcome_code in (''probation_extension_pending_hr'', ''non_confirmation_pending_hr'') and v_selected.milestone <> ''6_month'' then' || chr(10) || '    raise exception ''Employment decisions requiring People & Culture approval are only available for the six-month review.'' using errcode = ''22023'';' || chr(10) || '  end if;' || chr(10) || chr(10) || v_anchor;
  v_count := (length(v_definition) - length(replace(v_definition, v_anchor, ''))) / length(v_anchor);
  if v_count <> 1 then raise exception 'Check-In due-date validation differs from the reviewed baseline.' using errcode = '55000'; end if;
  v_definition := replace(v_definition, v_anchor, v_replacement);

  v_anchor := 'if v_existing.outcome_code = ''hr_review_required''' || chr(10) || '      and p_outcome_code <> ''hr_review_required''' || chr(10) || '      and exists (';
  v_replacement := 'if v_existing.outcome_code in (''hr_review_required'', ''probation_extension_pending_hr'', ''non_confirmation_pending_hr'')' || chr(10) || '      and (' || chr(10) || '        p_outcome_code not in (''hr_review_required'', ''probation_extension_pending_hr'', ''non_confirmation_pending_hr'')' || chr(10) || '        or v_existing.review_date is distinct from p_review_date' || chr(10) || '        or v_existing.notes is distinct from v_notes' || chr(10) || '      )' || chr(10) || '      and exists (';
  v_count := (length(v_definition) - length(replace(v_definition, v_anchor, ''))) / length(v_anchor);
  if v_count <> 1 then raise exception 'People & Culture notification guard differs from the reviewed baseline.' using errcode = '55000'; end if;
  v_definition := replace(v_definition, v_anchor, v_replacement);

  v_anchor := 'v_entered_hr_review := p_outcome_code = ''hr_review_required''' || chr(10) || '        and v_existing.outcome_code <> ''hr_review_required'';';
  v_replacement := 'v_entered_hr_review := p_outcome_code in (''hr_review_required'', ''probation_extension_pending_hr'', ''non_confirmation_pending_hr'')' || chr(10) || '        and (' || chr(10) || '          v_existing.outcome_code not in (''hr_review_required'', ''probation_extension_pending_hr'', ''non_confirmation_pending_hr'')' || chr(10) || '          or (p_outcome_code is distinct from v_existing.outcome_code)' || chr(10) || '          or v_existing.people_culture_approved_version = v_existing.version' || chr(10) || '        );';
  v_count := (length(v_definition) - length(replace(v_definition, v_anchor, ''))) / length(v_anchor);
  if v_count <> 1 then raise exception 'People & Culture transition differs from the reviewed baseline.' using errcode = '55000'; end if;
  v_definition := replace(v_definition, v_anchor, v_replacement);

  v_anchor := 'set outcome_code = p_outcome_code,' || chr(10) || '          review_date = p_review_date,';
  v_replacement := 'set outcome_code = p_outcome_code,' || chr(10) || '          people_culture_approved_version = null,' || chr(10) || '          people_culture_approved_by_user_id = null,' || chr(10) || '          people_culture_approved_at = null,' || chr(10) || '          review_date = p_review_date,';
  v_count := (length(v_definition) - length(replace(v_definition, v_anchor, ''))) / length(v_anchor);
  if v_count <> 1 then raise exception 'Check-In review update differs from the reviewed baseline.' using errcode = '55000'; end if;
  v_definition := replace(v_definition, v_anchor, v_replacement);

  v_anchor := 'v_entered_hr_review := p_outcome_code = ''hr_review_required'';';
  v_replacement := 'v_entered_hr_review := p_outcome_code in (''hr_review_required'', ''probation_extension_pending_hr'', ''non_confirmation_pending_hr'');';
  v_count := (length(v_definition) - length(replace(v_definition, v_anchor, ''))) / length(v_anchor);
  if v_count <> 1 then raise exception 'People & Culture initial review differs from the reviewed baseline.' using errcode = '55000'; end if;
  v_definition := replace(v_definition, v_anchor, v_replacement);

  v_anchor := 'if v_saved.outcome_code <> ''hr_review_required'' then';
  v_replacement := 'if v_saved.outcome_code not in (''hr_review_required'', ''probation_extension_pending_hr'', ''non_confirmation_pending_hr'') then';
  v_count := (length(v_definition) - length(replace(v_definition, v_anchor, ''))) / length(v_anchor);
  if v_count <> 1 then raise exception 'People & Culture notification cleanup differs from the reviewed baseline.' using errcode = '55000'; end if;
  v_definition := replace(v_definition, v_anchor, v_replacement);

  v_anchor := 'elsif v_entered_hr_review then' || chr(10) || '    insert into private.employee_check_in_review_notifications (';
  v_replacement := 'elsif v_entered_hr_review then' || chr(10) || '    update private.employee_check_in_review_notifications notification' || chr(10) || '    set status = ''cancelled'',' || chr(10) || '        claim_token = null,' || chr(10) || '        claimed_at = null,' || chr(10) || '        updated_at = clock_timestamp()' || chr(10) || '    where notification.review_id = v_saved.id' || chr(10) || '      and notification.status in (''scheduled'', ''needs_review'');' || chr(10) || '    insert into private.employee_check_in_review_notifications (';
  v_count := (length(v_definition) - length(replace(v_definition, v_anchor, ''))) / length(v_anchor);
  if v_count <> 1 then raise exception 'People & Culture notification transition differs from the reviewed baseline.' using errcode = '55000'; end if;
  v_definition := replace(v_definition, v_anchor, v_replacement);

  execute v_definition;
end;
$$;

do $$
declare
  v_definition text;
  v_anchor text;
  v_replacement text;
  v_count integer;
begin
  v_definition := pg_get_functiondef('public.prepare_employee_check_in_review_notification_delivery(uuid,uuid)'::regprocedure);
  v_anchor := 'if not found or v_review.outcome_code <> ''hr_review_required'' then';
  v_replacement := 'if not found or v_review.outcome_code not in (''hr_review_required'', ''probation_extension_pending_hr'', ''non_confirmation_pending_hr'') then';
  v_count := (length(v_definition) - length(replace(v_definition, v_anchor, ''))) / length(v_anchor);
  if v_count <> 1 then raise exception 'People & Culture notification validation differs from the reviewed baseline.' using errcode = '55000'; end if;
  v_definition := replace(v_definition, v_anchor, v_replacement);

  v_anchor := 'v_milestone not in (''2_week'', ''1_month'', ''2_month'', ''3_month'', ''5_month'')';
  v_replacement := 'v_milestone not in (''2_week'', ''1_month'', ''2_month'', ''3_month'', ''5_month'', ''6_month'')';
  v_count := (length(v_definition) - length(replace(v_definition, v_anchor, ''))) / length(v_anchor);
  if v_count <> 1 then raise exception 'People & Culture reminder allowlist differs from the reviewed baseline.' using errcode = '55000'; end if;
  execute replace(v_definition, v_anchor, v_replacement);
end;
$$;

create function public.approve_employee_check_in_employment_decision(
  p_reminder_id uuid,
  p_expected_review_version bigint
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_reminder private.employee_check_in_reminders%rowtype;
  v_review private.employee_check_in_reviews%rowtype;
  v_today date := (clock_timestamp() at time zone 'Australia/Melbourne')::date;
begin
  if v_actor is null or coalesce(((select auth.jwt()) ->> 'is_anonymous')::boolean, false)
    or not private.is_internal_org_hr() then
    raise exception 'Only People & Culture can approve an employment decision.' using errcode = '42501';
  end if;
  if p_reminder_id is null or p_expected_review_version is null then
    raise exception 'A saved six-month review is required.' using errcode = '22004';
  end if;

  select reminder.* into v_reminder
  from private.employee_check_in_reminders reminder
  join public.internal_org_people person on person.id = reminder.person_id
  where reminder.id = p_reminder_id
    and reminder.reminder_sequence = 'initial'
    and reminder.milestone = '6_month'
    and person.node_kind = 'person'
    and person.is_active
  for update of reminder;
  if not found then
    raise exception 'The six-month review does not exist.' using errcode = '23503';
  end if;
  if v_reminder.due_date > v_today then
    raise exception 'A future six-month review cannot be approved.' using errcode = '22023';
  end if;

  select review.* into v_review
  from private.employee_check_in_reviews review
  where review.reminder_id = v_reminder.id
  for update;
  if not found or v_review.outcome_code not in ('probation_extension_pending_hr', 'non_confirmation_pending_hr') then
    raise exception 'This six-month review has no employment decision awaiting approval.' using errcode = '22023';
  end if;
  if v_review.version <> p_expected_review_version then
    raise exception 'This review changed. Refresh and try again.' using errcode = '40001';
  end if;
  if v_review.people_culture_approved_version = v_review.version then
    return;
  end if;

  update private.employee_check_in_reviews review
  set people_culture_approved_version = review.version,
      people_culture_approved_by_user_id = v_actor,
      people_culture_approved_at = clock_timestamp(),
      updated_by_user_id = v_actor,
      updated_at = clock_timestamp()
  where review.id = v_review.id
    and review.version = p_expected_review_version;
  if not found then
    raise exception 'This review changed. Refresh and try again.' using errcode = '40001';
  end if;
end;
$$;

revoke all on function public.approve_employee_check_in_employment_decision(uuid,bigint)
  from public, anon, authenticated, service_role;
grant execute on function public.approve_employee_check_in_employment_decision(uuid,bigint)
  to authenticated;

do $$
begin
  if (select count(*) <> 1
      from private.people_hub_release_flags release
      where release.feature = 'six_month_check_in_review')
    or coalesce((select release.enabled
      from private.people_hub_release_flags release
      where release.feature = 'six_month_check_in_review'), true)
    or exists (
      select 1
      from private.employee_check_in_schedule(date '2026-03-15') schedule
      where schedule.milestone = '6_month'
    ) then
    raise exception 'The 6-Month release must remain disabled until app and live workflow are ready.';
  end if;
  if to_regprocedure('public.can_approve_employee_check_in_employment_decision()') is null
    or to_regprocedure('public.approve_employee_check_in_employment_decision(uuid,bigint)') is null then
    raise exception 'People & Culture employment-decision approval is not installed.';
  end if;
end;
$$;

commit;
