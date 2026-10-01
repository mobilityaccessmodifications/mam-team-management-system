\set ON_ERROR_STOP on
begin;
\ir confirmed-test-purge-delivered-fixture.sql
create function pg_temp.expect_envelope_purge_block(p_mutation text)
returns void language plpgsql as $$ declare reviewed jsonb; begin
  begin
    execute p_mutation;
    reviewed:=public.preview_confirmed_test_identity_purge('91abcdef-0000-4000-8000-000000000002','91abcdef-0000-4000-8000-000000000002','mam','Delivered Fake Synthetic','delivered-fake@example.test',1,1);
    perform public.prepare_confirmed_test_identity_purge('91abcdef-0000-4000-8000-000000000002','91abcdef-0000-4000-8000-000000000002','mam','Delivered Fake Synthetic','delivered-fake@example.test',1,1,reviewed->>'manifest_hash',true,true);
    raise exception 'Unsafe receipt envelope accepted; prepare removed % leaves: %',2-(select count(*) from public.leave_requests),p_mutation;
  exception when foreign_key_violation then
    assert sqlerrm like '%nonfinalized/unbound leave delivery receipt%', 'Wrong receipt envelope blocker';
  end;
end $$;
do $$ declare baseline jsonb; begin
baseline:=public.preview_confirmed_test_identity_purge('91abcdef-0000-4000-8000-000000000002','91abcdef-0000-4000-8000-000000000002','mam','Delivered Fake Synthetic','delivered-fake@example.test',1,1);
perform pg_temp.expect_envelope_purge_block($q$update private.notification_delivery_receipts set recipient='unrelated@example.test'$q$);
perform pg_temp.expect_envelope_purge_block($q$update private.notification_delivery_receipts set cc='unrelated@example.test'$q$);
perform pg_temp.expect_envelope_purge_block($q$update private.notification_delivery_receipts set recipient='reviewer@example.test' where recipient='hr@mobilityaccess.com.au,reviewer@example.test'$q$);
perform pg_temp.expect_envelope_purge_block($q$update private.notification_delivery_receipts set recipient='hr@mobilityaccess.com.au' where recipient='applicant@example.test'$q$);
perform pg_temp.expect_envelope_purge_block($q$update private.notification_delivery_receipts set cc='hr@mobilityaccess.com.au' where event_key like '%:leave-submitted:%'$q$);
perform pg_temp.expect_envelope_purge_block($q$update private.notification_delivery_receipts set cc='' where event_key like '%:leave-cancelled:%'$q$);
perform pg_temp.expect_envelope_purge_block($q$update private.leave_notification_outbox set delivery_payload=jsonb_set(delivery_payload,'{wasApproved}','true'::jsonb) where event='leave-cancelled'$q$);
perform pg_temp.expect_envelope_purge_block($q$update private.notification_delivery_receipts n set event_key='leave:'||o.request_id::text||':'||o.event||':'||left(encode(extensions.digest(o.id::text,'sha256'),'hex'),24) from private.leave_notification_outbox o where o.event='leave-submitted' and n.event_key='leave:'||o.request_id::text||':'||o.event||':'||left(encode(extensions.digest(o.id::text||':reviewers','sha256'),'hex'),24)$q$);
assert (select count(*)=2 from public.leave_requests), 'Blocked envelope purge removed business rows';
assert baseline=public.preview_confirmed_test_identity_purge('91abcdef-0000-4000-8000-000000000002','91abcdef-0000-4000-8000-000000000002','mam','Delivered Fake Synthetic','delivered-fake@example.test',1,1), 'Blocked envelope mutation changed reviewed history';
assert not exists(select 1 from private.confirmed_test_identity_purges where person_id='91abcdef-0000-4000-8000-000000000002'), 'Blocked envelope purge committed a receipt';
end $$;
rollback;
