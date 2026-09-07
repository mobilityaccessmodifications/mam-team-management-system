begin;

-- Preserve delegation and the existing request/evidence projection. Financial
-- fields are returned only for self, or in the actual Super Admin workspace.
create or replace function public.get_leave_priority_workspace(p_preview_person_id uuid default null)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare actor uuid := auth.uid(); scope_actor uuid; scope_person uuid; scope_admin boolean; requests jsonb; calendar_ids uuid[];
begin
  if actor is null or not private.is_active_portal_account(actor)
    or coalesce((auth.jwt()->>'is_anonymous')::boolean,false) then
    raise exception 'An active portal account is required.' using errcode = '42501';
  end if;
  scope_actor := actor;
  scope_person := private.current_active_portal_employee_id();
  if p_preview_person_id is not null then
    if not private.is_system_portal_account_admin() then raise exception 'Only Super Admin can change profile.' using errcode = '42501'; end if;
    select auth_user_id into scope_actor from public.internal_org_people
    where id = p_preview_person_id and is_active and node_kind = 'person';
    if scope_actor is null or not private.is_active_portal_account(scope_actor) then
      raise exception 'An active linked employee is required.' using errcode = '42501';
    end if;
    scope_person := p_preview_person_id;
    requests := public.get_leave_workspace_for_preview(p_preview_person_id)->'requests';
  else
    select coalesce(jsonb_agg(to_jsonb(r)), '[]'::jsonb) into requests from public.list_leave_workspace_requests() r;
  end if;
  scope_admin := p_preview_person_id is null and private.is_system_portal_account_admin();
  select array_agg(c.id) into calendar_ids from public.list_leave_calendar_entries() c;
  return jsonb_build_object(
    'people', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'personId', p.id, 'name', p.full_name,
        'canSubmit', private.can_submit_team_leave(p.id,scope_actor) and p.auth_user_id is not null and private.is_active_portal_account(p.auth_user_id),
        -- Delegating managers need category eligibility to offer the correct
        -- request types (not a balance). Do not mask it with financial fields.
        'paidLeave', coalesce(d.employment_type in ('full_time','part_time'),false),
        'canViewBalance', coalesce(p.id = scope_person or scope_admin, false),
        'hours', case when (p.id = scope_person or scope_admin) and d.employment_type in ('full_time','part_time') then coalesce(b.hours,80) else null end,
        'asOf', case when p.id = scope_person or scope_admin then b.as_of else null end,
        'isExample', case when p.id = scope_person or scope_admin then coalesce(b.is_example,true) else false end
      ) order by lower(p.full_name)), '[]'::jsonb)
      from public.internal_org_people p
      left join private.employee_directory_details d on d.person_id = p.id
      left join private.employee_annual_leave_balances b on b.person_id = p.id
      where p.is_active and p.node_kind = 'person'
        and (p.id = scope_person or scope_admin or private.can_submit_team_leave(p.id,scope_actor))
    ),
    'canManageBalances', private.is_system_portal_account_admin(),
    'requests', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'id', r.id, 'pendingBalance', r.status = 'submitted' and a.request_id is not null,
        'evidenceDueDate', r.evidence_due_date,
        'canAttach', private.can_add_my_leave_request_attachment(r.id)
      )), '[]'::jsonb)
      from public.leave_requests r left join private.leave_balance_approvals a on a.request_id = r.id
      where r.id in (select (entry->>'id')::uuid from jsonb_array_elements(requests) entry)
    ),
    'pendingBalanceCalendarIds', (
      select coalesce(jsonb_agg(r.id),'[]'::jsonb)
      from public.leave_requests r join private.leave_balance_approvals a on a.request_id = r.id
      where r.status = 'submitted' and (
        (p_preview_person_id is null and r.id = any(calendar_ids)
          and (r.user_id=actor or private.can_review_leave_request(r.id)))
        or r.id in (select (entry->>'id')::uuid from jsonb_array_elements(requests) entry)
      )
    )
  );
end;
$$;
revoke all on function public.get_leave_priority_workspace(uuid) from public, anon, authenticated;
grant execute on function public.get_leave_priority_workspace(uuid) to authenticated;

commit;
