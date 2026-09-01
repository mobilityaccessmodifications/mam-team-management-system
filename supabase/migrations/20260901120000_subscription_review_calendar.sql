begin;

-- Subscription reviews follow the same Monday-Friday rule as check-ins.
-- Public holidays are not inferred because the system has no approved holiday
-- calendar source. The existing helper moves Saturday/Sunday forward to Monday.
do $$
begin
  if to_regclass('private.subscription_register') is null
    or to_regprocedure('private.employee_check_in_next_business_day(date)') is null
    or to_regprocedure('private.current_active_portal_employee_id()') is null
    or to_regprocedure('private.is_system_portal_account_admin()') is null
    or to_regprocedure('private.is_active_subscription_person(uuid)') is null then
    raise exception 'Subscription review calendar prerequisites are missing.' using errcode = '55000';
  end if;
end;
$$;

create or replace function private.normalise_subscription_review_workday()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  new.next_review_on := private.employee_check_in_next_business_day(new.next_review_on);
  return new;
end;
$$;

drop trigger if exists subscription_register_normalise_review_workday
  on private.subscription_register;

create trigger subscription_register_normalise_review_workday
before insert or update of next_review_on on private.subscription_register
for each row execute function private.normalise_subscription_review_workday();

-- Bring existing review dates into the same Mon-Fri policy. The trigger above
-- keeps every future create, edit and completed-review date compliant too.
update private.subscription_register
set next_review_on = private.employee_check_in_next_business_day(next_review_on)
where extract(isodow from next_review_on)::integer in (6, 7);

comment on function private.normalise_subscription_review_workday() is
  'Normalises subscription review dates to Monday-Friday using the approved check-in workday helper.';

-- Calendar access is deliberately narrower than the subscription register.
-- System Admins see the global operational schedule; every other person can
-- only open a calendar when they are currently responsible for a live review.
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
    where subscription.subscription_status in ('active', 'paused')
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
    where subscription.subscription_status in ('active', 'paused')
    order by subscription.next_review_on, lower(subscription.service_name), subscription.id;
    return;
  end if;

  return query
  select subscription.id, subscription.service_name, subscription.next_review_on, subscription.subscription_status
  from private.subscription_register subscription
  where subscription.responsible_person_id = p_person_id
    and subscription.subscription_status in ('active', 'paused')
  order by subscription.next_review_on, lower(subscription.service_name), subscription.id;
end;
$$;

comment on function public.list_subscription_review_calendar_entries() is
  'Returns a minimal review-date projection: global for System Admins and self-only for all other active linked employees.';
comment on function public.list_subscription_review_calendar_entries_for_preview(uuid) is
  'System Admin Change Profile projection for the selected person’s review dates; it never includes price, plan, credentials or access members.';

revoke all on function private.normalise_subscription_review_workday() from public, anon, authenticated;
revoke all on function public.can_view_subscription_review_calendar() from public, anon, authenticated;
revoke all on function public.list_subscription_review_calendar_entries() from public, anon, authenticated;
revoke all on function public.can_view_subscription_review_calendar_for_preview(uuid) from public, anon, authenticated;
revoke all on function public.list_subscription_review_calendar_entries_for_preview(uuid) from public, anon, authenticated;

grant execute on function public.can_view_subscription_review_calendar() to authenticated;
grant execute on function public.list_subscription_review_calendar_entries() to authenticated;
grant execute on function public.can_view_subscription_review_calendar_for_preview(uuid) to authenticated;
grant execute on function public.list_subscription_review_calendar_entries_for_preview(uuid) to authenticated;

commit;
