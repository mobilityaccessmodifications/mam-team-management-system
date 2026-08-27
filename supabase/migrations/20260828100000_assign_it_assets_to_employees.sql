begin;

-- Device custody is part of the register, not a free-text HR note. Every new
-- or changed device must point to an active employee record, while a NOT VALID
-- check lets a pre-existing register be safely brought into compliance without
-- inventing an owner during this rollout.
do $$
begin
  perform pg_advisory_xact_lock(
    hashtextextended('mam:it-asset-assignment:20260828', 0)
  );

  if to_regclass('private.it_assets') is null
    or to_regclass('private.it_asset_audit_events') is null
    or to_regclass('public.internal_org_people') is null
    or to_regclass('private.employee_directory_details') is null
    or to_regprocedure('private.is_system_portal_account_admin()') is null then
    raise exception 'IT asset assignment prerequisites are missing.' using errcode = '55000';
  end if;
end;
$$;

alter table private.it_assets
  add column assigned_person_id uuid
    references public.internal_org_people (id) on delete restrict;

comment on column private.it_assets.assigned_person_id is
  'The active MAM or Equipsy employee who is accountable for this device. New and updated device records must always have a value.';

create index it_assets_assigned_person_active_idx
  on private.it_assets (assigned_person_id, updated_at desc)
  where asset_status <> 'retired';

-- Existing asset rows are deliberately not assigned to a guessed person. The
-- constraint validates every newly created or changed row and can be validated
-- once any historic rows have been explicitly assigned in the UI.
alter table private.it_assets
  add constraint it_assets_assigned_person_required
    check (assigned_person_id is not null) not valid;

alter table private.it_asset_audit_events
  drop constraint if exists it_asset_audit_events_event_type_check;

alter table private.it_asset_audit_events
  add constraint it_asset_audit_event_type_valid
    check (event_type in ('created', 'reassigned', 'retired'));

alter table private.it_asset_audit_events
  drop constraint if exists it_asset_audit_changed_fields_valid;

alter table private.it_asset_audit_events
  add constraint it_asset_audit_changed_fields_valid
    check (
      changed_fields <@ array[
        'asset_code',
        'asset_type',
        'manufacturer',
        'model',
        'serial_number',
        'asset_status',
        'assigned_person_id'
      ]::text[]
    );

create function private.is_active_it_asset_assignee(
  p_person_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_person_id is not null
    and exists (
      select 1
      from public.internal_org_people person
      where person.id = p_person_id
        and person.node_kind = 'person'
        and person.is_active
    );
$$;

-- The device-side and employee-side checks take the same per-person advisory
-- lock. That prevents a device assignment and an employment deactivation from
-- crossing in separate transactions and leaving an active device with an
-- inactive custodian.
create function private.lock_it_asset_assignee(
  p_person_id uuid
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if p_person_id is not null then
    perform pg_advisory_xact_lock(
      hashtextextended('mam:it-asset-assignee:' || p_person_id::text, 0)
    );
  end if;
end;
$$;

create function private.validate_it_asset_assignee()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.assigned_person_id is null then
    raise exception 'Choose the employee responsible for this device.' using errcode = '23514';
  end if;

  perform private.lock_it_asset_assignee(new.assigned_person_id);

  if not private.is_active_it_asset_assignee(new.assigned_person_id) then
    raise exception 'Choose an active employee responsible for this device.' using errcode = '23503';
  end if;

  return new;
end;
$$;

create function private.set_it_asset_updated_at()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  new.updated_at = clock_timestamp();
  new.updated_by = coalesce((select auth.uid()), new.updated_by, old.updated_by);
  new.version = old.version + 1;
  return new;
end;
$$;

create trigger it_assets_validate_assignee
before insert or update on private.it_assets
for each row execute function private.validate_it_asset_assignee();

create trigger it_assets_set_updated_at
before update on private.it_assets
for each row execute function private.set_it_asset_updated_at();

create function private.prevent_it_asset_custodian_deactivation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.node_kind = 'person'
    and old.is_active
    and not new.is_active then
    perform private.lock_it_asset_assignee(old.id);

    if exists (
      select 1
      from private.it_assets asset
      where asset.assigned_person_id = old.id
        and asset.asset_status <> 'retired'
    ) then
      raise exception 'Reassign or remove this employee''s active IT devices before ending employment.'
        using errcode = '23514';
    end if;
  end if;

  return new;
end;
$$;

create trigger internal_org_people_prevent_it_asset_custodian_deactivation
before update of is_active on public.internal_org_people
for each row execute function private.prevent_it_asset_custodian_deactivation();

-- Replace the original asset register projection/signature. The old create
-- function is intentionally removed so no stale client can create an ownerless
-- device after this migration.
drop function public.list_it_assets();
drop function public.create_it_asset(text, text, text, text);

create function public.list_it_assets()
returns table (
  asset_id uuid,
  asset_code text,
  barcode_value text,
  asset_type text,
  manufacturer text,
  model text,
  serial_number text,
  asset_status text,
  assigned_person_id uuid,
  assigned_person_name text,
  assigned_person_title text,
  assigned_person_team text,
  created_at timestamptz,
  version bigint
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not private.is_system_portal_account_admin() then
    raise exception 'You do not have permission to access IT assets.' using errcode = '42501';
  end if;

  return query
  select
    asset.id,
    asset.asset_code,
    asset.asset_code,
    asset.asset_type,
    asset.manufacturer,
    asset.model,
    asset.serial_number,
    asset.asset_status,
    owner.id,
    owner.full_name,
    owner.position_title,
    coalesce(detail.team_name, ''::text),
    asset.created_at,
    asset.version
  from private.it_assets asset
  left join public.internal_org_people owner on owner.id = asset.assigned_person_id
  left join private.employee_directory_details detail on detail.person_id = owner.id
  where asset.asset_status <> 'retired'
  order by asset.created_at desc, asset.id desc;
end;
$$;

create function public.list_it_asset_assignees()
returns table (
  person_id uuid,
  full_name text,
  position_title text,
  team_name text,
  company_key text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not private.is_system_portal_account_admin() then
    raise exception 'You do not have permission to access IT assets.' using errcode = '42501';
  end if;

  return query
  select
    person.id,
    person.full_name,
    person.position_title,
    coalesce(detail.team_name, ''::text),
    person.company_key
  from public.internal_org_people person
  left join private.employee_directory_details detail on detail.person_id = person.id
  where person.node_kind = 'person'
    and person.is_active
  order by lower(person.full_name), person.id;
end;
$$;

create function public.list_it_assets_for_employee(
  p_person_id uuid
)
returns table (
  asset_id uuid,
  asset_code text,
  barcode_value text,
  asset_type text,
  manufacturer text,
  model text,
  serial_number text,
  asset_status text,
  assigned_person_id uuid,
  assigned_person_name text,
  assigned_person_title text,
  assigned_person_team text,
  created_at timestamptz,
  version bigint
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not private.is_system_portal_account_admin() then
    raise exception 'You do not have permission to access IT assets.' using errcode = '42501';
  end if;

  return query
  select
    asset.id,
    asset.asset_code,
    asset.asset_code,
    asset.asset_type,
    asset.manufacturer,
    asset.model,
    asset.serial_number,
    asset.asset_status,
    owner.id,
    owner.full_name,
    owner.position_title,
    coalesce(detail.team_name, ''::text),
    asset.created_at,
    asset.version
  from private.it_assets asset
  join public.internal_org_people owner on owner.id = asset.assigned_person_id
  left join private.employee_directory_details detail on detail.person_id = owner.id
  where asset.assigned_person_id = p_person_id
    and asset.asset_status <> 'retired'
  order by asset.created_at desc, asset.id desc;
end;
$$;

create function public.create_it_asset(
  p_asset_type text,
  p_assigned_person_id uuid,
  p_manufacturer text default null,
  p_model text default null,
  p_serial_number text default null
)
returns table (
  asset_id uuid,
  asset_code text,
  barcode_value text,
  asset_type text,
  manufacturer text,
  model text,
  serial_number text,
  asset_status text,
  assigned_person_id uuid,
  assigned_person_name text,
  assigned_person_title text,
  assigned_person_team text,
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
  v_asset_type text := lower(btrim(coalesce(p_asset_type, '')));
  v_manufacturer text := nullif(btrim(coalesce(p_manufacturer, '')), '');
  v_model text := nullif(btrim(coalesce(p_model, '')), '');
  v_serial_number text := nullif(btrim(coalesce(p_serial_number, '')), '');
  v_asset_code text;
  v_asset private.it_assets%rowtype;
begin
  if v_actor_user_id is null
    or not private.is_system_portal_account_admin() then
    raise exception 'You do not have permission to create IT assets.' using errcode = '42501';
  end if;

  if v_asset_type not in (
    'laptop', 'desktop', 'iphone', 'ipad', 'tablet', 'mobile_phone',
    'monitor', 'keyboard', 'mouse', 'sim', 'other'
  ) then
    raise exception 'Choose a valid device type.' using errcode = '22023';
  end if;

  if not private.is_active_it_asset_assignee(p_assigned_person_id) then
    raise exception 'Choose an active employee responsible for this device.' using errcode = '23503';
  end if;

  if v_manufacturer is not null and char_length(v_manufacturer) > 80 then
    raise exception 'Manufacturer must be 80 characters or fewer.' using errcode = '22023';
  end if;

  if v_model is not null and char_length(v_model) > 120 then
    raise exception 'Model must be 120 characters or fewer.' using errcode = '22023';
  end if;

  if v_serial_number is not null and char_length(v_serial_number) > 128 then
    raise exception 'Serial number must be 128 characters or fewer.' using errcode = '22023';
  end if;

  v_asset_code := 'MAM-IT-' || lpad(
    nextval('private.it_asset_code_sequence'::regclass)::text,
    6,
    '0'
  );

  insert into private.it_assets (
    asset_code,
    asset_type,
    manufacturer,
    model,
    serial_number,
    asset_status,
    assigned_person_id,
    created_by,
    updated_by
  )
  values (
    v_asset_code,
    v_asset_type,
    v_manufacturer,
    v_model,
    v_serial_number,
    'assigned',
    p_assigned_person_id,
    v_actor_user_id,
    v_actor_user_id
  )
  returning * into v_asset;

  insert into private.it_asset_audit_events (
    asset_id,
    actor_user_id,
    event_type,
    changed_fields
  )
  values (
    v_asset.id,
    v_actor_user_id,
    'created',
    array_remove(
      array[
        'asset_code',
        'asset_type',
        case when v_manufacturer is not null then 'manufacturer' end,
        case when v_model is not null then 'model' end,
        case when v_serial_number is not null then 'serial_number' end,
        'asset_status',
        'assigned_person_id'
      ]::text[],
      null
    )
  );

  return query
  select
    asset.id,
    asset.asset_code,
    asset.asset_code,
    asset.asset_type,
    asset.manufacturer,
    asset.model,
    asset.serial_number,
    asset.asset_status,
    owner.id,
    owner.full_name,
    owner.position_title,
    coalesce(detail.team_name, ''::text),
    asset.created_at,
    asset.version
  from private.it_assets asset
  join public.internal_org_people owner on owner.id = asset.assigned_person_id
  left join private.employee_directory_details detail on detail.person_id = owner.id
  where asset.id = v_asset.id;
end;
$$;

create function public.reassign_it_asset(
  p_asset_id uuid,
  p_assigned_person_id uuid,
  p_expected_version bigint
)
returns table (
  asset_id uuid,
  asset_code text,
  barcode_value text,
  asset_type text,
  manufacturer text,
  model text,
  serial_number text,
  asset_status text,
  assigned_person_id uuid,
  assigned_person_name text,
  assigned_person_title text,
  assigned_person_team text,
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
  v_asset private.it_assets%rowtype;
  v_previous_assigned_person_id uuid;
  v_previous_status text;
begin
  if v_actor_user_id is null
    or not private.is_system_portal_account_admin() then
    raise exception 'You do not have permission to update IT assets.' using errcode = '42501';
  end if;

  if p_asset_id is null
    or p_expected_version is null
    or p_expected_version < 1 then
    raise exception 'The device record is invalid.' using errcode = '22023';
  end if;

  if not private.is_active_it_asset_assignee(p_assigned_person_id) then
    raise exception 'Choose an active employee responsible for this device.' using errcode = '23503';
  end if;

  select asset.*
  into v_asset
  from private.it_assets asset
  where asset.id = p_asset_id
  for update;

  if not found then
    raise exception 'This device is no longer available.' using errcode = 'P0002';
  end if;

  if v_asset.version <> p_expected_version then
    raise exception 'This device has changed. Refresh it, then try again.' using errcode = '40001';
  end if;

  if v_asset.asset_status = 'retired' then
    raise exception 'A removed device cannot be reassigned.' using errcode = '22023';
  end if;

  v_previous_assigned_person_id := v_asset.assigned_person_id;
  v_previous_status := v_asset.asset_status;

  if v_previous_assigned_person_id is distinct from p_assigned_person_id
    or v_previous_status = 'available' then
    update private.it_assets asset
    set assigned_person_id = p_assigned_person_id,
        asset_status = case when asset.asset_status = 'available' then 'assigned' else asset.asset_status end,
        updated_by = v_actor_user_id
    where asset.id = p_asset_id
    returning * into v_asset;

    insert into private.it_asset_audit_events (
      asset_id,
      actor_user_id,
      event_type,
      changed_fields
    )
    values (
      v_asset.id,
      v_actor_user_id,
      'reassigned',
      array_remove(
        array[
          case when v_previous_assigned_person_id is distinct from p_assigned_person_id then 'assigned_person_id' end,
          case when v_previous_status = 'available' then 'asset_status' end
        ]::text[],
        null
      )
    );
  end if;

  return query
  select
    asset.id,
    asset.asset_code,
    asset.asset_code,
    asset.asset_type,
    asset.manufacturer,
    asset.model,
    asset.serial_number,
    asset.asset_status,
    owner.id,
    owner.full_name,
    owner.position_title,
    coalesce(detail.team_name, ''::text),
    asset.created_at,
    asset.version
  from private.it_assets asset
  join public.internal_org_people owner on owner.id = asset.assigned_person_id
  left join private.employee_directory_details detail on detail.person_id = owner.id
  where asset.id = v_asset.id;
end;
$$;

create function public.retire_it_asset(
  p_asset_id uuid,
  p_expected_version bigint
)
returns table (
  asset_id uuid,
  asset_code text,
  barcode_value text,
  asset_type text,
  manufacturer text,
  model text,
  serial_number text,
  asset_status text,
  assigned_person_id uuid,
  assigned_person_name text,
  assigned_person_title text,
  assigned_person_team text,
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
  v_asset private.it_assets%rowtype;
begin
  if v_actor_user_id is null
    or not private.is_system_portal_account_admin() then
    raise exception 'You do not have permission to remove IT assets.' using errcode = '42501';
  end if;

  if p_asset_id is null
    or p_expected_version is null
    or p_expected_version < 1 then
    raise exception 'The device record is invalid.' using errcode = '22023';
  end if;

  select asset.*
  into v_asset
  from private.it_assets asset
  where asset.id = p_asset_id
  for update;

  if not found then
    raise exception 'This device is no longer available.' using errcode = 'P0002';
  end if;

  if v_asset.version <> p_expected_version then
    raise exception 'This device has changed. Refresh it, then try again.' using errcode = '40001';
  end if;

  if v_asset.asset_status = 'retired' then
    raise exception 'This device has already been removed.' using errcode = '22023';
  end if;

  if v_asset.assigned_person_id is null then
    raise exception 'Choose the employee responsible for this legacy device before removing it.' using errcode = '23514';
  end if;

  update private.it_assets asset
  set asset_status = 'retired',
      updated_by = v_actor_user_id
  where asset.id = p_asset_id
  returning * into v_asset;

  insert into private.it_asset_audit_events (
    asset_id,
    actor_user_id,
    event_type,
    changed_fields
  )
  values (
    v_asset.id,
    v_actor_user_id,
    'retired',
    array['asset_status']::text[]
  );

  return query
  select
    asset.id,
    asset.asset_code,
    asset.asset_code,
    asset.asset_type,
    asset.manufacturer,
    asset.model,
    asset.serial_number,
    asset.asset_status,
    owner.id,
    owner.full_name,
    owner.position_title,
    coalesce(detail.team_name, ''::text),
    asset.created_at,
    asset.version
  from private.it_assets asset
  join public.internal_org_people owner on owner.id = asset.assigned_person_id
  left join private.employee_directory_details detail on detail.person_id = owner.id
  where asset.id = v_asset.id;
end;
$$;

revoke all on function private.is_active_it_asset_assignee(uuid) from public, anon, authenticated;
revoke all on function private.lock_it_asset_assignee(uuid) from public, anon, authenticated;
revoke all on function private.validate_it_asset_assignee() from public, anon, authenticated;
revoke all on function private.set_it_asset_updated_at() from public, anon, authenticated;
revoke all on function private.prevent_it_asset_custodian_deactivation() from public, anon, authenticated;
revoke all on function public.list_it_assets() from public, anon, authenticated;
revoke all on function public.list_it_asset_assignees() from public, anon, authenticated;
revoke all on function public.list_it_assets_for_employee(uuid) from public, anon, authenticated;
revoke all on function public.create_it_asset(text, uuid, text, text, text) from public, anon, authenticated;
revoke all on function public.reassign_it_asset(uuid, uuid, bigint) from public, anon, authenticated;
revoke all on function public.retire_it_asset(uuid, bigint) from public, anon, authenticated;

grant execute on function public.list_it_assets() to authenticated;
grant execute on function public.list_it_asset_assignees() to authenticated;
grant execute on function public.list_it_assets_for_employee(uuid) to authenticated;
grant execute on function public.create_it_asset(text, uuid, text, text, text) to authenticated;
grant execute on function public.reassign_it_asset(uuid, uuid, bigint) to authenticated;
grant execute on function public.retire_it_asset(uuid, bigint) to authenticated;

commit;
