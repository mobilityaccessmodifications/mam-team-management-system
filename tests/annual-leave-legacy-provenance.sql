\set ON_ERROR_STOP on
DO $$ BEGIN ASSERT current_database() ~ '^mam_test_annual_'; ASSERT inet_server_addr() IS NULL; END $$;
BEGIN;
\ir payroll-closing-setup.sql
UPDATE public.leave_requests SET employment_type_snapshot=NULL WHERE id='96000000-0000-4000-8000-000000000012';
DO $$ BEGIN
  ASSERT (SELECT employment_type_snapshot IS NULL AND hours IS NULL FROM public.leave_requests
    WHERE id='96000000-0000-4000-8000-000000000012'), 'UPDATE must preserve missing legacy duration provenance';
END $$;
\echo PASS P01 UPDATE preserves missing legacy duration provenance
SAVEPOINT conditional_cache;
INSERT INTO private.leave_balance_approvals(request_id,approved_by,required_hours)
VALUES('96000000-0000-4000-8000-000000000012','96000000-0000-4000-8000-000000000001',15.2);
SAVEPOINT candidate_budget;
UPDATE private.leave_accrual_policies SET enabled=false WHERE person_id='96000000-0000-4000-8000-000000000002';
UPDATE private.employee_annual_leave_balances SET hours=15.1 WHERE person_id='96000000-0000-4000-8000-000000000002';
DO $$ DECLARE bank_hours numeric; basis jsonb; BEGIN
  basis:=private.leave_bank_basis('96000000-0000-4000-8000-000000000002','annual');
  ASSERT basis->>'reportDate'='2026-09-01' AND basis->>'coveredThrough' IS NULL,
    'The imported report does not confirm coverage of the original leave';
  ASSERT (now() AT TIME ZONE 'Australia/Melbourne')::date>date '2026-09-25',
    'The original approved leave is completed';
  FOREACH bank_hours IN ARRAY ARRAY[15.1,15.2,30.3] LOOP
    UPDATE private.employee_annual_leave_balances SET hours=bank_hours WHERE person_id='96000000-0000-4000-8000-000000000002';
    BEGIN
      UPDATE public.leave_requests SET start_date='2026-10-05',end_date='2026-10-06'
        WHERE id='96000000-0000-4000-8000-000000000012';
      RAISE EXCEPTION 'Missing snapshot understated candidate hours or refunded completed usage' USING ERRCODE='ZX001';
    EXCEPTION WHEN invalid_parameter_value THEN
      ASSERT SQLERRM LIKE ANY(array['Not enough balance.%','Future accrual could not be confirmed%']);
    END;
    ASSERT (SELECT start_date='2026-09-24' AND end_date='2026-09-25' AND employment_type_snapshot IS NULL
      FROM public.leave_requests WHERE id='96000000-0000-4000-8000-000000000012');
    ASSERT (SELECT required_hours=15.2 FROM private.leave_balance_approvals WHERE request_id='96000000-0000-4000-8000-000000000012');
  END LOOP;
  UPDATE private.employee_annual_leave_balances SET hours=30.4 WHERE person_id='96000000-0000-4000-8000-000000000002';
  UPDATE public.leave_requests SET start_date='2026-10-05',end_date='2026-10-06'
    WHERE id='96000000-0000-4000-8000-000000000012';
  ASSERT (SELECT employment_type_snapshot IS NULL AND hours IS NULL FROM public.leave_requests WHERE id='96000000-0000-4000-8000-000000000012');
  ASSERT (SELECT required_hours=15.2 FROM private.leave_balance_approvals WHERE request_id='96000000-0000-4000-8000-000000000012');
  UPDATE public.leave_requests SET business_days=1,end_date='2026-10-05' WHERE id='96000000-0000-4000-8000-000000000012';
  ASSERT (SELECT employment_type_snapshot IS NULL AND hours IS NULL FROM public.leave_requests WHERE id='96000000-0000-4000-8000-000000000012');
  ASSERT (SELECT required_hours=7.6 FROM private.leave_balance_approvals WHERE request_id='96000000-0000-4000-8000-000000000012');
  BEGIN
    UPDATE private.leave_balance_approvals SET required_hours=7.5 WHERE request_id='96000000-0000-4000-8000-000000000012';
    RAISE EXCEPTION 'Legacy conditional cache accepted understated hours' USING ERRCODE='ZX001';
  EXCEPTION WHEN invalid_parameter_value THEN ASSERT SQLERRM LIKE 'Paid hours are calculated automatically%'; END;
END $$;
\echo PASS P02 missing snapshot uses full-time candidate budget and refreshes exact conditional cache
ROLLBACK TO candidate_budget;
DO $$ BEGIN
  BEGIN
    UPDATE private.employee_directory_details SET employment_type='part_time' WHERE person_id='96000000-0000-4000-8000-000000000002';
    RAISE EXCEPTION 'Untracked legacy classification changed' USING ERRCODE='ZX001';
  EXCEPTION WHEN object_not_in_prerequisite_state THEN ASSERT SQLERRM LIKE 'Legacy annual leave hours require review%'; END;
  ASSERT (SELECT employment_type='full_time' FROM private.employee_directory_details WHERE person_id='96000000-0000-4000-8000-000000000002');
  ASSERT (SELECT required_hours=15.2 FROM private.leave_balance_approvals WHERE request_id='96000000-0000-4000-8000-000000000012');
END $$;
\echo PASS P03 untracked legacy classification remains protected
SAVEPOINT declining_obligation;
UPDATE private.employee_annual_leave_balances SET hours=0 WHERE person_id='96000000-0000-4000-8000-000000000002';
DO $$ DECLARE fingerprint text; BEGIN
  SELECT private.payroll_request_fingerprint(to_jsonb(r)) INTO fingerprint FROM public.leave_requests r WHERE id='96000000-0000-4000-8000-000000000012';
  UPDATE public.leave_requests SET manager_note='Synthetic legacy metadata' WHERE id='96000000-0000-4000-8000-000000000012';
  ASSERT (SELECT private.payroll_request_fingerprint(to_jsonb(r))=fingerprint FROM public.leave_requests r WHERE id='96000000-0000-4000-8000-000000000012');
  UPDATE public.leave_requests SET status='cancelled' WHERE id='96000000-0000-4000-8000-000000000012';
  ASSERT (SELECT employment_type_snapshot IS NULL AND hours IS NULL AND status='cancelled' FROM public.leave_requests WHERE id='96000000-0000-4000-8000-000000000012');
  ASSERT (SELECT required_hours=15.2 FROM private.leave_balance_approvals WHERE request_id='96000000-0000-4000-8000-000000000012');
  ASSERT (SELECT hours=0 FROM private.employee_annual_leave_balances WHERE person_id='96000000-0000-4000-8000-000000000002');
END $$;
ROLLBACK TO declining_obligation;
UPDATE private.employee_annual_leave_balances SET hours=0 WHERE person_id='96000000-0000-4000-8000-000000000002';
UPDATE public.leave_requests SET status='rejected' WHERE id='96000000-0000-4000-8000-000000000012';
DO $$ BEGIN
  ASSERT (SELECT employment_type_snapshot IS NULL AND hours IS NULL AND status='rejected' FROM public.leave_requests WHERE id='96000000-0000-4000-8000-000000000012');
  ASSERT (SELECT required_hours=15.2 FROM private.leave_balance_approvals WHERE request_id='96000000-0000-4000-8000-000000000012');
  ASSERT (SELECT hours=0 FROM private.employee_annual_leave_balances WHERE person_id='96000000-0000-4000-8000-000000000002');
END $$;
\echo PASS P04 metadata cancellation rejection do not guess provenance or refund balances
ROLLBACK TO conditional_cache;
SELECT public.reconcile_payroll_closing('synthetic-legacy-provenance',pg_temp.closing_payload());
DO $$ DECLARE before_event jsonb; before_bank jsonb; fingerprint text; BEGIN
  SELECT to_jsonb(e),e.request_fingerprint INTO before_event,fingerprint FROM private.payroll_carryforward_events e
    WHERE request_id='96000000-0000-4000-8000-000000000012' ORDER BY id DESC LIMIT 1;
  SELECT to_jsonb(b) INTO before_bank FROM private.employee_annual_leave_balances b WHERE person_id='96000000-0000-4000-8000-000000000002';
  ASSERT (SELECT employment_type_snapshot IS NULL AND hours IS NULL AND private.payroll_request_fingerprint(to_jsonb(r))=fingerprint
    FROM public.leave_requests r WHERE id='96000000-0000-4000-8000-000000000012');
  ASSERT private.approved_leave_hours_after('96000000-0000-4000-8000-000000000002',array['Annual leave'],'2026-09-24')=15.2;
  UPDATE private.employee_directory_details SET employment_type='part_time' WHERE person_id='96000000-0000-4000-8000-000000000002';
  ASSERT (SELECT employment_type_snapshot IS NULL AND hours IS NULL AND private.payroll_request_fingerprint(to_jsonb(r))<>fingerprint
    FROM public.leave_requests r WHERE id='96000000-0000-4000-8000-000000000012');
  ASSERT private.approved_leave_hours_after('96000000-0000-4000-8000-000000000002',array['Annual leave'],'2026-09-24') IS NULL,
    'Tracked legacy classification drift must remain unknown';
  ASSERT private.project_annual_leave_balance('96000000-0000-4000-8000-000000000002','2026-09-25')->>'status'='unavailable';
  ASSERT NOT coalesce(private.leave_payroll_balance_sufficient('96000000-0000-4000-8000-000000000012'),false);
  ASSERT (SELECT to_jsonb(e)=before_event FROM private.payroll_carryforward_events e
    WHERE request_id='96000000-0000-4000-8000-000000000012' ORDER BY id DESC LIMIT 1);
  ASSERT (SELECT to_jsonb(b)=before_bank FROM private.employee_annual_leave_balances b WHERE person_id='96000000-0000-4000-8000-000000000002');
  UPDATE public.leave_requests SET manager_note='Synthetic drift metadata' WHERE id='96000000-0000-4000-8000-000000000012';
  ASSERT (SELECT employment_type_snapshot IS NULL AND hours IS NULL FROM public.leave_requests WHERE id='96000000-0000-4000-8000-000000000012');
  ASSERT NOT EXISTS(SELECT 1 FROM private.leave_balance_approvals WHERE request_id='96000000-0000-4000-8000-000000000012');
  BEGIN
    UPDATE public.leave_requests SET status='cancelled' WHERE id='96000000-0000-4000-8000-000000000012';
    RAISE EXCEPTION 'Drifted payroll allocation was cancelled silently' USING ERRCODE='ZX001';
  EXCEPTION WHEN object_not_in_prerequisite_state THEN ASSERT SQLERRM LIKE 'A reconciled request cannot change%'; END;
  ASSERT (SELECT status='approved' FROM public.leave_requests WHERE id='96000000-0000-4000-8000-000000000012');
END $$;
\echo PASS P05 reconciled legacy classification drift fails closed without guessed snapshot cache or balance writes
ROLLBACK;
