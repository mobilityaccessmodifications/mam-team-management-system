\set ON_ERROR_STOP on
do $$begin assert current_database() ~ '^priority_v[0-9]+$', 'Synthetic database only';end$$;
begin;
insert into public.profiles(id,full_name,app_role,login_name,credentials_valid_after) values
('10000000-0000-4000-8000-000000000001','Test Admin','system_admin','testadmin',now()-interval '1 day'),
('10000000-0000-4000-8000-000000000002','Test Employee','employee','testemployee',now()-interval '1 day'),
('10000000-0000-4000-8000-000000000003','Test Manager','manager','testmanager',now()-interval '1 day');
insert into public.internal_org_people(id,full_name,company_key,position_title,auth_user_id,parent_id)
select id,full_name,'mam','Test role',id,case when app_role='employee' then '10000000-0000-4000-8000-000000000003'::uuid else null end from public.profiles;
insert into private.employee_directory_details(person_id,employment_type,work_email)
select id,'full_time',login_name||'@example.test' from public.profiles;
insert into private.leave_approval_grants(id,reviewer_user_id,scope_kind,scope_root_person_id,reviewer_label) values('20000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000003','subtree','10000000-0000-4000-8000-000000000003','Test Manager');
select set_config('test.uid','10000000-0000-4000-8000-000000000001',false);
select public.set_employee_annual_leave_balance('10000000-0000-4000-8000-000000000002',10,(now() at time zone 'Australia/Melbourne')::date-365,false);
select public.set_employee_sick_leave_balance('10000000-0000-4000-8000-000000000002',20,(now() at time zone 'Australia/Melbourne')::date-365);
insert into private.leave_accrual_policies(person_id,effective_from,weekly_hours,weekdays,annual_weeks,personal_weeks,enabled,note)
values('10000000-0000-4000-8000-000000000002',(now() at time zone 'Australia/Melbourne')::date-364,38,array[1,2,3,4,5],4,2,true,'Synthetic fixture');
do $$declare c jsonb;today date:=(now() at time zone 'Australia/Melbourne')::date;begin
 c:=private.calculate_employee_leave_accrual('10000000-0000-4000-8000-000000000002',today-1);
 assert (c->>'annualHours')::numeric=162, '52 weeks accrues exactly 152 annual hours';
 assert (c->>'personalHours')::numeric=96, '52 weeks accrues exactly 76 shared personal hours';
 assert c->>'status'='current';
 assert c=private.calculate_employee_leave_accrual('10000000-0000-4000-8000-000000000002',today+100),'Never accrue future days';
 assert public.refresh_employee_leave_accrual()=1;
 assert public.refresh_employee_leave_accrual()=0,'Idempotent durable checkpoint';
 assert (select hours=10 from private.employee_annual_leave_balances where person_id='10000000-0000-4000-8000-000000000002'),'Never compound or overwrite payroll';
end$$;
-- Hours awaiting permanent-classification confirmation can be recovered by review.
savepoint awaiting_hours;
insert into private.leave_accrual_policies(person_id,effective_from,weekly_hours,weekdays,annual_weeks,personal_weeks,enabled,requires_review,note)
values('10000000-0000-4000-8000-000000000002',(now() at time zone 'Australia/Melbourne')::date-1,38,array[1,2,3,4,5],4,2,false,true,'Awaiting part-time ordinary hours');
do $$declare c jsonb;before_hours numeric;day date:=(now() at time zone 'Australia/Melbourne')::date-1;begin
 c:=private.calculate_employee_leave_accrual('10000000-0000-4000-8000-000000000002',day);
 assert c->>'status'='needs_review';
 before_hours:=(c->>'annualExactHours')::numeric;
 perform public.review_employee_leave_accrual_day('10000000-0000-4000-8000-000000000002',day,3.8,3.8,0,0,'Confirmed part-time eligible hours');
 c:=private.calculate_employee_leave_accrual('10000000-0000-4000-8000-000000000002',day);
 assert c->>'status'='current';
 assert abs((c->>'annualExactHours')::numeric-before_hours-3.8/13)<0.000001,'Recover confirmed accrual rather than silently discarding it';
end$$;
rollback to awaiting_hours;
-- A gap between payroll and the first policy cannot silently omit usage/service.
savepoint missing_policy_period;
update private.leave_accrual_policies set effective_from=effective_from+1;
do $$declare c jsonb;begin
 c:=private.calculate_employee_leave_accrual('10000000-0000-4000-8000-000000000002',current_date);
 assert c->>'status'='needs_review';
 assert (c->>'annualHours')::numeric=10;
end$$;
rollback to missing_policy_period;
-- Each supplied entitlement accrues independently of a missing counterpart.
delete from private.employee_sick_leave_balances where person_id='10000000-0000-4000-8000-000000000002';
do $$declare c jsonb;begin
 c:=private.calculate_employee_leave_accrual('10000000-0000-4000-8000-000000000002',current_date);
 assert (c->>'annualHours')::numeric=162;
 assert c->>'personalHours' is null and c->>'personalAsOf' is null;
end$$;
select public.set_employee_sick_leave_balance('10000000-0000-4000-8000-000000000002',20,(now() at time zone 'Australia/Melbourne')::date-365);
delete from private.employee_annual_leave_balances where person_id='10000000-0000-4000-8000-000000000002';
do $$declare c jsonb;begin
 c:=private.calculate_employee_leave_accrual('10000000-0000-4000-8000-000000000002',current_date);
 assert (c->>'personalHours')::numeric=96;
 assert c->>'annualHours' is null and c->>'annualAsOf' is null;
end$$;
select public.set_employee_annual_leave_balance('10000000-0000-4000-8000-000000000002',10,(now() at time zone 'Australia/Melbourne')::date-365,false);
do $$declare r uuid;begin
 select id into r from public.submit_selected_employee_leave_request('10000000-0000-4000-8000-000000000002','Annual leave','2030-12-09','2030-12-13');
 perform public.decide_leave_with_balance(r,'Approved – pending leave balance',null);
 perform public.set_leave_balance_required_hours(r,162);
 update private.leave_balance_approvals set approved_at=now()-interval '2 days' where request_id=r;
 assert private.leave_payroll_balance_sufficient(r),'Accrual alone can cover a conditional request';
 perform public.set_leave_balance_required_hours(r,162.0001);
 assert not private.leave_payroll_balance_sufficient(r),'Never round a near-threshold balance into sufficiency';
 update public.leave_requests set status='cancelled' where id=r;
end$$;
select set_config('test.uid','10000000-0000-4000-8000-000000000002',false);
do $$declare w jsonb;begin
 w:=public.get_leave_priority_workspace();
 assert (w->'people'->0->>'hours')::numeric=162;
 assert w->'people'->0->>'sickHours' is null;
 assert not(w->'people'->0 ? 'sickPayrollHours');
 assert not(w->'people'->0 ? 'accrualPolicy');
 begin perform public.set_employee_leave_accrual_policy('10000000-0000-4000-8000-000000000002',38,4,2,false,true,'Test');raise exception 'Employee changed policy';exception when insufficient_privilege then null;end;
 begin perform public.review_employee_leave_accrual_day('10000000-0000-4000-8000-000000000002',current_date-1,7.6,7.6,0,0,'Test');raise exception 'Employee changed hours';exception when insufficient_privilege then null;end;
 assert not has_function_privilege('authenticated','public.refresh_employee_leave_accrual()','EXECUTE');
 assert not has_function_privilege('authenticated','public.get_leave_priority_workspace_before_accrual(uuid)','EXECUTE');
 assert not has_table_privilege('authenticated','private.leave_accrual_calculations','SELECT');
end$$;
select set_config('test.uid','10000000-0000-4000-8000-000000000001',false);
do $$declare r uuid;c jsonb;day date:=(now() at time zone 'Australia/Melbourne')::date-1; before_hours numeric;begin
 while extract(isodow from day)>5 loop day:=day-1;end loop;
 select id into r from public.submit_selected_employee_leave_request('10000000-0000-4000-8000-000000000002','Annual leave',day,day);
 update public.leave_requests set status='approved' where id=r;
 c:=private.calculate_employee_leave_accrual('10000000-0000-4000-8000-000000000002',current_date);
 assert c->>'status'='needs_review','Do not overstate balances after unconfirmed absence';
 assert (c->>'reviewDate')::date=day;
 perform public.review_employee_leave_accrual_day('10000000-0000-4000-8000-000000000002',day,7.6,7.6,7.6,0,'Paid annual leave: preserve accrual and deduct confirmed ordinary hours');
 c:=private.calculate_employee_leave_accrual('10000000-0000-4000-8000-000000000002',current_date);
 assert c->>'status'='current';
 assert (c->>'annualHours')::numeric=154.4,'Deduct actual annual hours exactly once';
 assert (c->>'personalHours')::numeric=96,'Paid annual leave still earns personal leave';
 update public.leave_requests set status='cancelled' where id=r;
 c:=private.calculate_employee_leave_accrual('10000000-0000-4000-8000-000000000002',current_date);
 assert c->>'status'='needs_review','Changed leave invalidates old reconciliation';
 perform public.review_employee_leave_accrual_day('10000000-0000-4000-8000-000000000002',day,7.6,7.6,0,0,'Cancellation confirmed: no leave taken');
 c:=private.calculate_employee_leave_accrual('10000000-0000-4000-8000-000000000002',current_date);
 assert (c->>'annualHours')::numeric=162;
 perform public.review_employee_leave_accrual_day('10000000-0000-4000-8000-000000000002',day,0,0,0,0,'Ordinary unpaid absence: no accrual');
 c:=private.calculate_employee_leave_accrual('10000000-0000-4000-8000-000000000002',current_date);
 assert (c->>'annualHours')::numeric=round(162-7.6/13,4);
 assert (c->>'personalHours')::numeric=round(96-7.6/26,4);
 perform public.set_employee_annual_leave_balance('10000000-0000-4000-8000-000000000002',50,current_date,false);
 perform public.set_employee_sick_leave_balance('10000000-0000-4000-8000-000000000002',60,current_date);
 c:=private.calculate_employee_leave_accrual('10000000-0000-4000-8000-000000000002',current_date);
 assert (c->>'annualHours')::numeric=50 and (c->>'personalHours')::numeric=60,'New payroll absorbs all earlier earnings and deductions';
end$$;
-- Prospective changes create history, never retain an assumed 38h for newly part-time staff.
update private.employee_directory_details set employment_type='part_time' where person_id='10000000-0000-4000-8000-000000000002';
do $$begin
 assert (select not enabled from private.leave_accrual_policies where person_id='10000000-0000-4000-8000-000000000002' order by effective_from desc,created_at desc limit 1);
end$$;
select public.set_employee_leave_accrual_policy('10000000-0000-4000-8000-000000000002',19,5,2,true,true,'Confirmed part time qualifying shiftworker');
update public.internal_org_people set is_active=false where id='10000000-0000-4000-8000-000000000002';
do $$begin
 assert (select not enabled from private.leave_accrual_policies where person_id='10000000-0000-4000-8000-000000000002' order by effective_from desc,created_at desc limit 1),'Inactive employment stops future accrual';
end$$;
-- A policy changed on the day BEFORE initial rollout must win on rollout day.
insert into private.leave_accrual_policies(person_id,effective_from,weekly_hours,weekdays,annual_weeks,personal_weeks,enabled,note)
values('10000000-0000-4000-8000-000000000003',current_date+1,38,array[1,2,3,4,5],4,2,true,'Future seed fixture');
select public.set_employee_leave_accrual_policy('10000000-0000-4000-8000-000000000003',19,4,2,false,false,'Disable before activation');
do $$begin
 assert (select not enabled and weekly_hours=19 and effective_from>=current_date+1 from private.leave_accrual_policies where person_id='10000000-0000-4000-8000-000000000003' order by effective_from desc,created_at desc,id desc limit 1);
end$$;
update private.employee_directory_details set working_weekdays=array[1,2,3]::smallint[] where person_id='10000000-0000-4000-8000-000000000003';
do $$begin
 assert (select not enabled and not requires_review from private.leave_accrual_policies where person_id='10000000-0000-4000-8000-000000000003' order by effective_from desc,created_at desc,id desc limit 1),'Schedule-only edit preserves explicit disablement';
end$$;
update public.internal_org_people set is_active=false where id='10000000-0000-4000-8000-000000000003';
do $$begin
 assert (select not enabled and effective_from>=current_date+1 from private.leave_accrual_policies where person_id='10000000-0000-4000-8000-000000000003' order by effective_from desc,created_at desc,id desc limit 1);
end$$;
rollback;
