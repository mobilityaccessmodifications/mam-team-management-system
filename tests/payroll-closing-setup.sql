\set ON_ERROR_STOP on
\ir sql-test-auth.sql
insert into auth.users(id,email,email_confirmed_at) values
('96000000-0000-4000-8000-000000000001','closing-admin@example.test',now()),
('96000000-0000-4000-8000-000000000002','closing-a@example.test',now()),
('96000000-0000-4000-8000-000000000003','closing-b@example.test',now());
insert into public.profiles(id,full_name,app_role,login_name,credentials_valid_after) values
('96000000-0000-4000-8000-000000000001','Synthetic Closing Admin','system_admin','closing-admin@example.test',now()-interval '1 day'),
('96000000-0000-4000-8000-000000000002','Synthetic Closing A','employee','closing-a@example.test',now()-interval '1 day'),
('96000000-0000-4000-8000-000000000003','Synthetic Closing B','employee','closing-b@example.test',now()-interval '1 day');
insert into private.portal_account_admins(auth_user_id) values ('96000000-0000-4000-8000-000000000001');
insert into public.internal_org_people(id,node_kind,company_key,full_name,position_title,auth_user_id,started_date,is_active) values
('96000000-0000-4000-8000-000000000002','person','equipsy','Synthetic Closing A','Tester','96000000-0000-4000-8000-000000000002','2026-08-01',true),
('96000000-0000-4000-8000-000000000003','person','equipsy','Synthetic Closing B','Tester','96000000-0000-4000-8000-000000000003','2026-08-01',true);
insert into private.employee_directory_details(person_id,first_name,employment_type) values
('96000000-0000-4000-8000-000000000002','Synthetic','full_time'),
('96000000-0000-4000-8000-000000000003','Synthetic','full_time');
select pg_temp.set_test_actor('96000000-0000-4000-8000-000000000001');
select public.set_employee_annual_leave_balance(id,200,'2026-09-01',false) from public.internal_org_people where id::text like '96000000%';
select public.set_employee_sick_leave_balance(id,80,'2026-09-01') from public.internal_org_people where id::text like '96000000%';
insert into private.leave_accrual_policies(person_id,effective_from,weekly_hours,weekdays,annual_weeks,personal_weeks,enabled,note,actor_user_id)
select id,'2026-09-02',38,array[1,2,3,4,5],4,2,true,'Synthetic policy','96000000-0000-4000-8000-000000000001' from public.internal_org_people where id::text like '96000000%';
insert into public.leave_requests(id,employee_person_id,user_id,leave_type,request_type_label,start_date,end_date,business_days,status,submitted_at,record_origin,source_record_sha256,employment_type_snapshot,pay_treatment) values
('96000000-0000-4000-8000-000000000012','96000000-0000-4000-8000-000000000002','96000000-0000-4000-8000-000000000002','annual','Annual leave','2026-09-24','2026-09-25',2,'approved',now(),'historical_import',repeat('a',64),'full_time','paid_entitlement'),
('96000000-0000-4000-8000-000000000013','96000000-0000-4000-8000-000000000003','96000000-0000-4000-8000-000000000003','annual','Annual leave','2026-09-04','2026-09-25',16,'approved',now(),'historical_import',repeat('b',64),'full_time','paid_entitlement');
insert into private.payroll_balance_imports(id,company_key,employee_name,annual_hours,sick_hours,as_of,source_file,source_sha256,person_id,match_status)
select case when id='96000000-0000-4000-8000-000000000002' then '96000000-0000-4000-8000-000000000022'::uuid else '96000000-0000-4000-8000-000000000023'::uuid end,
  company_key,full_name,200,80,'2026-09-01','synthetic-opening.csv',repeat('d',64),id,'linked' from public.internal_org_people where id::text like '96000000%';
update private.employee_annual_leave_balances b set updated_by=null,source_import_id=i.id from private.payroll_balance_imports i where i.person_id=b.person_id;
update private.employee_sick_leave_balances b set updated_by=null,source_import_id=i.id from private.payroll_balance_imports i where i.person_id=b.person_id;
update private.annual_leave_balance_history h set actor_user_id=null,source_import_id=i.id from private.payroll_balance_imports i where i.person_id=h.person_id;
update private.sick_leave_balance_history h set actor_user_id=null,source_import_id=i.id from private.payroll_balance_imports i where i.person_id=h.person_id;
create function pg_temp.closing_payload() returns jsonb language sql as $$
select jsonb_build_object('closingDate','2026-09-24','provenance','owner_estimate','note','Owner-approved synthetic estimate; not verified payroll usage or daily dates.', 'people',jsonb_build_array(
jsonb_build_object('personId','96000000-0000-4000-8000-000000000002','company','equipsy','expectedFingerprint',public.preview_payroll_closing_reconciliation('96000000-0000-4000-8000-000000000002')->>'fingerprint','annualHours',100.1234,'personalHours',85.2345,'reservations',jsonb_build_array(jsonb_build_object('requestId','96000000-0000-4000-8000-000000000012','accountedHours',0,'pendingHours',7.6))),
jsonb_build_object('personId','96000000-0000-4000-8000-000000000003','company','equipsy','expectedFingerprint',public.preview_payroll_closing_reconciliation('96000000-0000-4000-8000-000000000003')->>'fingerprint','annualHours',140.4321,'personalHours',86.5432,'reservations',jsonb_build_array(jsonb_build_object('requestId','96000000-0000-4000-8000-000000000013','accountedHours',76,'pendingHours',38)))))
$$;
