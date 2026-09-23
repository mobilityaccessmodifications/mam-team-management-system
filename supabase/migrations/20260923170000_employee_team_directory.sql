begin;

create or replace function private.list_current_employee_people_branch_node_ids()
returns table(node_id uuid)
language sql stable security definer set search_path = '' as $$
  select private.current_active_portal_employee_id()
  where private.current_active_portal_employee_id() is not null
  union
  select peer.person_id
  from private.employee_calendar_peer_ids(private.current_active_portal_employee_id()) peer;
$$;

create function public.list_employee_team_directory(p_preview_person_id uuid default null)
returns table(person_id uuid,full_name text,position_title text,company_key text,parent_id uuid,manager_name text)
language plpgsql stable security definer set search_path = '' as $$
declare actor_id uuid;
begin
  if not private.is_internal_org_member() then
    raise exception 'Not authorised.' using errcode='42501';
  end if;
  if p_preview_person_id is not null then
    if not private.is_internal_org_hr() then
      raise exception 'Only a Super Admin may preview the employee directory.' using errcode='42501';
    end if;
    select p.id into actor_id from public.internal_org_people p
    join public.profiles profile on profile.id=p.auth_user_id
    where p.id=p_preview_person_id and p.is_active and p.node_kind='person'
      and profile.account_status='active' and profile.login_name is not null
      and private.is_active_portal_account(profile.id);
  else
    actor_id := private.current_active_portal_employee_id();
  end if;
  if actor_id is null then
    raise exception 'An active employee is required.' using errcode='42501';
  end if;
  return query
  select p.id,p.full_name,p.position_title,p.company_key,p.parent_id,coalesce(manager.full_name,manager.position_title)
  from public.internal_org_people p
  left join public.internal_org_people manager on manager.id=p.parent_id and manager.is_active
  where p.is_active and p.node_kind='person'
    and (p.id=actor_id or p.id in (select peer.person_id from private.employee_calendar_peer_ids(actor_id) peer))
  order by p.full_name,p.id;
end;
$$;
revoke all on function public.list_employee_team_directory(uuid) from public,anon,authenticated,service_role;
grant execute on function public.list_employee_team_directory(uuid) to authenticated;

commit;
