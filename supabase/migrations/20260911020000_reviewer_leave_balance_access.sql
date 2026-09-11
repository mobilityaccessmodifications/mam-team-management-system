begin;

-- Approval grants are independent of the account's app_role. In particular,
-- an administrator preview uses the selected reviewer's scope, not admin scope.
create or replace function private.can_view_team_leave_balance(p_person_id uuid, p_actor uuid)
returns boolean language sql stable security definer set search_path='' as $$
  select private.is_active_portal_account(p_actor) and (
    exists (
      select 1 from public.profiles actor
      where actor.id=p_actor and actor.app_role='manager'
        and (
          exists(select 1 from public.internal_org_people p
            where p.id=p_person_id and p.auth_user_id=p_actor and p.is_active)
          or private.can_submit_team_leave(p_person_id,p_actor)
        )
    )
    or exists (
      select 1 from public.leave_requests r
      where r.employee_person_id=p_person_id and r.status='submitted'
        and private.is_current_leave_request_reviewer(r.id,p_actor)
    )
  );
$$;
revoke all on function private.can_view_team_leave_balance(uuid,uuid) from public,anon,authenticated;

commit;
