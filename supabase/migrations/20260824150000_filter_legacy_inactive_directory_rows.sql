begin;

-- Legacy roster imports used inactive organisation rows before employee
-- lifecycle archiving existed. They are not archived employee profiles and
-- must not appear beside profiles archived through the HR archive flow.
create or replace function public.list_employee_directory_records_with_archive_visibility(
  p_include_archived boolean default false
)
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
  address text,
  date_of_birth date,
  started_date date,
  scheduled_employment_end_date date,
  archive_reason text,
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
  if not private.can_view_archived_employee_profiles() then
    raise exception 'Only authorised HR and global reviewers can access employee directory records.'
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
    manager.manager_id,
    manager.manager_name,
    detail.work_email,
    detail.personal_email,
    detail.phone,
    detail.country,
    detail.address,
    detail.date_of_birth,
    person.started_date,
    detail.scheduled_employment_end_date,
    detail.archive_reason,
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
    and (
      person.is_active
      or (
        coalesce(p_include_archived, false)
        and detail.archive_reason is not null
      )
    )
  order by person.is_active desc, lower(person.full_name), person.id;
end;
$$;

comment on function public.list_employee_directory_records_with_archive_visibility(boolean) is
  'Returns active records and only lifecycle-archived records with a confirmed archive reason.';

revoke all on function public.list_employee_directory_records_with_archive_visibility(boolean)
  from public, anon, authenticated;
grant execute on function public.list_employee_directory_records_with_archive_visibility(boolean)
  to authenticated;

commit;
