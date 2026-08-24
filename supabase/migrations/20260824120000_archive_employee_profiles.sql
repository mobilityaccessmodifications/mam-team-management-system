begin;

-- Employee lifecycle is separate from the active organisation tree. Archived
-- records retain their HR history and are visible only to the same controlled
-- global reviewers who operate the HR workspace.
alter table private.employee_directory_details
  add column if not exists archive_reason text
    check (archive_reason is null or char_length(btrim(archive_reason)) between 1 and 120);

create index if not exists employee_directory_details_archive_reason_idx
  on private.employee_directory_details (archive_reason)
  where archive_reason is not null;

create or replace function private.can_view_archived_employee_profiles()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.is_system_portal_account_admin()
    or private.is_internal_org_hr()
    or exists (
      select 1
      from private.employee_check_in_access_grants access_grant
      where access_grant.reviewer_user_id = (select auth.uid())
        and access_grant.scope_kind = 'global'
        and access_grant.revoked_at is null
        and private.is_active_portal_account(access_grant.reviewer_user_id)
    );
$$;

comment on function private.can_view_archived_employee_profiles() is
  'Authorizes archived-directory visibility for Super Admin, HR, and active global check-in reviewers (including Steven and Penny).';

revoke all on function private.can_view_archived_employee_profiles()
  from public, anon, authenticated;

grant execute on function private.can_view_archived_employee_profiles()
  to authenticated;

create or replace function public.can_manage_employee_directory()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.can_view_archived_employee_profiles();
$$;

comment on function public.can_manage_employee_directory() is
  'Returns whether the current HR, Super Admin, or global check-in reviewer may manage the employee directory and archive view.';

drop function if exists public.list_employee_directory_records_with_archive_visibility(boolean);

create function public.list_employee_directory_records_with_archive_visibility(
  p_include_archived boolean default false
)
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
  archive_reason text,
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
  if not private.can_view_archived_employee_profiles() then
    raise exception 'Only authorised HR and global reviewers can access employee directory records.'
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
    detail.archive_reason,
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
    and (person.is_active or coalesce(p_include_archived, false))
  order by person.is_active desc, lower(person.full_name), person.id;
end;
$$;

comment on function public.list_employee_directory_records_with_archive_visibility(boolean) is
  'Returns active HR directory records and, when requested, archived records to authorised global reviewers.';

revoke all on function public.list_employee_directory_records_with_archive_visibility(boolean)
  from public, anon, authenticated;
grant execute on function public.list_employee_directory_records_with_archive_visibility(boolean)
  to authenticated;

drop function if exists public.archive_employee_directory_record(uuid, bigint, bigint, date, text);

create function public.archive_employee_directory_record(
  p_person_id uuid,
  p_expected_person_version bigint,
  p_expected_detail_version bigint,
  p_end_date date,
  p_archive_reason text
)
returns table (
  person_id uuid,
  person_version bigint,
  detail_version bigint
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_person public.internal_org_people%rowtype;
  v_detail private.employee_directory_details%rowtype;
  v_reason text := nullif(btrim(p_archive_reason), '');
  v_updated_person public.internal_org_people%rowtype;
  v_updated_detail private.employee_directory_details%rowtype;
begin
  if not private.can_view_archived_employee_profiles() then
    raise exception 'Only authorised HR and global reviewers can archive employee profiles.'
      using errcode = '42501';
  end if;

  if p_person_id is null or p_expected_person_version is null or p_expected_person_version < 1
    or p_expected_detail_version is null or p_expected_detail_version < 0 then
    raise exception 'The employee record is invalid.' using errcode = '22023';
  end if;

  if p_end_date is null then
    raise exception 'Choose an employment end date.' using errcode = '22004';
  end if;

  if v_reason is null or v_reason not in ('Resigned', 'End of contract', 'Terminated', 'Redundant', 'Other') then
    raise exception 'Choose an archive reason.' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('internal_org_people_hierarchy', 0));

  select person.* into v_person
  from public.internal_org_people person
  where person.id = p_person_id
    and person.node_kind = 'person'
  for update;

  if not found then
    raise exception 'The employee record no longer exists.' using errcode = '23503';
  end if;

  if v_person.version <> p_expected_person_version then
    raise exception 'This employee changed since it was opened. Refresh and try again.' using errcode = '40001';
  end if;

  if v_person.started_date is not null and p_end_date < v_person.started_date then
    raise exception 'The end date cannot be before the start date.' using errcode = '22023';
  end if;

  if exists (
    select 1
    from public.internal_org_people child
    where child.parent_id = p_person_id
      and child.is_active
  ) then
    raise exception 'Move or archive this employee''s active direct reports first.' using errcode = '23503';
  end if;

  if v_person.auth_user_id is not null
    and exists (
      select 1
      from public.profiles profile
      where profile.id = v_person.auth_user_id
        and profile.account_status = 'active'
    ) then
    raise exception 'Disable the portal account before archiving this employee.' using errcode = '23503';
  end if;

  select detail.* into v_detail
  from private.employee_directory_details detail
  where detail.person_id = p_person_id
  for update;

  if not found then
    raise exception 'The employee detail does not exist.' using errcode = '23503';
  end if;

  if v_detail.version <> p_expected_detail_version then
    raise exception 'This employee detail changed since it was opened. Refresh and try again.' using errcode = '40001';
  end if;

  update public.internal_org_people person
  set is_active = false,
      updated_by = v_actor
  where person.id = p_person_id
  returning * into v_updated_person;

  update private.employee_directory_details detail
  set scheduled_employment_end_date = p_end_date,
      archive_reason = v_reason,
      updated_by = v_actor
  where detail.person_id = p_person_id
  returning * into v_updated_detail;

  insert into private.employee_directory_audit_events (
    person_id,
    actor_user_id,
    event_type,
    changed_fields
  )
  values (
    p_person_id,
    v_actor,
    'updated',
    array['is_active', 'scheduled_employment_end_date']::text[]
  );

  return query select v_updated_person.id, v_updated_person.version, v_updated_detail.version;
end;
$$;

comment on function public.archive_employee_directory_record(uuid, bigint, bigint, date, text) is
  'Archives an employee with a required end date and controlled reason while retaining the HR record for authorised reviewers.';

revoke all on function public.archive_employee_directory_record(uuid, bigint, bigint, date, text)
  from public, anon, authenticated;
grant execute on function public.archive_employee_directory_record(uuid, bigint, bigint, date, text)
  to authenticated;

create or replace function public.can_delete_employee_directory_profile()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.can_view_archived_employee_profiles();
$$;

drop function if exists public.delete_employee_directory_record(uuid, bigint);

create function public.delete_employee_directory_record(
  p_person_id uuid,
  p_expected_person_version bigint
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_person public.internal_org_people%rowtype;
  v_has_roster_link boolean := false;
begin
  if not public.can_delete_employee_directory_profile() then
    raise exception 'Only authorised HR, Super Admin, Steven or Penny can delete archived employee profiles.'
      using errcode = '42501';
  end if;

  if p_person_id is null or p_expected_person_version is null or p_expected_person_version < 1 then
    raise exception 'The employee record is invalid.' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('internal_org_people_hierarchy', 0));

  select person.* into v_person
  from public.internal_org_people person
  where person.id = p_person_id
    and person.node_kind = 'person'
  for update;

  if not found then
    raise exception 'The employee record no longer exists.' using errcode = '23503';
  end if;

  if v_person.version <> p_expected_person_version then
    raise exception 'This employee changed since it was opened. Refresh and try again.' using errcode = '40001';
  end if;

  if v_person.is_active then
    raise exception 'Archive the employee before deleting the profile.' using errcode = '23503';
  end if;

  if v_person.auth_user_id is not null then
    raise exception 'Unlink the portal account before deleting the profile.' using errcode = '23503';
  end if;

  if exists (
    select 1 from public.internal_org_people child where child.parent_id = p_person_id
  ) then
    raise exception 'Move or delete this employee''s reporting line before deleting the profile.' using errcode = '23503';
  end if;

  if to_regclass('private.employee_check_in_reminders') is not null
    and exists (select 1 from private.employee_check_in_reminders reminder where reminder.person_id = p_person_id) then
    raise exception 'This profile has check-in history. Keep it archived instead.' using errcode = '23503';
  end if;

  if to_regclass('private.employee_check_in_enrolments') is not null
    and exists (select 1 from private.employee_check_in_enrolments enrolment where enrolment.person_id = p_person_id) then
    raise exception 'This profile has check-in history. Keep it archived instead.' using errcode = '23503';
  end if;

  if to_regclass('private.employee_roster_person_links') is not null then
    execute 'select exists (select 1 from private.employee_roster_person_links where person_id = $1)'
      into v_has_roster_link using p_person_id;
    if v_has_roster_link then
      raise exception 'This profile is part of the authoritative roster. Keep it archived instead.' using errcode = '23503';
    end if;
  end if;

  begin
    delete from public.internal_org_people person where person.id = p_person_id;
  exception
    when foreign_key_violation then
      raise exception 'This profile is referenced by existing records. Keep it archived instead.' using errcode = '23503';
  end;

  return p_person_id;
end;
$$;

comment on function public.delete_employee_directory_record(uuid, bigint) is
  'Permanently deletes only an archived, unlinked, history-free employee profile.';

revoke all on function public.can_delete_employee_directory_profile()
  from public, anon, authenticated;
revoke all on function public.delete_employee_directory_record(uuid, bigint)
  from public, anon, authenticated;
grant execute on function public.can_delete_employee_directory_profile()
  to authenticated;
grant execute on function public.delete_employee_directory_record(uuid, bigint)
  to authenticated;

commit;
