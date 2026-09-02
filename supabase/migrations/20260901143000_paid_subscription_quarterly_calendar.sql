begin;

-- Paid subscriptions are reviewed together on the first weekday of the next
-- calendar quarter. This intentionally does not use service import dates or
-- subscription start dates: the approved operating rule is one shared
-- quarterly review cycle for every paid service.
do $$
begin
  if to_regclass('private.subscription_register') is null
    or to_regclass('private.subscription_audit_events') is null
    or to_regprocedure('private.employee_check_in_next_business_day(date)') is null
    or to_regprocedure('private.is_system_portal_account_admin()') is null
    or to_regprocedure('private.current_active_portal_employee_id()') is null
    or to_regprocedure('private.is_active_subscription_person(uuid)') is null then
    raise exception 'Paid subscription quarterly review prerequisites are missing.' using errcode = '55000';
  end if;
end;
$$;

create or replace function private.mam_local_calendar_date()
returns date
language sql
volatile
security definer
set search_path = ''
as $$
  select (clock_timestamp() at time zone 'Australia/Melbourne')::date;
$$;

comment on function private.mam_local_calendar_date() is
  'Returns the current Australia/Melbourne date for date-sensitive People System schedules.';

create or replace function private.next_paid_subscription_quarter_review_on(
  p_reference_date date default private.mam_local_calendar_date()
)
returns date
language sql
volatile
security definer
set search_path = ''
as $$
  select private.employee_check_in_next_business_day(
    (
      date_trunc('quarter', coalesce(p_reference_date, private.mam_local_calendar_date())::timestamp)::date
      + interval '3 months'
    )::date
  );
$$;

comment on function private.next_paid_subscription_quarter_review_on(date) is
  'Returns the first Monday-Friday date of the next calendar quarter for the shared paid-subscription review cycle.';

-- Keep the legacy public RPC signatures stable while enforcing the paid
-- subscription scheduling invariant for both new records and status/model
-- changes. Normal edits to an already-live paid subscription leave its due
-- date intact.
create or replace function private.schedule_paid_subscription_quarterly_review()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.pricing_model = 'paid'
    and new.subscription_status in ('active', 'paused')
    and (
      tg_op = 'INSERT'
      or old.pricing_model is distinct from new.pricing_model
      or old.subscription_status is distinct from new.subscription_status
    ) then
    new.next_review_on := private.next_paid_subscription_quarter_review_on();
  end if;
  return new;
end;
$$;

drop trigger if exists a_subscription_register_schedule_paid_quarterly_review
  on private.subscription_register;

create trigger a_subscription_register_schedule_paid_quarterly_review
before insert or update of pricing_model, subscription_status on private.subscription_register
for each row execute function private.schedule_paid_subscription_quarterly_review();

-- Reset every currently live paid record to the shared next-quarter cycle.
-- The version/audit records make this operating-rule correction traceable.
with updated as (
  update private.subscription_register subscription
  set next_review_on = private.next_paid_subscription_quarter_review_on()
  where subscription.pricing_model = 'paid'
    and subscription.subscription_status in ('active', 'paused')
  returning subscription.id
)
insert into private.subscription_audit_events (
  subscription_id,
  actor_user_id,
  event_type,
  changed_fields
)
select
  updated.id,
  null,
  'updated',
  array['next_review_on']::text[]
from updated;

create or replace function public.mark_subscription_reviewed(
  p_subscription_id uuid,
  p_expected_version bigint
)
returns table (
  subscription_id uuid,
  subscription_code text,
  service_name text,
  plan_name text,
  subscription_status text,
  pricing_model text,
  billing_cycle text,
  amount_cents integer,
  currency_code text,
  renewal_date date,
  next_review_on date,
  responsible_person_id uuid,
  responsible_person_name text,
  responsible_person_title text,
  member_person_ids uuid[],
  member_names text[],
  created_at timestamptz,
  version bigint
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor_user_id uuid := (select auth.uid());
  v_subscription private.subscription_register%rowtype;
begin
  if v_actor_user_id is null
    or not private.is_system_portal_account_admin() then
    raise exception 'You do not have permission to review subscriptions.' using errcode = '42501';
  end if;
  if p_subscription_id is null or p_expected_version is null or p_expected_version < 1 then
    raise exception 'The subscription record is invalid.' using errcode = '22023';
  end if;

  select subscription.* into v_subscription
  from private.subscription_register subscription
  where subscription.id = p_subscription_id
  for update;

  if not found then
    raise exception 'This subscription is no longer available.' using errcode = 'P0002';
  end if;
  if v_subscription.version <> p_expected_version then
    raise exception 'This subscription has changed. Refresh it, then try again.' using errcode = '40001';
  end if;
  if v_subscription.subscription_status not in ('active', 'paused')
    or v_subscription.pricing_model <> 'paid' then
    raise exception 'Only active paid subscriptions need a quarterly review.' using errcode = '22023';
  end if;

  update private.subscription_register subscription
  set next_review_on = private.next_paid_subscription_quarter_review_on(
        greatest(
          private.mam_local_calendar_date(),
          coalesce(v_subscription.next_review_on, private.mam_local_calendar_date())
        )
      ),
      updated_by = v_actor_user_id
  where subscription.id = v_subscription.id
  returning * into v_subscription;

  insert into private.subscription_audit_events (
    subscription_id,
    actor_user_id,
    event_type,
    changed_fields
  )
  values (
    v_subscription.id,
    v_actor_user_id,
    'reviewed',
    array['next_review_on']::text[]
  );

  return query
  select projection.*
  from private.subscription_register_projection() as projection
  where projection.subscription_id = v_subscription.id;
end;
$$;

create or replace function public.can_view_subscription_review_calendar()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.is_system_portal_account_admin()
    or exists (
      select 1
      from private.subscription_register subscription
      where subscription.responsible_person_id = private.current_active_portal_employee_id()
        and subscription.pricing_model = 'paid'
        and subscription.subscription_status in ('active', 'paused')
    );
$$;

create or replace function public.list_subscription_review_calendar_entries()
returns table (
  subscription_id uuid,
  service_name text,
  due_date date,
  status text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_person_id uuid := private.current_active_portal_employee_id();
begin
  if private.is_system_portal_account_admin() then
    return query
    select subscription.id, subscription.service_name, subscription.next_review_on, subscription.subscription_status
    from private.subscription_register subscription
    where subscription.pricing_model = 'paid'
      and subscription.subscription_status in ('active', 'paused')
    order by subscription.next_review_on, lower(subscription.service_name), subscription.id;
    return;
  end if;

  if v_person_id is null then
    return;
  end if;

  return query
  select subscription.id, subscription.service_name, subscription.next_review_on, subscription.subscription_status
  from private.subscription_register subscription
  where subscription.responsible_person_id = v_person_id
    and subscription.pricing_model = 'paid'
    and subscription.subscription_status in ('active', 'paused')
  order by subscription.next_review_on, lower(subscription.service_name), subscription.id;
end;
$$;

create or replace function public.can_view_subscription_review_calendar_for_preview(
  p_person_id uuid
)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not private.is_system_portal_account_admin() then
    raise exception 'Only a System Admin can preview subscription review calendars.' using errcode = '42501';
  end if;
  if p_person_id is null or not private.is_active_subscription_person(p_person_id) then
    raise exception 'The selected employee profile is unavailable.' using errcode = '23503';
  end if;

  if exists (
    select 1
    from public.internal_org_people person
    join public.profiles profile on profile.id = person.auth_user_id
    where person.id = p_person_id
      and person.node_kind = 'person'
      and person.is_active
      and profile.app_role = 'system_admin'
      and profile.account_status = 'active'
      and profile.login_name is not null
  ) then
    return true;
  end if;

  return exists (
    select 1
    from private.subscription_register subscription
    where subscription.responsible_person_id = p_person_id
      and subscription.pricing_model = 'paid'
      and subscription.subscription_status in ('active', 'paused')
  );
end;
$$;

create or replace function public.list_subscription_review_calendar_entries_for_preview(
  p_person_id uuid
)
returns table (
  subscription_id uuid,
  service_name text,
  due_date date,
  status text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_target_is_system_admin boolean := false;
begin
  if not private.is_system_portal_account_admin() then
    raise exception 'Only a System Admin can preview subscription review calendars.' using errcode = '42501';
  end if;
  if p_person_id is null or not private.is_active_subscription_person(p_person_id) then
    raise exception 'The selected employee profile is unavailable.' using errcode = '23503';
  end if;

  select exists (
    select 1
    from public.internal_org_people person
    join public.profiles profile on profile.id = person.auth_user_id
    where person.id = p_person_id
      and person.node_kind = 'person'
      and person.is_active
      and profile.app_role = 'system_admin'
      and profile.account_status = 'active'
      and profile.login_name is not null
  ) into v_target_is_system_admin;

  if v_target_is_system_admin then
    return query
    select subscription.id, subscription.service_name, subscription.next_review_on, subscription.subscription_status
    from private.subscription_register subscription
    where subscription.pricing_model = 'paid'
      and subscription.subscription_status in ('active', 'paused')
    order by subscription.next_review_on, lower(subscription.service_name), subscription.id;
    return;
  end if;

  return query
  select subscription.id, subscription.service_name, subscription.next_review_on, subscription.subscription_status
  from private.subscription_register subscription
  where subscription.responsible_person_id = p_person_id
    and subscription.pricing_model = 'paid'
    and subscription.subscription_status in ('active', 'paused')
  order by subscription.next_review_on, lower(subscription.service_name), subscription.id;
end;
$$;

comment on function public.list_subscription_review_calendar_entries() is
  'Returns paid quarterly-review entries only: global for System Admins and owner-only for other active linked employees.';
comment on function public.list_subscription_review_calendar_entries_for_preview(uuid) is
  'System Admin Change Profile projection for the selected employee’s paid quarterly subscription-review entries.';

revoke all on function private.mam_local_calendar_date() from public, anon, authenticated;
revoke all on function private.next_paid_subscription_quarter_review_on(date) from public, anon, authenticated;
revoke all on function private.schedule_paid_subscription_quarterly_review() from public, anon, authenticated;
revoke all on function public.mark_subscription_reviewed(uuid, bigint) from public, anon, authenticated;
revoke all on function public.can_view_subscription_review_calendar() from public, anon, authenticated;
revoke all on function public.list_subscription_review_calendar_entries() from public, anon, authenticated;
revoke all on function public.can_view_subscription_review_calendar_for_preview(uuid) from public, anon, authenticated;
revoke all on function public.list_subscription_review_calendar_entries_for_preview(uuid) from public, anon, authenticated;

grant execute on function public.mark_subscription_reviewed(uuid, bigint) to authenticated;
grant execute on function public.can_view_subscription_review_calendar() to authenticated;
grant execute on function public.list_subscription_review_calendar_entries() to authenticated;
grant execute on function public.can_view_subscription_review_calendar_for_preview(uuid) to authenticated;
grant execute on function public.list_subscription_review_calendar_entries_for_preview(uuid) to authenticated;

commit;
