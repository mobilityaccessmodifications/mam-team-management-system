begin;
set local search_path = '';
select pg_advisory_xact_lock(hashtextextended('mam:directory-role-control', 0));
lock table private.confirmed_test_identity_purges, private.confirmed_test_purge_schema,
  public.internal_org_people, private.employee_directory_details, private.subscription_register,
  private.subscription_memberships in share row exclusive mode nowait;
do $$
begin
  if (select count(*) from private.confirmed_test_purge_schema) <> 1
    or private.confirmed_test_purge_schema_hash() is distinct from
      (select schema_hash from private.confirmed_test_purge_schema where singleton)
    or to_regprocedure('private.lock_subscription_role_authority(boolean)') is null
    or to_regprocedure('public.get_portal_role_capabilities(uuid)') is null
    or to_regprocedure('public.archive_employee_directory_record(uuid,bigint,bigint,date,text)') is null
    or to_regprocedure('public.run_scheduled_employee_offboarding(uuid,timestamptz)') is null then
    raise exception 'Subscription password tasks require the reviewed predecessor.' using errcode = '55000';
  end if;
end;
$$;

create table private.subscription_password_tasks (
  id uuid primary key default gen_random_uuid(),
  subscription_id uuid not null references private.subscription_register(id) on delete restrict,
  departed_person_id uuid not null references public.internal_org_people(id) on delete restrict,
  departed_person_version bigint not null check (departed_person_version > 0),
  due_on date not null,
  version bigint not null default 1 check (version between 1 and 9007199254740991),
  created_at timestamptz not null default clock_timestamp(),
  completed_at timestamptz,
  completed_by uuid references auth.users(id) on delete restrict,
  unique (subscription_id, departed_person_id, departed_person_version),
  check ((completed_at is null and completed_by is null) or (completed_at is not null and completed_by is not null))
);
create index subscription_password_tasks_pending_idx on private.subscription_password_tasks(due_on, subscription_id)
  where completed_at is null;
create table private.subscription_password_task_completions (
  task_id uuid primary key references private.subscription_password_tasks(id) on delete restrict,
  actor_user_id uuid not null references auth.users(id) on delete restrict,
  task_version bigint not null check (task_version > 1),
  created_at timestamptz not null default clock_timestamp()
);
alter table private.subscription_password_tasks enable row level security;
alter table private.subscription_password_tasks force row level security;
alter table private.subscription_password_task_completions enable row level security;
alter table private.subscription_password_task_completions force row level security;
revoke all on private.subscription_password_tasks, private.subscription_password_task_completions
  from public, anon, authenticated, service_role;

create function private.queue_subscription_departure_password_tasks()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if old.node_kind <> 'person' or not old.is_active or new.is_active
    or not exists(select 1 from public.internal_org_people person
      join private.employee_directory_details detail on detail.person_id = person.id
      where person.id = new.id and not person.is_active and person.node_kind = 'person'
        and detail.archive_reason in ('Resigned', 'End of contract', 'Terminated', 'Redundant', 'Other')
        and detail.scheduled_employment_end_date <= private.mam_local_calendar_date()) then
    return null;
  end if;
  perform 1 from private.subscription_register subscription
    where subscription.subscription_status in ('active', 'paused')
      and (subscription.responsible_person_id = new.id or exists(
        select 1 from private.subscription_memberships member
        where member.subscription_id = subscription.id and member.person_id = new.id))
    order by subscription.id for share;
  insert into private.subscription_password_tasks(subscription_id, departed_person_id, departed_person_version, due_on)
    select subscription.id, new.id, new.version, private.mam_local_calendar_date()
    from private.subscription_register subscription
    where subscription.subscription_status in ('active', 'paused')
      and (subscription.responsible_person_id = new.id or exists(
        select 1 from private.subscription_memberships member
        where member.subscription_id = subscription.id and member.person_id = new.id))
    on conflict (subscription_id, departed_person_id, departed_person_version) do nothing;
  return null;
end;
$$;
create constraint trigger subscription_departure_password_tasks
after update of is_active on public.internal_org_people
deferrable initially deferred for each row
when (old.is_active and not new.is_active and old.node_kind = 'person')
execute function private.queue_subscription_departure_password_tasks();

create function public.list_my_subscription_password_tasks()
returns table(task_id uuid, subscription_id uuid, service_name text, due_on date, version bigint)
language plpgsql stable security definer set search_path = '' as $$
declare v_person_id uuid := private.current_active_portal_employee_id();
begin
  if v_person_id is null or not private.is_active_linked_internal_employee()
    or not exists(select 1 from private.portal_role_policy() policy where policy.person_id = v_person_id) then
    raise exception 'Active employee access is required.' using errcode = '42501';
  end if;
  return query select task.id, subscription.id, subscription.service_name, task.due_on, task.version
    from private.subscription_password_tasks task
    join private.subscription_register subscription on subscription.id = task.subscription_id
    where task.completed_at is null and subscription.subscription_status in ('active', 'paused')
      and exists(select 1 from private.subscription_management_grants delegate
        join private.portal_role_policy() policy on policy.person_id = delegate.person_id and policy.can_manage_subscriptions
        where delegate.person_id = v_person_id)
    order by task.due_on, subscription.service_name, task.id;
end;
$$;

create function public.list_subscription_password_tasks_for_preview(p_person_id uuid)
returns table(task_id uuid, subscription_id uuid, service_name text, due_on date, version bigint)
language plpgsql stable security definer set search_path = '' as $$
begin
  if p_person_id is null then raise exception 'The selected employee is unavailable.' using errcode = '42501'; end if;
  perform public.get_portal_role_capabilities(p_person_id);
  return query select task.id, subscription.id, subscription.service_name, task.due_on, task.version
    from private.subscription_password_tasks task
    join private.subscription_register subscription on subscription.id = task.subscription_id
    where task.completed_at is null and subscription.subscription_status in ('active', 'paused')
      and exists(select 1 from private.subscription_management_grants delegate
        join public.internal_org_people person on person.id = delegate.person_id
        cross join lateral private.portal_role_policy(person.auth_user_id) policy
        where delegate.person_id = p_person_id and policy.person_id = delegate.person_id and policy.can_manage_subscriptions)
    order by task.due_on, subscription.service_name, task.id;
end;
$$;

create function public.complete_my_subscription_password_task(p_task_id uuid, p_expected_version bigint, p_password_changed boolean)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare v_person_id uuid; task private.subscription_password_tasks%rowtype;
begin
  if not private.lock_subscription_role_authority(false) then
    raise exception 'You do not have permission to complete password tasks.' using errcode = '42501';
  end if;
  v_person_id := private.current_active_portal_employee_id();
  if v_person_id is null or not private.is_active_linked_internal_employee()
    or not exists(select 1 from private.subscription_management_grants delegate where delegate.person_id = v_person_id) then
    raise exception 'You do not have permission to complete password tasks.' using errcode = '42501';
  end if;
  perform 1 from public.internal_org_people person where person.id = v_person_id for share nowait;
  if p_task_id is null or p_expected_version is null or p_expected_version < 1
    or p_expected_version >= 9007199254740991 or p_password_changed is distinct from true then
    raise exception 'Confirm that the subscription password has been changed.' using errcode = '22023';
  end if;
  select item.* into task from private.subscription_password_tasks item where item.id = p_task_id for update;
  if not found then
    raise exception 'The password task is unavailable.' using errcode = '42501';
  end if;
  perform 1 from private.subscription_register subscription
    where subscription.id = task.subscription_id and subscription.subscription_status in ('active', 'paused') for share;
  if not found then raise exception 'The password task is unavailable.' using errcode = '42501'; end if;
  if task.version <> p_expected_version or task.completed_at is not null then
    raise exception 'This password task has changed.' using errcode = '40001';
  end if;
  update private.subscription_password_tasks item
    set version = item.version + 1, completed_at = clock_timestamp(), completed_by = (select auth.uid())
    where item.id = task.id returning * into task;
  insert into private.subscription_password_task_completions(task_id, actor_user_id, task_version)
    values(task.id, (select auth.uid()), task.version);
  return jsonb_build_object('task_id', task.id, 'version', task.version, 'completed', true);
end;
$$;

revoke all on function private.queue_subscription_departure_password_tasks() from public, anon, authenticated, service_role;
revoke all on function public.list_my_subscription_password_tasks() from public, anon, authenticated, service_role;
revoke all on function public.list_subscription_password_tasks_for_preview(uuid) from public, anon, authenticated, service_role;
revoke all on function public.complete_my_subscription_password_task(uuid,bigint,boolean) from public, anon, authenticated, service_role;
grant execute on function public.list_my_subscription_password_tasks() to authenticated;
grant execute on function public.list_subscription_password_tasks_for_preview(uuid) to authenticated;
grant execute on function public.complete_my_subscription_password_task(uuid,bigint,boolean) to authenticated;

set constraints all immediate;
do $$ begin
  if exists(select 1 from private.subscription_password_tasks) or exists(select 1 from private.subscription_password_task_completions) then
    raise exception 'Subscription password tasks must not backfill historical departures.' using errcode = '55000';
  end if;
end $$;
update private.confirmed_test_purge_schema set schema_hash = private.confirmed_test_purge_schema_hash() where singleton;
commit;
