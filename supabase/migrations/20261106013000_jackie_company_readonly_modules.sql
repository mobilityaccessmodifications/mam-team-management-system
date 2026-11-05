-- Named, account-scoped company-wide viewing access. Does not grant HR edits,
-- asset mutations, subscription management or broader reviews/check-ins.
create table if not exists private.people_company_read_access_grants (
  person_id uuid primary key references public.internal_org_people(id) on delete cascade,
  granted_at timestamptz not null default clock_timestamp()
);
revoke all on private.people_company_read_access_grants from public, anon, authenticated;
insert into private.people_company_read_access_grants(person_id)
values ('22f7630d-2154-4958-9e3b-ee1f1e19072c')
on conflict (person_id) do nothing;

do $do$
declare
  v_source text;
  v_next text;
begin
  select pg_get_functiondef(p.oid) into v_source
  from pg_proc p
  where p.oid = 'private.portal_role_policy(uuid)'::regprocedure;
  if position('company_reader' in v_source) > 0 then
    return;
  end if;
  v_next := replace(v_source,
    $old$target.app_role='account' as account$old$,
    $new$target.app_role='account' as account,
      (target.app_role='account' and exists (
        select 1 from private.people_company_read_access_grants grant_row
        where grant_row.person_id=target.person_id
      )) as company_reader$new$);
  v_next := replace(v_next,
    $old$p0, operational, manager or operational, operational,$old$,
    $new$p0, operational, manager or operational or company_reader, operational,$new$);
  v_next := replace(v_next,
    $old$manager or operational, operational, p0, manager or operational,$old$,
    $new$manager or operational or company_reader, operational, p0, manager or operational,$new$);
  v_next := replace(v_next,
    $old$operational, manager or operational or (policy.app_role=$old$,
    $new$operational, manager or operational or company_reader or (policy.app_role=$new$);
  if v_next=v_source or
     position('company_reader, operational' in v_next)=0 or
     position('manager or operational or company_reader or (policy.app_role=' in v_next)=0 then
    raise exception 'Role policy signature changed; do not apply access patch';
  end if;
  execute v_next;
end
$do$;

create or replace function public.list_people_company_directory_readonly()
returns table (
  employee_name text, company text, department text, job_title text,
  work_location text, employment_type text, work_email text, work_phone text
)
language plpgsql stable security definer
set search_path to ''
as $function$
begin
  if not exists (
    select 1 from private.portal_role_policy() policy
    join private.people_company_read_access_grants grant_row on grant_row.person_id=policy.person_id
    where policy.app_role='account' and policy.account_status='active'
      and policy.can_view_employee_directory
  ) then
    raise exception 'Company directory viewing is not authorised.' using errcode='42501';
  end if;
  return query
  select person.full_name, case person.company_key when 'mam' then 'MAM' when 'equipsy' then 'Equipsy' else person.company_key end,
    coalesce(details.team_name,''),person.position_title,
    coalesce(details.location,''),coalesce(details.employment_type,''),
    coalesce(details.work_email,''),coalesce(details.phone,'')
  from public.internal_org_people person
  left join private.employee_directory_details details on details.person_id=person.id
  where person.node_kind='person' and person.is_active
  order by person.full_name;
end
$function$;
revoke all on function public.list_people_company_directory_readonly() from public, anon;
grant execute on function public.list_people_company_directory_readonly() to authenticated;

create or replace function public.list_people_company_assets_readonly()
returns table (
  asset_code text, asset_type text, manufacturer text, model text,
  serial_number text, asset_status text, assigned_person_name text, assigned_on date
)
language plpgsql stable security definer
set search_path to ''
as $function$
begin
  if not exists (
    select 1 from private.portal_role_policy() policy
    join private.people_company_read_access_grants grant_row on grant_row.person_id=policy.person_id
    where policy.app_role='account' and policy.account_status='active'
  ) then
    raise exception 'Company asset viewing is not authorised.' using errcode='42501';
  end if;
  return query select projection.asset_code, projection.asset_type,
    projection.manufacturer, projection.model, projection.serial_number,
    projection.asset_status, projection.assigned_person_name, projection.assigned_on
  from private.it_asset_register_projection() projection
  order by projection.asset_code;
end
$function$;
revoke all on function public.list_people_company_assets_readonly() from public, anon;
grant execute on function public.list_people_company_assets_readonly() to authenticated;
