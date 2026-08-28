begin;

do $$
begin
  perform pg_advisory_xact_lock(
    hashtextextended('mam:employee-preview-it-assets:20260828', 0)
  );

  if to_regclass('private.it_assets') is null
    or to_regclass('public.internal_org_people') is null
    or to_regprocedure('private.is_system_portal_account_admin()') is null then
    raise exception 'Employee device preview prerequisites are missing.' using errcode = '55000';
  end if;
end;
$$;

-- Change profile previews must use the same safe device projection as a real
-- employee. Keep this separate from the full System Admin custody projection:
-- it has no owner metadata, credentials, lifecycle controls or other HR data.
create function public.list_employee_it_assets_for_preview(
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
    raise exception 'Only a System Admin can preview employee devices.' using errcode = '42501';
  end if;

  if p_person_id is null
    or not exists (
      select 1
      from public.internal_org_people person
      where person.id = p_person_id
        and person.node_kind = 'person'
        and person.is_active
    ) then
    raise exception 'The selected employee profile is unavailable.' using errcode = '23503';
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
  where asset.assigned_person_id = p_person_id
    and owner.node_kind = 'person'
    and owner.is_active
    and asset.asset_status <> 'retired'
  order by asset.created_at desc, asset.id desc;
end;
$$;

comment on function public.list_employee_it_assets_for_preview(uuid) is
  'Returns the safe active-device projection for an active employee selected in Change profile. System Admin authorization and the target employee are checked in the database; no credentials or owner metadata are returned.';

revoke all on function public.list_employee_it_assets_for_preview(uuid)
  from public, anon, authenticated;

grant execute on function public.list_employee_it_assets_for_preview(uuid)
  to authenticated;

commit;
