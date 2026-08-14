begin;

-- A registered external-manager root is a public structural placeholder, not
-- an employee or a public record of the external manager's name. Keep its
-- title fixed so a later organisation-tree edit cannot move the private HR
-- Manager label from the registry into the public tree.
create or replace function private.validate_employee_roster_external_manager_root()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_node public.internal_org_people%rowtype;
begin
  select node.*
  into v_node
  from public.internal_org_people node
  where node.id = new.org_unit_id
  for key share;

  if not found
    or v_node.node_kind <> 'org_unit'
    or v_node.parent_id is not null
    or v_node.company_key <> new.company_key
    or v_node.position_title <> 'External reporting group' then
    raise exception 'An external manager root must reference a generic root-level org-unit in the same company.'
      using errcode = '23514';
  end if;

  return new;
end;
$$;

create or replace function private.prevent_employee_roster_external_manager_root_drift()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if exists (
    select 1
    from private.employee_roster_external_manager_roots root
    where root.org_unit_id = old.id
  )
  and (
    new.node_kind <> 'org_unit'
    or new.parent_id is not null
    or new.company_key <> old.company_key
    or new.position_title <> 'External reporting group'
  ) then
    raise exception 'An external manager root must remain a generic root-level org-unit in its registered company.'
      using errcode = '23514';
  end if;

  return new;
end;
$$;

drop trigger internal_org_people_prevent_external_manager_root_drift
  on public.internal_org_people;

create trigger internal_org_people_prevent_external_manager_root_drift
before update of node_kind, parent_id, company_key, position_title
on public.internal_org_people
for each row execute function private.prevent_employee_roster_external_manager_root_drift();

revoke all on function private.validate_employee_roster_external_manager_root()
  from public, anon, authenticated;
revoke all on function private.prevent_employee_roster_external_manager_root_drift()
  from public, anon, authenticated;

commit;
