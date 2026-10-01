\set ON_ERROR_STOP on
begin;
\ir confirmed-test-purge-delivered-fixture.sql
create function pg_temp.expect_delivered_purge_block(p_mutation text,p_error text)
returns void language plpgsql as $$ begin
  begin
    execute p_mutation;
    perform public.preview_confirmed_test_identity_purge('91abcdef-0000-4000-8000-000000000002','91abcdef-0000-4000-8000-000000000002','mam','Delivered Fake Synthetic','delivered-fake@example.test',1,1);
    raise exception 'Unsafe delivered-history purge accepted: %',p_mutation;
  exception when foreign_key_violation then
    assert sqlerrm like '%'||p_error||'%', 'Wrong delivered-history blocker';
  end;
end $$;
do $$ declare change text; baseline jsonb; receipt uuid; begin
baseline:=public.preview_confirmed_test_identity_purge('91abcdef-0000-4000-8000-000000000002','91abcdef-0000-4000-8000-000000000002','mam','Delivered Fake Synthetic','delivered-fake@example.test',1,1);
foreach change in array array[
  'claim_token=gen_random_uuid()',
  'claimed_until=now()-interval ''1 day''',
  'claim_token=gen_random_uuid(),claimed_until=now()+interval ''5 minutes''',
  'delivered_at=null',
  'delivered_at=null,last_error=''delivery_unconfirmed''',
  'last_error=''delivery_unconfirmed''',
  'attempts=0',
  'attempts=-1',
  'delivered_at=created_at-interval ''1 second''',
  'delivery_payload=null',
  'delivery_payload=jsonb_set(delivery_payload,''{requestId}'',''"91abcdef-0000-4000-8001-000000000099"''::jsonb)',
  'payload=jsonb_set(payload,''{requestId}'',''"91abcdef-0000-4000-8001-000000000099"''::jsonb)',
  'delivery_payload=jsonb_set(delivery_payload,''{event}'',''"leave-approved"''::jsonb)',
  'delivery_payload=jsonb_set(delivery_payload,''{managerEmail}'',''null''::jsonb)',
  'delivery_payload=jsonb_set(delivery_payload,''{employeeEmails}'',''["not-an-address"]''::jsonb)',
  'delivery_payload=jsonb_set(delivery_payload,''{employeeEmail}'',''"other@example.test"''::jsonb)'
] loop
perform pg_temp.expect_delivered_purge_block('update private.leave_notification_outbox set '||change,'leave delivery not finalized');
end loop;
perform pg_temp.expect_delivered_purge_block($q$update private.notification_delivery_receipts set state='processing',sent_at=null,provider_receipt=null$q$,'nonfinalized/unbound leave delivery receipt');
perform pg_temp.expect_delivered_purge_block($q$update private.notification_delivery_receipts set state='legacy_unknown',sent_at=null,provider_receipt=null,delivery_token=null,recipient=null,cc=null$q$,'nonfinalized/unbound leave delivery receipt');
perform pg_temp.expect_delivered_purge_block($q$update private.notification_delivery_receipts set state='sent_tombstone',provider_receipt=null,delivery_token=null,recipient=null,cc=null,minimized_at=clock_timestamp()$q$,'nonfinalized/unbound leave delivery receipt');
perform pg_temp.expect_delivered_purge_block($q$update private.notification_delivery_receipts set event_key=left(event_key,length(event_key)-24)||'ffffffffffffffffffffffff' where event_key=(select event_key from private.notification_delivery_receipts limit 1)$q$,'nonfinalized/unbound leave delivery receipt');
foreach change in array array['"unknown"','"submitted"','"pending"','" Pending "','"Cancelled"','null','7','{}','[]'] loop
perform pg_temp.expect_delivered_purge_block('update private.leave_submission_receipts set result=jsonb_set(result,''{status}'','||quote_literal(change)||'::jsonb)','unbound/shared leave submission receipt');
end loop;
perform pg_temp.expect_delivered_purge_block($q$update private.leave_submission_receipts set result=result-'status'$q$,'unbound/shared leave submission receipt');
perform pg_temp.expect_delivered_purge_block($q$update private.leave_submission_receipts set result=jsonb_set(result,'{approval_required}','"true"')$q$,'unbound/shared leave submission receipt');
perform pg_temp.expect_delivered_purge_block($q$update private.leave_submission_receipts set input_hash=repeat('A',64)$q$,'unbound/shared leave submission receipt');
perform pg_temp.expect_delivered_purge_block($q$update private.leave_submission_receipts set input_hash=repeat('a',63)$q$,'unbound/shared leave submission receipt');
perform pg_temp.expect_delivered_purge_block($q$update public.leave_requests set status='submitted'$q$,'only exclusive cancelled portal leave');
perform pg_temp.expect_delivered_purge_block($q$update private.leave_submission_receipts set result=jsonb_set(result,'{id}','"91abcdef-0000-4000-8001-000000000099"')$q$,'unbound/shared leave submission receipt');
perform pg_temp.expect_delivered_purge_block($q$update private.leave_submission_receipts set result=result||'{"unexpected":"unreviewed"}'$q$,'unbound/shared leave submission receipt');
perform pg_temp.expect_delivered_purge_block($q$update private.leave_submission_receipts set actor_user_id='91abcdef-0000-4000-8000-000000000001'$q$,'unreviewed/shared/immutable reference in private.leave_submission_receipts');
foreach change in array array[
  'status=''pending'',finalised_at=null',
  'provider_status=''unknown''',
  'provider_status=''executing''',
  'provider_status=''not_started''',
  'requested_enabled=true',
  'person_id=''91abcdef-0000-4000-8000-000000000003''',
  'final_account_version=2',
  'provider_finished_at=null',
  'executor_token=null'
] loop
perform pg_temp.expect_delivered_purge_block('update private.portal_account_status_change_claims set '||change,'account status claim not finalized');
end loop;
perform pg_temp.expect_delivered_purge_block($q$insert into private.openclaw_leave_receipts(key,body) select repeat('c',64),jsonb_build_object('indirect_delivery',id) from private.leave_notification_outbox limit 1$q$,'unreviewed/shared/immutable reference in private.openclaw_leave_receipts');
perform pg_temp.expect_delivered_purge_block($q$insert into private.openclaw_leave_receipts(key,body) select repeat('c',64),jsonb_build_object('indirect_submission',submission_key) from private.leave_submission_receipts limit 1$q$,'unreviewed/shared/immutable reference in private.openclaw_leave_receipts');
perform pg_temp.expect_delivered_purge_block($q$insert into private.openclaw_leave_receipts(key,body) select repeat('c',64),jsonb_build_object('indirect_token',delivery_token) from private.notification_delivery_receipts limit 1$q$,'unreviewed/shared/immutable reference in private.openclaw_leave_receipts');
perform pg_temp.expect_delivered_purge_block($q$insert into private.openclaw_leave_receipts(key,body) select repeat('c',64),jsonb_build_object('indirect_executor',executor_token) from private.portal_account_status_change_claims limit 1$q$,'unreviewed/shared/immutable reference in private.openclaw_leave_receipts');
begin
  update private.notification_delivery_receipts set provider_receipt=jsonb_set(provider_receipt,'{messageId}','"synthetic-other-provider-message"');
  perform public.prepare_confirmed_test_identity_purge('91abcdef-0000-4000-8000-000000000002','91abcdef-0000-4000-8000-000000000002','mam','Delivered Fake Synthetic','delivered-fake@example.test',1,1,baseline->>'manifest_hash',true,true);
  raise exception 'Changed provider history accepted against stale preview';
exception when serialization_failure then null; end;
assert baseline=public.preview_confirmed_test_identity_purge('91abcdef-0000-4000-8000-000000000002','91abcdef-0000-4000-8000-000000000002','mam','Delivered Fake Synthetic','delivered-fake@example.test',1,1), 'Rejected mutation changed reviewed history';
assert not exists(select 1 from private.confirmed_test_identity_purges where person_id='91abcdef-0000-4000-8000-000000000002'), 'Blocked purge committed a receipt';
end $$;
rollback;
