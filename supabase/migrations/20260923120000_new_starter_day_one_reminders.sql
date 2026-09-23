begin;

do $$
begin
  if to_regclass('public.internal_org_people') is null
    or to_regclass('private.employee_directory_details') is null
    or to_regprocedure('private.victorian_business_days_before(date,integer)') is null
    or to_regprocedure('private.notification_event_key_valid(text)') is null then
    raise exception 'New starter reminder prerequisites are missing';
  end if;
end;
$$;

-- Test and live sends have separate keys, so a test delivery can never consume
-- the future live delivery receipt for the same reminder.
create or replace function private.notification_event_key_valid(p_key text)
returns boolean language sql immutable set search_path = '' as $$
  select coalesce(length(p_key) <= 160 and p_key ~ (
    '^(leave:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:' ||
    '(leave-submitted|leave-approved|leave-declined|leave-cancelled|leave-conditionally-approved|leave-reminder|team-birthday):[0-9a-f]{24}' ||
    '|payroll-balance:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:[0-9]{4}-(0[1-9]|1[0-2])' ||
    '|payroll-comparison:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' ||
    '|new-starter:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:day-one:(test|live))$'
  ), false)
$$;

create table private.employee_new_starter_day_one_reminders (
  id uuid primary key default gen_random_uuid(),
  person_id uuid not null references public.internal_org_people(id) on delete cascade,
  commencement_date date not null,
  notify_date date not null,
  status text not null default 'scheduled'
    check (status in ('scheduled','claimed','delivered','needs_review','superseded','cancelled')),
  review_reason text
    check (review_reason is null or review_reason in (
      'missing_employee_email','missing_manager','missing_manager_email',
      'missed_delivery','retry_exhausted','context_changed'
    )),
  failure_count integer not null default 0 check (failure_count between 0 and 8),
  next_attempt_at timestamptz not null default clock_timestamp(),
  claim_token uuid,
  claim_expires_at timestamptz,
  delivered_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  constraint employee_new_starter_day_one_dates check (notify_date < commencement_date),
  constraint employee_new_starter_day_one_claim_shape check (
    (status = 'claimed' and claim_token is not null and claim_expires_at is not null)
    or (status <> 'claimed' and claim_token is null and claim_expires_at is null)
  ),
  constraint employee_new_starter_day_one_review_shape check (
    (status = 'needs_review' and review_reason is not null)
    or (status <> 'needs_review' and review_reason is null)
  ),
  constraint employee_new_starter_day_one_delivery_shape check (
    (status = 'delivered' and delivered_at is not null)
    or (status <> 'delivered' and delivered_at is null)
  )
);

create unique index employee_new_starter_day_one_open_person_idx
  on private.employee_new_starter_day_one_reminders(person_id)
  where status in ('scheduled','claimed','needs_review');
create unique index employee_new_starter_day_one_delivered_date_idx
  on private.employee_new_starter_day_one_reminders(person_id, commencement_date)
  where status = 'delivered';
create index employee_new_starter_day_one_due_idx
  on private.employee_new_starter_day_one_reminders(notify_date, next_attempt_at)
  where status = 'scheduled';

create table private.employee_new_starter_day_one_events (
  id bigint generated always as identity primary key,
  reminder_id uuid not null references private.employee_new_starter_day_one_reminders(id) on delete cascade,
  event_type text not null check (event_type in (
    'scheduled','rescheduled','claimed','delivered','retry_scheduled','needs_review','cancelled'
  )),
  code text check (code is null or code in (
    'missing_employee_email','missing_manager','missing_manager_email',
    'missed_delivery','retry_exhausted','context_changed',
    'network_error','provider_timeout','provider_rejected','invalid_response','configuration_error'
  )),
  created_at timestamptz not null default clock_timestamp()
);
create index employee_new_starter_day_one_events_reminder_idx
  on private.employee_new_starter_day_one_events(reminder_id, created_at desc);

alter table private.employee_new_starter_day_one_reminders enable row level security;
alter table private.employee_new_starter_day_one_reminders force row level security;
alter table private.employee_new_starter_day_one_events enable row level security;
alter table private.employee_new_starter_day_one_events force row level security;
revoke all on table private.employee_new_starter_day_one_reminders,
  private.employee_new_starter_day_one_events from public, anon, authenticated, service_role;
revoke all on sequence private.employee_new_starter_day_one_events_id_seq
  from public, anon, authenticated, service_role;

create function private.employee_new_starter_day_one_context(p_person_id uuid)
returns table (
  person_id uuid,
  employee_active boolean,
  employee_first_name text,
  employee_work_email text,
  employee_personal_email text,
  role text,
  company_key text,
  manager_id uuid,
  manager_active boolean,
  manager_first_name text,
  manager_email text,
  commencement_date date
)
language sql stable security definer set search_path = '' as $$
  select person.id,
    person.is_active,
    detail.first_name,
    lower(nullif(btrim(detail.work_email),'')),
    lower(nullif(btrim(detail.personal_email),'')),
    person.position_title,
    person.company_key,
    manager.id,
    coalesce(manager.is_active,false),
    coalesce(manager_detail.first_name,split_part(manager.full_name,' ',1)),
    lower(nullif(btrim(manager_detail.work_email),'')),
    person.started_date
  from public.internal_org_people person
  left join private.employee_directory_details detail on detail.person_id = person.id
  left join public.internal_org_people manager
    on manager.id = person.parent_id and manager.node_kind = 'person'
  left join private.employee_directory_details manager_detail on manager_detail.person_id = manager.id
  where person.id = p_person_id and person.node_kind = 'person'
$$;

create function private.sync_employee_new_starter_day_one_reminder(
  p_person_id uuid,
  p_now timestamptz default clock_timestamp()
) returns void language plpgsql volatile security definer set search_path = '' as $$
declare
  context record;
  today date := timezone('Australia/Melbourne',p_now)::date;
  notification_date date;
  reason text;
  current_id uuid;
  changed_id uuid;
  was_new boolean := false;
begin
  select * into context from private.employee_new_starter_day_one_context(p_person_id);
  if not found or context.employee_active is distinct from true
    or context.commencement_date is null or context.commencement_date <= today then
    update private.employee_new_starter_day_one_reminders
      set status='cancelled',review_reason=null,claim_token=null,claim_expires_at=null,
        updated_at=p_now
      where person_id=p_person_id and status in ('scheduled','claimed','needs_review')
      returning id into changed_id;
    if changed_id is not null then
      insert into private.employee_new_starter_day_one_events(reminder_id,event_type)
        values(changed_id,'cancelled');
    end if;
    return;
  end if;

  notification_date := private.victorian_business_days_before(context.commencement_date,1);
  if context.employee_work_email is null and context.employee_personal_email is null then
    reason := 'missing_employee_email';
  elsif context.manager_id is null or context.manager_active is distinct from true then
    reason := 'missing_manager';
  elsif context.manager_email is null then
    reason := 'missing_manager_email';
  end if;

  if exists (
    select 1 from private.employee_new_starter_day_one_reminders
    where person_id=p_person_id and commencement_date=context.commencement_date and status='delivered'
  ) then
    update private.employee_new_starter_day_one_reminders
      set status='superseded',review_reason=null,claim_token=null,claim_expires_at=null,updated_at=p_now
      where person_id=p_person_id and status in ('scheduled','claimed','needs_review');
    return;
  end if;

  select id into current_id
  from private.employee_new_starter_day_one_reminders
  where person_id=p_person_id and status in ('scheduled','claimed','needs_review')
  for update;

  if current_id is null then
    insert into private.employee_new_starter_day_one_reminders(
      person_id,commencement_date,notify_date,status,review_reason,next_attempt_at,updated_at
    ) values (
      p_person_id,context.commencement_date,notification_date,
      case when reason is null then 'scheduled' else 'needs_review' end,
      reason,p_now,p_now
    ) returning id into current_id;
    was_new := true;
  else
    update private.employee_new_starter_day_one_reminders
      set commencement_date=context.commencement_date,
        notify_date=notification_date,
        status=case when reason is null then 'scheduled' else 'needs_review' end,
        review_reason=reason,
        failure_count=0,
        next_attempt_at=p_now,
        claim_token=null,
        claim_expires_at=null,
        delivered_at=null,
        updated_at=p_now
      where id=current_id;
  end if;

  insert into private.employee_new_starter_day_one_events(reminder_id,event_type,code)
    values(current_id,
      case when reason is not null then 'needs_review'
        when was_new then 'scheduled' else 'rescheduled' end,
      reason);
end;
$$;

create function private.sync_new_starter_after_person_change()
returns trigger language plpgsql volatile security definer set search_path = '' as $$
declare child_id uuid;
begin
  if new.node_kind = 'person' then
    perform private.sync_employee_new_starter_day_one_reminder(new.id);
  end if;
  if new.node_kind = 'person' then
    for child_id in
      select child.id from public.internal_org_people child
      where child.node_kind='person' and child.parent_id=new.id
    loop
      perform private.sync_employee_new_starter_day_one_reminder(child_id);
    end loop;
  end if;
  return new;
end;
$$;

create function private.sync_new_starter_after_detail_change()
returns trigger language plpgsql volatile security definer set search_path = '' as $$
declare child_id uuid;
begin
  perform private.sync_employee_new_starter_day_one_reminder(new.person_id);
  for child_id in
    select child.id from public.internal_org_people child
    where child.node_kind='person' and child.parent_id=new.person_id
  loop
    perform private.sync_employee_new_starter_day_one_reminder(child_id);
  end loop;
  return new;
end;
$$;

create trigger sync_new_starter_after_person_change
after insert or update of full_name,position_title,company_key,parent_id,started_date,is_active
on public.internal_org_people for each row
execute function private.sync_new_starter_after_person_change();

create trigger sync_new_starter_after_detail_change
after insert or update of first_name,work_email,personal_email
on private.employee_directory_details for each row
execute function private.sync_new_starter_after_detail_change();

create function public.claim_due_new_starter_day_one_reminders(p_limit integer default 10)
returns table(reminder_id uuid,claim_token uuid)
language plpgsql volatile security definer set search_path = '' as $$
declare
  now_value timestamptz := clock_timestamp();
  today date := timezone('Australia/Melbourne',now_value)::date;
begin
  if p_limit is null or p_limit < 1 or p_limit > 25 then
    raise exception 'Invalid reminder claim limit' using errcode='22023';
  end if;

  update private.employee_new_starter_day_one_reminders reminder
    set status=case when reminder.commencement_date > today and reminder.failure_count < 8
      then 'scheduled' else 'needs_review' end,
      review_reason=case when reminder.commencement_date > today and reminder.failure_count < 8
        then null when reminder.failure_count >= 8 then 'retry_exhausted' else 'missed_delivery' end,
      claim_token=null,claim_expires_at=null,next_attempt_at=now_value,updated_at=now_value
    where reminder.status='claimed' and reminder.claim_expires_at <= now_value;

  return query
  with candidates as (
    select reminder.id
    from private.employee_new_starter_day_one_reminders reminder
    where reminder.status='scheduled'
      and reminder.notify_date <= today
      and reminder.commencement_date > today
      and reminder.next_attempt_at <= now_value
    order by reminder.notify_date,reminder.created_at
    limit p_limit
    for update skip locked
  ), claimed as (
    update private.employee_new_starter_day_one_reminders reminder
      set status='claimed',claim_token=gen_random_uuid(),
        claim_expires_at=now_value + interval '10 minutes',updated_at=now_value
      from candidates where reminder.id=candidates.id
      returning reminder.id,reminder.claim_token
  )
  select claimed.id,claimed.claim_token from claimed;

  insert into private.employee_new_starter_day_one_events(reminder_id,event_type)
    select reminder.id,'claimed'
    from private.employee_new_starter_day_one_reminders reminder
    where reminder.status='claimed' and reminder.updated_at=now_value;
end;
$$;

create function public.prepare_new_starter_day_one_delivery(
  p_reminder_id uuid,
  p_claim_token uuid
) returns table(
  reminder_id uuid,
  employee_first_name text,
  employee_work_email text,
  employee_personal_email text,
  role text,
  company_key text,
  manager_first_name text,
  manager_email text,
  commencement_date date,
  notify_date date
)
language plpgsql volatile security definer set search_path = '' as $$
declare
  now_value timestamptz := clock_timestamp();
  today date := timezone('Australia/Melbourne',now_value)::date;
  reminder private.employee_new_starter_day_one_reminders%rowtype;
  context record;
  reason text;
begin
  select * into reminder from private.employee_new_starter_day_one_reminders
    where id=p_reminder_id for update;
  if not found or reminder.status <> 'claimed' or reminder.claim_token is distinct from p_claim_token
    or reminder.claim_expires_at <= now_value then return; end if;

  select * into context from private.employee_new_starter_day_one_context(reminder.person_id);
  if not found or context.employee_active is distinct from true
    or context.commencement_date is distinct from reminder.commencement_date then
    reason := 'context_changed';
  elsif context.commencement_date <= today then
    reason := 'missed_delivery';
  elsif context.employee_work_email is null and context.employee_personal_email is null then
    reason := 'missing_employee_email';
  elsif context.manager_id is null or context.manager_active is distinct from true then
    reason := 'missing_manager';
  elsif context.manager_email is null then
    reason := 'missing_manager_email';
  end if;

  if reason is not null then
    update private.employee_new_starter_day_one_reminders
      set status='needs_review',review_reason=reason,claim_token=null,claim_expires_at=null,updated_at=now_value
      where id=reminder.id;
    insert into private.employee_new_starter_day_one_events(reminder_id,event_type,code)
      values(reminder.id,'needs_review',reason);
    return;
  end if;

  return query select reminder.id,context.employee_first_name,context.employee_work_email,
    context.employee_personal_email,context.role,context.company_key,
    context.manager_first_name,context.manager_email,
    reminder.commencement_date,reminder.notify_date;
end;
$$;

create function public.complete_new_starter_day_one_delivery(
  p_reminder_id uuid,
  p_claim_token uuid
) returns boolean language plpgsql volatile security definer set search_path = '' as $$
declare changed boolean;
begin
  update private.employee_new_starter_day_one_reminders
    set status='delivered',review_reason=null,claim_token=null,claim_expires_at=null,
      delivered_at=clock_timestamp(),updated_at=clock_timestamp()
    where id=p_reminder_id and status='claimed' and claim_token=p_claim_token;
  changed := found;
  if changed then
    insert into private.employee_new_starter_day_one_events(reminder_id,event_type)
      values(p_reminder_id,'delivered');
  end if;
  return changed;
end;
$$;

create function public.fail_new_starter_day_one_delivery(
  p_reminder_id uuid,
  p_claim_token uuid,
  p_error_code text
) returns boolean language plpgsql volatile security definer set search_path = '' as $$
declare
  now_value timestamptz := clock_timestamp();
  today date := timezone('Australia/Melbourne',now_value)::date;
  reminder private.employee_new_starter_day_one_reminders%rowtype;
  next_failures integer;
  next_status text;
  next_reason text;
begin
  if p_error_code not in ('network_error','provider_timeout','provider_rejected','invalid_response','configuration_error') then
    raise exception 'Invalid delivery error code' using errcode='22023';
  end if;
  select * into reminder from private.employee_new_starter_day_one_reminders
    where id=p_reminder_id and status='claimed' and claim_token=p_claim_token for update;
  if not found then return false; end if;
  next_failures := reminder.failure_count + 1;
  if next_failures >= 8 then
    next_status := 'needs_review'; next_reason := 'retry_exhausted';
  elsif reminder.commencement_date <= today then
    next_status := 'needs_review'; next_reason := 'missed_delivery';
  else
    next_status := 'scheduled'; next_reason := null;
  end if;
  update private.employee_new_starter_day_one_reminders
    set status=next_status,review_reason=next_reason,failure_count=next_failures,
      next_attempt_at=now_value + make_interval(mins => least(360,5 * (2 ^ least(next_failures,6))::integer)),
      claim_token=null,claim_expires_at=null,updated_at=now_value
    where id=reminder.id;
  insert into private.employee_new_starter_day_one_events(reminder_id,event_type,code)
    values(reminder.id,case when next_status='scheduled' then 'retry_scheduled' else 'needs_review' end,
      case when next_status='scheduled' then p_error_code else next_reason end);
  return true;
end;
$$;

-- Schedule only active future starters at release. Historic employees are not
-- replayed, and same-day records are left for HR review rather than emailed late.
do $$
declare person_id uuid;
begin
  for person_id in
    select person.id from public.internal_org_people person
    where person.node_kind='person' and person.is_active
      and person.started_date > timezone('Australia/Melbourne',clock_timestamp())::date
  loop
    perform private.sync_employee_new_starter_day_one_reminder(person_id);
  end loop;
end;
$$;

revoke all on function private.employee_new_starter_day_one_context(uuid),
  private.sync_employee_new_starter_day_one_reminder(uuid,timestamptz),
  private.sync_new_starter_after_person_change(),
  private.sync_new_starter_after_detail_change(),
  public.claim_due_new_starter_day_one_reminders(integer),
  public.prepare_new_starter_day_one_delivery(uuid,uuid),
  public.complete_new_starter_day_one_delivery(uuid,uuid),
  public.fail_new_starter_day_one_delivery(uuid,uuid,text)
  from public,anon,authenticated,service_role;
grant usage on schema private to service_role;
grant execute on function public.claim_due_new_starter_day_one_reminders(integer),
  public.prepare_new_starter_day_one_delivery(uuid,uuid),
  public.complete_new_starter_day_one_delivery(uuid,uuid),
  public.fail_new_starter_day_one_delivery(uuid,uuid,text)
  to service_role;

comment on table private.employee_new_starter_day_one_reminders is
  'Durable one-business-day-before Day 1 email schedule. Recipient addresses are resolved only at claimed delivery time.';
comment on table private.employee_new_starter_day_one_events is
  'Minimal operational audit for Day 1 reminder scheduling and retries; contains no email address or message body.';

commit;
