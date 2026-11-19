-- Controlled cross-company reporting: Equipsy Warehouse -> MAM Warehouse Manager Kieran Kose.
-- Preserves same-company validation for all other combinations.

-- Add the same Warehouse Team Manager for Equipsy staff.
-- This is a default only for future employee creations; it does not update existing employees.
insert into private.employee_team_manager_defaults (company_key, team_name, manager_person_id)
select 'equipsy', 'Warehouse', mam.manager_person_id
from private.employee_team_manager_defaults mam
join public.internal_org_people person on person.id=mam.manager_person_id
where mam.company_key='mam' and mam.team_name='Warehouse'
  and person.node_kind='person' and person.is_active
  and person.company_key='mam' and person.full_name='Kieran Kose'
on conflict (company_key, team_name) do nothing;

do $verify$
begin
  if not exists (
    select 1 from private.employee_team_manager_defaults equipsy
    join private.employee_team_manager_defaults mam on mam.company_key='mam' and mam.team_name='Warehouse'
    join public.internal_org_people manager on manager.id=mam.manager_person_id
    where equipsy.company_key='equipsy' and equipsy.team_name='Warehouse'
      and equipsy.manager_person_id=mam.manager_person_id
      and manager.is_active and manager.full_name='Kieran Kose'
      and manager.company_key='mam'
  ) then
    raise exception 'Equipsy Warehouse manager must be the active MAM Warehouse manager Kieran Kose';
  end if;
end;
$verify$;

CREATE OR REPLACE FUNCTION public.get_employee_team_manager_default(p_company_key text, p_team_name text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  configured_manager uuid;
  manager_name text;
begin
  if not private.is_internal_org_hr() then
    raise exception 'Only an authorized HR user can resolve a new employee manager.' using errcode='42501';
  end if;
  if p_company_key not in ('mam','equipsy') or p_company_key is null
    or p_team_name not in ('Operation & Accounts','Management','Major','Minor','Warehouse','Equipsy') or p_team_name is null then
    raise exception 'Choose a valid company and team.' using errcode='22023';
  end if;
  select manager_person_id into configured_manager
  from private.employee_team_manager_defaults where company_key=p_company_key and team_name=p_team_name;
  if not found then
    return jsonb_build_object('status','missing','managerId',null,'managerName','');
  end if;
  select full_name into manager_name from public.internal_org_people
  where id=configured_manager and node_kind='person' and is_active
    and (
      company_key=p_company_key
      or (
        p_company_key='equipsy' and p_team_name='Warehouse'
        and company_key='mam'
        and id=(
          select defaults.manager_person_id
          from private.employee_team_manager_defaults defaults
          where defaults.company_key='mam' and defaults.team_name='Warehouse'
        )
      )
    );
  if not found then
    return jsonb_build_object('status','invalid','managerId',null,'managerName','');
  end if;
  return jsonb_build_object('status','valid','managerId',configured_manager,'managerName',manager_name);
end;
$function$


CREATE OR REPLACE FUNCTION public.create_employee_directory_record(p_first_name text, p_last_name text, p_work_email text, p_personal_email text, p_phone text, p_position_title text, p_team_name text, p_manager_id uuid, p_country text, p_date_of_birth date, p_started_date date, p_scheduled_employment_end_date date, p_company_key text, p_is_active boolean, p_laptop_supplied text, p_laptop_id text, p_mouse_id text, p_keyboard_id text, p_asset_tags text[], p_sort_order integer DEFAULT 0)
 RETURNS TABLE(person_id uuid, person_version bigint, detail_version bigint)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_unified_role_fence boolean := private.lock_portal_role_actor();
  v_actor uuid := (select auth.uid());
  v_manager_id uuid := p_manager_id;
  v_first_name text;
  v_last_name text;
  v_work_email text;
  v_personal_email text;
  v_phone text;
  v_position_title text;
  v_team_name text;
  v_country text;
  v_laptop_supplied text;
  v_laptop_id text;
  v_mouse_id text;
  v_keyboard_id text;
  v_asset_tags text[];
  v_company_key text := lower(nullif(btrim(p_company_key), ''));
  v_full_name text;
  v_sort_order integer := coalesce(p_sort_order, 0);
  v_person public.internal_org_people%rowtype;
  v_detail private.employee_directory_details%rowtype;
begin
  if not private.is_internal_org_hr() then
    raise exception 'Only an authorized HR user can create employee directory records.'
      using errcode = '42501';
  end if;

  v_first_name := private.normalise_employee_directory_text(p_first_name, 80, true, 'First name');
  v_last_name := private.normalise_employee_directory_text(p_last_name, 120, false, 'Last name');
  v_work_email := private.normalise_employee_directory_email(p_work_email, 'Work email');
  v_personal_email := private.normalise_employee_directory_email(p_personal_email, 'Personal email');
  v_phone := private.normalise_employee_directory_text(p_phone, 64, false, 'Phone');
  v_position_title := private.normalise_employee_directory_text(p_position_title, 120, true, 'Job title');
  v_team_name := private.normalise_employee_directory_text(p_team_name, 120, false, 'Team');
  v_country := private.normalise_employee_directory_text(p_country, 120, false, 'Country');
  v_laptop_supplied := private.normalise_employee_directory_laptop_supplied(p_laptop_supplied);
  v_laptop_id := private.normalise_employee_directory_text(p_laptop_id, 120, false, 'Laptop ID');
  v_mouse_id := private.normalise_employee_directory_text(p_mouse_id, 120, false, 'Mouse ID');
  v_keyboard_id := private.normalise_employee_directory_text(p_keyboard_id, 120, false, 'Keyboard ID');
  v_asset_tags := private.normalise_employee_directory_asset_tags(p_asset_tags);
  v_full_name := concat_ws(' ', v_first_name, v_last_name);

  if char_length(v_full_name) > 120 then
    raise exception 'First and last name together are too long.' using errcode = '22001';
  end if;

  if v_company_key is null or v_company_key not in ('mam', 'equipsy') then
    raise exception 'Choose MAM or Equipsy as the company.' using errcode = '22023';
  end if;

  if p_is_active is null then
    raise exception 'Choose whether the employee is active.' using errcode = '22004';
  end if;

  if v_laptop_supplied = 'mam_laptop' and v_laptop_id is null then
    raise exception 'A Laptop ID is required for a MAM laptop.' using errcode = '22004';
  end if;

  if v_sort_order not between 0 and 32767 then
    raise exception 'Sort order must be between 0 and 32767.' using errcode = '22023';
  end if;

  if p_date_of_birth is not null and p_date_of_birth > current_date then
    raise exception 'Date of birth cannot be in the future.' using errcode = '22023';
  end if;

  if p_scheduled_employment_end_date is not null
    and p_started_date is not null
    and p_scheduled_employment_end_date < p_started_date then
    raise exception 'Scheduled employment end date cannot be before the start date.'
      using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('internal_org_people_hierarchy', 0));

  if v_manager_id is null then
    select configured.manager_person_id into v_manager_id
    from private.employee_team_manager_defaults configured
    where configured.company_key = v_company_key and configured.team_name = v_team_name
    for share;
  end if;

  if v_manager_id is not null then
    perform 1 from public.internal_org_people manager
    where manager.id = v_manager_id and manager.node_kind = 'person'
      and manager.is_active
      and (
        manager.company_key = v_company_key
        or (
          v_company_key = 'equipsy' and v_team_name = 'Warehouse'
          and manager.company_key = 'mam'
          and manager.id = (
            select defaults.manager_person_id
            from private.employee_team_manager_defaults defaults
            where defaults.company_key = 'mam' and defaults.team_name = 'Warehouse'
          )
        )
      )
    for share;
    if not found then
      raise exception 'Choose an active same-company employee as the manager.' using errcode = '23503';
    end if;
  end if;

  insert into public.internal_org_people (
    company_key,
    node_kind,
    position_title,
    full_name,
    parent_id,
    started_date,
    sort_order,
    is_active,
    auth_user_id,
    created_by,
    updated_by
  )
  values (
    v_company_key,
    'person',
    v_position_title,
    v_full_name,
    v_manager_id,
    p_started_date,
    v_sort_order,
    p_is_active,
    null,
    v_actor,
    v_actor
  )
  returning * into v_person;

  insert into private.employee_directory_details (
    person_id,
    first_name,
    last_name,
    work_email,
    personal_email,
    phone,
    team_name,
    country,
    date_of_birth,
    scheduled_employment_end_date,
    laptop_supplied,
    laptop_id,
    mouse_id,
    keyboard_id,
    asset_tags,
    created_by,
    updated_by
  )
  values (
    v_person.id,
    v_first_name,
    v_last_name,
    v_work_email,
    v_personal_email,
    v_phone,
    v_team_name,
    v_country,
    p_date_of_birth,
    p_scheduled_employment_end_date,
    v_laptop_supplied,
    v_laptop_id,
    v_mouse_id,
    v_keyboard_id,
    v_asset_tags,
    v_actor,
    v_actor
  )
  returning * into v_detail;

  insert into private.employee_directory_audit_events (
    person_id,
    actor_user_id,
    event_type,
    changed_fields
  )
  values (
    v_person.id,
    v_actor,
    'created',
    array[
      'first_name',
      'last_name',
      'work_email',
      'personal_email',
      'phone',
      'position_title',
      'team_name',
      'manager_id',
      'country',
      'date_of_birth',
      'started_date',
      'scheduled_employment_end_date',
      'company_key',
      'is_active',
      'sort_order',
      'laptop_supplied',
      'laptop_id',
      'mouse_id',
      'keyboard_id',
      'asset_tags'
    ]::text[]
  );

  return query select v_person.id, v_person.version, v_detail.version;
end;
$function$;
