begin;

-- Managers may view their own narrow work-directory record alongside the
-- active direct and indirect reports they manage. This changes only the read
-- projection: the manager update RPC remains descendant-only, so a manager
-- cannot alter their own work identity through the team directory.
create or replace function private.list_manager_employee_directory_records_for_scope(
  p_manager_person_id uuid
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
  manager_name text,
  work_email text
)
language sql
stable
security definer
set search_path = ''
as $$
  with scoped_people as (
    select p_manager_person_id as person_id

    union

    select scope.person_id
    from private.list_active_manager_directory_descendants(p_manager_person_id) scope
  )
  select
    person.id,
    person.version,
    coalesce(detail.version, 0::bigint),
    person.company_key,
    person.is_active,
    coalesce(detail.first_name, person.full_name),
    coalesce(detail.last_name, ''::text),
    person.full_name,
    person.position_title,
    coalesce(detail.team_name, ''::text),
    coalesce(manager.manager_name, ''::text),
    coalesce(detail.work_email, ''::text)
  from scoped_people scope
  join public.internal_org_people person on person.id = scope.person_id
  left join private.employee_directory_details detail on detail.person_id = person.id
  left join lateral private.resolve_internal_org_employee_manager(person.id) manager on true
  where person.node_kind = 'person'
    and person.is_active
  order by lower(person.full_name), person.id;
$$;

comment on function private.list_manager_employee_directory_records_for_scope(uuid) is
  'Returns a manager''s own active narrow work-directory record plus active direct and indirect reports.';

comment on function public.list_managed_employee_directory_records() is
  'Returns the current manager''s own active work-directory record plus active direct and indirect reports using a narrow projection.';

comment on function public.list_managed_employee_directory_records_for_preview(uuid) is
  'System Admin-only preview of an active manager''s own narrow work-directory record plus their active team.';

commit;
