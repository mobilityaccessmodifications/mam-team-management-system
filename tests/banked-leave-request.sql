\set ON_ERROR_STOP on
do $$begin assert current_database() in ('banked_leave_request_test','projected_leave_request_test'), 'Disposable database only'; end$$;
create schema private;
do $$begin
  if not exists(select 1 from pg_roles where rolname='anon') then create role anon; end if;
  if not exists(select 1 from pg_roles where rolname='authenticated') then create role authenticated; end if;
  if not exists(select 1 from pg_roles where rolname='service_role') then create role service_role; end if;
end$$;
create table public.internal_org_people(id uuid primary key, full_name text, company_key text);
create table private.employee_directory_details(person_id uuid primary key, employment_type text);
create table private.employee_annual_leave_balances(person_id uuid primary key, hours numeric, as_of date, is_example boolean);
create table public.leave_requests(
 id uuid primary key default gen_random_uuid(), employee_person_id uuid,
 record_origin text default 'portal', status text default 'submitted', request_type_label text default 'Annual leave',
 start_date date default '2026-10-12', end_date date default '2026-10-12', start_time time, end_time time,
 business_days integer default 1, hours numeric, employment_type_snapshot text default 'full_time', reason text, manager_note text
);
create table private.leave_notification_outbox(request_id uuid, event text, payload jsonb, unique(request_id,event));
create function private.enqueue_leave_notification(uuid,text,boolean) returns void language sql as $$ select; $$;
create function public.get_leave_priority_workspace(uuid default null) returns jsonb language sql as $$
 select '{"people":[{"personId":"10000000-0000-4000-8000-000000000001","paidLeave":true,"canViewBalance":true,"annualPayrollHours":15.2,"annualPayrollDate":"2026-09-30"}],"requests":[]}'::jsonb;
$$;
\ir ../supabase/migrations/20260917090100_leave_duration_balance_breakdown.sql
\ir ../supabase/migrations/20260922120000_banked_annual_leave_request_limit.sql

insert into public.internal_org_people values('10000000-0000-4000-8000-000000000001','Synthetic employee','mam');
insert into private.employee_directory_details values('10000000-0000-4000-8000-000000000001','full_time');
insert into private.employee_annual_leave_balances values('10000000-0000-4000-8000-000000000001',15.2,'2026-09-30',false);
-- A prior approved day consumes 7.6h; the exact remaining day may be requested.
insert into public.leave_requests(employee_person_id,status,record_origin) values('10000000-0000-4000-8000-000000000001','approved','historical_import');
insert into public.leave_requests(employee_person_id) values('10000000-0000-4000-8000-000000000001');
do $$declare person uuid := '10000000-0000-4000-8000-000000000001'; payload jsonb; begin
  begin
    insert into public.leave_requests(employee_person_id,business_days,end_date) values(person,2,'2026-10-13');
    raise exception 'TEST: excess request accepted';
  exception when sqlstate '22023' then assert sqlerrm like 'Not enough balance.%'; end;
  insert into public.leave_requests(employee_person_id,hours,start_time,end_time) values(person,4,'12:00','16:00');
  begin
    insert into public.leave_requests(employee_person_id,hours,start_time,end_time) values(person,8,'08:00','16:00');
    raise exception 'TEST: excess timed request accepted';
  exception when sqlstate '22023' then assert sqlerrm like 'Not enough balance.%'; end;
  update private.employee_annual_leave_balances set hours=5;
  begin
    insert into public.leave_requests(employee_person_id) values(person);
    raise exception 'TEST: negative available balance accepted';
  exception when sqlstate '22023' then assert sqlerrm like 'Not enough balance.%'; end;
  update private.employee_annual_leave_balances set hours=-2;
  begin
    insert into public.leave_requests(employee_person_id) values(person);
    raise exception 'TEST: negative banked balance accepted';
  exception when sqlstate '22023' then assert sqlerrm like 'Not enough balance.%'; end;
  update private.employee_annual_leave_balances set hours=100,is_example=true;
  begin
    insert into public.leave_requests(employee_person_id) values(person);
    raise exception 'TEST: example balance accepted';
  exception when sqlstate '22023' then assert sqlerrm like '%balance is unavailable.%'; end;
  delete from private.employee_annual_leave_balances;
  begin
    insert into public.leave_requests(employee_person_id) values(person);
    raise exception 'TEST: missing banked balance accepted';
  exception when sqlstate '22023' then assert sqlerrm like '%balance is unavailable.%'; end;
  -- Unpaid/sick and historical requests remain unchanged, even without balances.
  insert into public.leave_requests(employee_person_id,request_type_label) values(person,'Unpaid leave'),(person,'Sick leave'),(person,'Carer''s leave');
  insert into public.leave_requests(employee_person_id,record_origin) values(person,'historical_import');
  assert (public.get_leave_priority_workspace()->'people'->0->>'requestFullDayHours')::numeric=7.6;
  assert not has_function_privilege('authenticated','public.get_leave_priority_workspace_before_request_limit(uuid)','EXECUTE');
  assert not has_function_privilege('authenticated','private.enforce_banked_annual_leave_request()','EXECUTE');
  update public.leave_requests set status='rejected',manager_note='Please reapply for fewer paid days.' where status='submitted';
  perform private.enqueue_leave_notification((select id from public.leave_requests where status='rejected' limit 1),'leave-declined',false);
  select outbox.payload into payload from private.leave_notification_outbox outbox limit 1;
  assert payload->>'managerNote'='Please reapply for fewer paid days.';
  assert not payload ? 'leaveBalance';
end$$;
