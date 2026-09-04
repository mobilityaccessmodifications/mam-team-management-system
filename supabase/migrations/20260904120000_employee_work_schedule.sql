begin;

do $$
begin
  perform pg_advisory_xact_lock(
    hashtextextended('mam:employee-work-schedule:20260904', 0)
  );

  if to_regclass('private.employee_directory_details') is null
    or to_regclass('private.employee_directory_audit_events') is null
    or to_regprocedure('private.is_system_portal_account_admin()') is null
    or to_regprocedure('private.can_view_archived_employee_profiles()') is null
    or to_regprocedure('public.list_employee_directory_records_with_archive_visibility(boolean)') is null
    or to_regprocedure('public.get_employee_directory_record_with_archive_visibility(uuid)') is null
    or to_regprocedure('public.create_employee_directory_record_with_employment_type(text,text,text,text,text,text,text,uuid,text,date,date,date,text,boolean,text,text,text,text,text[],text,text,integer)') is null
    or to_regprocedure('public.update_employee_directory_record_with_employment_type(uuid,text,text,text,text,text,text,text,uuid,text,date,date,date,text,boolean,bigint,bigint,text,text,text,text,text[],text,text,integer)') is null then
    raise exception 'Employee work-schedule prerequisites are missing.'
      using errcode = '55000';
  end if;
end;
$$;

create function private.valid_employee_working_weekdays(p_value smallint[])
returns boolean
language sql
immutable
parallel safe
set search_path = ''
as $$
  select p_value is null
    or (
      cardinality(p_value) between 1 and 7
      and not exists (
        select 1
        from unnest(p_value) as weekday(value)
        where weekday.value < 1 or weekday.value > 7
      )
      and cardinality(p_value) = (
        select count(distinct weekday.value)
        from unnest(p_value) as weekday(value)
      )
    );
$$;

create function private.normalise_employee_working_weekdays(p_value smallint[])
returns smallint[]
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_result smallint[];
begin
  if p_value is null or cardinality(p_value) = 0 then
    return null;
  end if;

  if not private.valid_employee_working_weekdays(p_value) then
    raise exception 'Choose valid, non-repeating work days.'
      using errcode = '22023';
  end if;

  select array_agg(weekday.value order by weekday.value)
  into v_result
  from unnest(p_value) as weekday(value);

  return v_result;
end;
$$;

alter table private.employee_directory_details
  add column working_weekdays smallint[]
    constraint employee_directory_details_working_weekdays_check
    check (private.valid_employee_working_weekdays(working_weekdays));

comment on column private.employee_directory_details.working_weekdays is
  'HR-private usual working weekdays using ISO values 1=Monday through 7=Sunday. Null means the schedule has not been recorded. This field does not yet drive leave or check-in calculations.';

alter table private.employee_directory_audit_events
  drop constraint employee_directory_audit_events_changed_fields_check;

alter table private.employee_directory_audit_events
  add constraint employee_directory_audit_events_changed_fields_check
  check (
    changed_fields <@ array[
      'first_name', 'last_name', 'work_email', 'personal_email', 'phone',
      'position_title', 'team_name', 'manager_id', 'country', 'address',
      'date_of_birth', 'started_date', 'scheduled_employment_end_date',
      'company_key', 'is_active', 'sort_order', 'laptop_supplied',
      'laptop_id', 'mouse_id', 'keyboard_id', 'asset_tags',
      'employment_type', 'working_weekdays'
    ]::text[]
  );

create function public.list_employee_directory_records_with_work_schedule(
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
  employment_type text,
  has_paid_leave_entitlement boolean,
  laptop_supplied text,
  laptop_id text,
  mouse_id text,
  keyboard_id text,
  asset_tags text[],
  working_weekdays smallint[]
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
    record.person_id,
    record.person_version,
    record.detail_version,
    record.company_key,
    record.is_active,
    record.first_name,
    record.last_name,
    record.full_name,
    record.position_title,
    record.team_name,
    record.manager_id,
    record.manager_name,
    record.work_email,
    record.personal_email,
    record.phone,
    record.country,
    record.address,
    record.date_of_birth,
    record.started_date,
    record.scheduled_employment_end_date,
    record.archive_reason,
    record.employment_type,
    record.has_paid_leave_entitlement,
    record.laptop_supplied,
    record.laptop_id,
    record.mouse_id,
    record.keyboard_id,
    record.asset_tags,
    detail.working_weekdays
  from public.list_employee_directory_records_with_archive_visibility(
    p_include_archived
  ) record
  left join private.employee_directory_details detail
    on detail.person_id = record.person_id;
end;
$$;

comment on function public.list_employee_directory_records_with_work_schedule(boolean) is
  'Returns the authorised private employee directory with each recorded weekly work schedule.';

create function public.get_employee_directory_record_with_work_schedule(
  p_person_id uuid
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
  employment_type text,
  has_paid_leave_entitlement boolean,
  laptop_supplied text,
  laptop_id text,
  mouse_id text,
  keyboard_id text,
  asset_tags text[],
  working_weekdays smallint[]
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
    record.person_id,
    record.person_version,
    record.detail_version,
    record.company_key,
    record.is_active,
    record.first_name,
    record.last_name,
    record.full_name,
    record.position_title,
    record.team_name,
    record.manager_id,
    record.manager_name,
    record.work_email,
    record.personal_email,
    record.phone,
    record.country,
    record.address,
    record.date_of_birth,
    record.started_date,
    record.scheduled_employment_end_date,
    record.archive_reason,
    record.employment_type,
    record.has_paid_leave_entitlement,
    record.laptop_supplied,
    record.laptop_id,
    record.mouse_id,
    record.keyboard_id,
    record.asset_tags,
    detail.working_weekdays
  from public.get_employee_directory_record_with_archive_visibility(
    p_person_id
  ) record
  left join private.employee_directory_details detail
    on detail.person_id = record.person_id;
end;
$$;

comment on function public.get_employee_directory_record_with_work_schedule(uuid) is
  'Returns one authorised private employee-directory record with its recorded weekly work schedule.';

create function public.create_employee_directory_record_with_work_schedule(
  p_first_name text,
  p_last_name text,
  p_work_email text,
  p_personal_email text,
  p_phone text,
  p_position_title text,
  p_team_name text,
  p_manager_id uuid,
  p_country text,
  p_date_of_birth date,
  p_started_date date,
  p_scheduled_employment_end_date date,
  p_company_key text,
  p_is_active boolean,
  p_laptop_supplied text,
  p_laptop_id text,
  p_mouse_id text,
  p_keyboard_id text,
  p_asset_tags text[],
  p_address text,
  p_employment_type text,
  p_working_weekdays smallint[],
  p_sort_order integer default 0
)
returns table (
  person_id uuid,
  person_version bigint,
  detail_version bigint
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_working_weekdays smallint[] := private.normalise_employee_working_weekdays(p_working_weekdays);
  v_current_working_weekdays smallint[];
  v_person_id uuid;
  v_person_version bigint;
  v_detail_version bigint;
begin
  if not private.is_system_portal_account_admin() then
    raise exception 'Only the active System Admin can create employee directory records.'
      using errcode = '42501';
  end if;

  select created.person_id, created.person_version, created.detail_version
  into v_person_id, v_person_version, v_detail_version
  from public.create_employee_directory_record_with_employment_type(
    p_first_name => p_first_name,
    p_last_name => p_last_name,
    p_work_email => p_work_email,
    p_personal_email => p_personal_email,
    p_phone => p_phone,
    p_position_title => p_position_title,
    p_team_name => p_team_name,
    p_manager_id => p_manager_id,
    p_country => p_country,
    p_date_of_birth => p_date_of_birth,
    p_started_date => p_started_date,
    p_scheduled_employment_end_date => p_scheduled_employment_end_date,
    p_company_key => p_company_key,
    p_is_active => p_is_active,
    p_laptop_supplied => p_laptop_supplied,
    p_laptop_id => p_laptop_id,
    p_mouse_id => p_mouse_id,
    p_keyboard_id => p_keyboard_id,
    p_asset_tags => p_asset_tags,
    p_address => p_address,
    p_employment_type => p_employment_type,
    p_sort_order => p_sort_order
  ) created;

  select detail.working_weekdays
  into v_current_working_weekdays
  from private.employee_directory_details detail
  where detail.person_id = v_person_id
    and detail.version = v_detail_version
  for update;

  if not found then
    raise exception 'This employee detail changed while it was being created. Refresh and try again.'
      using errcode = '40001';
  end if;

  if v_current_working_weekdays is distinct from v_working_weekdays then
    update private.employee_directory_details detail
    set working_weekdays = v_working_weekdays,
        updated_by = v_actor
    where detail.person_id = v_person_id
      and detail.version = v_detail_version
    returning detail.version into v_detail_version;

    if not found then
      raise exception 'This employee detail changed while it was being created. Refresh and try again.'
        using errcode = '40001';
    end if;

    update public.internal_org_people person
    set updated_by = v_actor
    where person.id = v_person_id
    returning person.version into v_person_version;

    insert into private.employee_directory_audit_events (
      person_id,
      actor_user_id,
      event_type,
      changed_fields
    )
    values (
      v_person_id,
      v_actor,
      'updated',
      array['working_weekdays']::text[]
    );
  end if;

  return query select v_person_id, v_person_version, v_detail_version;
end;
$$;

create function public.update_employee_directory_record_with_work_schedule(
  p_person_id uuid,
  p_first_name text,
  p_last_name text,
  p_work_email text,
  p_personal_email text,
  p_phone text,
  p_position_title text,
  p_team_name text,
  p_manager_id uuid,
  p_country text,
  p_date_of_birth date,
  p_started_date date,
  p_scheduled_employment_end_date date,
  p_company_key text,
  p_is_active boolean,
  p_expected_person_version bigint,
  p_expected_detail_version bigint,
  p_laptop_supplied text,
  p_laptop_id text,
  p_mouse_id text,
  p_keyboard_id text,
  p_asset_tags text[],
  p_address text,
  p_employment_type text,
  p_working_weekdays smallint[],
  p_sort_order integer default null
)
returns table (
  person_id uuid,
  person_version bigint,
  detail_version bigint
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_working_weekdays smallint[] := private.normalise_employee_working_weekdays(p_working_weekdays);
  v_current_working_weekdays smallint[];
  v_person_id uuid;
  v_person_version bigint;
  v_detail_version bigint;
begin
  if not private.is_system_portal_account_admin() then
    raise exception 'Only the active System Admin can update employee directory records.'
      using errcode = '42501';
  end if;

  select updated.person_id, updated.person_version, updated.detail_version
  into v_person_id, v_person_version, v_detail_version
  from public.update_employee_directory_record_with_employment_type(
    p_person_id => p_person_id,
    p_first_name => p_first_name,
    p_last_name => p_last_name,
    p_work_email => p_work_email,
    p_personal_email => p_personal_email,
    p_phone => p_phone,
    p_position_title => p_position_title,
    p_team_name => p_team_name,
    p_manager_id => p_manager_id,
    p_country => p_country,
    p_date_of_birth => p_date_of_birth,
    p_started_date => p_started_date,
    p_scheduled_employment_end_date => p_scheduled_employment_end_date,
    p_company_key => p_company_key,
    p_is_active => p_is_active,
    p_expected_person_version => p_expected_person_version,
    p_expected_detail_version => p_expected_detail_version,
    p_laptop_supplied => p_laptop_supplied,
    p_laptop_id => p_laptop_id,
    p_mouse_id => p_mouse_id,
    p_keyboard_id => p_keyboard_id,
    p_asset_tags => p_asset_tags,
    p_address => p_address,
    p_employment_type => p_employment_type,
    p_sort_order => p_sort_order
  ) updated;

  select detail.working_weekdays
  into v_current_working_weekdays
  from private.employee_directory_details detail
  where detail.person_id = v_person_id
    and detail.version = v_detail_version
  for update;

  if not found then
    raise exception 'This employee detail changed while it was being saved. Refresh and try again.'
      using errcode = '40001';
  end if;

  if v_current_working_weekdays is distinct from v_working_weekdays then
    update private.employee_directory_details detail
    set working_weekdays = v_working_weekdays,
        updated_by = v_actor
    where detail.person_id = v_person_id
      and detail.version = v_detail_version
    returning detail.version into v_detail_version;

    if not found then
      raise exception 'This employee detail changed while it was being saved. Refresh and try again.'
        using errcode = '40001';
    end if;

    update public.internal_org_people person
    set updated_by = v_actor
    where person.id = v_person_id
    returning person.version into v_person_version;

    insert into private.employee_directory_audit_events (
      person_id,
      actor_user_id,
      event_type,
      changed_fields
    )
    values (
      v_person_id,
      v_actor,
      'updated',
      array['working_weekdays']::text[]
    );
  end if;

  return query select v_person_id, v_person_version, v_detail_version;
end;
$$;

revoke all on function private.valid_employee_working_weekdays(smallint[])
  from public, anon, authenticated;
revoke all on function private.normalise_employee_working_weekdays(smallint[])
  from public, anon, authenticated;
revoke all on function public.list_employee_directory_records_with_work_schedule(boolean)
  from public, anon, authenticated;
revoke all on function public.get_employee_directory_record_with_work_schedule(uuid)
  from public, anon, authenticated;
revoke all on function public.create_employee_directory_record_with_work_schedule(
  text, text, text, text, text, text, text, uuid, text, date, date, date,
  text, boolean, text, text, text, text, text[], text, text, smallint[], integer
) from public, anon, authenticated;
revoke all on function public.update_employee_directory_record_with_work_schedule(
  uuid, text, text, text, text, text, text, text, uuid, text, date, date, date,
  text, boolean, bigint, bigint, text, text, text, text, text[], text, text,
  smallint[], integer
) from public, anon, authenticated;

grant execute on function public.list_employee_directory_records_with_work_schedule(boolean)
  to authenticated;
grant execute on function public.get_employee_directory_record_with_work_schedule(uuid)
  to authenticated;
grant execute on function public.create_employee_directory_record_with_work_schedule(
  text, text, text, text, text, text, text, uuid, text, date, date, date,
  text, boolean, text, text, text, text, text[], text, text, smallint[], integer
) to authenticated;
grant execute on function public.update_employee_directory_record_with_work_schedule(
  uuid, text, text, text, text, text, text, text, uuid, text, date, date, date,
  text, boolean, bigint, bigint, text, text, text, text, text[], text, text,
  smallint[], integer
) to authenticated;

commit;
