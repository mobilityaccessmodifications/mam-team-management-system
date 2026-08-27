begin;

-- The first durable IT asset boundary. Device inventory is deliberately kept
-- separate from the one-to-one HR employee-detail record: a person can hold
-- several devices and an asset must retain its own lifecycle/audit history.
do $$
begin
  perform pg_advisory_xact_lock(
    hashtextextended('mam:it-assets:20260827', 0)
  );

  if to_regclass('public.profiles') is null
    or to_regprocedure('private.is_system_portal_account_admin()') is null then
    raise exception 'IT asset register prerequisites are missing.' using errcode = '55000';
  end if;
end;
$$;

create sequence private.it_asset_code_sequence
  as bigint
  start with 1
  increment by 1
  minvalue 1;

create table private.it_assets (
  id uuid primary key default gen_random_uuid(),
  asset_code text not null,
  asset_type text not null,
  manufacturer text,
  model text,
  serial_number text,
  asset_status text not null default 'available',
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  created_by uuid references auth.users (id) on delete set null,
  updated_by uuid references auth.users (id) on delete set null,
  version bigint not null default 1,
  constraint it_assets_asset_code_format
    check (
      asset_code = btrim(asset_code)
      and char_length(asset_code) <= 64
      and asset_code ~ '^MAM-IT-[0-9]{6,}$'
    ),
  constraint it_assets_asset_type_valid
    check (asset_type in (
      'laptop',
      'desktop',
      'iphone',
      'ipad',
      'tablet',
      'mobile_phone',
      'monitor',
      'keyboard',
      'mouse',
      'sim',
      'other'
    )),
  constraint it_assets_manufacturer_valid
    check (
      manufacturer is null
      or (manufacturer = btrim(manufacturer) and char_length(manufacturer) between 1 and 80)
    ),
  constraint it_assets_model_valid
    check (
      model is null
      or (model = btrim(model) and char_length(model) between 1 and 120)
    ),
  constraint it_assets_serial_number_valid
    check (
      serial_number is null
      or (serial_number = btrim(serial_number) and char_length(serial_number) between 1 and 128)
    ),
  constraint it_assets_asset_status_valid
    check (asset_status in ('available', 'assigned', 'repair', 'retired')),
  constraint it_assets_version_positive check (version > 0)
);

comment on table private.it_assets is
  'System Admin-only MAM device inventory. Barcode payload is the non-secret asset_code; no passcodes, accounts or recovery details belong here.';

create unique index it_assets_asset_code_unique_idx
  on private.it_assets (lower(asset_code));

create unique index it_assets_serial_number_unique_idx
  on private.it_assets (lower(serial_number))
  where serial_number is not null;

create table private.it_asset_audit_events (
  id bigint generated always as identity primary key,
  asset_id uuid not null references private.it_assets (id) on delete restrict,
  actor_user_id uuid references auth.users (id) on delete set null,
  event_type text not null check (event_type in ('created')),
  changed_fields text[] not null default array[]::text[],
  created_at timestamptz not null default clock_timestamp(),
  constraint it_asset_audit_changed_fields_valid
    check (changed_fields <@ array['asset_code', 'asset_type', 'manufacturer', 'model', 'serial_number', 'asset_status']::text[])
);

comment on table private.it_asset_audit_events is
  'Append-only IT asset audit. It records only field names, never device passcodes, account credentials or before/after values.';

alter table private.it_assets enable row level security;
alter table private.it_asset_audit_events enable row level security;

revoke all on table private.it_assets from public, anon, authenticated;
revoke all on table private.it_asset_audit_events from public, anon, authenticated;
revoke all on sequence private.it_asset_code_sequence from public, anon, authenticated;

create or replace function public.can_manage_it_assets()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.is_system_portal_account_admin();
$$;

comment on function public.can_manage_it_assets() is
  'Returns whether the current active System Admin may access the MAM IT asset register.';

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
    asset.created_at,
    asset.version
  from private.it_assets asset
  order by asset.created_at desc, asset.id desc;
end;
$$;

create function public.create_it_asset(
  p_asset_type text,
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
    created_by,
    updated_by
  )
  values (
    v_asset_code,
    v_asset_type,
    v_manufacturer,
    v_model,
    v_serial_number,
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
        'asset_status'
      ]::text[],
      null
    )
  );

  return query
  select
    v_asset.id,
    v_asset.asset_code,
    v_asset.asset_code,
    v_asset.asset_type,
    v_asset.manufacturer,
    v_asset.model,
    v_asset.serial_number,
    v_asset.asset_status,
    v_asset.created_at,
    v_asset.version;
end;
$$;

revoke all on function public.can_manage_it_assets() from public, anon, authenticated;
revoke all on function public.list_it_assets() from public, anon, authenticated;
revoke all on function public.create_it_asset(text, text, text, text) from public, anon, authenticated;

grant execute on function public.can_manage_it_assets() to authenticated;
grant execute on function public.list_it_assets() to authenticated;
grant execute on function public.create_it_asset(text, text, text, text) to authenticated;

commit;
