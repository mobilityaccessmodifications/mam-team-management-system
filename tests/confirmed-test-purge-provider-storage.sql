\set ON_ERROR_STOP on
begin;
\ir sql-test-auth.sql
insert into auth.users(id,email,email_confirmed_at,banned_until) values
('98000000-0000-4000-8000-000000000001','storage-admin@example.test',now(),null),
('98000000-0000-4000-8000-000000000002','storage-fake@example.test',now(),now()+interval '1 day');
insert into public.profiles(id,full_name,app_role,login_name,account_status,credentials_valid_after,disabled_at) values
('98000000-0000-4000-8000-000000000001','Storage Admin Synthetic','system_admin','storage-admin@example.test','active',now()-interval '1 day',null),
('98000000-0000-4000-8000-000000000002','Storage Fake Synthetic','employee','storage-fake@example.test','disabled',now()-interval '1 day',now());
insert into public.internal_org_people(id,full_name,company_key,position_title,auth_user_id,is_active) values
('98000000-0000-4000-8000-000000000002','Storage Fake Synthetic','mam','Synthetic','98000000-0000-4000-8000-000000000002',true);
select pg_temp.set_test_actor('98000000-0000-4000-8000-000000000001');
do $$ declare tbl text; begin
  foreach tbl in array array['confirmed_test_identity_purges','confirmed_test_purge_schema'] loop
    execute format('insert into storage.%I(id,metadata) values(''synthetic'',jsonb_build_object(''person'',''98000000-0000-4000-8000-000000000002''))',tbl);
    begin
      perform public.preview_confirmed_test_identity_purge('98000000-0000-4000-8000-000000000002','98000000-0000-4000-8000-000000000002','mam','Storage Fake Synthetic','storage-fake@example.test',1,1);
      raise exception 'Same-named Storage table was excluded from census';
    exception when foreign_key_violation then
      assert position('storage.'||tbl in sqlerrm)>0, 'Wrong qualified receipt census blocker';
    end;
    execute format('delete from storage.%I',tbl);
  end loop;
end $$;
set local role authenticated;
do $$ declare reviewed jsonb; receipt uuid; begin
  reviewed:=public.preview_confirmed_test_identity_purge('98000000-0000-4000-8000-000000000002','98000000-0000-4000-8000-000000000002','mam','Storage Fake Synthetic','storage-fake@example.test',1,1);
  receipt:=public.prepare_confirmed_test_identity_purge('98000000-0000-4000-8000-000000000002','98000000-0000-4000-8000-000000000002','mam','Storage Fake Synthetic','storage-fake@example.test',1,1,reviewed->>'manifest_hash',true,true);
  assert (select count(*)=3 from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='storage' and c.relname in ('migrations','buckets_vectors','vector_indexes')
    and exists(select 1 from pg_locks l where l.pid=pg_backend_pid() and l.relation=c.oid and l.mode='AccessShareLock' and l.granted)
    and not exists(select 1 from pg_locks l where l.pid=pg_backend_pid() and l.relation=c.oid and l.mode in ('ShareRowExclusiveLock','ExclusiveLock','AccessExclusiveLock'))), 'Only the exact provider tables may use read-only locks';
  assert not exists(select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace where (n.nspname in ('public','private','storage') or c.oid='auth.users'::regclass)
    and c.relkind in ('r','p') and (n.nspname,c.relname) not in (('storage','migrations'),('storage','buckets_vectors'),('storage','vector_indexes'))
    and not exists(select 1 from pg_locks l where l.pid=pg_backend_pid() and l.relation=c.oid and l.mode='ShareRowExclusiveLock' and l.granted)), 'Supported tables lost strong worker/Auth locks';
  assert (public.claim_confirmed_test_identity_auth_delete(receipt)->>'delete_authorized')::boolean, 'Auth deletion claim missing';
end $$;
reset role;
delete from auth.users where id='98000000-0000-4000-8000-000000000002';
set local role authenticated;
do $$ declare receipt jsonb; begin
  receipt:=public.get_confirmed_test_identity_purge('98000000-0000-4000-8000-000000000002');
  assert public.complete_confirmed_test_identity_purge((receipt->>'id')::uuid)->>'phase'='complete', 'SELECT-only Storage prevented completion';
end $$;
reset role;
do $$ begin
  assert not exists(select 1 from public.internal_org_people where id='98000000-0000-4000-8000-000000000002'), 'Test person remains';
  assert not exists(select 1 from public.profiles where id='98000000-0000-4000-8000-000000000002'), 'Test account remains';
  assert (select phase='complete' from private.confirmed_test_identity_purges where person_id='98000000-0000-4000-8000-000000000002'), 'Receipt incomplete';
end $$;
rollback;
