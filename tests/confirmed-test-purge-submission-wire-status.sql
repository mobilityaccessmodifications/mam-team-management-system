\set ON_ERROR_STOP on
begin;
\ir sql-test-auth.sql
insert into auth.users(id,email,email_confirmed_at) values
('92abcdef-0000-4000-8000-000000000001','wire-admin@example.test',now()),
('92abcdef-0000-4000-8000-000000000002','wire-employee@example.test',now());
insert into public.profiles(id,full_name,app_role,login_name,account_status,credentials_valid_after) values
('92abcdef-0000-4000-8000-000000000001','Wire Admin Synthetic','system_admin','wire-admin@example.test','active',now()-interval '1 day'),
('92abcdef-0000-4000-8000-000000000002','Wire Employee Synthetic','employee','wire-employee@example.test','active',now()-interval '1 day');
insert into public.internal_org_people(id,full_name,company_key,position_title,auth_user_id,is_active) values
('92abcdef-0000-4000-8000-000000000001','Wire Admin Synthetic','mam','Synthetic reviewer','92abcdef-0000-4000-8000-000000000001',true),
('92abcdef-0000-4000-8000-000000000002','Wire Employee Synthetic','mam','Synthetic applicant','92abcdef-0000-4000-8000-000000000002',true);
insert into private.leave_approval_grants(reviewer_user_id,scope_kind,reviewer_label,priority)
values ('92abcdef-0000-4000-8000-000000000001','global','Wire Admin Synthetic',100);
select pg_temp.set_test_actor('92abcdef-0000-4000-8000-000000000002');
set local role authenticated;
do $$ declare submission uuid:=gen_random_uuid(); produced record; replayed record; begin
select * into strict produced from public.submit_leave_request_once(submission,null,'Unpaid leave',date '2027-01-11',date '2027-01-11');
assert produced.status='Pending' and produced.approval_required, 'Own submission must return the literal Pending wire status';
select * into strict replayed from public.submit_leave_request_once(submission,null,'Unpaid leave',date '2027-01-11',date '2027-01-11');
assert to_jsonb(replayed)=to_jsonb(produced), 'Receipt replay must preserve the wire DTO';
end $$;
reset role;
select pg_temp.set_test_actor('92abcdef-0000-4000-8000-000000000001');
set local role authenticated;
do $$ declare produced record; begin
select * into strict produced from public.submit_leave_request_once(gen_random_uuid(),'92abcdef-0000-4000-8000-000000000002','Unpaid leave',date '2027-01-12',date '2027-01-12');
assert produced.status='Pending' and produced.approval_required, 'Selected submission must return the literal Pending wire status';
end $$;
reset role;
do $$ declare receipt record; begin
assert (select count(*)=2 from private.leave_submission_receipts), 'Each actual submission must write one receipt';
for receipt in select * from private.leave_submission_receipts loop
assert (select array_agg(key order by key) from jsonb_object_keys(receipt.result) key)=array['approval_required','assigned_reviewer_label','id','status']::text[], 'Producer receipt keys changed';
assert receipt.result#>>'{status}'='Pending' and jsonb_typeof(receipt.result->'approval_required')='boolean', 'Producer receipt changed status or boolean wire type';
assert receipt.input_hash ~ '^[0-9a-f]{64}$', 'Producer receipt input hash changed';
assert exists(select 1 from public.leave_requests l where l.id=(receipt.result->>'id')::uuid and l.status='submitted'
  and l.user_id='92abcdef-0000-4000-8000-000000000002' and l.employee_person_id='92abcdef-0000-4000-8000-000000000002'), 'Wire Pending must remain distinct from owned leave submitted storage state';
assert exists(select 1 from public.leave_request_events e where e.leave_request_id=(receipt.result->>'id')::uuid and e.event_type='submitted' and e.actor_user_id=receipt.actor_user_id), 'Producer receipt actor must match submission audit actor';
end loop;
assert (select count(distinct actor_user_id)=2 from private.leave_submission_receipts), 'Own and selected submission actor paths not exercised';
end $$;
rollback;
