\set ON_ERROR_STOP on
begin;
set local time zone 'UTC';
\ir confirmed-test-purge-delivered-fixture.sql
set local role authenticated;
do $$ declare reviewed jsonb; receipt uuid; begin
reviewed:=public.preview_confirmed_test_identity_purge('91abcdef-0000-4000-8000-000000000002','91abcdef-0000-4000-8000-000000000002','mam','Delivered Fake Synthetic','delivered-fake@example.test',1,1);
receipt:=public.prepare_confirmed_test_identity_purge('91abcdef-0000-4000-8000-000000000002','91abcdef-0000-4000-8000-000000000002','mam','Delivered Fake Synthetic','delivered-fake@example.test',1,1,reviewed->>'manifest_hash',true,true);
perform public.claim_confirmed_test_identity_auth_delete(receipt);
end $$;
reset role;
set local time zone 'Pacific/Auckland';
do $$ begin
assert private.minimize_notification_delivery_receipts('{}',1000)=6, 'Worker timezone broke legitimate 90-day minimization';
assert (select count(*)=6 and bool_and(private.confirmed_test_retained_leave_receipt(to_jsonb(r))) from private.notification_delivery_receipts r), 'Audit proof depended on timestamp presentation';
end $$;
delete from auth.users where id='91abcdef-0000-4000-8000-000000000002';
set local role authenticated;
do $$ declare receipt jsonb; begin
receipt:=public.get_confirmed_test_identity_purge('91abcdef-0000-4000-8000-000000000002');
assert public.complete_confirmed_test_identity_purge((receipt->>'id')::uuid)->>'phase'='complete', 'Completion timezone broke retained proof';
end $$;
reset role;
rollback;
