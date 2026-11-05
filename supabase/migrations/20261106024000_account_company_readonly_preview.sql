-- Super Admin Change profile must show the granted account's read-only modules.
-- The preview endpoints verify the target employee and can only be called by
-- a real System Admin session. Ordinary employees cannot impersonate targets.

create or replace function public.can_view_accounts_employee_report_for_preview(p_person_id uuid)
returns boolean
language plpgsql stable security definer
set search_path to ''
as $function$
begin
  if not private.is_system_portal_account_admin() then
    raise exception 'Only System Admin may preview Accounts Report access.' using errcode='42501';
  end if;
  return exists (
    select 1
    from private.accounts_report_access_grants grant_row
    join public.internal_org_people person on person.id=grant_row.person_id
    where grant_row.person_id=p_person_id
      and person.node_kind='person' and person.is_active
      and exists (
        select 1 from private.portal_role_policy(person.auth_user_id) policy
        where policy.person_id=person.id and policy.account_status='active'
      )
  );
end;
$function$;
revoke all on function public.can_view_accounts_employee_report_for_preview(uuid) from public, anon;
grant execute on function public.can_view_accounts_employee_report_for_preview(uuid) to authenticated;

create or replace function public.list_people_company_directory_readonly_for_preview(p_person_id uuid)
returns table (
  employee_name text, company text, department text, job_title text,
  work_location text, employment_type text, work_email text, work_phone text
)
language plpgsql stable security definer
set search_path to ''
as $function$
begin
  if not private.is_system_portal_account_admin() or not exists (
    select 1 from private.people_company_read_access_grants grant_row
    join public.internal_org_people target on target.id=grant_row.person_id
    where target.id=p_person_id and target.node_kind='person' and target.is_active
      and exists (
        select 1 from private.portal_role_policy(target.auth_user_id) policy
        where policy.person_id=target.id and policy.app_role='account'
          and policy.account_status='active' and policy.can_view_employee_directory
      )
  ) then
    raise exception 'Company directory preview is not authorised.' using errcode='42501';
  end if;

  return query
  select person.full_name,
    case person.company_key when 'mam' then 'MAM' when 'equipsy' then 'Equipsy' else person.company_key end,
    coalesce(details.team_name,''), person.position_title,
    coalesce(details.location,''), coalesce(details.employment_type,''),
    coalesce(details.work_email,''), coalesce(details.phone,'')
  from public.internal_org_people person
  left join private.employee_directory_details details on details.person_id=person.id
  where person.node_kind='person' and person.is_active
  order by person.full_name;
end;
$function$;
revoke all on function public.list_people_company_directory_readonly_for_preview(uuid) from public, anon;
grant execute on function public.list_people_company_directory_readonly_for_preview(uuid) to authenticated;

create or replace function public.list_people_company_assets_readonly_for_preview(p_person_id uuid)
returns table (
  asset_code text, asset_type text, manufacturer text, model text,
  serial_number text, asset_status text, assigned_person_name text, assigned_on date
)
language plpgsql stable security definer
set search_path to ''
as $function$
begin
  if not private.is_system_portal_account_admin() or not exists (
    select 1 from private.people_company_read_access_grants grant_row
    join public.internal_org_people target on target.id=grant_row.person_id
    where target.id=p_person_id and target.node_kind='person' and target.is_active
      and exists (
        select 1 from private.portal_role_policy(target.auth_user_id) policy
        where policy.person_id=target.id and policy.app_role='account'
          and policy.account_status='active'
      )
  ) then
    raise exception 'Company asset preview is not authorised.' using errcode='42501';
  end if;

  return query
  select projection.asset_code, projection.asset_type,
    projection.manufacturer, projection.model, projection.serial_number,
    projection.asset_status, projection.assigned_person_name, projection.assigned_on
  from private.it_asset_register_projection() projection
  order by projection.asset_code;
end;
$function$;
revoke all on function public.list_people_company_assets_readonly_for_preview(uuid) from public, anon;
grant execute on function public.list_people_company_assets_readonly_for_preview(uuid) to authenticated;
