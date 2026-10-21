\set ON_ERROR_STOP on
begin;
\ir sql-test-auth.sql
insert into auth.users(id,email,email_confirmed_at) values
('93000000-0000-4000-8000-000000000001','purge-admin@example.test',now()),
('93000000-0000-4000-8000-000000000002','purge-fake@example.test',now()),
('93000000-0000-4000-8000-000000000003','purge-real@example.test',now());
update auth.users set banned_until=now()+interval '1 day' where id='93000000-0000-4000-8000-000000000002';
insert into public.profiles(id,full_name,app_role,login_name,account_status,credentials_valid_after,disabled_at)
select id,case when id::text like '%002' then 'Confirmed Fake Synthetic' else 'Other Synthetic' end,
case when id::text like '%001' then 'system_admin' else 'employee' end,
email,case when id::text like '%002' then 'disabled' else 'active' end,now()-interval '1 day',case when id::text like '%002' then now() else null end
from auth.users where id::text like '93000000%';
insert into public.internal_org_people(id,full_name,company_key,position_title,auth_user_id,is_active)
select id,full_name,'mam','Synthetic role',id,true from public.profiles where id::text like '93000000%';
insert into private.employee_directory_details(person_id,first_name,last_name)
values ('93000000-0000-4000-8000-000000000002','Confirmed Fake','Synthetic');
insert into private.employee_check_in_reminders(id,person_id,milestone,reminder_sequence,due_date,notify_date,delivery_status)
select ('93100000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,'93000000-0000-4000-8000-000000000002','2_week','initial',date '2026-02-01'+n,date '2026-01-25'+n,case when n<=5 then 'completed' else 'superseded' end from generate_series(1,11) n;
insert into private.employee_check_in_reminders(id,person_id,milestone,reminder_sequence,due_date,notify_date,delivery_status)
values ('93100000-0000-4000-8000-000000000100','93000000-0000-4000-8000-000000000003','2_week','initial',date '2026-02-01',date '2026-01-25','completed');
insert into private.employee_directory_audit_events(person_id,actor_user_id,event_type,changed_fields)
select '93000000-0000-4000-8000-000000000002','93000000-0000-4000-8000-000000000001','updated',array['first_name'] from generate_series(1,7);
insert into private.employee_annual_leave_balances(person_id,hours,as_of,is_example,updated_by)
values ('93000000-0000-4000-8000-000000000002',8,date '2026-01-01',false,'93000000-0000-4000-8000-000000000001');
insert into private.annual_leave_balance_history(person_id,hours,as_of,is_example,actor_user_id)
values ('93000000-0000-4000-8000-000000000002',8,date '2026-01-01',false,'93000000-0000-4000-8000-000000000001');
insert into private.employee_new_starter_day_one_reminders(person_id,commencement_date,notify_date,status)
values ('93000000-0000-4000-8000-000000000002',date '2026-02-01',date '2026-01-30','superseded');
select pg_temp.set_test_actor('93000000-0000-4000-8000-000000000001');
set local role authenticated;
do $$ begin
begin perform public.preview_confirmed_test_identity_purge('93000000-0000-4000-8000-000000000002','93000000-0000-4000-8000-000000000002','equipsy','Confirmed Fake Synthetic','purge-fake@example.test',1,1); raise exception 'Wrong company accepted'; exception when check_violation then null; end;
begin perform public.preview_confirmed_test_identity_purge('93000000-0000-4000-8000-000000000002','93000000-0000-4000-8000-000000000002','mam','Other Synthetic','purge-fake@example.test',1,1); raise exception 'Wrong full name accepted'; exception when check_violation then null; end;
begin perform public.preview_confirmed_test_identity_purge('93000000-0000-4000-8000-000000000002','93000000-0000-4000-8000-000000000002','mam','Confirmed Fake Synthetic','purge-fake@example.test',2,1); raise exception 'Stale version accepted'; exception when serialization_failure then null; end;
begin perform public.prepare_confirmed_test_identity_purge('93000000-0000-4000-8000-000000000002','93000000-0000-4000-8000-000000000002','mam','Confirmed Fake Synthetic','purge-fake@example.test',1,1,repeat('a',64),false,true); raise exception 'Missing test confirmation accepted'; exception when check_violation then null; end;
begin perform public.prepare_confirmed_test_identity_purge('93000000-0000-4000-8000-000000000002','93000000-0000-4000-8000-000000000002','mam','Confirmed Fake Synthetic','purge-fake@example.test',1,1,repeat('a',64),true,true); raise exception 'Unreviewed manifest accepted'; exception when serialization_failure then null; end;
begin perform * from private.confirmed_test_identity_purges; raise exception 'Private cleanup audit exposed'; exception when insufficient_privilege then null; end;
end $$;
do $$ declare result jsonb; begin
result:=public.preview_confirmed_test_identity_purge('93000000-0000-4000-8000-000000000002','93000000-0000-4000-8000-000000000002','mam','Confirmed Fake Synthetic','purge-fake@example.test',1,1);
assert result->>'manifest_hash' is not null, 'Missing reviewed manifest';
end $$;
reset role;
insert into public.internal_org_people(id,full_name,company_key,position_title,is_active)
values ('93000000-0000-4000-8000-000000000004','Directory Only Fake Synthetic','mam','Synthetic role',false);
insert into public.internal_org_people(id,full_name,company_key,position_title,is_active) values
('93000000-0000-4000-8000-000000000005','Directory Active Synthetic','mam','Synthetic role',true),
('93000000-0000-4000-8000-000000000006','Directory','mam','Synthetic short name',false);
insert into private.employee_check_in_reminders(id,person_id,milestone,reminder_sequence,due_date,notify_date,delivery_status)
select ('93400000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,'93000000-0000-4000-8000-000000000004','2_week','initial',date '2026-02-01'+n,date '2026-01-25'+n,'completed' from generate_series(1,5) n;
set local role authenticated;
do $$ declare result jsonb; begin
result:=public.preview_confirmed_test_identity_purge('93000000-0000-4000-8000-000000000004',null,'mam','Directory Only Fake Synthetic',null,1,null);
assert result->>'manifest_hash' is not null, 'Directory-only manifest missing';
end $$;
reset role;
insert into private.employee_directory_audit_events(person_id,actor_user_id,event_type,changed_fields)
values ('93000000-0000-4000-8000-000000000004','93000000-0000-4000-8000-000000000001','created',array['first_name']);
set local role authenticated;
do $$ declare reviewed jsonb; receipt uuid; begin
reviewed:=public.preview_confirmed_test_identity_purge('93000000-0000-4000-8000-000000000004',null,'mam','Directory Only Fake Synthetic',null,1,null);
receipt:=public.prepare_confirmed_test_identity_purge('93000000-0000-4000-8000-000000000004',null,'mam','Directory Only Fake Synthetic',null,1,null,reviewed->>'manifest_hash',true,true);
assert receipt is not null, 'Receipt missing';
end $$;
reset role;
do $$ begin
assert (select count(*)=2 from public.internal_org_people where id in ('93000000-0000-4000-8000-000000000005','93000000-0000-4000-8000-000000000006')), 'Real shared-first-name or short-name identity changed';
assert not exists(select 1 from private.employee_check_in_reminders where person_id='93000000-0000-4000-8000-000000000004'), 'Directory-only test history remains';
assert not exists(select 1 from public.internal_org_people where id='93000000-0000-4000-8000-000000000004'), 'Directory-only fake remains operational';
assert (select phase='complete' and auth_user_id is null and jsonb_array_length(retained_audit->'private.employee_directory_audit_events')=1 from private.confirmed_test_identity_purges where person_id='93000000-0000-4000-8000-000000000004'), 'No-auth completion/audit retention failed';
assert exists(select 1 from public.internal_org_people where id='93000000-0000-4000-8000-000000000003'), 'Real synthetic employee removed';
begin
insert into public.internal_org_people(id,full_name,company_key,position_title,is_active)
values ('93000000-0000-4000-8000-000000000004','Directory Only Fake Synthetic','mam','Synthetic role',false);
raise exception 'Retired test identity recreated';
exception when check_violation then null; end;
end $$;
do $$ declare checked jsonb; begin
begin
insert into private.employee_work_schedule_change_requests(id,person_id,submitted_by_user_id,requested_working_weekdays,request_reason)
values ('93300000-0000-4000-8000-000000000001','93000000-0000-4000-8000-000000000002','93000000-0000-4000-8000-000000000001',array[1]::smallint[],'Synthetic schedule request');
insert into private.employee_work_schedule_change_events(request_id,person_id,actor_user_id,event_type,to_working_weekdays,reason)
values ('93300000-0000-4000-8000-000000000001','93000000-0000-4000-8000-000000000002','93000000-0000-4000-8000-000000000001','submitted',array[1]::smallint[],'Synthetic audit');
begin delete from private.employee_work_schedule_change_events where request_id='93300000-0000-4000-8000-000000000001';
raise exception 'Immutable schedule audit deletion permitted';
exception when insufficient_privilege then assert sqlerrm='Work-schedule audit events are append-only.', 'Immutable protection changed'; end;
perform public.preview_confirmed_test_identity_purge('93000000-0000-4000-8000-000000000002','93000000-0000-4000-8000-000000000002','mam','Confirmed Fake Synthetic','purge-fake@example.test',1,1);
raise exception 'Immutable schedule reference accepted';
exception when foreign_key_violation then assert sqlerrm like '%employee_work_schedule_change_events%', 'Wrong immutable blocker'; end;
begin
update private.employee_onboarding_credentials set claim_expires_at=now()+interval '5 minutes',claimed_personal_email='synthetic-provider-context@example.test' where person_id='93000000-0000-4000-8000-000000000002';
perform public.preview_confirmed_test_identity_purge('93000000-0000-4000-8000-000000000002','93000000-0000-4000-8000-000000000002','mam','Confirmed Fake Synthetic','purge-fake@example.test',1,1);
raise exception 'Partial onboarding provider context accepted';
exception when foreign_key_violation then assert sqlerrm like '%onboarding delivery evidence%', 'Wrong onboarding provider blocker'; end;
begin
update auth.users set raw_user_meta_data=jsonb_build_object('linked_test_uuid','93000000-0000-4000-8000-000000000002') where id='93000000-0000-4000-8000-000000000003';
perform public.preview_confirmed_test_identity_purge('93000000-0000-4000-8000-000000000002','93000000-0000-4000-8000-000000000002','mam','Confirmed Fake Synthetic','purge-fake@example.test',1,1);
raise exception 'Cross-account Auth metadata reference accepted';
exception when foreign_key_violation then assert sqlerrm like '%auth.users%', 'Wrong Auth metadata blocker'; end;
begin
update public.internal_org_people set created_by='93000000-0000-4000-8000-000000000002' where id='93000000-0000-4000-8000-000000000003';
perform public.preview_confirmed_test_identity_purge('93000000-0000-4000-8000-000000000002','93000000-0000-4000-8000-000000000002','mam','Confirmed Fake Synthetic','purge-fake@example.test',1,1);
raise exception 'Real actor provenance reference accepted';
exception when foreign_key_violation then assert sqlerrm like '%public.internal_org_people%', 'Wrong real-record blocker'; end;
begin
update private.employee_check_in_reminders set claim_token=gen_random_uuid(),claimed_at=now() where id='93100000-0000-4000-8000-000000000001';
perform public.preview_confirmed_test_identity_purge('93000000-0000-4000-8000-000000000002','93000000-0000-4000-8000-000000000002','mam','Confirmed Fake Synthetic','purge-fake@example.test',1,1);
raise exception 'Claimed reminder accepted';
exception when foreign_key_violation then assert sqlerrm like '%claimed/attempted/provider%', 'Wrong queue blocker'; end;
begin
insert into private.openclaw_leave_receipts(key,body) values(repeat('b',64),jsonb_build_object('indirect_reminder','93100000-0000-4000-8000-000000000001'));
perform public.preview_confirmed_test_identity_purge('93000000-0000-4000-8000-000000000002','93000000-0000-4000-8000-000000000002','mam','Confirmed Fake Synthetic','purge-fake@example.test',1,1);
raise exception 'Indirect reminder receipt accepted';
exception when foreign_key_violation then assert sqlerrm like '%openclaw_leave_receipts%', 'Wrong indirect blocker'; end;
end $$;
insert into public.leave_requests(id,user_id,employee_person_id,leave_type,request_type_label,start_date,end_date,status,submitted_at,business_days,reason)
select ('93200000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,'93000000-0000-4000-8000-000000000002','93000000-0000-4000-8000-000000000002','unpaid','Unpaid leave',date '2026-11-01'+n,date '2026-11-01'+n,'cancelled',now(),1,'Synthetic cancelled leave' from generate_series(1,2) n;
set local role authenticated;
do $$ declare reviewed jsonb; receipt uuid; state jsonb; begin
reviewed:=public.preview_confirmed_test_identity_purge('93000000-0000-4000-8000-000000000002','93000000-0000-4000-8000-000000000002','mam','Confirmed Fake Synthetic','purge-fake@example.test',1,1);
receipt:=public.prepare_confirmed_test_identity_purge('93000000-0000-4000-8000-000000000002','93000000-0000-4000-8000-000000000002','mam','Confirmed Fake Synthetic','purge-fake@example.test',1,1,reviewed->>'manifest_hash',true,true);
state:=public.claim_confirmed_test_identity_auth_delete(receipt);
assert state->>'phase'='auth_delete_started' and (state->>'delete_authorized')::boolean, 'Auth deletion not durably armed';
state:=public.claim_confirmed_test_identity_auth_delete(receipt);
assert not (state->>'delete_authorized')::boolean, 'Blind Auth retry authorized';
begin
perform public.complete_confirmed_test_identity_purge(receipt);
raise exception 'Completion claimed while Auth still exists';
exception when object_not_in_prerequisite_state then null; end;
end $$;
reset role;
do $$ begin
assert (select count(*)=0 from public.leave_requests where employee_person_id='93000000-0000-4000-8000-000000000002'), 'Cancelled test leave remains in reporting';
assert (select count(*)=0 from private.employee_check_in_reminders where person_id='93000000-0000-4000-8000-000000000002'), 'Test check-ins remain in reporting';
assert (select count(*)=1 from private.employee_check_in_reminders where person_id='93000000-0000-4000-8000-000000000003'), 'Real check-in changed';
assert (select jsonb_array_length(retained_audit->'private.employee_directory_audit_events')=7 from private.confirmed_test_identity_purges where person_id='93000000-0000-4000-8000-000000000002'), 'Original linked directory audits not retained';
assert exists(select 1 from auth.users where id='93000000-0000-4000-8000-000000000002'), 'SQL deleted Auth user';
assert not exists(select 1 from public.internal_org_people where id='93000000-0000-4000-8000-000000000002'), 'Linked fake person operational';
assert not exists(select 1 from public.profiles where id='93000000-0000-4000-8000-000000000002'), 'Linked fake profile operational';
end $$;
do $$ declare dataset text; projection jsonb; begin
foreach dataset in array array['employees','leave_requests','leave_events','check_ins','check_in_events'] loop
projection:=public.analytics_dashboard_dataset(dataset,null,null,1000,0);
assert position('93000000-0000-4000-8000-000000000002' in projection::text)=0, 'Linked test identity still contributes to dashboard dataset';
assert position('93000000-0000-4000-8000-000000000004' in projection::text)=0, 'Directory-only test identity still contributes to dashboard dataset';
assert position('Confirmed Fake Synthetic' in projection::text)=0, 'Test name remains in dashboard';
end loop;
assert (public.analytics_dashboard_dataset('check_ins',null,null,1000,0)->'pagination'->>'total')::integer=1, 'Real check-in reporting changed';
end $$;
create schema synthetic_external;
create table synthetic_external.unreviewed_projection(person_id uuid references public.internal_org_people(id) on delete cascade);
set local role authenticated;
do $$ begin
begin
perform public.preview_confirmed_test_identity_purge('93000000-0000-4000-8000-000000000002','93000000-0000-4000-8000-000000000002','mam','Confirmed Fake Synthetic','purge-fake@example.test',1,1);
raise exception 'Schema drift accepted';
exception when object_not_in_prerequisite_state then null; end;
end $$;
reset role;
rollback;
