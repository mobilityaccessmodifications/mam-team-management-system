\set ON_ERROR_STOP on
begin;
\ir confirmed-test-purge-delivered-fixture.sql
do $$ declare reviewed jsonb; baseline jsonb; begin
baseline:=public.preview_confirmed_test_identity_purge('91abcdef-0000-4000-8000-000000000002','91abcdef-0000-4000-8000-000000000002','mam','Delivered Fake Synthetic','delivered-fake@example.test',1,1);
begin
  update private.leave_notification_outbox set delivery_payload=delivery_payload||'{"employeeEmails":["first@example.test,second@example.test"],"employeeEmail":"first@example.test,second@example.test"}'::jsonb where event='leave-cancelled';
  assert (select bool_and(delivery_payload->>'employeeEmail'=array_to_string(array(select jsonb_array_elements_text(delivery_payload->'employeeEmails')),',')) from private.leave_notification_outbox where event='leave-cancelled'), 'Malformed-element proof must preserve aggregate employeeEmail equality';
  reviewed:=public.preview_confirmed_test_identity_purge('91abcdef-0000-4000-8000-000000000002','91abcdef-0000-4000-8000-000000000002','mam','Delivered Fake Synthetic','delivered-fake@example.test',1,1);
  perform public.prepare_confirmed_test_identity_purge('91abcdef-0000-4000-8000-000000000002','91abcdef-0000-4000-8000-000000000002','mam','Delivered Fake Synthetic','delivered-fake@example.test',1,1,reviewed->>'manifest_hash',true,true);
  raise exception 'Unsafe array recipient-set element accepted with matching aggregate; prepare removed % leaves',2-(select count(*) from public.leave_requests);
exception when foreign_key_violation then
  assert sqlerrm like '%leave delivery not finalized%', 'Wrong single employee address blocker';
end;
assert (select count(*)=2 from public.leave_requests), 'Blocked array purge removed business rows';
assert baseline=public.preview_confirmed_test_identity_purge('91abcdef-0000-4000-8000-000000000002','91abcdef-0000-4000-8000-000000000002','mam','Delivered Fake Synthetic','delivered-fake@example.test',1,1), 'Blocked array mutation changed reviewed history';
assert not exists(select 1 from private.confirmed_test_identity_purges where person_id='91abcdef-0000-4000-8000-000000000002'), 'Blocked array purge committed a receipt';
end $$;
rollback;
