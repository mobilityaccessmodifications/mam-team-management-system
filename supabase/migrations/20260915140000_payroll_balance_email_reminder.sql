begin;

do $$
begin
  perform pg_advisory_xact_lock(
    hashtextextended('mam:payroll-balance-email-reminder:20260915', 0)
  );

  if to_regclass('private.payroll_balance_import_grants') is null
    or to_regclass('private.payroll_balance_imports') is null
    or to_regclass('private.employee_directory_details') is null
    or to_regprocedure('private.payroll_balance_monthly_reminder_projection()') is null
    or to_regprocedure('private.mam_local_calendar_date()') is null
    or to_regprocedure('private.normalise_payroll_employee_name(text)') is null then
    raise exception 'Payroll balance email reminder prerequisites are missing.' using errcode = '55000';
  end if;
end;
$$;

-- The named monthly recipient is configured after deployment through the
-- target-checked MAM release script. Keeping it as data avoids compiling a
-- staff name, email address or Auth identifier into the application schema.
create table private.payroll_balance_email_recipients (
  person_id uuid primary key references public.internal_org_people (id) on delete restrict,
  enabled boolean not null default true,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp()
);

comment on table private.payroll_balance_email_recipients is
  'Explicit people who receive the monthly payroll-balance upload reminder. Addresses are always resolved from the current HR directory record.';

create table private.payroll_balance_email_reminders (
  id uuid primary key default gen_random_uuid(),
  person_id uuid not null references private.payroll_balance_email_recipients (person_id) on delete restrict,
  reminder_month date not null,
  delivery_status text not null default 'scheduled'
    check (delivery_status in ('scheduled', 'claimed', 'delivered', 'not_required', 'needs_review')),
  claim_token uuid,
  claimed_at timestamptz,
  attempt_count integer not null default 0 check (attempt_count between 0 and 10),
  next_attempt_at timestamptz,
  delivered_at timestamptz,
  not_required_at timestamptz,
  needs_review_reason text
    check (needs_review_reason is null or needs_review_reason in ('context_changed', 'missing_work_email', 'missed_delivery', 'retry_exhausted')),
  provider_delivery_id text
    check (provider_delivery_id is null or provider_delivery_id ~ '^[A-Za-z0-9._:-]{1,200}$'),
  last_delivery_error_code text
    check (last_delivery_error_code is null or last_delivery_error_code in ('network_error', 'provider_timeout', 'provider_rejected', 'invalid_response', 'configuration_error', 'delivery_failed', 'claim_timeout')),
  last_delivery_error_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  unique (person_id, reminder_month),
  check (reminder_month = date_trunc('month', reminder_month::timestamp)::date),
  check ((delivery_status = 'claimed') = (claim_token is not null and claimed_at is not null)),
  check ((delivery_status = 'delivered') = (delivered_at is not null)),
  check ((delivery_status = 'not_required') = (not_required_at is not null)),
  check ((delivery_status = 'needs_review') = (needs_review_reason is not null)),
  check (delivery_status = 'delivered' or provider_delivery_id is null)
);

comment on table private.payroll_balance_email_reminders is
  'Durable, month-scoped delivery state for the first-day payroll balance email. It stores no email address or workbook data.';

create index payroll_balance_email_reminders_due_idx
  on private.payroll_balance_email_reminders (reminder_month, next_attempt_at, created_at)
  where delivery_status = 'scheduled';

create table private.payroll_balance_email_reminder_events (
  id bigint generated always as identity primary key,
  reminder_id uuid not null references private.payroll_balance_email_reminders (id) on delete restrict,
  event_type text not null check (event_type in ('scheduled', 'claimed', 'delivered', 'not_required', 'delivery_failed', 'needs_review')),
  error_code text
    check (error_code is null or error_code in ('network_error', 'provider_timeout', 'provider_rejected', 'invalid_response', 'configuration_error', 'delivery_failed', 'claim_timeout', 'context_changed', 'missing_work_email', 'missed_delivery', 'retry_exhausted')),
  created_at timestamptz not null default clock_timestamp()
);

comment on table private.payroll_balance_email_reminder_events is
  'Append-only operational audit for monthly payroll reminder claims and outcomes; it contains no recipient address or leave values.';

alter table private.payroll_balance_email_recipients enable row level security;
alter table private.payroll_balance_email_reminders enable row level security;
alter table private.payroll_balance_email_reminder_events enable row level security;

revoke all on table private.payroll_balance_email_recipients from public, anon, authenticated, service_role;
revoke all on table private.payroll_balance_email_reminders from public, anon, authenticated, service_role;
revoke all on table private.payroll_balance_email_reminder_events from public, anon, authenticated, service_role;
revoke all on sequence private.payroll_balance_email_reminder_events_id_seq from public, anon, authenticated, service_role;

create function private.payroll_balance_missing_companies(p_reminder_month date)
returns text[]
language sql
stable
security definer
set search_path = ''
as $$
  with latest as (
    select
      max(imported.as_of) filter (
        where imported.company_key = 'mam'
          and imported.match_status = 'linked'
      ) as mam_as_of,
      max(imported.as_of) filter (
        where imported.company_key = 'equipsy'
          and imported.match_status = 'linked'
      ) as equipsy_as_of
    from private.payroll_balance_imports imported
  )
  select array_remove(array[
    case when latest.mam_as_of is null or latest.mam_as_of < p_reminder_month then 'mam' end,
    case when latest.equipsy_as_of is null or latest.equipsy_as_of < p_reminder_month then 'equipsy' end
  ]::text[], null)
  from latest;
$$;

create function private.claim_due_payroll_balance_email_reminders_at(
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
begin
  if p_limit is null or p_limit not between 1 and 25 or p_now is null then
    raise exception 'Invalid payroll reminder claim request.' using errcode = '22023';
  end if;

  v_today := (p_now at time zone 'Australia/Melbourne')::date;
  v_month := date_trunc('month', v_today::timestamp)::date;
  v_hour := extract(hour from p_now at time zone 'Australia/Melbourne');

  -- A timed-out provider request is safe to retry because the application and
  -- n8n receiver reuse the same month-scoped event key.
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
      and reminder.reminder_month < v_today
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

  -- There is deliberately no mid-month catch-up. The daily n8n scheduler may
  -- claim this work only on the first Melbourne calendar day of the month.
  if extract(day from v_today) <> 1 or v_hour < 8 or v_hour >= 17 then
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
    insert into private.payroll_balance_email_reminders (person_id, reminder_month)
    select recipient.person_id, v_month
    from private.payroll_balance_email_recipients recipient
    where recipient.enabled
    on conflict (person_id, reminder_month) do nothing
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
    where reminder.reminder_month = v_month
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
    where reminder.reminder_month = v_month
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
    where reminder.reminder_month = v_month
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

create function public.claim_due_payroll_balance_email_reminders(p_limit integer default 10)
returns table (
  reminder_id uuid,
  claim_token uuid
)
language sql
volatile
security definer
set search_path = ''
as $$
  select *
  from private.claim_due_payroll_balance_email_reminders_at(p_limit, clock_timestamp());
$$;

create function private.prepare_payroll_balance_email_reminder_delivery_at(
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
    or extract(day from v_today) <> 1
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

create function public.prepare_payroll_balance_email_reminder_delivery(
  p_reminder_id uuid,
  p_claim_token uuid
)
returns table (
  reminder_id uuid,
  delivery_required boolean,
  recipient_name text,
  recipient_email text,
  reminder_month date,
  missing_companies text[]
)
language sql
volatile
security definer
set search_path = ''
as $$
  select *
  from private.prepare_payroll_balance_email_reminder_delivery_at(
    p_reminder_id,
    p_claim_token,
    clock_timestamp()
  );
$$;

create function public.complete_payroll_balance_email_reminder_delivery(
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
    update private.payroll_balance_email_reminders reminder
    set delivery_status = 'delivered',
        claim_token = null,
        claimed_at = null,
        delivered_at = clock_timestamp(),
        provider_delivery_id = case
          when p_provider_delivery_id ~ '^[A-Za-z0-9._:-]{1,200}$' then p_provider_delivery_id
          else null
        end,
        updated_at = clock_timestamp()
    where reminder.id = p_reminder_id
      and reminder.delivery_status = 'claimed'
      and reminder.claim_token = p_claim_token
    returning reminder.id
  ), event_inserted as (
    insert into private.payroll_balance_email_reminder_events (reminder_id, event_type)
    select id, 'delivered' from delivered
    returning reminder_id
  )
  select exists (select 1 from delivered) into v_updated;

  return v_updated;
end;
$$;

create function private.fail_payroll_balance_email_reminder_delivery_at(
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
  v_updated boolean := false;
begin
  if p_now is null then
    return false;
  end if;
  v_today := (p_now at time zone 'Australia/Melbourne')::date;
  v_hour := extract(hour from p_now at time zone 'Australia/Melbourne');
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
          when reminder.reminder_month = v_today and extract(day from v_today) = 1 and v_hour between 8 and 16 and reminder.attempt_count < 10
            then 'scheduled'
          else 'needs_review'
        end,
        needs_review_reason = case
          when reminder.reminder_month = v_today and extract(day from v_today) = 1 and v_hour between 8 and 16 and reminder.attempt_count < 10
            then null
          when reminder.attempt_count >= 10 then 'retry_exhausted'
          else 'missed_delivery'
        end,
        claim_token = null,
        claimed_at = null,
        next_attempt_at = case
          when reminder.reminder_month = v_today and extract(day from v_today) = 1 and v_hour between 8 and 16 and reminder.attempt_count < 10
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

create function public.fail_payroll_balance_email_reminder_delivery(
  p_reminder_id uuid,
  p_claim_token uuid,
  p_error_code text
)
returns boolean
language sql
volatile
security definer
set search_path = ''
as $$
  select private.fail_payroll_balance_email_reminder_delivery_at(
    p_reminder_id,
    p_claim_token,
    p_error_code,
    clock_timestamp()
  );
$$;

comment on function public.claim_due_payroll_balance_email_reminders(integer) is
  'Service-only first-of-month claim. It schedules no catch-up and omits mail after both company snapshots are current.';
comment on function public.prepare_payroll_balance_email_reminder_delivery(uuid, uuid) is
  'Revalidates the configured active importer and resolves the current HR work email immediately before n8n delivery.';

revoke all on function private.payroll_balance_missing_companies(date) from public, anon, authenticated, service_role;
revoke all on function private.claim_due_payroll_balance_email_reminders_at(integer, timestamptz) from public, anon, authenticated, service_role;
revoke all on function private.prepare_payroll_balance_email_reminder_delivery_at(uuid, uuid, timestamptz) from public, anon, authenticated, service_role;
revoke all on function private.fail_payroll_balance_email_reminder_delivery_at(uuid, uuid, text, timestamptz) from public, anon, authenticated, service_role;
revoke all on function public.claim_due_payroll_balance_email_reminders(integer) from public, anon, authenticated, service_role;
revoke all on function public.prepare_payroll_balance_email_reminder_delivery(uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function public.complete_payroll_balance_email_reminder_delivery(uuid, uuid, text) from public, anon, authenticated, service_role;
revoke all on function public.fail_payroll_balance_email_reminder_delivery(uuid, uuid, text) from public, anon, authenticated, service_role;

grant execute on function public.claim_due_payroll_balance_email_reminders(integer) to service_role;
grant execute on function public.prepare_payroll_balance_email_reminder_delivery(uuid, uuid) to service_role;
grant execute on function public.complete_payroll_balance_email_reminder_delivery(uuid, uuid, text) to service_role;
grant execute on function public.fail_payroll_balance_email_reminder_delivery(uuid, uuid, text) to service_role;

commit;
