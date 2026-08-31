begin;

-- Device custody needs a durable timeline. The active asset row remains the
-- fast current-register projection; this table retains every accountable
-- employee and the date the device was returned to MAM.
do $$
begin
  perform pg_advisory_xact_lock(
    hashtextextended('mam:it-asset-custody-history:20260831', 0)
  );

  if to_regclass('private.it_assets') is null
    or to_regclass('private.it_asset_audit_events') is null
    or to_regclass('public.internal_org_people') is null
    or to_regprocedure('private.is_system_portal_account_admin()') is null
    or to_regprocedure('private.is_active_it_asset_assignee(uuid)') is null then
    raise exception 'IT asset custody prerequisites are missing.' using errcode = '55000';
  end if;
end;
$$;

create table if not exists private.it_asset_custody_history (
  id uuid primary key default gen_random_uuid(),
  asset_id uuid not null references private.it_assets (id) on delete restrict,
  person_id uuid not null references public.internal_org_people (id) on delete restrict,
  assigned_on date not null,
  returned_on date,
  assigned_by uuid references auth.users (id) on delete set null,
  returned_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  constraint it_asset_custody_return_after_assignment
    check (returned_on is null or returned_on >= assigned_on)
);

comment on table private.it_asset_custody_history is
  'Append-only-by-assignment IT asset custody periods. A returned_on date closes a period without removing the device or its owner history.';

create unique index if not exists it_asset_custody_one_open_period_idx
  on private.it_asset_custody_history (asset_id)
  where returned_on is null;

create index if not exists it_asset_custody_asset_timeline_idx
  on private.it_asset_custody_history (asset_id, assigned_on desc, created_at desc);

create index if not exists it_asset_custody_person_timeline_idx
  on private.it_asset_custody_history (person_id, assigned_on desc, created_at desc);

alter table private.it_asset_custody_history enable row level security;
revoke all on table private.it_asset_custody_history from public, anon, authenticated;

-- Legacy rows were introduced before custody dates existed. Preserve their
-- known owner without guessing a later transfer date: creation date is the
-- earliest durable date available; non-assigned rows are recorded as closed.
insert into private.it_asset_custody_history (
  asset_id,
  person_id,
  assigned_on,
  returned_on,
  assigned_by,
  returned_by,
  created_at,
  updated_at
)
select
  asset.id,
  asset.assigned_person_id,
  timezone('Australia/Melbourne', asset.created_at)::date,
  case
    when asset.asset_status = 'assigned' then null
    else timezone('Australia/Melbourne', asset.updated_at)::date
  end,
  asset.created_by,
  case when asset.asset_status = 'assigned' then null else asset.updated_by end,
  asset.created_at,
  asset.updated_at
from private.it_assets asset
where asset.assigned_person_id is not null
  and not exists (
    select 1
    from private.it_asset_custody_history custody
    where custody.asset_id = asset.id
  );

alter table private.it_asset_audit_events
  drop constraint if exists it_asset_audit_event_type_valid;

alter table private.it_asset_audit_events
  add constraint it_asset_audit_event_type_valid
    check (event_type in ('created', 'reassigned', 'returned', 'retired'));

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
        'assigned_person_id',
        'assigned_on',
        'returned_on'
      ]::text[]
    );

-- A device only needs a current employee while it is actively assigned. A
-- returned/available, repair, or removed record has no current custodian; its
-- historical owner remains in the custody table above.
create or replace function private.validate_it_asset_assignee()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.asset_status = 'assigned' then
    if new.assigned_person_id is null then
      raise exception 'Choose the employee responsible for this device.' using errcode = '23514';
    end if;

    perform private.lock_it_asset_assignee(new.assigned_person_id);

    if not private.is_active_it_asset_assignee(new.assigned_person_id) then
      raise exception 'Choose an active employee responsible for this device.' using errcode = '23503';
    end if;
  elsif new.assigned_person_id is not null then
    raise exception 'Only assigned devices may have a current employee.' using errcode = '23514';
  end if;

  return new;
end;
$$;

alter table private.it_assets
  drop constraint if exists it_assets_assigned_person_required;

alter table private.it_assets
  add constraint it_assets_assignment_matches_status
    check (
      (asset_status = 'assigned' and assigned_person_id is not null)
      or (asset_status in ('available', 'repair', 'retired') and assigned_person_id is null)
    ) not valid;

-- Normalise pre-existing returned/removed rows only after the trigger above
-- permits an asset with no current employee. Their earlier owner is retained
-- by the backfilled custody row.
update private.it_assets asset
set assigned_person_id = null
where asset.asset_status in ('available', 'repair', 'retired')
  and asset.assigned_person_id is not null;

create or replace function private.prevent_it_asset_custodian_deactivation()
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
        and asset.asset_status = 'assigned'
    ) then
      raise exception 'Record the return of this employee''s active IT devices before ending employment.'
        using errcode = '23514';
    end if;
  end if;

  return new;
end;
$$;

-- This trigger owns the custody timeline so all authorised paths (new device,
-- owner transfer, return and mistaken-entry removal) keep the history in sync.
create or replace function private.record_it_asset_custody_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_returned_on date := coalesce(
    nullif(current_setting('app.it_asset_returned_on', true), '')::date,
    timezone('Australia/Melbourne', now())::date
  );
  v_open_custody private.it_asset_custody_history%rowtype;
begin
  if tg_op = 'INSERT' then
    if new.asset_status = 'assigned' then
      insert into private.it_asset_custody_history (
        asset_id,
        person_id,
        assigned_on,
        assigned_by
      )
      values (
        new.id,
        new.assigned_person_id,
        timezone('Australia/Melbourne', now())::date,
        coalesce((select auth.uid()), new.created_by)
      );
    end if;
    return new;
  end if;

  if old.asset_status = 'assigned'
    and old.assigned_person_id is not null
    and (
      new.asset_status <> 'assigned'
      or new.assigned_person_id is distinct from old.assigned_person_id
    ) then
    select custody.* into v_open_custody
    from private.it_asset_custody_history custody
    where custody.asset_id = old.id
      and custody.returned_on is null
    for update;

    if not found then
      raise exception 'This device is missing its active custody record. Refresh and try again.'
        using errcode = '55000';
    end if;

    if v_returned_on < v_open_custody.assigned_on then
      raise exception 'The returned date cannot be before the assigned date.' using errcode = '22023';
    end if;

    update private.it_asset_custody_history custody
    set returned_on = v_returned_on,
        returned_by = coalesce((select auth.uid()), new.updated_by),
        updated_at = clock_timestamp()
    where custody.id = v_open_custody.id;
  end if;

  if new.asset_status = 'assigned'
    and new.assigned_person_id is not null
    and (
      old.asset_status <> 'assigned'
      or new.assigned_person_id is distinct from old.assigned_person_id
    ) then
    insert into private.it_asset_custody_history (
      asset_id,
      person_id,
      assigned_on,
      assigned_by
    )
    values (
      new.id,
      new.assigned_person_id,
      timezone('Australia/Melbourne', now())::date,
      coalesce((select auth.uid()), new.updated_by)
    );
  end if;

  return new;
end;
$$;

drop trigger if exists it_assets_record_custody_history on private.it_assets;
create trigger it_assets_record_custody_history
after insert or update of assigned_person_id, asset_status on private.it_assets
for each row execute function private.record_it_asset_custody_change();

create or replace function private.it_asset_register_projection()
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
  assigned_on date,
  last_returned_on date,
  created_at timestamptz,
  version bigint
)
language sql
stable
security definer
set search_path = ''
as $$
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
    active_custody.assigned_on,
    latest_return.returned_on,
    asset.created_at,
    asset.version
  from private.it_assets asset
  left join public.internal_org_people owner
    on owner.id = asset.assigned_person_id
  left join private.employee_directory_details detail
    on detail.person_id = owner.id
  left join lateral (
    select custody.assigned_on
    from private.it_asset_custody_history custody
    where custody.asset_id = asset.id
      and custody.person_id = asset.assigned_person_id
      and custody.returned_on is null
    order by custody.assigned_on desc, custody.created_at desc, custody.id desc
    limit 1
  ) active_custody on true
  left join lateral (
    select max(custody.returned_on) as returned_on
    from private.it_asset_custody_history custody
    where custody.asset_id = asset.id
      and custody.returned_on is not null
  ) latest_return on true
  where asset.asset_status <> 'retired';
$$;

create function public.list_it_assets_with_custody()
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
  assigned_on date,
  last_returned_on date,
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
  select projection.*
  from private.it_asset_register_projection() projection
  order by projection.created_at desc, projection.asset_id desc;
end;
$$;

create function public.list_it_assets_for_employee_with_custody(
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
  assigned_on date,
  last_returned_on date,
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

  if p_person_id is null then
    raise exception 'The employee record is invalid.' using errcode = '22023';
  end if;

  return query
  select projection.*
  from private.it_asset_register_projection() projection
  where projection.assigned_person_id = p_person_id
  order by projection.created_at desc, projection.asset_id desc;
end;
$$;

create function public.list_it_asset_custody_history(
  p_asset_id uuid default null
)
returns table (
  custody_id uuid,
  asset_id uuid,
  asset_code text,
  asset_type text,
  manufacturer text,
  model text,
  serial_number text,
  person_id uuid,
  person_name text,
  person_title text,
  person_team text,
  assigned_on date,
  returned_on date
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not private.is_system_portal_account_admin() then
    raise exception 'You do not have permission to access IT asset custody history.' using errcode = '42501';
  end if;

  return query
  select
    custody.id,
    asset.id,
    asset.asset_code,
    asset.asset_type,
    asset.manufacturer,
    asset.model,
    asset.serial_number,
    person.id,
    person.full_name,
    person.position_title,
    coalesce(detail.team_name, ''::text),
    custody.assigned_on,
    custody.returned_on
  from private.it_asset_custody_history custody
  join private.it_assets asset on asset.id = custody.asset_id
  join public.internal_org_people person on person.id = custody.person_id
  left join private.employee_directory_details detail on detail.person_id = person.id
  where p_asset_id is null or custody.asset_id = p_asset_id
  order by asset.asset_code, custody.assigned_on desc, custody.created_at desc, custody.id desc;
end;
$$;

create function public.return_it_asset(
  p_asset_id uuid,
  p_expected_version bigint,
  p_returned_on date
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
  assigned_on date,
  last_returned_on date,
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
    raise exception 'You do not have permission to record IT asset returns.' using errcode = '42501';
  end if;

  if p_asset_id is null
    or p_expected_version is null
    or p_expected_version < 1 then
    raise exception 'The device record is invalid.' using errcode = '22023';
  end if;

  if p_returned_on is null then
    raise exception 'Choose the date the hardware was returned.' using errcode = '22004';
  end if;

  if p_returned_on > timezone('Australia/Melbourne', now())::date then
    raise exception 'The hardware returned date cannot be in the future.' using errcode = '22023';
  end if;

  select asset.* into v_asset
  from private.it_assets asset
  where asset.id = p_asset_id
  for update;

  if not found then
    raise exception 'This device is no longer available.' using errcode = 'P0002';
  end if;

  if v_asset.version <> p_expected_version then
    raise exception 'This device has changed. Refresh it, then try again.' using errcode = '40001';
  end if;

  if v_asset.asset_status <> 'assigned' or v_asset.assigned_person_id is null then
    raise exception 'This device is not currently assigned.' using errcode = '22023';
  end if;

  perform set_config('app.it_asset_returned_on', p_returned_on::text, true);

  update private.it_assets asset
  set asset_status = 'available',
      assigned_person_id = null,
      updated_by = v_actor_user_id
  where asset.id = v_asset.id
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
    'returned',
    array['asset_status', 'assigned_person_id', 'returned_on']::text[]
  );

  return query
  select projection.*
  from private.it_asset_register_projection() projection
  where projection.asset_id = v_asset.id;
end;
$$;

-- A mistaken-entry removal is deliberately separate from a return. It removes
-- the record from the active register, while retaining its immutable audit and
-- any recorded custody periods for defensible historical reporting.
create or replace function public.retire_it_asset(
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
  v_previous_assigned_person_id uuid;
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

  select asset.* into v_asset
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

  v_previous_assigned_person_id := v_asset.assigned_person_id;

  update private.it_assets asset
  set asset_status = 'retired',
      assigned_person_id = null,
      updated_by = v_actor_user_id
  where asset.id = v_asset.id
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
    array_remove(
      array[
        'asset_status',
        case when v_previous_assigned_person_id is not null then 'assigned_person_id' end,
        case when v_previous_assigned_person_id is not null then 'returned_on' end
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
  left join public.internal_org_people owner on owner.id = asset.assigned_person_id
  left join private.employee_directory_details detail on detail.person_id = owner.id
  where asset.id = v_asset.id;
end;
$$;

revoke all on function private.record_it_asset_custody_change() from public, anon, authenticated;
revoke all on function private.it_asset_register_projection() from public, anon, authenticated;
revoke all on function public.list_it_assets_with_custody() from public, anon, authenticated;
revoke all on function public.list_it_assets_for_employee_with_custody(uuid) from public, anon, authenticated;
revoke all on function public.list_it_asset_custody_history(uuid) from public, anon, authenticated;
revoke all on function public.return_it_asset(uuid, bigint, date) from public, anon, authenticated;
revoke all on function public.retire_it_asset(uuid, bigint) from public, anon, authenticated;

grant execute on function public.list_it_assets_with_custody() to authenticated;
grant execute on function public.list_it_assets_for_employee_with_custody(uuid) to authenticated;
grant execute on function public.list_it_asset_custody_history(uuid) to authenticated;
grant execute on function public.return_it_asset(uuid, bigint, date) to authenticated;
grant execute on function public.retire_it_asset(uuid, bigint) to authenticated;

commit;
