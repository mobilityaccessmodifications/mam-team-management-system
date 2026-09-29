begin;

alter table private.employee_directory_audit_events
  drop constraint employee_directory_audit_events_changed_fields_check;
alter table private.employee_directory_audit_events
  add constraint employee_directory_audit_events_changed_fields_check check (
    changed_fields <@ array[
      'first_name','last_name','work_email','personal_email','phone',
      'position_title','team_name','manager_id','country','address',
      'date_of_birth','started_date','scheduled_employment_end_date',
      'company_key','is_active','sort_order','laptop_supplied',
      'laptop_id','mouse_id','keyboard_id','asset_tags',
      'employment_type','working_weekdays','working_day_times','app_role'
    ]::text[]
  );

create function public.list_employee_directory_roles()
returns table(person_id uuid, app_role text)
language plpgsql stable security definer set search_path = ''
as $$
begin
  if not private.is_system_portal_account_admin() then
    raise exception 'Directory access denied.' using errcode = '42501';
  end if;
  return query
    select person.id, profile.app_role
    from public.internal_org_people person
    left join public.profiles profile on profile.id = person.auth_user_id
      and profile.account_status = 'active' and profile.login_name is not null
    where person.node_kind = 'person';
end;
$$;

create function public.update_employee_directory_role(
  p_person_id uuid, p_role text, p_expected_role text
)
returns text
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_user_id uuid;
  v_old_role text;
begin
  if not private.is_system_portal_account_admin() then
    raise exception 'Directory access denied.' using errcode = '42501';
  end if;
  if p_role is null or p_role not in ('employee','manager','system_admin') then
    raise exception 'Invalid role.' using errcode = '23514';
  end if;
  if p_person_id is null or p_expected_role is null then
    raise exception 'Invalid role target.' using errcode = '23514';
  end if;
  select person.auth_user_id into v_user_id
  from public.internal_org_people person
  where person.id = p_person_id and person.node_kind = 'person' and person.is_active
  for update;
  if v_user_id is null or not private.is_active_portal_account(v_user_id) then
    raise exception 'An active linked portal account is required.' using errcode = '42501';
  end if;
  select profile.app_role into v_old_role
  from public.profiles profile where profile.id = v_user_id for update;
  if v_old_role is distinct from p_expected_role then
    raise exception 'Role has changed. Refresh and try again.' using errcode = '40001';
  end if;
  if v_user_id = (select auth.uid()) and p_role <> 'system_admin' then
    raise exception 'You cannot remove your own administrator access.' using errcode = '42501';
  end if;
  if v_old_role is distinct from p_role then
    update public.profiles set app_role = p_role where id = v_user_id;
    insert into private.employee_directory_audit_events(person_id, actor_user_id, event_type, changed_fields)
    values (p_person_id, (select auth.uid()), 'updated', array['app_role']::text[]);
  end if;
  return p_role;
end;
$$;

revoke all on function public.list_employee_directory_roles() from public, anon, authenticated;
revoke all on function public.update_employee_directory_role(uuid,text,text) from public, anon, authenticated;
grant execute on function public.list_employee_directory_roles() to authenticated;
grant execute on function public.update_employee_directory_role(uuid,text,text) to authenticated;

commit;
