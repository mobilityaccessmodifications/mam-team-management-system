begin;
do $$begin assert to_regprocedure('public.reconcile_payroll_closing(text,jsonb)') is not null, 'Audited closing RPC is required'; end$$;
\ir payroll-closing-setup.sql
create temporary table preserved_requests as select * from public.leave_requests;
create temporary table preserved_annual_history as select * from private.annual_leave_balance_history;
create temporary table preserved_personal_history as select * from private.sick_leave_balance_history;
create temporary table preserved_imports as select * from private.payroll_balance_imports;
create temporary table preserved_outbox as select * from private.leave_notification_outbox;
do $$declare p jsonb; r jsonb; before_count integer; begin
  p:=pg_temp.closing_payload();
  r:=public.reconcile_payroll_closing('synthetic-closing-one',p);
  assert r->>'committed'='true';
  assert (select hours from private.employee_annual_leave_balances where person_id='96000000-0000-4000-8000-000000000002')=100.1234;
  assert (select hours from private.employee_sick_leave_balances where person_id='96000000-0000-4000-8000-000000000003')=86.5432;
  assert (select count(*) from private.annual_leave_balance_history)=(select count(*)+2 from preserved_annual_history);
  assert (select count(*) from private.sick_leave_balance_history)=(select count(*)+2 from preserved_personal_history);
  assert not exists(select * from preserved_requests except select * from public.leave_requests);
  assert not exists(select * from public.leave_requests except select * from preserved_requests);
  assert not exists(select * from preserved_annual_history except select * from private.annual_leave_balance_history);
  assert not exists(select * from preserved_personal_history except select * from private.sick_leave_balance_history);
  assert not exists(select * from preserved_imports except select * from private.payroll_balance_imports);
  assert not exists(select * from private.payroll_balance_imports except select * from preserved_imports);
  assert not exists(select * from private.leave_notification_outbox except select * from preserved_outbox);
  assert not exists(select * from preserved_outbox except select * from private.leave_notification_outbox);
  assert not exists(select 1 from private.employee_annual_leave_balances where person_id::text like '96000000%' and (source_import_id is not null or updated_by is distinct from auth.uid()));
  assert (select count(*) from private.payroll_closing_receipts)=1;
  assert (select count(*) from private.payroll_carryforward_events)=2;
  assert private.approved_leave_hours_after('96000000-0000-4000-8000-000000000002',array['Annual leave'],'2026-09-24')=15.2;
  assert private.approved_leave_hours_after('96000000-0000-4000-8000-000000000003',array['Annual leave'],'2026-09-24')=45.6;
  assert (private.project_annual_leave_balance('96000000-0000-4000-8000-000000000003','2026-09-25')->>'availableHours')::numeric=140.4321-45.6;
  assert (private.calculate_employee_leave_accrual('96000000-0000-4000-8000-000000000003','2026-09-24')->>'annualTaken')::numeric=0;
  assert public.reconcile_payroll_closing('synthetic-closing-one',p)=r, 'Identical key and payload returns original receipt';
  assert (select count(*) from private.payroll_closing_receipts)=1;
  begin
    perform public.reconcile_payroll_closing('synthetic-closing-one',jsonb_set(p,'{people,0,annualHours}','101'));
    raise exception 'Changed idempotency payload accepted';
  exception when sqlstate '22023' then null; end;
  begin
    perform public.set_employee_annual_leave_balance('96000000-0000-4000-8000-000000000002',101,'2026-09-25',false);
    raise exception 'Manual setter dropped pending';
  exception when sqlstate '55000' then null; end;
end$$;
rollback;
