\set ON_ERROR_STOP on
begin;
\ir confirmed-test-purge-delivered-fixture.sql
set local role authenticated;
do $$ declare reviewed jsonb; receipt uuid; state jsonb; begin
reviewed:=public.preview_confirmed_test_identity_purge('91abcdef-0000-4000-8000-000000000002','91abcdef-0000-4000-8000-000000000002','mam','Delivered Fake Synthetic','delivered-fake@example.test',1,1);
assert (reviewed->'manifest'->'private.leave_notification_outbox'->>'count')::integer=4, 'Four finalized deliveries must be reviewed';
assert position('reviewer@example.test' in reviewed::text)=0 and position('applicant@example.test' in reviewed::text)=0, 'Preview leaked recipients';
receipt:=public.prepare_confirmed_test_identity_purge('91abcdef-0000-4000-8000-000000000002','91abcdef-0000-4000-8000-000000000002','mam','Delivered Fake Synthetic','delivered-fake@example.test',1,1,reviewed->>'manifest_hash',true,true);
state:=public.get_confirmed_test_identity_purge('91abcdef-0000-4000-8000-000000000002');
assert state->>'phase'='business_purged', 'Business purge did not retain Auth boundary';
assert not (state ? 'retained_audit'), 'Delivery audit exposed through receipt RPC';
state:=public.claim_confirmed_test_identity_auth_delete(receipt);
assert (state->>'delete_authorized')::boolean, 'One-shot Auth claim missing';
state:=public.claim_confirmed_test_identity_auth_delete(receipt);
assert not (state->>'delete_authorized')::boolean, 'Auth deletion authorized twice';
end $$;
reset role;
do $$ declare audit jsonb; original jsonb; retained jsonb; dataset text; begin
select retained_audit->'private.leave_notification_outbox' into audit from private.confirmed_test_identity_purges where person_id='91abcdef-0000-4000-8000-000000000002';
assert jsonb_array_length(audit)=4, 'Finalized delivery provenance missing';
for original in select document from delivered_history_before loop
select value into retained from jsonb_array_elements(audit) where value->>'id'=original->>'id';
assert retained=jsonb_build_object('id',original->'id','request_id',original->'request_id','event',original->'event','created_at',original->'created_at','delivered_at',original->'delivered_at','attempts',original->'attempts',
'recipient_snapshot',jsonb_build_object('source','delivery_payload','manager',jsonb_build_array(encode(extensions.digest('reviewer@example.test','sha256'),'hex')),'employee',jsonb_build_array(encode(extensions.digest('applicant@example.test','sha256'),'hex')))), 'Delivery chronology/count/recipient attribution changed';
end loop;
assert position('reviewer@example.test' in audit::text)=0 and position('applicant@example.test' in audit::text)=0, 'Necessary audit retained contact values';
select retained_audit->'private.leave_submission_receipts' into audit from private.confirmed_test_identity_purges where person_id='91abcdef-0000-4000-8000-000000000002';
for original in select document from delivered_submissions_before loop
assert original#>>'{result,status}'='Pending', 'Fixture must use the literal submission wire status';
select value into retained from jsonb_array_elements(audit) where value->>'submission_key'=original->>'submission_key';
assert retained=jsonb_build_object('actor_user_id',original->'actor_user_id','submission_key',original->'submission_key','input_hash',original->'input_hash','created_at',original->'created_at',
'result',(original->'result')-'assigned_reviewer_label','result_sha256',encode(extensions.digest((original->'result')::text,'sha256'),'hex')), 'Submission audit changed literal status, identity, hash, keys or chronology';
assert retained#>>'{result,status}'='Pending' and not (retained->'result' ? 'assigned_reviewer_label'), 'Submission audit normalized status or retained reviewer label';
end loop;
assert not exists(select 1 from private.leave_submission_receipts), 'Submission receipts silently left to Auth cascade';
assert not exists(select 1 from private.portal_account_status_change_claims), 'Finalized status claim silently left to person cascade';
assert (select count(*)=6 and bool_and(to_jsonb(r)=b.document) from private.notification_delivery_receipts r join delivered_receipts_before b on r.event_key=b.document->>'event_key'), 'Permanent no-resend receipt changed';
assert (select bool_and(to_jsonb(p)=b.document) from private.confirmed_test_identity_purges p join delivered_completed_before b on p.id=(b.document->>'id')::uuid), 'Previously completed purge receipt changed';
assert (select retained_audit->'private.portal_account_status_change_claims'=(select jsonb_agg(document) from delivered_claim_before) from private.confirmed_test_identity_purges where person_id='91abcdef-0000-4000-8000-000000000002'), 'Original finalized actor/state evidence missing';
assert (select jsonb_array_length(retained_audit->'private.leave_submission_receipts')=2 and jsonb_array_length(retained_audit->'private.notification_delivery_receipts')=6 from private.confirmed_test_identity_purges where person_id='91abcdef-0000-4000-8000-000000000002'), 'Reviewed retained/deleted receipt provenance missing';
assert not exists(select 1 from private.leave_notification_outbox), 'Delivered test history still operational';
assert not exists(select 1 from public.leave_requests where employee_person_id='91abcdef-0000-4000-8000-000000000002'), 'Cancelled test leave still operational';
assert exists(select 1 from auth.users where id='91abcdef-0000-4000-8000-000000000002'), 'SQL deleted Auth identity';
assert (select to_jsonb(p)=b.document from public.internal_org_people p cross join delivered_real_before b where p.id='91abcdef-0000-4000-8000-000000000003'), 'Unrelated homonym changed';
foreach dataset in array array['employees','leave_requests','leave_events','check_ins','check_in_events'] loop
assert position('91abcdef-0000-4000-8000-000000000002' in public.analytics_dashboard_dataset(dataset,null,null,1000,0)::text)=0, 'Purged test identity remains in analytics';
end loop;
assert not public.finish_leave_notification_outbox((select (document->>'id')::uuid from delivered_history_before limit 1),gen_random_uuid(),true), 'Late worker acknowledgement recreated delivery';
assert not exists(select 1 from public.claim_leave_notification_outbox(null,50)), 'Purge queued or resent notifications';
end $$;
rollback;
