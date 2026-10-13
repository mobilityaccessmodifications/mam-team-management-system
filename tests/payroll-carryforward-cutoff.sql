begin;
\ir payroll-closing-setup.sql
create function pg_temp.cutoff_continuous() returns boolean language sql stable as $$ select to_regprocedure('private.annual_leave_accounting_day(uuid,date)') is not null; $$;
select public.reconcile_payroll_closing('synthetic-cutoff-closing',pg_temp.closing_payload());
insert into public.leave_requests(id,employee_person_id,user_id,leave_type,request_type_label,start_date,end_date,business_days,hours,status,submitted_at,employment_type_snapshot,pay_treatment,approval_required,reason)
values('96000000-0000-4000-8000-000000000031','96000000-0000-4000-8000-000000000003','96000000-0000-4000-8000-000000000003','annual','Annual leave','2027-03-01','2027-03-18',14,100,'submitted',now(),'full_time','paid_entitlement',true,'Synthetic employee note');
insert into private.leave_balance_approvals(request_id,approved_by,approved_at)
values('96000000-0000-4000-8000-000000000031','96000000-0000-4000-8000-000000000001','2026-09-24 00:00:00+10');
select public.review_employee_leave_accrual_day('96000000-0000-4000-8000-000000000003',day::date,0,0,0,0,'Synthetic actual zero usage')
from generate_series(date '2026-09-25',(now() at time zone 'Australia/Melbourne')::date-1,interval '1 day') day;
do $$declare pid uuid:='96000000-0000-4000-8000-000000000003'; calculation jsonb; sufficient boolean; begin
  calculation:=private.calculate_employee_leave_accrual(pid,(now() at time zone 'Australia/Melbourne')::date-1);
  assert calculation->>'status'='current';
  assert (calculation->>'annualTaken')::numeric=case when pg_temp.cutoff_continuous() then 38 else 0 end;
  assert private.approved_leave_hours_after(pid,array['Annual leave'],'2026-09-24')=45.6;
  assert private.approved_leave_hours_after(pid,array['Annual leave'],(calculation->>'annualAsOf')::date)=38;
  assert (private.project_annual_leave_balance(pid,'2026-09-25')->>'availableHours')::numeric=94.8321;
  sufficient:=private.leave_payroll_balance_sufficient('96000000-0000-4000-8000-000000000031');
  raise notice 'zero-usage actual sufficient=%, banked=%, annualTaken=%, bank commitments=%, current dated commitments=%',sufficient,calculation->>'annualExactHours',calculation->>'annualTaken',private.approved_leave_hours_after(pid,array['Annual leave'],'2026-09-24'),private.approved_leave_hours_after(pid,array['Annual leave'],(calculation->>'annualAsOf')::date);
  assert not sufficient, 'Advancing cutoff must not release an unconsumed post-closing commitment';
end$$;
create function pg_temp.assert_cutoff_usage(p_taken numeric) returns void language plpgsql as $$
declare pid uuid:='96000000-0000-4000-8000-000000000003'; calculation jsonb; remaining numeric; begin
  perform public.review_employee_leave_accrual_day(pid,'2026-09-25',0,0,p_taken,0,'Synthetic confirmed post-closing usage');
  calculation:=private.calculate_employee_leave_accrual(pid,(now() at time zone 'Australia/Melbourne')::date-1);
  remaining:=private.payroll_request_unconsumed_hours(pid,'2026-09-24',(calculation->>'annualAsOf')::date);
  assert calculation->>'status'='current';
  assert (calculation->>'annualTaken')::numeric=p_taken+case when pg_temp.cutoff_continuous() then 38 else 0 end;
  assert (calculation->>'annualExactHours')::numeric=140.4321-p_taken-case when pg_temp.cutoff_continuous() then 38 else 0 end;
  assert remaining=45.6-least(p_taken,7.6)-case when pg_temp.cutoff_continuous() then 38 else 0 end, 'Only confirmed scheduled consumption releases commitments';
  assert (calculation->>'annualExactHours')::numeric-remaining=94.8321-greatest(0,p_taken-7.6), 'Actual usage is never subtracted twice';
  assert private.approved_leave_hours_after(pid,array['Annual leave'],'2026-09-24')=45.6, 'Bank-cutoff duration is unchanged';
  assert private.approved_leave_hours_after(pid,array['Annual leave'],'2026-09-24')-private.approved_leave_hours_after(pid,array['Annual leave'],'2026-09-25')=7.6, 'Reviewed-usage duration difference is unchanged';
  assert (private.project_annual_leave_balance(pid,((calculation->>'annualAsOf')::date+1))->>'availableHours')::numeric=94.8321-greatest(0,p_taken-7.6);
  delete from private.leave_balance_approvals where request_id='96000000-0000-4000-8000-000000000031';
  update public.leave_requests set hours=94.83-greatest(0,p_taken-7.6) where id='96000000-0000-4000-8000-000000000031';
  insert into private.leave_balance_approvals(request_id,approved_by,approved_at) values('96000000-0000-4000-8000-000000000031','96000000-0000-4000-8000-000000000001','2026-09-24 00:00:00+10');
  assert private.leave_payroll_balance_sufficient('96000000-0000-4000-8000-000000000031'), 'Coverage remains sufficient after actual debit';
  delete from private.leave_balance_approvals where request_id='96000000-0000-4000-8000-000000000031';
  update public.leave_requests set hours=94.84-greatest(0,p_taken-7.6) where id='96000000-0000-4000-8000-000000000031';
  insert into private.leave_balance_approvals(request_id,approved_by,approved_at) values('96000000-0000-4000-8000-000000000031','96000000-0000-4000-8000-000000000001','2026-09-24 00:00:00+10');
  assert not private.leave_payroll_balance_sufficient('96000000-0000-4000-8000-000000000031'), 'Authoritative four-decimal availability never rounds up into sufficiency';
end$$;
select pg_temp.assert_cutoff_usage(0);
select pg_temp.assert_cutoff_usage(3.0001);
select pg_temp.assert_cutoff_usage(7.6);
select pg_temp.assert_cutoff_usage(10);
select pg_temp.assert_cutoff_usage(7.6);
delete from private.leave_balance_approvals where request_id='96000000-0000-4000-8000-000000000031';
update public.leave_requests set hours=1 where id='96000000-0000-4000-8000-000000000031';
insert into private.leave_balance_approvals(request_id,approved_by,approved_at) values('96000000-0000-4000-8000-000000000031','96000000-0000-4000-8000-000000000001','2026-09-24 00:00:00+10');
savepoint employment_end;
update private.employee_directory_details set scheduled_employment_end_date='2026-09-24' where person_id='96000000-0000-4000-8000-000000000003';
do $$declare pid uuid:='96000000-0000-4000-8000-000000000003'; calculation jsonb; begin
  calculation:=private.calculate_employee_leave_accrual(pid,(now() at time zone 'Australia/Melbourne')::date-1);
  assert calculation->>'status'='current';
  assert (calculation->>'annualTaken')::numeric=7.6+case when pg_temp.cutoff_continuous() then 38 else 0 end, 'Correcting employment end cannot erase confirmed actual usage';
  assert (calculation->>'annualExactHours')::numeric=132.8321-case when pg_temp.cutoff_continuous() then 38 else 0 end;
  assert private.payroll_request_unconsumed_hours(pid,'2026-09-24',(calculation->>'annualAsOf')::date)=case when pg_temp.cutoff_continuous() then 0 else 45.6 end, 'Accounted usage cannot be charged again after employment end';
  assert (private.project_annual_leave_balance(pid,((calculation->>'annualAsOf')::date+1))->>'availableHours')::numeric=94.8321, 'Confirmed usage overlapping the preserved reservation is debited once';
end$$;
rollback to employment_end;
savepoint missing_review;
delete from private.leave_accrual_day_reviews where person_id='96000000-0000-4000-8000-000000000003' and service_date='2026-09-25';
do $$begin
  if pg_temp.cutoff_continuous() then
   assert private.calculate_employee_leave_accrual('96000000-0000-4000-8000-000000000003',(now() at time zone 'Australia/Melbourne')::date-1)->>'status'='current';
   assert private.payroll_request_unconsumed_hours('96000000-0000-4000-8000-000000000003','2026-09-24','2026-09-30')=0;
   assert private.leave_payroll_balance_sufficient('96000000-0000-4000-8000-000000000031');
  else
   assert private.calculate_employee_leave_accrual('96000000-0000-4000-8000-000000000003',(now() at time zone 'Australia/Melbourne')::date-1)->>'status'='needs_review';
   assert private.payroll_request_unconsumed_hours('96000000-0000-4000-8000-000000000003','2026-09-24','2026-09-30') is null;
   assert not private.leave_payroll_balance_sufficient('96000000-0000-4000-8000-000000000031');
  end if;
end$$;
rollback to missing_review;
savepoint stale_review;
update private.leave_accrual_day_reviews set request_fingerprint=repeat('0',32) where person_id='96000000-0000-4000-8000-000000000003' and service_date='2026-09-25';
do $$begin
  assert private.calculate_employee_leave_accrual('96000000-0000-4000-8000-000000000003',(now() at time zone 'Australia/Melbourne')::date-1)->>'status'='needs_review';
  assert private.payroll_request_unconsumed_hours('96000000-0000-4000-8000-000000000003','2026-09-24','2026-09-30') is null;
  assert not private.leave_payroll_balance_sufficient('96000000-0000-4000-8000-000000000031');
end$$;
rollback to stale_review;
savepoint overlapping_review;
insert into public.leave_requests(id,employee_person_id,user_id,leave_type,request_type_label,start_date,end_date,business_days,status,submitted_at,record_origin,source_record_sha256,employment_type_snapshot,pay_treatment)
values('96000000-0000-4000-8000-000000000032','96000000-0000-4000-8000-000000000003','96000000-0000-4000-8000-000000000003','annual','Annual leave','2026-09-25','2026-09-25',1,'approved',now(),'historical_import',repeat('c',64),'full_time','paid_entitlement');
select public.review_employee_leave_accrual_day('96000000-0000-4000-8000-000000000003','2026-09-25',0,0,3,0,'Synthetic ambiguous actual usage');
do $$begin
  assert private.calculate_employee_leave_accrual('96000000-0000-4000-8000-000000000003',(now() at time zone 'Australia/Melbourne')::date-1)->>'status'=case when pg_temp.cutoff_continuous() then 'needs_review' else 'current' end;
  assert private.payroll_request_unconsumed_hours('96000000-0000-4000-8000-000000000003','2026-09-24','2026-09-30') is null, 'Aggregate review cannot allocate consumption between overlapping approvals';
  assert not private.leave_payroll_balance_sufficient('96000000-0000-4000-8000-000000000031'), 'Ambiguous usage fails closed even for a one-hour request';
end$$;
rollback to overlapping_review;
do $$declare pid uuid:='96000000-0000-4000-8000-000000000003'; rid uuid:='96000000-0000-4000-8000-000000000013'; calculation jsonb; payload jsonb; begin
  assert not has_function_privilege('authenticated','private.payroll_request_unconsumed_hours(uuid,date,date)','EXECUTE');
  assert not has_function_privilege('service_role','private.payroll_request_unconsumed_hours(uuid,date,date)','EXECUTE');
  assert private.payroll_request_unconsumed_hours(pid,null,'2026-09-30') is null;
  assert private.payroll_request_unconsumed_hours(pid,'2026-09-24','2026-09-23') is null;
  assert (select accounted_hours from private.payroll_carryforward_events where request_id=rid order by id desc limit 1)=76;
  assert (select pending_hours from private.payroll_carryforward_events where request_id=rid order by id desc limit 1)=38;
  payload:=jsonb_build_object('personId',pid,'requestId',rid,'expectedFingerprint',private.payroll_closing_fingerprint(pid),'hours',38,'provenance','confirmed_usage','note','Synthetic confirmed retained consumption');
  perform public.settle_payroll_carryforward('synthetic-cutoff-settlement',payload);
  assert (select hours from private.employee_annual_leave_balances where person_id=pid)=102.4321;
  assert (select accounted_hours from private.payroll_carryforward_events where request_id=rid order by id desc limit 1)=114;
  calculation:=private.calculate_employee_leave_accrual(pid,(now() at time zone 'Australia/Melbourne')::date-1);
  assert (calculation->>'annualExactHours')::numeric-private.payroll_request_unconsumed_hours(pid,'2026-09-24',(calculation->>'annualAsOf')::date)=94.8321;
  update public.leave_requests set status='cancelled' where id=rid;
  assert (select hours from private.employee_annual_leave_balances where person_id=pid)=102.4321, 'Cancellation never refunds settled or consumed hours';
  assert not private.leave_payroll_balance_sufficient('96000000-0000-4000-8000-000000000031'), 'Cancellation retains consumed usage but stale manual review eligibility remains held';
  if pg_temp.cutoff_continuous() then
    assert (private.calculate_employee_leave_accrual(pid,(now() at time zone 'Australia/Melbourne')::date-1)->>'annualTaken')::numeric=7.6, 'A stale cancellation review cannot refund captured consumption';
  end if;
  perform public.review_employee_leave_accrual_day(pid,'2026-09-25',0,0,7.6,0,'Synthetic preserved consumption after cancellation');
  calculation:=private.calculate_employee_leave_accrual(pid,(now() at time zone 'Australia/Melbourne')::date-1);
  assert (calculation->>'annualExactHours')::numeric=94.8321;
  assert private.payroll_request_unconsumed_hours(pid,'2026-09-24',(calculation->>'annualAsOf')::date)=0;
  payload:=jsonb_build_object('closingDate','2026-09-30','provenance','owner_estimate','note','Synthetic later closing after settlement and cancellation','people',jsonb_build_array(jsonb_build_object('personId',pid,'company','equipsy','expectedFingerprint',private.payroll_closing_fingerprint(pid),'annualHours',94.8321,'personalHours',86.5432,'reservations','[]'::jsonb)));
  perform public.reconcile_payroll_closing('synthetic-cutoff-later-closing',payload);
  calculation:=private.calculate_employee_leave_accrual(pid,'2026-09-30');
  assert (calculation->>'annualExactHours')::numeric=94.8321;
  assert (calculation->>'annualTaken')::numeric=0, 'Later closing never debits prior confirmed usage again';
  assert private.approved_leave_hours_after(pid,array['Annual leave'],'2026-09-30')=0;
  assert (select hours from private.employee_annual_leave_balances where person_id=pid)=94.8321;
  assert (select count(*) from private.payroll_closing_receipts)=4;
  assert (select accounted_hours from private.payroll_carryforward_events where request_id=rid order by id desc limit 1)=114;
  assert private.leave_payroll_balance_sufficient('96000000-0000-4000-8000-000000000031');
end$$;
rollback;
