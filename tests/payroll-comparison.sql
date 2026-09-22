\set ON_ERROR_STOP on
-- Isolated synthetic database only.
do $$begin assert current_database()='payroll_comparison_test';end$$;
create schema private;
create schema auth;
do $$begin
 if not exists(select from pg_roles where rolname='anon') then create role anon;end if;
 if not exists(select from pg_roles where rolname='authenticated') then create role authenticated;end if;
 if not exists(select from pg_roles where rolname='service_role') then create role service_role;end if;
end$$;
create function auth.uid() returns uuid language sql as $$select nullif(current_setting('test.actor',true),'')::uuid$$;
create table public.internal_org_people(id uuid primary key,auth_user_id uuid);
create table private.payroll_balance_import_batches(id uuid primary key,source_files jsonb,uploaded_by uuid);
create table private.payroll_balance_import_stage_rows(id bigint,batch_id uuid,person_id uuid,employee_name text,company_key text,as_of date,match_status text,annual_hours numeric,sick_hours numeric);
create table private.employee_annual_leave_balances(person_id uuid,hours numeric,as_of date,is_example boolean);
create table private.employee_sick_leave_balances(person_id uuid,hours numeric,as_of date);
create table private.payroll_balance_imports(company_key text,match_status text,as_of date);
create function private.approved_leave_hours_after(uuid,text[],date) returns numeric language sql as $$select 10::numeric$$;
create function private.next_victorian_business_day(date) returns date language sql as $$select $1$$;
create function private.payroll_balance_missing_companies(date) returns text[] language sql as $$select array['mam','equipsy']::text[]$$;
create function private.has_payroll_balance_import_access() returns boolean language sql as $$select auth.uid() is not null$$;
create function private.payroll_balance_import_batch_projection(uuid) returns jsonb language sql as $$select jsonb_build_object('batchId',$1)$$;
create function public.stage_payroll_balance_import(uuid,text,jsonb,jsonb) returns jsonb language plpgsql as $$begin
 if $1 is null then raise exception 'Not authorised' using errcode='42501';end if;
 return private.payroll_balance_import_batch_projection($2::uuid);end$$;
create function public.commit_payroll_balance_import(uuid,bigint) returns jsonb language plpgsql as $$begin
 update private.employee_annual_leave_balances set hours=999;return '{}'::jsonb;end$$;
\ir ../supabase/migrations/20260922150000_payroll_comparison_alerts.sql
insert into public.internal_org_people values('10000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001');
insert into private.payroll_comparison_only_importers values('10000000-0000-4000-8000-000000000001');
insert into private.payroll_balance_import_batches values('20000000-0000-4000-8000-000000000001','[]','10000000-0000-4000-8000-000000000001',false);
insert into private.employee_annual_leave_balances values('10000000-0000-4000-8000-000000000001',50,current_date,false);
insert into private.employee_sick_leave_balances values('10000000-0000-4000-8000-000000000001',30,current_date);
insert into private.payroll_balance_import_stage_rows values(1,'20000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','Synthetic Person','mam',current_date,'linked',40,25);
select set_config('test.actor','10000000-0000-4000-8000-000000000001',false);
do $$declare result jsonb; job record;begin
 result:=public.stage_payroll_balance_import(auth.uid(),'20000000-0000-4000-8000-000000000001','[]','[]');
 assert (result->>'comparisonOnly')::boolean;
 assert (result->>'differenceCount')::integer=1;
 assert result->'comparisonRows'->0->>'systemHours'='40';
 assert (select hours=50 from private.employee_annual_leave_balances);
 begin perform public.commit_payroll_balance_import('20000000-0000-4000-8000-000000000001',1);raise exception 'Overwrite allowed';exception when insufficient_privilege then null;end;
 -- Even another uploader/admin cannot commit this comparison-only batch.
 perform set_config('test.actor','10000000-0000-4000-8000-000000000099',false);
 begin perform public.commit_payroll_balance_import('20000000-0000-4000-8000-000000000001',1);raise exception 'Overwrite allowed';exception when insufficient_privilege then null;end;
 perform public.stage_payroll_balance_import('10000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001','[]','[]');
 assert (select count(*)=1 from private.payroll_balance_comparisons);
 select * into job from public.claim_payroll_comparison_alerts(); assert job.difference_count=1;
 assert (select count(*)=0 from public.claim_payroll_comparison_alerts());
 assert not public.finish_payroll_comparison_alert(job.batch_id,gen_random_uuid(),true);
 assert public.finish_payroll_comparison_alert(job.batch_id,job.claim_token,false);
 update private.payroll_balance_comparisons set retry_at=now()-interval '1 minute';
 select * into job from public.claim_payroll_comparison_alerts();
 assert public.finish_payroll_comparison_alert(job.batch_id,job.claim_token,true);
 assert (select count(*)=0 from public.claim_payroll_comparison_alerts());
 assert private.payroll_balance_missing_companies(date_trunc('month',current_date)::date)=array['equipsy'];
 assert not has_function_privilege('authenticated','public.commit_payroll_balance_import_before_comparison(uuid,bigint)','execute');
 assert not has_function_privilege('service_role','public.stage_payroll_balance_import_before_comparison(uuid,text,jsonb,jsonb)','execute');
 assert not has_function_privilege('authenticated','public.claim_payroll_comparison_alerts()','execute');
 assert not has_table_privilege('authenticated','private.payroll_balance_comparisons','select');
end$$;
