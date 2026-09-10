-- Run after the security notification bootstrap, only in a disposable database.
\set ON_ERROR_STOP on
do $$begin
  assert (current_database()='security_test' or current_database() ~ '^leave_email_test(_[0-9]+)?$'), 'Disposable database only';
  assert to_regprocedure('private.calculate_employee_leave_accrual(uuid,date)') is null, 'Never replace real accrual';
end$$;
create table private.employee_annual_leave_balances(person_id uuid primary key,hours numeric,is_example boolean);
create table private.employee_sick_leave_balances(person_id uuid primary key,hours numeric);
-- Stub the already-tested accrual engine to exercise its email boundary precisely.
create function private.calculate_employee_leave_accrual(uuid,date) returns jsonb language plpgsql as $$
begin
  assert $2=(now() at time zone 'Australia/Melbourne')::date-1,'Completed days only';
  return jsonb_build_object('status',coalesce(nullif(current_setting('test.accrual_status',true),''),'current'),
    'annualExactHours',28.4621,'personalExactHours',40.9297,'annualHours',28.46,'personalHours',40.93);
end$$;
\ir ../supabase/migrations/20260911010000_leave_email_balance_snapshot.sql
begin;
insert into public.internal_org_people values('10000000-0000-4000-8000-000000000001','Synthetic Employee','mam');
insert into private.employee_annual_leave_balances values('10000000-0000-4000-8000-000000000001',20,false);
insert into private.employee_sick_leave_balances values('10000000-0000-4000-8000-000000000001',30);
do $$declare person uuid:='10000000-0000-4000-8000-000000000001';s jsonb;begin
  s:=private.leave_notification_balance_snapshot(person,'Annual leave');
  assert s->>'kind'='annual' and s->>'status'='current' and (s->>'hours')::numeric=28.4621,'Use exact accrued annual balance';
  s:=private.leave_notification_balance_snapshot(person,'Sick leave');
  assert s->>'kind'='sick' and (s->>'hours')::numeric=40.9297;
  assert private.leave_notification_balance_snapshot(person,'Carer''s leave')=s,'Shared sick/personal entitlement';
  perform set_config('test.accrual_status','needs_review',true);
  s:=private.leave_notification_balance_snapshot(person,'Annual leave');
  assert s->>'status'='check_balance' and s->>'hours' is null,'No precise balance during review hold';
  perform set_config('test.accrual_status','current',true);
  update private.employee_annual_leave_balances set is_example=true;
  assert private.leave_notification_balance_snapshot(person,'Annual leave')->>'hours' is null,'Example balances are unavailable';
  update private.employee_annual_leave_balances set is_example=false;
  delete from private.employee_sick_leave_balances;
  assert private.leave_notification_balance_snapshot(person,'Sick leave')->>'hours' is null,'Missing sick balance is not zero';
  assert not has_function_privilege('authenticated','private.leave_notification_balance_snapshot(uuid,text)','execute');
  assert not has_function_privilege('service_role','private.leave_notification_balance_snapshot(uuid,text)','execute');
end$$;
insert into public.leave_requests(id,employee_person_id,status) values
('20000000-0000-4000-8000-000000000010','10000000-0000-4000-8000-000000000001','submitted');
do $$declare snapshot_payload jsonb;begin
  select o.payload into snapshot_payload from private.leave_notification_outbox o where request_id='20000000-0000-4000-8000-000000000010';
  assert (snapshot_payload->'leaveBalance'->>'hours')::numeric=28.4621,'New requests capture balances';
  assert snapshot_payload->>'days'='2' and snapshot_payload->>'hours' is null;
  perform set_config('test.accrual_status','needs_review',true);
  assert (select o.payload=snapshot_payload from private.leave_notification_outbox o where request_id='20000000-0000-4000-8000-000000000010'),'Snapshot stable after balance changes';
end$$;
update public.leave_requests set status='approved' where id='20000000-0000-4000-8000-000000000010';
do $$begin
 assert (select not (payload ? 'leaveBalance') from private.leave_notification_outbox where request_id='20000000-0000-4000-8000-000000000010' and event='leave-approved'),'No misleading second subtraction after approval';
 assert (select hours=20 from private.employee_annual_leave_balances),'Payroll unchanged';
end$$;
rollback;
