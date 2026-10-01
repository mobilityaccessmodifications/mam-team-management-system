\set ON_ERROR_STOP on
begin;
\ir confirmed-test-purge-delivered-fixture.sql
update private.leave_notification_outbox set delivery_payload=delivery_payload||'{"employeeEmail":null,"employeeEmails":[]}'::jsonb;
delete from private.notification_delivery_receipts n where exists(select 1 from private.leave_notification_outbox o where n.event_key='leave:'||o.request_id::text||':'||o.event||':'||left(encode(extensions.digest(o.id::text||':employee','sha256'),'hex'),24));
set local role authenticated;
do $$ declare reviewed jsonb; begin
reviewed:=public.preview_confirmed_test_identity_purge('91abcdef-0000-4000-8000-000000000002','91abcdef-0000-4000-8000-000000000002','mam','Delivered Fake Synthetic','delivered-fake@example.test',1,1);
assert (reviewed->'manifest'->'private.notification_delivery_receipts'->>'count')::integer=4, 'Manager-only notification receipts not reviewed';
perform public.prepare_confirmed_test_identity_purge('91abcdef-0000-4000-8000-000000000002','91abcdef-0000-4000-8000-000000000002','mam','Delivered Fake Synthetic','delivered-fake@example.test',1,1,reviewed->>'manifest_hash',true,true);
end $$;
reset role;
do $$ begin
assert (select bool_and(value#>'{recipient_snapshot,employee}'='[]'::jsonb) from private.confirmed_test_identity_purges p cross join lateral jsonb_array_elements(p.retained_audit->'private.leave_notification_outbox') where p.person_id='91abcdef-0000-4000-8000-000000000002'), 'Missing applicant attribution was fabricated';
end $$;
rollback;
