begin;
set local search_path = '';
set local lock_timeout = '2s';
set local statement_timeout = '120s';

do $review_before$
declare r record; previous_hash text;
begin
  if not pg_try_advisory_xact_lock(hashtextextended('confirmed-test-purge',0)) then
    raise exception 'Concurrent purge; defer onboarding review migration.' using errcode='55P03';
  end if;
  lock table auth.users,public.profiles,public.internal_org_people,
    private.employee_onboarding_credentials,private.employee_onboarding_credential_events,
    private.notification_delivery_receipts,private.confirmed_test_identity_purges,
    private.confirmed_test_purge_schema in share row exclusive mode nowait;
  if (select count(*) from private.confirmed_test_purge_schema)<>1 then
    raise exception 'Exact onboarding review schema predecessor required.' using errcode='55000';
  end if;
  select schema_hash into strict previous_hash from private.confirmed_test_purge_schema where singleton for update nowait;
  if private.confirmed_test_purge_schema_hash() is distinct from previous_hash then
    raise exception 'Onboarding review schema predecessor changed.' using errcode='55000';
  end if;
  for r in select * from (values
    ('private.confirmed_test_purge_schema_hash()','3385d5a0140df3995e3196ffea442b4829f9a5357de3ccf5a8d521fbe9011a54'),
    ('private.is_system_portal_account_admin()','6347635e6b97237fe5e212d2c9817e477a91641ec0a27e9e9a6a1d4ca3ce4a25'),
    ('private.lock_portal_role_actor()','b0c9f1ef54c2a84a6630b1cd3c42d6534a6620958459fb24ee20bcb291e1f8b0'),
    ('private.guard_onboarding_credential_send()','e6c990b2ac13fa5e58cbb29ffb6ae40682013dbb564218afdd1494b7e560be45')
  ) expected(signature,sha256) loop
    if encode(extensions.digest(pg_get_functiondef(to_regprocedure(r.signature)),'sha256'),'hex') is distinct from r.sha256 then
      raise exception 'Onboarding review protected predecessor changed (%).',r.signature using errcode='55000';
    end if;
  end loop;
  if to_regprocedure('public.list_onboarding_credential_reviews()') is not null
    or to_regprocedure('public.cancel_onboarding_credential_review(uuid,timestamptz)') is not null then
    raise exception 'Onboarding review RPCs already exist.' using errcode='55000';
  end if;
  perform set_config('mam.onboarding_review_previous_hash',previous_hash,true);
end;
$review_before$;

create function pg_temp.onboarding_review_catalog()
returns table(kind text,object_identity text,definition text)
language sql stable set search_path = '' as $catalog$
  select 'relation',format('%I.%I',n.nspname,c.relname),jsonb_build_object(
    'kind',c.relkind,'rls',c.relrowsecurity,'force_rls',c.relforcerowsecurity,'owner',r.rolname,
    'acl',c.relacl::text,'options',c.reloptions,'persistence',c.relpersistence,'replica_identity',c.relreplident,
    'partition',c.relispartition,'partition_key',pg_get_partkeydef(c.oid),'partition_bound',pg_get_expr(c.relpartbound,c.oid))::text
  from pg_class c join pg_namespace n on n.oid=c.relnamespace join pg_roles r on r.oid=c.relowner
  where n.nspname in ('public','private','storage') and c.relkind in ('r','p','v','m','S','f')
  union all
  select 'column',format('%I.%I.%I',n.nspname,c.relname,a.attname),jsonb_build_object(
    'ordinal',a.attnum,'type',format_type(a.atttypid,a.atttypmod),'not_null',a.attnotnull,
    'identity',a.attidentity,'generated',a.attgenerated,'default',pg_get_expr(d.adbin,d.adrelid),
    'collation',case when a.attcollation=0 then null else a.attcollation::regcollation::text end,'acl',a.attacl::text)::text
  from pg_attribute a join pg_class c on c.oid=a.attrelid join pg_namespace n on n.oid=c.relnamespace
    left join pg_attrdef d on d.adrelid=a.attrelid and d.adnum=a.attnum
  where n.nspname in ('public','private','storage') and a.attnum>0 and not a.attisdropped
  union all
  select 'constraint',(case when k.conrelid=0 then format('%I.%I',kn.nspname,typ.typname)
    else format('%I.%I',n.nspname,c.relname) end)||':'||k.conname,jsonb_build_object(
    'definition',pg_get_constraintdef(k.oid),'validated',k.convalidated,'deferrable',k.condeferrable,'deferred',k.condeferred)::text
  from pg_constraint k join pg_namespace kn on kn.oid=k.connamespace
    left join pg_class c on c.oid=k.conrelid left join pg_namespace n on n.oid=c.relnamespace
    left join pg_type typ on typ.oid=k.contypid
  where k.connamespace in (select oid from pg_namespace where nspname in ('public','private','storage'))
    or (kn.nspname='pg_catalog' and k.contypid<>0 and typ.typtype='d')
    or k.confrelid='auth.users'::regclass or k.confrelid in (
      select c2.oid from pg_class c2 join pg_namespace n2 on n2.oid=c2.relnamespace where n2.nspname in ('public','private','storage'))
  union all
  select 'trigger',format('%I.%I',n.nspname,c.relname)||':'||t.tgname,
    jsonb_build_object('enabled',t.tgenabled,'definition',pg_get_triggerdef(t.oid))::text
  from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace
  where not t.tgisinternal and (n.nspname in ('public','private','storage') or c.oid='auth.users'::regclass)
  union all
  select 'function',n.nspname||'.'||p.proname||'('||oidvectortypes(p.proargtypes)||')',pg_get_functiondef(p.oid)
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('public','private') and p.prokind='f'
  union all
  select 'function_security',n.nspname||'.'||p.proname||'('||oidvectortypes(p.proargtypes)||')',jsonb_build_object(
    'owner',r.rolname,'acl',p.proacl::text,'config',p.proconfig,'security_definer',p.prosecdef,
    'volatility',p.provolatile,'strict',p.proisstrict,'parallel',p.proparallel,'leakproof',p.proleakproof)::text
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace join pg_roles r on r.oid=p.proowner
  where n.nspname in ('public','private') and p.prokind='f'
  union all
  select 'view',format('%I.%I',n.nspname,c.relname),pg_get_viewdef(c.oid)
  from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname in ('public','private','storage') and c.relkind in ('v','m')
  union all
  select 'policy',format('%I.%I',n.nspname,c.relname)||':'||p.polname,jsonb_build_object(
    'command',p.polcmd,'permissive',p.polpermissive,
    'roles',array(select case when role_id=0 then 'PUBLIC' else (select rolname from pg_roles where oid=role_id) end from unnest(p.polroles) role_id),
    'using',pg_get_expr(p.polqual,p.polrelid),'check',pg_get_expr(p.polwithcheck,p.polrelid))::text
  from pg_policy p join pg_class c on c.oid=p.polrelid join pg_namespace n on n.oid=c.relnamespace
  where n.nspname in ('public','private','storage')
  union all
  select 'index',format('%I.%I',n.nspname,c.relname),jsonb_build_object(
    'definition',pg_get_indexdef(i.indexrelid),'valid',i.indisvalid,'ready',i.indisready,
    'clustered',i.indisclustered,'replica_identity',i.indisreplident)::text
  from pg_index i join pg_class c on c.oid=i.indexrelid join pg_namespace n on n.oid=c.relnamespace
  where n.nspname in ('public','private','storage')
  union all
  select 'sequence',format('%I.%I',n.nspname,c.relname),jsonb_build_object(
    'type',format_type(s.seqtypid,null),'start',s.seqstart,'increment',s.seqincrement,'maximum',s.seqmax,
    'minimum',s.seqmin,'cache',s.seqcache,'cycle',s.seqcycle,
    'owned_by',(select format('%I.%I.%I',tn.nspname,tc.relname,a.attname) from pg_depend dep
      join pg_class tc on tc.oid=dep.refobjid join pg_namespace tn on tn.oid=tc.relnamespace
      join pg_attribute a on a.attrelid=dep.refobjid and a.attnum=dep.refobjsubid
      where dep.classid='pg_class'::regclass and dep.objid=c.oid and dep.refclassid='pg_class'::regclass and dep.deptype in ('a','i')))::text
  from pg_sequence s join pg_class c on c.oid=s.seqrelid join pg_namespace n on n.oid=c.relnamespace
  where n.nspname in ('public','private','storage')
  union all
  select 'schema',n.nspname,jsonb_build_object('owner',r.rolname,'acl',n.nspacl::text)::text
  from pg_namespace n join pg_roles r on r.oid=n.nspowner
  where n.nspname !~ '^pg_(toast_)?temp_'
  union all
  select 'default_acl',r.rolname||':'||coalesce(n.nspname,'GLOBAL')||':'||d.defaclobjtype::text,d.defaclacl::text
  from pg_default_acl d join pg_roles r on r.oid=d.defaclrole left join pg_namespace n on n.oid=d.defaclnamespace
  union all
  select 'role',r.rolname,jsonb_build_object('oid',r.oid,'superuser',r.rolsuper,'inherit',r.rolinherit,'create_role',r.rolcreaterole,
    'create_db',r.rolcreatedb,'login',r.rolcanlogin,'replication',r.rolreplication,'bypass_rls',r.rolbypassrls,
    'connection_limit',r.rolconnlimit,'valid_until',r.rolvaliduntil)::text
  from pg_roles r
  union all
  select 'role_membership',parent.rolname||':'||member.rolname||':'||grantor.rolname,
    jsonb_build_object('admin',m.admin_option,'inherit',m.inherit_option,'set',m.set_option)::text
  from pg_auth_members m join pg_roles parent on parent.oid=m.roleid
    join pg_roles member on member.oid=m.member join pg_roles grantor on grantor.oid=m.grantor
  union all
  select 'global_relation_acl',format('%I.%I',n.nspname,c.relname),c.relacl::text
  from pg_class c join pg_namespace n on n.oid=c.relnamespace
  where c.relacl is not null and n.nspname !~ '^pg_(toast_)?temp_'
  union all
  select 'global_column_acl',format('%I.%I.%I',n.nspname,c.relname,a.attname),a.attacl::text
  from pg_attribute a join pg_class c on c.oid=a.attrelid join pg_namespace n on n.oid=c.relnamespace
  where a.attacl is not null and n.nspname !~ '^pg_(toast_)?temp_'
  union all
  select 'global_function_acl',n.nspname||'.'||p.proname||'('||oidvectortypes(p.proargtypes)||')',p.proacl::text
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where p.proacl is not null and n.nspname !~ '^pg_(toast_)?temp_'
  union all
  select 'type',format('%I.%I',n.nspname,t.typname),jsonb_build_object(
    'owner',r.rolname,'acl',t.typacl::text,'kind',t.typtype,'category',t.typcategory,
    'preferred',t.typispreferred,'defined',t.typisdefined,'not_null',t.typnotnull,
    'length',t.typlen,'by_value',t.typbyval,'alignment',t.typalign,'storage',t.typstorage,
    'delimiter',t.typdelim,'base',case when t.typbasetype=0 then null else format_type(t.typbasetype,t.typtypmod) end,
    'modifier',t.typtypmod,'dimensions',t.typndims,
    'element',case when t.typelem=0 then null else format_type(t.typelem,null) end,
    'array',case when t.typarray=0 then null else format_type(t.typarray,null) end,
    'relation',case when t.typrelid=0 then null else t.typrelid::regclass::text end,
    'collation',case when t.typcollation=0 then null else t.typcollation::regcollation::text end,
    'default',t.typdefault,'default_expression',pg_get_expr(t.typdefaultbin,0),
    'input',t.typinput::regproc::text,'output',t.typoutput::regproc::text,
    'receive',t.typreceive::regproc::text,'send',t.typsend::regproc::text,
    'modifier_input',t.typmodin::regproc::text,'modifier_output',t.typmodout::regproc::text,
    'analyze',t.typanalyze::regproc::text,'subscript',t.typsubscript::regproc::text)::text
  from pg_type t join pg_namespace n on n.oid=t.typnamespace join pg_roles r on r.oid=t.typowner
  where n.nspname in ('public','private','storage')
    or (n.nspname='pg_catalog' and (t.typtype='d' or exists(
      select 1 from pg_type element where element.oid=t.typelem and element.typtype='d' and element.typnamespace=n.oid)))
  union all
  select 'enum',format('%I.%I',n.nspname,t.typname)||':'||e.enumlabel,
    jsonb_build_object('label',e.enumlabel,'order',e.enumsortorder)::text
  from pg_enum e join pg_type t on t.oid=e.enumtypid join pg_namespace n on n.oid=t.typnamespace
  where n.nspname in ('public','private','storage')
  union all
  select 'range',format('%I.%I',n.nspname,t.typname),jsonb_build_object(
    'subtype',format_type(g.rngsubtype,null),'multirange',format_type(g.rngmultitypid,null),
    'collation',case when g.rngcollation=0 then null else g.rngcollation::regcollation::text end,
    'opclass',(select format('%I.%I',onsp.nspname,o.opcname) from pg_opclass o join pg_namespace onsp on onsp.oid=o.opcnamespace where o.oid=g.rngsubopc),
    'canonical',g.rngcanonical::regproc::text,'difference',g.rngsubdiff::regproc::text)::text
  from pg_range g join pg_type t on t.oid=g.rngtypid join pg_namespace n on n.oid=t.typnamespace
  where n.nspname in ('public','private','storage')
  union all
  select 'rewrite',format('%I.%I',n.nspname,c.relname)||':'||w.rulename,
    jsonb_build_object('event',w.ev_type,'enabled',w.ev_enabled,'instead',w.is_instead,
      'definition',pg_get_ruledef(w.oid))::text
  from pg_rewrite w join pg_class c on c.oid=w.ev_class join pg_namespace n on n.oid=c.relnamespace
  where n.nspname in ('public','private','storage')
$catalog$;

create function pg_temp.onboarding_review_state() returns text
language sql stable set search_path = '' as $state$
  select encode(extensions.digest(jsonb_build_object(
    'auth',(select coalesce(jsonb_agg(to_jsonb(r) order by r.id),'[]'::jsonb) from auth.users r),
    'profiles',(select coalesce(jsonb_agg(to_jsonb(r) order by r.id),'[]'::jsonb) from public.profiles r),
    'people',(select coalesce(jsonb_agg(to_jsonb(r) order by r.id),'[]'::jsonb) from public.internal_org_people r),
    'credentials',(select coalesce(jsonb_agg(to_jsonb(r) order by r.id),'[]'::jsonb) from private.employee_onboarding_credentials r),
    'credential_events',(select coalesce(jsonb_agg(to_jsonb(r) order by r.id),'[]'::jsonb) from private.employee_onboarding_credential_events r),
    'delivery_receipts',(select coalesce(jsonb_agg(to_jsonb(r) order by r.event_key),'[]'::jsonb) from private.notification_delivery_receipts r),
    'purge_receipts',(select coalesce(jsonb_agg(to_jsonb(r) order by r.id),'[]'::jsonb) from private.confirmed_test_identity_purges r)
  )::text,'sha256'),'hex');
$state$;
create temp table pg_temp.onboarding_review_state_before on commit drop as
  select pg_temp.onboarding_review_state() as sha256;
create temp table pg_temp.onboarding_review_catalog_before on commit drop as
  select kind,object_identity,encode(extensions.digest(definition,'sha256'),'hex') as sha256
  from pg_temp.onboarding_review_catalog();
alter table pg_temp.onboarding_review_catalog_before add primary key(kind,object_identity);
create temp table pg_temp.onboarding_review_catalog_delta(
  kind text not null,object_identity text not null,sha256 text not null,
  primary key(kind,object_identity)
) on commit drop;
insert into pg_temp.onboarding_review_catalog_delta values
('function','public.cancel_onboarding_credential_review(uuid, timestamp with time zone)','6c637483adbcc5344a1865cb5bce411af0239e11cad5d9c98f1f78c46a2b495d'),
('function','public.list_onboarding_credential_reviews()','38d75d08a1f55ecfda9c66cf2cf4df641756a8e8f9c14ad76650d56c9ec4e194'),
('function_security','public.cancel_onboarding_credential_review(uuid, timestamp with time zone)','9854602ac8fba4e8fb0b56304eb3b5cbb4259a3189d7acd7e5d977127b3f3f1e'),
('function_security','public.list_onboarding_credential_reviews()','9854602ac8fba4e8fb0b56304eb3b5cbb4259a3189d7acd7e5d977127b3f3f1e'),
('global_function_acl','public.cancel_onboarding_credential_review(uuid, timestamp with time zone)','48cbe0bdca3235e1dba22f9504e61b3c8e254ede516a33fa6fe51f6537916ca9'),
('global_function_acl','public.list_onboarding_credential_reviews()','48cbe0bdca3235e1dba22f9504e61b3c8e254ede516a33fa6fe51f6537916ca9');

create function public.list_onboarding_credential_reviews()
returns table(delivery_id uuid,employee_name text,company_key text,status text,review_code text,
  has_claimed_login boolean,due_date date,created_at timestamptz,updated_at timestamptz)
language plpgsql volatile security definer set search_path = '' as $function$
begin
  if (select auth.role()) is distinct from 'authenticated'
    or not private.is_system_portal_account_admin() then
    raise exception 'Only System Admin may review onboarding credentials.' using errcode='42501';
  end if;
  if not private.lock_portal_role_actor() or not private.is_system_portal_account_admin() then
    raise exception 'Only System Admin may review onboarding credentials.' using errcode='42501';
  end if;
  return query select credential.id,person.full_name,person.company_key,credential.status,
    credential.review_code,credential.claimed_login is not null,credential.due_date,
    credential.created_at,credential.updated_at
  from private.employee_onboarding_credentials credential
  join public.internal_org_people person on person.id=credential.person_id
  where credential.status='needs_review'
  order by credential.updated_at,credential.id;
end;
$function$;

create function public.cancel_onboarding_credential_review(p_delivery_id uuid,p_expected_updated_at timestamptz)
returns boolean language plpgsql volatile security definer set search_path = '' as $function$
declare credential private.employee_onboarding_credentials%rowtype; actor uuid := (select auth.uid());
begin
  if (select auth.role()) is distinct from 'authenticated'
    or not private.is_system_portal_account_admin() then
    raise exception 'Only System Admin may review onboarding credentials.' using errcode='42501';
  end if;
  if not private.lock_portal_role_actor() or not private.is_system_portal_account_admin() then
    raise exception 'Only System Admin may review onboarding credentials.' using errcode='42501';
  end if;
  if p_delivery_id is null or p_expected_updated_at is null then
    raise exception 'Review changed. Refresh the list before continuing.' using errcode='55000';
  end if;
  select * into credential from private.employee_onboarding_credentials
    where id=p_delivery_id for update;
  if not found or credential.status is distinct from 'needs_review'
    or credential.updated_at is distinct from p_expected_updated_at then
    raise exception 'Review changed. Refresh the list before continuing.' using errcode='55000';
  end if;
  update private.employee_onboarding_credentials set status='cancelled',updated_at=clock_timestamp()
    where id=credential.id;
  insert into private.employee_onboarding_credential_events(delivery_id,event_type,code)
    values(credential.id,'review_cancelled','actor:'||actor::text);
  return true;
end;
$function$;
revoke all on function public.list_onboarding_credential_reviews(),
  public.cancel_onboarding_credential_review(uuid,timestamptz) from public,anon,authenticated,service_role;
grant execute on function public.list_onboarding_credential_reviews(),
  public.cancel_onboarding_credential_review(uuid,timestamptz) to authenticated;

create function pg_temp.assert_onboarding_review_transition() returns void
language plpgsql set search_path = '' as $assert$
declare collector_source text; normalized_hash text;
begin
  if exists(
    (select c.kind,c.object_identity,encode(extensions.digest(c.definition,'sha256'),'hex') from pg_temp.onboarding_review_catalog() c
      except all (select kind,object_identity,sha256 from pg_temp.onboarding_review_catalog_before
        union all select kind,object_identity,sha256 from pg_temp.onboarding_review_catalog_delta))
    union all
    ((select kind,object_identity,sha256 from pg_temp.onboarding_review_catalog_before
        union all select kind,object_identity,sha256 from pg_temp.onboarding_review_catalog_delta)
      except all select c.kind,c.object_identity,encode(extensions.digest(c.definition,'sha256'),'hex') from pg_temp.onboarding_review_catalog() c)
  ) then
    raise exception 'Onboarding review contains metadata outside the exact two-RPC delta.' using errcode='55000';
  end if;
  select prosrc into strict collector_source from pg_proc where oid='private.confirmed_test_purge_schema_hash()'::regprocedure;
  if encode(extensions.digest(pg_get_functiondef('private.confirmed_test_purge_schema_hash()'::regprocedure),'sha256'),'hex')
      is distinct from '3385d5a0140df3995e3196ffea442b4829f9a5357de3ccf5a8d521fbe9011a54'
    or (length(collector_source)-length(replace(collector_source,'and p.prokind=''f''','')))/length('and p.prokind=''f''')<>2 then
    raise exception 'Onboarding review purge catalog collector changed.' using errcode='55000';
  end if;
  execute replace(collector_source,'and p.prokind=''f''',
    'and p.prokind=''f'' and p.oid not in (''public.list_onboarding_credential_reviews()''::regprocedure,''public.cancel_onboarding_credential_review(uuid,timestamptz)''::regprocedure)')
    into normalized_hash;
  if normalized_hash is distinct from current_setting('mam.onboarding_review_previous_hash') then
    raise exception 'Unrelated purge catalog change during onboarding review migration.' using errcode='55000';
  end if;
  if pg_temp.onboarding_review_state() is distinct from (select sha256 from pg_temp.onboarding_review_state_before) then
    raise exception 'Onboarding review migration must preserve accounts, credentials and protected receipts.' using errcode='55000';
  end if;
end;
$assert$;

set constraints all immediate;
select pg_temp.assert_onboarding_review_transition();
do $review_refresh$
declare candidate_hash text;
begin
  candidate_hash:=private.confirmed_test_purge_schema_hash();
  update private.confirmed_test_purge_schema set schema_hash=candidate_hash
    where singleton and schema_hash=current_setting('mam.onboarding_review_previous_hash');
  if not found then
    raise exception 'Onboarding review schema baseline changed.' using errcode='55000';
  end if;
  perform set_config('mam.onboarding_review_candidate_hash',candidate_hash,true);
end;
$review_refresh$;
set constraints all immediate;
select pg_temp.assert_onboarding_review_transition();
do $review_after$
begin
  if private.confirmed_test_purge_schema_hash() is distinct from current_setting('mam.onboarding_review_candidate_hash')
    or (select schema_hash from private.confirmed_test_purge_schema where singleton)
      is distinct from current_setting('mam.onboarding_review_candidate_hash') then
    raise exception 'Onboarding review purge fingerprint changed after transition.' using errcode='55000';
  end if;
end;
$review_after$;
drop function pg_temp.assert_onboarding_review_transition();
drop function pg_temp.onboarding_review_state();
drop function pg_temp.onboarding_review_catalog();
notify pgrst, 'reload schema';
commit;
