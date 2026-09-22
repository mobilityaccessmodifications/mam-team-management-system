begin;

-- Reassert the approved reviewer-aware resolver after live definition drift.
-- No request, assignment, delivered event or frozen retry payload is rewritten.
create or replace function public.resolve_leave_notification_manager(p_request_id uuid)
returns table(manager_user_id uuid,manager_name text,manager_email text)
language sql stable security definer set search_path='' as $$
  with request_route as (
    select r.*,private.is_manager_leave_person(r.employee_person_id) as manager_owned
    from public.leave_requests r where r.id=p_request_id
  ), group_recipients as (
    select ap.id,ap.full_name,lower(nullif(btrim(d.work_email),'')) email,c.priority
    from request_route r
    join private.manager_leave_reviewers c on r.manager_owned
    join public.profiles ap on ap.id=c.reviewer_user_id
    join public.internal_org_people mp on mp.auth_user_id=ap.id and mp.is_active and mp.node_kind='person'
    left join private.employee_directory_details d on d.person_id=mp.id
    where ap.id is distinct from r.user_id and private.is_active_portal_account(ap.id)
      and private.is_current_leave_request_reviewer(r.id,ap.id)
  ), candidates as (
    select mp.auth_user_id,mp.full_name,d.work_email,0 priority
    from request_route r
    join lateral private.resolve_internal_org_employee_manager(r.employee_person_id) m on true
    join public.internal_org_people mp on mp.id=m.manager_id and mp.is_active
    join public.profiles ap on ap.id=mp.auth_user_id and ap.app_role in ('manager','system_admin')
    left join private.employee_directory_details d on d.person_id=mp.id
    where r.id=p_request_id and not r.manager_owned and mp.auth_user_id is distinct from r.user_id
      and private.is_active_portal_account(mp.auth_user_id)
      and private.is_current_leave_request_reviewer(r.id,mp.auth_user_id)
    union all
    select ap.id,coalesce(mp.full_name,ap.full_name),d.work_email,case when a.is_primary then 1 else 2 end
    from request_route r join private.leave_request_reviewer_assignments a on a.leave_request_id=r.id
    join public.profiles ap on ap.id=a.reviewer_user_id and ap.app_role in ('manager','system_admin')
    join public.internal_org_people mp on mp.auth_user_id=ap.id and mp.is_active and mp.node_kind='person'
    left join private.employee_directory_details d on d.person_id=mp.id
    where r.id=p_request_id and not r.manager_owned and ap.id is distinct from r.user_id and private.is_active_portal_account(ap.id)
      and private.is_current_leave_request_reviewer(r.id,ap.id)
  )
  (select c.auth_user_id,c.full_name,lower(nullif(btrim(c.work_email),'')) from candidates c
    order by c.priority,c.auth_user_id limit 1)
  union all
  select (array_agg(g.id order by g.priority,g.id))[1],
    string_agg(g.full_name,', ' order by g.priority,g.id),
    -- A missing address must not silently drop one of the required reviewers.
    case when bool_and(g.email is not null) then string_agg(g.email,',' order by g.priority,g.id) end
  from group_recipients g having count(*)>0;
$$;


comment on function public.resolve_leave_notification_manager(uuid) is
  'Service-only email route restricted to current authorised reviewers; manager-owned requests use the configured reviewer group.';
revoke all on function public.resolve_leave_notification_manager(uuid) from public,anon,authenticated;
grant execute on function public.resolve_leave_notification_manager(uuid) to service_role;

commit;
