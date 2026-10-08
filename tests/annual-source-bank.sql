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
(pg_temp.source_request(1),pg_temp.source_person(1),pg_temp.source_person(1),'sick','Sick leave','2026-09-24','2026-09-24',1,NULL,'approved',now(),'historical_import',repeat('1',64),'full_time','paid_entitlement'),
(pg_temp.source_request(2),pg_temp.source_person(2),pg_temp.source_person(2),'annual','Annual leave','2030-12-09','2030-12-09',1,NULL,'approved',now(),'historical_import',repeat('2',64),'full_time','paid_entitlement'),
(pg_temp.source_request(3),pg_temp.source_person(3),pg_temp.source_person(3),'annual','Annual leave','2026-09-26','2026-09-27',2,NULL,'approved',now(),'historical_import',repeat('3',64),'part_time','paid_entitlement'),
(pg_temp.source_request(4),pg_temp.source_person(4),pg_temp.source_person(4),'annual','Annual leave','2026-09-11','2026-10-02',16,NULL,'approved',now(),'historical_import',repeat('4',64),'full_time','paid_entitlement'),
(pg_temp.source_request(5),pg_temp.source_person(5),pg_temp.source_person(5),'unpaid','Unpaid leave','2026-10-05','2026-10-05',1,NULL,'approved',now(),'historical_import',repeat('5',64),'full_time','unpaid'),
(pg_temp.source_request(6),pg_temp.source_person(6),pg_temp.source_person(6),'sick','Sick leave','2026-10-05','2026-10-05',1,5,'approved',now(),'historical_import',repeat('6',64),'full_time','paid_entitlement'),
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
UPDATE private.employee_annual_leave_balances SET as_of='2026-09-24',hours=20 WHERE person_id=pg_temp.source_person(9);
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
ROLLBACK;
