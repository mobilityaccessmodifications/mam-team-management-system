begin;
set local search_path='';
lock table private.confirmed_test_purge_schema in exclusive mode;
lock table storage.buckets,storage.objects,storage.buckets_analytics,storage.buckets_vectors,storage.vector_indexes in access share mode;

do $storage_catalog_reconciliation$
declare current_hash text; stored_hash text; counterfactual_hash text; affected integer;
begin
 if (select count(*) from private.confirmed_test_purge_schema where singleton)<>1 then raise exception 'Exact purge catalog fingerprint required' using errcode='55000'; end if;
 current_hash:=private.confirmed_test_purge_schema_hash();
 select schema_hash into stored_hash from private.confirmed_test_purge_schema where singleton;
 if stored_hash=current_hash then return; end if;
 if current_setting('server_version_num')::integer/10000<>17
 or stored_hash<>'c99a0a375681c75a4d17c7b56905a3130559a05efd4111c4badc684a8f8adc4f'
 or current_hash<>'bda99195a816a34310a05a0268d60c102dbc3c5f3712d87181974276330a032d'
 or encode(extensions.digest(pg_get_functiondef('private.confirmed_test_purge_schema_hash()'::regprocedure),'sha256'),'hex')<>'3385d5a0140df3995e3196ffea442b4829f9a5357de3ccf5a8d521fbe9011a54'
 or (select count(*) from storage.migrations where id=73 and name='revoke-grants-to-unused-operations' and hash='ba9244051be09f22f714fc0170a2539f8b5f0e68')<>1
 or (select max(id) from storage.migrations)<>73
 or (select pg_get_userbyid(relowner)='supabase_storage_admin' and relacl::text='{supabase_storage_admin=a*r*w*d*D*x*t*m*/supabase_storage_admin,service_role=arwdDxtm/supabase_storage_admin,authenticated=arwd/supabase_storage_admin,anon=arwd/supabase_storage_admin,postgres=a*r*w*d*D*x*t*m*/supabase_storage_admin}' from pg_class where oid='storage.buckets'::regclass) is distinct from true
 or (select pg_get_userbyid(relowner)='supabase_storage_admin' and relacl::text='{supabase_storage_admin=arwdDxtm/supabase_storage_admin,service_role=arwdDxtm/supabase_storage_admin,authenticated=arwd/supabase_storage_admin,anon=arwd/supabase_storage_admin}' from pg_class where oid='storage.buckets_analytics'::regclass) is distinct from true
 or (select pg_get_userbyid(relowner)='supabase_storage_admin' and relacl::text='{supabase_storage_admin=arwdDxtm/supabase_storage_admin,service_role=r/supabase_storage_admin,anon=r/supabase_storage_admin,authenticated=r/supabase_storage_admin}' from pg_class where oid='storage.buckets_vectors'::regclass) is distinct from true
 or (select pg_get_userbyid(relowner)='supabase_storage_admin' and relacl::text='{supabase_storage_admin=a*r*w*d*D*x*t*m*/supabase_storage_admin,service_role=arwdDxtm/supabase_storage_admin,authenticated=arwd/supabase_storage_admin,anon=arwd/supabase_storage_admin,postgres=a*r*w*d*D*x*t*m*/supabase_storage_admin}' from pg_class where oid='storage.objects'::regclass) is distinct from true
 or (select pg_get_userbyid(relowner)='supabase_storage_admin' and relacl::text='{supabase_storage_admin=arwdDxtm/supabase_storage_admin,service_role=r/supabase_storage_admin,anon=r/supabase_storage_admin,authenticated=r/supabase_storage_admin}' from pg_class where oid='storage.vector_indexes'::regclass) is distinct from true then raise exception 'Unreviewed catalog drift; exact Storage 0073 transition required' using errcode='55000'; end if;
 select value into counterfactual_hash from (select encode(extensions.digest(coalesce(string_agg(definition,E'\n' order by definition),''),'sha256'),'hex') from (
  select n.nspname||'.'||c.relname||':'||c.relkind::text||':'||c.relrowsecurity||':'||c.relforcerowsecurity as definition from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname in ('public','private','storage') and c.relkind in ('r','p','v','m')
  union all select a.attrelid::regclass::text||':'||a.attname||':'||format_type(a.atttypid,a.atttypmod)||':'||a.attnotnull from pg_attribute a join pg_class c on c.oid=a.attrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname in ('public','private','storage') and a.attnum>0 and not a.attisdropped
  union all select conrelid::regclass::text||':'||pg_get_constraintdef(oid) from pg_constraint where connamespace in (select oid from pg_namespace where nspname in ('public','private','storage')) or confrelid='auth.users'::regclass or confrelid in (select c.oid from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname in ('public','private','storage'))
  union all select tgrelid::regclass::text||':'||tgenabled::text||':'||pg_get_triggerdef(t.oid) from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace where (n.nspname in ('public','private','storage') or c.oid='auth.users'::regclass) and not t.tgisinternal
  union all select pg_get_functiondef(p.oid) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('public','private') and p.prokind='f'
  union all select c.oid::regclass::text||':'||pg_get_viewdef(c.oid) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname in ('public','private','storage') and c.relkind in ('v','m')
  union all select p.oid::regprocedure::text||':'||p.proowner::text||':'||coalesce(p.proacl::text,'default') from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('public','private') and p.prokind='f'
  union all select c.oid::regclass::text||':'||c.relowner::text||':'||case c.oid::regclass::text when 'storage.buckets' then '{supabase_storage_admin=a*r*w*d*D*x*t*m*/supabase_storage_admin,service_role=arwdDxtm/supabase_storage_admin,authenticated=arwdDxtm/supabase_storage_admin,anon=arwdDxtm/supabase_storage_admin,postgres=a*r*w*d*D*x*t*m*/supabase_storage_admin}' when 'storage.objects' then '{supabase_storage_admin=a*r*w*d*D*x*t*m*/supabase_storage_admin,service_role=arwdDxtm/supabase_storage_admin,authenticated=arwdDxtm/supabase_storage_admin,anon=arwdDxtm/supabase_storage_admin,postgres=a*r*w*d*D*x*t*m*/supabase_storage_admin}' when 'storage.buckets_analytics' then '{supabase_storage_admin=arwdDxtm/supabase_storage_admin,service_role=arwdDxtm/supabase_storage_admin,authenticated=arwdDxtm/supabase_storage_admin,anon=arwdDxtm/supabase_storage_admin}' when 'storage.buckets_vectors' then '{supabase_storage_admin=arwdDxtm/supabase_storage_admin,service_role=r/supabase_storage_admin,authenticated=r/supabase_storage_admin,anon=r/supabase_storage_admin}' when 'storage.vector_indexes' then '{supabase_storage_admin=arwdDxtm/supabase_storage_admin,service_role=r/supabase_storage_admin,authenticated=r/supabase_storage_admin,anon=r/supabase_storage_admin}' else coalesce(c.relacl::text,'default') end from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname in ('public','private','storage') and c.relkind in ('r','p','v','m')
  union all select polrelid::regclass::text||':'||polname||':'||polcmd::text||':'||polpermissive::text||':'||polroles::text||':'||coalesce(pg_get_expr(polqual,polrelid),'')||':'||coalesce(pg_get_expr(polwithcheck,polrelid),'') from pg_policy where polrelid in (select c.oid from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname in ('public','private','storage'))
) definitions) proof(value);
 if counterfactual_hash is distinct from stored_hash then raise exception 'Storage ACL counterfactual does not reproduce retained catalog' using errcode='55000'; end if;
 update private.confirmed_test_purge_schema set schema_hash=current_hash where singleton and schema_hash=stored_hash;
 get diagnostics affected=row_count;
 if affected<>1 then raise exception 'Retained catalog fingerprint changed' using errcode='55000'; end if;
end
$storage_catalog_reconciliation$;

do $storage_catalog_reconciliation_final$ begin
 if (select count(*)=1 and bool_and(singleton and schema_hash=private.confirmed_test_purge_schema_hash()) from private.confirmed_test_purge_schema) is distinct from true then raise exception 'Reconciled catalog readback differs' using errcode='55000'; end if;
end $storage_catalog_reconciliation_final$;

commit;
