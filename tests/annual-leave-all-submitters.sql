\set ON_ERROR_STOP on
DO $$ BEGIN
  ASSERT current_database() ~ '^mam_test_annual_', 'Synthetic annual-leave database only';
  ASSERT inet_server_addr() IS NULL AND current_setting('listen_addresses') = '';
END $$;
BEGIN;
\ir sql-test-auth.sql
INSERT INTO auth.users(id,email,email_confirmed_at)
SELECT ('b1000000-0000-4000-8000-00000000000'||n)::uuid,'annual'||n||'@example.test',now()
FROM generate_series(1,7) n;
INSERT INTO public.profiles(id,full_name,app_role,login_name,credentials_valid_after)
SELECT ('b1000000-0000-4000-8000-00000000000'||n)::uuid,'Synthetic Annual '||n,
  CASE n WHEN 1 THEN 'system_admin' WHEN 3 THEN 'manager' WHEN 4 THEN 'account' WHEN 5 THEN 'admin' ELSE 'employee' END,
  'annual-fixture-'||n,now()-interval '1 day'
FROM generate_series(1,7) n;
INSERT INTO public.internal_org_people(id,full_name,company_key,position_title,auth_user_id)
SELECT id,full_name,'mam','Synthetic annual role',id FROM public.profiles WHERE login_name LIKE 'annual-fixture-%' AND app_role<>'employee';
INSERT INTO public.internal_org_people(id,full_name,company_key,position_title,auth_user_id,parent_id)
SELECT id,full_name,'mam','Synthetic annual role',id,'b1000000-0000-4000-8000-000000000003'
FROM public.profiles WHERE login_name LIKE 'annual-fixture-%' AND app_role='employee';
INSERT INTO private.employee_directory_details(person_id,employment_type)
SELECT id,CASE WHEN login_name='annual-fixture-6' THEN 'part_time' ELSE 'full_time' END
FROM public.profiles WHERE login_name LIKE 'annual-fixture-%';
INSERT INTO private.employee_annual_leave_balances(person_id,hours,as_of,is_example,updated_by)
SELECT id,0,(now() at time zone 'Australia/Melbourne')::date,false,'b1000000-0000-4000-8000-000000000001'::uuid
FROM public.profiles WHERE login_name LIKE 'annual-fixture-%';
INSERT INTO private.leave_accrual_policies(person_id,effective_from,weekly_hours,weekdays,annual_weeks,personal_weeks,enabled,note)
SELECT d.person_id,'2020-01-01',CASE WHEN d.employment_type='part_time' THEN 37.5 ELSE 38 END,array[1,2,3,4,5],4,2,false,'Synthetic declared ordinary policy; accrual paused for budget-only cases'
FROM private.employee_directory_details d WHERE d.person_id::text LIKE 'b1000000-%' OR d.person_id::text LIKE 'b2000000-%';
INSERT INTO private.leave_payroll_calendars(person_id,calendar_key)
SELECT person_id,'none' FROM private.employee_directory_details WHERE person_id::text LIKE 'b1000000-%' OR person_id::text LIKE 'b2000000-%';
SELECT pg_temp.set_test_actor('b1000000-0000-4000-8000-000000000001');
INSERT INTO private.leave_approval_grants(reviewer_user_id,scope_kind,reviewer_label,priority)
VALUES('b1000000-0000-4000-8000-000000000001','global','Synthetic Annual Admin',100);
INSERT INTO private.manager_leave_reviewers VALUES('b1000000-0000-4000-8000-000000000001',1) ON CONFLICT DO NOTHING;
CREATE FUNCTION pg_temp.annual_fixture_weekday(p_date date)
RETURNS date LANGUAGE sql IMMUTABLE AS $$
  SELECT p_date + CASE extract(isodow FROM p_date)::integer WHEN 6 THEN 2 WHEN 7 THEN 1 ELSE 0 END;
$$;
CREATE FUNCTION pg_temp.annual_request(person uuid,amount numeric,request_status text DEFAULT 'submitted')
RETURNS uuid LANGUAGE plpgsql AS $$ DECLARE r uuid;
  day date:=(current_date+28)-(extract(isodow from current_date+28)::integer-1); BEGIN
  INSERT INTO public.leave_requests(employee_person_id,record_origin,source_record_sha256,status,submitted_at,
    leave_type,request_type_label,start_date,end_date,business_days,hours)
  VALUES(person,'historical_import',encode(sha256(convert_to(gen_random_uuid()::text,'UTF8')),'hex'),request_status,now(),'annual','Annual leave',day,day,1,amount)
  RETURNING id INTO r;
  RETURN r;
END $$;
DO $$ BEGIN
  BEGIN
    INSERT INTO public.leave_requests(employee_person_id,record_origin,source_record_sha256,status,submitted_at,
      leave_type,request_type_label,start_date,end_date,business_days,hours)
    VALUES('b1000000-0000-4000-8000-000000000002','historical_import',repeat('a',64),'submitted',now(),
      'annual','Annual leave',pg_temp.annual_fixture_weekday(current_date),pg_temp.annual_fixture_weekday(current_date),1,7.6);
    RAISE EXCEPTION 'T06: historical import bypassed the shared annual balance gate' USING ERRCODE='ZX001';
  EXCEPTION WHEN invalid_parameter_value THEN
    ASSERT SQLERRM LIKE 'Not enough balance.%' OR SQLERRM LIKE 'Future accrual could not be confirmed%';
  END;
  ASSERT NOT EXISTS(SELECT 1 FROM public.leave_requests WHERE employee_person_id='b1000000-0000-4000-8000-000000000002');
END $$;
\echo PASS T06 historical import obeys the shared balance gate
UPDATE private.employee_annual_leave_balances SET hours=10 WHERE person_id::text LIKE 'b1000000-%';
UPDATE private.leave_accrual_policies SET enabled=false,requires_review=false WHERE person_id::text LIKE 'b1000000-%';
SAVEPOINT self_submission;
SELECT pg_temp.set_test_actor('b1000000-0000-4000-8000-000000000002');
UPDATE private.employee_annual_leave_balances SET hours=0 WHERE person_id='b1000000-0000-4000-8000-000000000002';
SET LOCAL ROLE authenticated;
DO $$ BEGIN
  BEGIN
    PERFORM public.submit_my_leave_request('Annual leave','2030-12-09','2030-12-09');
    RAISE EXCEPTION 'T01: insufficient self submission accepted' USING ERRCODE='ZX001';
  EXCEPTION WHEN invalid_parameter_value THEN ASSERT SQLERRM LIKE ANY(array['Not enough balance.%','Future accrual could not be confirmed%']); END;
END $$;
RESET ROLE;
UPDATE private.employee_annual_leave_balances SET hours=7.6 WHERE person_id='b1000000-0000-4000-8000-000000000002';
SET LOCAL ROLE authenticated;
DO $$ DECLARE r uuid; BEGIN
  SELECT id INTO r FROM public.submit_my_leave_request('Annual leave','2030-12-09','2030-12-09');
  ASSERT r IS NOT NULL;
END $$;
RESET ROLE;
\echo PASS T01 self RPC enforces insufficient and exact funded requests
ROLLBACK TO self_submission;
SAVEPOINT delegated_submission;
DO $$ DECLARE actor uuid; r uuid; BEGIN
  FOR actor IN SELECT ('b1000000-0000-4000-8000-00000000000'||n)::uuid FROM unnest(array[1,3,5]) n LOOP
    PERFORM pg_temp.set_test_actor(actor);
    UPDATE private.employee_annual_leave_balances SET hours=0 WHERE person_id='b1000000-0000-4000-8000-000000000002';
    BEGIN
      PERFORM public.submit_selected_employee_leave_request('b1000000-0000-4000-8000-000000000002','Annual leave','2030-12-09','2030-12-09');
      RAISE EXCEPTION 'T02: delegated submission bypassed balance' USING ERRCODE='ZX001';
    EXCEPTION WHEN invalid_parameter_value THEN ASSERT SQLERRM LIKE ANY(array['Not enough balance.%','Future accrual could not be confirmed%']); END;
    UPDATE private.employee_annual_leave_balances SET hours=10 WHERE person_id='b1000000-0000-4000-8000-000000000002';
    SELECT id INTO r FROM public.submit_selected_employee_leave_request('b1000000-0000-4000-8000-000000000002','Annual leave','2030-12-09','2030-12-09');
    ASSERT r IS NOT NULL;
  END LOOP;
  PERFORM pg_temp.set_test_actor('b1000000-0000-4000-8000-000000000004');
  BEGIN
    PERFORM public.submit_selected_employee_leave_request('b1000000-0000-4000-8000-000000000002','Annual leave','2030-12-09','2030-12-09');
    RAISE EXCEPTION 'T02: Account gained delegated submission' USING ERRCODE='ZX001';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  UPDATE private.employee_annual_leave_balances SET hours=0 WHERE person_id='b1000000-0000-4000-8000-000000000004';
  BEGIN
    PERFORM public.submit_my_leave_request('Annual leave','2030-12-09','2030-12-09');
    RAISE EXCEPTION 'T02: Account self submission bypassed balance' USING ERRCODE='ZX001';
  EXCEPTION WHEN invalid_parameter_value THEN ASSERT SQLERRM LIKE ANY(array['Not enough balance.%','Future accrual could not be confirmed%']); END;
END $$;
\echo PASS T02 Manager Admin and P0 use one rule; Account authority is unchanged
ROLLBACK TO delegated_submission;
SAVEPOINT idempotent_submission;
SELECT pg_temp.set_test_actor('b1000000-0000-4000-8000-000000000002');
DO $$ DECLARE r uuid; replay uuid; key uuid:=gen_random_uuid(); BEGIN
  SELECT id INTO r FROM public.submit_leave_request_once(key,NULL,'Annual leave','2030-12-09','2030-12-09');
  SELECT id INTO replay FROM public.submit_leave_request_once(key,NULL,'Annual leave','2030-12-09','2030-12-09');
  ASSERT replay=r;
  BEGIN
    PERFORM public.submit_leave_request_once(key,NULL,'Annual leave','2030-12-10','2030-12-10');
    RAISE EXCEPTION 'T03: changed submission payload reused key' USING ERRCODE='ZX001';
  EXCEPTION WHEN invalid_parameter_value THEN ASSERT SQLERRM LIKE 'This submission was already used%'; END;
  ASSERT (SELECT count(*)=1 FROM private.leave_submission_receipts WHERE actor_user_id='b1000000-0000-4000-8000-000000000002');
  ASSERT (SELECT count(*)=1 FROM public.leave_requests WHERE employee_person_id='b1000000-0000-4000-8000-000000000002');
END $$;
\echo PASS T03 actual idempotent producer has one request and rejects changed payload
ROLLBACK TO idempotent_submission;
SAVEPOINT direct_rpc;
SELECT pg_temp.set_test_actor('b1000000-0000-4000-8000-000000000002');
UPDATE private.employee_annual_leave_balances SET hours=0 WHERE person_id='b1000000-0000-4000-8000-000000000002';
SET LOCAL ROLE authenticated;
DO $$ BEGIN
  BEGIN PERFORM public.submit_my_leave_request('Annual leave','2030-12-09','2030-12-09');
    RAISE EXCEPTION 'T04: direct authenticated RPC bypassed balance' USING ERRCODE='ZX001';
  EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
END $$;
RESET ROLE;
\echo PASS T04 direct authenticated RPC needs no form or Server Action to enforce the gate
ROLLBACK TO direct_rpc;
SAVEPOINT conflict_candidate;
DO $$ DECLARE r uuid; BEGIN
  r:=pg_temp.annual_request('b1000000-0000-4000-8000-000000000007',4);
  UPDATE private.employee_annual_leave_balances SET hours=0 WHERE person_id='b1000000-0000-4000-8000-000000000007';
  BEGIN
    INSERT INTO public.leave_requests(id,employee_person_id,record_origin,source_record_sha256,status,submitted_at,
      leave_type,request_type_label,start_date,end_date,business_days,hours)
    VALUES(r,'b1000000-0000-4000-8000-000000000002','historical_import',repeat('f',64),'submitted',now(),
      'annual','Annual leave',pg_temp.annual_fixture_weekday(current_date),pg_temp.annual_fixture_weekday(current_date),1,5)
    ON CONFLICT(id) DO UPDATE SET hours=excluded.hours;
    RAISE EXCEPTION 'T08: UPSERT validated the proposal instead of its existing target' USING ERRCODE='ZX001';
  EXCEPTION WHEN invalid_parameter_value THEN ASSERT SQLERRM LIKE ANY(array['Not enough balance.%','Future accrual could not be confirmed%']); END;
  BEGIN
    MERGE INTO public.leave_requests t USING (SELECT r AS id) s ON t.id=s.id
    WHEN MATCHED THEN UPDATE SET hours=5;
    RAISE EXCEPTION 'T08: MERGE update bypassed balance' USING ERRCODE='ZX001';
  EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
  INSERT INTO public.leave_requests(id,employee_person_id,record_origin,source_record_sha256,status,submitted_at,
    leave_type,request_type_label,start_date,end_date,business_days,hours)
  VALUES(r,'b1000000-0000-4000-8000-000000000002','historical_import',repeat('f',64),'submitted',now(),
    'annual','Annual leave',pg_temp.annual_fixture_weekday(current_date),pg_temp.annual_fixture_weekday(current_date),1,5) ON CONFLICT(id) DO NOTHING;
  ASSERT (SELECT hours=4 FROM public.leave_requests WHERE id=r);
END $$;
\echo PASS T08 conflict UPDATE and MERGE use the final target; DO NOTHING adds no obligation
ROLLBACK TO conflict_candidate;
SAVEPOINT update_candidate;
UPDATE private.employee_annual_leave_balances SET hours=10 WHERE person_id='b1000000-0000-4000-8000-000000000002';
DO $$ DECLARE r uuid; BEGIN
  INSERT INTO public.leave_requests(employee_person_id,record_origin,source_record_sha256,status,submitted_at,
    leave_type,request_type_label,start_date,end_date,business_days,hours)
  VALUES('b1000000-0000-4000-8000-000000000002','historical_import',repeat('b',64),'submitted',now(),
    'annual','Annual leave',pg_temp.annual_fixture_weekday(current_date),pg_temp.annual_fixture_weekday(current_date),1,4) RETURNING id INTO r;
  BEGIN
    UPDATE public.leave_requests SET hours=100 WHERE id=r;
    RAISE EXCEPTION 'T09: UPDATE accepted an insufficient final NEW candidate' USING ERRCODE='ZX001';
  EXCEPTION WHEN invalid_parameter_value THEN
    ASSERT SQLERRM LIKE 'Not enough balance.%' OR SQLERRM LIKE 'Future accrual could not be confirmed%';
  END;
  ASSERT (SELECT hours=4 FROM public.leave_requests WHERE id=r);
END $$;
DO $$ DECLARE r uuid; day date; BEGIN
  r:=pg_temp.annual_request('b1000000-0000-4000-8000-000000000002',NULL);
  SELECT start_date INTO day FROM public.leave_requests WHERE id=r;
  BEGIN UPDATE public.leave_requests SET end_date=day+1,business_days=2 WHERE id=r;
    RAISE EXCEPTION 'T09: extended full days used the old amount' USING ERRCODE='ZX001';
  EXCEPTION WHEN invalid_parameter_value THEN ASSERT SQLERRM LIKE ANY(array['Not enough balance.%','Future accrual could not be confirmed%']); END;
  UPDATE public.leave_requests SET start_time='08:00',end_time='12:00',hours=4 WHERE id=r;
  BEGIN UPDATE public.leave_requests SET end_time='16:00' WHERE id=r;
    RAISE EXCEPTION 'T09: timed extension kept understated hours' USING ERRCODE='ZX001';
  EXCEPTION WHEN invalid_parameter_value THEN ASSERT SQLERRM LIKE '%timed hours are inconsistent%'; END;
  UPDATE private.employee_annual_leave_balances SET hours=5 WHERE person_id='b1000000-0000-4000-8000-000000000002';
  BEGIN UPDATE public.leave_requests SET end_time='16:00',hours=8 WHERE id=r;
    RAISE EXCEPTION 'T09: computed timed extension bypassed balance' USING ERRCODE='ZX001';
  EXCEPTION WHEN invalid_parameter_value THEN ASSERT SQLERRM LIKE ANY(array['Not enough balance.%','Future accrual could not be confirmed%']); END;
  ASSERT (SELECT hours=4 AND end_time='12:00' FROM public.leave_requests WHERE id=r);
END $$;
\echo PASS T09 UPDATE checks the final candidate
ROLLBACK TO update_candidate;
SAVEPOINT conditional_cache;
UPDATE private.employee_annual_leave_balances SET hours=10 WHERE person_id='b1000000-0000-4000-8000-000000000002';
DO $$ DECLARE r uuid; BEGIN
  INSERT INTO public.leave_requests(employee_person_id,record_origin,source_record_sha256,status,submitted_at,
    leave_type,request_type_label,start_date,end_date,business_days,hours)
  VALUES('b1000000-0000-4000-8000-000000000002','historical_import',repeat('c',64),'submitted',now(),
    'annual','Annual leave',pg_temp.annual_fixture_weekday(current_date),pg_temp.annual_fixture_weekday(current_date),1,4) RETURNING id INTO r;
  INSERT INTO private.leave_balance_approvals(request_id,approved_by,required_hours)
  VALUES(r,'b1000000-0000-4000-8000-000000000003',4);
  BEGIN
    UPDATE private.leave_balance_approvals SET required_hours=1 WHERE request_id=r;
    RAISE EXCEPTION 'T13: conditional cache accepted underreported hours' USING ERRCODE='ZX001';
  EXCEPTION WHEN invalid_parameter_value THEN
    ASSERT SQLERRM LIKE 'Paid hours are calculated automatically%';
  END;
  ASSERT (SELECT required_hours=4 FROM private.leave_balance_approvals WHERE request_id=r);
  UPDATE public.leave_requests SET hours=5 WHERE id=r;
  ASSERT (SELECT required_hours=5 FROM private.leave_balance_approvals WHERE request_id=r), 'NEW duration refreshes its existing conditional cache';
  PERFORM pg_temp.set_test_actor('b1000000-0000-4000-8000-000000000001');
  BEGIN PERFORM public.set_leave_balance_required_hours(r,1);
    RAISE EXCEPTION 'T13: compatibility RPC accepted understated paid hours' USING ERRCODE='ZX001';
  EXCEPTION WHEN invalid_parameter_value THEN ASSERT SQLERRM='Paid hours are calculated automatically for this request.'; END;
  ASSERT (SELECT required_hours=5 FROM private.leave_balance_approvals WHERE request_id=r);
END $$;
\echo PASS T13 conditional hours cannot be underreported or stale
ROLLBACK TO conditional_cache;
SAVEPOINT legacy_classification;
DO $$ BEGIN
  ASSERT (SELECT employment_type_snapshot IS NULL AND hours IS NULL FROM public.leave_requests
    WHERE id='b2000000-0000-4000-8000-000000000010'), 'Migration must not rewrite legacy requests';
  BEGIN
    UPDATE private.employee_directory_details SET employment_type='full_time'
      WHERE person_id='b2000000-0000-4000-8000-000000000002';
    RAISE EXCEPTION 'T15: Directory silently increased legacy annual hours' USING ERRCODE='ZX001';
  EXCEPTION WHEN object_not_in_prerequisite_state THEN
    ASSERT SQLERRM LIKE 'Legacy annual leave hours require review%';
  END;
  ASSERT (SELECT employment_type='part_time' FROM private.employee_directory_details
    WHERE person_id='b2000000-0000-4000-8000-000000000002');
  ASSERT private.leave_request_required_hours('b2000000-0000-4000-8000-000000000010')=7.5;
  UPDATE private.employee_directory_details SET working_weekdays=array[1,2,3]::smallint[]
    WHERE person_id='b2000000-0000-4000-8000-000000000002';
  ASSERT private.leave_request_required_hours('b2000000-0000-4000-8000-000000000010')=12.5, '37.5 weekly hours over three saved ordinary days uses 12.5 per day';
END $$;
\echo PASS T15 legacy classification changes fail closed without rewriting requests
ROLLBACK TO legacy_classification;
SAVEPOINT own_commitment;
DO $$ DECLARE r uuid; other uuid; BEGIN
  r:=pg_temp.annual_request('b1000000-0000-4000-8000-000000000002',4,'approved');
  UPDATE public.leave_requests SET hours=8 WHERE id=r;
  ASSERT (SELECT hours=8 FROM public.leave_requests WHERE id=r), 'Exclude exactly the already reserved self';
  other:=pg_temp.annual_request('b1000000-0000-4000-8000-000000000002',2,'approved');
  BEGIN
    UPDATE public.leave_requests SET hours=9 WHERE id=r;
    RAISE EXCEPTION 'T11: self exclusion added back another request' USING ERRCODE='ZX001';
  EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
  ASSERT private.approved_leave_hours_after('b1000000-0000-4000-8000-000000000002',array['Annual leave'],current_date-1)=10;
END $$;
\echo PASS T11 own approved commitment is neither double counted nor over-credited
ROLLBACK TO own_commitment;
SAVEPOINT ordinary_approval;
SELECT pg_temp.set_test_actor('b1000000-0000-4000-8000-000000000003');
DO $$ DECLARE r uuid; before_events bigint; before_outbox bigint; BEGIN
  SELECT id INTO r FROM public.submit_selected_employee_leave_request('b1000000-0000-4000-8000-000000000002','Annual leave','2030-12-09','2030-12-09');
  SELECT count(*) INTO before_events FROM public.leave_request_events WHERE leave_request_id=r;
  SELECT count(*) INTO before_outbox FROM private.leave_notification_outbox WHERE request_id=r;
  UPDATE private.employee_annual_leave_balances SET hours=0 WHERE person_id='b1000000-0000-4000-8000-000000000002';
  BEGIN PERFORM public.decide_my_managed_leave_request(r,'Approved',NULL);
    RAISE EXCEPTION 'T12: ordinary approval skipped current balance' USING ERRCODE='ZX001';
  EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
  BEGIN PERFORM public.decide_leave_with_balance(r,'Approved',NULL);
    RAISE EXCEPTION 'T12: balance decision wrapper skipped current balance' USING ERRCODE='ZX001';
  EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
  ASSERT (SELECT status='submitted' AND decided_at IS NULL FROM public.leave_requests WHERE id=r);
  ASSERT (SELECT count(*)=before_events FROM public.leave_request_events WHERE leave_request_id=r);
  ASSERT (SELECT count(*)=before_outbox FROM private.leave_notification_outbox WHERE request_id=r);
  PERFORM pg_temp.set_test_actor('b1000000-0000-4000-8000-000000000002');
  BEGIN PERFORM public.decide_my_managed_leave_request(r,'Approved',NULL);
    RAISE EXCEPTION 'T12: self approval became authorized' USING ERRCODE='ZX001';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END $$;
\echo PASS T12 both approval RPCs recheck; rejection rolls back notes decisions events and outbox
ROLLBACK TO ordinary_approval;
SAVEPOINT declining_obligation;
DO $$ DECLARE r uuid; rejected uuid; before_bank numeric; BEGIN
  r:=pg_temp.annual_request('b1000000-0000-4000-8000-000000000002',4,'approved');
  rejected:=pg_temp.annual_request('b1000000-0000-4000-8000-000000000002',4);
  UPDATE private.employee_annual_leave_balances SET hours=0 WHERE person_id='b1000000-0000-4000-8000-000000000002';
  SELECT hours INTO before_bank FROM private.employee_annual_leave_balances WHERE person_id='b1000000-0000-4000-8000-000000000002';
  UPDATE public.leave_requests SET manager_note='Synthetic unchanged amount',submitted_by='b1000000-0000-4000-8000-000000000001' WHERE id=r;
  UPDATE public.leave_requests SET status='cancelled' WHERE id=r;
  UPDATE public.leave_requests SET status='rejected' WHERE id=rejected;
  ASSERT (SELECT hours=before_bank FROM private.employee_annual_leave_balances WHERE person_id='b1000000-0000-4000-8000-000000000002');
  ASSERT (SELECT hours=4 AND employment_type_snapshot='full_time' FROM public.leave_requests WHERE id=r);
END $$;
\echo PASS T14 metadata cancellation and rejection stay possible without refund or retroactive rewrite
ROLLBACK TO declining_obligation;
SAVEPOINT employee_type_candidate;
DO $$ DECLARE r uuid; BEGIN
  r:=pg_temp.annual_request('b1000000-0000-4000-8000-000000000002',4);
  UPDATE private.employee_annual_leave_balances SET hours=0 WHERE person_id='b1000000-0000-4000-8000-000000000007';
  BEGIN UPDATE public.leave_requests SET employee_person_id='b1000000-0000-4000-8000-000000000007' WHERE id=r;
    RAISE EXCEPTION 'T10: changed employee was not checked' USING ERRCODE='ZX001';
  EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
  BEGIN UPDATE public.leave_requests SET leave_type='unpaid' WHERE id=r;
    RAISE EXCEPTION 'T10: annual label and enum diverged' USING ERRCODE='ZX001';
  EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
  BEGIN UPDATE public.leave_requests SET pay_treatment='unpaid' WHERE id=r;
    RAISE EXCEPTION 'T10: annual pay treatment bypassed the gate' USING ERRCODE='ZX001';
  EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
  BEGIN UPDATE public.leave_requests SET employment_type_snapshot='part_time' WHERE id=r;
    RAISE EXCEPTION 'T10: caller reduced the full-time snapshot' USING ERRCODE='ZX001';
  EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
  UPDATE public.leave_requests SET leave_type='unpaid',request_type_label='Unpaid leave',pay_treatment='unpaid' WHERE id=r;
  UPDATE private.employee_annual_leave_balances SET hours=0 WHERE person_id='b1000000-0000-4000-8000-000000000002';
  BEGIN UPDATE public.leave_requests SET leave_type='annual',request_type_label='Annual leave',pay_treatment='paid_entitlement' WHERE id=r;
    RAISE EXCEPTION 'T10: unpaid-to-annual transition bypassed balance' USING ERRCODE='ZX001';
  EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
END $$;
\echo PASS T10 final employee label enum pay treatment and employment snapshot cannot understate annual obligations
ROLLBACK TO employee_type_candidate;
SAVEPOINT projected_boundaries;
DO $$ DECLARE p constant uuid:='b1000000-0000-4000-8000-000000000002'; r uuid; day date;
  projection jsonb; BEGIN
  day:=(current_date+28)-(extract(isodow from current_date+28)::integer-1);
  UPDATE private.employee_annual_leave_balances SET hours=5 WHERE person_id=p;
  INSERT INTO private.leave_accrual_policies(person_id,effective_from,weekly_hours,weekdays,annual_weeks,personal_weeks,enabled,note,actor_user_id)
  VALUES(p,pg_temp.annual_fixture_weekday(current_date)+1,38,array[1,2,3,4,5],4,2,true,'Synthetic projected policy','b1000000-0000-4000-8000-000000000001');
  projection:=private.project_annual_leave_balance(p,day);
  ASSERT projection->>'status'='projected' AND (projection->>'availableHours')::numeric>=7.6;
  r:=pg_temp.annual_request(p,NULL);
  BEGIN UPDATE public.leave_requests SET start_date=pg_temp.annual_fixture_weekday(current_date),end_date=pg_temp.annual_fixture_weekday(current_date) WHERE id=r;
    RAISE EXCEPTION 'T17: earlier start retained future accrual' USING ERRCODE='ZX001';
  EXCEPTION WHEN invalid_parameter_value THEN ASSERT SQLERRM LIKE ANY(array['Not enough balance.%','Future accrual could not be confirmed%']); END;
  UPDATE private.leave_accrual_policies SET enabled=false WHERE person_id=p;
  UPDATE private.employee_annual_leave_balances SET hours=10.9999 WHERE person_id=p;
  BEGIN PERFORM pg_temp.annual_request(p,11);
    RAISE EXCEPTION 'T17: four-decimal shortfall rounded into sufficiency' USING ERRCODE='ZX001';
  EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
  UPDATE private.employee_annual_leave_balances SET hours=11 WHERE person_id=p;
  PERFORM pg_temp.annual_request(p,11);
  UPDATE private.employee_annual_leave_balances SET is_example=true WHERE person_id=p;
  BEGIN PERFORM pg_temp.annual_request(p,1);
    RAISE EXCEPTION 'T17: example balance became usable' USING ERRCODE='ZX001';
  EXCEPTION WHEN invalid_parameter_value THEN ASSERT SQLERRM LIKE '%projection is unavailable%'; END;
  DELETE FROM private.employee_annual_leave_balances WHERE person_id=p;
  BEGIN PERFORM pg_temp.annual_request(p,1);
    RAISE EXCEPTION 'T17: missing balance became usable' USING ERRCODE='ZX001';
  EXCEPTION WHEN invalid_parameter_value THEN ASSERT SQLERRM LIKE '%projection is unavailable%'; END;
END $$;
\echo PASS T17 forecast credit missing evidence and exact four-decimal balance thresholds
ROLLBACK TO projected_boundaries;
SAVEPOINT other_entitlements;
DO $$ DECLARE person uuid:='b1000000-0000-4000-8000-000000000002'; r uuid; label text; kind text; BEGIN
  r:=pg_temp.annual_request('b1000000-0000-4000-8000-000000000006',NULL);
  ASSERT private.leave_request_required_hours(r)=7.5;
  r:=pg_temp.annual_request(person,NULL);
  ASSERT private.leave_request_required_hours(r)=7.6;
  UPDATE private.employee_annual_leave_balances SET hours=0 WHERE person_id=person;
  FOR label,kind IN VALUES('Sick leave','personal'),('Carer''s leave','personal'),('Unpaid leave','unpaid') LOOP
    INSERT INTO public.leave_requests(employee_person_id,record_origin,source_record_sha256,status,submitted_at,
      leave_type,request_type_label,start_date,end_date,business_days,hours)
    VALUES(person,'historical_import',encode(sha256(convert_to(gen_random_uuid()::text,'UTF8')),'hex'),'submitted',now(),
      kind,label,pg_temp.annual_fixture_weekday(current_date),pg_temp.annual_fixture_weekday(current_date),1,4);
  END LOOP;
  PERFORM pg_temp.set_test_actor('b1000000-0000-4000-8000-000000000003');
  BEGIN PERFORM public.submit_selected_employee_leave_request(person,'Annual leave',pg_temp.annual_fixture_weekday(current_date),pg_temp.annual_fixture_weekday(current_date));
    RAISE EXCEPTION 'T18: notice exemption became balance exemption' USING ERRCODE='ZX001';
  EXCEPTION WHEN invalid_parameter_value THEN ASSERT SQLERRM LIKE ANY(array['Not enough balance.%','Future accrual could not be confirmed%']); END;
END $$;
\echo PASS T18 full-time part-time and non-annual rules are retained; notice exemption does not bypass balance
ROLLBACK TO other_entitlements;
SAVEPOINT retained_payroll;
\ir payroll-closing-setup.sql
SELECT public.reconcile_payroll_closing('synthetic-annual-gate-closing',pg_temp.closing_payload());
DO $$ DECLARE bank numeric; before_source text; BEGIN
  SELECT hours INTO bank FROM private.employee_annual_leave_balances WHERE person_id='96000000-0000-4000-8000-000000000003';
  SELECT source_record_sha256 INTO before_source FROM public.leave_requests WHERE id='96000000-0000-4000-8000-000000000013';
  BEGIN UPDATE public.leave_requests SET hours=1 WHERE id='96000000-0000-4000-8000-000000000013';
    RAISE EXCEPTION 'T19: protected retained allocation changed' USING ERRCODE='ZX001';
  EXCEPTION WHEN object_not_in_prerequisite_state THEN ASSERT SQLERRM LIKE 'A reconciled request cannot change%'; END;
  UPDATE public.leave_requests SET manager_note='Synthetic unchanged payroll metadata' WHERE id='96000000-0000-4000-8000-000000000013';
  UPDATE public.leave_requests SET status='cancelled' WHERE id='96000000-0000-4000-8000-000000000013';
  ASSERT (SELECT accounted_hours=76 AND pending_hours=0 FROM private.payroll_carryforward_events
    WHERE request_id='96000000-0000-4000-8000-000000000013' ORDER BY id DESC LIMIT 1);
  ASSERT (SELECT hours=bank FROM private.employee_annual_leave_balances WHERE person_id='96000000-0000-4000-8000-000000000003');
  ASSERT (SELECT source_record_sha256=before_source FROM public.leave_requests WHERE id='96000000-0000-4000-8000-000000000013');
END $$;
\echo PASS T19 retained accounted hours protection source digest and no-refund cancellation remain intact
ROLLBACK TO retained_payroll;
DO $$ BEGIN
  ASSERT private.confirmed_test_purge_schema_hash()=(SELECT schema_hash FROM private.confirmed_test_purge_schema WHERE singleton);
  ASSERT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.leave_requests'::regclass
    AND tgname='z_leave_requests_banked_annual_limit' AND tgenabled='O' AND (tgtype&4)=4 AND (tgtype&16)=16);
  ASSERT (SELECT relrowsecurity FROM pg_class WHERE oid='public.leave_requests'::regclass);
  ASSERT NOT has_function_privilege('authenticated','private.enforce_banked_annual_leave_request()','EXECUTE');
  ASSERT NOT has_function_privilege('service_role','private.lock_annual_leave_budget(boolean)','EXECUTE');
  ASSERT position('record_origin' IN pg_get_functiondef('private.enforce_banked_annual_leave_request()'::regprocedure))=0;
  ASSERT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.leave_requests'::regclass
    AND tgname='payroll_carryforward_request_guard' AND tgenabled='O');
  ASSERT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.leave_requests'::regclass
    AND tgname='leave_notification_on_mutation' AND tgenabled='O');
END $$;
\echo PASS T20 effective INSERT UPDATE RLS private ACL and notification protections remain enabled
SAVEPOINT source_bank_weekend_producers;
INSERT INTO private.leave_accrual_policies(person_id,effective_from,weekly_hours,weekdays,annual_weeks,personal_weeks,enabled,note)
VALUES('b1000000-0000-4000-8000-000000000006','2020-01-02',12,array[6,7],4,2,false,'Synthetic declared weekend ordinary hours; accrual paused');
UPDATE private.employee_annual_leave_balances SET hours=5.9999 WHERE person_id='b1000000-0000-4000-8000-000000000006';
SELECT pg_temp.set_test_actor('b1000000-0000-4000-8000-000000000006');
SET LOCAL ROLE authenticated;
DO $$ DECLARE day date:=(current_date+28)+(6-extract(isodow from current_date+28)::integer); BEGIN
  BEGIN
    PERFORM public.submit_my_leave_request('Annual leave',day,day);
    RAISE EXCEPTION 'Weekend self request rounded insufficient balance into funding' USING ERRCODE='ZX001';
  EXCEPTION WHEN invalid_parameter_value THEN
    ASSERT SQLERRM LIKE ANY(array['Not enough balance.%','Future accrual could not be confirmed%']);
  END;
END $$;
RESET ROLE;
DO $$ BEGIN ASSERT NOT EXISTS(SELECT 1 FROM public.leave_requests WHERE employee_person_id='b1000000-0000-4000-8000-000000000006'); END $$;
UPDATE private.employee_annual_leave_balances SET hours=6 WHERE person_id='b1000000-0000-4000-8000-000000000006';
SET LOCAL ROLE authenticated;
DO $$ DECLARE day date:=(current_date+28)+(6-extract(isodow from current_date+28)::integer); r uuid; replay uuid;
  key constant uuid:='b6000000-0000-4000-8000-000000000066'; BEGIN
  SELECT id INTO r FROM public.submit_my_leave_request('Annual leave',day,day);
  ASSERT r IS NOT NULL;
  ASSERT (SELECT business_days=1 AND hours IS NULL FROM public.leave_requests WHERE id=r), 'Full weekend request uses the policy quantity, without rounded stored hours';
  SELECT id INTO r FROM public.submit_leave_request_once(key,NULL,'Annual leave',day+1,day+1);
  SELECT id INTO replay FROM public.submit_leave_request_once(key,NULL,'Annual leave',day+1,day+1);
  ASSERT replay=r, 'Weekend idempotent producer has one canonical request';
  BEGIN
    PERFORM public.submit_leave_request_once(key,NULL,'Annual leave',day+7,day+7);
    RAISE EXCEPTION 'Weekend replay accepted changed request details' USING ERRCODE='ZX001';
  EXCEPTION WHEN invalid_parameter_value THEN ASSERT SQLERRM LIKE 'This submission was already used%'; END;
  BEGIN
    PERFORM public.submit_my_leave_request('Annual leave',day-1,day-1);
    RAISE EXCEPTION 'Weekend employee acquired Friday annual leave' USING ERRCODE='ZX001';
  EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
  BEGIN
    PERFORM public.decide_my_managed_leave_request(r,'Approved',NULL);
    RAISE EXCEPTION 'Weekend employee acquired self-approval' USING ERRCODE='ZX001';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END $$;
RESET ROLE;
DO $$ DECLARE r record; BEGIN
  ASSERT (SELECT count(*)=2 FROM public.leave_requests WHERE employee_person_id='b1000000-0000-4000-8000-000000000006');
  FOR r IN SELECT id FROM public.leave_requests WHERE employee_person_id='b1000000-0000-4000-8000-000000000006' LOOP
    ASSERT private.leave_request_required_hours(r.id)=6, '12 weekly hours over Saturday/Sunday is six per day';
  END LOOP;
  ASSERT (SELECT count(*)=1 FROM private.leave_submission_receipts
    WHERE actor_user_id='b1000000-0000-4000-8000-000000000006' AND submission_key='b6000000-0000-4000-8000-000000000066');
END $$;
SELECT pg_temp.set_test_actor('b1000000-0000-4000-8000-000000000003');
SET LOCAL ROLE authenticated;
DO $$ DECLARE day date:=(current_date+28)+(6-extract(isodow from current_date+28)::integer); r uuid; BEGIN
  SELECT id INTO r FROM public.submit_selected_employee_leave_request('b1000000-0000-4000-8000-000000000006','Annual leave',day+7,day+7);
  ASSERT r IS NOT NULL, 'Direct manager can submit a funded saved-policy weekend';
END $$;
RESET ROLE;
SELECT pg_temp.set_test_actor('b1000000-0000-4000-8000-000000000004');
SET LOCAL ROLE authenticated;
DO $$ DECLARE day date:=(current_date+28)+(6-extract(isodow from current_date+28)::integer); BEGIN
  BEGIN
    PERFORM public.submit_selected_employee_leave_request('b1000000-0000-4000-8000-000000000006','Annual leave',day+14,day+14);
    RAISE EXCEPTION 'Account acquired delegated weekend submission' USING ERRCODE='ZX001';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END $$;
RESET ROLE;
UPDATE private.employee_annual_leave_balances SET hours=11.9999 WHERE person_id='b1000000-0000-4000-8000-000000000006';
SELECT pg_temp.set_test_actor('b1000000-0000-4000-8000-000000000006');
SET LOCAL ROLE authenticated;
DO $$ DECLARE day date:=(current_date+28)+(6-extract(isodow from current_date+28)::integer); BEGIN
  BEGIN
    PERFORM public.submit_my_leave_request('Annual leave',day+20,day+22);
    RAISE EXCEPTION 'Friday through Sunday annual request rounded twelve hours into funding' USING ERRCODE='ZX001';
  EXCEPTION WHEN invalid_parameter_value THEN
    ASSERT SQLERRM LIKE ANY(array['Not enough balance.%','Future accrual could not be confirmed%']);
  END;
END $$;
RESET ROLE;
UPDATE private.employee_annual_leave_balances SET hours=12 WHERE person_id='b1000000-0000-4000-8000-000000000006';
SET LOCAL ROLE authenticated;
DO $$ DECLARE day date:=(current_date+28)+(6-extract(isodow from current_date+28)::integer); r uuid; BEGIN
  SELECT id INTO r FROM public.submit_my_leave_request('Annual leave',day+20,day+22);
  ASSERT r IS NOT NULL;
  ASSERT (SELECT business_days=2 AND hours IS NULL FROM public.leave_requests WHERE id=r), 'Friday through Sunday contains two scheduled days';
END $$;
RESET ROLE;
DO $$ DECLARE r record; BEGIN
  FOR r IN SELECT id,business_days FROM public.leave_requests WHERE employee_person_id='b1000000-0000-4000-8000-000000000006' LOOP
    ASSERT private.leave_request_required_hours(r.id)=r.business_days*6;
  END LOOP;
  ASSERT (SELECT count(*)=4 FROM public.leave_requests WHERE employee_person_id='b1000000-0000-4000-8000-000000000006');
END $$;
ROLLBACK TO source_bank_weekend_producers;
\echo PASS: actual self selected idempotent weekend producers; exact policy quantity; role and replay boundaries

SAVEPOINT fractional_conditional_approval;
CREATE TEMP TABLE annual_precision_request(id uuid PRIMARY KEY);
GRANT SELECT,INSERT ON pg_temp.annual_precision_request TO authenticated;
INSERT INTO private.leave_accrual_policies(person_id,effective_from,weekly_hours,weekdays,annual_weeks,personal_weeks,enabled,note)
VALUES('b1000000-0000-4000-8000-000000000002','2020-01-02',38,array[1,2,3],4,2,false,'Synthetic fractional conditional quantity');
UPDATE private.employee_annual_leave_balances SET hours=20 WHERE person_id='b1000000-0000-4000-8000-000000000002';
SELECT pg_temp.set_test_actor('b1000000-0000-4000-8000-000000000002');
SET LOCAL ROLE authenticated;
INSERT INTO pg_temp.annual_precision_request
SELECT id FROM public.submit_my_leave_request('Annual leave','2030-12-09','2030-12-09');
RESET ROLE;
SELECT pg_temp.set_test_actor('b1000000-0000-4000-8000-000000000003');
SET LOCAL ROLE authenticated;
DO $$ DECLARE result record; BEGIN
  SELECT * INTO result FROM public.decide_leave_with_balance((SELECT id FROM pg_temp.annual_precision_request),'Approved – pending leave balance',NULL);
  ASSERT result.status='Approved – pending leave balance';
END $$;
RESET ROLE;
DO $$ DECLARE r uuid:=(SELECT id FROM pg_temp.annual_precision_request); BEGIN
  ASSERT (SELECT status='submitted' AND record_origin='portal' AND approval_required FROM public.leave_requests WHERE id=r);
  ASSERT private.leave_request_required_hours(r)=38::numeric/3;
  ASSERT (SELECT required_hours=12.6667 FROM private.leave_balance_approvals WHERE request_id=r);
  UPDATE private.employee_annual_leave_balances SET hours=12.6667 WHERE person_id='b1000000-0000-4000-8000-000000000002';
  ASSERT private.leave_payroll_balance_sufficient(r), 'Rounded-up receipt must not reject sufficient raw funding';
  ASSERT NOT has_table_privilege('authenticated','private.leave_balance_approvals','SELECT');
  ASSERT NOT has_function_privilege('authenticated','private.leave_request_required_hours(uuid)','EXECUTE');
  ASSERT NOT has_function_privilege('authenticated','private.leave_payroll_balance_sufficient(uuid)','EXECUTE');
END $$;
SELECT pg_temp.set_test_actor('b1000000-0000-4000-8000-000000000002');
SET LOCAL ROLE authenticated;
DO $$ DECLARE r uuid:=(SELECT id FROM pg_temp.annual_precision_request); BEGIN
  ASSERT EXISTS(SELECT 1 FROM jsonb_array_elements(public.get_leave_priority_workspace()->'requests') q WHERE q->>'id'=r::text AND (q->>'balanceSufficient')::boolean);
  BEGIN
    PERFORM public.decide_leave_with_balance(r,'Approved – pending leave balance',NULL);
    RAISE EXCEPTION 'Fractional receipt authorized self approval' USING ERRCODE='ZX001';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END $$;
RESET ROLE;
SELECT pg_temp.set_test_actor('b1000000-0000-4000-8000-000000000004');
SET LOCAL ROLE authenticated;
DO $$ BEGIN
  BEGIN
    PERFORM public.decide_leave_with_balance((SELECT id FROM pg_temp.annual_precision_request),'Approved – pending leave balance',NULL);
    RAISE EXCEPTION 'Fractional receipt authorized Account review' USING ERRCODE='ZX001';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END $$;
RESET ROLE;
SELECT pg_temp.set_test_actor('b1000000-0000-4000-8000-000000000007');
SET LOCAL ROLE authenticated;
DO $$ BEGIN
  ASSERT NOT EXISTS(SELECT 1 FROM jsonb_array_elements(public.get_leave_priority_workspace()->'requests') q WHERE q->>'id'=(SELECT id::text FROM pg_temp.annual_precision_request)), 'Sibling employee must not see another employee request';
END $$;
RESET ROLE;
ROLLBACK TO fractional_conditional_approval;
\echo PASS: actual authenticated conditional RPC stores 38/3 as 12.6667; sufficient raw funding; private receipts and reviewer authority unchanged

SAVEPOINT rounded_down_conditional_funding;
CREATE TEMP TABLE annual_precision_request(id uuid PRIMARY KEY);
GRANT SELECT,INSERT ON pg_temp.annual_precision_request TO authenticated;
INSERT INTO private.leave_accrual_policies(person_id,effective_from,weekly_hours,weekdays,annual_weeks,personal_weeks,enabled,note)
VALUES('b1000000-0000-4000-8000-000000000002','2020-01-02',37,array[1,2,3],4,2,false,'Synthetic raw funding boundary');
UPDATE private.employee_annual_leave_balances SET hours=20 WHERE person_id='b1000000-0000-4000-8000-000000000002';
SELECT pg_temp.set_test_actor('b1000000-0000-4000-8000-000000000002');
SET LOCAL ROLE authenticated;
INSERT INTO pg_temp.annual_precision_request
SELECT id FROM public.submit_my_leave_request('Annual leave','2030-12-09','2030-12-09');
RESET ROLE;
SELECT pg_temp.set_test_actor('b1000000-0000-4000-8000-000000000003');
SET LOCAL ROLE authenticated;
SELECT * FROM public.decide_leave_with_balance((SELECT id FROM pg_temp.annual_precision_request),'Approved – pending leave balance',NULL);
RESET ROLE;
DO $$ DECLARE r uuid:=(SELECT id FROM pg_temp.annual_precision_request); BEGIN
  ASSERT private.leave_request_required_hours(r)=37::numeric/3;
  ASSERT (SELECT required_hours=12.3333 FROM private.leave_balance_approvals WHERE request_id=r);
  UPDATE private.employee_annual_leave_balances SET hours=12.3333 WHERE person_id='b1000000-0000-4000-8000-000000000002';
  ASSERT NOT private.leave_payroll_balance_sufficient(r), 'Four-decimal cache must not fund a greater raw quantity';
END $$;
SELECT pg_temp.set_test_actor('b1000000-0000-4000-8000-000000000002');
SET LOCAL ROLE authenticated;
DO $$ BEGIN
  ASSERT EXISTS(SELECT 1 FROM jsonb_array_elements(public.get_leave_priority_workspace()->'requests') q WHERE q->>'id'=(SELECT id::text FROM pg_temp.annual_precision_request) AND NOT (q->>'balanceSufficient')::boolean);
END $$;
RESET ROLE;
DO $$ DECLARE r uuid:=(SELECT id FROM pg_temp.annual_precision_request); BEGIN
  UPDATE private.employee_annual_leave_balances SET hours=12.3334 WHERE person_id='b1000000-0000-4000-8000-000000000002';
  ASSERT private.leave_payroll_balance_sufficient(r), 'Funding above the raw quantity is sufficient';
  ASSERT (SELECT required_hours=12.3333 FROM private.leave_balance_approvals WHERE request_id=r), 'Funding checks must not rewrite the receipt';
END $$;
ROLLBACK TO rounded_down_conditional_funding;
\echo PASS: conditional funding uses raw 37/3; 12.3333 is insufficient and 12.3334 is sufficient without rewriting the receipt

SAVEPOINT current_policy_conditional_funding;
CREATE TEMP TABLE annual_precision_request(id uuid PRIMARY KEY);
GRANT SELECT,INSERT ON pg_temp.annual_precision_request TO authenticated;
UPDATE private.employee_annual_leave_balances SET hours=20 WHERE person_id='b1000000-0000-4000-8000-000000000006';
SELECT pg_temp.set_test_actor('b1000000-0000-4000-8000-000000000006');
SET LOCAL ROLE authenticated;
INSERT INTO pg_temp.annual_precision_request
SELECT id FROM public.submit_my_leave_request('Annual leave','2030-12-09','2030-12-09');
RESET ROLE;
SELECT pg_temp.set_test_actor('b1000000-0000-4000-8000-000000000003');
SET LOCAL ROLE authenticated;
SELECT * FROM public.decide_leave_with_balance((SELECT id FROM pg_temp.annual_precision_request),'Approved – pending leave balance',NULL);
RESET ROLE;
DO $$ BEGIN
  ASSERT (SELECT required_hours=7.5 FROM private.leave_balance_approvals WHERE request_id=(SELECT id FROM pg_temp.annual_precision_request));
END $$;
INSERT INTO private.leave_accrual_policies(person_id,effective_from,weekly_hours,weekdays,annual_weeks,personal_weeks,enabled,note)
VALUES('b1000000-0000-4000-8000-000000000006','2020-01-02',38,array[1,2,3,4],4,2,false,'Synthetic changed ordinary work arrangement');
DO $$ DECLARE r uuid:=(SELECT id FROM pg_temp.annual_precision_request); BEGIN
  ASSERT private.leave_request_required_hours(r)=9.5;
  ASSERT (SELECT required_hours=7.5 FROM private.leave_balance_approvals WHERE request_id=r), 'A work policy change must not silently rewrite the decision receipt';
  UPDATE private.employee_annual_leave_balances SET hours=8 WHERE person_id='b1000000-0000-4000-8000-000000000006';
  ASSERT NOT private.leave_payroll_balance_sufficient(r), 'Stale 7.5-hour receipt cannot fund a current 9.5-hour obligation';
  UPDATE private.employee_annual_leave_balances SET hours=10 WHERE person_id='b1000000-0000-4000-8000-000000000006';
  ASSERT private.leave_payroll_balance_sufficient(r);
END $$;
INSERT INTO private.leave_accrual_policies(person_id,effective_from,weekly_hours,weekdays,annual_weeks,personal_weeks,enabled,note)
VALUES('b1000000-0000-4000-8000-000000000006','2020-01-03',38,array[1,1,2,3],4,2,false,'Synthetic ambiguous ordinary schedule');
DO $$ DECLARE r uuid:=(SELECT id FROM pg_temp.annual_precision_request); BEGIN
  ASSERT private.leave_request_required_hours(r) IS NULL;
  ASSERT NOT private.leave_payroll_balance_sufficient(r), 'Unknown live quantity must fail closed despite a funded stale receipt';
  ASSERT (SELECT required_hours=7.5 FROM private.leave_balance_approvals WHERE request_id=r);
END $$;
ROLLBACK TO current_policy_conditional_funding;
\echo PASS: live policy quantity controls conditional funding; stale receipt is immutable and unknown quantity fails closed

SAVEPOINT historical_timed_precision;
UPDATE private.employee_annual_leave_balances SET hours=2.0084 WHERE person_id='b1000000-0000-4000-8000-000000000002';
DO $$ DECLARE r uuid; BEGIN
  ASSERT private.leave_request_quantity('b1000000-0000-4000-8000-000000000002','2030-12-09','2030-12-09','09:00','11:10',2.17)=130::numeric/60;
  ASSERT private.leave_request_quantity('b1000000-0000-4000-8000-000000000002','2030-12-09','2030-12-09','09:00','11:10',6) IS NULL;
  INSERT INTO public.leave_requests(employee_person_id,record_origin,source_record_sha256,status,submitted_at,leave_type,request_type_label,start_date,end_date,business_days,start_time,end_time,hours)
  VALUES('b1000000-0000-4000-8000-000000000002','historical_import',encode(sha256(convert_to('synthetic-annual-historical-timed-precision-20261008','UTF8')),'hex'),'submitted',now(),'annual','Annual leave','2030-12-09','2030-12-09',1,'09:00:00','11:00:30',2.01) RETURNING id INTO r;
  ASSERT (SELECT hours=2.01 FROM public.leave_requests WHERE id=r);
  ASSERT private.leave_request_required_hours(r)=7230::numeric/3600;
  ASSERT private.leave_payroll_day_hours(r,'2030-12-09')=7230::numeric/3600;
  BEGIN
    UPDATE public.leave_requests SET hours=6 WHERE id=r;
    RAISE EXCEPTION 'Historical timed request accepted a six-hour cache for two hours and thirty seconds' USING ERRCODE='ZX001';
  EXCEPTION WHEN invalid_parameter_value THEN ASSERT SQLERRM LIKE '%timed hours are inconsistent%'; END;
  ASSERT (SELECT hours=2.01 FROM public.leave_requests WHERE id=r);
END $$;
ROLLBACK TO historical_timed_precision;
\echo PASS: 130-minute canonical helper validates its 2.17-hour cache; a valid timed row funds actual elapsed hours and rejects a mismatched cache

ROLLBACK;
