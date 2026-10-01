begin;
\ir payroll-closing-setup.sql
insert into public.internal_org_people(id,node_kind,company_key,full_name,position_title,is_active) values('96000000-0000-4000-8000-000000000004','person','equipsy','Synthetic Unlinked C','Tester',true);
select public.review_employee_leave_accrual_day('96000000-0000-4000-8000-000000000003','2026-09-23',7.6,7.6,7.6,0,'Synthetic actual usage');
select public.reconcile_payroll_closing('synthetic-closing-one',pg_temp.closing_payload());
do $$begin
  begin
    update private.employee_annual_leave_balances set person_id='96000000-0000-4000-8000-000000000004' where person_id='96000000-0000-4000-8000-000000000002';
    raise exception 'Protected balance moved';
  exception when sqlstate '55000' then null; end;
  begin
    update private.leave_accrual_day_reviews set service_date='2026-09-26' where person_id='96000000-0000-4000-8000-000000000003' and service_date='2026-09-23';
    raise exception 'Closed dated review moved';
  exception when sqlstate '55000' then null; end;
  begin
    truncate private.payroll_carryforward_events;
    raise exception 'Reservation audit truncated';
  exception when sqlstate '55000' then null; end;
  begin
    delete from private.payroll_carryforward_events;
    raise exception 'Audit deleted';
  exception when sqlstate '55000' then null; end;
end$$;
rollback;
