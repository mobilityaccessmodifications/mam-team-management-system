begin;
set local search_path='';
lock table private.confirmed_test_identity_purges,private.confirmed_test_purge_schema in share row exclusive mode nowait;
lock table private.subscription_requests,private.subscription_request_notifications in share row exclusive mode nowait;
do $$ begin
 if (select count(*) from private.confirmed_test_purge_schema)<>1
 or private.confirmed_test_purge_schema_hash() is distinct from (select schema_hash from private.confirmed_test_purge_schema where singleton)
 or encode(extensions.digest(pg_get_functiondef('private.confirmed_test_purge_schema_hash()'::regprocedure),'sha256'),'hex') is distinct from '3385d5a0140df3995e3196ffea442b4829f9a5357de3ccf5a8d521fbe9011a54'
 or encode(extensions.digest(pg_get_functiondef('private.notification_event_key_valid(text)'::regprocedure),'sha256'),'hex') is distinct from '5a4e8ef9c2913c696b59e80a30ccad75d27efe6912f45f1163188102a3c05f5e' then
  raise exception 'Subscription mail predecessor differs.' using errcode='55000';
 end if;
 perform set_config('mam.sr_mail_predecessor_hash',private.confirmed_test_purge_schema_hash(),true);
end $$;
create function pg_temp.sr_mail_inventory()
returns table(kind text,object_identity text,definition text)
language plpgsql stable set search_path = '' as $catalog$
declare builtin_count bigint; builtin_hash text;
begin
  if exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname !~ '^pg_(toast_)?temp_' and p.prokind<>'f'
      and not (n.nspname='pg_catalog' and p.oid<16384)) then
    raise exception 'Subscription requests requires the reviewed built-in non-function routine inventory.' using errcode='55000';
  end if;
  with routines as (
    select format('%I.%I(%s)',n.nspname,p.proname,oidvectortypes(p.proargtypes)) as identity,p.prokind as kind,
      jsonb_build_object('proc',to_jsonb(p)-'oid',
        'aggregate',case when p.prokind='a' then to_jsonb(a)-'aggfnoid' else null end) as metadata
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace left join pg_aggregate a on a.aggfnoid=p.oid
    where n.nspname !~ '^pg_(toast_)?temp_' and p.prokind<>'f'
  )
  select count(*),encode(extensions.digest(coalesce(jsonb_agg(jsonb_build_array(r.identity,r.kind,r.metadata)
    order by r.identity collate "C"),'[]'::jsonb)::text,'sha256'),'hex') into builtin_count,builtin_hash from routines r;
  if builtin_count<>172 or builtin_hash is distinct from (case current_setting('server_version_num')::integer/10000
    when 16 then 'c87f2f680aab3a071915bcc5c7774820f57a7e6c20b5be465cd3dffada088512'
    when 17 then 'd6785c452e91fdc4bdeb4e75a3d07e003d778eb59831717421f45bb63bd71f75'
    else null end) then
    raise exception 'Subscription requests built-in non-function routine metadata changed.' using errcode='55000';
  end if;
  return query
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
  select 'function',n.nspname||'.'||p.proname||'('||oidvectortypes(p.proargtypes)||')',
    case when p.prokind in ('a','w') then jsonb_build_object('proc',to_jsonb(p)-'oid',
      'aggregate',case when p.prokind='a' then to_jsonb(a)-'aggfnoid' else null end)::text
      else pg_get_functiondef(p.oid) end
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace left join pg_aggregate a on a.aggfnoid=p.oid
  where n.nspname !~ '^pg_(toast_)?temp_'
  union all
  select 'routine_kind',n.nspname||'.'||p.proname||'('||oidvectortypes(p.proargtypes)||')',p.prokind::text
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname !~ '^pg_(toast_)?temp_'
  union all
  select 'function_security',n.nspname||'.'||p.proname||'('||oidvectortypes(p.proargtypes)||')',jsonb_build_object(
    'owner',r.rolname,'acl',p.proacl::text,'config',p.proconfig,'security_definer',p.prosecdef,
    'volatility',p.provolatile,'strict',p.proisstrict,'parallel',p.proparallel,'leakproof',p.proleakproof)::text
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace join pg_roles r on r.oid=p.proowner
  where n.nspname !~ '^pg_(toast_)?temp_'
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
  select 'global_function_acl',n.nspname||'.'||p.proname||'('||oidvectortypes(p.proargtypes)||')',coalesce(p.proacl,acldefault('f',p.proowner))::text
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname !~ '^pg_(toast_)?temp_'
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
  where n.nspname in ('public','private','storage');
end;
$catalog$;
create temporary table sr_mail_catalog_before on commit drop as
select kind,object_identity,encode(extensions.digest(definition,'sha256'),'hex') definition_hash from pg_temp.sr_mail_inventory();
create temporary table sr_mail_removed(kind text,object_identity text,definition_hash text) on commit drop;
insert into sr_mail_removed values
('function','private.notification_event_key_valid(text)','5a4e8ef9c2913c696b59e80a30ccad75d27efe6912f45f1163188102a3c05f5e');
create temporary table sr_mail_added(kind text,object_identity text,definition_hash text) on commit drop;
insert into sr_mail_added values
('column','private.subscription_request_mail_deliveries.claim_token','bc862bc491c79e380eb65cfdaa25df215cf53f6d6ea40d2cb92df347a637fc88'),
('column','private.subscription_request_mail_deliveries.claimed_at','bce820bcebc4a8707981af1e57acf8702f97694ec8f50aa61e229960398aa644'),
('column','private.subscription_request_mail_deliveries.delivered_at','82493a35fb5020838787bfb7b90dec24c6ba02143963911b048d8eaac148889f'),
('column','private.subscription_request_mail_deliveries.request_id','652219c5442a9aa75c9914348de1bb4f02c16fc10c41ace8445c2bb95a8ac76c'),
('column','private.subscription_request_mail_deliveries.version','43ee491a3352508276c4ae9228716a5201e1046652bf3dfcff61847b5c0ed879'),
('column','private.subscription_request_mail_deliveries_pkey.request_id','352d7a15f2ee1b56b2eb4d0c8b16f60f41bdf755c9bcb623898fe3d7dbea56ab'),
('column','private.subscription_request_mail_deliveries_pkey.version','306215ef05afb0c9cb80a27d899c5a62d0c7a158e1e53fd1c76b8cea59b4da97'),
('constraint','private.subscription_request_mail_deliveries:subscription_request_mail_deliveries_pkey','fe3ec764ef915f5818ded535ba560081d661373a0af02eedaa6cf8eaf18eac97'),
('constraint','private.subscription_request_mail_deliveries:subscription_request_mail_deliveries_request_id_version_fkey','c38ab9b57db3487d3c76dda09b1bf0e42f36c453b72b294d93ddb3afce25c471'),
('function','private.notification_event_key_valid(text)','19b31d1a98015146acdd337e198d560dae29aa95a2c519a833dc11c5d81a46ad'),
('function','public.claim_subscription_request_mail(uuid, integer)','d936b77ac884dbb772de1216e7211451f8e5057b2726a1f7c974c2796f4b8f76'),
('function','public.finish_subscription_request_mail(uuid, bigint, uuid, boolean)','0b27b2c5b0405b05c9ded68f56ecde7e64bdafec4b2b901ca1dde5270685fcf6'),
('function_security','public.claim_subscription_request_mail(uuid, integer)','c8dc8f274369710266018b19f1a1f63f49158d16fde0f707e92f4f4ddd0d20de'),
('function_security','public.finish_subscription_request_mail(uuid, bigint, uuid, boolean)','c8dc8f274369710266018b19f1a1f63f49158d16fde0f707e92f4f4ddd0d20de'),
('global_function_acl','public.claim_subscription_request_mail(uuid, integer)','fbafe3bfaed21ba605e4c84f054cfe31484d3df07d5445aa6ebfb7f1a277f4e3'),
('global_function_acl','public.finish_subscription_request_mail(uuid, bigint, uuid, boolean)','fbafe3bfaed21ba605e4c84f054cfe31484d3df07d5445aa6ebfb7f1a277f4e3'),
('global_relation_acl','private.subscription_request_mail_deliveries',case current_setting('server_version_num')::integer/10000 when 16 then 'c0e6bb2dbd327bd3c3ef5cf70c329910a5853d629417887f257e091ff5b73577' when 17 then 'd51696be62bea2471822f7114b081fc4989012a076cf2721dc1bf1139b89773d' end),
('index','private.subscription_request_mail_deliveries_pkey','1e592afdb26ab7f90f79806887d008ed43b88afa51285d9dd65dfe07cb5cbd84'),
('relation','private.subscription_request_mail_deliveries',case current_setting('server_version_num')::integer/10000 when 16 then '23004a5648ab8cfd403aca4079c055b0b556ecdd61e6f8fc787ccf8765642d19' when 17 then 'ee62aacc4551fcd30dfc8f51c25773931805de7d6aa6210d0466c5aa1be5b89b' end),
('routine_kind','public.claim_subscription_request_mail(uuid, integer)','252f10c83610ebca1a059c0bae8255eba2f95be4d1d7bcfa89d7248a82d9f111'),
('routine_kind','public.finish_subscription_request_mail(uuid, bigint, uuid, boolean)','252f10c83610ebca1a059c0bae8255eba2f95be4d1d7bcfa89d7248a82d9f111'),
('type','private._subscription_request_mail_deliveries','2508130432d0c805e26c0c97c5702fa508f99be3d00d56928caed465c0b00fae'),
('type','private.subscription_request_mail_deliveries','5e6ec55b0a56620f678e846aafee05c77a60c28556f80a5591faacd70fec029a');
create temporary table sr_mail_data_relations on commit drop as
select format('%I.%I',n.nspname,c.relname) name from pg_class c join pg_namespace n on n.oid=c.relnamespace
where n.nspname in ('public','private','storage') and c.relkind in ('r','p') and c.oid<>'private.confirmed_test_purge_schema'::regclass;
create function pg_temp.sr_mail_data() returns jsonb language plpgsql set search_path='' as $$
declare item record; value text; result jsonb:='{}';
begin
 for item in select name from sr_mail_data_relations order by name loop
  execute 'select encode(extensions.digest(coalesce(string_agg(to_jsonb(t)::text,E''\n'' order by to_jsonb(t)::text collate "C"),''''),''sha256''),''hex'') from '||item.name||' t' into value;
  result:=result||jsonb_build_object(item.name,value);
 end loop;
 return result;
end $$;
create temporary table sr_mail_data_before on commit drop as select pg_temp.sr_mail_data() value;
create table private.subscription_request_mail_deliveries (
  request_id uuid not null, version bigint not null,
  claim_token uuid, claimed_at timestamptz, delivered_at timestamptz,
  primary key(request_id,version),
  foreign key(request_id,version) references private.subscription_request_notifications(request_id,version) on delete restrict
);
alter table private.subscription_request_mail_deliveries enable row level security;
revoke all on private.subscription_request_mail_deliveries from public,anon,authenticated,service_role;

create function public.claim_subscription_request_mail(p_request_id uuid default null,p_limit integer default 25)
returns table(request_id uuid,version bigint,claim_token uuid,payload jsonb)
language plpgsql security definer set search_path='' as $$
declare item record; token uuid; previous private.subscription_request_mail_deliveries;
begin
  if p_limit is null or p_limit<1 or p_limit>25 then raise exception 'Invalid claim limit.' using errcode='22023'; end if;
  if not exists(select 1 from private.subscription_request_config c where c.singleton and c.enabled) then return; end if;
  for item in
    select n.request_id,n.version,r.applicant,e.payload,person.full_name,lower(btrim(details.work_email)) work_email
    from private.subscription_request_notifications n
    join private.subscription_requests r on r.id=n.request_id and r.version=n.version and r.status='submitted'
    join private.subscription_request_events e on e.request_id=n.request_id and e.version=n.version and e.operation='submit'
    join public.internal_org_people person on person.auth_user_id=r.applicant and person.is_active and person.node_kind='person'
    join private.employee_directory_details details on details.person_id=person.id
    left join private.subscription_request_mail_deliveries d on d.request_id=n.request_id and d.version=n.version
    where n.event='submit'
      and exists(select 1 from private.portal_role_policy(r.applicant))
      and (select count(*) from public.internal_org_people p where p.auth_user_id=r.applicant)=1
      and length(btrim(details.work_email))<=254 and lower(btrim(details.work_email)) ~ '^[^[:space:]@,;]+@[^[:space:]@,;]+\.[^[:space:]@,;]+$' and (p_request_id is null or n.request_id=p_request_id)
      and d.delivered_at is null and (d.claimed_at is null or d.claimed_at<clock_timestamp()-interval '15 minutes')
    order by n.created_at,n.request_id limit p_limit for update of r skip locked
  loop
    insert into private.subscription_request_mail_deliveries(request_id,version) values(item.request_id,item.version) on conflict do nothing;
    select * into previous from private.subscription_request_mail_deliveries d where d.request_id=item.request_id and d.version=item.version for update;
    if previous.delivered_at is not null or previous.claimed_at>clock_timestamp()-interval '15 minutes' then continue; end if;
    token:=extensions.gen_random_uuid();
    update private.subscription_request_mail_deliveries d set claim_token=token,claimed_at=clock_timestamp() where d.request_id=item.request_id and d.version=item.version;
    return query select item.request_id,item.version,token,jsonb_build_object(
      'version',1,'event','subscription-request-submitted','deliveryId','subscription-request:'||item.request_id::text||':'||item.version::text,
      'applicantName',item.full_name,'applicantWorkEmail',item.work_email,
      'request',jsonb_build_object('service',item.payload->>'service','plan',item.payload->>'plan','purpose',item.payload->>'purpose',
        'company',item.payload->>'company','duration',item.payload->>'duration','billing',item.payload->>'billing',
        'currency',item.payload->>'currency','quoteCents',item.payload->'quoteCents','audEstimateCents',item.payload->'audEstimateCents',
        'noQuoteReason',item.payload->>'noQuoteReason','intendedUsers',item.payload->>'intendedUsers'));
  end loop;
end $$;

create function public.finish_subscription_request_mail(p_request_id uuid,p_version bigint,p_claim_token uuid,p_delivered boolean)
returns boolean language plpgsql security definer set search_path='' as $$
begin
  if p_delivered is distinct from true then return false; end if;
  update private.subscription_request_mail_deliveries d set delivered_at=clock_timestamp()
  where d.request_id=p_request_id and d.version=p_version and d.claim_token=p_claim_token and d.delivered_at is null;
  return found;
end $$;
revoke all on function public.claim_subscription_request_mail(uuid,integer),public.finish_subscription_request_mail(uuid,bigint,uuid,boolean) from public,anon,authenticated;
grant execute on function public.claim_subscription_request_mail(uuid,integer),public.finish_subscription_request_mail(uuid,bigint,uuid,boolean) to service_role;
create or replace function private.notification_event_key_valid(p_key text)
returns boolean language sql immutable set search_path = '' as $$
  select coalesce(length(p_key) <= 160 and p_key ~ (
    '^(leave:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:' ||
    '(leave-submitted|leave-approved|leave-declined|leave-cancelled|leave-conditionally-approved|leave-reminder|team-birthday):[0-9a-f]{24}' ||
    '|payroll-balance:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:[0-9]{4}-(0[1-9]|1[0-2])' ||
    '|payroll-comparison:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' ||
    '|new-starter:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:day-one:(test|live)' ||
    '|checkin:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:(2-week|1-month|2-month|3-month|5-month|6-month|6-month-casual):initial:(test|live)' ||
    '|checkin-review:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:hr:[1-9][0-9]*:(test|live)' ||
    '|onboarding-credential:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' ||
    '|subscription-request:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:[1-9][0-9]*)$'
  ), false)
$$;

revoke all on function private.notification_event_key_valid(text) from public,anon,authenticated,service_role;
create function pg_temp.sr_mail_assert_delta() returns void language plpgsql set search_path='' as $$
begin
 if exists(with actual as materialized (
   select kind,object_identity,encode(extensions.digest(definition,'sha256'),'hex') definition_hash from pg_temp.sr_mail_inventory()
  ), expected as materialized (
   (select * from sr_mail_catalog_before except all select * from sr_mail_removed) union all select * from sr_mail_added
  ) select 1 from ((select * from actual except all select * from expected) union all (select * from expected except all select * from actual)) drift)
 or pg_temp.sr_mail_data() is distinct from (select value from sr_mail_data_before)
 or exists(select 1 from private.subscription_request_mail_deliveries) then
  raise exception 'Subscription mail exact catalog or protected data differs.' using errcode='55000';
 end if;
end $$;
set constraints all immediate;
select pg_temp.sr_mail_assert_delta();
do $$ declare candidate text; changed integer; begin
 candidate:=private.confirmed_test_purge_schema_hash();
 update private.confirmed_test_purge_schema set schema_hash=candidate where singleton and schema_hash=current_setting('mam.sr_mail_predecessor_hash');
 get diagnostics changed=row_count;
 if changed<>1 then raise exception 'Subscription mail predecessor ledger changed.' using errcode='55000'; end if;
 perform set_config('mam.sr_mail_candidate_hash',candidate,true);
end $$;
set constraints all immediate;
select pg_temp.sr_mail_assert_delta();
do $$ begin
 if (select count(*) from private.confirmed_test_purge_schema)<>1
 or (select schema_hash from private.confirmed_test_purge_schema where singleton) is distinct from current_setting('mam.sr_mail_candidate_hash')
 or private.confirmed_test_purge_schema_hash() is distinct from current_setting('mam.sr_mail_candidate_hash') then
  raise exception 'Subscription mail final catalog differs.' using errcode='55000';
 end if;
end $$;
commit;
