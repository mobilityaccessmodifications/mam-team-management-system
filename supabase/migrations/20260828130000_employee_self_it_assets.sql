begin;

do $$
begin
  perform pg_advisory_xact_lock(
    hashtextextended('mam:employee-self-it-assets:20260828', 0)
  );

  if to_regclass('private.it_assets') is null
    or to_regclass('public.internal_org_people') is null
    or to_regprocedure('private.current_active_portal_employee_id()') is null then
    raise exception 'Employee device projection prerequisites are missing.' using errcode = '55000';
  end if;
end;
$$;

-- The employee directory may show a person's own assigned hardware, but it
-- must never accept a browser-supplied person id. The current linked person is
-- resolved from auth.uid() by the existing self-service helper.
create function public.list_my_it_assets()
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
declare
  v_person_id uuid := private.current_active_portal_employee_id();
begin
  if v_person_id is null then
    raise exception 'An active linked portal account is required.' using errcode = '42501';
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
  join public.internal_org_people owner
    on owner.id = asset.assigned_person_id
  where asset.assigned_person_id = v_person_id
    and owner.auth_user_id = (select auth.uid())
    and owner.node_kind = 'person'
    and owner.is_active
    and asset.asset_status <> 'retired'
  order by asset.created_at desc, asset.id desc;
end;
$$;

comment on function public.list_my_it_assets() is
  'Returns only active IT devices assigned to the current authenticated employee. The owner is derived from auth.uid(); no person id or credential data is accepted or returned.';

revoke all on function public.list_my_it_assets()
  from public, anon, authenticated;

grant execute on function public.list_my_it_assets()
  to authenticated;

commit;
