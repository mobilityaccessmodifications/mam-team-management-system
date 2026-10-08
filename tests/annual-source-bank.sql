\set ON_ERROR_STOP on
DO $$ BEGIN
  ASSERT current_database() ~ '^mam_test_', 'Synthetic database only';
  ASSERT inet_server_addr() IS NULL, 'Owned local Unix socket only';
  ASSERT (now() at time zone 'Australia/Melbourne')::date >= date '2026-10-08', 'Completed-service fixture';
  ASSERT to_regprocedure('private.leave_payroll_day_hours(uuid,date)') IS NOT NULL, 'Source-bank migration day-hours contract is required';
  ASSERT to_regprocedure('private.leave_bank_basis(uuid,text)') IS NOT NULL, 'Source-bank migration basis contract is required';
  ASSERT to_regprocedure('private.calculate_leave_entitlement(uuid,text,date)') IS NOT NULL, 'Source-bank migration independent entitlement contract is required';
END $$;
BEGIN;
\ir sql-test-auth.sql
CREATE FUNCTION pg_temp.source_person(p_number integer) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$
  SELECT ('98000000-0000-4000-8000-' || lpad(p_number::text,12,'0'))::uuid;
$$;
CREATE FUNCTION pg_temp.source_request(p_number integer) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$
  SELECT ('98100000-0000-4000-8000-' || lpad(p_number::text,12,'0'))::uuid;
$$;
INSERT INTO auth.users(id,email,email_confirmed_at)
SELECT pg_temp.source_person(n),'source-bank-'||n||'@example.test',now() FROM generate_series(1,27) n
UNION ALL SELECT pg_temp.source_person(900),'source-bank-admin@example.test',now();
INSERT INTO public.profiles(id,full_name,app_role,login_name,credentials_valid_after)
SELECT pg_temp.source_person(n),'Synthetic Source '||n,'employee','source-bank-'||n,now()-interval '1 day' FROM generate_series(1,27) n
UNION ALL SELECT pg_temp.source_person(900),'Synthetic Source Admin','system_admin','source-bank-admin',now()-interval '1 day';
INSERT INTO private.portal_account_admins(auth_user_id) VALUES(pg_temp.source_person(900));
INSERT INTO public.internal_org_people(id,node_kind,company_key,full_name,position_title,auth_user_id,started_date,is_active)
SELECT pg_temp.source_person(n),'person',CASE WHEN n<=24 THEN 'mam' ELSE 'equipsy' END,
  'Synthetic Source '||n,'Synthetic tester',pg_temp.source_person(n),'2026-08-01',true FROM generate_series(1,27) n;
INSERT INTO private.employee_directory_details(person_id,first_name,employment_type,working_weekdays)
SELECT pg_temp.source_person(n),'Synthetic',CASE WHEN n=3 THEN 'part_time' ELSE 'full_time' END,
  CASE WHEN n=3 THEN ARRAY[6,7]::smallint[] ELSE ARRAY[1,2,3,4,5]::smallint[] END FROM generate_series(1,27) n;
SELECT pg_temp.set_test_actor(pg_temp.source_person(900));
INSERT INTO private.employee_annual_leave_balances(person_id,hours,as_of,is_example,updated_by)
SELECT pg_temp.source_person(n),CASE WHEN n=1 THEN 32.5545 WHEN n=2 THEN 100.1234 WHEN n=4 THEN 200.4 ELSE 20+n::numeric/10 END,
  CASE WHEN n=1 THEN date '2026-10-07' WHEN n IN (3,4,8,9) THEN date '2026-09-10' ELSE date '2026-10-01' END,
  false,pg_temp.source_person(900) FROM generate_series(1,27) n;
INSERT INTO private.employee_sick_leave_balances(person_id,hours,as_of,updated_by)
SELECT pg_temp.source_person(n),40,CASE WHEN n=1 THEN date '2026-09-10' ELSE date '2026-10-01' END,
  pg_temp.source_person(900) FROM generate_series(1,27) n;
INSERT INTO private.leave_accrual_policies(person_id,effective_from,weekly_hours,weekdays,annual_weeks,personal_weeks,enabled,note,actor_user_id)
SELECT pg_temp.source_person(n),'2026-09-11',CASE WHEN n=3 THEN 12 ELSE 38 END,
  CASE WHEN n=3 THEN ARRAY[6,7] ELSE ARRAY[1,2,3,4,5] END,4,2,true,'Synthetic confirmed ordinary hours',pg_temp.source_person(900)
FROM generate_series(1,27) n;
INSERT INTO private.leave_payroll_calendars(person_id,calendar_key)
SELECT pg_temp.source_person(n),CASE WHEN n=4 THEN 'victoria' ELSE 'none' END FROM generate_series(1,27) n WHERE n<>8;
INSERT INTO private.leave_bank_adoption_receipts(id,owner_key,plan_hash,operator_role,source_count)
VALUES('98200000-0000-4000-8000-000000000001','synthetic-source-bank-27',repeat('c',64),'postgres',27);
INSERT INTO private.leave_bank_sources(id,person_id,leave_kind,hours,report_date,covered_service_through,source_kind,
  source_fingerprint,note,operator_role,adoption_receipt_id)
SELECT ('98300000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,b.person_id,'annual',b.hours,b.as_of,
  CASE WHEN n=1 THEN date '2026-10-02' WHEN n=2 THEN NULL ELSE b.as_of END,
  CASE WHEN n=1 THEN 'payslip' ELSE 'payroll_report' END,encode(sha256(convert_to('synthetic source row '||n,'UTF8')),'hex'),'Synthetic source evidence','postgres','98200000-0000-4000-8000-000000000001'
FROM generate_series(1,27) n JOIN private.employee_annual_leave_balances b ON b.person_id=pg_temp.source_person(n);
INSERT INTO public.leave_requests(id,employee_person_id,user_id,leave_type,request_type_label,start_date,end_date,business_days,hours,
  status,submitted_at,record_origin,source_record_sha256,employment_type_snapshot,pay_treatment)
VALUES
(pg_temp.source_request(1),pg_temp.source_person(1),pg_temp.source_person(1),'personal','Sick leave','2026-09-24','2026-09-24',1,NULL,'approved',now(),'historical_import',repeat('1',64),'full_time','paid_entitlement'),
(pg_temp.source_request(2),pg_temp.source_person(2),pg_temp.source_person(2),'annual','Annual leave','2030-12-09','2030-12-09',1,NULL,'approved',now(),'historical_import',repeat('2',64),'full_time','paid_entitlement'),
(pg_temp.source_request(3),pg_temp.source_person(3),pg_temp.source_person(3),'annual','Annual leave','2026-09-26','2026-09-27',2,NULL,'approved',now(),'historical_import',repeat('3',64),'part_time','paid_entitlement'),
(pg_temp.source_request(4),pg_temp.source_person(4),pg_temp.source_person(4),'annual','Annual leave','2026-09-11','2026-10-02',16,NULL,'approved',now(),'historical_import',repeat('4',64),'full_time','paid_entitlement'),
(pg_temp.source_request(5),pg_temp.source_person(5),pg_temp.source_person(5),'unpaid','Unpaid leave','2026-10-05','2026-10-05',1,NULL,'approved',now(),'historical_import',repeat('5',64),'full_time','unpaid'),
(pg_temp.source_request(6),pg_temp.source_person(6),pg_temp.source_person(6),'personal','Sick leave','2026-10-05','2026-10-05',1,5,'approved',now(),'historical_import',repeat('6',64),'full_time','paid_entitlement'),
(pg_temp.source_request(7),pg_temp.source_person(7),pg_temp.source_person(7),'annual','Annual leave','2030-12-09','2030-12-09',1,NULL,'approved',now(),'historical_import',repeat('7',64),'full_time','paid_entitlement'),
(pg_temp.source_request(9),pg_temp.source_person(9),pg_temp.source_person(9),'annual','Annual leave','2026-09-25','2026-09-25',1,NULL,'approved',now(),'historical_import',repeat('9',64),'full_time','paid_entitlement');
UPDATE public.leave_requests SET start_time='09:00',end_time='14:00' WHERE id=pg_temp.source_request(6);

DO $$ DECLARE n integer; bank jsonb; source private.leave_bank_sources%rowtype; calculation jsonb; BEGIN
  ASSERT (SELECT count(*) FROM private.leave_bank_sources WHERE person_id::text LIKE '98000000-%')=27;
  ASSERT (SELECT source_count=27 FROM private.leave_bank_adoption_receipts WHERE owner_key='synthetic-source-bank-27');
  FOR n IN 1..27 LOOP
    SELECT * INTO STRICT source FROM private.leave_bank_sources WHERE person_id=pg_temp.source_person(n) AND leave_kind='annual';
    bank:=private.leave_bank_basis(source.person_id,'annual');
    ASSERT (bank->>'bankHours')::numeric=source.hours, 'Every source identity retains exact source bank';
    ASSERT (bank->>'reportDate')::date=source.report_date, 'Report date is independent metadata';
    ASSERT (bank->>'coveredThrough')::date IS NOT DISTINCT FROM source.covered_service_through, 'No inferred service cutoff';
    ASSERT bank->>'sourceKind'=source.source_kind;
  END LOOP;
  calculation:=private.calculate_leave_entitlement(pg_temp.source_person(2),'annual','2026-10-07');
  ASSERT calculation->>'status'<>'current', 'Unknown source coverage never masquerades as current accrual';
  ASSERT (calculation->>'earned')::numeric=0, 'Do not earn from report/upload date';
  ASSERT (calculation->>'exactHours')::numeric=100.1234, 'Unknown coverage preserves the authoritative bank';
  ASSERT (calculation->>'payrollDate')::date='2026-10-01';
  ASSERT (calculation->>'payrollHours')::numeric=100.1234;
END $$;
\echo PASS: 27 synthetic source identities; exact bank/report dates; unknown service coverage

DO $$ DECLARE annual jsonb; personal jsonb; combined jsonb; BEGIN
  annual:=private.calculate_leave_entitlement(pg_temp.source_person(1),'annual','2026-10-07');
  personal:=private.calculate_leave_entitlement(pg_temp.source_person(1),'personal','2026-10-07');
  combined:=private.calculate_employee_leave_accrual(pg_temp.source_person(1),'2026-10-07');
  ASSERT annual->>'status'='current', 'Covered annual continues despite earlier personal usage hold';
  ASSERT abs((annual->>'earned')::numeric-22.8/13)<0.000000000001, 'Use service end 10/2, not report 10/7';
  ASSERT abs((annual->>'exactHours')::numeric-(32.5545+22.8/13))<0.000000000001;
  ASSERT (annual->>'taken')::numeric=0, 'Covered payslip usage is not debited again';
  ASSERT (annual->>'asOf')::date='2026-10-07';
  ASSERT personal->>'status'='needs_review', 'Unreviewed historical personal usage remains unresolved';
  ASSERT (personal->>'reviewDate')::date='2026-09-24';
  ASSERT combined->>'annualStatus'='current' AND combined->>'personalStatus'='needs_review';
  ASSERT (combined->>'annualExactHours')::numeric=(annual->>'exactHours')::numeric;
  ASSERT (combined->>'personalExactHours')::numeric=(personal->>'exactHours')::numeric;
  ASSERT (SELECT count(*) FROM private.leave_accrual_day_reviews WHERE person_id::text LIKE '98000000-%')=0,
    'Calculation never manufactures actual payroll usage reviews';
END $$;
\echo PASS: known-period annual and old personal hold are independent; no fabricated usage

DO $$ BEGIN
  ASSERT private.leave_payroll_day_hours(pg_temp.source_request(3),'2026-09-26')=6, '12h weekend policy charges six hours per ordinary day';
  ASSERT private.leave_payroll_day_hours(pg_temp.source_request(3),'2026-09-27')=6, 'Sunday is a saved ordinary workday';
  ASSERT private.payroll_request_hours_after(pg_temp.source_request(3),'2026-09-25')=12, 'Part-time does not use 7.5 or Mon-Fri';
  ASSERT private.leave_payroll_day_hours(pg_temp.source_request(4),'2026-09-25')=0, 'Applicable paid public holiday is not annual usage';
  ASSERT private.payroll_request_hours_after(pg_temp.source_request(4),'2026-09-10')=114, 'Exclude one public holiday from 16 weekday annual days';
  ASSERT private.leave_payroll_day_hours(pg_temp.source_request(9),'2026-09-25')=7.6, 'Explicit none calendar is distinct from Victoria';
END $$;
SAVEPOINT unknown_calendar;
DELETE FROM private.leave_payroll_calendars WHERE person_id=pg_temp.source_person(9);
DO $$ BEGIN
  ASSERT private.leave_payroll_day_hours(pg_temp.source_request(9),'2026-09-25') IS NULL, 'Unknown calendar must not guess holiday applicability';
  ASSERT private.payroll_request_hours_after(pg_temp.source_request(9),'2026-09-24') IS NULL, 'Aggregate propagates uncertain day';
END $$;
ROLLBACK TO unknown_calendar;
\echo PASS: effective weekend policy; Victoria holiday; unknown and none calendars

SAVEPOINT holiday_service;

INSERT INTO private.leave_bank_sources(id,person_id,leave_kind,hours,report_date,covered_service_through,source_kind,source_fingerprint,note,operator_role,adopted_at)
VALUES('98300000-0000-4000-8000-000000000099',pg_temp.source_person(9),'annual',20,'2026-09-24','2026-09-24','payroll_report',repeat('e',64),'Synthetic later adoption with verified service coverage','postgres',clock_timestamp());
UPDATE private.leave_payroll_calendars SET calendar_key='victoria' WHERE person_id=pg_temp.source_person(9);
DO $$ DECLARE c jsonb; BEGIN
  c:=private.calculate_leave_entitlement(pg_temp.source_person(9),'annual','2026-09-25');
  ASSERT (c->>'taken')::numeric=0, 'Holiday-only annual request consumes no annual bank';
  ASSERT abs((c->>'earned')::numeric-7.6/13)<0.000000000001, 'Paid holiday retains ordinary accrual';
END $$;
ROLLBACK TO holiday_service;
\echo PASS: paid public holiday accrues ordinary service without annual consumption

DO $$ DECLARE c jsonb; BEGIN
  ASSERT private.leave_payroll_day_hours(pg_temp.source_request(6),'2026-10-05')=5, 'Explicit same-day partial personal hours remain five';
  ASSERT private.approved_leave_hours_after(pg_temp.source_person(6),ARRAY['Sick leave','Carer''s leave'],'2026-10-01')=5;
  ASSERT private.approved_leave_hours_after(pg_temp.source_person(6),ARRAY['Annual leave'],'2026-10-01')=0, 'Personal usage never becomes annual usage';
  ASSERT private.approved_leave_hours_after(pg_temp.source_person(5),ARRAY['Annual leave'],'2026-10-01')=0, 'Ordinary unpaid request never debits annual bank';
  ASSERT (SELECT hours FROM private.employee_annual_leave_balances WHERE person_id=pg_temp.source_person(5))=20.5;
  c:=private.calculate_leave_entitlement(pg_temp.source_person(5),'annual','2026-10-07');
  ASSERT c->>'status'='needs_review', 'Unreviewed unpaid absence is not confirmed actual service';
  ASSERT (c->>'reviewDate')::date='2026-10-05';
  ASSERT (c->>'taken')::numeric=0, 'Unpaid uncertainty never becomes annual consumption';
  c:=private.calculate_leave_entitlement(pg_temp.source_person(6),'annual','2026-10-07');
  ASSERT c->>'status'='current', 'Known paid personal service does not pause annual entitlement';
  ASSERT abs((c->>'earned')::numeric-30.4/13)<0.000000000001;
  ASSERT (c->>'taken')::numeric=0;
  c:=private.calculate_leave_entitlement(pg_temp.source_person(6),'personal','2026-10-07');
  ASSERT c->>'status'='needs_review', 'Approved partial request is not proof of actual payroll consumption';
  ASSERT (SELECT count(*) FROM private.leave_accrual_day_reviews WHERE person_id::text LIKE '98000000-%')=0;
END $$;
\echo PASS: paid personal partial hours and unpaid service stay distinct; actual usage remains unconfirmed

DO $$ DECLARE bank_before jsonb; bank_after jsonb; BEGIN
  bank_before:=private.leave_bank_basis(pg_temp.source_person(7),'annual');
  ASSERT private.approved_leave_hours_after(pg_temp.source_person(7),ARRAY['Annual leave'],'2026-10-01')=7.6;
  UPDATE public.leave_requests SET status='cancelled' WHERE id=pg_temp.source_request(7);
  ASSERT private.approved_leave_hours_after(pg_temp.source_person(7),ARRAY['Annual leave'],'2026-10-01')=0, 'Cancelled future approval releases reservation';
  bank_after:=private.leave_bank_basis(pg_temp.source_person(7),'annual');
  ASSERT bank_after=bank_before, 'Future cancellation never credits the authoritative source bank';
END $$;
\echo PASS: future cancellation releases reservation without refunding source bank

DO $$ DECLARE signature text; relation text; BEGIN
  FOREACH signature IN ARRAY ARRAY['private.leave_payroll_day_hours(uuid,date)','private.leave_bank_basis(uuid,text)',
    'private.calculate_leave_entitlement(uuid,text,date)'] LOOP
    ASSERT NOT has_function_privilege('anon',signature,'EXECUTE');
    ASSERT NOT has_function_privilege('authenticated',signature,'EXECUTE');
    ASSERT NOT has_function_privilege('service_role',signature,'EXECUTE');
  END LOOP;
  FOREACH relation IN ARRAY ARRAY['private.leave_bank_sources','private.leave_bank_adoption_receipts','private.leave_payroll_calendars'] LOOP
    ASSERT (SELECT relrowsecurity FROM pg_class WHERE oid=relation::regclass), 'Private source/calendar tables retain RLS';
    ASSERT NOT has_table_privilege('anon',relation,'SELECT');
    ASSERT NOT has_table_privilege('authenticated',relation,'SELECT');
    ASSERT NOT has_table_privilege('service_role',relation,'SELECT');
  END LOOP;
  ASSERT (SELECT count(*) FROM private.leave_accrual_day_reviews WHERE person_id::text LIKE '98000000-%')=0;
END $$;
\echo PASS: private calculators and source/calendar tables retain denied application-role access
SAVEPOINT source_bank_paid_annual_service;
INSERT INTO public.leave_requests(id,employee_person_id,user_id,leave_type,request_type_label,start_date,end_date,business_days,hours,
  status,submitted_at,record_origin,source_record_sha256,employment_type_snapshot,pay_treatment)
VALUES(pg_temp.source_request(10),pg_temp.source_person(10),pg_temp.source_person(10),'annual','Annual leave','2026-10-05','2026-10-05',1,NULL,
  'approved',now(),'historical_import',repeat('a',64),'full_time','paid_entitlement');
DO $$ DECLARE c jsonb; p jsonb; BEGIN
  c:=private.calculate_leave_entitlement(pg_temp.source_person(10),'annual','2026-10-07');
  ASSERT c->>'status'='needs_review' AND c->>'eligibilityStatus'='current', 'Unconfirmed paid annual usage does not stop eligible ordinary service';
  ASSERT (c->>'reviewDate')::date='2026-10-05';
  ASSERT (c->>'asOf')::date='2026-10-07';
  ASSERT abs((c->>'earned')::numeric-30.4/13)<0.000000000001;
  ASSERT (c->>'taken')::numeric=0, 'Approval is not manufactured actual usage';
  p:=private.project_annual_leave_balance(pg_temp.source_person(10),'2026-10-08');
  ASSERT p->>'status'='projected';
  ASSERT (p->>'approvedHours')::numeric=7.6;
  ASSERT abs((p->>'availableHours')::numeric-(21+30.4/13-7.6))<0.000000000001, 'Reserve the pending approved annual hours once';
  ASSERT (SELECT count(*) FROM private.leave_accrual_day_reviews WHERE person_id=pg_temp.source_person(10))=0;
END $$;
ROLLBACK TO source_bank_paid_annual_service;
\echo PASS: paid approved annual usage remains pending while ordinary service accrues

SAVEPOINT source_bank_actual_personal_no_double_debit;
INSERT INTO private.leave_accrual_day_reviews(person_id,service_date,annual_eligible_hours,personal_eligible_hours,annual_taken_hours,personal_taken_hours,request_fingerprint,note,actor_user_id)
VALUES(pg_temp.source_person(6),'2026-10-05',7.6,7.6,0,5,private.leave_accrual_request_fingerprint(pg_temp.source_person(6),'2026-10-05'),'Synthetic confirmed personal actual usage',pg_temp.source_person(900));
SELECT pg_temp.set_test_actor(pg_temp.source_person(900));
DO $$ DECLARE c jsonb; w jsonb; person jsonb; BEGIN
  c:=private.calculate_leave_entitlement(pg_temp.source_person(6),'personal','2026-10-07');
  ASSERT c->>'status'='current';
  ASSERT (c->>'taken')::numeric=5;
  ASSERT abs((SELECT sum((value->>'accruedHours')::numeric) FROM jsonb_array_elements(c->'terms'))-(c->>'earned')::numeric)<0.000000000001, 'Personal terms use personal entitlement rate';
  w:=public.get_leave_priority_workspace();
  SELECT value INTO STRICT person FROM jsonb_array_elements(w->'people') WHERE value->>'personId'=pg_temp.source_person(6)::text;
  ASSERT (person->>'sickApprovedHours')::numeric=5;
  ASSERT abs((person->>'sickAvailableHours')::numeric-(40+30.4/26-5))<0.000000000001, 'Reviewed approved personal usage is deducted once';
END $$;
ROLLBACK TO source_bank_actual_personal_no_double_debit;
\echo PASS: reviewed personal usage does not get charged again as an approval reservation

SAVEPOINT source_bank_actual_usage_past_hold;
INSERT INTO private.leave_accrual_day_reviews(person_id,service_date,annual_eligible_hours,personal_eligible_hours,annual_taken_hours,personal_taken_hours,request_fingerprint,note,actor_user_id)
VALUES(pg_temp.source_person(5),'2026-10-02',7.6,7.6,2,0,private.leave_accrual_request_fingerprint(pg_temp.source_person(5),'2026-10-02'),'Synthetic extra actual annual usage before service hold',pg_temp.source_person(900));
INSERT INTO public.leave_requests(id,employee_person_id,user_id,leave_type,request_type_label,start_date,end_date,business_days,hours,
  status,submitted_at,record_origin,source_record_sha256,employment_type_snapshot,pay_treatment)
VALUES(pg_temp.source_request(50),pg_temp.source_person(5),pg_temp.source_person(5),'annual','Annual leave','2026-10-06','2026-10-06',1,NULL,
  'approved',now(),'historical_import',repeat('b',64),'full_time','paid_entitlement');
INSERT INTO private.leave_accrual_day_reviews(person_id,service_date,annual_eligible_hours,personal_eligible_hours,annual_taken_hours,personal_taken_hours,request_fingerprint,note,actor_user_id)
VALUES(pg_temp.source_person(5),'2026-10-06',7.6,7.6,7.6,0,private.leave_accrual_request_fingerprint(pg_temp.source_person(5),'2026-10-06'),'Synthetic actual approved annual usage after separate service hold',pg_temp.source_person(900));
DO $$ DECLARE c jsonb; p jsonb; BEGIN
  c:=private.calculate_leave_entitlement(pg_temp.source_person(5),'annual','2026-10-07');
  ASSERT c->>'status'='needs_review' AND c->>'eligibilityStatus'='needs_review';
  ASSERT (c->>'reviewDate')::date='2026-10-05';
  ASSERT (c->>'asOf')::date='2026-10-04';
  ASSERT (c->>'taken')::numeric=9.6, 'Actual usage remains charged across the unpaid service hold';
  ASSERT (c->>'usageThroughDate')::date='2026-10-07';
  p:=private.project_annual_leave_balance(pg_temp.source_person(5),'2026-10-08');
  ASSERT (p->>'approvedHours')::numeric=7.6;
  ASSERT (p->>'otherTakenHours')::numeric=2, 'Later approved usage does not erase earlier unrelated actual usage';
  ASSERT abs((p->>'availableHours')::numeric-(20.5+7.6/13-7.6-2))<0.000000000001;
END $$;
SAVEPOINT source_bank_extra_after_hold;
INSERT INTO private.leave_accrual_day_reviews(person_id,service_date,annual_eligible_hours,personal_eligible_hours,annual_taken_hours,personal_taken_hours,request_fingerprint,note,actor_user_id)
VALUES(pg_temp.source_person(5),'2026-10-06',7.6,7.6,10.6,0,private.leave_accrual_request_fingerprint(pg_temp.source_person(5),'2026-10-06'),'Synthetic extra actual annual usage after eligibility hold',pg_temp.source_person(900));
DO $$ DECLARE c jsonb; p jsonb; BEGIN
  c:=private.calculate_leave_entitlement(pg_temp.source_person(5),'annual','2026-10-07');
  ASSERT (c->>'taken')::numeric=12.6, 'Extra confirmed usage after a hold is still deducted';
  ASSERT (c->>'asOf')::date='2026-10-04', 'Usage does not falsely advance eligible service';
  p:=private.project_annual_leave_balance(pg_temp.source_person(5),'2026-10-08');
  ASSERT (p->>'otherTakenHours')::numeric=5;
  ASSERT abs((p->>'availableHours')::numeric-(20.5+7.6/13-7.6-5))<0.000000000001;
END $$;
ROLLBACK TO source_bank_extra_after_hold;
UPDATE public.leave_requests SET status='cancelled' WHERE id=pg_temp.source_request(50);
DO $$ DECLARE c jsonb; p jsonb; BEGIN
  c:=private.calculate_leave_entitlement(pg_temp.source_person(5),'annual','2026-10-07');
  ASSERT c->>'status'='needs_review';
  p:=private.project_annual_leave_balance(pg_temp.source_person(5),'2026-10-08');
  ASSERT p->>'status'='unavailable' AND p->>'availableHours' IS NULL, 'Stale usage after an eligibility hold fails closed';
  ASSERT (p->>'payrollHours')::numeric=20.5;
END $$;
ROLLBACK TO source_bank_actual_usage_past_hold;
\echo PASS: actual usage and stale reviews after eligibility holds are processed independently

SAVEPOINT source_bank_used_edit_credit;
UPDATE private.leave_accrual_policies SET enabled=false,requires_review=false WHERE person_id=pg_temp.source_person(1);
INSERT INTO public.leave_requests(id,employee_person_id,user_id,leave_type,request_type_label,start_date,end_date,business_days,hours,
 status,submitted_at,record_origin,source_record_sha256,employment_type_snapshot,pay_treatment)
VALUES(pg_temp.source_request(501),pg_temp.source_person(1),pg_temp.source_person(1),'annual','Annual leave','2026-10-05','2026-10-05',1,7.6,
 'approved',now(),'historical_import',encode(sha256(convert_to('source-bank-used-edit-credit-501','UTF8')),'hex'),'full_time','paid_entitlement');
SELECT pg_temp.set_test_actor(pg_temp.source_person(900));
SELECT public.review_employee_leave_accrual_day(pg_temp.source_person(1),'2026-10-05',0,0,7.6,0,'Synthetic confirmed used annual hours');
DO $$ BEGIN
 ASSERT abs((private.project_annual_leave_balance(pg_temp.source_person(1),'2030-12-09')->>'availableHours')::numeric-24.9545)<0.000000000001;
 BEGIN
  UPDATE public.leave_requests SET start_date='2030-12-09',end_date='2030-12-10',business_days=2,hours=30 WHERE id=pg_temp.source_request(501);
  RAISE EXCEPTION 'Confirmed used hours were returned as editable approval credit.' USING ERRCODE='ZX001';
 EXCEPTION WHEN invalid_parameter_value THEN ASSERT SQLERRM LIKE 'Not enough balance.%'; END;
 ASSERT (SELECT start_date='2026-10-05' AND hours=7.6 FROM public.leave_requests WHERE id=pg_temp.source_request(501));
END $$;
ROLLBACK TO source_bank_used_edit_credit;
\echo PASS: editing an approved request cannot release confirmed already-used annual hours

SAVEPOINT source_bank_pending_inclusion;
INSERT INTO private.payroll_closing_receipts(id,owner_key,actor_user_id,operation,provenance,note,payload,result)
VALUES('98400000-0000-4000-8000-000000000070','synthetic-source-pending-proof',pg_temp.source_person(900),'closing','owner_estimate','Synthetic retained usage evidence','[]','{}');
INSERT INTO public.leave_requests(id,employee_person_id,user_id,leave_type,request_type_label,start_date,end_date,business_days,hours,status,submitted_at,record_origin,source_record_sha256,employment_type_snapshot,pay_treatment)
VALUES(pg_temp.source_request(70),pg_temp.source_person(10),pg_temp.source_person(10),'annual','Annual leave','2026-09-25','2026-09-25',1,NULL,'approved',now(),'historical_import',repeat('a',64),'full_time','paid_entitlement');
INSERT INTO private.payroll_carryforward_events(receipt_id,request_id,person_id,company_key,leave_kind,origin_after,through_date,total_hours,accounted_hours,pending_hours,request_fingerprint)
VALUES('98400000-0000-4000-8000-000000000070',pg_temp.source_request(70),pg_temp.source_person(10),'mam','annual','2026-09-10','2026-10-01',7.6,0,7.6,
 (SELECT private.payroll_request_fingerprint(to_jsonb(r)) FROM public.leave_requests r WHERE id=pg_temp.source_request(70)));
DO $$ DECLARE b jsonb; p jsonb; BEGIN
 b:=private.leave_bank_basis(pg_temp.source_person(10),'annual');
 ASSERT b->>'status'='current' AND (b->>'coveredThrough')::date='2026-10-01';
 ASSERT (b->>'retainedHours')::numeric=7.6, 'A known service cutoff does not prove pending usage was deducted';
 ASSERT private.approved_leave_hours_after(pg_temp.source_person(10),ARRAY['Annual leave'],'2026-10-01')=7.6;
 p:=private.project_annual_leave_balance(pg_temp.source_person(10),'2026-10-08');
 ASSERT (p->>'retainedHours')::numeric=7.6;
 ASSERT abs((p->>'availableHours')::numeric-(21+30.4/13-7.6))<0.000000000001;
END $$;
SAVEPOINT invalid_source_pending_proof;
INSERT INTO private.leave_bank_sources(person_id,leave_kind,hours,report_date,covered_service_through,source_kind,source_fingerprint,note,operator_role,included_usage)
VALUES(pg_temp.source_person(10),'annual',21,'2026-10-01','2026-10-01','payslip',repeat('b',64),'Synthetic incorrect inclusion fingerprint','postgres',
 jsonb_build_array(jsonb_build_object('requestId',pg_temp.source_request(70),'includedHours','7.6','includedPendingHours','7.6','requestFingerprint',repeat('f',64),'evidenceHash',repeat('c',64))));
DO $$ DECLARE b jsonb; BEGIN
 b:=private.leave_bank_basis(pg_temp.source_person(10),'annual');
 ASSERT b->>'status'='needs_review';
 ASSERT (b->>'retainedHours')::numeric=7.6, 'Incorrect inclusion proof preserves the entire reservation';
 ASSERT private.approved_leave_hours_after(pg_temp.source_person(10),ARRAY['Annual leave'],'2026-10-01') IS NULL;
END $$;
ROLLBACK TO invalid_source_pending_proof;
DO $$ DECLARE before_sources bigint; before_receipts bigint; before_carry jsonb; before_legacy jsonb; before_source_hash text; bad jsonb; BEGIN
 SELECT count(*) INTO before_sources FROM private.leave_bank_sources;
 SELECT count(*) INTO before_receipts FROM private.leave_bank_adoption_receipts;
 SELECT jsonb_agg(to_jsonb(e) ORDER BY id) INTO before_carry FROM private.payroll_carryforward_events e;
 SELECT to_jsonb(a) INTO before_legacy FROM private.employee_annual_leave_balances a WHERE person_id=pg_temp.source_person(10);
 SELECT encode(extensions.digest(coalesce(jsonb_agg(to_jsonb(s) ORDER BY s.adopted_at,s.id),'[]'::jsonb)::text,'sha256'),'hex')
  INTO before_source_hash FROM private.leave_bank_sources s WHERE s.person_id=pg_temp.source_person(10) AND s.leave_kind='annual';
 bad:=jsonb_build_array(jsonb_build_object('personId',pg_temp.source_person(10),'kind','annual','hours','21','reportDate','2026-10-01','coveredThrough','2026-10-01','sourceKind','payslip','sourceFingerprint',repeat('d',64),'note','Synthetic invalid proof atomic adoption',
  'expectedLegacyHash',encode(extensions.digest(before_legacy::text,'sha256'),'hex'),'expectedSourceHash',before_source_hash,'includedUsage',jsonb_build_array(jsonb_build_object('requestId',pg_temp.source_request(70),'includedHours','7.6','includedPendingHours','7.6','requestFingerprint',repeat('f',64),'evidenceHash',repeat('c',64)))));
 BEGIN
  PERFORM private.adopt_leave_bank_sources('synthetic-invalid-source-inclusion',repeat('e',64),bad);
  RAISE EXCEPTION 'Incorrect proof source adoption committed' USING ERRCODE='ZX001';
 EXCEPTION WHEN invalid_parameter_value THEN ASSERT SQLERRM='Source usage inclusion evidence differs.';END;
 ASSERT (SELECT count(*) FROM private.leave_bank_sources)=before_sources;
 ASSERT (SELECT count(*) FROM private.leave_bank_adoption_receipts)=before_receipts;
 ASSERT (SELECT jsonb_agg(to_jsonb(e) ORDER BY id) FROM private.payroll_carryforward_events e)=before_carry;
 ASSERT (SELECT to_jsonb(a) FROM private.employee_annual_leave_balances a WHERE person_id=pg_temp.source_person(10))=before_legacy;
END $$;
DO $$ DECLARE before_carry jsonb; b jsonb; r public.leave_requests%rowtype; BEGIN
 SELECT jsonb_agg(to_jsonb(e) ORDER BY id) INTO before_carry FROM private.payroll_carryforward_events e;
 SELECT * INTO STRICT r FROM public.leave_requests WHERE id=pg_temp.source_request(70);
 INSERT INTO private.leave_bank_sources(person_id,leave_kind,hours,report_date,covered_service_through,source_kind,source_fingerprint,note,operator_role,included_usage)
 VALUES(pg_temp.source_person(10),'annual',21,'2026-10-01','2026-10-01','payslip',repeat('b',64),'Synthetic explicit partial pending inclusion','postgres',
  jsonb_build_array(jsonb_build_object('requestId',r.id,'includedHours','3.8','includedPendingHours','3.8','requestFingerprint',private.payroll_request_fingerprint(to_jsonb(r)),'evidenceHash',repeat('c',64))));
 b:=private.leave_bank_basis(pg_temp.source_person(10),'annual');
 ASSERT b->>'status'='current' AND (b->>'retainedHours')::numeric=3.8;
 ASSERT private.approved_leave_hours_after(pg_temp.source_person(10),ARRAY['Annual leave'],'2026-10-01')=3.8, 'Only the explicitly included pending portion leaves the reservation';
 ASSERT (SELECT jsonb_agg(to_jsonb(e) ORDER BY id) FROM private.payroll_carryforward_events e)=before_carry, 'Immutable carry evidence remains unchanged';
 ASSERT private.payroll_retained_hours(pg_temp.source_person(10),'annual')=7.6, 'Raw carry history is not settled by source adoption';
END $$;
ROLLBACK TO source_bank_pending_inclusion;
\echo PASS: known coverage retains pending usage; exact inclusion only removes its specified portion; invalid proof adoption is atomic

SAVEPOINT source_bank_pending_window_ambiguity;
INSERT INTO private.payroll_closing_receipts(id,owner_key,actor_user_id,operation,provenance,note,payload,result)
VALUES('98400000-0000-4000-8000-000000000071','synthetic-source-straddling-pending',pg_temp.source_person(900),'closing','owner_estimate','Synthetic undated retained allocation','[]','{}');
INSERT INTO private.leave_bank_sources(person_id,leave_kind,hours,report_date,covered_service_through,source_kind,source_fingerprint,note,operator_role)
VALUES(pg_temp.source_person(11),'annual',100,'2026-10-01','2026-09-30','payslip',repeat('b',64),'Synthetic verified service end before older retained window ends','postgres');
INSERT INTO public.leave_requests(id,employee_person_id,user_id,leave_type,request_type_label,start_date,end_date,business_days,hours,status,submitted_at,record_origin,source_record_sha256,employment_type_snapshot,pay_treatment)
VALUES(pg_temp.source_request(71),pg_temp.source_person(11),pg_temp.source_person(11),'annual','Annual leave','2026-09-30','2026-10-02',3,NULL,'approved',now(),'historical_import',repeat('a',64),'full_time','paid_entitlement');
INSERT INTO private.payroll_carryforward_events(receipt_id,request_id,person_id,company_key,leave_kind,origin_after,through_date,total_hours,accounted_hours,pending_hours,request_fingerprint)
VALUES('98400000-0000-4000-8000-000000000071',pg_temp.source_request(71),pg_temp.source_person(11),'mam','annual','2026-09-10','2026-10-01',22.8,7.6,7.6,
 (SELECT private.payroll_request_fingerprint(to_jsonb(r)) FROM public.leave_requests r WHERE id=pg_temp.source_request(71)));
DO $$ DECLARE p jsonb; BEGIN
 ASSERT private.approved_leave_hours_after(pg_temp.source_person(11),ARRAY['Annual leave'],'2026-10-01') IS NULL, 'Undated pending allocation crossing the new service cutoff has unknown overlap';
 p:=private.project_annual_leave_balance(pg_temp.source_person(11),'2026-10-08');
 ASSERT p->>'status'='unavailable' AND p->>'availableHours' IS NULL;
 ASSERT (p->>'retainedHours')::numeric=7.6;
END $$;
ROLLBACK TO source_bank_pending_window_ambiguity;
\echo PASS: undated retained allocation straddling a source cutoff fails closed

SAVEPOINT source_bank_pending_after_cutoff;
INSERT INTO private.payroll_closing_receipts(id,owner_key,actor_user_id,operation,provenance,note,payload,result)
VALUES('98400000-0000-4000-8000-000000000072','synthetic-source-postcutoff-pending',pg_temp.source_person(900),'closing','owner_estimate','Synthetic post-cutoff retained allocation','[]','{}');
INSERT INTO private.leave_bank_sources(person_id,leave_kind,hours,report_date,covered_service_through,source_kind,source_fingerprint,note,operator_role)
VALUES(pg_temp.source_person(12),'annual',100,'2026-10-01','2026-10-01','payslip',repeat('b',64),'Synthetic verified service end before the whole pending window','postgres');
INSERT INTO public.leave_requests(id,employee_person_id,user_id,leave_type,request_type_label,start_date,end_date,business_days,hours,status,submitted_at,record_origin,source_record_sha256,employment_type_snapshot,pay_treatment)
VALUES(pg_temp.source_request(72),pg_temp.source_person(12),pg_temp.source_person(12),'annual','Annual leave','2026-10-02','2026-10-05',2,NULL,'approved',now(),'historical_import',repeat('a',64),'full_time','paid_entitlement');
INSERT INTO private.payroll_carryforward_events(receipt_id,request_id,person_id,company_key,leave_kind,origin_after,through_date,total_hours,accounted_hours,pending_hours,request_fingerprint)
VALUES('98400000-0000-4000-8000-000000000072',pg_temp.source_request(72),pg_temp.source_person(12),'mam','annual','2026-10-01','2026-10-05',15.2,0,15.2,
 (SELECT private.payroll_request_fingerprint(to_jsonb(r)) FROM public.leave_requests r WHERE id=pg_temp.source_request(72)));
DO $$ DECLARE b jsonb; BEGIN
 b:=private.leave_bank_basis(pg_temp.source_person(12),'annual');
 ASSERT (b->>'retainedHours')::numeric=15.2;
 ASSERT private.approved_leave_hours_after(pg_temp.source_person(12),ARRAY['Annual leave'],'2026-10-01')=15.2, 'Pending entirely after the cutoff is already reserved by the post-cutoff request';
END $$;
ROLLBACK TO source_bank_pending_after_cutoff;
\echo PASS: retained usage entirely inside the post-cutoff reservation is counted once

SAVEPOINT source_bank_luke_like_included_usage;
INSERT INTO public.leave_requests(id,employee_person_id,user_id,leave_type,request_type_label,start_date,end_date,business_days,hours,status,submitted_at,record_origin,source_record_sha256,employment_type_snapshot,pay_treatment)
VALUES(pg_temp.source_request(73),pg_temp.source_person(1),pg_temp.source_person(1),'annual','Annual leave','2026-10-02','2026-10-02',1,NULL,'approved',now(),'historical_import',repeat('a',64),'full_time','paid_entitlement');
DO $$ DECLARE r public.leave_requests%rowtype; b jsonb; c jsonb; BEGIN
 SELECT * INTO STRICT r FROM public.leave_requests WHERE id=pg_temp.source_request(73);
 ASSERT NOT EXISTS(SELECT 1 FROM private.payroll_carryforward_events WHERE person_id=r.employee_person_id);
 INSERT INTO private.leave_bank_sources(person_id,leave_kind,hours,report_date,covered_service_through,source_kind,source_fingerprint,note,operator_role,included_usage)
 VALUES(r.employee_person_id,'annual',32.5545,'2026-10-02','2026-10-02','payslip',repeat('b',64),'Synthetic direct confirmation of included annual usage without a carry event','postgres',
  jsonb_build_array(jsonb_build_object('requestId',r.id,'includedHours','7.6','includedPendingHours','0','requestFingerprint',private.payroll_request_fingerprint(to_jsonb(r)),'evidenceHash',repeat('c',64))));
 b:=private.leave_bank_basis(r.employee_person_id,'annual');
 ASSERT b->>'status'='current' AND (b->>'retainedHours')::numeric=0;
 ASSERT private.approved_leave_hours_after(r.employee_person_id,ARRAY['Annual leave'],'2026-10-02')=0;
 c:=private.calculate_leave_entitlement(r.employee_person_id,'annual','2026-10-07');
 ASSERT abs((c->>'exactHours')::numeric-(32.5545+22.8/13))<0.000000000001, 'The already-deducted Oct2 usage is not deducted again';
 ASSERT NOT EXISTS(SELECT 1 FROM private.payroll_carryforward_events WHERE person_id=r.employee_person_id);
 ASSERT NOT EXISTS(SELECT 1 FROM private.leave_accrual_day_reviews WHERE person_id=r.employee_person_id);
END $$;
ROLLBACK TO source_bank_luke_like_included_usage;
\echo PASS: explicit included usage with zero pending carry remains auditable without fabricated history

SAVEPOINT source_bank_postcutoff_holiday_shrink;
INSERT INTO private.payroll_closing_receipts(id,owner_key,actor_user_id,operation,provenance,note,payload,result)
VALUES('98400000-0000-4000-8000-000000000080','synthetic-postcutoff-holiday-shrink',pg_temp.source_person(900),'closing','owner_estimate','Synthetic retained holiday allocation','[]','{}');
INSERT INTO private.leave_bank_sources(person_id,leave_kind,hours,report_date,covered_service_through,source_kind,source_fingerprint,note,operator_role)
VALUES(pg_temp.source_person(13),'annual',100,'2026-10-01','2026-09-24','payslip',repeat('a',64),'Synthetic cutoff before retained holiday','postgres');
INSERT INTO public.leave_requests(id,employee_person_id,user_id,leave_type,request_type_label,start_date,end_date,business_days,hours,status,submitted_at,record_origin,source_record_sha256,employment_type_snapshot,pay_treatment)
VALUES(pg_temp.source_request(80),pg_temp.source_person(13),pg_temp.source_person(13),'annual','Annual leave','2026-09-25','2026-09-25',1,NULL,'approved',now(),'historical_import',repeat('b',64),'full_time','paid_entitlement');
INSERT INTO private.payroll_carryforward_events(receipt_id,request_id,person_id,company_key,leave_kind,origin_after,through_date,total_hours,accounted_hours,pending_hours,request_fingerprint)
VALUES('98400000-0000-4000-8000-000000000080',pg_temp.source_request(80),pg_temp.source_person(13),'mam','annual','2026-09-24','2026-09-25',7.6,0,7.6,
 (SELECT private.payroll_request_fingerprint(to_jsonb(r)) FROM public.leave_requests r WHERE id=pg_temp.source_request(80)));
DO $$ BEGIN
 ASSERT private.payroll_request_hours_after(pg_temp.source_request(80),'2026-09-24')=7.6;
 ASSERT private.approved_leave_hours_after(pg_temp.source_person(13),ARRAY['Annual leave'],'2026-10-01')=7.6, 'Unchanged post-cutoff quantity counts the retained obligation once';
END $$;
UPDATE private.leave_payroll_calendars SET calendar_key='victoria' WHERE person_id=pg_temp.source_person(13);
DO $$ DECLARE b jsonb; p jsonb; c jsonb; BEGIN
 b:=private.leave_bank_basis(pg_temp.source_person(13),'annual');
 ASSERT b->>'status'='current' AND (b->>'retainedHours')::numeric=7.6;
 ASSERT private.payroll_request_hours_after(pg_temp.source_request(80),'2026-09-24')=0;
 ASSERT private.approved_leave_hours_after(pg_temp.source_person(13),ARRAY['Annual leave'],'2026-10-01')=7.6, 'Canonical holiday quantity zero cannot discard an immutable 7.6-hour pending obligation';
 c:=private.calculate_leave_entitlement(pg_temp.source_person(13),'annual','2026-10-07');
 p:=private.project_annual_leave_balance(pg_temp.source_person(13),'2026-10-08');
 ASSERT (p->>'approvedHours')::numeric=7.6;
 ASSERT abs((p->>'availableHours')::numeric-(100+(c->>'earned')::numeric-7.6))<0.000000000001;
 ASSERT private.payroll_retained_hours(pg_temp.source_person(13),'annual')=7.6;
END $$;
ROLLBACK TO source_bank_postcutoff_holiday_shrink;
\echo PASS: unchanged post-cutoff pending counts once; holiday quantity shrink retains the entire pending obligation

SAVEPOINT source_bank_postcutoff_smaller_quantity;
INSERT INTO private.payroll_closing_receipts(id,owner_key,actor_user_id,operation,provenance,note,payload,result)
VALUES('98400000-0000-4000-8000-000000000081','synthetic-postcutoff-smaller-quantity',pg_temp.source_person(900),'closing','owner_estimate','Synthetic retained allocations and explicit inclusion','[]','{}');
INSERT INTO private.leave_bank_sources(person_id,leave_kind,hours,report_date,covered_service_through,source_kind,source_fingerprint,note,operator_role)
VALUES(pg_temp.source_person(15),'annual',100,'2026-10-01','2026-09-24','payslip',repeat('a',64),'Synthetic cutoff before retained changed ordinary hours','postgres');
INSERT INTO public.leave_requests(id,employee_person_id,user_id,leave_type,request_type_label,start_date,end_date,business_days,hours,status,submitted_at,record_origin,source_record_sha256,employment_type_snapshot,pay_treatment)
VALUES
 (pg_temp.source_request(81),pg_temp.source_person(15),pg_temp.source_person(15),'annual','Annual leave','2026-09-25','2026-09-25',1,NULL,'approved',now(),'historical_import',repeat('b',64),'full_time','paid_entitlement'),
 (pg_temp.source_request(82),pg_temp.source_person(15),pg_temp.source_person(15),'annual','Annual leave','2026-09-23','2026-09-23',1,NULL,'approved',now(),'historical_import',repeat('c',64),'full_time','paid_entitlement');
INSERT INTO private.payroll_carryforward_events(receipt_id,request_id,person_id,company_key,leave_kind,origin_after,through_date,total_hours,accounted_hours,pending_hours,request_fingerprint)
SELECT '98400000-0000-4000-8000-000000000081',r.id,r.employee_person_id,'mam','annual',r.start_date-1,r.end_date,7.6,0,7.6,private.payroll_request_fingerprint(to_jsonb(r))
FROM public.leave_requests r WHERE r.id IN(pg_temp.source_request(81),pg_temp.source_request(82));
INSERT INTO private.leave_accrual_policies(person_id,effective_from,weekly_hours,weekdays,annual_weeks,personal_weeks,enabled,note,actor_user_id)
VALUES(pg_temp.source_person(15),'2026-09-12',19,ARRAY[1,2,3,4,5],4,2,true,'Synthetic smaller ordinary quantity with unchanged request evidence',pg_temp.source_person(900));
DO $$ BEGIN
 ASSERT private.payroll_request_hours_after(pg_temp.source_request(81),'2026-09-24')=3.8;
 ASSERT private.approved_leave_hours_after(pg_temp.source_person(15),ARRAY['Annual leave'],'2026-10-01')=15.2, 'Canonical 3.8 plus retained excess 3.8 counts post-cutoff 7.6 once, alongside pre-cutoff 7.6';
END $$;
DO $$ DECLARE before_carry jsonb; r public.leave_requests%rowtype; b jsonb; BEGIN
 SELECT jsonb_agg(to_jsonb(e) ORDER BY id) INTO before_carry FROM private.payroll_carryforward_events e WHERE person_id=pg_temp.source_person(15);
 SELECT * INTO STRICT r FROM public.leave_requests WHERE id=pg_temp.source_request(82);
 INSERT INTO private.leave_bank_sources(person_id,leave_kind,hours,report_date,covered_service_through,source_kind,source_fingerprint,note,operator_role,included_usage)
 VALUES(pg_temp.source_person(15),'annual',100,'2026-10-01','2026-09-24','payslip',repeat('d',64),'Synthetic explicit pre-cutoff pending portion with a separate post-cutoff shrink','postgres',
  jsonb_build_array(jsonb_build_object('requestId',r.id,'includedHours','3.8','includedPendingHours','3.8','requestFingerprint',private.payroll_request_fingerprint(to_jsonb(r)),'evidenceHash',repeat('e',64))));
 b:=private.leave_bank_basis(pg_temp.source_person(15),'annual');
 ASSERT b->>'status'='current' AND (b->>'retainedHours')::numeric=11.4;
 ASSERT private.approved_leave_hours_after(pg_temp.source_person(15),ARRAY['Annual leave'],'2026-10-01')=11.4, 'Explicit pre-cutoff inclusion removes only 3.8; smaller post-cutoff quantity does not erase its pending excess or double-count it';
 ASSERT private.payroll_retained_hours(pg_temp.source_person(15),'annual')=15.2;
 ASSERT (SELECT jsonb_agg(to_jsonb(e) ORDER BY id) FROM private.payroll_carryforward_events e WHERE person_id=pg_temp.source_person(15))=before_carry;
END $$;
ROLLBACK TO source_bank_postcutoff_smaller_quantity;
\echo PASS: smaller post-cutoff canonical quantity retains its pending excess once; explicit included pending and immutable history remain exact

SAVEPOINT source_bank_unknown_coverage_before_policy;
INSERT INTO private.leave_accrual_policies(person_id,effective_from,weekly_hours,weekdays,annual_weeks,personal_weeks,enabled,note,actor_user_id)
VALUES(pg_temp.source_person(14),'2026-09-01',38,ARRAY[1,2,3,4,5],4,2,true,'Synthetic original policy for an older approved request',pg_temp.source_person(900));
INSERT INTO public.leave_requests(id,employee_person_id,user_id,leave_type,request_type_label,start_date,end_date,business_days,hours,status,submitted_at,record_origin,source_record_sha256,employment_type_snapshot,pay_treatment)
VALUES(pg_temp.source_request(83),pg_temp.source_person(14),pg_temp.source_person(14),'annual','Annual leave','2026-09-10','2026-09-10',1,NULL,'approved',now(),'historical_import',repeat('f',64),'full_time','paid_entitlement');
DELETE FROM private.leave_accrual_policies WHERE person_id=pg_temp.source_person(14) AND effective_from='2026-09-01';
INSERT INTO private.leave_bank_sources(person_id,leave_kind,hours,report_date,covered_service_through,source_kind,source_fingerprint,note,operator_role)
VALUES(pg_temp.source_person(14),'annual',100,'2026-10-01',NULL,'payroll_report',repeat('a',64),'Synthetic unknown report coverage with earlier approved usage','postgres');
DO $$ DECLARE b jsonb; p jsonb; c jsonb; BEGIN
 ASSERT (SELECT min(effective_from) FROM private.leave_accrual_policies WHERE person_id=pg_temp.source_person(14))='2026-09-11';
 ASSERT private.payroll_request_hours_after(pg_temp.source_request(83),'2026-09-09') IS NULL;
 b:=private.leave_bank_basis(pg_temp.source_person(14),'annual');
 ASSERT b->>'status'='coverage_unconfirmed' AND b->>'coveredThrough' IS NULL AND (b->>'bankHours')::numeric=100;
 ASSERT private.approved_leave_hours_after(pg_temp.source_person(14),ARRAY['Annual leave'],'2026-10-01') IS NULL, 'Old approved usage before the first configured policy cannot be presumed covered by an unknown report period';
 c:=private.calculate_leave_entitlement(pg_temp.source_person(14),'annual','2026-10-07');
 ASSERT (c->>'exactHours')::numeric=100 AND (c->>'earned')::numeric=0;
 p:=private.project_annual_leave_balance(pg_temp.source_person(14),'2026-10-08');
 ASSERT p->>'status'='unavailable' AND p->>'availableHours' IS NULL;
 ASSERT (p->>'payrollHours')::numeric=100;
END $$;
ROLLBACK TO source_bank_unknown_coverage_before_policy;
\echo PASS: unknown coverage with approved usage before the first configured policy fails closed without changing the authoritative bank

ROLLBACK;
