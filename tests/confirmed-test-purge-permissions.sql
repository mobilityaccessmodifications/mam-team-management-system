\set ON_ERROR_STOP on
begin;
do $$ declare r record; role_name text; begin
assert (select atttypid='uuid[]'::regtype from pg_attribute where attrelid='private.confirmed_test_identity_purges'::regclass and attname='retired_identifiers'), 'Retirement boundary must store typed stable UUIDs';
for r in select oid,proname from pg_proc where proname in ('preview_confirmed_test_identity_purge','prepare_confirmed_test_identity_purge','get_confirmed_test_identity_purge','claim_confirmed_test_identity_auth_delete','complete_confirmed_test_identity_purge','reject_retired_test_identity_reference','confirmed_test_has_reference','confirmed_test_purge_census','confirmed_test_purge_schema_hash') loop
foreach role_name in array array['anon','service_role'] loop
assert not has_function_privilege(role_name,r.oid,'EXECUTE'), format('Unexpected %s EXECUTE on %s',role_name,r.proname);
end loop;
assert has_function_privilege('authenticated',r.oid,'EXECUTE')=(r.proname in ('preview_confirmed_test_identity_purge','prepare_confirmed_test_identity_purge','get_confirmed_test_identity_purge','claim_confirmed_test_identity_auth_delete','complete_confirmed_test_identity_purge')), 'Authenticated RPC boundary changed';
end loop;
for r in select oid,relname,relrowsecurity,relforcerowsecurity from pg_class where oid in ('private.confirmed_test_identity_purges'::regclass,'private.confirmed_test_purge_schema'::regclass) loop
assert r.relrowsecurity and r.relforcerowsecurity, 'Receipt tables must FORCE RLS';
foreach role_name in array array['anon','authenticated','service_role'] loop
assert not has_table_privilege(role_name,r.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'), 'Unexpected receipt table privileges';
end loop;
end loop;
end $$;
do $$ declare before_hash text; begin
before_hash:=private.confirmed_test_purge_schema_hash();
grant execute on function public.get_confirmed_test_identity_purge(uuid) to service_role;
assert private.confirmed_test_purge_schema_hash()<>before_hash, 'RPC permission drift was not fingerprinted';
end $$;
rollback;
