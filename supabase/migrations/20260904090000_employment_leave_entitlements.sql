begin;

do $$
begin
  perform pg_advisory_xact_lock(
    hashtextextended('mam:employment-leave-entitlements:20260904', 0)
  );

  if to_regclass('private.employee_directory_details') is null
    or to_regclass('private.employee_directory_audit_events') is null
    or to_regclass('public.leave_requests') is null
    or to_regprocedure('private.is_system_portal_account_admin()') is null
    or to_regprocedure('private.is_active_portal_account(uuid)') is null
    or to_regprocedure('private.current_active_portal_employee_id()') is null
    or to_regprocedure('private.can_view_archived_employee_profiles()') is null
    or to_regprocedure('private.resolve_internal_org_employee_manager(uuid)') is null
    or to_regprocedure('public.list_employee_directory_records_with_archive_visibility(boolean)') is null
    or to_regprocedure('public.get_employee_directory_record_with_archive_visibility(uuid)') is null
    or to_regprocedure('public.create_employee_directory_record_with_address(text,text,text,text,text,text,text,uuid,text,date,date,date,text,boolean,text,text,text,text,text[],text,integer)') is null
    or to_regprocedure('public.update_employee_directory_record_with_address(uuid,text,text,text,text,text,text,text,uuid,text,date,date,date,text,boolean,bigint,bigint,text,text,text,text,text[],text,integer)') is null then
    raise exception 'Employment leave-entitlement prerequisites are missing.'
      using errcode = '55000';
  end if;
end;
$$;

alter table private.employee_directory_details
  add column employment_type text;

alter table private.employee_directory_details
  add constraint employee_directory_details_employment_type_check
  check (
    employment_type is null
    or employment_type in ('abn', 'casual', 'full_time', 'part_time')
  );

comment on column private.employee_directory_details.employment_type is
  'System Admin-managed employment classification. Paid-leave eligibility is derived: Full Time and Part Time are eligible; ABN and Casual are unpaid-leave only.';

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
      'employment_type'
    ]::text[]
  );

create function private.normalise_employee_employment_type(p_value text)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_value text := lower(nullif(btrim(p_value), ''));
begin
  if v_value is null or v_value not in ('abn', 'casual', 'full_time', 'part_time') then
    raise exception 'Choose ABN, Casual, Full Time or Part Time as the employment type.'
      using errcode = '22023';
  end if;
  return v_value;
end;
$$;

revoke all on function private.normalise_employee_employment_type(text)
  from public, anon, authenticated;

-- Keep the private employee DTO and its employment policy in one database
-- snapshot. Older clients ignore the two appended JSON fields, while the new
-- client no longer has to race a second entitlement query against directory
-- edits.
drop function public.list_employee_directory_records_with_archive_visibility(boolean);

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
  employment_type text,
  has_paid_leave_entitlement boolean,
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
    detail.employment_type,
    coalesce(detail.employment_type in ('full_time', 'part_time'), false),
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
    and (
      person.is_active
      or (
        coalesce(p_include_archived, false)
        and detail.archive_reason is not null
      )
    )
  order by person.is_active desc, lower(person.full_name), person.id;
end;
$$;

comment on function public.list_employee_directory_records_with_archive_visibility(boolean) is
  'Returns active records and only lifecycle-archived records, including employment classification and derived paid-leave eligibility.';

drop function public.get_employee_directory_record_with_archive_visibility(uuid);

create function public.get_employee_directory_record_with_archive_visibility(
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
  asset_tags text[]
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not private.can_view_archived_employee_profiles() then
    raise exception 'Only the active System Admin can access employee directory records.'
      using errcode = '42501';
  end if;

  if p_person_id is null then
    raise exception 'The employee record is invalid.' using errcode = '22023';
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
    detail.employment_type,
    coalesce(detail.employment_type in ('full_time', 'part_time'), false),
    detail.laptop_supplied,
    detail.laptop_id,
    detail.mouse_id,
    detail.keyboard_id,
    coalesce(detail.asset_tags, array[]::text[])
  from public.internal_org_people person
  left join private.employee_directory_details detail
    on detail.person_id = person.id
  left join lateral private.resolve_internal_org_employee_manager(person.id) manager on true
  where person.id = p_person_id
    and person.node_kind = 'person'
  limit 1;
end;
$$;

comment on function public.get_employee_directory_record_with_archive_visibility(uuid) is
  'Returns one private employee-directory DTO, including employment classification and derived paid-leave eligibility, to the active System Admin.';

create function public.create_employee_directory_record_with_employment_type(
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
  v_employment_type text := private.normalise_employee_employment_type(p_employment_type);
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
  from public.create_employee_directory_record_with_address(
    p_first_name,
    p_last_name,
    p_work_email,
    p_personal_email,
    p_phone,
    p_position_title,
    p_team_name,
    p_manager_id,
    p_country,
    p_date_of_birth,
    p_started_date,
    p_scheduled_employment_end_date,
    p_company_key,
    p_is_active,
    p_laptop_supplied,
    p_laptop_id,
    p_mouse_id,
    p_keyboard_id,
    p_asset_tags,
    p_address,
    p_sort_order
  ) created;

  update private.employee_directory_details detail
  set employment_type = v_employment_type,
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
    array['employment_type']::text[]
  );

  return query select v_person_id, v_person_version, v_detail_version;
end;
$$;

create function public.update_employee_directory_record_with_employment_type(
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
  v_employment_type text := private.normalise_employee_employment_type(p_employment_type);
  v_person_id uuid;
  v_person_version bigint;
  v_detail_version bigint;
  v_current_employment_type text;
begin
  if not private.is_system_portal_account_admin() then
    raise exception 'Only the active System Admin can update employee directory records.'
      using errcode = '42501';
  end if;

  select updated.person_id, updated.person_version, updated.detail_version
  into v_person_id, v_person_version, v_detail_version
  from public.update_employee_directory_record_with_address(
    p_person_id,
    p_first_name,
    p_last_name,
    p_work_email,
    p_personal_email,
    p_phone,
    p_position_title,
    p_team_name,
    p_manager_id,
    p_country,
    p_date_of_birth,
    p_started_date,
    p_scheduled_employment_end_date,
    p_company_key,
    p_is_active,
    p_expected_person_version,
    p_expected_detail_version,
    p_laptop_supplied,
    p_laptop_id,
    p_mouse_id,
    p_keyboard_id,
    p_asset_tags,
    p_address,
    p_sort_order
  ) updated;

  select detail.employment_type
  into v_current_employment_type
  from private.employee_directory_details detail
  where detail.person_id = v_person_id
    and detail.version = v_detail_version
  for update;

  if not found then
    raise exception 'This employee detail changed while it was being saved. Refresh and try again.'
      using errcode = '40001';
  end if;

  if v_current_employment_type is distinct from v_employment_type then
    update private.employee_directory_details detail
    set employment_type = v_employment_type,
        updated_by = v_actor
    where detail.person_id = v_person_id
      and detail.version = v_detail_version
    returning detail.version into v_detail_version;

    if not found then
      raise exception 'This employee detail changed while it was being saved. Refresh and try again.'
        using errcode = '40001';
    end if;

    -- Trigger the existing privacy-safe Realtime invalidation without copying
    -- employment classification into the public organisation projection.
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
      array['employment_type']::text[]
    );
  end if;

  return query select v_person_id, v_person_version, v_detail_version;
end;
$$;

create function public.get_my_leave_entitlement_policy()
returns table (
  person_id uuid,
  employment_type text,
  has_paid_leave_entitlement boolean
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_person_id uuid;
begin
  if not private.is_active_portal_account() then
    return;
  end if;

  v_person_id := private.current_active_portal_employee_id();
  if v_person_id is null then
    return;
  end if;

  return query
  select
    person.id,
    detail.employment_type,
    coalesce(detail.employment_type in ('full_time', 'part_time'), false)
  from public.internal_org_people person
  left join private.employee_directory_details detail
    on detail.person_id = person.id
  where person.id = v_person_id
    and person.node_kind = 'person'
    and person.is_active
  limit 1;
end;
$$;

create function public.get_selected_employee_leave_entitlement_policy(p_person_id uuid)
returns table (
  person_id uuid,
  employment_type text,
  has_paid_leave_entitlement boolean
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not private.is_system_portal_account_admin() then
    raise exception 'Only Super Admin may inspect a selected employee leave policy.'
      using errcode = '42501';
  end if;

  return query
  select
    person.id,
    detail.employment_type,
    coalesce(detail.employment_type in ('full_time', 'part_time'), false)
  from public.internal_org_people person
  left join private.employee_directory_details detail
    on detail.person_id = person.id
  join public.profiles profile
    on profile.id = person.auth_user_id
   and profile.account_status = 'active'
  where person.id = p_person_id
    and person.node_kind = 'person'
    and person.is_active
    and person.auth_user_id is not null
  limit 1;
end;
$$;

alter table public.leave_requests
  add column employment_type_snapshot text,
  add column pay_treatment text;

alter table public.leave_requests
  add constraint leave_requests_employment_type_snapshot_check
    check (
      employment_type_snapshot is null
      or employment_type_snapshot in ('abn', 'casual', 'full_time', 'part_time')
    ),
  add constraint leave_requests_pay_treatment_check
    check (pay_treatment is null or pay_treatment in ('paid_entitlement', 'unpaid'));

comment on column public.leave_requests.employment_type_snapshot is
  'Employment classification at submission time. Legacy requests remain null.';
comment on column public.leave_requests.pay_treatment is
  'Eligibility treatment at submission time. It is not a leave-balance calculation.';

create function private.enforce_leave_request_employment_policy()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_person_id uuid;
  v_employment_type text;
begin
  select person.id, detail.employment_type
  into v_person_id, v_employment_type
  from public.internal_org_people person
  left join private.employee_directory_details detail
    on detail.person_id = person.id
  where person.auth_user_id = new.user_id
    and person.node_kind = 'person'
    and person.is_active
  limit 1;

  if v_person_id is null then
    raise exception 'An active linked employee account is required to submit leave.'
      using errcode = '42501';
  end if;

  if v_employment_type in ('abn', 'casual')
    and new.request_type_label <> 'Unpaid leave' then
    raise exception 'This employment type only allows Unpaid leave.'
      using errcode = '22023';
  end if;

  if v_employment_type is null
    and new.request_type_label <> 'Unpaid leave' then
    raise exception 'Ask a System Admin to set your employment type before requesting this leave.'
      using errcode = '22023';
  end if;

  new.employment_type_snapshot := v_employment_type;
  new.pay_treatment := case
    when new.request_type_label = 'Unpaid leave' then 'unpaid'
    when v_employment_type in ('full_time', 'part_time') then 'paid_entitlement'
    else 'unpaid'
  end;

  return new;
end;
$$;

create trigger leave_requests_enforce_employment_policy
before insert on public.leave_requests
for each row execute function private.enforce_leave_request_employment_policy();

revoke all on function public.list_employee_directory_records_with_archive_visibility(boolean)
  from public, anon, authenticated;
revoke all on function public.get_employee_directory_record_with_archive_visibility(uuid)
  from public, anon, authenticated;
revoke all on function public.create_employee_directory_record_with_employment_type(
  text, text, text, text, text, text, text, uuid, text, date, date, date,
  text, boolean, text, text, text, text, text[], text, text, integer
) from public, anon, authenticated;
revoke all on function public.update_employee_directory_record_with_employment_type(
  uuid, text, text, text, text, text, text, text, uuid, text, date, date, date,
  text, boolean, bigint, bigint, text, text, text, text, text[], text, text, integer
) from public, anon, authenticated;
revoke all on function public.get_my_leave_entitlement_policy()
  from public, anon, authenticated;
revoke all on function public.get_selected_employee_leave_entitlement_policy(uuid)
  from public, anon, authenticated;
revoke all on function private.enforce_leave_request_employment_policy()
  from public, anon, authenticated;

grant execute on function public.list_employee_directory_records_with_archive_visibility(boolean)
  to authenticated;
grant execute on function public.get_employee_directory_record_with_archive_visibility(uuid)
  to authenticated;
grant execute on function public.create_employee_directory_record_with_employment_type(
  text, text, text, text, text, text, text, uuid, text, date, date, date,
  text, boolean, text, text, text, text, text[], text, text, integer
) to authenticated;
grant execute on function public.update_employee_directory_record_with_employment_type(
  uuid, text, text, text, text, text, text, text, uuid, text, date, date, date,
  text, boolean, bigint, bigint, text, text, text, text, text[], text, text, integer
) to authenticated;
grant execute on function public.get_my_leave_entitlement_policy()
  to authenticated;
grant execute on function public.get_selected_employee_leave_entitlement_policy(uuid)
  to authenticated;

commit;
