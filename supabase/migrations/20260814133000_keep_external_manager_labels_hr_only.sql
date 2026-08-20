begin;

-- The authoritative roster may contain managers who are intentionally not
-- employees or portal users. Their original Excel Manager labels are private
-- HR data. HR directory/export functions may use the private registry, but an
-- ordinary employee's self-profile must never receive that private label.
create or replace function public.get_my_employee_profile()
returns table (
  person_id uuid,
  person_version bigint,
  detail_version bigint,
  has_detail boolean,
  full_name text,
  position_title text,
  company_key text,
  team_name text,
  manager_id uuid,
  manager_name text,
  work_email text,
  personal_email text,
  phone text,
  date_of_birth date
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
    person.id,
    person.version,
    coalesce(detail.version, 0::bigint),
    detail.person_id is not null,
    person.full_name,
    person.position_title,
    person.company_key,
    detail.team_name,
    manager.manager_id,
    manager.manager_name,
    detail.work_email,
    detail.personal_email,
    detail.phone,
    detail.date_of_birth
  from public.internal_org_people person
  left join private.employee_directory_details detail
    on detail.person_id = person.id
  left join lateral (
    with recursive ancestors as (
      select
        parent.id,
        parent.full_name,
        parent.position_title,
        parent.parent_id,
        parent.node_kind,
        parent.is_active,
        1 as depth
      from public.internal_org_people parent
      where parent.id = person.parent_id

      union all

      select
        parent.id,
        parent.full_name,
        parent.position_title,
        parent.parent_id,
        parent.node_kind,
        parent.is_active,
        ancestors.depth + 1
      from public.internal_org_people parent
      join ancestors on parent.id = ancestors.parent_id
    )
    select
      (
        select ancestor.id
        from ancestors ancestor
        where ancestor.node_kind = 'person'
          and ancestor.is_active
        order by ancestor.depth
        limit 1
      ) as manager_id,
      coalesce(
        (
          select ancestor.full_name
          from ancestors ancestor
          where ancestor.node_kind = 'person'
            and ancestor.is_active
          order by ancestor.depth
          limit 1
        ),
        (
          select ancestor.position_title
          from ancestors ancestor
          where ancestor.node_kind = 'org_unit'
            and ancestor.is_active
          order by ancestor.depth
          limit 1
        )
      ) as manager_name
  ) manager on true
  where person.id = v_person_id
    and person.auth_user_id = (select auth.uid())
    and person.node_kind = 'person'
    and person.is_active
    and private.is_active_portal_account()
    and private.is_internal_org_member();
end;
$$;

comment on function public.get_my_employee_profile() is
  'Returns only the current active employee''s safe work identity and own contact fields. External roster manager labels remain HR-only; an employee can receive only a public structural org-unit title when no person manager exists.';

revoke all on function public.get_my_employee_profile()
  from public, anon, authenticated;
grant execute on function public.get_my_employee_profile()
  to authenticated;

commit;
