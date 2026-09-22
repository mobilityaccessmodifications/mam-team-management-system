\set ON_ERROR_STOP on
do $$begin assert current_database() = 'automatic_leave_hours_test', 'Disposable database only'; end$$;

begin;

do $$
declare
  decision record;
begin
  assert (select required_hours = 7.6 from private.leave_balance_approvals where request_id = '20000000-0000-4000-8000-000000000001'),
    'Full-time full-day legacy approval is backfilled to 7.6 hours';
  assert (select required_hours = 3.25 from private.leave_balance_approvals where request_id = '20000000-0000-4000-8000-000000000002'),
    'Explicit part-day hours remain authoritative';
  assert (select required_hours = 15 from private.leave_balance_approvals where request_id = '20000000-0000-4000-8000-000000000003'),
    'Non-full-time full days retain the established 7.5-hour rule';
  assert (select required_hours = 7.6 from private.leave_balance_approvals where request_id = '20000000-0000-4000-8000-000000000004'),
    'A legacy request without a snapshot falls back to the current classification';
  assert not exists(select 1 from private.leave_balance_approvals where required_hours is null),
    'Every conditional approval has system-calculated hours';
  assert (select is_nullable = 'NO' from information_schema.columns where table_schema = 'private' and table_name = 'leave_balance_approvals' and column_name = 'required_hours'),
    'The required-hours invariant is enforced by the schema';

  perform set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000001', true);
  perform set_config('request.jwt.claims', '{"sub":"10000000-0000-4000-8000-000000000001","is_anonymous":false}', true);

  select * into decision
  from public.decide_leave_with_balance(
    '20000000-0000-4000-8000-000000000005',
    'Approved – pending leave balance',
    null
  );
  assert decision.status = 'Approved – pending leave balance';
  assert (select required_hours = 7.6 from private.leave_balance_approvals where request_id = '20000000-0000-4000-8000-000000000005'),
    'A new conditional approval snapshots calculated hours atomically';

  -- The older deployed decision body omitted hours; the insert trigger makes
  -- an already-running old invocation safe across the migration boundary.
  delete from private.leave_balance_approvals where request_id = '20000000-0000-4000-8000-000000000005';
  insert into private.leave_balance_approvals(request_id, approved_by)
  values('20000000-0000-4000-8000-000000000005', '10000000-0000-4000-8000-000000000001');
  assert (select required_hours = 7.6 from private.leave_balance_approvals where request_id = '20000000-0000-4000-8000-000000000005'),
    'In-flight older inserts get automatic hours before the NOT NULL check';

  begin
    perform public.set_leave_balance_required_hours('20000000-0000-4000-8000-000000000001', 99);
    raise exception 'TEST: reviewer overrode the system-calculated hours';
  exception when sqlstate '22023' then
    assert sqlerrm = 'Paid hours are calculated automatically for this request.';
  end;

  perform public.set_leave_balance_required_hours('20000000-0000-4000-8000-000000000001', 7.6);
  assert (select required_hours = 7.6 from private.leave_balance_approvals where request_id = '20000000-0000-4000-8000-000000000001'),
    'The compatibility RPC cannot change the calculated value';

  assert not private.leave_payroll_balance_sufficient('20000000-0000-4000-8000-000000000001'),
    'Gross 28.4621 hours minus 22.8 committed hours cannot cover a 7.6-hour request';

  update private.test_accrual_state
  set payload = jsonb_set(payload, '{annualExactHours}', '30.4'::jsonb)
  where person_id = '10000000-0000-4000-8000-000000000002';

  assert private.leave_payroll_balance_sufficient('20000000-0000-4000-8000-000000000001'),
    'At the exact threshold, leave completed on the accrual cutoff is not deducted again';

  update private.test_accrual_state set payload = jsonb_set(payload, '{annualExactHours}', '30.3999'::jsonb);
  assert not private.leave_payroll_balance_sufficient('20000000-0000-4000-8000-000000000001'),
    'Never round a near-threshold available balance into sufficiency';
  update private.test_accrual_state set payload = jsonb_set(payload, '{status}', '"needs_review"'::jsonb);
  assert not private.leave_payroll_balance_sufficient('20000000-0000-4000-8000-000000000001'),
    'Unresolved accrual reviews do not trigger reminders';

  update private.test_accrual_state set payload = '{"status":"not_configured"}'::jsonb;
  assert not private.leave_payroll_balance_sufficient('20000000-0000-4000-8000-000000000001'),
    'The payroll-only path also reserves approved commitments';
  update private.employee_annual_leave_balances set hours = 30.4;
  assert private.leave_payroll_balance_sufficient('20000000-0000-4000-8000-000000000001'),
    'A fresh payroll-only available balance can reach the exact threshold';
  update private.employee_annual_leave_balances set as_of = as_of - 2;
  assert not private.leave_payroll_balance_sufficient('20000000-0000-4000-8000-000000000001'),
    'Stale payroll snapshots do not trigger a balance-ready reminder';
  update private.employee_annual_leave_balances set as_of = as_of + 2, is_example = true;
  assert not private.leave_payroll_balance_sufficient('20000000-0000-4000-8000-000000000001'),
    'Example payroll balances never trigger reminders';
  update private.employee_annual_leave_balances set is_example = false;
  update public.leave_requests set status = 'cancelled' where id = '20000000-0000-4000-8000-000000000001';
  assert not private.leave_payroll_balance_sufficient('20000000-0000-4000-8000-000000000001'),
    'Cancelled requests never trigger reminders';

  perform set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000002', true);
  begin
    perform public.decide_leave_with_balance('20000000-0000-4000-8000-000000000005', 'Approved – pending leave balance', null);
    raise exception 'TEST: employee conditionally approved their own request';
  exception when insufficient_privilege then null;
  end;

  perform set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000003', true);
  begin
    perform public.decide_leave_with_balance('20000000-0000-4000-8000-000000000005', 'Approved – pending leave balance', null);
    raise exception 'TEST: unrelated employee approved a request';
  exception when insufficient_privilege then null;
  end;
  perform set_config('request.jwt.claim.sub', '', true);
  begin
    perform public.decide_leave_with_balance('20000000-0000-4000-8000-000000000005', 'Approved – pending leave balance', null);
    raise exception 'TEST: unauthenticated approval allowed';
  exception when insufficient_privilege then null;
  end;

  assert (select hours is null from public.leave_requests where id = '20000000-0000-4000-8000-000000000005'),
    'Snapshotting reminder hours preserves the original full-day request';

  assert not has_function_privilege('authenticated', 'private.leave_request_required_hours(uuid)', 'EXECUTE'),
    'Browser sessions cannot call the private duration helper';
  assert not has_function_privilege('authenticated', 'private.leave_payroll_balance_sufficient(uuid)', 'EXECUTE'),
    'Browser sessions cannot call the private balance decision helper';
end;
$$;

rollback;
