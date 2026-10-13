begin;
\ir payroll-closing-setup.sql
select public.reconcile_payroll_closing('synthetic-closing-one',pg_temp.closing_payload());
do $$declare pid uuid:='96000000-0000-4000-8000-000000000003'; p jsonb; r jsonb; before_hours numeric; next_payload jsonb; begin
  assert to_regprocedure('public.settle_payroll_carryforward(text,jsonb)') is not null, 'Supported audited settlement is required';
  p:=jsonb_build_object('personId',pid,'requestId','96000000-0000-4000-8000-000000000013','expectedFingerprint',private.payroll_closing_fingerprint(pid),
    'hours',7.6,'provenance','confirmed_usage','note','Synthetic confirmed usage, not invented daily dates.');
  select hours into before_hours from private.employee_annual_leave_balances where person_id=pid;
  r:=public.settle_payroll_carryforward('synthetic-settlement-one',p);
  assert r->>'committed'='true';
  assert (select hours from private.employee_annual_leave_balances where person_id=pid)=before_hours-7.6;
  assert (private.project_annual_leave_balance(pid,'2026-09-25')->>'balanceSource')='owner_estimate', 'Confirmed consumption does not verify the estimated banked opening';
  assert exists(select 1 from jsonb_array_elements(public.get_leave_priority_workspace()->'people') person where person->>'personId'=pid::text and person->>'annualBalanceSource'='owner_estimate');
  assert private.approved_leave_hours_after(pid,array['Annual leave'],'2026-09-24')=38;
  assert (select accounted_hours from private.payroll_carryforward_events where person_id=pid order by id desc limit 1)=83.6;
  assert public.settle_payroll_carryforward('synthetic-settlement-one',p)=r;
  assert (select hours from private.employee_annual_leave_balances where person_id=pid)=before_hours-7.6;
  begin
    perform public.review_employee_leave_accrual_day(pid,'2026-09-22',7.6,7.6,7.6,0,'Cannot re-account the adopted aggregate');
    raise exception 'Retroactive dated usage accepted';
  exception when sqlstate '55000' then null; end;
  begin
    update public.leave_requests set end_date='2026-09-28' where id='96000000-0000-4000-8000-000000000013';
    raise exception 'Protected request changed';
  exception when sqlstate '55000' then null; end;
  perform public.review_employee_leave_accrual_day(pid,'2026-09-25',7.6,7.6,7.6,0,'Synthetic actual later usage');
  next_payload:=jsonb_build_object('closingDate','2026-09-25','provenance','owner_estimate','note','Synthetic next closing retaining prior pending.',
    'people',jsonb_build_array(jsonb_build_object('personId',pid,'company','equipsy','expectedFingerprint',private.payroll_closing_fingerprint(pid),
      'annualHours',125,'personalHours',87,'reservations',jsonb_build_array(jsonb_build_object('requestId','96000000-0000-4000-8000-000000000013','accountedHours',91.2,'pendingHours',30.4)))));
  perform public.reconcile_payroll_closing('synthetic-next-closing',next_payload);
  assert private.approved_leave_hours_after(pid,array['Annual leave'],'2026-09-25')=30.4;
  assert (private.project_annual_leave_balance(pid,'2026-09-26')->>'availableHours')::numeric=94.6;
  assert (private.calculate_employee_leave_accrual(pid,'2026-09-25')->>'annualTaken')::numeric=case when pg_temp.closing_continuous() then 30.4 else 0 end;
  select hours into before_hours from private.employee_annual_leave_balances where person_id=pid;
  update public.leave_requests set status='cancelled' where id='96000000-0000-4000-8000-000000000013';
  assert private.approved_leave_hours_after(pid,array['Annual leave'],'2026-09-25')=0;
  assert (select hours from private.employee_annual_leave_balances where person_id=pid)=before_hours, 'Cancellation must never refund assumed or consumed usage';
  assert (select operation from private.payroll_closing_receipts order by created_at desc limit 1)='cancellation';
  assert (select accounted_hours from private.payroll_carryforward_events where person_id=pid order by id desc limit 1)=91.2;
end$$;
rollback;
