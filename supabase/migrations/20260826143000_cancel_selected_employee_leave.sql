begin;

-- Change Profile uses the real System Admin session while rendering the
-- selected employee's workspace. Keep that display projection separate from
-- the employee self-service cancellation RPC: the target person is resolved
-- from the live organisation link and the browser cannot choose a user_id.
create function public.cancel_selected_employee_approved_leave_request(
  p_person_id uuid,
  p_request_id uuid
)
returns table (
  id uuid,
  status text
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor_user_id uuid := (select auth.uid());
  v_target_user_id uuid;
  v_melbourne_today date := (current_timestamp at time zone 'Australia/Melbourne')::date;
  v_request public.leave_requests%rowtype;
begin
  if v_actor_user_id is null
    or coalesce(((select auth.jwt()) ->> 'is_anonymous')::boolean, false)
    or not private.is_active_portal_account()
    or not private.is_system_portal_account_admin()
    or p_person_id is null
    or p_request_id is null then
    raise exception 'This leave request cannot be cancelled.' using errcode = '42501';
  end if;

  select person.auth_user_id
    into v_target_user_id
  from public.internal_org_people person
  join public.profiles target_profile
    on target_profile.id = person.auth_user_id
   and target_profile.account_status = 'active'
   and target_profile.login_name is not null
  where person.id = p_person_id
    and person.node_kind = 'person'
    and person.is_active = true
    and person.auth_user_id is not null;

  -- Keep the response deliberately indistinguishable for missing, inactive or
  -- unlinked profiles. The target is never accepted as an Auth user ID.
  if v_target_user_id is null then
    raise exception 'This leave request cannot be cancelled.' using errcode = '42501';
  end if;

  -- Lock before checking eligibility so a concurrent reviewer decision or
  -- repeat cancellation cannot create a second state transition or event.
  select request.*
    into v_request
  from public.leave_requests request
  where request.id = p_request_id
  for update;

  if not found
    or v_request.user_id is distinct from v_target_user_id
    or v_request.status <> 'approved'
    or v_request.start_date <= v_melbourne_today then
    raise exception 'This leave request cannot be cancelled.' using errcode = '42501';
  end if;

  update public.leave_requests request
  set status = 'cancelled',
      updated_at = clock_timestamp()
  where request.id = v_request.id
  returning request.* into v_request;

  insert into public.leave_request_events (
    leave_request_id,
    actor_user_id,
    event_type,
    note
  )
  values (
    v_request.id,
    v_actor_user_id,
    'cancelled',
    'Cancelled by System Admin through Change Profile before leave start.'
  );

  return query
  select v_request.id, 'Cancelled';
end;
$$;

comment on function public.cancel_selected_employee_approved_leave_request(uuid, uuid) is
  'Cancels a selected active employee''s future approved leave from the System Admin Change Profile view. The target employee is resolved from the active organisation link and the actor is recorded separately.';

revoke all on function public.cancel_selected_employee_approved_leave_request(uuid, uuid) from public, anon, authenticated;
grant execute on function public.cancel_selected_employee_approved_leave_request(uuid, uuid) to authenticated;

commit;
