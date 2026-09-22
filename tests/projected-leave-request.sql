\set ON_ERROR_STOP on
do $$begin assert current_database()='projected_leave_request_test', 'Disposable database only'; end$$;
\ir banked-leave-request.sql
alter table public.internal_org_people add column started_date date;
alter table private.employee_directory_details add column scheduled_employment_end_date date;
create table private.leave_accrual_policies(id uuid primary key default gen_random_uuid(), person_id uuid,
 effective_from date, weekly_hours numeric, weekdays integer[], annual_weeks numeric, enabled boolean,
 requires_review boolean default false,created_at timestamptz default clock_timestamp());
create table private.leave_accrual_day_reviews(id uuid primary key default gen_random_uuid(),person_id uuid,
 service_date date,annual_eligible_hours numeric,annual_taken_hours numeric,request_fingerprint text,
 created_at timestamptz default clock_timestamp());
create function private.leave_accrual_request_fingerprint(uuid,date) returns text language sql stable as $$ select 'synthetic-fingerprint'::text; $$;
\ir ../supabase/migrations/20260922140000_projected_annual_leave_request_limit.sql

-- All following rows are disposable synthetic fixtures.
delete from public.leave_requests;
insert into private.employee_annual_leave_balances values('10000000-0000-4000-8000-000000000001',5,'2026-10-02',false);
insert into private.leave_accrual_policies(person_id,effective_from,weekly_hours,weekdays,annual_weeks,enabled)
 values('10000000-0000-4000-8000-000000000001','2026-10-03',38,array[1,2,3,4,5],4,true);
do $$declare person uuid:='10000000-0000-4000-8000-000000000001'; result jsonb; before_snapshot numeric; begin
  result:=public.preview_annual_leave_balance(person,'2026-10-12');
  assert result->>'projectedDate'='2026-10-12';
  assert result->>'throughDate'='2026-10-11';
  assert abs((result->>'accruedHours')::numeric-38::numeric*4/52)<0.000000001;
  assert (result->'terms'->0->>'eligibleHours')::numeric=38;
  -- Banked 5h is insufficient today, but projected 7.923h permits one day.
  insert into public.leave_requests(employee_person_id,start_date,end_date) values(person,'2026-10-12','2026-10-12');
  begin
    insert into public.leave_requests(employee_person_id,start_date,end_date,business_days) values(person,'2026-10-12','2026-10-13',2);
    raise exception 'TEST: exceeded projected balance';
  exception when sqlstate '22023' then assert sqlerrm like 'Not enough balance.%'; end;
  -- All approved commitments after the snapshot remain reserved, even later bookings.
  insert into public.leave_requests(employee_person_id,start_date,end_date,record_origin,status,hours) values(person,'2026-12-01','2026-12-01','historical_import','approved',2);
  result:=public.preview_annual_leave_balance(person,'2026-10-12');
  assert (result->>'approvedHours')::numeric=2;
  assert (result->>'availableHours')::numeric<7.6;
  -- One approved unpaid day removes one scheduled day's accrual, not a whole week.
  insert into public.leave_requests(employee_person_id,start_date,end_date,record_origin,status,request_type_label) values(person,'2026-10-05','2026-10-05','historical_import','approved','Unpaid leave');
  result:=public.preview_annual_leave_balance(person,'2026-10-12');
  assert (result->'terms'->0->>'eligibleHours')::numeric=30.4;
  -- A reviewed day overrides the assumption, and extra usage is deducted once.
  insert into private.leave_accrual_day_reviews(person_id,service_date,annual_eligible_hours,annual_taken_hours,request_fingerprint)
    values(person,'2026-10-05',7.6,1,'synthetic-fingerprint');
  result:=public.preview_annual_leave_balance(person,'2026-10-12');
  assert (result->'terms'->0->>'eligibleHours')::numeric=38;
  assert (result->>'otherTakenHours')::numeric=1;
  update private.leave_accrual_day_reviews set request_fingerprint='stale';
  assert public.preview_annual_leave_balance(person,'2026-10-12')->>'status'='unavailable';
  delete from private.leave_accrual_day_reviews;
  delete from public.leave_requests;
  -- Employment end stops forecast credit; no accrual during the requested leave.
  update private.employee_directory_details set scheduled_employment_end_date='2026-10-07';
  result:=public.preview_annual_leave_balance(person,'2026-10-12');
  assert (result->'terms'->0->>'eligibleHours')::numeric=22.8;
  update private.employee_directory_details set scheduled_employment_end_date=null;
  assert (public.preview_annual_leave_balance(person,'2026-10-05')->>'accruedHours')::numeric=0;
  -- Effective-dated part-time/higher entitlements do not assume 38h or four weeks.
  insert into private.leave_accrual_policies(person_id,effective_from,weekly_hours,weekdays,annual_weeks,enabled)
    values(person,'2026-10-07',20,array[1,2,3,4,5],5,true);
  result:=public.preview_annual_leave_balance(person,'2026-10-12');
  assert jsonb_array_length(result->'terms')=2;
  assert abs((result->>'accruedHours')::numeric-(15.2*4+12*5)/52)<0.000000001;
  -- Missing policies never invent future hours; existing banked allowance remains.
  delete from private.leave_accrual_policies;
  result:=public.preview_annual_leave_balance(person,'2026-10-12');
  assert result->>'status'='banked_only';
  assert (result->>'availableHours')::numeric=5;
  begin
    insert into public.leave_requests(employee_person_id) values(person);
    raise exception 'TEST: invented accrual for missing policy';
  exception when sqlstate '22023' then assert sqlerrm like 'Future accrual could not be confirmed%'; end;
  begin
    perform public.preview_annual_leave_balance('10000000-0000-4000-8000-000000000002','2026-10-12');
    raise exception 'TEST: unrelated employee projection leaked';
  exception when sqlstate '42501' then null; end;
  assert not has_function_privilege('authenticated','private.project_annual_leave_balance(uuid,date)','EXECUTE');
  assert not has_function_privilege('anon','public.preview_annual_leave_balance(uuid,date,uuid)','EXECUTE');
  assert (select hours from private.employee_annual_leave_balances where person_id=person)=5, 'Preview never rewrites Xero';
end$$;
