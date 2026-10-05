\set ON_ERROR_STOP on
begin;
\ir unified-role-fixture.sql
select public.stage_payroll_balance_import('a1000000-0000-4000-8000-000000000006',repeat('b',64),
  jsonb_build_array(jsonb_build_object('name','synthetic.csv','sha256',repeat('a',64),'sizeBytes',100,
    'companies',jsonb_build_array('mam'),'asOfDates',jsonb_build_array(current_date),'employeeRows',1)),
  jsonb_build_array(jsonb_build_object('companyKey','mam','employeeName','Synthetic role 01','annualHours',60,
    'asOf',current_date,'sourceFile','synthetic.csv','sourceSha256',repeat('a',64))));
commit;
