\set ON_ERROR_STOP on
begin;
\ir unified-role-fixture.sql
insert into private.employee_directory_details(person_id,first_name,last_name,employment_type)
select id,'Synthetic','Payroll Subject','full_time' from public.internal_org_people where id='a1000000-0000-4000-8000-000000000001';
update public.internal_org_people set full_name='Synthetic Payroll Subject' where id='a1000000-0000-4000-8000-000000000001';
insert into private.employee_annual_leave_balances(person_id,hours,as_of,is_example,updated_by)
values ('a1000000-0000-4000-8000-000000000001',80,current_date,false,'a1000000-0000-4000-8000-000000000009');
insert into private.employee_sick_leave_balances(person_id,hours,as_of,updated_by)
values ('a1000000-0000-4000-8000-000000000001',40,current_date,'a1000000-0000-4000-8000-000000000009');
create function pg_temp.payroll_files() returns jsonb language sql as $$
  select jsonb_build_array(jsonb_build_object('name','synthetic.csv','sha256',repeat('a',64),'sizeBytes',100,
    'companies',jsonb_build_array('mam'),'asOfDates',jsonb_build_array(current_date),'employeeRows',1));
$$;
create function pg_temp.payroll_rows() returns jsonb language sql as $$
  select jsonb_build_array(jsonb_build_object('companyKey','mam','employeeName','Synthetic Payroll Subject',
    'annualHours',60,'sickHours',30,'asOf',current_date,'sourceFile','synthetic.csv','sourceSha256',repeat('a',64)));
$$;
create temp table payroll_test_batches(kind text primary key, id uuid, projection jsonb);
grant select on payroll_test_batches to authenticated;
select pg_temp.set_test_actor('a1000000-0000-4000-8000-000000000006');
do $$ declare b jsonb; begin
  b:=public.stage_payroll_balance_import(auth.uid(),repeat('b',64),pg_temp.payroll_files(),pg_temp.payroll_rows());
  assert (b->>'comparisonOnly')::boolean, 'Every Account stages comparison only, irrespective of personal grants';
  insert into payroll_test_batches values('account',(b->>'batchId')::uuid,b);
  begin perform public.commit_payroll_balance_import_before_comparison((b->>'batchId')::uuid,1);
    raise exception 'Legacy payroll commit bypass accepted Account'; exception when insufficient_privilege then null; end;
end $$;
do $$ begin
  assert to_regprocedure('public.stage_payroll_balance_import_for_preview(uuid,uuid,text,jsonb,jsonb)') is not null,
    'P0 real-uploader / target-policy payroll staging RPC is missing';
  assert to_regprocedure('public.get_payroll_balance_import_workspace_for_preview(uuid)') is not null,
    'Target-scoped payroll preview workspace RPC is missing';
end $$;
select pg_temp.set_test_actor('a1000000-0000-4000-8000-000000000009');
do $$ declare b jsonb; target uuid:='a1000000-0000-4000-8000-000000000003'; begin
  b:=public.stage_payroll_balance_import_for_preview(auth.uid(),target,repeat('c',64),pg_temp.payroll_files(),pg_temp.payroll_rows());
  assert (b->>'comparisonOnly')::boolean and jsonb_array_length(b->'comparisonRows')=2, 'Account-target P0 upload forced comparison inside DB';
  insert into payroll_test_batches values('preview',(b->>'batchId')::uuid,b);
  assert (select uploaded_by=auth.uid() and preview_person_id=target from private.payroll_balance_import_batches where id=(b->>'batchId')::uuid), 'Audit uploader remains real P0';
  begin perform public.commit_payroll_balance_import((b->>'batchId')::uuid,1);
    raise exception 'Real P0 committed Account-target comparison'; exception when insufficient_privilege then null; end;
  begin perform public.commit_payroll_balance_import_before_comparison((b->>'batchId')::uuid,1);
    raise exception 'Legacy API committed immutable comparison'; exception when insufficient_privilege then null; end;
  b:=public.get_payroll_balance_import_workspace_for_preview(target);
  assert (b->>'canImport')::boolean and not (b->>'canManageAccess')::boolean and (b->>'comparisonOnly')::boolean, 'Account preview payroll projection cannot inherit P0';
  assert jsonb_array_length(b->'recentBatches')=1, 'Preview batch loader stays target/real-uploader scoped';
end $$;
update public.profiles set app_role='admin' where id='a1000000-0000-4000-8000-000000000003';
do $$ declare b jsonb; before_rows jsonb; begin
  select projection->'comparisonRows' into before_rows from payroll_test_batches where kind='preview';
  update private.employee_annual_leave_balances set hours=79 where person_id='a1000000-0000-4000-8000-000000000001';
  b:=public.stage_payroll_balance_import_for_preview(auth.uid(),'a1000000-0000-4000-8000-000000000003',repeat('c',64),pg_temp.payroll_files(),pg_temp.payroll_rows());
  assert b->'comparisonRows'=before_rows and (b->>'comparisonOnly')::boolean, 'Retry/promotion retains immutable comparison result';
  begin perform public.commit_payroll_balance_import((b->>'batchId')::uuid,1);
    raise exception 'Promotion made comparison batch committable'; exception when insufficient_privilege then null; end;
end $$;
select pg_temp.set_test_actor('a1000000-0000-4000-8000-000000000006');
set local role authenticated;
do $$ declare b uuid; begin
  select id into b from payroll_test_batches where kind='account';
  begin perform public.commit_payroll_balance_import(b,1);
    raise exception 'Account committed through current API'; exception when insufficient_privilege then null; end;
  begin perform public.commit_payroll_balance_import_before_comparison(b,1);
    raise exception 'Browser called old commit API'; exception when insufficient_privilege then null; end;
  begin perform public.set_employee_annual_leave_balance('a1000000-0000-4000-8000-000000000001',1,current_date,false);
    raise exception 'Account manually edited balance'; exception when insufficient_privilege then null; end;
  begin perform public.stage_payroll_balance_import_for_preview(auth.uid(),'a1000000-0000-4000-8000-000000000004',repeat('e',64),'[]','[]');
    raise exception 'Browser called service preview stage'; exception when insufficient_privilege then null; end;
end $$;
reset role;
do $$ declare n integer; begin
  for n in 1..2 loop
    begin perform public.stage_payroll_balance_import(('a1000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,repeat('d',64),pg_temp.payroll_files(),pg_temp.payroll_rows());
      raise exception 'Employee/Manager staged from obsolete payroll grant'; exception when insufficient_privilege then null; end;
  end loop;
  begin perform public.stage_payroll_balance_import('a1000000-0000-4000-8000-000000000008',repeat('d',64),pg_temp.payroll_files(),pg_temp.payroll_rows());
    raise exception 'Granted Employee payroll bypass'; exception when insufficient_privilege then null; end;
  begin perform public.stage_payroll_balance_import_for_preview('a1000000-0000-4000-8000-000000000004','a1000000-0000-4000-8000-000000000003',repeat('d',64),pg_temp.payroll_files(),pg_temp.payroll_rows());
    raise exception 'Ordinary Admin impersonated preview actor'; exception when insufficient_privilege then null; end;
  assert (select hours=79 from private.employee_annual_leave_balances where person_id='a1000000-0000-4000-8000-000000000001'), 'Comparisons never changed annual balance';
  assert (select hours=40 from private.employee_sick_leave_balances where person_id='a1000000-0000-4000-8000-000000000001'), 'Comparisons never changed sick balance';
  assert not exists(select 1 from private.payroll_balance_imports where batch_id in (select id from payroll_test_batches)), 'Comparisons never created balance import provenance';
end $$;
select pg_temp.set_test_actor('a1000000-0000-4000-8000-000000000004');
do $$ declare b jsonb; begin
  b:=public.stage_payroll_balance_import(auth.uid(),repeat('f',64),pg_temp.payroll_files(),pg_temp.payroll_rows());
  assert not (b->>'comparisonOnly')::boolean, 'Admin normal payroll import';
  b:=public.commit_payroll_balance_import((b->>'batchId')::uuid,1);
  assert b->>'status'='committed', 'Admin daily balance commit remains available';
end $$;
select pg_temp.set_test_actor('a1000000-0000-4000-8000-000000000006');
do $$ declare a jsonb; begin
  a:=public.prepare_payroll_balance_source_archive(auth.uid(),'synthetic.csv','text/csv',100,repeat('a',64));
  insert into storage.objects(bucket_id,name,metadata) values('payroll-balance-archives',a->>'storagePath','{"size":100,"mimetype":"text/csv"}');
  perform public.complete_payroll_balance_source_archive(auth.uid(),(a->>'archiveId')::uuid);
  perform public.link_payroll_balance_source_archives(auth.uid(),array[(a->>'archiveId')::uuid],(select id from payroll_test_batches where kind='account'));
  assert (select retain_until>=uploaded_at+interval '30 days' and parse_status='parsed' and uploaded_by=auth.uid()
    from private.payroll_balance_source_archives where id=(a->>'archiveId')::uuid), 'Account upload retention/uploader scope remains unchanged';
end $$;
rollback;
\echo PASS: Account/preview comparison-only imports, old/current commit fences, immutable promotion/retry and source retention
