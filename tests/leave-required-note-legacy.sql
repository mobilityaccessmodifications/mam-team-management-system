\set ON_ERROR_STOP on
BEGIN;
\ir sql-test-auth.sql
DO $$ BEGIN
 ASSERT (SELECT reason IS NULL AND record_origin='portal' FROM public.leave_requests WHERE employee_person_id='e6000000-0000-4000-8000-000000000002'), 'Migration must not backfill legacy portal notes';
END $$;
SELECT pg_temp.set_test_actor('e6000000-0000-4000-8000-000000000002');
SET LOCAL ROLE authenticated;
DO $$ DECLARE replay uuid; BEGIN
 SELECT id INTO replay FROM public.submit_leave_request_once('e6000000-0000-4000-8000-000000000004',NULL,'Sick leave','2030-10-14','2030-10-14');
 ASSERT replay IS NOT NULL;
 BEGIN
  PERFORM public.submit_leave_request_once('e6000000-0000-4000-8000-000000000004',NULL,'Sick leave','2030-10-14','2030-10-14',NULL,NULL,'Invented replacement');
  RAISE EXCEPTION 'RN05: legacy receipt accepted changed note' USING ERRCODE='ZX001';
 EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
END $$;
RESET ROLE;
DO $$ DECLARE r uuid; BEGIN
 SELECT id INTO STRICT r FROM public.leave_requests WHERE employee_person_id='e6000000-0000-4000-8000-000000000002';
 ASSERT (SELECT count(*)=1 FROM private.leave_submission_receipts WHERE actor_user_id='e6000000-0000-4000-8000-000000000002');
 PERFORM private.reroute_pending_leave_requests_to_current_manager();
 ASSERT (SELECT reason IS NULL AND status='submitted' FROM public.leave_requests WHERE id=r);
 PERFORM pg_temp.set_test_actor('e6000000-0000-4000-8000-000000000003');
 EXECUTE 'set local role authenticated';
 PERFORM public.decide_leave_with_balance(r,'Approved',NULL);
 EXECUTE 'reset role';
 ASSERT (SELECT reason IS NULL AND status='approved' FROM public.leave_requests WHERE id=r);
 PERFORM pg_temp.set_test_actor('e6000000-0000-4000-8000-000000000002');
 EXECUTE 'set local role authenticated';
 PERFORM public.cancel_my_approved_leave_request(r);
 EXECUTE 'reset role';
 ASSERT (SELECT reason IS NULL AND status='cancelled' FROM public.leave_requests WHERE id=r);
 INSERT INTO public.leave_requests(employee_person_id,user_id,record_origin,source_record_sha256,status,submitted_at,leave_type,request_type_label,start_date,end_date,business_days)
 VALUES('e6000000-0000-4000-8000-000000000002','e6000000-0000-4000-8000-000000000002','historical_import',repeat('e',64),'submitted',now(),'personal','Sick leave','2026-10-12','2026-10-12',1);
 ASSERT (SELECT reason IS NULL AND record_origin='historical_import' AND source_record_sha256=repeat('e',64) FROM public.leave_requests WHERE source_record_sha256=repeat('e',64));
END $$;
\echo PASS RN05 existing blank portal receipt replay reroute approval cancellation and historical provenance remain safe
ROLLBACK;
