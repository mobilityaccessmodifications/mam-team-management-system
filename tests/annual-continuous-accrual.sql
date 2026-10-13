\set ON_ERROR_STOP on
DO $$ BEGIN
 ASSERT current_database() ~ '^mam_test_', 'Synthetic database only';
 ASSERT inet_server_addr() IS NULL, 'Owned Unix socket only';
 ASSERT (now() at time zone 'Australia/Melbourne')::date > date '2026-10-06', 'Completed synthetic service date';
END $$;
BEGIN;
\ir sql-test-auth.sql
CREATE FUNCTION pg_temp.continuous_person(n integer) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$
 SELECT ('99000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid;
$$;
CREATE FUNCTION pg_temp.continuous_request(n integer) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$
 SELECT ('99100000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid;
$$;
INSERT INTO auth.users(id,email,email_confirmed_at) VALUES
 (pg_temp.continuous_person(1),'continuous-employee@example.test',now()),
 (pg_temp.continuous_person(900),'continuous-admin@example.test',now());
INSERT INTO public.profiles(id,full_name,app_role,login_name,credentials_valid_after) VALUES
 (pg_temp.continuous_person(1),'Synthetic Continuous','employee','continuous-employee',now()-interval '1 day'),
 (pg_temp.continuous_person(900),'Synthetic Continuous Admin','system_admin','continuous-admin',now()-interval '1 day');
INSERT INTO private.portal_account_admins(auth_user_id) VALUES(pg_temp.continuous_person(900));
INSERT INTO public.internal_org_people(id,node_kind,company_key,full_name,position_title,auth_user_id,started_date,is_active)
 VALUES(pg_temp.continuous_person(1),'person','mam','Synthetic Continuous','Synthetic tester',pg_temp.continuous_person(1),'2026-09-01',true);
INSERT INTO private.employee_directory_details(person_id,first_name,employment_type,working_weekdays)
 VALUES(pg_temp.continuous_person(1),'Synthetic','full_time',ARRAY[1,2,3,4,5]::smallint[]);
SELECT pg_temp.set_test_actor(pg_temp.continuous_person(900));
INSERT INTO private.employee_annual_leave_balances(person_id,hours,as_of,is_example,updated_by)
 VALUES(pg_temp.continuous_person(1),80.4321,'2026-10-01',false,pg_temp.continuous_person(900));
INSERT INTO private.employee_sick_leave_balances(person_id,hours,as_of,updated_by)
 VALUES(pg_temp.continuous_person(1),30.1234,'2026-10-01',pg_temp.continuous_person(900));
INSERT INTO private.leave_accrual_policies(person_id,effective_from,weekly_hours,weekdays,annual_weeks,personal_weeks,enabled,note,actor_user_id)
 VALUES(pg_temp.continuous_person(1),'2026-10-02',38,ARRAY[1,2,3,4,5],4,2,true,'Synthetic confirmed policy',pg_temp.continuous_person(900));
INSERT INTO private.leave_payroll_calendars(person_id,calendar_key) VALUES(pg_temp.continuous_person(1),'none');
INSERT INTO public.leave_requests(id,employee_person_id,user_id,leave_type,request_type_label,start_date,end_date,business_days,hours,status,submitted_at,record_origin,source_record_sha256,employment_type_snapshot,pay_treatment)
 VALUES(pg_temp.continuous_request(1),pg_temp.continuous_person(1),pg_temp.continuous_person(1),'annual','Annual leave','2026-10-05','2026-10-05',1,7.6,'approved',now(),'historical_import',repeat('a',64),'full_time','paid_entitlement');
DO $$ DECLARE a jsonb; BEGIN
 a:=private.calculate_leave_entitlement(pg_temp.continuous_person(1),'annual','2026-10-06');
 ASSERT a->>'status'='current', 'Routine completed approved annual leave must not wait for a manual review';
 ASSERT (a->>'taken')::numeric=7.6, 'Completed approval uses its canonical quantity automatically';
 ASSERT abs((a->>'earned')::numeric-22.8/13)<0.000000000001, 'Paid annual leave keeps ordinary accrual';
 ASSERT abs((a->>'exactHours')::numeric-(80.4321+22.8/13-7.6))<0.000000000001, 'Bank debits completed usage once';
 ASSERT (a->>'asOf')::date='2026-10-06';
 ASSERT NOT EXISTS(SELECT 1 FROM private.leave_accrual_day_reviews WHERE person_id=pg_temp.continuous_person(1)), 'Automatic usage must not fabricate payroll reviews';
END $$;
\echo PASS C01: completed approved annual leave accrues and is used without a manual payroll review
DO $$ DECLARE p jsonb; BEGIN
 p:=private.project_annual_leave_balance(pg_temp.continuous_person(1),'2026-10-07');
 ASSERT p->>'status'='projected';
 ASSERT (p->>'approvedHours')::numeric=7.6;
 ASSERT (p->>'otherTakenHours')::numeric=0, 'Automatic completed usage must not be charged again as an approval';
 ASSERT abs((p->>'availableHours')::numeric-(80.4321+22.8/13-7.6))<0.000000000001, 'Booking uses the same exact annual bank less unconsumed commitments';
END $$;
\echo PASS C02: booking does not double debit completed automatic usage
SAVEPOINT completed_cancellation;
UPDATE public.leave_requests SET status='cancelled' WHERE id=pg_temp.continuous_request(1);
DO $$ DECLARE a jsonb; p jsonb; BEGIN
 a:=private.calculate_leave_entitlement(pg_temp.continuous_person(1),'annual','2026-10-06');
 ASSERT a->>'status'='current';
 ASSERT (a->>'taken')::numeric=7.6, 'Cancelling completed annual leave must retain its already-used quantity';
 ASSERT abs((a->>'exactHours')::numeric-(80.4321+22.8/13-7.6))<0.000000000001, 'Completed cancellation is not a bank refund';
 p:=private.project_annual_leave_balance(pg_temp.continuous_person(1),'2026-10-07');
 ASSERT (p->>'approvedHours')::numeric=0;
 ASSERT (p->>'otherTakenHours')::numeric=7.6, 'Used history remains debited when no live commitment exists';
 ASSERT abs((p->>'availableHours')::numeric-(80.4321+22.8/13-7.6))<0.000000000001;
END $$;
\echo PASS C03: cancelling completed annual leave preserves used history without refund
ROLLBACK TO completed_cancellation;
SAVEPOINT durable_refresh;
SET LOCAL ROLE service_role;
DO $$ BEGIN
 ASSERT public.refresh_employee_leave_accrual()>=1, 'First synthetic checkpoint is recorded';
 ASSERT public.refresh_employee_leave_accrual()=0, 'Repeated refresh is idempotent';
END $$;
RESET ROLE;
DO $$ DECLARE before_count bigint; BEGIN
 ASSERT (SELECT count(*) FROM private.leave_accrual_calculations WHERE person_id=pg_temp.continuous_person(1))=1, 'This synthetic person has exactly one checkpoint';
 ASSERT EXISTS(SELECT 1 FROM private.annual_leave_day_accounting WHERE person_id=pg_temp.continuous_person(1) AND service_date='2026-10-05' AND (state->>'taken')::numeric=7.6), 'Daily refresh persists truthful automatic usage, not only a calculation JSON';
 SELECT count(*) INTO before_count FROM private.annual_leave_day_accounting WHERE person_id=pg_temp.continuous_person(1);
 PERFORM public.refresh_employee_leave_accrual();
 ASSERT (SELECT count(*) FROM private.annual_leave_day_accounting WHERE person_id=pg_temp.continuous_person(1))=before_count, 'Accounting snapshots do not duplicate on a retry';
 ASSERT NOT EXISTS(SELECT 1 FROM private.leave_accrual_day_reviews WHERE person_id=pg_temp.continuous_person(1));
END $$;
\echo PASS C04: daily service-only refresh persists immutable annual usage and checkpoints idempotently
ROLLBACK TO durable_refresh;
SAVEPOINT conditional_balance;
INSERT INTO public.leave_requests(id,employee_person_id,user_id,leave_type,request_type_label,start_date,end_date,business_days,hours,status,submitted_at,employment_type_snapshot,pay_treatment,approval_required,reason)
SELECT pg_temp.continuous_request(2),pg_temp.continuous_person(1),pg_temp.continuous_person(1),'annual','Annual leave',day,day,1,1,'submitted',now(),'full_time','paid_entitlement',true,'Synthetic continuous accrual note'
FROM (SELECT min(d::date) AS day FROM generate_series((now() at time zone 'Australia/Melbourne')::date+21,(now() at time zone 'Australia/Melbourne')::date+28,interval '1 day')d WHERE extract(isodow from d) BETWEEN 1 AND 5)dates;
INSERT INTO private.leave_balance_approvals(request_id,approved_by,approved_at)
VALUES(pg_temp.continuous_request(2),pg_temp.continuous_person(900),(now() at time zone 'Australia/Melbourne')::date-1);
DO $$ BEGIN
 ASSERT private.payroll_request_unconsumed_hours(pg_temp.continuous_person(1),'2026-10-01','2026-10-06')=0, 'Completed automatic usage is not an unconsumed commitment';
 ASSERT private.leave_payroll_balance_sufficient(pg_temp.continuous_request(2)), 'Conditional balance readiness must not wait for routine manual reviews';
 ASSERT private.approved_leave_hours_after(pg_temp.continuous_person(1),ARRAY['Annual leave'],'2026-10-01')=7.6, 'Pending requests do not reserve balance';
END $$;
\echo PASS C05: conditional sufficiency and pending-not-reserved use automatic consumed history
ROLLBACK TO conditional_balance;
SAVEPOINT holiday_quantity;
INSERT INTO auth.users(id,email,email_confirmed_at) VALUES(pg_temp.continuous_person(2),'continuous-holiday@example.test',now());
INSERT INTO public.profiles(id,full_name,app_role,login_name,credentials_valid_after) VALUES(pg_temp.continuous_person(2),'Synthetic Holiday','employee','continuous-holiday',now()-interval '1 day');
INSERT INTO public.internal_org_people(id,node_kind,company_key,full_name,position_title,auth_user_id,started_date,is_active)
 VALUES(pg_temp.continuous_person(2),'person','mam','Synthetic Holiday','Synthetic tester',pg_temp.continuous_person(2),'2026-09-01',true);
INSERT INTO private.employee_directory_details(person_id,first_name,employment_type,working_weekdays)
 VALUES(pg_temp.continuous_person(2),'Synthetic','full_time',ARRAY[1,2,3,4,5]::smallint[]);
INSERT INTO private.employee_annual_leave_balances(person_id,hours,as_of,is_example,updated_by)
 VALUES(pg_temp.continuous_person(2),200,'2026-10-01',false,pg_temp.continuous_person(900));
INSERT INTO private.leave_accrual_policies(person_id,effective_from,weekly_hours,weekdays,annual_weeks,personal_weeks,enabled,note,actor_user_id)
 VALUES(pg_temp.continuous_person(2),'2026-09-11',38,ARRAY[1,2,3,4,5],4,2,true,'Synthetic confirmed policy',pg_temp.continuous_person(900));
INSERT INTO public.leave_requests(id,employee_person_id,user_id,leave_type,request_type_label,start_date,end_date,business_days,hours,status,submitted_at,record_origin,source_record_sha256,employment_type_snapshot,pay_treatment)
 VALUES(pg_temp.continuous_request(6),pg_temp.continuous_person(2),pg_temp.continuous_person(2),'annual','Annual leave','2026-10-19','2026-11-13',20,NULL,'approved',now(),'historical_import',repeat('6',64),'full_time','paid_entitlement');
DO $$ DECLARE a jsonb; p jsonb; BEGIN
 ASSERT private.leave_payroll_day_hours(pg_temp.continuous_request(6),'2026-11-03')=7.6, 'A public holiday inside annual leave is not deducted from duration';
 ASSERT private.payroll_request_hours_after(pg_temp.continuous_request(6),'2026-10-01')=152, 'Twenty weekdays including a public holiday have a deterministic quantity';
 ASSERT private.leave_request_quantity(pg_temp.continuous_person(2),'2026-10-19','2026-11-13',NULL,NULL,NULL)=152;
 ASSERT private.leave_request_quantity(pg_temp.continuous_person(1),'2026-11-02','2026-11-04',NULL,NULL,NULL)=22.8, 'Explicit none calendar is unchanged';
 a:=private.calculate_leave_entitlement(pg_temp.continuous_person(2),'annual','2026-10-12');
 ASSERT a->>'status'='current' AND (a->>'taken')::numeric=0, 'Future approved leave is reserved, not taken';
 p:=private.project_annual_leave_balance(pg_temp.continuous_person(2),'2026-11-16');
 ASSERT p->>'status'='projected', 'Booking projection is available for a holiday-spanning approval';
 ASSERT (p->>'approvedHours')::numeric=152;
END $$;
UPDATE public.leave_requests SET start_date='2026-10-21',end_date='2026-11-12',business_days=17 WHERE id=pg_temp.continuous_request(6);
DO $$ BEGIN
 ASSERT private.payroll_request_hours_after(pg_temp.continuous_request(6),'2026-10-01')=129.2, 'Seventeen weekdays including the same holiday retain their canonical quantity';
 ASSERT (public.preview_annual_leave_request(pg_temp.continuous_person(2),'2026-10-21','2026-11-12',NULL,NULL)->>'requestedHours')::numeric=129.2, 'The real role-scoped booking RPC returns the same deterministic quantity';
 ASSERT public.preview_annual_leave_request(pg_temp.continuous_person(2),'2026-10-21','2026-11-12',NULL,NULL)->>'status'='projected';
 ASSERT private.leave_payroll_day_hours(pg_temp.continuous_request(6),'2026-11-03')=7.6;
END $$;
INSERT INTO private.leave_payroll_calendars(person_id,calendar_key) VALUES(pg_temp.continuous_person(2),'victoria');
DO $$ BEGIN
 ASSERT private.leave_request_quantity(pg_temp.continuous_person(2),'2026-11-02','2026-11-04',NULL,NULL,NULL)=15.2, 'Explicit Victoria calendar is unchanged';
 ASSERT private.leave_payroll_day_hours(pg_temp.continuous_request(6),'2026-11-03')=0;
END $$;
\echo PASS C06: holiday-spanning approved annual leave has a deterministic quantity without a payroll calendar row
ROLLBACK TO holiday_quantity;
SAVEPOINT amendment_credit;
INSERT INTO auth.users(id,email,email_confirmed_at) VALUES(pg_temp.continuous_person(3),'continuous-amend@example.test',now());
INSERT INTO public.profiles(id,full_name,app_role,login_name,credentials_valid_after) VALUES(pg_temp.continuous_person(3),'Synthetic Amend','employee','continuous-amend',now()-interval '1 day');
INSERT INTO public.internal_org_people(id,node_kind,company_key,full_name,position_title,auth_user_id,started_date,is_active)
 VALUES(pg_temp.continuous_person(3),'person','mam','Synthetic Amend','Synthetic tester',pg_temp.continuous_person(3),'2026-09-01',true);
INSERT INTO private.employee_directory_details(person_id,first_name,employment_type,working_weekdays)
 VALUES(pg_temp.continuous_person(3),'Synthetic','full_time',ARRAY[1,2,3,4,5]::smallint[]);
INSERT INTO private.employee_annual_leave_balances(person_id,hours,as_of,is_example,updated_by)
 VALUES(pg_temp.continuous_person(3),120,'2026-10-01',false,pg_temp.continuous_person(900));
INSERT INTO private.leave_accrual_policies(person_id,effective_from,weekly_hours,weekdays,annual_weeks,personal_weeks,enabled,note,actor_user_id)
 VALUES(pg_temp.continuous_person(3),'2026-10-02',38,ARRAY[1,2,3,4,5],4,2,true,'Synthetic confirmed policy',pg_temp.continuous_person(900));
INSERT INTO private.leave_payroll_calendars(person_id,calendar_key) VALUES(pg_temp.continuous_person(3),'none');
INSERT INTO public.leave_requests(id,employee_person_id,user_id,leave_type,request_type_label,start_date,end_date,business_days,hours,status,submitted_at,record_origin,source_record_sha256,employment_type_snapshot,pay_treatment)
 VALUES(pg_temp.continuous_request(7),pg_temp.continuous_person(3),pg_temp.continuous_person(3),'annual','Annual leave','2026-10-05','2026-10-23',15,NULL,'approved',now(),'historical_import',repeat('7',64),'full_time','paid_entitlement');
SAVEPOINT amendment_rejected;
DO $$ DECLARE rejected boolean:=false; BEGIN
 BEGIN
  UPDATE public.leave_requests SET start_date='2026-10-13',end_date='2026-10-30',business_days=14 WHERE id=pg_temp.continuous_request(7);
 EXCEPTION WHEN sqlstate '22023' THEN rejected:=SQLERRM LIKE 'Not enough balance%';
 END;
 ASSERT rejected, 'Amendment credits only the unconsumed part of the original approval';
END $$;
ROLLBACK TO amendment_rejected;
UPDATE private.employee_annual_leave_balances SET hours=160 WHERE person_id=pg_temp.continuous_person(3);
UPDATE public.leave_requests SET start_date='2026-10-13',end_date='2026-10-30',business_days=14 WHERE id=pg_temp.continuous_request(7);
DO $$ DECLARE a jsonb; p jsonb; BEGIN
 a:=private.calculate_leave_entitlement(pg_temp.continuous_person(3),'annual','2026-10-12');
 ASSERT a->>'status'='current' AND (a->>'taken')::numeric=45.6, 'Amending completed leave keeps its consumed usage';
 p:=private.project_annual_leave_balance(pg_temp.continuous_person(3),'2026-10-13');
 ASSERT (p->>'approvedHours')::numeric=106.4 AND (p->>'otherTakenHours')::numeric=45.6;
 ASSERT abs((p->>'availableHours')::numeric-(160+7*7.6*4/52-106.4-45.6))<0.000000000001, 'Consumed and amended future hours are each debited once';
 ASSERT private.payroll_request_unconsumed_hours(pg_temp.continuous_person(3),'2026-10-01','2026-10-12')=106.4;
END $$;
\echo PASS C07: amending in-progress annual leave keeps consumed usage and credits only the unconsumed approval
UPDATE public.leave_requests SET status='cancelled' WHERE id=pg_temp.continuous_request(7);
DO $$ DECLARE p jsonb; BEGIN
 p:=private.project_annual_leave_balance(pg_temp.continuous_person(3),'2026-10-13');
 ASSERT (p->>'approvedHours')::numeric=0 AND (p->>'otherTakenHours')::numeric=45.6;
 ASSERT abs((p->>'availableHours')::numeric-(160+7*7.6*4/52-45.6))<0.000000000001, 'Only the unconsumed future part is released';
 ASSERT private.payroll_request_unconsumed_hours(pg_temp.continuous_person(3),'2026-10-01','2026-10-12')=0;
END $$;
\echo PASS C14: cancelling in-progress leave releases future reservations but keeps completed consumption
ROLLBACK TO amendment_credit;
SAVEPOINT unpaid_and_review;
INSERT INTO public.leave_requests(id,employee_person_id,user_id,leave_type,request_type_label,start_date,end_date,business_days,hours,status,submitted_at,record_origin,source_record_sha256,employment_type_snapshot,pay_treatment)
 VALUES(pg_temp.continuous_request(8),pg_temp.continuous_person(1),pg_temp.continuous_person(1),'unpaid','Unpaid leave','2026-10-07','2026-10-07',1,NULL,'approved',now(),'historical_import',repeat('8',64),'full_time','unpaid');
INSERT INTO private.leave_accrual_day_reviews(person_id,service_date,annual_eligible_hours,personal_eligible_hours,annual_taken_hours,personal_taken_hours,request_fingerprint,note,actor_user_id)
 VALUES(pg_temp.continuous_person(1),'2026-10-05',7.6,7.6,3.8,0,private.leave_accrual_request_fingerprint(pg_temp.continuous_person(1),'2026-10-05'),'Synthetic confirmed review',pg_temp.continuous_person(900));
DO $$ DECLARE a jsonb; s jsonb; BEGIN
 a:=private.calculate_leave_entitlement(pg_temp.continuous_person(1),'annual','2026-10-08');
 ASSERT a->>'status'='current', 'Approved unpaid leave does not pause annual accrual';
 ASSERT abs((a->>'earned')::numeric-4*7.6*4/52)<0.000000000001, 'Approved unpaid leave reduces eligible service by its recorded quantity';
 ASSERT (a->>'taken')::numeric=3.8, 'A valid manual review overrides automatic usage';
 s:=private.calculate_leave_entitlement(pg_temp.continuous_person(1),'personal','2026-10-08');
 ASSERT s->>'status'='needs_review', 'Personal leave review behaviour is unchanged';
END $$;
\echo PASS C08: unpaid leave reduces eligible service, manual reviews override, personal logic unchanged
ROLLBACK TO unpaid_and_review;
SAVEPOINT employment_usage;
INSERT INTO private.leave_accrual_day_reviews(person_id,service_date,annual_eligible_hours,personal_eligible_hours,annual_taken_hours,personal_taken_hours,request_fingerprint,note,actor_user_id)
 VALUES(pg_temp.continuous_person(1),'2026-10-05',7.6,7.6,3.8,0,private.leave_accrual_request_fingerprint(pg_temp.continuous_person(1),'2026-10-05'),'Synthetic valid usage before corrected employment dates',pg_temp.continuous_person(900));
UPDATE private.employee_directory_details SET scheduled_employment_end_date='2026-10-01' WHERE person_id=pg_temp.continuous_person(1);
DO $$ DECLARE a jsonb; BEGIN
 a:=private.calculate_leave_entitlement(pg_temp.continuous_person(1),'annual','2026-10-06');
 ASSERT a->>'status'='current' AND (a->>'taken')::numeric=3.8, 'Employment boundaries must not erase valid confirmed usage';
 ASSERT (a->>'earned')::numeric=0;
END $$;
\echo PASS C09: corrected employment dates stop accrual but never erase confirmed usage
ROLLBACK TO employment_usage;
SAVEPOINT source_carry_usage;
INSERT INTO private.leave_bank_sources(person_id,leave_kind,hours,report_date,covered_service_through,source_kind,source_fingerprint,note,operator_role)
 VALUES(pg_temp.continuous_person(1),'annual',80.4321,'2026-10-01','2026-10-01','payslip',repeat('b',64),'Synthetic source before completed carried request','postgres');
INSERT INTO private.payroll_closing_receipts(id,owner_key,actor_user_id,operation,provenance,note,payload,result)
 VALUES('99200000-0000-4000-8000-000000000010','synthetic-continuous-carry',pg_temp.continuous_person(900),'closing','owner_estimate','Synthetic retained quantity','[]','{}');
INSERT INTO private.payroll_carryforward_events(receipt_id,request_id,person_id,company_key,leave_kind,origin_after,through_date,total_hours,accounted_hours,pending_hours,request_fingerprint)
 SELECT '99200000-0000-4000-8000-000000000010',r.id,r.employee_person_id,'mam','annual','2026-10-01','2026-10-05',7.6,0,7.6,private.payroll_request_fingerprint(to_jsonb(r)) FROM public.leave_requests r WHERE id=pg_temp.continuous_request(1);
DO $$ DECLARE a jsonb; p jsonb; BEGIN
 a:=private.calculate_leave_entitlement(pg_temp.continuous_person(1),'annual','2026-10-06');
 ASSERT a->>'status'='current' AND (a->>'taken')::numeric=7.6;
 ASSERT private.approved_leave_hours_after(pg_temp.continuous_person(1),ARRAY['Annual leave'],'2026-10-01')=7.6, 'Automatic canonical usage subsumes the same post-cutoff carried obligation';
 p:=private.project_annual_leave_balance(pg_temp.continuous_person(1),'2026-10-07');
 ASSERT abs((p->>'availableHours')::numeric-(80.4321+22.8/13-7.6))<0.000000000001, 'An old pending allocation and automatic consumption must not double debit';
 ASSERT private.payroll_request_unconsumed_hours(pg_temp.continuous_person(1),'2026-10-01','2026-10-06')=0;
END $$;
UPDATE public.leave_requests SET status='cancelled' WHERE id=pg_temp.continuous_request(1);
DO $$ DECLARE a jsonb; p jsonb; BEGIN
 a:=private.calculate_leave_entitlement(pg_temp.continuous_person(1),'annual','2026-10-06');
 ASSERT a->>'status'='current' AND (a->>'taken')::numeric=7.6;
 p:=private.project_annual_leave_balance(pg_temp.continuous_person(1),'2026-10-07');
 ASSERT (p->>'approvedHours')::numeric=0 AND (p->>'otherTakenHours')::numeric=7.6;
 ASSERT abs((p->>'availableHours')::numeric-(80.4321+22.8/13-7.6))<0.000000000001, 'Carried cancellation retains consumption';
END $$;
INSERT INTO private.leave_bank_sources(person_id,leave_kind,hours,report_date,covered_service_through,source_kind,source_fingerprint,note,operator_role)
 VALUES(pg_temp.continuous_person(1),'annual',74.586,'2026-10-06','2026-10-06','payslip',repeat('c',64),'Synthetic later confirmed closing includes earlier consumption','postgres');
DO $$ DECLARE a jsonb; BEGIN
 a:=private.calculate_leave_entitlement(pg_temp.continuous_person(1),'annual','2026-10-06');
 ASSERT a->>'status'='current' AND (a->>'taken')::numeric=0 AND (a->>'exactHours')::numeric=74.586, 'A later source closing preserves prior consumption without another debit';
 ASSERT EXISTS(SELECT 1 FROM private.annual_leave_day_accounting WHERE person_id=pg_temp.continuous_person(1) AND service_date='2026-10-05' AND (state->>'taken')::numeric=7.6);
END $$;
\echo PASS C10: post-cutoff carry, automatic usage, cancellation and a later closing each debit once
ROLLBACK TO source_carry_usage;
SAVEPOINT refreshed_unpaid;
SELECT public.refresh_employee_leave_accrual();
INSERT INTO public.leave_requests(id,employee_person_id,user_id,leave_type,request_type_label,start_date,end_date,business_days,hours,status,submitted_at,record_origin,source_record_sha256,employment_type_snapshot,pay_treatment)
 VALUES(pg_temp.continuous_request(11),pg_temp.continuous_person(1),pg_temp.continuous_person(1),'unpaid','Unpaid leave','2026-10-06','2026-10-06',1,3.8,'approved',now(),'historical_import',encode(sha256(convert_to('continuous-unpaid-checkpoint-11','UTF8')),'hex'),'full_time','unpaid');
DO $$ DECLARE a jsonb; BEGIN
 a:=private.calculate_leave_entitlement(pg_temp.continuous_person(1),'annual','2026-10-06');
 ASSERT a->>'status'='current';
 ASSERT abs((a->>'earned')::numeric-19.0/13)<0.000000000001, 'A checkpoint must not hide newly approved recorded unpaid service';
 ASSERT (a->>'taken')::numeric=7.6;
END $$;
\echo PASS C11: refreshed accounting still observes recorded unpaid service changes
ROLLBACK TO refreshed_unpaid;
SAVEPOINT personal_calendar;
INSERT INTO public.leave_requests(id,employee_person_id,user_id,leave_type,request_type_label,start_date,end_date,business_days,hours,status,submitted_at,record_origin,source_record_sha256,employment_type_snapshot,pay_treatment)
 VALUES(pg_temp.continuous_request(12),pg_temp.continuous_person(1),pg_temp.continuous_person(1),'personal','Sick leave','2026-11-03','2026-11-03',1,3.8,'approved',now(),'historical_import',repeat('e',64),'full_time','paid_entitlement');
DELETE FROM private.leave_payroll_calendars WHERE person_id=pg_temp.continuous_person(1);
INSERT INTO public.leave_requests(id,employee_person_id,user_id,leave_type,request_type_label,start_date,end_date,business_days,hours,status,submitted_at,record_origin,source_record_sha256,employment_type_snapshot,pay_treatment)
 VALUES(pg_temp.continuous_request(121),pg_temp.continuous_person(1),pg_temp.continuous_person(1),'personal','Sick leave','2026-11-02','2026-11-04',3,22.8,'approved',now(),'historical_import',encode(sha256(convert_to('continuous-personal-calendar-121','UTF8')),'hex'),'full_time','paid_entitlement');
DO $$ BEGIN
 ASSERT private.leave_payroll_day_hours(pg_temp.continuous_request(121),'2026-11-04') IS NULL, 'Personal recorded multiday hours keep the original whole-request calendar boundary';
 ASSERT private.payroll_request_hours_after(pg_temp.continuous_request(121),'2026-11-03') IS NULL, 'An earlier unknown personal holiday cannot be discarded at a later cutoff';
 ASSERT private.leave_payroll_day_hours(pg_temp.continuous_request(12),'2026-11-03') IS NULL, 'Personal holiday quantity retains its prior unknown-calendar boundary';
 ASSERT private.payroll_request_hours_after(pg_temp.continuous_request(12),'2026-10-01') IS NULL, 'Explicit personal hours retain the same calendar boundary';
 ASSERT private.leave_request_quantity(pg_temp.continuous_person(1),'2026-11-03','2026-11-03',NULL,NULL,NULL)=7.6, 'Annual duration uses the confirmed weekday default';
END $$;
\echo PASS C12: annual default duration does not change personal/sick holiday quantities
ROLLBACK TO personal_calendar;
SAVEPOINT retained_before_cutoff;
INSERT INTO private.leave_bank_sources(person_id,leave_kind,hours,report_date,covered_service_through,source_kind,source_fingerprint,note,operator_role)
 VALUES(pg_temp.continuous_person(1),'annual',80.4321,'2026-10-06','2026-10-06','payslip',repeat('f',64),'Synthetic known service with undeducted retained consumption','postgres');
INSERT INTO private.payroll_closing_receipts(id,owner_key,actor_user_id,operation,provenance,note,payload,result)
 VALUES('99200000-0000-4000-8000-000000000013','synthetic-retained-before-cutoff',pg_temp.continuous_person(900),'closing','owner_estimate','Synthetic undeducted closing allocation','[]','{}');
INSERT INTO private.payroll_carryforward_events(receipt_id,request_id,person_id,company_key,leave_kind,origin_after,through_date,total_hours,accounted_hours,pending_hours,request_fingerprint)
 SELECT '99200000-0000-4000-8000-000000000013',r.id,r.employee_person_id,'mam','annual','2026-10-01','2026-10-06',7.6,0,7.6,private.payroll_request_fingerprint(to_jsonb(r)) FROM public.leave_requests r WHERE id=pg_temp.continuous_request(1);
DO $$ DECLARE a jsonb; p jsonb; BEGIN
 a:=private.calculate_leave_entitlement(pg_temp.continuous_person(1),'annual','2026-10-06');
 ASSERT a->>'status'='current' AND (a->>'taken')::numeric=7.6, 'Completed retained usage not included in the source is used, not future leave';
 p:=private.project_annual_leave_balance(pg_temp.continuous_person(1),'2026-10-07');
 ASSERT (p->>'availableHours')::numeric=72.8321, 'Retained consumption is debited once before cancellation';
END $$;
UPDATE public.leave_requests SET status='cancelled' WHERE id=pg_temp.continuous_request(1);
DO $$ DECLARE a jsonb; p jsonb; BEGIN
 a:=private.calculate_leave_entitlement(pg_temp.continuous_person(1),'annual','2026-10-06');
 ASSERT a->>'status'='current' AND (a->>'taken')::numeric=7.6, 'Cancellation cannot release pre-cutoff retained consumed usage';
 p:=private.project_annual_leave_balance(pg_temp.continuous_person(1),'2026-10-07');
 ASSERT (p->>'approvedHours')::numeric=0 AND (p->>'otherTakenHours')::numeric=7.6 AND (p->>'availableHours')::numeric=72.8321;
 ASSERT (SELECT hours FROM private.employee_annual_leave_balances WHERE person_id=pg_temp.continuous_person(1))=80.4321, 'Accounting never mutates the payroll source bank';
END $$;
INSERT INTO private.leave_bank_sources(person_id,leave_kind,hours,report_date,covered_service_through,source_kind,source_fingerprint,note,operator_role)
 VALUES(pg_temp.continuous_person(1),'annual',72.8321,'2026-10-06','2026-10-06','payslip',repeat('a',64),'Synthetic later source explicitly closes preserved consumed usage','postgres');
DO $$ BEGIN
 ASSERT (private.calculate_leave_entitlement(pg_temp.continuous_person(1),'annual','2026-10-06')->>'exactHours')::numeric=72.8321;
END $$;
\echo PASS C13: retained completed usage before a source cutoff survives cancellation and a later closing exactly once
ROLLBACK TO retained_before_cutoff;
SAVEPOINT recorded_quantities;
INSERT INTO auth.users(id,email,email_confirmed_at) VALUES(pg_temp.continuous_person(4),'continuous-recorded@example.test',now());
INSERT INTO public.profiles(id,full_name,app_role,login_name,credentials_valid_after) VALUES(pg_temp.continuous_person(4),'Synthetic Recorded','employee','continuous-recorded',now()-interval '1 day');
INSERT INTO public.internal_org_people(id,node_kind,company_key,full_name,position_title,auth_user_id,started_date,is_active)
 VALUES(pg_temp.continuous_person(4),'person','mam','Synthetic Recorded','Synthetic tester',pg_temp.continuous_person(4),'2026-09-01',true);
INSERT INTO private.employee_directory_details(person_id,first_name,employment_type,working_weekdays)
 VALUES(pg_temp.continuous_person(4),'Synthetic','full_time',ARRAY[1,2,3,4,5]::smallint[]);
INSERT INTO private.employee_annual_leave_balances(person_id,hours,as_of,is_example,updated_by)
 VALUES(pg_temp.continuous_person(4),80.4321,'2026-10-01',false,pg_temp.continuous_person(900));
INSERT INTO private.leave_accrual_policies(person_id,effective_from,weekly_hours,weekdays,annual_weeks,personal_weeks,enabled,note,actor_user_id)
 VALUES(pg_temp.continuous_person(4),'2026-10-02',38,ARRAY[1,2,3,4,5],4,2,true,'Synthetic recorded quantity policy',pg_temp.continuous_person(900));
INSERT INTO public.leave_requests(id,employee_person_id,user_id,leave_type,request_type_label,start_date,end_date,business_days,hours,status,submitted_at,record_origin,source_record_sha256,employment_type_snapshot,pay_treatment)
 VALUES(pg_temp.continuous_request(15),pg_temp.continuous_person(4),pg_temp.continuous_person(4),'annual','Annual leave','2026-10-05','2026-10-06',2,7.6,'approved',now(),'historical_import',encode(sha256(convert_to('continuous-recorded-annual-15','UTF8')),'hex'),'full_time','paid_entitlement');
DO $$ DECLARE a jsonb; BEGIN
 ASSERT private.leave_payroll_day_hours(pg_temp.continuous_request(15),'2026-10-05')=3.8;
 ASSERT private.payroll_request_hours_after(pg_temp.continuous_request(15),'2026-10-01')=7.6, 'Explicit canonical request quantity is unchanged';
 ASSERT private.payroll_request_hours_after(pg_temp.continuous_request(15),'2026-10-05')=3.8;
 a:=private.calculate_leave_entitlement(pg_temp.continuous_person(4),'annual','2026-10-06');
 ASSERT a->>'status'='current' AND (a->>'taken')::numeric=7.6, 'Recorded multiday annual hours need no routine day review';
END $$;
\echo PASS C15: recorded multiday annual quantities stay exact and consume automatically
SAVEPOINT recorded_fractional;
INSERT INTO public.leave_requests(id,employee_person_id,user_id,leave_type,request_type_label,start_date,end_date,business_days,hours,status,submitted_at,record_origin,source_record_sha256,employment_type_snapshot,pay_treatment)
 VALUES(pg_temp.continuous_request(151),pg_temp.continuous_person(4),pg_temp.continuous_person(4),'annual','Annual leave','2026-10-05','2026-10-07',3,5,'approved',now(),'historical_import',encode(sha256(convert_to('continuous-recorded-fractional-151','UTF8')),'hex'),'full_time','paid_entitlement');
DO $$ BEGIN
 ASSERT (SELECT sum(private.leave_payroll_day_hours(pg_temp.continuous_request(151),d::date)) FROM generate_series(date '2026-10-05',date '2026-10-07',interval '1 day')d)=5, 'Fractional daily allocation telescopes to the exact recorded total';
END $$;
ROLLBACK TO recorded_fractional;
INSERT INTO public.leave_requests(id,employee_person_id,user_id,leave_type,request_type_label,start_date,end_date,business_days,hours,status,submitted_at,record_origin,source_record_sha256,employment_type_snapshot,pay_treatment)
 VALUES(pg_temp.continuous_request(16),pg_temp.continuous_person(4),pg_temp.continuous_person(4),'unpaid','Unpaid leave','2026-10-06','2026-10-07',2,7.6,'approved',now(),'historical_import',encode(sha256(convert_to('continuous-recorded-unpaid-16','UTF8')),'hex'),'full_time','unpaid');
DO $$ DECLARE a jsonb; BEGIN
 ASSERT private.leave_payroll_day_hours(pg_temp.continuous_request(16),'2026-10-06')=3.8;
 ASSERT private.payroll_request_hours_after(pg_temp.continuous_request(16),'2026-10-01')=7.6;
 a:=private.calculate_leave_entitlement(pg_temp.continuous_person(4),'annual','2026-10-07');
 ASSERT a->>'status'='current' AND (a->>'taken')::numeric=7.6;
 ASSERT abs((a->>'earned')::numeric-22.8/13)<0.000000000001, 'Recorded multiday unpaid quantity reduces eligible service exactly once';
END $$;
INSERT INTO private.employee_sick_leave_balances(person_id,hours,as_of,updated_by)
 VALUES(pg_temp.continuous_person(4),40,'2026-10-31',pg_temp.continuous_person(900));
INSERT INTO public.leave_requests(id,employee_person_id,user_id,leave_type,request_type_label,start_date,end_date,business_days,hours,status,submitted_at,record_origin,source_record_sha256,employment_type_snapshot,pay_treatment)
 VALUES(pg_temp.continuous_request(161),pg_temp.continuous_person(4),pg_temp.continuous_person(4),'unpaid','Unpaid leave','2026-11-02','2026-11-04',3,5,'approved',now(),'historical_import',encode(sha256(convert_to('continuous-personal-unpaid-forecast-161','UTF8')),'hex'),'full_time','unpaid');
DO $$ DECLARE p jsonb; BEGIN
 p:=private.calculate_leave_entitlement(pg_temp.continuous_person(4),'personal','2026-11-04');
 ASSERT p->>'status'='needs_review' AND (p->>'reviewDate')::date='2026-11-02', 'Personal future unpaid review boundaries are unchanged';
END $$;
\echo PASS C16: recorded multiday unpaid hours reduce annual eligible service without review holds
UPDATE private.employee_annual_leave_balances SET as_of='2026-10-07',hours=80 WHERE person_id=pg_temp.continuous_person(4);
INSERT INTO private.payroll_closing_receipts(id,owner_key,actor_user_id,operation,provenance,note,payload,result)
 VALUES('99200000-0000-4000-8000-000000000017','synthetic-retained-timezone',pg_temp.continuous_person(900),'closing','owner_estimate','Synthetic legacy retained identity across sessions','[]','{}');
INSERT INTO private.payroll_carryforward_events(receipt_id,request_id,person_id,company_key,leave_kind,origin_after,through_date,total_hours,accounted_hours,pending_hours,request_fingerprint)
 SELECT '99200000-0000-4000-8000-000000000017',r.id,r.employee_person_id,'mam','annual','2026-10-01','2026-10-07',7.6,0,7.6,private.payroll_request_fingerprint(to_jsonb(r)) FROM public.leave_requests r WHERE id=pg_temp.continuous_request(15);
SET LOCAL TIME ZONE 'UTC';
UPDATE public.leave_requests SET status='cancelled' WHERE id=pg_temp.continuous_request(15);
DO $$ BEGIN
 ASSERT (private.calculate_leave_entitlement(pg_temp.continuous_person(4),'annual','2026-10-07')->>'taken')::numeric=7.6;
END $$;
SET LOCAL TIME ZONE 'Australia/Melbourne';
DO $$ BEGIN
 ASSERT (private.calculate_leave_entitlement(pg_temp.continuous_person(4),'annual','2026-10-07')->>'taken')::numeric=7.6, 'Changing a SQL session timezone cannot refund retained consumption';
END $$;
\echo PASS C17: retained legacy-bank consumption uses a timezone-independent bank identity
SET LOCAL TIME ZONE DEFAULT;
ROLLBACK TO recorded_quantities;
SAVEPOINT reviewed_checkpoint;
INSERT INTO private.leave_accrual_day_reviews(person_id,service_date,annual_eligible_hours,personal_eligible_hours,annual_taken_hours,personal_taken_hours,request_fingerprint,note,actor_user_id)
 VALUES(pg_temp.continuous_person(1),'2026-10-05',7.6,7.6,3.8,0,private.leave_accrual_request_fingerprint(pg_temp.continuous_person(1),'2026-10-05'),'Synthetic reviewed checkpoint',pg_temp.continuous_person(900));
SELECT public.refresh_employee_leave_accrual();
DO $$ DECLARE a jsonb; BEGIN
 a:=private.annual_leave_accounting_day(pg_temp.continuous_person(1),'2026-10-05');
 ASSERT a->>'status'='current' AND (a->>'taken')::numeric=3.8 AND (a->>'eligibleNumerator')::numeric=7.6*420;
 ASSERT EXISTS(SELECT 1 FROM private.annual_leave_day_accounting WHERE person_id=pg_temp.continuous_person(1) AND service_date='2026-10-05' AND state=a), 'The reviewed day is durably captured before its requests change';
END $$;
SAVEPOINT reviewed_requests_changed;
INSERT INTO public.leave_requests(id,employee_person_id,user_id,leave_type,request_type_label,start_date,end_date,business_days,hours,status,submitted_at,record_origin,source_record_sha256,employment_type_snapshot,pay_treatment)
 VALUES(pg_temp.continuous_request(18),pg_temp.continuous_person(1),pg_temp.continuous_person(1),'unpaid','Unpaid leave','2026-10-05','2026-10-05',1,3.8,'approved',now(),'historical_import',encode(sha256(convert_to('continuous-reviewed-unpaid-18','UTF8')),'hex'),'full_time','unpaid');
DO $$ DECLARE a jsonb; BEGIN
 ASSERT EXISTS(SELECT 1 FROM private.leave_accrual_day_reviews WHERE person_id=pg_temp.continuous_person(1) AND service_date='2026-10-05' AND request_fingerprint<>private.leave_accrual_request_fingerprint(pg_temp.continuous_person(1),'2026-10-05'));
 a:=private.annual_leave_accounting_day(pg_temp.continuous_person(1),'2026-10-05');
 ASSERT a->>'status'='needs_review', 'New approved unpaid leave invalidates saved reviewed eligibility';
 ASSERT (a->>'taken')::numeric=3.8, 'Invalidating eligibility does not refund confirmed completed usage';
 a:=private.calculate_leave_entitlement(pg_temp.continuous_person(1),'annual','2026-10-06');
 ASSERT a->>'status'='needs_review' AND a->>'eligibilityStatus'='needs_review' AND (a->>'taken')::numeric=3.8;
 ASSERT abs((a->>'earned')::numeric-7.6/13)<0.000000000001, 'Stale reviewed service cannot be credited';
 ASSERT private.project_annual_leave_balance(pg_temp.continuous_person(1),'2026-10-07')->>'status'='unavailable';
 ASSERT private.payroll_request_unconsumed_hours(pg_temp.continuous_person(1),'2026-10-01','2026-10-06') IS NULL;
 PERFORM public.refresh_employee_leave_accrual();
 ASSERT (SELECT count(*) FROM private.annual_leave_day_accounting WHERE person_id=pg_temp.continuous_person(1) AND service_date='2026-10-05')=1, 'Refresh cannot replace stale review evidence with a current snapshot';
END $$;
INSERT INTO private.leave_accrual_day_reviews(person_id,service_date,annual_eligible_hours,personal_eligible_hours,annual_taken_hours,personal_taken_hours,request_fingerprint,note,actor_user_id)
 VALUES(pg_temp.continuous_person(1),'2026-10-05',3.8,3.8,3.8,0,private.leave_accrual_request_fingerprint(pg_temp.continuous_person(1),'2026-10-05'),'Synthetic revalidated unpaid service',pg_temp.continuous_person(900));
DO $$ DECLARE a jsonb; BEGIN
 a:=private.calculate_leave_entitlement(pg_temp.continuous_person(1),'annual','2026-10-06');
 ASSERT a->>'status'='current' AND (a->>'taken')::numeric=3.8;
 ASSERT abs((a->>'earned')::numeric-19.0/13)<0.000000000001, 'A fresh review restores only confirmed eligible service';
END $$;
ROLLBACK TO reviewed_requests_changed;
UPDATE public.leave_requests SET status='cancelled' WHERE id=pg_temp.continuous_request(1);
DO $$ DECLARE a jsonb; BEGIN
 a:=private.calculate_leave_entitlement(pg_temp.continuous_person(1),'annual','2026-10-06');
 ASSERT a->>'status'='needs_review' AND (a->>'taken')::numeric=3.8, 'Cancelled reviewed leave retains consumption while stale eligibility fails closed';
END $$;
ROLLBACK TO reviewed_requests_changed;
UPDATE public.leave_requests SET hours=1.9 WHERE id=pg_temp.continuous_request(1);
DO $$ DECLARE a jsonb; BEGIN
 a:=private.calculate_leave_entitlement(pg_temp.continuous_person(1),'annual','2026-10-06');
 ASSERT a->>'status'='needs_review' AND (a->>'taken')::numeric=3.8, 'Amended reviewed leave cannot refund already consumed hours';
END $$;
\echo PASS C18: saved reviewed accounting revalidates request fingerprints and retains consumed annual usage
ROLLBACK TO reviewed_checkpoint;
SAVEPOINT nonannual_unresolved_day;
INSERT INTO private.leave_accrual_policies(person_id,effective_from,weekly_hours,weekdays,annual_weeks,personal_weeks,enabled,requires_review,note,actor_user_id)
 VALUES(pg_temp.continuous_person(1),'2026-10-05',38,ARRAY[1,2,3,4,5],4,2,true,true,'Synthetic unresolved annual day',pg_temp.continuous_person(900));
UPDATE private.employee_directory_details SET trade_school_enabled=true WHERE person_id=pg_temp.continuous_person(1);
DO $$ DECLARE r record; n integer; request_id uuid; blocked boolean:=false; BEGIN
 ASSERT private.annual_leave_accounting_day(pg_temp.continuous_person(1),'2026-10-05')->>'status'='needs_review';
 FOR r IN SELECT * FROM (VALUES
  (19,'personal','Sick leave','paid_entitlement'),
  (190,'personal','Carer''s leave','paid_entitlement'),
  (191,'unpaid','Unpaid leave','unpaid'),
  (192,'other','Other leave','unpaid'),
  (193,'other','trade school','paid_other')
 )kinds(number,leave_type,label,treatment) LOOP
  FOR n IN 1..2 LOOP
   request_id:=pg_temp.continuous_request(r.number*10+n);
   INSERT INTO public.leave_requests(id,employee_person_id,user_id,leave_type,request_type_label,start_date,end_date,business_days,hours,status,submitted_at,record_origin,source_record_sha256,employment_type_snapshot,pay_treatment)
    VALUES(request_id,pg_temp.continuous_person(1),pg_temp.continuous_person(1),r.leave_type,r.label,'2026-10-05','2026-10-05',1,3.8,'approved',now(),'historical_import',encode(sha256(convert_to('continuous-nonannual-'||request_id::text,'UTF8')),'hex'),'full_time',r.treatment);
   IF n=1 THEN
    UPDATE public.leave_requests SET status='cancelled' WHERE id=request_id;
    ASSERT (SELECT status='cancelled' AND hours=3.8 FROM public.leave_requests WHERE id=request_id), r.label||' cancellation succeeds with unresolved annual accounting';
   ELSE
    UPDATE public.leave_requests SET hours=1.9 WHERE id=request_id;
    ASSERT (SELECT status='approved' AND hours=1.9 FROM public.leave_requests WHERE id=request_id), r.label||' amendment succeeds with unresolved annual accounting';
   END IF;
   ASSERT private.annual_leave_accounting_day(pg_temp.continuous_person(1),'2026-10-05')->>'status'='needs_review', 'Nonannual changes cannot fabricate an annual review';
  END LOOP;
 END LOOP;
 ASSERT NOT EXISTS(SELECT 1 FROM private.annual_leave_day_accounting WHERE person_id=pg_temp.continuous_person(1)), 'Nonannual lifecycle changes never capture annual accounting';
 BEGIN
  UPDATE public.leave_requests SET status='cancelled' WHERE id=pg_temp.continuous_request(1);
 EXCEPTION WHEN sqlstate '55000' THEN blocked:=SQLERRM='Completed annual accounting requires a confirmed day review.';
 END;
 ASSERT blocked AND (SELECT status='approved' FROM public.leave_requests WHERE id=pg_temp.continuous_request(1)), 'Unresolved completed annual cancellation still fails closed';
END $$;
\echo PASS C19: nonannual cancellations and amendments bypass unresolved annual accounting without weakening annual guards
ROLLBACK TO nonannual_unresolved_day;
ROLLBACK;
