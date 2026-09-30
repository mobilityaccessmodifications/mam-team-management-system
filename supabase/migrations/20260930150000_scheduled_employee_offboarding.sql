begin;

create table private.scheduled_employee_offboarding (
  person_id uuid primary key references public.internal_org_people(id) on delete cascade,
  end_date date not null,
  reason text not null check (reason in ('Resigned','End of contract','Terminated','Redundant','Other')),
  scheduled_by uuid not null references auth.users(id),
  scheduled_at timestamptz not null default clock_timestamp(),
  auth_ban_confirmed_at timestamptz,
  auth_ban_user_id uuid,
  auth_ban_executor_token uuid,
  auth_ban_status text not null default 'not_started' check (auth_ban_status in ('not_started','executing','unknown','succeeded'))
);
alter table private.scheduled_employee_offboarding enable row level security;
alter table private.scheduled_employee_offboarding force row level security;
revoke all on private.scheduled_employee_offboarding from public, anon, authenticated;

create function public.schedule_employee_offboarding(
  p_person_id uuid, p_expected_person_version bigint, p_expected_detail_version bigint,
  p_end_date date, p_reason text
) returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_person public.internal_org_people%rowtype;
  v_detail private.employee_directory_details%rowtype;
  v_actor uuid := (select auth.uid());
begin
  if not private.can_view_archived_employee_profiles() then
    raise exception 'Only authorised HR and global reviewers can schedule offboarding.' using errcode='42501';
  end if;
  if p_end_date is null or p_end_date <= (clock_timestamp() at time zone 'Australia/Melbourne')::date
    or p_reason not in ('Resigned','End of contract','Terminated','Redundant','Other') or p_reason is null then
    raise exception 'Choose a future employment end date and reason.' using errcode='22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('internal_org_people_hierarchy', 0));
  select * into v_person from public.internal_org_people where id=p_person_id and node_kind='person' for update;
  select * into v_detail from private.employee_directory_details where person_id=p_person_id for update;
  if v_person.id is null or v_detail.person_id is null or not v_person.is_active then
    raise exception 'The active employee record no longer exists.' using errcode='23503';
  end if;
  if v_person.auth_user_id = v_actor then
    raise exception 'You cannot schedule the disablement of your own portal account.' using errcode='42501';
  end if;
  if v_person.version is distinct from p_expected_person_version or v_detail.version is distinct from p_expected_detail_version then
    raise exception 'This employee changed since it was opened. Refresh and try again.' using errcode='40001';
  end if;
  if v_person.started_date is not null and p_end_date < v_person.started_date then
    raise exception 'The end date cannot be before the start date.' using errcode='22023';
  end if;
  update private.employee_directory_details set scheduled_employment_end_date=p_end_date, updated_by=v_actor where person_id=p_person_id;
  insert into private.scheduled_employee_offboarding(person_id,end_date,reason,scheduled_by)
  values(p_person_id,p_end_date,p_reason,v_actor)
  on conflict(person_id) do update set end_date=excluded.end_date,reason=excluded.reason,
    scheduled_by=excluded.scheduled_by,scheduled_at=clock_timestamp();
  return p_person_id;
end $$;
revoke all on function public.schedule_employee_offboarding(uuid,bigint,bigint,date,text) from public,anon,authenticated;
grant execute on function public.schedule_employee_offboarding(uuid,bigint,bigint,date,text) to authenticated;

create function private.sync_scheduled_employee_offboarding() returns trigger language plpgsql
security definer set search_path='' as $$
begin
  if new.scheduled_employment_end_date is distinct from old.scheduled_employment_end_date then
    if new.scheduled_employment_end_date is null then
      delete from private.scheduled_employee_offboarding where person_id=new.person_id and auth_ban_confirmed_at is null
        and exists (select 1 from public.internal_org_people person where person.id=new.person_id and person.is_active);
    else
      update private.scheduled_employee_offboarding set end_date=new.scheduled_employment_end_date
      where person_id=new.person_id and auth_ban_confirmed_at is null;
    end if;
  end if;
  return new;
end $$;
revoke all on function private.sync_scheduled_employee_offboarding() from public,anon,authenticated,service_role;
create trigger sync_scheduled_employee_offboarding after update of scheduled_employment_end_date
on private.employee_directory_details for each row execute function private.sync_scheduled_employee_offboarding();

create function public.list_scheduled_employee_offboarding() returns table(person_id uuid, auth_user_id uuid, is_active boolean)
language sql security definer set search_path='' as $$
  select schedule.person_id,person.auth_user_id,person.is_active
  from private.scheduled_employee_offboarding schedule
  join public.internal_org_people person on person.id=schedule.person_id
  where schedule.auth_ban_confirmed_at is null
    and (not person.is_active or schedule.end_date < (clock_timestamp() at time zone 'Australia/Melbourne')::date)
  order by schedule.end_date,schedule.person_id limit 100
$$;
revoke all on function public.list_scheduled_employee_offboarding() from public,anon,authenticated;
grant execute on function public.list_scheduled_employee_offboarding() to service_role;

create function public.run_scheduled_employee_offboarding(p_person_id uuid, p_now timestamptz default clock_timestamp())
returns boolean language plpgsql security definer set search_path='' as $$
declare
  v_person public.internal_org_people%rowtype;
  v_schedule private.scheduled_employee_offboarding%rowtype;
  v_profile public.profiles%rowtype;
  v_version bigint;
begin
  if (select auth.role()) is distinct from 'service_role' and session_user not in ('service_role','postgres') then
    raise exception 'Service role required.' using errcode='42501';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('mam:directory-role-control', 0));
  perform pg_advisory_xact_lock(hashtextextended('internal_org_people_hierarchy', 0));
  select * into v_person from public.internal_org_people where id=p_person_id and node_kind='person' for update;
  select * into v_schedule from private.scheduled_employee_offboarding where person_id=p_person_id for update;
  if v_person.id is null or not v_person.is_active or v_schedule.person_id is null
    or v_schedule.end_date >= (p_now at time zone 'Australia/Melbourne')::date then
    return false;
  end if;
  if exists(select 1 from public.internal_org_people where parent_id=p_person_id and is_active) then
    raise exception 'Move or archive active direct reports first.' using errcode='23503';
  end if;
  if exists(select 1 from private.it_assets where assigned_person_id=p_person_id and asset_status <> 'retired') then
    raise exception 'Reassign active IT devices before ending employment.' using errcode='23514';
  end if;
  if v_person.auth_user_id is not null then
    select * into v_profile from public.profiles where id=v_person.auth_user_id for update;
    if v_profile.id is not null and v_profile.account_status='active' then
      if (v_profile.app_role='system_admin' or exists(select 1 from private.portal_account_admins where auth_user_id=v_profile.id and revoked_at is null))
        and not exists(select 1 from public.profiles other where other.id<>v_profile.id and other.account_status='active' and other.login_name is not null
          and (other.app_role='system_admin' or exists(select 1 from private.portal_account_admins admin where admin.auth_user_id=other.id and admin.revoked_at is null))) then
        raise exception 'The last active account administrator cannot be disabled.' using errcode='42501';
      end if;
      update public.profiles set account_status='disabled',disabled_at=clock_timestamp(),credentials_valid_after=clock_timestamp(),
        account_version=account_version+1,updated_at=clock_timestamp() where id=v_profile.id returning account_version into v_version;
      insert into private.portal_account_admin_events(actor_user_id,target_user_id,event_type,before_state,after_state)
      values(v_schedule.scheduled_by,v_profile.id,'account_disabled',
        jsonb_build_object('account_status',v_profile.account_status,'account_version',v_profile.account_version),
        jsonb_build_object('account_status','disabled','account_version',v_version));
    end if;
  end if;
  update public.internal_org_people set is_active=false,updated_by=v_schedule.scheduled_by where id=p_person_id;
  update private.employee_directory_details set archive_reason=v_schedule.reason,updated_by=v_schedule.scheduled_by where person_id=p_person_id;
  insert into private.employee_directory_audit_events(person_id,actor_user_id,event_type,changed_fields)
  values(p_person_id,v_schedule.scheduled_by,'updated',array['is_active','scheduled_employment_end_date']::text[]);
  return true;
end $$;
revoke all on function public.run_scheduled_employee_offboarding(uuid,timestamptz) from public,anon,authenticated;
grant execute on function public.run_scheduled_employee_offboarding(uuid,timestamptz) to service_role;

create function private.prevent_late_offboarding_account_link() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  if new.auth_user_id is distinct from old.auth_user_id and new.auth_user_id is not null
    and not new.is_active and exists (
      select 1 from private.scheduled_employee_offboarding schedule
      where schedule.person_id=new.id and schedule.auth_ban_confirmed_at is null
    ) then
    raise exception 'Archived offboarding cannot acquire a portal account.' using errcode='55000';
  end if;
  return new;
end $$;
revoke all on function private.prevent_late_offboarding_account_link() from public,anon,authenticated,service_role;
create trigger prevent_late_offboarding_account_link before update of auth_user_id
on public.internal_org_people for each row execute function private.prevent_late_offboarding_account_link();

create function public.claim_scheduled_offboarding_auth_ban(p_person_id uuid, p_executor_token uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  v_person public.internal_org_people%rowtype;
  v_schedule private.scheduled_employee_offboarding%rowtype;
begin
  if p_executor_token is null then raise exception 'Executor required.' using errcode='22004'; end if;
  select * into v_person from public.internal_org_people where id=p_person_id for update;
  select * into v_schedule from private.scheduled_employee_offboarding where person_id=p_person_id for update;
  if v_person.id is null or v_person.is_active or v_schedule.person_id is null
    or v_schedule.auth_ban_confirmed_at is not null then
    raise exception 'Offboarding is not ready.' using errcode='55000';
  end if;
  if v_schedule.auth_ban_status <> 'not_started' then
    if v_schedule.auth_ban_user_id is distinct from v_person.auth_user_id then
      raise exception 'Linked account changed during offboarding.' using errcode='55000';
    end if;
    return jsonb_build_object('auth_user_id',v_schedule.auth_ban_user_id,'state',v_schedule.auth_ban_status);
  end if;
  if v_person.auth_user_id is null then
    return jsonb_build_object('auth_user_id',null,'state','no_account');
  end if;
  if not exists(select 1 from public.profiles profile where profile.id=v_person.auth_user_id and profile.account_status='disabled') then
    raise exception 'Linked account must be disabled first.' using errcode='55000';
  end if;
  update private.scheduled_employee_offboarding set auth_ban_user_id=v_person.auth_user_id,
    auth_ban_executor_token=p_executor_token,auth_ban_status='executing' where person_id=p_person_id;
  return jsonb_build_object('auth_user_id',v_person.auth_user_id,'state','execute');
end $$;
revoke all on function public.claim_scheduled_offboarding_auth_ban(uuid,uuid) from public,anon,authenticated;
grant execute on function public.claim_scheduled_offboarding_auth_ban(uuid,uuid) to service_role;

create function public.record_scheduled_offboarding_auth_ban(p_person_id uuid, p_auth_user_id uuid,
  p_executor_token uuid, p_succeeded boolean) returns boolean
language plpgsql security definer set search_path='' as $$
declare v_schedule private.scheduled_employee_offboarding%rowtype;
begin
  select * into v_schedule from private.scheduled_employee_offboarding where person_id=p_person_id for update;
  if v_schedule.person_id is null or v_schedule.auth_ban_user_id is distinct from p_auth_user_id
    or v_schedule.auth_ban_executor_token is distinct from p_executor_token or p_succeeded is null then return false; end if;
  if v_schedule.auth_ban_status=(case when p_succeeded then 'succeeded' else 'unknown' end) then return true; end if;
  if v_schedule.auth_ban_status <> 'executing' then return false; end if;
  update private.scheduled_employee_offboarding set auth_ban_status=(case when p_succeeded then 'succeeded' else 'unknown' end)
  where person_id=p_person_id;
  return true;
end $$;
revoke all on function public.record_scheduled_offboarding_auth_ban(uuid,uuid,uuid,boolean) from public,anon,authenticated;
grant execute on function public.record_scheduled_offboarding_auth_ban(uuid,uuid,uuid,boolean) to service_role;

create function public.confirm_scheduled_offboarding_auth_ban(p_person_id uuid) returns boolean
language plpgsql security definer set search_path='' as $$
declare v_changed integer;
begin
  if (select auth.role()) is distinct from 'service_role' and session_user not in ('service_role','postgres') then
    raise exception 'Service role required.' using errcode='42501';
  end if;
  update private.scheduled_employee_offboarding schedule set auth_ban_confirmed_at=clock_timestamp()
  from public.internal_org_people person
  left join public.profiles profile on profile.id=person.auth_user_id
  where schedule.person_id=p_person_id and person.id=p_person_id and not person.is_active
    and ((person.auth_user_id is null and schedule.auth_ban_status='not_started')
      or (person.auth_user_id=schedule.auth_ban_user_id and profile.account_status='disabled' and schedule.auth_ban_status='succeeded'))
    and schedule.auth_ban_confirmed_at is null;
  get diagnostics v_changed = row_count;
  return v_changed = 1;
end $$;
revoke all on function public.confirm_scheduled_offboarding_auth_ban(uuid) from public,anon,authenticated;
grant execute on function public.confirm_scheduled_offboarding_auth_ban(uuid) to service_role;
commit;
