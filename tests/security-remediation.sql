\set ON_ERROR_STOP on
begin;
create function pg_temp.assert(ok boolean,label text) returns void language plpgsql as $$
begin if ok is not true then raise exception 'Assertion failed: %',label; end if; end $$;
insert into public.internal_org_people values('10000000-0000-4000-8000-000000000001','Synthetic Employee','mam');
insert into public.leave_requests(id,employee_person_id,status) values
  ('20000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','submitted');
select pg_temp.assert((select count(*)=1 from private.leave_notification_outbox),'direct SQL/RPC mutation enqueues without web action');
savepoint mutation;
update public.leave_requests set status='approved';
select pg_temp.assert((select count(*)=2 from private.leave_notification_outbox),'approval queued');
rollback to mutation;
select pg_temp.assert((select count(*)=1 from private.leave_notification_outbox),'rollback also rolls back mail event');
insert into private.leave_balance_approvals values('20000000-0000-4000-8000-000000000001');
update public.leave_requests set manager_note=E'Line one\nLine two';
insert into public.leave_request_events values('20000000-0000-4000-8000-000000000001','updated');
insert into public.leave_request_events values('20000000-0000-4000-8000-000000000001','updated');
select pg_temp.assert((select count(*)=1 from private.leave_notification_outbox where event='leave-conditionally-approved'),'conditional once');
select pg_temp.assert((select payload->>'managerNote'=E'Line one\nLine two' from private.leave_notification_outbox where event='leave-conditionally-approved'),'conditional snapshots note');
update public.leave_requests set status='approved';
update public.leave_requests set status='cancelled';
select pg_temp.assert((select (payload->>'wasApproved')::boolean from private.leave_notification_outbox where event='leave-cancelled'),'approved cancellation preserved');
update public.leave_requests set reason='later edit';
select pg_temp.assert((select count(*)=4 from private.leave_notification_outbox),'ordinary edit does not resend');
insert into public.leave_requests(id,record_origin,status) values('20000000-0000-4000-8000-000000000002','historical_import','approved');
select pg_temp.assert((select count(*)=4 from private.leave_notification_outbox),'historical insert is silent');
update public.leave_requests set status='rejected' where record_origin='historical_import';
update public.leave_requests set status='approved' where record_origin='historical_import';
select pg_temp.assert((select count(*)=4 from private.leave_notification_outbox),'historical corrections never send new decision notices');
update public.leave_requests set status='cancelled' where record_origin='historical_import';
select pg_temp.assert((select count(*)=5 from private.leave_notification_outbox),'historical approved cancellation still notifies');
select pg_temp.assert(not has_function_privilege('authenticated','public.claim_leave_notification_outbox(uuid,integer)','execute'),'employee cannot claim');
select pg_temp.assert(not has_function_privilege('anon','public.finish_leave_notification_outbox(uuid,uuid,boolean)','execute'),'anon cannot ack');
select pg_temp.assert(not has_table_privilege('authenticated','private.leave_notification_outbox','select'),'no private payload leak');
select pg_temp.assert(has_function_privilege('service_role','public.claim_leave_notification_outbox(uuid,integer)','execute'),'worker can claim');
create temp table claimed as select * from public.claim_leave_notification_outbox('20000000-0000-4000-8000-000000000001',50);
select pg_temp.assert((select count(*)=1 from claimed),'per-request ordering claims oldest only');
select pg_temp.assert((select count(*)=0 from public.claim_leave_notification_outbox('20000000-0000-4000-8000-000000000001',50)),'live lease excludes duplicate worker');
select pg_temp.assert(not public.finish_leave_notification_outbox(delivery_id,gen_random_uuid(),true),'wrong token rejected') from claimed;
select pg_temp.assert(public.finish_leave_notification_outbox(delivery_id,claim_token,false),'failed delivery released') from claimed;
select pg_temp.assert((select count(*)=0 from public.claim_leave_notification_outbox('20000000-0000-4000-8000-000000000001',50)),'backoff blocks early retry and later events');
update private.leave_notification_outbox set next_attempt_at=now()-interval '1 minute' where id in(select delivery_id from claimed);
create temp table retried as select * from public.claim_leave_notification_outbox('20000000-0000-4000-8000-000000000001',50);
select pg_temp.assert((select a.delivery_id=b.delivery_id and a.claim_token<>b.claim_token and a.payload=b.payload from claimed a,retried b),'retry same event/payload new lease');
select pg_temp.assert(public.finish_leave_notification_outbox(delivery_id,claim_token,true),'confirmed receipt completes') from retried;
select pg_temp.assert((select count(*)=1 from public.claim_leave_notification_outbox('20000000-0000-4000-8000-000000000001',50)),'next event unblocked');
select set_config('test.actor','30000000-0000-4000-8000-000000000001',true);
insert into private.subscription_credential_access_grants values('40000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001',null);
delete from private.subscription_credential_access_grants where auth_user_id='40000000-0000-4000-8000-000000000001';
select pg_temp.assert((select count(*)=2 and bool_and(actor_user_id='30000000-0000-4000-8000-000000000001') and bool_and(auth_user_id='40000000-0000-4000-8000-000000000001') from private.subscription_credential_grant_changes),'grant and revoke identities retained');
select pg_temp.assert(not has_table_privilege('authenticated','private.subscription_credential_grant_changes','delete'),'audit not writable by employee');
do $$ begin
  delete from public.leave_requests where id='20000000-0000-4000-8000-000000000001';
  raise exception 'Pending source deletion was not blocked';
exception when sqlstate '55000' then null; end $$;
update private.leave_notification_outbox set delivered_at=now() where request_id='20000000-0000-4000-8000-000000000001';
delete from public.leave_requests where id='20000000-0000-4000-8000-000000000001';
select pg_temp.assert((select count(*)=4 from private.leave_notification_outbox where request_id is null),'completed source can be purged without destroying receipt history');
create or replace function public.resolve_leave_notification_manager(uuid) returns table(manager_email text)
  language sql as $$ select 'invalid'::text $$;
create temp table missing_recipient as select * from public.claim_leave_notification_outbox('20000000-0000-4000-8000-000000000002',50);
select pg_temp.assert((select count(*)=1 and bool_and(payload is null) from missing_recipient),'invalid recipient surfaced as failed claim');
select pg_temp.assert((select delivery_payload is null and last_error='missing_recipient' from private.leave_notification_outbox where request_id='20000000-0000-4000-8000-000000000002'),'bad address not frozen');
create or replace function public.resolve_leave_notification_manager(uuid) returns table(manager_email text)
  language sql as $$ select 'manager@example.test'::text $$;
create or replace function public.resolve_leave_notification_employee_recipients(uuid) returns table(employee_emails text[])
  language sql as $$ select array[]::text[] $$;
insert into public.leave_requests(id,status) values('20000000-0000-4000-8000-000000000003','submitted');
select pg_temp.assert((select count(*)=1 and bool_and(payload->>'managerEmail'='manager@example.test')
  from public.claim_leave_notification_outbox('20000000-0000-4000-8000-000000000003',50)),'manager still receives submission without employee email');
insert into private.leave_balance_approvals values('20000000-0000-4000-8000-000000000003');
update public.leave_requests set status='cancelled' where id='20000000-0000-4000-8000-000000000003';
select pg_temp.assert((select (payload->>'wasApproved')::boolean from private.leave_notification_outbox
  where request_id='20000000-0000-4000-8000-000000000003' and event='leave-cancelled'),'conditional approval cancellation retains Accounts notification');
rollback;
