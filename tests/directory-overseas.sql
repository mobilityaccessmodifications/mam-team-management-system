\set ON_ERROR_STOP on
begin;
\ir sql-test-auth.sql
insert into auth.users(id,email,email_confirmed_at) values
('93000000-0000-4000-8000-000000000001','overseas-admin@example.test',now()),
('93000000-0000-4000-8000-000000000002','overseas-staff@example.test',now());
insert into public.profiles(id,full_name,app_role,login_name,credentials_valid_after)
select id,'Synthetic',case when id::text like '%001' then 'system_admin' else 'employee' end,'overseastest'||right(id::text,1),now()-interval '1 day'
from auth.users where id::text like '93000000%';
insert into public.internal_org_people(id,full_name,company_key,position_title,auth_user_id)
select id,'Synthetic','mam','Test',id from public.profiles where id::text like '93000000%';
select pg_temp.set_test_actor('93000000-0000-4000-8000-000000000001');
set local role authenticated;
do $$
declare saved record; projected record; employment text;
begin
  for employment in select unnest(array['overseas','abn','casual','full_time','part_time']) loop
    select * into saved from public.create_employee_directory_record_with_work_schedule_times(
      p_first_name => 'Synthetic', p_last_name => 'Overseas', p_work_email => 'synthetic@example.test',
      p_personal_email => null, p_phone => null, p_position_title => 'Coordinator',
      p_team_name => 'Operation & Accounts', p_manager_id => null, p_country => null,
      p_date_of_birth => null, p_started_date => date '2026-10-05', p_scheduled_employment_end_date => null,
      p_company_key => 'mam', p_is_active => true, p_laptop_supplied => null,
      p_laptop_id => null, p_mouse_id => null, p_keyboard_id => null, p_asset_tags => null,
      p_address => null, p_employment_type => employment, p_working_weekdays => null, p_working_day_times => '[]'
    );
    select * into projected from public.get_employee_directory_record_with_work_schedule_times(saved.person_id);
    assert projected.employment_type=employment, 'Create/get employment roundtrip';
    assert projected.has_paid_leave_entitlement=(employment in ('full_time','part_time')), 'Existing entitlement eligibility unchanged';
    perform * from public.update_employee_directory_record_with_work_schedule_times(
      p_person_id => saved.person_id, p_first_name => 'Synthetic', p_last_name => 'Overseas',
      p_work_email => 'synthetic@example.test', p_personal_email => null, p_phone => null,
      p_position_title => 'Coordinator', p_team_name => 'Operation & Accounts', p_manager_id => null,
      p_country => null, p_date_of_birth => null, p_started_date => date '2026-10-05',
      p_scheduled_employment_end_date => null, p_company_key => 'mam', p_is_active => true,
      p_expected_person_version => saved.person_version, p_expected_detail_version => saved.detail_version,
      p_laptop_supplied => null, p_laptop_id => null, p_mouse_id => null, p_keyboard_id => null,
      p_asset_tags => null, p_address => null, p_employment_type => 'overseas',
      p_working_weekdays => null, p_working_day_times => '[]'
    );
    assert (select employment_type='overseas' and not has_paid_leave_entitlement from public.list_employee_directory_records_with_work_schedule_times() where person_id=saved.person_id), 'Update/list Overseas roundtrip';
  end loop;
end $$;
reset role;
insert into private.employee_directory_details(person_id,employment_type)
values ('93000000-0000-4000-8000-000000000002','overseas');
insert into private.leave_approval_grants(reviewer_user_id,scope_kind,reviewer_label,priority)
values ('93000000-0000-4000-8000-000000000001','global','Synthetic Admin',100);
select pg_temp.set_test_actor('93000000-0000-4000-8000-000000000002');
set local role authenticated;
do $$ declare request_id uuid; begin
  assert (select employment_type='overseas' and not has_paid_leave_entitlement from public.get_my_leave_entitlement_policy()), 'Self entitlement fails closed';
  begin
    perform public.submit_my_leave_request('Annual leave','2030-12-09','2030-12-13',null,null,'Synthetic employee note');
    raise exception 'Overseas paid request accepted';
  exception when invalid_parameter_value then null; end;
  select id into request_id from public.submit_my_leave_request('Unpaid leave','2030-12-09','2030-12-13',null,null,'Synthetic employee note');
  assert request_id is not null, 'Overseas unpaid request submitted';
end $$;
reset role;
do $$ begin
  assert (select employment_type_snapshot='overseas' and pay_treatment='unpaid' from public.leave_requests where user_id='93000000-0000-4000-8000-000000000002'), 'Durable Overseas unpaid snapshot roundtrip';
end $$;
create temporary table policy_probe (
  user_id uuid, employee_person_id uuid, request_type_label text, record_origin text default 'portal',
  employment_type_snapshot text, pay_treatment text, reason text
);
create trigger policy_probe_employment before insert on policy_probe for each row
execute function private.enforce_leave_request_employment_policy();
do $$ begin
  begin
    insert into policy_probe(user_id,request_type_label,reason) values ('93000000-0000-4000-8000-000000000002','Annual leave','Synthetic employee note');
    raise exception 'Overseas paid leave accepted';
  exception when invalid_parameter_value then null; end;
  insert into policy_probe(user_id,request_type_label,reason) values ('93000000-0000-4000-8000-000000000002','Unpaid leave','Synthetic employee note');
  assert (select employment_type_snapshot='overseas' and pay_treatment='unpaid' from policy_probe), 'Unpaid snapshot preserved';
  assert private.normalise_employee_employment_type(' Overseas ')='overseas', 'SQL normaliser supports Overseas';
  begin
    perform private.normalise_employee_employment_type('unknown');
    raise exception 'Unknown employment accepted';
  exception when invalid_parameter_value then null; end;
end $$;
rollback;
