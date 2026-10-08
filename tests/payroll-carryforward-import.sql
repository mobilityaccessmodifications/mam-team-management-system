begin;
\ir payroll-closing-setup.sql
select public.reconcile_payroll_closing('synthetic-closing-one',pg_temp.closing_payload());
insert into private.payroll_balance_import_grants(person_id,granted_by) values('96000000-0000-4000-8000-000000000003','96000000-0000-4000-8000-000000000001');
insert into private.payroll_comparison_only_importers values('96000000-0000-4000-8000-000000000003');
-- Legacy importer grants are inert after canonical roles; Account owns comparison-only upload.
update public.profiles set app_role='account' where id='96000000-0000-4000-8000-000000000003';
create temporary table staged_result(result jsonb);
grant all on staged_result to service_role;
set local role service_role;
insert into staged_result select public.stage_payroll_balance_import('96000000-0000-4000-8000-000000000003',repeat('c',64),
  jsonb_build_array(jsonb_build_object('name','synthetic.csv','sha256',repeat('c',64),'sizeBytes',100,'companies',jsonb_build_array('equipsy'),'asOfDates',jsonb_build_array('2026-09-24'),'employeeRows',1)),
  jsonb_build_array(jsonb_build_object('companyKey','equipsy','employeeName','Synthetic Closing B','annualHours',94.8321,'sickHours',86.5432,'asOf','2026-09-24','sourceFile','synthetic.csv','sourceSha256',repeat('c',64))));
reset role;
do $$declare bid uuid; row jsonb; p jsonb; begin
  p:=(select result from staged_result); bid:=(p->>'batchId')::uuid;
  assert p->>'comparisonOnly'='true';
  select value into row from jsonb_array_elements(p->'comparisonRows') where value->>'kind'='annual';
  assert (row->>'systemHours')::numeric=140.4321, 'Xero comparison uses dated bank before future or retained reservations';
  assert row->>'different'='true';
  begin perform public.commit_payroll_balance_import(bid,1); raise exception 'P0 applied comparison'; exception when sqlstate '42501' then null; end;
  perform pg_temp.set_test_actor('96000000-0000-4000-8000-000000000003');
  begin perform public.commit_payroll_balance_import(bid,1); raise exception 'Comparison uploader applied'; exception when sqlstate '42501' then null; end;
  begin perform public.reconcile_payroll_closing('synthetic-uploader',pg_temp.closing_payload()); raise exception 'Uploader gained closing'; exception when sqlstate '42501' then null; end;
  assert (select hours from private.employee_annual_leave_balances where person_id='96000000-0000-4000-8000-000000000003')=140.4321;
  assert (select count(*) from private.payroll_closing_receipts)=1;
end$$;
rollback;
