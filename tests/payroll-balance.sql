-- Synthetic integration test, never run against a production database.
\set ON_ERROR_STOP on
do $$begin assert current_database() ~ '^priority_v[0-9]+$', 'Never run fixtures in production'; end$$;
begin;
\ir sql-test-auth.sql
insert into public.profiles(id,full_name,app_role,login_name,credentials_valid_after)
values ('10000000-0000-4000-8000-000000000001','Test Admin','system_admin','testadmin',now()-interval '1 day'),
('10000000-0000-4000-8000-000000000002','Test Manager','manager','testmanager',now()-interval '1 day'),
('10000000-0000-4000-8000-000000000003','Test Employee','employee','testemployee',now()-interval '1 day'),
('10000000-0000-4000-8000-000000000004','Test Outsider','manager','testoutsider',now()-interval '1 day');
-- Parent validation fires per row, so roots must exist before their reports.
insert into public.internal_org_people(id,full_name,company_key,position_title,auth_user_id,parent_id)
select id,full_name,'mam','Test role',id,null from public.profiles where app_role<>'employee';
insert into public.internal_org_people(id,full_name,company_key,position_title,auth_user_id,parent_id)
select id,full_name,'mam','Test role',id,'10000000-0000-4000-8000-000000000002' from public.profiles where app_role='employee';
insert into private.employee_directory_details(person_id,first_name,last_name,work_email,employment_type)
select id,'Test','Employee',login_name||'@example.test','full_time' from public.profiles;
do $$begin
  assert (select count(*)=1 from private.leave_approval_grants
    where reviewer_user_id='10000000-0000-4000-8000-000000000002'
      and scope_kind='subtree'
      and scope_root_person_id='10000000-0000-4000-8000-000000000002'
      and revoked_at is null), 'Manager fixture receives one automatic subtree approval grant';
end$$;
select pg_temp.set_test_actor('10000000-0000-4000-8000-000000000001');
select public.set_employee_annual_leave_balance('10000000-0000-4000-8000-000000000003',119.9999,current_date,false);
select public.set_employee_sick_leave_balance('10000000-0000-4000-8000-000000000003',45.1234,current_date);
insert into private.payroll_balance_imports(company_key,employee_name,annual_hours,sick_hours,as_of,source_file,source_sha256,match_status)
values('mam','Unmatched Test Employee',10,20,current_date,'synthetic.xlsx',repeat('a',64),'unmatched');
do $$begin
  assert jsonb_array_length(public.get_leave_priority_workspace()->'payrollImports')=1, 'Admin can review all imported records';
end$$;
select pg_temp.set_test_actor('10000000-0000-4000-8000-000000000003');
do $$declare w jsonb; begin
  w:=public.get_leave_priority_workspace();
  assert jsonb_array_length(w->'people')=1;
  assert (w->'people'->0->>'hours')::numeric=119.9999, 'Keep payroll precision';
  assert not (w->'people'->0->>'canViewSickBalance')::boolean;
  assert jsonb_array_length(w->'payrollImports')=0, 'Staff cannot read the import register';
  assert w->'people'->0->>'sickHours' is null and w->'people'->0->>'sickAsOf' is null;
  begin
    perform public.set_employee_sick_leave_balance('10000000-0000-4000-8000-000000000003',10,current_date);
    raise exception 'Employee changed sick balance';
  exception when insufficient_privilege then null; end;
end$$;
select pg_temp.set_test_actor('10000000-0000-4000-8000-000000000004');
do $$declare w jsonb; begin
  w:=public.get_leave_priority_workspace();
  assert jsonb_array_length(w->'payrollImports')=0, 'Managers cannot read the unscoped import register';
  assert not exists(select 1 from jsonb_array_elements(w->'people') p where p->>'personId'='10000000-0000-4000-8000-000000000003');
end$$;
select pg_temp.set_test_actor('10000000-0000-4000-8000-000000000002');
do $$declare p jsonb; begin
  select e into strict p from jsonb_array_elements(public.get_leave_priority_workspace()->'people') e
  where e->>'personId'='10000000-0000-4000-8000-000000000003';
  assert (p->>'hours')::numeric=119.9999 and (p->>'sickHours')::numeric=45.1234;
  begin
    perform public.set_employee_sick_leave_balance('10000000-0000-4000-8000-000000000003',10,current_date);
    raise exception 'Manager changed sick balance';
  exception when insufficient_privilege then null; end;
end$$;
select * from public.submit_selected_employee_leave_request('10000000-0000-4000-8000-000000000003','Annual leave','2030-12-09','2030-12-27');
do $$declare r uuid; definition text; delivery record; retry record; begin
  select id into strict r from public.leave_requests;
  perform public.decide_leave_with_balance(r,'Approved – pending leave balance',null);
  assert not private.leave_payroll_balance_sufficient(r), 'Days do not imply paid hours';
  perform public.set_leave_balance_required_hours(r,120);
  update public.leave_requests set submitted_at=timestamptz '2030-08-01 10:00:00+10' where id=r;
  select pg_get_functiondef('public.claim_leave_priority_reminders(integer)'::regprocedure) into definition;
  execute replace(definition, 'now() at time zone ''Australia/Melbourne''', 'timestamp ''2030-09-10 08:00:00''');
  insert into private.leave_priority_reminder_deliveries(kind,source_id,notify_date)
  values('leave-reminder',r,'2030-09-10');
  assert (select count(*)=0 from public.claim_leave_priority_reminders(100)), 'Insufficient: no routine or old queued reminders';
  update private.employee_annual_leave_balances set hours=120,is_example=true;
  assert not private.leave_payroll_balance_sufficient(r), 'Temporary balances do not qualify';
  update private.employee_annual_leave_balances set is_example=false,updated_at=now()-interval '1 day';
  assert not private.leave_payroll_balance_sufficient(r), 'Old snapshot must not qualify';
  update private.employee_annual_leave_balances set updated_at=now(),as_of=current_date-1;
  assert not private.leave_payroll_balance_sufficient(r), 'Re-entering an old payroll date must not qualify';
  update private.employee_annual_leave_balances set as_of=current_date;
  assert private.leave_payroll_balance_sufficient(r), 'Updated balance at exact threshold qualifies';
  select * into strict delivery from public.claim_leave_priority_reminders(100);
  assert delivery.manager_email='testmanager@example.test';
  assert (select count(*)=0 from public.claim_leave_priority_reminders(100)), 'Concurrent lease prevents duplicates';
  -- Simulated failure: retry next working day with the same durable delivery ID.
  update private.leave_priority_reminder_deliveries set claimed_until=now()-interval '1 minute' where id=delivery.delivery_id;
  execute replace(definition, 'now() at time zone ''Australia/Melbourne''', 'timestamp ''2030-09-11 08:00:00''');
  update private.employee_annual_leave_balances set hours=119;
  assert (select count(*)=0 from public.claim_leave_priority_reminders(100)), 'Recheck balance before retry';
  update private.employee_annual_leave_balances set hours=120;
  select * into strict retry from public.claim_leave_priority_reminders(100);
  assert retry.delivery_id=delivery.delivery_id, 'Stable event key across retries';
  assert public.complete_leave_priority_reminder(retry.delivery_id,retry.claim_token);
  execute replace(definition, 'now() at time zone ''Australia/Melbourne''', 'timestamp ''2030-09-12 08:00:00''');
  assert (select count(*)=0 from public.claim_leave_priority_reminders(100)), 'Sends only once';
  assert (select status='submitted' from public.leave_requests where id=r), 'Never auto-approves';
  assert not has_function_privilege('authenticated','private.leave_payroll_balance_sufficient(uuid)','EXECUTE');
  assert not has_table_privilege('authenticated','private.employee_sick_leave_balances','SELECT');
  assert not has_function_privilege('anon','public.set_employee_sick_leave_balance(uuid,numeric,date)','EXECUTE');
  assert not has_table_privilege('authenticated','private.payroll_balance_imports','SELECT');
end$$;
select pg_temp.set_test_actor('10000000-0000-4000-8000-000000000003');
do $$declare r uuid; begin
  select id into strict r from public.leave_requests;
  begin
    perform public.set_leave_balance_required_hours(r,1);
    raise exception 'Employee changed own reminder threshold';
  exception when insufficient_privilege then null; end;
end$$;
select pg_temp.set_test_actor('10000000-0000-4000-8000-000000000001');
do $$declare w jsonb; begin
  w:=public.get_leave_priority_workspace('10000000-0000-4000-8000-000000000003');
  assert jsonb_array_length(w->'people')=1;
  assert w->'people'->0->>'sickHours' is null, 'Employee preview cannot expose sick balances';
  assert jsonb_array_length(w->'payrollImports')=0, 'Employee preview cannot expose payroll imports';
end$$;
rollback;
