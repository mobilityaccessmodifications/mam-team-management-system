begin;

-- HR contact and employment information is deliberately kept outside the
-- authenticated organisation-tree projection. The public tree remains the
-- source of safe hierarchy facts only; this table is readable and writable
-- exclusively through the narrowly scoped HR RPCs below.
create table private.employee_directory_details (
  person_id uuid primary key references public.internal_org_people (id) on delete cascade,
  first_name text not null
    check (
      first_name = btrim(first_name)
      and char_length(first_name) between 1 and 80
    ),
  last_name text
    check (
      last_name is null
      or (
        last_name = btrim(last_name)
        and char_length(last_name) between 1 and 120
      )
    ),
  work_email text
    check (
      work_email is null
      or (
        work_email = btrim(work_email)
        and char_length(work_email) between 3 and 254
        and work_email ~ '^[^[:space:]@]+@[^[:space:]@]+$'
      )
    ),
  personal_email text
    check (
      personal_email is null
      or (
        personal_email = btrim(personal_email)
        and char_length(personal_email) between 3 and 254
        and personal_email ~ '^[^[:space:]@]+@[^[:space:]@]+$'
      )
    ),
  phone text
    check (
      phone is null
      or (
        phone = btrim(phone)
        and char_length(phone) between 1 and 64
      )
    ),
  team_name text
    check (
      team_name is null
      or (
        team_name = btrim(team_name)
        and char_length(team_name) between 1 and 120
      )
    ),
  country text
    check (
      country is null
      or (
        country = btrim(country)
        and char_length(country) between 1 and 120
      )
    ),
  date_of_birth date,
  scheduled_employment_end_date date,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  created_by uuid references auth.users (id) on delete set null,
  updated_by uuid references auth.users (id) on delete set null,
  version bigint not null default 1 check (version > 0)
);

comment on table private.employee_directory_details is
  'HR-private employee contact and employment information. Access only through HR directory RPCs; never select this table from the browser.';
comment on column private.employee_directory_details.person_id is
  'One-to-one link to the canonical public organisation person node. A row is created when HR records are created or imported.';

alter table private.employee_directory_details enable row level security;
revoke all on table private.employee_directory_details from public, anon, authenticated;

create index employee_directory_details_work_email_idx
  on private.employee_directory_details (lower(work_email))
  where work_email is not null;

create index employee_directory_details_team_name_idx
  on private.employee_directory_details (team_name)
  where team_name is not null;

-- The audit stores only field labels and opaque identifiers. It intentionally
-- never stores names, contact details, dates of birth, or before/after values.
create table private.employee_directory_audit_events (
  id bigint generated always as identity primary key,
  person_id uuid not null references public.internal_org_people (id) on delete cascade,
  actor_user_id uuid references auth.users (id) on delete set null,
  event_type text not null check (event_type in ('created', 'updated')),
  changed_fields text[] not null default array[]::text[]
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
        'sort_order'
      ]::text[]
    ),
  created_at timestamptz not null default clock_timestamp()
);

comment on table private.employee_directory_audit_events is
  'Append-only HR employee-directory audit. It stores changed field names only, never HR data values.';

alter table private.employee_directory_audit_events enable row level security;
revoke all on table private.employee_directory_audit_events from public, anon, authenticated;

create index employee_directory_audit_events_person_created_idx
  on private.employee_directory_audit_events (person_id, created_at desc);

create index employee_directory_audit_events_actor_created_idx
  on private.employee_directory_audit_events (actor_user_id, created_at desc)
  where actor_user_id is not null;

create function private.set_employee_directory_details_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = clock_timestamp();
  new.updated_by = coalesce((select auth.uid()), new.updated_by, old.updated_by);
  new.version = old.version + 1;
  return new;
end;
$$;

create trigger employee_directory_details_set_updated_at
before update on private.employee_directory_details
for each row execute function private.set_employee_directory_details_updated_at();

-- A linked account profile is a display mirror of the canonical organisation
-- name, not a second editable identity record. This complements the HR/tree
-- RPC synchronisation below and closes the self-service profile update path.
create function private.prevent_linked_profile_name_drift()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.full_name is distinct from old.full_name
    and exists (
      select 1
      from public.internal_org_people person
      where person.auth_user_id = new.id
        and person.node_kind = 'person'
        and person.full_name is distinct from new.full_name
    ) then
    raise exception 'Use the employee directory to change the name of a linked account.'
      using errcode = '42501';
  end if;

  return new;
end;
$$;

create trigger profiles_prevent_linked_name_drift
before update of full_name on public.profiles
for each row execute function private.prevent_linked_profile_name_drift();

create function private.normalise_employee_directory_text(
  p_value text,
  p_max_length integer,
  p_required boolean,
  p_field_label text
)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_value text := nullif(btrim(p_value), '');
begin
  if p_required and v_value is null then
    raise exception '% is required.', p_field_label using errcode = '22004';
  end if;

  if v_value is not null and char_length(v_value) > p_max_length then
    raise exception '% is too long.', p_field_label using errcode = '22001';
  end if;

  return v_value;
end;
$$;

create function private.normalise_employee_directory_email(
  p_value text,
  p_field_label text
)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_value text := private.normalise_employee_directory_text(p_value, 254, false, p_field_label);
begin
  if v_value is not null and v_value !~ '^[^[:space:]@]+@[^[:space:]@]+$' then
    raise exception '% must be a valid email address.', p_field_label using errcode = '22023';
  end if;

  return v_value;
end;
$$;

create function public.can_manage_employee_directory()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.is_internal_org_hr();
$$;

comment on function public.can_manage_employee_directory() is
  'Returns whether the current active internal-org HR user may read, edit, create, and export private employee directory records.';

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
  scheduled_employment_end_date date
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
    detail.scheduled_employment_end_date
  from public.internal_org_people person
  left join private.employee_directory_details detail
    on detail.person_id = person.id
  left join lateral (
    with recursive ancestors as (
      select
        parent.id,
        parent.full_name,
        parent.parent_id,
        parent.node_kind,
        1 as depth
      from public.internal_org_people parent
      where parent.id = person.parent_id

      union all

      select
        parent.id,
        parent.full_name,
        parent.parent_id,
        parent.node_kind,
        ancestors.depth + 1
      from public.internal_org_people parent
      join ancestors on parent.id = ancestors.parent_id
    )
    select ancestor.id, ancestor.full_name
    from ancestors ancestor
    where ancestor.node_kind = 'person'
    order by ancestor.depth
    limit 1
  ) manager on true
  where person.node_kind = 'person'
  order by lower(person.full_name), person.id;
end;
$$;

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
      'sort_order'
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
  -- and their nearest people-manager. When the HR form submits the same
  -- manager it saw on load, retain that structural parent rather than silently
  -- flattening the organisation tree.
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
    or v_detail.scheduled_employment_end_date is distinct from p_scheduled_employment_end_date;

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
      (15, 'sort_order'::text, v_person.sort_order is distinct from v_sort_order)
  ) as change(sort_order, field_name, is_changed)
  where change.is_changed;

  if v_public_changed or v_detail_changed then
    -- A private-only change deliberately touches this public row. The existing
    -- version/updated-at trigger publishes an internal_org_people Realtime
    -- event, so all org-tree clients reload the canonical shared projection.
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

-- The original tree editor predates the private employee directory. Retain its
-- signature and existing narrow authorisation, but reject a name/type change
-- once HR has a detailed record. This prevents a parallel "full name" value
-- from drifting away from first/last name in the HR record. The directory RPC
-- above is the only supported path for detailed employee names.
create or replace function public.update_internal_org_node(
  p_node_id uuid,
  p_company_key text,
  p_node_kind text,
  p_position_title text,
  p_full_name text default null,
  p_parent_id uuid default null,
  p_started_date date default null,
  p_sort_order integer default 0,
  p_is_active boolean default true,
  p_expected_version bigint default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_node public.internal_org_people%rowtype;
  v_updated_node public.internal_org_people%rowtype;
  v_node_kind text := lower(btrim(p_node_kind));
  v_company_key text := lower(btrim(p_company_key));
  v_full_name text := case
    when lower(btrim(p_node_kind)) = 'person' then nullif(btrim(p_full_name), '')
    else null
  end;
begin
  if not private.is_internal_org_hr() then
    if not private.is_portal_account_admin() then
      raise exception 'Only an authorized HR user can edit the organisation tree.'
        using errcode = '42501';
    end if;
  end if;

  if p_expected_version is null then
    raise exception 'The expected org node version is required.' using errcode = '22004';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('internal_org_people_hierarchy', 0));

  select node.*
  into v_node
  from public.internal_org_people node
  where node.id = p_node_id
  for update;

  if not found then
    raise exception 'The org node does not exist.' using errcode = '23503';
  end if;

  if v_node.version <> p_expected_version then
    raise exception 'This org node changed since it was opened. Refresh and try again.'
      using errcode = '40001';
  end if;

  if exists (
    select 1
    from private.employee_directory_details detail
    where detail.person_id = p_node_id
  ) and (
    v_node.full_name is distinct from v_full_name
    or v_node.node_kind is distinct from v_node_kind
  ) then
    raise exception 'Use the HR employee directory to change a detailed employee name or type.'
      using errcode = '42501';
  end if;

  if v_node_kind <> 'person' and v_node.auth_user_id is not null then
    raise exception 'Disable or relink the portal account before changing this person node.'
      using errcode = '23503';
  end if;

  if p_is_active is false
    and v_node.auth_user_id is not null
    and exists (
      select 1
      from public.profiles profile
      where profile.id = v_node.auth_user_id
        and profile.account_status = 'active'
    ) then
    raise exception 'Disable the portal account before archiving this person.'
      using errcode = '23503';
  end if;

  update public.internal_org_people node
  set company_key = v_company_key,
      node_kind = v_node_kind,
      position_title = btrim(p_position_title),
      full_name = v_full_name,
      parent_id = p_parent_id,
      started_date = case when v_node_kind = 'person' then p_started_date else null end,
      sort_order = p_sort_order,
      is_active = p_is_active,
      updated_by = v_actor
  where node.id = p_node_id
  returning * into v_updated_node;

  if v_node.auth_user_id is not null
    and v_node.full_name is distinct from v_full_name then
    update public.profiles profile
    set full_name = v_full_name,
        updated_at = clock_timestamp()
    where profile.id = v_node.auth_user_id;
  end if;

  return v_updated_node.id;
end;
$$;

revoke all on function private.set_employee_directory_details_updated_at() from public, anon, authenticated;
revoke all on function private.prevent_linked_profile_name_drift() from public, anon, authenticated;
revoke all on function private.normalise_employee_directory_text(text, integer, boolean, text) from public, anon, authenticated;
revoke all on function private.normalise_employee_directory_email(text, text) from public, anon, authenticated;
revoke all on function public.can_manage_employee_directory() from public, anon, authenticated;
revoke all on function public.list_employee_directory_records() from public, anon, authenticated;
revoke all on function public.create_employee_directory_record(
  text, text, text, text, text, text, text, uuid, text, date, date, date, text, boolean, integer
) from public, anon, authenticated;
revoke all on function public.update_employee_directory_record(
  uuid, text, text, text, text, text, text, text, uuid, text, date, date, date, text, boolean, bigint, bigint, integer
) from public, anon, authenticated;
revoke all on function public.update_internal_org_node(
  uuid, text, text, text, text, uuid, date, integer, boolean, bigint
) from public, anon, authenticated;

grant execute on function public.can_manage_employee_directory() to authenticated;
grant execute on function public.list_employee_directory_records() to authenticated;
grant execute on function public.create_employee_directory_record(
  text, text, text, text, text, text, text, uuid, text, date, date, date, text, boolean, integer
) to authenticated;
grant execute on function public.update_employee_directory_record(
  uuid, text, text, text, text, text, text, text, uuid, text, date, date, date, text, boolean, bigint, bigint, integer
) to authenticated;
grant execute on function public.update_internal_org_node(
  uuid, text, text, text, text, uuid, date, integer, boolean, bigint
) to authenticated;

commit;
