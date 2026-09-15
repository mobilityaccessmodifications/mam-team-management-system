begin;

do $$
begin
  perform pg_advisory_xact_lock(
    hashtextextended('mam:payroll-balance-email-reminder:weekday-recurring:20260915', 0)
  );

  if to_regclass('private.payroll_balance_email_recipients') is null
    or to_regclass('private.payroll_balance_email_reminders') is null
    or to_regclass('private.payroll_balance_email_reminder_events') is null
    or to_regprocedure('private.payroll_balance_missing_companies(date)') is null
    or to_regprocedure('private.claim_due_payroll_balance_email_reminders_at(integer,timestamp with time zone)') is null
    or to_regprocedure('private.prepare_payroll_balance_email_reminder_delivery_at(uuid,uuid,timestamp with time zone)') is null
    or to_regprocedure('private.fail_payroll_balance_email_reminder_delivery_at(uuid,uuid,text,timestamp with time zone)') is null then
    raise exception 'Payroll balance email reminder prerequisites are missing.' using errcode = '55000';
  end if;
end;
$$;

alter table private.payroll_balance_email_reminders
  add column reminder_date date;

-- The original release allowed at most one row per month. Preserve any
-- historical row at the first Monday-to-Friday date in that month.
update private.payroll_balance_email_reminders reminder
set reminder_date = case extract(isodow from reminder.reminder_month)::integer
  when 6 then reminder.reminder_month + 2
  when 7 then reminder.reminder_month + 1
  else reminder.reminder_month
end;

alter table private.payroll_balance_email_reminders
  alter column reminder_date set not null,
  drop constraint payroll_balance_email_reminders_person_id_reminder_month_key,
  add constraint payroll_balance_email_reminders_person_day_key
    unique (person_id, reminder_date),
  add constraint payroll_balance_email_reminders_day_month_check
    check (reminder_month = date_trunc('month', reminder_date::timestamp)::date),
  add constraint payroll_balance_email_reminders_weekday_check
    check (extract(isodow from reminder_date)::integer between 1 and 5);

drop index private.payroll_balance_email_reminders_due_idx;
create index payroll_balance_email_reminders_due_idx
  on private.payroll_balance_email_reminders (reminder_date, next_attempt_at, created_at)
  where delivery_status = 'scheduled';

comment on table private.payroll_balance_email_reminders is
  'Durable, workday-scoped delivery state for recurring payroll balance email reminders. It stores no email address or workbook data.';
comment on column private.payroll_balance_email_reminders.reminder_date is
  'Australia/Melbourne Monday-to-Friday date for this one-per-workday delivery record.';
comment on table private.payroll_balance_email_reminder_events is
  'Append-only operational audit for recurring workday payroll reminder claims and outcomes; it contains no recipient address or leave values.';

create or replace function private.claim_due_payroll_balance_email_reminders_at(
  p_limit integer,
  p_now timestamptz
)
returns table (
  reminder_id uuid,
  claim_token uuid
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_today date;
  v_month date;
  v_hour integer;
  v_is_workday boolean;
begin
  if p_limit is null or p_limit not between 1 and 25 or p_now is null then
    raise exception 'Invalid payroll reminder claim request.' using errcode = '22023';
  end if;

  v_today := (p_now at time zone 'Australia/Melbourne')::date;
  v_month := date_trunc('month', v_today::timestamp)::date;
  v_hour := extract(hour from p_now at time zone 'Australia/Melbourne');
  v_is_workday := extract(isodow from v_today)::integer between 1 and 5;

  -- A timed-out provider request is safe to retry because the application and
  -- n8n receiver reuse the same delivery key for this workday row.
  with timed_out as (
    update private.payroll_balance_email_reminders reminder
    set delivery_status = 'scheduled',
        claim_token = null,
        claimed_at = null,
        next_attempt_at = p_now,
        last_delivery_error_code = 'claim_timeout',
        last_delivery_error_at = p_now,
        updated_at = p_now
    where reminder.delivery_status = 'claimed'
      and reminder.claimed_at < p_now - interval '30 minutes'
    returning reminder.id
  )
  insert into private.payroll_balance_email_reminder_events (reminder_id, event_type, error_code)
  select id, 'delivery_failed', 'claim_timeout' from timed_out;

  with overdue as (
    update private.payroll_balance_email_reminders reminder
    set delivery_status = 'needs_review',
        needs_review_reason = 'missed_delivery',
        claim_token = null,
        claimed_at = null,
        next_attempt_at = null,
        updated_at = p_now
    where reminder.delivery_status = 'scheduled'
      and reminder.reminder_date < v_today
    returning reminder.id
  )
  insert into private.payroll_balance_email_reminder_events (reminder_id, event_type, error_code)
  select id, 'needs_review', 'missed_delivery' from overdue;

  with exhausted as (
    update private.payroll_balance_email_reminders reminder
    set delivery_status = 'needs_review',
        needs_review_reason = 'retry_exhausted',
        next_attempt_at = null,
        updated_at = p_now
    where reminder.delivery_status = 'scheduled'
      and reminder.attempt_count >= 10
    returning reminder.id
  )
  insert into private.payroll_balance_email_reminder_events (reminder_id, event_type, error_code)
  select id, 'needs_review', 'retry_exhausted' from exhausted;

  -- The daily scheduler may create one row only on a Melbourne workday and
  -- only in the payroll delivery window. Public holidays are not modelled.
  if not v_is_workday or v_hour < 8 or v_hour >= 17 then
    return;
  end if;

  if cardinality(private.payroll_balance_missing_companies(v_month)) = 0 then
    with resolved as (
      update private.payroll_balance_email_reminders reminder
      set delivery_status = 'not_required',
          not_required_at = p_now,
          next_attempt_at = null,
          updated_at = p_now
      where reminder.reminder_month = v_month
        and reminder.delivery_status = 'scheduled'
      returning reminder.id
    )
    insert into private.payroll_balance_email_reminder_events (reminder_id, event_type)
    select id, 'not_required' from resolved;
    return;
  end if;

  with inserted as (
    insert into private.payroll_balance_email_reminders (
      person_id,
      reminder_month,
      reminder_date
    )
    select recipient.person_id, v_month, v_today
    from private.payroll_balance_email_recipients recipient
    where recipient.enabled
    on conflict (person_id, reminder_date) do nothing
    returning id
  )
  insert into private.payroll_balance_email_reminder_events (reminder_id, event_type)
  select id, 'scheduled' from inserted;

  -- Current directory, portal and importer authority are all revalidated. The
  -- configured person ID is stable; the email address is never snapshotted.
  with invalid_context as (
    update private.payroll_balance_email_reminders reminder
    set delivery_status = 'needs_review',
        needs_review_reason = 'context_changed',
        next_attempt_at = null,
        updated_at = p_now
    where reminder.reminder_date = v_today
      and reminder.delivery_status = 'scheduled'
      and not exists (
        select 1
        from private.payroll_balance_email_recipients recipient
        join public.internal_org_people person on person.id = recipient.person_id
        join public.profiles profile on profile.id = person.auth_user_id
        join private.payroll_balance_import_grants access_grant on access_grant.person_id = person.id
        where recipient.person_id = reminder.person_id
          and recipient.enabled
          and person.node_kind = 'person'
          and person.company_key = 'mam'
          and person.is_active
          and profile.account_status = 'active'
          and profile.login_name is not null
      )
    returning reminder.id
  )
  insert into private.payroll_balance_email_reminder_events (reminder_id, event_type, error_code)
  select id, 'needs_review', 'context_changed' from invalid_context;

  with missing_email as (
    update private.payroll_balance_email_reminders reminder
    set delivery_status = 'needs_review',
        needs_review_reason = 'missing_work_email',
        next_attempt_at = null,
        updated_at = p_now
    where reminder.reminder_date = v_today
      and reminder.delivery_status = 'scheduled'
      and not exists (
        select 1
        from private.employee_directory_details detail
        where detail.person_id = reminder.person_id
          and nullif(btrim(detail.first_name), '') is not null
          and lower(btrim(detail.work_email)) ~ '^[^[:space:]@,;]+@[^[:space:]@,;]+\.[^[:space:]@,;]+$'
      )
    returning reminder.id
  )
  insert into private.payroll_balance_email_reminder_events (reminder_id, event_type, error_code)
  select id, 'needs_review', 'missing_work_email' from missing_email;

  return query
  with candidates as (
    select reminder.id
    from private.payroll_balance_email_reminders reminder
    where reminder.reminder_date = v_today
      and reminder.delivery_status = 'scheduled'
      and (reminder.next_attempt_at is null or reminder.next_attempt_at <= p_now)
      and reminder.attempt_count < 10
    order by reminder.created_at, reminder.id
    for update of reminder skip locked
    limit p_limit
  ), claimed as (
    update private.payroll_balance_email_reminders reminder
    set delivery_status = 'claimed',
        claim_token = gen_random_uuid(),
        claimed_at = p_now,
        attempt_count = reminder.attempt_count + 1,
        next_attempt_at = null,
        last_delivery_error_code = null,
        last_delivery_error_at = null,
        updated_at = p_now
    from candidates
    where reminder.id = candidates.id
    returning reminder.id, reminder.claim_token
  ), claimed_events as (
    insert into private.payroll_balance_email_reminder_events as event (reminder_id, event_type)
    select claimed.id, 'claimed' from claimed
    returning event.reminder_id as event_reminder_id
  )
  select claimed.id, claimed.claim_token
  from claimed
  join claimed_events on claimed_events.event_reminder_id = claimed.id;
end;
$$;

create or replace function private.prepare_payroll_balance_email_reminder_delivery_at(
  p_reminder_id uuid,
  p_claim_token uuid,
  p_now timestamptz
)
returns table (
  reminder_id uuid,
  delivery_required boolean,
  recipient_name text,
  recipient_email text,
  reminder_month date,
  missing_companies text[]
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_reminder private.payroll_balance_email_reminders%rowtype;
  v_today date;
  v_hour integer;
  v_is_workday boolean;
  v_name text;
  v_email text;
  v_missing text[];
  v_context_valid boolean := false;
begin
  if p_now is null then
    return;
  end if;

  v_today := (p_now at time zone 'Australia/Melbourne')::date;
  v_hour := extract(hour from p_now at time zone 'Australia/Melbourne');
  v_is_workday := extract(isodow from v_today)::integer between 1 and 5;
  select reminder.*
  into v_reminder
  from private.payroll_balance_email_reminders reminder
  where reminder.id = p_reminder_id
    and reminder.delivery_status = 'claimed'
    and reminder.claim_token = p_claim_token
  for update;

  if not found then
    return;
  end if;

  v_missing := private.payroll_balance_missing_companies(v_reminder.reminder_month);
  if cardinality(v_missing) = 0 then
    update private.payroll_balance_email_reminders reminder
    set delivery_status = 'not_required',
        claim_token = null,
        claimed_at = null,
        not_required_at = p_now,
        updated_at = p_now
    where reminder.id = v_reminder.id;
    insert into private.payroll_balance_email_reminder_events (reminder_id, event_type)
    values (v_reminder.id, 'not_required');
    return query select v_reminder.id, false, null::text, null::text, v_reminder.reminder_month, v_missing;
    return;
  end if;

  select
    detail.first_name,
    lower(btrim(detail.work_email)),
    recipient.enabled
      and person.node_kind = 'person'
      and person.company_key = 'mam'
      and person.is_active
      and profile.account_status = 'active'
      and profile.login_name is not null
      and access_grant.person_id is not null
  into v_name, v_email, v_context_valid
  from private.payroll_balance_email_recipients recipient
  join public.internal_org_people person on person.id = recipient.person_id
  left join public.profiles profile on profile.id = person.auth_user_id
  left join private.payroll_balance_import_grants access_grant on access_grant.person_id = person.id
  left join private.employee_directory_details detail on detail.person_id = person.id
  where recipient.person_id = v_reminder.person_id;

  if v_reminder.reminder_month <> date_trunc('month', v_today::timestamp)::date
    or v_reminder.reminder_date <> v_today
    or not v_is_workday
    or v_hour < 8
    or v_hour >= 17 then
    update private.payroll_balance_email_reminders reminder
    set delivery_status = 'needs_review',
        needs_review_reason = 'missed_delivery',
        claim_token = null,
        claimed_at = null,
        updated_at = p_now
    where reminder.id = v_reminder.id;
    insert into private.payroll_balance_email_reminder_events (reminder_id, event_type, error_code)
    values (v_reminder.id, 'needs_review', 'missed_delivery');
    return;
  elsif not coalesce(v_context_valid, false) then
    update private.payroll_balance_email_reminders reminder
    set delivery_status = 'needs_review',
        needs_review_reason = 'context_changed',
        claim_token = null,
        claimed_at = null,
        updated_at = p_now
    where reminder.id = v_reminder.id;
    insert into private.payroll_balance_email_reminder_events (reminder_id, event_type, error_code)
    values (v_reminder.id, 'needs_review', 'context_changed');
    return;
  elsif nullif(btrim(v_name), '') is null
    or v_email is null
    or v_email !~ '^[^[:space:]@,;]+@[^[:space:]@,;]+\.[^[:space:]@,;]+$' then
    update private.payroll_balance_email_reminders reminder
    set delivery_status = 'needs_review',
        needs_review_reason = 'missing_work_email',
        claim_token = null,
        claimed_at = null,
        updated_at = p_now
    where reminder.id = v_reminder.id;
    insert into private.payroll_balance_email_reminder_events (reminder_id, event_type, error_code)
    values (v_reminder.id, 'needs_review', 'missing_work_email');
    return;
  end if;

  return query
  select v_reminder.id, true, v_name, v_email, v_reminder.reminder_month, v_missing;
end;
$$;

create or replace function private.fail_payroll_balance_email_reminder_delivery_at(
  p_reminder_id uuid,
  p_claim_token uuid,
  p_error_code text,
  p_now timestamptz
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_error_code text;
  v_today date;
  v_hour integer;
  v_is_workday boolean;
  v_updated boolean := false;
begin
  if p_now is null then
    return false;
  end if;
  v_today := (p_now at time zone 'Australia/Melbourne')::date;
  v_hour := extract(hour from p_now at time zone 'Australia/Melbourne');
  v_is_workday := extract(isodow from v_today)::integer between 1 and 5;
  v_error_code := case lower(coalesce(nullif(btrim(p_error_code), ''), ''))
    when 'network_error' then 'network_error'
    when 'provider_timeout' then 'provider_timeout'
    when 'provider_rejected' then 'provider_rejected'
    when 'invalid_response' then 'invalid_response'
    when 'configuration_error' then 'configuration_error'
    else 'delivery_failed'
  end;

  with failed as (
    update private.payroll_balance_email_reminders reminder
    set delivery_status = case
          when reminder.reminder_date = v_today
            and v_is_workday
            and v_hour between 8 and 16
            and reminder.attempt_count < 10
            then 'scheduled'
          else 'needs_review'
        end,
        needs_review_reason = case
          when reminder.reminder_date = v_today
            and v_is_workday
            and v_hour between 8 and 16
            and reminder.attempt_count < 10
            then null
          when reminder.attempt_count >= 10 then 'retry_exhausted'
          else 'missed_delivery'
        end,
        claim_token = null,
        claimed_at = null,
        next_attempt_at = case
          when reminder.reminder_date = v_today
            and v_is_workday
            and v_hour between 8 and 16
            and reminder.attempt_count < 10
            then p_now + interval '15 minutes'
          else null
        end,
        last_delivery_error_code = v_error_code,
        last_delivery_error_at = p_now,
        updated_at = p_now
    where reminder.id = p_reminder_id
      and reminder.delivery_status = 'claimed'
      and reminder.claim_token = p_claim_token
    returning reminder.id, reminder.delivery_status, reminder.needs_review_reason
  ), failure_event as (
    insert into private.payroll_balance_email_reminder_events (reminder_id, event_type, error_code)
    select id, 'delivery_failed', v_error_code from failed
    returning reminder_id
  ), review_event as (
    insert into private.payroll_balance_email_reminder_events (reminder_id, event_type, error_code)
    select id, 'needs_review', needs_review_reason
    from failed
    where delivery_status = 'needs_review'
    returning reminder_id
  )
  select exists (select 1 from failed) into v_updated;

  return v_updated;
end;
$$;

comment on function public.claim_due_payroll_balance_email_reminders(integer) is
  'Service-only recurring claim: one email per Melbourne Monday-to-Friday date while a current-month company snapshot remains missing.';
comment on function public.prepare_payroll_balance_email_reminder_delivery(uuid, uuid) is
  'Rechecks the current workday, outstanding company snapshots and configured importer before resolving the current HR work email.';

revoke all on function private.claim_due_payroll_balance_email_reminders_at(integer, timestamptz) from public, anon, authenticated, service_role;
revoke all on function private.prepare_payroll_balance_email_reminder_delivery_at(uuid, uuid, timestamptz) from public, anon, authenticated, service_role;
revoke all on function private.fail_payroll_balance_email_reminder_delivery_at(uuid, uuid, text, timestamptz) from public, anon, authenticated, service_role;
revoke all on function public.claim_due_payroll_balance_email_reminders(integer) from public, anon, authenticated, service_role;
revoke all on function public.prepare_payroll_balance_email_reminder_delivery(uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function public.fail_payroll_balance_email_reminder_delivery(uuid, uuid, text) from public, anon, authenticated, service_role;

grant execute on function public.claim_due_payroll_balance_email_reminders(integer) to service_role;
grant execute on function public.prepare_payroll_balance_email_reminder_delivery(uuid, uuid) to service_role;
grant execute on function public.fail_payroll_balance_email_reminder_delivery(uuid, uuid, text) to service_role;

commit;
