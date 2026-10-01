\set ON_ERROR_STOP on
begin;
\ir confirmed-test-purge-delivered-fixture.sql
create function pg_temp.expect_retired_delivery_error(p_sql text) returns void language plpgsql as $$ begin
begin execute p_sql; raise exception 'Retained no-resend evidence was mutable'; exception when check_violation then null; end;
end $$;
do $$ declare role_name text; begin
foreach role_name in array array['anon','authenticated','service_role'] loop
assert not has_function_privilege(role_name,'private.confirmed_test_retained_leave_receipt(jsonb)','EXECUTE'), 'Private audit exception exposed';
end loop;
assert (select prosecdef and proconfig=array['search_path=""'] from pg_proc where oid='private.confirmed_test_retained_leave_receipt(jsonb)'::regprocedure), 'Private audit helper security changed';
end $$;
update private.notification_delivery_receipts set created_at=now()-interval '1 hour',sent_at=now()-interval '30 minutes' where event_key=(select min(event_key) from private.notification_delivery_receipts);
update private.notification_delivery_control set legacy_import_count=0,legacy_import_sha256=repeat('d',64),legacy_imported_at=clock_timestamp(),ready=true;
create temp table delivered_retention_before as select to_jsonb(r) as document from private.notification_delivery_receipts r;
set local role authenticated;
do $$ declare reviewed jsonb; receipt uuid; begin
reviewed:=public.preview_confirmed_test_identity_purge('91abcdef-0000-4000-8000-000000000002','91abcdef-0000-4000-8000-000000000002','mam','Delivered Fake Synthetic','delivered-fake@example.test',1,1);
receipt:=public.prepare_confirmed_test_identity_purge('91abcdef-0000-4000-8000-000000000002','91abcdef-0000-4000-8000-000000000002','mam','Delivered Fake Synthetic','delivered-fake@example.test',1,1,reviewed->>'manifest_hash',true,true);
perform public.claim_confirmed_test_identity_auth_delete(receipt);
end $$;
reset role;
do $$ declare k text; recent text; original jsonb; result jsonb; begin
select min(event_key) into recent from private.notification_delivery_receipts;
perform pg_temp.expect_retired_delivery_error(format($q$update private.notification_delivery_receipts set state='sent_tombstone',delivery_token=null,recipient=null,cc=null,provider_receipt=null,minimized_at=clock_timestamp() where event_key=%L$q$,recent));
perform pg_temp.expect_retired_delivery_error($q$update private.notification_delivery_receipts set recipient='replacement@example.test'$q$);
perform pg_temp.expect_retired_delivery_error($q$update private.notification_delivery_receipts set delivery_token=gen_random_uuid()$q$);
perform pg_temp.expect_retired_delivery_error($q$update private.notification_delivery_receipts set sent_at=sent_at-interval '1 day'$q$);
assert private.minimize_notification_delivery_receipts(array(select event_key from private.notification_delivery_receipts),1000)=0, 'Protected keys were minimized';
assert private.minimize_notification_delivery_receipts('{}',1000)=5, 'Actual 90-day minimization blocked by retirement guard';
assert (select count(*)=6 and count(*) filter(where state='sent_tombstone')=5 and count(*) filter(where state='sent')=1 from private.notification_delivery_receipts), 'No-resend keys were lost or recent evidence minimized';
assert (select bool_and(r.event_key=b.document->>'event_key' and to_jsonb(r)->'created_at'=b.document->'created_at' and to_jsonb(r)->'sent_at'=b.document->'sent_at') from private.notification_delivery_receipts r join delivered_retention_before b on r.event_key=b.document->>'event_key'), 'Original key/chronology changed';
assert (select bool_and(private.confirmed_test_retained_leave_receipt(to_jsonb(r))) from private.notification_delivery_receipts r), 'Reviewed exact receipts lost retained-audit binding';
assert private.minimize_notification_delivery_receipts('{}',1000)=0, 'Minimization was not idempotent';
for original in select document from delivered_retention_before loop
k:=original->>'event_key';
set local role service_role;
result:=public.reserve_notification_delivery(k,original->>'recipient',original->>'cc');
assert not result ? 'deliveryToken' and result->>'outcome' is distinct from 'send', 'Retained receipt authorized a duplicate send';
assert case when k=recent then result->>'outcome'='duplicate' else result->>'rejectionCode'='receipt-evidence-unavailable' end, 'Permanent no-resend behavior changed';
reset role;
end loop;
perform pg_temp.expect_retired_delivery_error($q$update private.notification_delivery_receipts set minimized_at=clock_timestamp()+interval '1 day' where state='sent_tombstone'$q$);
perform pg_temp.expect_retired_delivery_error($q$update private.notification_delivery_receipts set state='sent',delivery_token=gen_random_uuid(),recipient='restored@example.test',cc='',provider_receipt='{"accepted":true,"messageId":null,"requestId":null,"statusCode":202}',minimized_at=null where state='sent_tombstone'$q$);
perform pg_temp.expect_retired_delivery_error($q$insert into private.notification_delivery_receipts(event_key,state,delivery_token,recipient,cc,provider_receipt,sent_at) values('leave:91abcdef-0000-4000-8001-000000000001:leave-approved:aaaaaaaaaaaaaaaaaaaaaaaa','sent',gen_random_uuid(),'unreviewed@example.test','','{"accepted":true,"messageId":null,"requestId":null,"statusCode":202}',now())$q$);
end $$;
delete from auth.users where id='91abcdef-0000-4000-8000-000000000002';
set local role authenticated;
do $$ declare receipt jsonb; begin
receipt:=public.get_confirmed_test_identity_purge('91abcdef-0000-4000-8000-000000000002');
assert public.complete_confirmed_test_identity_purge((receipt->>'id')::uuid)->>'phase'='complete', 'Exact retained sent/tombstone audit blocked completion';
assert public.complete_confirmed_test_identity_purge((receipt->>'id')::uuid)->>'phase'='complete', 'Completion replay changed retained audit';
end $$;
reset role;
do $$ begin
assert (select bool_and(to_jsonb(p)=b.document) from private.confirmed_test_identity_purges p join delivered_completed_before b on p.id=(b.document->>'id')::uuid), 'Earlier completed receipt changed';
assert (select count(*)=6 from private.notification_delivery_receipts), 'Auth deletion cascaded permanent no-resend keys';
end $$;
rollback;
