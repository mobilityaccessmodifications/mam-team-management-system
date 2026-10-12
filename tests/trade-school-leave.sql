\set ON_ERROR_STOP on
DO $$ BEGIN
  ASSERT current_database() ~ '^mam_test_trade_', 'Synthetic trade-school database only';
  ASSERT inet_server_addr() IS NULL AND current_setting('listen_addresses') = '';
END $$;
BEGIN;
\ir sql-test-auth.sql
DO $$ BEGIN
  ASSERT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid='private.employee_directory_details'::regclass AND attname='trade_school_enabled' AND attnotnull AND NOT attisdropped), 'Trade-school entitlement flag is missing';
END $$;
INSERT INTO auth.users(id,email,email_confirmed_at)
SELECT ('d1000000-0000-4000-8000-00000000000'||n)::uuid,'trade'||n||'@example.test',now() FROM generate_series(1,7) n;
INSERT INTO public.profiles(id,full_name,app_role,login_name,credentials_valid_after)
SELECT ('d1000000-0000-4000-8000-00000000000'||n)::uuid,'Synthetic Trade '||n,
  CASE n WHEN 1 THEN 'system_admin' WHEN 3 THEN 'manager' WHEN 4 THEN 'account' WHEN 5 THEN 'admin' ELSE 'employee' END,
  'trade-fixture-'||n,now()-interval '1 day' FROM generate_series(1,7) n;
INSERT INTO public.internal_org_people(id,full_name,company_key,position_title,auth_user_id)
SELECT id,full_name,'mam','Synthetic trade role',id FROM public.profiles WHERE login_name LIKE 'trade-fixture-%' AND app_role<>'employee';
INSERT INTO public.internal_org_people(id,full_name,company_key,position_title,auth_user_id,parent_id)
SELECT id,full_name,'mam','Synthetic trade role',id,'d1000000-0000-4000-8000-000000000003' FROM public.profiles WHERE login_name LIKE 'trade-fixture-%' AND app_role='employee';
INSERT INTO private.employee_directory_details(person_id,employment_type)
SELECT id,'full_time' FROM public.profiles WHERE login_name LIKE 'trade-fixture-%';
DO $$ BEGIN ASSERT NOT EXISTS(SELECT 1 FROM private.employee_directory_details WHERE trade_school_enabled), 'Entitlement must default disabled for every employee'; END $$;
UPDATE private.employee_directory_details SET trade_school_enabled=true WHERE person_id='d1000000-0000-4000-8000-000000000002';
SELECT pg_temp.set_test_actor('d1000000-0000-4000-8000-000000000002');
SET LOCAL ROLE authenticated;
DO $$ BEGIN
  ASSERT (SELECT array_agg(person_id) FROM public.list_trade_school_leave_entitlements())=ARRAY['d1000000-0000-4000-8000-000000000002'::uuid], 'Eligible self must receive only own entitlement';
END $$;
RESET ROLE;
\echo PASS TS01 default-disabled flag and eligible-self projection
CREATE FUNCTION pg_temp.trade_import(person uuid,linked uuid,label text DEFAULT 'trade school',treatment text DEFAULT NULL)
RETURNS uuid LANGUAGE plpgsql AS $$ DECLARE r uuid; day date:=current_date+(8-extract(isodow from current_date)::integer)%7; BEGIN
  INSERT INTO public.leave_requests(employee_person_id,user_id,record_origin,source_record_sha256,status,submitted_at,
    leave_type,request_type_label,pay_treatment,start_date,end_date,business_days)
  VALUES(person,linked,'historical_import',repeat('a',64),'submitted',now(),'personal',label,treatment,day,day,1) RETURNING id INTO r;
  RETURN r;
END $$;
SELECT pg_temp.set_test_actor('d1000000-0000-4000-8000-000000000001');
INSERT INTO private.leave_approval_grants(reviewer_user_id,scope_kind,reviewer_label,priority)
VALUES('d1000000-0000-4000-8000-000000000001','global','Synthetic Trade Admin',100);
INSERT INTO private.manager_leave_reviewers VALUES('d1000000-0000-4000-8000-000000000001',1) ON CONFLICT DO NOTHING;
SELECT pg_temp.set_test_actor('d1000000-0000-4000-8000-000000000002');
SET LOCAL ROLE authenticated;
DO $$ DECLARE r uuid; day date:=current_date+(8-extract(isodow from current_date)::integer)%7; BEGIN
  SELECT id INTO r FROM public.submit_my_leave_request('trade school',day,day);
  ASSERT (SELECT status='submitted' AND approval_required AND request_type_label='trade school' AND leave_type='other' AND pay_treatment='paid_other' FROM public.leave_requests WHERE id=r), 'Trade-school self submission must be pending paid-other leave';
END $$;
RESET ROLE;
DO $$ BEGIN
  ASSERT (SELECT count(*)=1 FROM public.leave_requests WHERE employee_person_id='d1000000-0000-4000-8000-000000000002');
  ASSERT (SELECT count(*)=2 FROM public.leave_request_events WHERE actor_user_id='d1000000-0000-4000-8000-000000000002');
  ASSERT EXISTS(SELECT 1 FROM private.leave_request_reviewer_assignments a JOIN public.leave_requests r ON r.id=a.leave_request_id WHERE r.employee_person_id='d1000000-0000-4000-8000-000000000002');
  ASSERT NOT EXISTS(SELECT 1 FROM private.leave_balance_approvals a JOIN public.leave_requests r ON r.id=a.request_id WHERE r.request_type_label='trade school');
  ASSERT (SELECT count(*)=1 AND bool_and(schema_hash=private.confirmed_test_purge_schema_hash()) FROM private.confirmed_test_purge_schema);
END $$;
\echo PASS TS02 paid-other self submission retains approval audit and no notice or balance workflow
DO $$ DECLARE actor uuid; r uuid; day date:=current_date+(8-extract(isodow from current_date)::integer)%7; BEGIN
  FOR actor IN SELECT ('d1000000-0000-4000-8000-00000000000'||n)::uuid FROM unnest(ARRAY[1,3,5]) n LOOP
    PERFORM pg_temp.set_test_actor(actor);
    EXECUTE 'set local role authenticated';
    SELECT id INTO r FROM public.submit_selected_employee_leave_request('d1000000-0000-4000-8000-000000000002','trade school',day,day,time '09:00',time '10:00');
    EXECUTE 'reset role';
    ASSERT (SELECT user_id='d1000000-0000-4000-8000-000000000002' AND employee_person_id='d1000000-0000-4000-8000-000000000002' AND status='submitted' AND approval_required AND pay_treatment='paid_other' AND leave_type='other' AND hours=1 FROM public.leave_requests WHERE id=r);
    ASSERT (SELECT count(*)=2 FROM public.leave_request_events WHERE leave_request_id=r AND actor_user_id=actor);
  END LOOP;
END $$;
\echo PASS TS03 authorized Manager Admin and P0 selected submissions preserve employee and actor
DO $$ DECLARE r uuid; BEGIN
  SELECT id INTO r FROM public.leave_requests WHERE request_type_label='trade school' ORDER BY id LIMIT 1;
  BEGIN
    UPDATE public.leave_requests SET employee_person_id='d1000000-0000-4000-8000-000000000006',user_id='d1000000-0000-4000-8000-000000000006' WHERE id=r;
    RAISE EXCEPTION 'TS04: UPDATE bypassed trade-school entitlement' USING ERRCODE='ZX001';
  EXCEPTION WHEN insufficient_privilege THEN ASSERT SQLERRM='Trade-school leave is not enabled for this employee.'; END;
  ASSERT (SELECT employee_person_id='d1000000-0000-4000-8000-000000000002' FROM public.leave_requests WHERE id=r);
  BEGIN
    UPDATE public.leave_requests SET request_type_label='Other leave',pay_treatment='paid_entitlement' WHERE id=r;
    RAISE EXCEPTION 'TS04: trade-school request was reclassified as ordinary entitlement' USING ERRCODE='ZX001';
  EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
  UPDATE public.leave_requests SET leave_type='personal',pay_treatment='paid_entitlement' WHERE id=r;
  ASSERT (SELECT leave_type='other' AND pay_treatment='paid_other' FROM public.leave_requests WHERE id=r);
END $$;
\echo PASS TS04 update target denial transformed-label denial and paid-other canonicalization
DO $$ DECLARE actor uuid; scope uuid[]; BEGIN
  FOR actor IN SELECT ('d1000000-0000-4000-8000-00000000000'||n)::uuid FROM unnest(ARRAY[1,3,5]) n LOOP
    PERFORM pg_temp.set_test_actor(actor);
    EXECUTE 'set local role authenticated';
    SELECT array_agg(person_id) INTO scope FROM public.list_trade_school_leave_entitlements();
    EXECUTE 'reset role';
    ASSERT scope=ARRAY['d1000000-0000-4000-8000-000000000002'::uuid], 'Authorized selected scope differs';
  END LOOP;
  PERFORM pg_temp.set_test_actor('d1000000-0000-4000-8000-000000000001');
  EXECUTE 'set local role authenticated';
  ASSERT NOT EXISTS(SELECT 1 FROM public.list_trade_school_leave_entitlements('d1000000-0000-4000-8000-000000000006')), 'P0 preview leaked actor-wide eligibility';
  ASSERT (SELECT array_agg(person_id) FROM public.list_trade_school_leave_entitlements('d1000000-0000-4000-8000-000000000002'))=ARRAY['d1000000-0000-4000-8000-000000000002'::uuid];
  ASSERT (SELECT array_agg(person_id) FROM public.list_trade_school_leave_entitlements('d1000000-0000-4000-8000-000000000003'))=ARRAY['d1000000-0000-4000-8000-000000000002'::uuid];
  EXECUTE 'reset role';
  PERFORM pg_temp.set_test_actor('d1000000-0000-4000-8000-000000000006');
  EXECUTE 'set local role authenticated';
  ASSERT NOT EXISTS(SELECT 1 FROM public.list_trade_school_leave_entitlements());
  BEGIN
    PERFORM public.list_trade_school_leave_entitlements('d1000000-0000-4000-8000-000000000002');
    RAISE EXCEPTION 'TS05: Employee obtained privileged profile preview' USING ERRCODE='ZX001';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  EXECUTE 'reset role';
END $$;
\echo PASS TS05 scoped current and preview projections preserve canonical role boundaries
DO $$ DECLARE r uuid; day date:=current_date+(8-extract(isodow from current_date)::integer)%7; BEGIN
  BEGIN
    PERFORM pg_temp.trade_import('d1000000-0000-4000-8000-000000000006',NULL);
    RAISE EXCEPTION 'TS06: historical import bypassed entitlement' USING ERRCODE='ZX001';
  EXCEPTION WHEN insufficient_privilege THEN ASSERT SQLERRM='Trade-school leave is not enabled for this employee.'; END;
  BEGIN
    PERFORM pg_temp.trade_import('d1000000-0000-4000-8000-000000000002','d1000000-0000-4000-8000-000000000006');
    RAISE EXCEPTION 'TS06: mismatched login accepted' USING ERRCODE='ZX001';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN
    INSERT INTO public.leave_requests(employee_person_id,user_id,status,submitted_at,leave_type,request_type_label,start_date,end_date,business_days)
    VALUES('d1000000-0000-4000-8000-000000000006','d1000000-0000-4000-8000-000000000002','submitted',now(),'other','trade school',day,day,1);
    RAISE EXCEPTION 'TS06: INSERT silently repaired forged employee identity' USING ERRCODE='ZX001';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN
    PERFORM pg_temp.trade_import('d1000000-0000-4000-8000-000000000002',NULL,'Other leave','paid_other');
    RAISE EXCEPTION 'TS06: ordinary historical leave retained paid_other' USING ERRCODE='ZX001';
  EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
  r:=pg_temp.trade_import('d1000000-0000-4000-8000-000000000002',NULL,'trade school','paid_entitlement');
  ASSERT (SELECT leave_type='other' AND pay_treatment='paid_other' FROM public.leave_requests WHERE id=r);
  PERFORM pg_temp.set_test_actor('d1000000-0000-4000-8000-000000000006');
  EXECUTE 'set local role authenticated';
  BEGIN
    PERFORM public.submit_my_leave_request('trade school',day,day);
    RAISE EXCEPTION 'TS06: unentitled self accepted' USING ERRCODE='ZX001';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN
    PERFORM public.submit_selected_employee_leave_request('d1000000-0000-4000-8000-000000000002','trade school',day,day);
    RAISE EXCEPTION 'TS06: Employee obtained delegated submission' USING ERRCODE='ZX001';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  EXECUTE 'reset role';
  PERFORM pg_temp.set_test_actor('d1000000-0000-4000-8000-000000000004');
  EXECUTE 'set local role authenticated';
  BEGIN
    PERFORM public.submit_selected_employee_leave_request('d1000000-0000-4000-8000-000000000002','trade school',day,day);
    RAISE EXCEPTION 'TS06: Account obtained delegated submission' USING ERRCODE='ZX001';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  EXECUTE 'reset role';
END $$;
SET LOCAL ROLE service_role;
DO $$ DECLARE day date:=current_date+(8-extract(isodow from current_date)::integer)%7; BEGIN
  BEGIN
    INSERT INTO public.leave_requests(employee_person_id,user_id,status,submitted_at,leave_type,request_type_label,start_date,end_date,business_days)
    VALUES('d1000000-0000-4000-8000-000000000006','d1000000-0000-4000-8000-000000000006','submitted',now(),'other','trade school',day,day,1);
    RAISE EXCEPTION 'TS06: service-role INSERT bypassed entitlement' USING ERRCODE='ZX001';
  EXCEPTION WHEN insufficient_privilege THEN ASSERT SQLERRM='Trade-school leave is not enabled for this employee.'; END;
  BEGIN
    UPDATE public.leave_requests SET employee_person_id='d1000000-0000-4000-8000-000000000006',user_id='d1000000-0000-4000-8000-000000000006' WHERE request_type_label='trade school';
    RAISE EXCEPTION 'TS06: service-role UPDATE bypassed entitlement' USING ERRCODE='ZX001';
  EXCEPTION WHEN insufficient_privilege THEN ASSERT SQLERRM='Trade-school leave is not enabled for this employee.'; END;
END $$;
RESET ROLE;
\echo PASS TS06 direct historical authenticated and service-role sources cannot bypass eligibility or identity
SAVEPOINT revoke_flag;
UPDATE private.employee_directory_details SET trade_school_enabled=false WHERE person_id='d1000000-0000-4000-8000-000000000002';
SELECT pg_temp.set_test_actor('d1000000-0000-4000-8000-000000000002');
SET LOCAL ROLE authenticated;
DO $$ DECLARE day date:=current_date+(8-extract(isodow from current_date)::integer)%7; BEGIN
  ASSERT NOT EXISTS(SELECT 1 FROM public.list_trade_school_leave_entitlements());
  BEGIN
    PERFORM public.submit_my_leave_request('trade school',day,day);
    RAISE EXCEPTION 'TS07: revoked self submitted' USING ERRCODE='ZX001';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END $$;
RESET ROLE;
DO $$ DECLARE r uuid; mutation text; BEGIN
  SELECT id INTO STRICT r FROM public.leave_requests WHERE request_type_label='trade school' AND record_origin='portal' ORDER BY id LIMIT 1;
  UPDATE public.leave_requests SET reason='Synthetic revised note',manager_note='Synthetic routing note',manager_name_snapshot='Synthetic retained reviewer' WHERE id=r;
  ASSERT (SELECT reason='Synthetic revised note' AND manager_note='Synthetic routing note' AND leave_type='other' AND pay_treatment='paid_other' FROM public.leave_requests WHERE id=r);
  FOR mutation IN SELECT unnest(ARRAY[
    'start_date=start_date+1','end_date=end_date+1','start_time=time ''11:00''','end_time=time ''12:00''',
    'hours=coalesce(hours,0)+2','business_days=business_days+1','employment_type_snapshot=''part_time''','record_origin=''historical_import''',
    'employee_person_id=''d1000000-0000-4000-8000-000000000006'',user_id=''d1000000-0000-4000-8000-000000000006''',
    'leave_type=''personal''','pay_treatment=''paid_entitlement'''
  ]) LOOP
    BEGIN
      EXECUTE 'update public.leave_requests set '||mutation||' where id='||quote_literal(r);
      RAISE EXCEPTION 'TS07: revoked economic or identity edit accepted: %',mutation USING ERRCODE='ZX001';
    EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  END LOOP;
  BEGIN
    UPDATE public.leave_requests SET request_type_label='Other leave',pay_treatment='paid_entitlement' WHERE id=r;
    RAISE EXCEPTION 'TS07: revoked request reclassified' USING ERRCODE='ZX001';
  EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
  PERFORM pg_temp.set_test_actor('d1000000-0000-4000-8000-000000000005');
  EXECUTE 'set local role authenticated';
  PERFORM public.decide_leave_with_balance(r,'Approved','Synthetic post-revocation decision');
  EXECUTE 'reset role';
  ASSERT (SELECT status='approved' AND pay_treatment='paid_other' FROM public.leave_requests WHERE id=r);
  PERFORM pg_temp.set_test_actor('d1000000-0000-4000-8000-000000000002');
  EXECUTE 'set local role authenticated';
  PERFORM public.cancel_my_approved_leave_request(r);
  EXECUTE 'reset role';
  ASSERT (SELECT status='cancelled' AND leave_type='other' AND pay_treatment='paid_other' FROM public.leave_requests WHERE id=r);
END $$;
ROLLBACK TO revoke_flag;
DO $$ DECLARE mutation text; r uuid; BEGIN
 SELECT id INTO STRICT r FROM public.leave_requests WHERE request_type_label='trade school' AND record_origin='portal' ORDER BY id LIMIT 1;
 FOR mutation IN SELECT unnest(ARRAY[
   'update public.internal_org_people set is_active=false where id=''d1000000-0000-4000-8000-000000000002''',
   'update public.profiles set account_status=''disabled'',disabled_at=now() where id=''d1000000-0000-4000-8000-000000000002''',
   'update private.employee_directory_details set employment_type=''casual'' where person_id=''d1000000-0000-4000-8000-000000000002''',
   'update public.internal_org_people set auth_user_id=null where id=''d1000000-0000-4000-8000-000000000002'''
 ]) LOOP
  BEGIN
   PERFORM pg_temp.set_test_actor('d1000000-0000-4000-8000-000000000001');
   EXECUTE mutation;
   ASSERT NOT EXISTS(SELECT 1 FROM public.list_trade_school_leave_entitlements());
   ASSERT EXISTS(SELECT 1 FROM public.leave_requests WHERE id=r AND request_type_label='trade school' AND pay_treatment='paid_other');
   UPDATE public.leave_requests SET manager_note='Synthetic deactivated routing',status='cancelled' WHERE id=r;
   ASSERT (SELECT status='cancelled' AND manager_note='Synthetic deactivated routing' AND leave_type='other' AND pay_treatment='paid_other' FROM public.leave_requests WHERE id=r);
   BEGIN
    UPDATE public.leave_requests SET hours=2 WHERE id=r;
    RAISE EXCEPTION 'TS07: inactive economic edit accepted' USING ERRCODE='ZX001';
   EXCEPTION WHEN insufficient_privilege THEN NULL; END;
   BEGIN
    PERFORM pg_temp.trade_import('d1000000-0000-4000-8000-000000000002',NULL);
    RAISE EXCEPTION 'TS07: inactive unpaid or unlinked identity accepted' USING ERRCODE='ZX001';
   EXCEPTION WHEN insufficient_privilege THEN NULL; END;
   RAISE EXCEPTION 'rollback synthetic eligibility mutation' USING ERRCODE='ZX002';
  EXCEPTION WHEN SQLSTATE 'ZX002' THEN NULL; END;
 END LOOP;
END $$;
\echo PASS TS07 revoked and disabled existing requests retain lifecycle only; new and economic identity edits fail closed
DO $$ BEGIN
  ASSERT has_function_privilege('authenticated','public.list_trade_school_leave_entitlements(uuid)','EXECUTE');
  ASSERT NOT has_function_privilege('anon','public.list_trade_school_leave_entitlements(uuid)','EXECUTE');
  ASSERT NOT has_function_privilege('service_role','public.list_trade_school_leave_entitlements(uuid)','EXECUTE');
  ASSERT NOT has_function_privilege('authenticated','private.enforce_trade_school_leave()','EXECUTE');
  ASSERT NOT has_function_privilege('service_role','private.enforce_trade_school_leave()','EXECUTE');
  ASSERT NOT has_column_privilege('authenticated','private.employee_directory_details','trade_school_enabled','SELECT');
  ASSERT NOT has_column_privilege('authenticated','private.employee_directory_details','trade_school_enabled','UPDATE');
END $$;
\echo PASS TS08 entitlement ACL and private flag protections
SELECT pg_temp.set_test_actor('d1000000-0000-4000-8000-000000000001');
INSERT INTO private.employee_annual_leave_balances(person_id,hours,as_of,is_example,updated_by)
VALUES('d1000000-0000-4000-8000-000000000002',0,current_date,false,'d1000000-0000-4000-8000-000000000001');
INSERT INTO private.employee_sick_leave_balances(person_id,hours,as_of,updated_by)
VALUES('d1000000-0000-4000-8000-000000000002',0,current_date,'d1000000-0000-4000-8000-000000000001');
CREATE FUNCTION pg_temp.trade_balance_state() RETURNS jsonb LANGUAGE sql AS $$
 SELECT jsonb_build_object(
 'annual',(SELECT jsonb_agg(to_jsonb(b) ORDER BY person_id) FROM private.employee_annual_leave_balances b),
 'personal',(SELECT jsonb_agg(to_jsonb(b) ORDER BY person_id) FROM private.employee_sick_leave_balances b),
 'annualHistory',(SELECT coalesce(jsonb_agg(to_jsonb(b) ORDER BY id),'[]') FROM private.annual_leave_balance_history b),
 'personalHistory',(SELECT coalesce(jsonb_agg(to_jsonb(b) ORDER BY id),'[]') FROM private.sick_leave_balance_history b));
$$;
CREATE TEMPORARY TABLE trade_balances_before AS SELECT pg_temp.trade_balance_state() value;
DO $$ DECLARE r uuid; BEGIN
 SELECT id INTO r FROM public.leave_requests WHERE request_type_label='trade school' AND record_origin='portal' ORDER BY id LIMIT 1;
 PERFORM pg_temp.set_test_actor('d1000000-0000-4000-8000-000000000002');
 EXECUTE 'set local role authenticated';
 BEGIN
  PERFORM public.decide_leave_with_balance(r,'Approved',NULL);
  RAISE EXCEPTION 'TS09: employee self-approved trade-school leave' USING ERRCODE='ZX001';
 EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 EXECUTE 'reset role';
 PERFORM pg_temp.set_test_actor('d1000000-0000-4000-8000-000000000005');
 EXECUTE 'set local role authenticated';
 PERFORM public.decide_leave_with_balance(r,'Approved',NULL);
 EXECUTE 'reset role';
 ASSERT (SELECT status='approved' AND pay_treatment='paid_other' FROM public.leave_requests WHERE id=r);
 ASSERT pg_temp.trade_balance_state()=(SELECT value FROM trade_balances_before);
 ASSERT private.approved_leave_hours_after('d1000000-0000-4000-8000-000000000002',ARRAY['Annual leave'],current_date-1)=0;
 ASSERT private.approved_leave_hours_after('d1000000-0000-4000-8000-000000000002',ARRAY['Sick leave','Carer''s leave'],current_date-1)=0;
 PERFORM pg_temp.set_test_actor('d1000000-0000-4000-8000-000000000002');
 EXECUTE 'set local role authenticated';
 PERFORM public.cancel_my_approved_leave_request(r);
 EXECUTE 'reset role';
 ASSERT (SELECT status='cancelled' AND pay_treatment='paid_other' FROM public.leave_requests WHERE id=r);
 ASSERT pg_temp.trade_balance_state()=(SELECT value FROM trade_balances_before);
 ASSERT NOT EXISTS(SELECT 1 FROM private.leave_balance_approvals WHERE request_id=r);
END $$;
\echo PASS TS09 approval cancellation and zero annual or sick debit
SELECT pg_temp.set_test_actor('d1000000-0000-4000-8000-000000000002');
SET LOCAL ROLE authenticated;
DO $$ DECLARE label text; r uuid; day date:=current_date+(8-extract(isodow from current_date)::integer)%7; BEGIN
 FOR label IN SELECT unnest(ARRAY['Sick leave','Carer''s leave']) LOOP
  SELECT id INTO r FROM public.submit_my_leave_request(label,day,day);
  ASSERT (SELECT leave_type='personal' AND pay_treatment='paid_entitlement' FROM public.leave_requests WHERE id=r);
 END LOOP;
 BEGIN
  PERFORM public.submit_my_leave_request('Unpaid leave',day,day);
  RAISE EXCEPTION 'TS10: unpaid self lost 14-day notice rule' USING ERRCODE='ZX001';
 EXCEPTION WHEN invalid_parameter_value THEN ASSERT SQLERRM LIKE '%14 days%'; END;
 BEGIN
  PERFORM public.submit_my_leave_request('Trade School',day,day);
  RAISE EXCEPTION 'TS10: non-exact trade-school label accepted' USING ERRCODE='ZX001';
 EXCEPTION WHEN invalid_parameter_value THEN ASSERT SQLERRM='Choose a valid leave type.'; END;
END $$;
RESET ROLE;
SELECT pg_temp.set_test_actor('d1000000-0000-4000-8000-000000000003');
SET LOCAL ROLE authenticated;
DO $$ DECLARE r uuid; day date:=current_date+(8-extract(isodow from current_date)::integer)%7; BEGIN
 SELECT id INTO r FROM public.submit_selected_employee_leave_request('d1000000-0000-4000-8000-000000000002','Unpaid leave',day,day);
 ASSERT (SELECT leave_type='unpaid' AND pay_treatment='unpaid' FROM public.leave_requests WHERE id=r);
END $$;
RESET ROLE;
\echo PASS TS10 ordinary categories and notice exemptions remain unchanged
INSERT INTO private.employee_directory_audit_events(person_id,actor_user_id,event_type,changed_fields)
VALUES('d1000000-0000-4000-8000-000000000002','d1000000-0000-4000-8000-000000000001','updated',ARRAY['trade_school_enabled']);
\echo PASS TS11 explicit eligibility field can be recorded in the existing private audit
ROLLBACK;
