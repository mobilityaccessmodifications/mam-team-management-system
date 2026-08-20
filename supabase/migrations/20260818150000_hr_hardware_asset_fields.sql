begin;

-- Hardware allocation is an HR-only audit record. It stays with the existing
-- private employee detail, never with the public organisation-tree projection.
alter table private.employee_directory_details
  add column laptop_supplied text,
  add column laptop_id text,
  add column mouse_id text,
  add column keyboard_id text,
  add column asset_tags text[] not null default array[]::text[],
  add constraint employee_directory_details_laptop_supplied_check
    check (laptop_supplied is null or laptop_supplied in ('own_laptop', 'mam_laptop')),
  add constraint employee_directory_details_mam_laptop_identifier_check
    check (laptop_supplied is distinct from 'mam_laptop' or laptop_id is not null),
  add constraint employee_directory_details_asset_tags_check
    check (
      cardinality(asset_tags) <= 24
      and array_position(asset_tags, null) is null
    );

comment on column private.employee_directory_details.laptop_supplied is
  'HR-only laptop allocation status: own_laptop or mam_laptop. A MAM laptop requires a laptop ID.';
comment on column private.employee_directory_details.laptop_id is
  'HR-only asset identifier for the assigned laptop.';
comment on column private.employee_directory_details.mouse_id is
  'HR-only asset identifier for the assigned mouse.';
comment on column private.employee_directory_details.keyboard_id is
  'HR-only asset identifier for the assigned keyboard.';
comment on column private.employee_directory_details.asset_tags is
  'HR-only free-form asset tags, normalized and limited by the employee-directory RPCs.';

-- Retain identifiers after offboarding so a device cannot silently be assigned
-- to a second person. Case-insensitive uniqueness reflects how asset IDs are
-- normally entered while preserving the HR-entered display value.
create unique index employee_directory_details_laptop_id_unique_idx
  on private.employee_directory_details (lower(btrim(laptop_id)))
  where nullif(btrim(laptop_id), '') is not null;

create unique index employee_directory_details_mouse_id_unique_idx
  on private.employee_directory_details (lower(btrim(mouse_id)))
  where nullif(btrim(mouse_id), '') is not null;

create unique index employee_directory_details_keyboard_id_unique_idx
  on private.employee_directory_details (lower(btrim(keyboard_id)))
  where nullif(btrim(keyboard_id), '') is not null;

-- The audit continues to retain field labels only, never asset values.
alter table private.employee_directory_audit_events
  drop constraint employee_directory_audit_events_changed_fields_check;

alter table private.employee_directory_audit_events
  add constraint employee_directory_audit_events_changed_fields_check
  check (
    changed_fields <@ array[
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

create function private.normalise_employee_directory_laptop_supplied(p_value text)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_value text := lower(nullif(btrim(p_value), ''));
begin
  if v_value is null then
    return null;
  end if;

  if v_value not in ('own_laptop', 'mam_laptop') then
    raise exception 'Choose Own laptop or MAM laptop.' using errcode = '22023';
  end if;

  return v_value;
end;
$$;

create function private.normalise_employee_directory_asset_tags(p_tags text[])
returns text[]
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_tags text[];
begin
  if p_tags is null then
    return array[]::text[];
  end if;

  if cardinality(p_tags) > 24 then
    raise exception 'Asset tags must contain 24 values or fewer.' using errcode = '22001';
  end if;

  if exists (
    select 1
    from unnest(p_tags) supplied(tag)
    where supplied.tag is null
      or btrim(supplied.tag) = ''
      or char_length(btrim(supplied.tag)) > 80
  ) then
    raise exception 'Each asset tag must be between 1 and 80 characters.' using errcode = '22001';
  end if;

  select coalesce(array_agg(deduplicated.tag order by deduplicated.ordinality), array[]::text[])
  into v_tags
  from (
    select distinct on (lower(btrim(supplied.tag)))
      btrim(supplied.tag) as tag,
      supplied.ordinality
    from unnest(p_tags) with ordinality as supplied(tag, ordinality)
    order by lower(btrim(supplied.tag)), supplied.ordinality
  ) deduplicated;

  return v_tags;
end;
$$;

-- New hardware parameters are required at the RPC boundary (although most
-- values may be NULL). This prevents a stale pre-release browser from
-- accidentally clearing an allocation after the schema is upgraded.
drop function public.list_employee_directory_records();

drop function public.create_employee_directory_record(
  text, text, text, text, text, text, text, uuid, text, date, date, date, text, boolean, integer
);

drop function public.update_employee_directory_record(
  uuid, text, text, text, text, text, text, text, uuid, text, date, date, date, text, boolean, bigint, bigint, integer
);

create function public.list_employee_directory_records()
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
  date_of_birth date,
  started_date date,
  scheduled_employment_end_date date,
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
  if not private.is_internal_org_hr() then
    raise exception 'Only an authorized HR user can access employee directory records.'
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
    manager.id,
    manager.full_name,
    detail.work_email,
    detail.personal_email,
    detail.phone,
    detail.country,
    detail.date_of_birth,
    person.started_date,
    detail.scheduled_employment_end_date,
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
    and person.is_active
  order by lower(person.full_name), person.id;
end;
$$;

comment on function public.list_employee_directory_records() is
  'Returns the active HR-only employee directory, including private contact, employment and equipment allocation fields. The manager label preserves the authoritative external-manager fallback.';

create function public.create_employee_directory_record(
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

  if p_manager_id is not null then
    if not exists (
      select 1
      from public.internal_org_people manager
      where manager.id = p_manager_id
        and manager.node_kind = 'person'
        and manager.is_active
    ) then
      raise exception 'Choose an active employee as the manager.' using errcode = '23503';
    end if;
  end if;

  perform pg_advisory_xact_lock(hashtextextended('internal_org_people_hierarchy', 0));

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
    p_manager_id,
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
$$;

create function public.update_employee_directory_record(
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
  v_sort_order integer;
  v_person public.internal_org_people%rowtype;
  v_updated_person public.internal_org_people%rowtype;
  v_detail private.employee_directory_details%rowtype;
  v_updated_detail private.employee_directory_details%rowtype;
  v_has_detail boolean;
  v_current_manager_id uuid;
  v_parent_id uuid;
  v_public_changed boolean;
  v_detail_changed boolean;
  v_changed_fields text[];
begin
  if not private.is_internal_org_hr() then
    raise exception 'Only an authorized HR user can update employee directory records.'
      using errcode = '42501';
  end if;

  if p_person_id is null then
    raise exception 'Choose an employee to update.' using errcode = '22004';
  end if;

  if p_expected_person_version is null or p_expected_person_version < 1 then
    raise exception 'The expected employee version is required.' using errcode = '22004';
  end if;

  if p_expected_detail_version is null or p_expected_detail_version < 0 then
    raise exception 'The expected employee detail version is required.' using errcode = '22004';
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

  select person.*
  into v_person
  from public.internal_org_people person
  where person.id = p_person_id
    and person.node_kind = 'person'
  for update;

  if not found then
    raise exception 'The employee does not exist.' using errcode = '23503';
  end if;

  if v_person.version <> p_expected_person_version then
    raise exception 'This employee changed since it was opened. Refresh and try again.'
      using errcode = '40001';
  end if;

  v_sort_order := coalesce(p_sort_order, v_person.sort_order);
  if v_sort_order not between 0 and 32767 then
    raise exception 'Sort order must be between 0 and 32767.' using errcode = '22023';
  end if;

  -- The public tree may contain structural org-unit nodes between an employee
  -- and their nearest people-manager. When HR submits the same manager it saw
  -- on load, retain that structural parent instead of flattening the tree.
  with recursive ancestors as (
    select parent.id, parent.parent_id, parent.node_kind, 1 as depth
    from public.internal_org_people parent
    where parent.id = v_person.parent_id

    union all

    select parent.id, parent.parent_id, parent.node_kind, ancestors.depth + 1
    from public.internal_org_people parent
    join ancestors on parent.id = ancestors.parent_id
  )
  select ancestor.id
  into v_current_manager_id
  from ancestors ancestor
  where ancestor.node_kind = 'person'
  order by ancestor.depth
  limit 1;

  if p_manager_id is not distinct from v_current_manager_id then
    v_parent_id := v_person.parent_id;
  else
    v_parent_id := p_manager_id;
  end if;

  if p_manager_id = p_person_id then
    raise exception 'An employee cannot report to themselves.' using errcode = '22023';
  end if;

  if p_manager_id is not null
    and p_manager_id is distinct from v_current_manager_id then
    if not exists (
      select 1
      from public.internal_org_people manager
      where manager.id = p_manager_id
        and manager.node_kind = 'person'
        and manager.is_active
    ) then
      raise exception 'Choose an active employee as the manager.' using errcode = '23503';
    end if;
  end if;

  if p_is_active is false
    and v_person.auth_user_id is not null
    and exists (
      select 1
      from public.profiles profile
      where profile.id = v_person.auth_user_id
        and profile.account_status = 'active'
    ) then
    raise exception 'Disable the portal account before archiving this employee.'
      using errcode = '23503';
  end if;

  select detail.*
  into v_detail
  from private.employee_directory_details detail
  where detail.person_id = p_person_id
  for update;
  v_has_detail := found;

  if v_has_detail and v_detail.version <> p_expected_detail_version then
    raise exception 'This employee detail changed since it was opened. Refresh and try again.'
      using errcode = '40001';
  end if;

  if not v_has_detail and p_expected_detail_version <> 0 then
    raise exception 'This employee detail changed since it was opened. Refresh and try again.'
      using errcode = '40001';
  end if;

  v_public_changed :=
    v_person.company_key is distinct from v_company_key
    or v_person.full_name is distinct from v_full_name
    or v_person.position_title is distinct from v_position_title
    or v_person.parent_id is distinct from v_parent_id
    or v_person.started_date is distinct from p_started_date
    or v_person.sort_order is distinct from v_sort_order
    or v_person.is_active is distinct from p_is_active;

  v_detail_changed := not v_has_detail
    or v_detail.first_name is distinct from v_first_name
    or v_detail.last_name is distinct from v_last_name
    or v_detail.work_email is distinct from v_work_email
    or v_detail.personal_email is distinct from v_personal_email
    or v_detail.phone is distinct from v_phone
    or v_detail.team_name is distinct from v_team_name
    or v_detail.country is distinct from v_country
    or v_detail.date_of_birth is distinct from p_date_of_birth
    or v_detail.scheduled_employment_end_date is distinct from p_scheduled_employment_end_date
    or v_detail.laptop_supplied is distinct from v_laptop_supplied
    or v_detail.laptop_id is distinct from v_laptop_id
    or v_detail.mouse_id is distinct from v_mouse_id
    or v_detail.keyboard_id is distinct from v_keyboard_id
    or v_detail.asset_tags is distinct from v_asset_tags;

  select coalesce(array_agg(change.field_name order by change.sort_order), array[]::text[])
  into v_changed_fields
  from (
    values
      (1, 'first_name'::text, not v_has_detail or v_detail.first_name is distinct from v_first_name),
      (2, 'last_name'::text, not v_has_detail or v_detail.last_name is distinct from v_last_name),
      (3, 'work_email'::text, not v_has_detail or v_detail.work_email is distinct from v_work_email),
      (4, 'personal_email'::text, not v_has_detail or v_detail.personal_email is distinct from v_personal_email),
      (5, 'phone'::text, not v_has_detail or v_detail.phone is distinct from v_phone),
      (6, 'position_title'::text, v_person.position_title is distinct from v_position_title),
      (7, 'team_name'::text, not v_has_detail or v_detail.team_name is distinct from v_team_name),
      (8, 'manager_id'::text, v_current_manager_id is distinct from p_manager_id),
      (9, 'country'::text, not v_has_detail or v_detail.country is distinct from v_country),
      (10, 'date_of_birth'::text, not v_has_detail or v_detail.date_of_birth is distinct from p_date_of_birth),
      (11, 'started_date'::text, v_person.started_date is distinct from p_started_date),
      (12, 'scheduled_employment_end_date'::text, not v_has_detail or v_detail.scheduled_employment_end_date is distinct from p_scheduled_employment_end_date),
      (13, 'company_key'::text, v_person.company_key is distinct from v_company_key),
      (14, 'is_active'::text, v_person.is_active is distinct from p_is_active),
      (15, 'sort_order'::text, v_person.sort_order is distinct from v_sort_order),
      (16, 'laptop_supplied'::text, not v_has_detail or v_detail.laptop_supplied is distinct from v_laptop_supplied),
      (17, 'laptop_id'::text, not v_has_detail or v_detail.laptop_id is distinct from v_laptop_id),
      (18, 'mouse_id'::text, not v_has_detail or v_detail.mouse_id is distinct from v_mouse_id),
      (19, 'keyboard_id'::text, not v_has_detail or v_detail.keyboard_id is distinct from v_keyboard_id),
      (20, 'asset_tags'::text, not v_has_detail or v_detail.asset_tags is distinct from v_asset_tags)
  ) as change(sort_order, field_name, is_changed)
  where change.is_changed;

  if v_public_changed or v_detail_changed then
    -- A private-only asset edit touches the safe public row solely to trigger
    -- the existing authorised reload signal; no asset field is copied there.
    update public.internal_org_people person
    set company_key = v_company_key,
        position_title = v_position_title,
        full_name = v_full_name,
        parent_id = v_parent_id,
        started_date = p_started_date,
        sort_order = v_sort_order,
        is_active = p_is_active,
        updated_by = v_actor
    where person.id = p_person_id
    returning * into v_updated_person;

    if v_detail_changed then
      if v_has_detail then
        update private.employee_directory_details detail
        set first_name = v_first_name,
            last_name = v_last_name,
            work_email = v_work_email,
            personal_email = v_personal_email,
            phone = v_phone,
            team_name = v_team_name,
            country = v_country,
            date_of_birth = p_date_of_birth,
            scheduled_employment_end_date = p_scheduled_employment_end_date,
            laptop_supplied = v_laptop_supplied,
            laptop_id = v_laptop_id,
            mouse_id = v_mouse_id,
            keyboard_id = v_keyboard_id,
            asset_tags = v_asset_tags,
            updated_by = v_actor
        where detail.person_id = p_person_id
        returning * into v_updated_detail;
      else
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
          p_person_id,
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
        returning * into v_updated_detail;
      end if;
    else
      v_updated_detail := v_detail;
    end if;

    if v_person.auth_user_id is not null
      and v_person.full_name is distinct from v_full_name then
      update public.profiles profile
      set full_name = v_full_name,
          updated_at = clock_timestamp()
      where profile.id = v_person.auth_user_id;
    end if;

    insert into private.employee_directory_audit_events (
      person_id,
      actor_user_id,
      event_type,
      changed_fields
    )
    values (
      p_person_id,
      v_actor,
      case when v_has_detail then 'updated' else 'created' end,
      v_changed_fields
    );
  else
    v_updated_person := v_person;
    v_updated_detail := v_detail;
  end if;

  return query select
    v_updated_person.id,
    v_updated_person.version,
    coalesce(v_updated_detail.version, 0::bigint);
end;
$$;

revoke all on function private.normalise_employee_directory_laptop_supplied(text)
  from public, anon, authenticated;
revoke all on function private.normalise_employee_directory_asset_tags(text[])
  from public, anon, authenticated;
revoke all on function public.list_employee_directory_records()
  from public, anon, authenticated;
revoke all on function public.create_employee_directory_record(
  text, text, text, text, text, text, text, uuid, text, date, date, date, text, boolean, text, text, text, text, text[], integer
) from public, anon, authenticated;
revoke all on function public.update_employee_directory_record(
  uuid, text, text, text, text, text, text, text, uuid, text, date, date, date, text, boolean, bigint, bigint, text, text, text, text, text[], integer
) from public, anon, authenticated;

grant execute on function public.list_employee_directory_records() to authenticated;
grant execute on function public.create_employee_directory_record(
  text, text, text, text, text, text, text, uuid, text, date, date, date, text, boolean, text, text, text, text, text[], integer
) to authenticated;
grant execute on function public.update_employee_directory_record(
  uuid, text, text, text, text, text, text, text, uuid, text, date, date, date, text, boolean, bigint, bigint, text, text, text, text, text[], integer
) to authenticated;

commit;
