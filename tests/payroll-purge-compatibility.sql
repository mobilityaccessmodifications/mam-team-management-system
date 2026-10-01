\set ON_ERROR_STOP on
begin;
\ir sql-test-auth.sql
select pg_temp.set_test_actor('97abcdef-0000-4000-8000-000000000001');
set local role authenticated;
do $$ declare preview jsonb; claim jsonb; begin
  preview:=public.preview_confirmed_test_identity_purge('97abcdef-0000-4000-8000-000000000003',null,'mam','Compatibility Test Synthetic',null,1,null);
  assert preview->>'manifest_hash' is not null, 'Exclusive synthetic preview became unavailable';
  claim:=public.claim_confirmed_test_identity_auth_delete('97abcdef-0000-4000-8001-000000000002');
  assert (claim->>'delete_authorized')::boolean, 'Existing pending receipt lost its one-shot Auth claim';
end $$;
reset role;
delete from auth.users where id='97abcdef-0000-4000-8000-000000000002';
set local role authenticated;
do $$ declare result jsonb; begin
  result:=public.complete_confirmed_test_identity_purge('97abcdef-0000-4000-8001-000000000002');
  assert result->>'phase'='complete', 'Existing pending receipt cannot complete after confirmed synthetic Auth absence';
end $$;
rollback;
