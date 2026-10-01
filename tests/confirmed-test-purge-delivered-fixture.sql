\ir sql-test-auth.sql
insert into auth.users(id,email,email_confirmed_at,banned_until) values
('91abcdef-0000-4000-8000-000000000001','delivered-admin@example.test',now(),null),
('91abcdef-0000-4000-8000-000000000002','delivered-fake@example.test',now(),now()+interval '1 day');
insert into public.profiles(id,full_name,app_role,login_name,account_status,credentials_valid_after,disabled_at) values
('91abcdef-0000-4000-8000-000000000001','Delivered Admin Synthetic','system_admin','delivered-admin@example.test','active',now()-interval '1 day',null),
('91abcdef-0000-4000-8000-000000000002','Delivered Fake Synthetic','employee','delivered-fake@example.test','disabled',now()-interval '1 day',now());
insert into public.internal_org_people(id,full_name,company_key,position_title,auth_user_id,is_active) values
('91abcdef-0000-4000-8000-000000000002','Delivered Fake Synthetic','mam','Synthetic','91abcdef-0000-4000-8000-000000000002',true),
('91abcdef-0000-4000-8000-000000000003','Delivered Fake Synthetic','mam','Unrelated homonym',null,false);
insert into public.leave_requests(id,user_id,employee_person_id,leave_type,request_type_label,start_date,end_date,status,submitted_at,business_days,record_origin)
select ('91abcdef-0000-4000-8001-'||lpad(n::text,12,'0'))::uuid,'91abcdef-0000-4000-8000-000000000002','91abcdef-0000-4000-8000-000000000002','unpaid','Unpaid leave',date '2026-11-10'+n,date '2026-11-10'+n,'cancelled',now(),1,'portal' from generate_series(1,2) n;
insert into private.leave_notification_outbox(request_id,event,payload)
select request_id,'leave-submitted',payload||jsonb_build_object('event','leave-submitted') from private.leave_notification_outbox
where request_id in ('91abcdef-0000-4000-8001-000000000001','91abcdef-0000-4000-8001-000000000002');
update private.leave_notification_outbox set attempts=1,delivered_at=timestamptz '2026-01-10 02:00:00+00',created_at=timestamptz '2026-01-10 01:00:00+00',claim_token=null,claimed_until=null,
delivery_payload=payload||jsonb_build_object('managerEmail','reviewer@example.test','employeeEmail','applicant@example.test','employeeEmails',jsonb_build_array('applicant@example.test'))
where request_id in ('91abcdef-0000-4000-8001-000000000001','91abcdef-0000-4000-8001-000000000002');
insert into private.leave_submission_receipts(actor_user_id,submission_key,input_hash,result,created_at)
select '91abcdef-0000-4000-8000-000000000002',gen_random_uuid(),repeat('a',64),jsonb_build_object('approval_required',true,'assigned_reviewer_label','Synthetic reviewer','id',id,'status','Pending'),timestamptz '2026-01-10 00:00:00+00' from public.leave_requests;
insert into private.notification_delivery_receipts(event_key,state,delivery_token,recipient,cc,provider_receipt,created_at,sent_at)
select 'leave:'||q.request_id::text||':'||q.event||':'||left(encode(extensions.digest(q.id::text||case when q.event='leave-submitted' then ':'||audience else '' end,'sha256'),'hex'),24),
'sent',gen_random_uuid(),case when audience='employee' then 'applicant@example.test' when audience='reviewers' then 'hr@mobilityaccess.com.au,reviewer@example.test' else 'reviewer@example.test' end,
case when audience<>'shared' then '' when q.delivery_payload->'wasApproved'='false'::jsonb then 'hr@mobilityaccess.com.au' else 'accounts@mobilityaccess.com.au,hr@mobilityaccess.com.au' end,
jsonb_build_object('accepted',true,'messageId','synthetic-message','requestId','synthetic-provider-request','statusCode',202),timestamptz '2026-01-10 01:30:00+00',timestamptz '2026-01-10 01:45:00+00'
from private.leave_notification_outbox q cross join lateral unnest(case when q.event='leave-submitted' then array['reviewers','employee'] else array['shared'] end) audience;
insert into private.portal_account_status_change_claims(auth_user_id,person_id,claimed_by,requested_enabled,status,claimed_account_status,claimed_account_version,final_account_version,finalised_at,provider_status,executor_token,provider_started_at,provider_finished_at)
values ('91abcdef-0000-4000-8000-000000000002','91abcdef-0000-4000-8000-000000000002','91abcdef-0000-4000-8000-000000000001',false,'finalised','disabled',1,1,now(),'succeeded',gen_random_uuid(),now()-interval '1 minute',now());
insert into private.confirmed_test_identity_purges(person_id,actor_user_id,company_key,manifest_hash,manifest,retained_audit,retired_identifiers,phase,completed_at)
values ('91abcdef-0000-4000-8000-000000000099','91abcdef-0000-4000-8000-000000000001','mam',repeat('b',64),'{}','{}',array['91abcdef-0000-4000-8000-000000000099']::uuid[],'complete',now());
create temp table delivered_completed_before as select to_jsonb(p) as document from private.confirmed_test_identity_purges p;
create temp table delivered_receipts_before as select to_jsonb(r) as document from private.notification_delivery_receipts r;
create temp table delivered_submissions_before as select to_jsonb(r) as document from private.leave_submission_receipts r;
create temp table delivered_claim_before as select to_jsonb(r) as document from private.portal_account_status_change_claims r;
create temp table delivered_history_before as select to_jsonb(q) as document from private.leave_notification_outbox q;
create temp table delivered_real_before as select to_jsonb(p) as document from public.internal_org_people p where id='91abcdef-0000-4000-8000-000000000003';
select pg_temp.set_test_actor('91abcdef-0000-4000-8000-000000000001');
