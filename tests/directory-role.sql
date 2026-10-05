\set ON_ERROR_STOP on
begin;
\ir sql-test-auth.sql
insert into auth.users(id,email,email_confirmed_at) values
('92000000-0000-4000-8000-000000000001','admin@example.test',now()),
('92000000-0000-4000-8000-000000000002','staff@example.test',now()),
('92000000-0000-4000-8000-000000000003','other@example.test',now());
insert into public.profiles(id,full_name,app_role,login_name,credentials_valid_after)
select id,'Synthetic',case when id::text like '%001' then 'system_admin' else 'employee' end,'roletest'||right(id::text,1),now()-interval '1 day' from auth.users where email like '%@example.test' and id::text like '92000000%';
insert into public.internal_org_people(id,full_name,company_key,position_title,auth_user_id)
select id,'Synthetic','mam','Test',id from public.profiles where id::text like '92000000%';
update public.internal_org_people set parent_id='92000000-0000-4000-8000-000000000001'
where id='92000000-0000-4000-8000-000000000003';
insert into private.subscription_management_grants(person_id) values ('92000000-0000-4000-8000-000000000003');
select pg_temp.set_test_actor('92000000-0000-4000-8000-000000000002');
set local role authenticated;
do $$ begin
  begin
    perform public.update_employee_directory_role('92000000-0000-4000-8000-000000000003','manager','employee');
    raise exception 'Nonadmin changed role';
  exception when insufficient_privilege then null; end;
  begin
    perform * from public.list_employee_directory_roles();
    raise exception 'Nonadmin listed roles';
  exception when insufficient_privilege then null; end;
end $$;
reset role;
update public.profiles set app_role='hr' where id='92000000-0000-4000-8000-000000000002';
select pg_temp.set_test_actor('92000000-0000-4000-8000-000000000001');
set local role authenticated;
do $$
declare v_person_id uuid;
begin
  select person_id into v_person_id
  from public.create_employee_directory_record_with_work_schedule_times(
    p_first_name => 'Unassigned', p_last_name => 'Synthetic',
    p_work_email => 'unassigned@example.test', p_personal_email => null,
    p_phone => null, p_position_title => 'Coordinator', p_team_name => 'Operation & Accounts',
    p_manager_id => null, p_country => null, p_date_of_birth => null,
    p_started_date => date '2026-10-05', p_scheduled_employment_end_date => null,
    p_company_key => 'mam', p_is_active => true, p_laptop_supplied => null,
    p_laptop_id => null, p_mouse_id => null, p_keyboard_id => null,
    p_asset_tags => null, p_address => null, p_employment_type => 'full_time',
    p_working_weekdays => null, p_working_day_times => '[]'::jsonb
  );
  assert v_person_id is not null, 'Active employee created without manager';
  assert (select parent_id is null and is_active from public.internal_org_people where id=v_person_id),
    'Unassigned employee has no inferred reporting link';
end $$;
do $$ begin
  begin
    perform public.update_employee_directory_role('92000000-0000-4000-8000-000000000003','hr','employee');
    raise exception 'Unsupported role accepted';
  exception when check_violation then null; end;
  begin
    perform public.update_employee_directory_role('92000000-0000-4000-8000-000000000003','manager','system_admin');
    raise exception 'Stale role accepted';
  exception when sqlstate 'PT409' then
    assert sqlerrm='Role has changed. Refresh and try again.', 'Stale role has the documented nonretry conflict';
  end;
  begin
    perform public.update_employee_directory_role('92000000-0000-4000-8000-000000000001','employee','system_admin');
    raise exception 'Self-demotion accepted';
  exception when insufficient_privilege then null; end;
  assert public.update_employee_directory_role('92000000-0000-4000-8000-000000000003','manager','employee')='manager', 'Role changed';
  assert public.update_employee_directory_role('92000000-0000-4000-8000-000000000003','manager','manager')='manager', 'No-op accepted';
  assert (select count(*)=3 from public.list_employee_directory_roles() where person_id::text like '92000000%'), 'All synthetic people listed';
  assert (select app_role='hr' from public.list_employee_directory_roles() where person_id='92000000-0000-4000-8000-000000000002'), 'Legacy role visible';
  assert public.update_employee_directory_role('92000000-0000-4000-8000-000000000002','employee','hr')='employee', 'Legacy role converted';
end $$;
reset role;
do $$ begin
  assert (select app_role='manager' from public.profiles where id='92000000-0000-4000-8000-000000000003'), 'Role persisted';
  assert (select count(*)=1 from private.employee_directory_audit_events where person_id='92000000-0000-4000-8000-000000000003' and changed_fields=array['app_role']::text[]), 'Role audited once';
  assert (select count(*)=1 from private.subscription_management_grants where person_id='92000000-0000-4000-8000-000000000003'), 'Explicit grants unchanged';
  assert (select parent_id='92000000-0000-4000-8000-000000000001' from public.internal_org_people where id='92000000-0000-4000-8000-000000000003'), 'Reporting relationship unchanged';
  update public.profiles set account_status='disabled', disabled_at=now() where id='92000000-0000-4000-8000-000000000003';
end $$;
set local role authenticated;
do $$ begin
  begin
    perform public.update_employee_directory_role('92000000-0000-4000-8000-000000000003','employee','manager');
    raise exception 'Disabled account accepted';
  exception when insufficient_privilege then null; end;
end $$;
reset role;
update public.profiles set account_status='active', disabled_at=null where id='92000000-0000-4000-8000-000000000003';
update public.internal_org_people set is_active=false where id='92000000-0000-4000-8000-000000000003';
set local role authenticated;
do $$ begin
  begin
    perform public.update_employee_directory_role('92000000-0000-4000-8000-000000000003','employee','manager');
    raise exception 'Archived target accepted';
  exception when insufficient_privilege then null; end;
end $$;
reset role;
rollback;
