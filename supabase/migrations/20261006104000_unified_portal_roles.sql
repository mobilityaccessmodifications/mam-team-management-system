begin;

do $$ begin
  if current_setting('server_version_num')::integer/10000 not in (16,17) then
    raise exception 'Unified role migration requires reviewed PostgreSQL 16 or 17 metadata.' using errcode='55000';
  end if;
end $$;

do $$ begin
  if private.confirmed_test_purge_schema_hash() is distinct from (select schema_hash from private.confirmed_test_purge_schema) then
    raise exception 'Unified role migration requires the reviewed confirmed-test purge schema baseline.' using errcode='55000';
  end if;
end $$;

do $$ begin
  if encode(extensions.digest(pg_get_functiondef('private.confirmed_test_purge_schema_hash()'::regprocedure),'sha256'),'hex')
    is distinct from '3385d5a0140df3995e3196ffea442b4829f9a5357de3ccf5a8d521fbe9011a54' then
    raise exception 'Unified role migration requires the reviewed purge catalog collector.' using errcode='55000';
  end if;
end $$;

create function pg_temp.unified_role_transition_catalog()
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

do $storage_type_compatibility$
declare reviewed_catalog_additions jsonb := '{"enum|storage.buckettype:ANALYTICS":"c275dae6976a18b8e6a7690d44b7d9d335249d0f51714ab92949544184a71a76","enum|storage.buckettype:STANDARD":"0546316b4565ec12b355dd2c73b103da95d02a9e8db979883bfaabf9b0f7bfe0","enum|storage.buckettype:VECTOR":"a73af622371b4f7a6e5b8ca0c1e1dd65d718f6789726e628b7b7c37a337c0009","type|private._employee_identity_consolidations":"9890a237eccc557b4858af97f4186d3717731e46758588101a9e7a66e5897aa2","type|private._payroll_carryforward_events":"78020a1efa0c78861f855a4b0756434e21e818f68b363458f81ff163cb423e75","type|private._payroll_closing_receipts":"c707f3c444fe4943b5f6e10a1d6cec992fcb04346c5bacc438d1f7874f5e7765","type|private._payroll_closing_write_claims":"f68e84e999622ea14e0091bfdbce283b58a952ee904543022fc8957eacc16a7e","type|private._portal_account_test_sessions":"72ea95b46ee2340b4dc0b52711b750f1315bd323311c9ca64929bcba45c7178b","type|private.employee_identity_consolidations":"a1181cc1cfe7134daf44a4d484c4c878bc3fbdef0923b8af960a1648d9edaf40","type|private.payroll_carryforward_events":"b7ae413f2594c805de74f6e67b74ae2590b96f8b3b569e5d03d4880515574054","type|private.payroll_closing_receipts":"a9b8953bf8f9a57495f8708253538d22d66342cd3ce33e152e60e9d6427890b2","type|private.payroll_closing_write_claims":"28d16ecc5eea24b65a396792ae71704330b355a6cef97e88602f469f49b5e48a","type|private.portal_account_test_sessions":"b1d7866c5d58c7c9b551ba41ef2688dba5cc7078d81603977fbe181cfa379e5e","type|storage._buckets_analytics":"3dfa0022e92afa59e456621a4154a1d2ba06c7e5c77e49d10b6985ab00e80884","type|storage._buckets_vectors":"28c369f10abc4ae88ee4a6c851c2a67460a2f332a39c5e139534c89dfe09f911","type|storage._buckettype":"392f3fd33c176849bd9b2f7fb350a853445a9b1fd66f9699c06db53497bf7f96","type|storage._migrations":"b6767eeeed27bf8d597d4bc7266129e2fc3c6aecb1757627b0bfc3f971f3e183","type|storage._s3_multipart_uploads":"666e145354dd92a755091be31da9eb83b353c85edc6619fa981667f9587a8dde","type|storage._s3_multipart_uploads_parts":"9dc18cd1139884128200e4682fd2263dfbcdd8e1ffc3404bf00e619bda62f6d2","type|storage._vector_indexes":"52c7c01bc315bc3c6f176769372d51b249cbb2bd23cbc53a4043ed9aa6372041","type|storage.buckets_analytics":"d3523432e3c164b0ab56c3c410fd54d85151bea1cc0fe246695706df2cbdf2db","type|storage.buckets_vectors":"b742c1426d585d2ecdf824c91e510568f1562d63502d2a5af373e31d46128eba","type|storage.buckettype":"8bbd2614b50b69e03181c81722584f85a4f9a3012b2a25373aa6b535b71f8eaa","type|storage.migrations":"5d1a3b3986539c5b2db54eded16eb5cbb3e8a06473ce20714274e60ad8008646","type|storage.s3_multipart_uploads":"96e141c86cb24b032847275f487b01a588f87a514f99a6114fad4d073a5a404e","type|storage.s3_multipart_uploads_parts":"d0b7a84ea8a6c051d3ac849abb6d22f8ce7285d89d31331262934110dfae473e","type|storage.vector_indexes":"576023e68040a6623ddb87b8c0dae8f406e01add8e7515729185d9716f80ef24"}'::jsonb;
begin
  if exists (
    select 1 from jsonb_each_text(reviewed_catalog_additions) expected(object_key,sha256)
    left join pg_temp.unified_role_transition_catalog() c
      on expected.object_key=c.kind||'|'||c.object_identity
    where expected.sha256 is distinct from encode(extensions.digest(c.definition,'sha256'),'hex')
  ) then
    raise exception 'Unified role migration requires exact reviewed catalog additions.' using errcode='55000';
  end if;
  if (select encode(extensions.digest(coalesce(jsonb_agg(to_jsonb(c)
      order by kind collate "C",object_identity collate "C"),'[]'::jsonb)::text,'sha256'),'hex')
    from pg_temp.unified_role_transition_catalog() c
    where kind in ('type','enum','range','rewrite')
      and not (reviewed_catalog_additions ? (kind||'|'||object_identity)))
    is distinct from '0830e83e54e5b78db5cdcfed915e37d8bd1415a5b7acfdfbb7de76604f645909' then
    raise exception 'Unified role migration requires the reviewed type and rewrite baseline.' using errcode='55000';
  end if;
end $storage_type_compatibility$;

create temp table pg_temp.unified_role_catalog_before on commit drop as
  select * from pg_temp.unified_role_transition_catalog();
alter table pg_temp.unified_role_catalog_before add primary key(kind,object_identity);
create temp table pg_temp.unified_role_catalog_delta(
  kind text not null,object_identity text not null,before_sha256 text,after_sha256 text not null,
  primary key(kind,object_identity)
) on commit drop;
insert into pg_temp.unified_role_catalog_delta(kind,object_identity,before_sha256,after_sha256) values
('function','private.guard_system_admin_account_target()',NULL,'87014a854e5cfa7e5f88f0ce0096c49fc68e8e25517ef67f21b71f383293ab04'),
('function_security','private.guard_system_admin_account_target()',NULL,'67f77240be35694c25f9a905775c20494865d6890bee22272ca82d458643a37d'),
('global_function_acl','private.guard_system_admin_account_target()',NULL,'c027e95beca64045f15d2075c66162eeeeb192e6756be61c73f91c7ce14dd4f3'),
('trigger','private.portal_account_status_change_claims:aa_system_admin_account_target',NULL,'bd9bf49d25d4124997b15b949fd13fd785e70ad138d69fe6b0890a82fd4244e2'),
('trigger','private.portal_password_reset_claims:aa_system_admin_account_target',NULL,'69bdd2c335484d2169b3a3fa8f10c007af243725e74e0dd93af791b2440dc5fe'),
('trigger','public.internal_org_people:aa_system_admin_account_target',NULL,'6d6a004c18e9344902dde9c099cc87b5ee80a18eb3d2180c48922a023cec464a'),
('trigger','public.profiles:aa_system_admin_account_target',NULL,'1d6f72369cff95e757849f053dd88a2af153efb2b5841d96f35c478fd85f4543'),
('type','private._subscription_management_grant_events',NULL,'7f8108c45491d0fa2394bd86c4477adbc0dfe241858c2171033f71291892b8f2'),
('type','private.subscription_management_grant_events',NULL,'e0ec833a9aec51cfdd099b441b98cf21540a4593a6aa533b3b5ac58279637646'),
('column','private.payroll_balance_import_batches.preview_person_id',NULL,'239d631ac38b62f990e0e17e40a1668e3f714c7fc7af156bb0d3be602f88cb08'),
('column','private.subscription_management_grant_events.actor_user_id',NULL,'8d30b465a77cd283a787a377aa282c3c753e3e31f7d35313c714c437f5f2e23f'),
('column','private.subscription_management_grant_events.after_person_ids',NULL,'e18cd9cb51cc3c230d1b902a829a97f409f3e5a8001417fbd06e1c6455fdda64'),
('column','private.subscription_management_grant_events.before_person_ids',NULL,'055fa59f03ca4363336c97ac14b313547f8ecfa0dba56f1d565ea25bd7098fa8'),
('column','private.subscription_management_grant_events.created_at',NULL,'be398acfa5d9d0dcb83cec2fe9670a09c1ed2d5782fe8ecb34d16a2117ac8cb1'),
('column','private.subscription_management_grant_events.id',NULL,'b3e2b3e7a4efdaae57614e9ea41e1f9270c9f7af703ca35a1350f7dfb5c2d890'),
('column','private.subscription_management_grant_events_id_seq.is_called',NULL,'f7b02b34686315e96bbf42bc082ebaa7ae1f279ec02be176cbe84da044608bcc'),
('column','private.subscription_management_grant_events_id_seq.last_value',NULL,'ebea4c5a0a1b32adf994f04928010d5a91e5e0ebc4508feb63afc7344b7954e7'),
('column','private.subscription_management_grant_events_id_seq.log_cnt',NULL,'43ee491a3352508276c4ae9228716a5201e1046652bf3dfcff61847b5c0ed879'),
('column','private.subscription_management_grant_events_pkey.id',NULL,'8ff518547b84ae04115b453d9b3216d50cc652373dcaaa08bc72daac9b77e2ed'),
('constraint','private.payroll_balance_import_batches:payroll_balance_import_batches_preview_person_id_fkey',NULL,'aa3224ec9fdb75adf91fb8c37323b1a58d57d1ccd037c4a0e2a8a33d7fd809e9'),
('constraint','private.subscription_management_grant_events:subscription_management_grant_events_actor_user_id_fkey',NULL,'5bdeddd7aaff1b182a3e8662078c641c7871fcdb58e2b29d310bf6e1aa4260da'),
('constraint','private.subscription_management_grant_events:subscription_management_grant_events_pkey',NULL,'ceeed3e1b6b0f71197286468986349d099d90ea1af0bc7dc10eec8147ca0bd38'),
('constraint','public.profiles:profiles_app_role_check','3d6a93962956c40d0f7534a4154d71007f99d61b30642959a7a37507e84720f4','46b16eca0c793b095b2f25be72ce013bbb9d3a17e94c93e2e7eb7897e1c56769'),
('function','private.can_add_my_leave_request_attachment(uuid)','e8bdfeb1a96921e3e38751a34f60b18da42bb1ed985133811c74fb9d53d72da9','5b20008e18bbf32d1cbf8e55419bf20a62590049b6d37d5c8d26ab7761dd288f'),
('function','private.can_review_leave_request(uuid)','735c2cb01a0a03ee09ddccdd490a19cc90f463a39a061ab417fc5ef4cd70be89','ebd1a763b3784cb438783f164edfb68e97d797e2b3f9f6bd611f5538d268d473'),
('function','private.can_submit_team_leave(uuid, uuid)','476316c223f0626fe683048d3bf57ecf41c1f0f261081d4e9d8398feda862390','d4e50e65679a4ebc833bfb8d704744e9cffcef5a83561a87f567b3249034f16f'),
('function','private.can_view_all_approved_leave_calendar_for(uuid)','95e2823ec984b5c8a8857c700ec726609125b38ba7fd93574726889b193981d2','06fd61864cf3d490ba0fd19df3120b2b60a7574559810a6d29ea6efd9f1ede15'),
('function','private.can_view_archived_employee_profiles()','6efe2347db5659528cac2da6e7956d0f987ce737a066da576391b9061670638c','faf80d317cac81d8833ddc5311b9a0149726687e7caf57521f7050cd57407124'),
('function','private.can_view_people_operational_tabs()','a780b40f11799de9069da98757f86fb16b7ffc5b74a6f5b6fd9faf82af9fcb98','891ff9019bfad099ce2588fc146d064c3af4a616c5868db0315645dbc351e3f0'),
('function','private.employee_work_schedule_workspace_json_for_actor(uuid, boolean, uuid, boolean, uuid)',NULL,'c74c143d5507c7dcbf588252abe08949b981ac7ef81420ba86dacd12cb5e79c7'),
('function','private.freeze_payroll_balance_comparison(uuid)',NULL,'23439afa06e8c51f8da3d221684f08e6a1e184a9ab555f9112dd081cfebae9b5'),
('function','private.has_configured_global_employee_check_in_access(uuid)','8957b519deada99229fe0e10490c0b33282367e02385983aecc5b97045d320a1','1d608b36e856adbe28619d239e0097dddd61c6a3087f3030e767efad660a46ca'),
('function','private.has_current_portal_access()','1de9bb733549c056a69a226ef261a91a6d7723a018b91f5f069e44ad44c64a21','e3214e6e8a64c7cc8274d53e73c7fbbf1218521dcac0996cb1477ae91fd62eb8'),
('function','private.has_employee_check_in_workspace_access()','927fc4b810d42c208cc3389096765c1616f51fcca033307d5fb122397b954165','dd5cb6599a7fd2a9bc7891887d3207aad665a69634cc93d50f5f4c0221eca73d'),
('function','private.has_leave_register_read_grant(uuid)','16fd929aee39ffcbe272bd86774751a2fe457aed292edf9a3aa292ce525c15ca','eee974fe9d62aa753bc82d38aedfc03a145ef129f96ba46f2130248b1b2eca8a'),
('function','private.has_payroll_balance_import_access()','44817e23dac0540580ae5c4ff15f61596cacfd63a15c7085065da3b01c575530','593ac7258aff1bd5692c3447691f4d25841f0940193bb2fd24ea0da56c56f8fd'),
('function','private.has_payroll_balance_import_access_for(uuid)','86b8e54d28b3365808d9ac9e3d5a4e9145262f7f697f25979e243728bc4b0fd7','3c0d080c923cefa420958bb0d74b52da698f1c058462b60fde35a15f3e3f08a7'),
('function','private.is_current_leave_request_reviewer(uuid, uuid)','4f56712eb8073104454f77c7712a98812168ee8a29d453131f256da5318b9f26','c3457b896737a2dbc75155c208a1206b05b4c3167748b35b9e638e2b490ecd73'),
('function','private.is_current_subscription_credential_manager()','5c1fb3f32f90c1e349ff91695a2956040cf4d4314ab8dfbdbac0a65dad00fdc0','dc08b444994613cfd36b36f3cb0975434807fa5dc24ea6c96664a4640566d15c'),
('function','private.is_internal_org_hr()','83b6c7a49760ff22ee3c453e1b300d623247af3d42707b21d09822356805838c','08b024626a122d3a2190afd6f86f8c770a256f498536d52ca57829539a068605'),
('function','private.is_internal_org_member()','625491f78599364a5cdd8cb08644b32f5fbce82f91cf323b234d7798db943731','1cb0fa099eea93c21bda7734b097d930096a8dd1af6ca087bf9e2da8bc490cbb'),
('function','private.is_operational_portal_admin()',NULL,'5ec6857459aed38fce5bbfc8bfe1963cd5db8ac2d28f55ad1e1e8862bfc2d8d6'),
('function','private.is_portal_account_admin()','abf3859afab0412f48b0d6bbf8ddfbd500f00971bebd2f295e84bbd294b447ba','ad9598db0530fd734e6b2829f64bd94153d0f8b0cdb35a37fb6fe3e0ea302f33'),
('function','private.is_system_portal_account_admin()','5bfe267f05d59c56ddb497788a91fe336f1aef90802dee581bac07a0e09ada77','6347635e6b97237fe5e212d2c9817e477a91641ec0a27e9e9a6a1d4ca3ce4a25'),
('function','private.list_calendar_birthday_person_ids_for(uuid)','8808ae6aa6ac78c059752e5c6f82505fb37b931c236a10460bec6c9e3c5121a5','335e90a19308f17359b4a59a6ecc121bfd83babb9d710eb3700e78ff361f74d5'),
('function','private.list_visible_employee_check_in_person_ids()','9f3093f3d70f6d7e8d695761e56638de9104b524585e8b4c112b693bce4cbb45','a30be6fa60a3b4ef34b4bb69024ad28e7aee7b41414def496b342a063274613e'),
('function','private.lock_portal_role_actor()',NULL,'b0c9f1ef54c2a84a6630b1cd3c42d6534a6620958459fb24ee20bcb291e1f8b0'),
('function','private.lock_subscription_role_authority(boolean)',NULL,'d6f97626463f2ef66773235207e860d2270e00e92167ee9c7493488a819bbd87'),
('function','private.payroll_balance_import_projection()','f71ae0a565f611be04af6c440869ea86301f25f96cb946fd7bf5bfde139f9571','caa1f5a37467032f81264f8a4cbaf7e7a10cd4b7046d55bf8c4a12618b0307cc'),
('function','private.payroll_comparison_only(uuid)','c2ba637c9778e05821211019154ba88095dc04e4273be74dd7bb2afe6f7c713d','d5ea35614888a18bfd77e9ab09122d304f7511e85164f231b34207b51fe58119'),
('function','private.portal_role_policy(uuid)',NULL,'8f6bba78aefb558d8bce5ee3e91a4c6f7aeabd0fecd01495b54ee03389ae2b54'),
('function','private.resolve_internal_org_employee_manager(uuid)','2c0f99a87ae457265f44cd752a15c29ef916ea5c3408ad01de449bbe852bf3a7','834b8c3e0b0b96635504b6dacdbffa7e98ce0695a5aacc03e623f2decf5cb27c'),
('function','private.resolve_leave_approval_grants(uuid)','fafec2c251bf537794c2a8941fcdcebfdd61576ec4634e41b6b1dc1666326d2a','3a9a9a8819cc3847a93fe517e32b5e0226668ec7572812b44d2e21bbe10b4de3'),
('function','private.set_subscription_company(uuid, text)','28f539c5d7edd57cb77ff6b0ccaafd432b5f49977d46f1fc0b5ace7fcd1d4420','1ca409ee118b456b747c635439071dcb403a2d1fc32993c474b46e1158da5779'),
('function','private.validate_subscription_role_delegates(uuid[])',NULL,'d7fa828df293f3bfec247e78ead54de571c52a22219e546c20f20ba55b566793'),
('function','public.approve_employee_check_in_employment_decision(uuid, bigint)','3fd96e798b4744249ec09e5b688a17f42f607d46c889ab68f5241ed97fa3ec21','b151f58282a6eadda8dcf111d7a964440d61ea5e02e2cdea404c3eba3455db3d'),
('function','public.archive_employee_directory_record(uuid, bigint, bigint, date, text)','9e07fe800745add49b3e3c93d3b1d81a3bfb848f33c0833fb1f119b1eaecc50f','9fbb4e10f6b99ebdcc6d773efdfadeea42b2b546687c32a73fdbb8ed42673fc8'),
('function','public.begin_portal_account_status_change(uuid, uuid, boolean, bigint)','7d2876cfb4752e52ce519a68229055f38f51975f5f9a941ae7dd058a90673cd8','89323955d5605589d0520619482ac3bb78875ac5f49e82822bf846a7b6224b89'),
('function','public.can_access_non_roster_system_admin_workspace()','0f030ab9e26a89475237e7861c8eff7d412251235775181bbf7fc4f3a7a0ca1e','cb860b9d255118ce98573360147c4a875424a87d666a49ea4d2415c58f5e8c6b'),
('function','public.can_edit_internal_org()','c84296550ffeba95b03f1ca7453f7203aefcc783d90041682a3310e80f982ee3','017fe04c8c1c8c71908f42e37d492e544357ed7c37d251fde11a0bf7d809f619'),
('function','public.can_import_payroll_balances_for_preview(uuid)','0faa6cbe8b8c032ed0d25993433f5759d56dc7b158dfee99c1eb40b9223f0a03','d469fb056ffc2eaf6272b6aef0a235acd0496bf556dc401c7ef258e17176d30e'),
('function','public.can_manage_employee_directory()','a3bce1f1373fd1b869e87d2aab0451eb94254867bdc4c839a90efce1d8ca053b','04b8eba9fa0ae27f193118f52a9c111dbecf3dcfe4c79230f344af48ad296ebc'),
('function','public.can_manage_it_assets()','2b4abf1b8f1196813b38ac446187fd142a6de743bf11464058e1dc38c235e2cf','45ceb91292dd7ad50db6c427cb3a6c3c9979cbba32f1f038701f6a8c3c8a4020'),
('function','public.can_manage_payroll_balance_import_grants()','cefa644ef0483274f08c36fc8f01040227105d82c4946c9cfa8c03db83072163','79bcb73458842e902eb153b4d6f68fec66c2e73eb17a00d157667711ff567c7e'),
('function','public.can_manage_portal_accounts()','708dcb362b3ae7305684cefb88690738059b6bd8362b97d22acd865edec4c1b3','5e550f9d379dfc07885b0d12fac680052b2eb2e8937a028a5c308ed3e0b20829'),
('function','public.can_manage_subscriptions()','3945f03f15a23f0c56c25be20a81ac0f0f5c07775ee1d6a523012821083ed83c','7b50e669cb7c903241acd9bbec70f5b383655baf15a75685efc2665e2af29105'),
('function','public.can_review_leave_workspace()','7049b979b4721e2f93300b59bb35923ae8dcd289d556044863a2e082f8bb8adf','18f15ab9fb83d070ea82011e4a685719cbf39ece9818a36ff95a18e4ab1708c4'),
('function','public.can_view_all_leave_requests()','38f9e2538ea82dad7608d78b98b4b265e8747f62ec2d4fe5c1ec20876146021e','5d09bf25ec47729b1bf1829d4a1efec3e79ee86d0504c737aa26b75c8d85f902'),
('function','public.can_view_employee_directory()','3b5928ccf75574677bae198172bfdb17d5b267b287513a57e27e11b239affae0','3546095a047b76c613299fca2ba4ad93744ccfa5e899d23d01fd0a0fb0c06c77'),
('function','public.can_view_subscription_register()','c8a6a4474aeba6e3ceb1975b5de137891d0e7c505c17ec907c27d7d5ddb013d0','25eacad65cf6952495170cebc44e85a353070769ea9476695134d4731c22d0a5'),
('function','public.can_view_subscription_review_calendar()','3b8bc2bd1ef309b41fb3f3a3cd2998c3273f516e1c53d91c7b6ec32a5fe0d575','0a47af1c89954ce0084371d5198877af28ae455a5106d196ddadcab4f3c7a20d'),
('function','public.can_view_subscription_review_calendar_for_preview(uuid)','006d8f2c0e7fe21dd0807f3abc1a1aff20ef3026637e4efe7094ade293469c73','db2c0b493a77605f44297a6891d60b08a4492630e097e4fb0fd42441f0f0bd60'),
('function','public.cancel_my_approved_leave_request(uuid)','ae13b53e64b9607a1f8511cc0e62734aea17743535efc23ee0df3721ea606caf','dee4d3cba109c150be4057523c5b5ff80300b546dfc9c6e0955d725bf7a49c82'),
('function','public.cancel_portal_account_status_change(uuid, uuid)','145fffba4bedf8776113bfc996510c72b80e124cd7c346d564687e9d27ce2fb6','82b8cc682e497743025512a33dbe14f2327ea240b9d6dc7d217d8c694849b67a'),
('function','public.commit_payroll_balance_import(uuid, bigint)','8afa261076d880d057abc3a1cc74140b94065c08ddcce771e6720a54018b7f81','7873186bf4022ee955505af0da3d7a1b8047fc6dd77b77430a92bc80fb61347a'),
('function','public.commit_payroll_balance_import_before_comparison(uuid, bigint)','9212347194268006e426132d147dba5722fe185f14b397b86ec85d82b4d39a2c','096316798e95f969c73114425476d939ed340dc72dd58eea69e1c83bb611c1ff'),
('function','public.complete_employee_check_in_reminder(uuid)','a64e546e5cd6d78f6b02ec0c9d5988fdeb660cd05fd42310c6292fd6e3fddd48','e567ef9b9450594dc91c5ab3f4835d3471ee5b09c290eda1f40ab7d2bc35ae82'),
('function','public.complete_my_employee_check_in_task(uuid)','2485128dfaa635a4eb4e19dd0de3a6f6236d4a56827cc72d31d3f236685d6784','e990b70208da48dcc8f9b5884a18f7bc154957e567fcff17eab177d190fd6c2c'),
('function','public.complete_my_leave_request_attachment_upload(text)','bcb79e949fc116e2bfc7d740e5ab00419f42fcc3716434d7339da29201d3f975','8450ebcdb4f84284b632e84d9a0ce97cb7fb029bfcda5e1e7b48b99c8f250c01'),
('function','public.complete_visible_employee_check_in_reminder(uuid)','11b4bd3bf091d6297e9cd28123d9d90c78b4622b199cdd805f042a8e6e883dbe','ac74e912983bcf33685e3544cae1024f2396122e7e787e53ff2ad6f82c9e9e7e'),
('function','public.create_employee_directory_record(text, text, text, text, text, text, text, uuid, text, date, date, date, text, boolean, text, text, text, text, text[], integer)','3fbf519a1eda98f2f69b676289b4b0c6ab160b499c3502aad6c1c1cf76ac888c','555ee2cf046cbcc0da9c67d63254ee138a19737a959c048b581179840445272c'),
('function','public.create_employee_directory_record_with_address(text, text, text, text, text, text, text, uuid, text, date, date, date, text, boolean, text, text, text, text, text[], text, integer)','77e7ec1595c63563ae6d6e03905719180c3d41618fe474a1c2aa051b7f47d44a','eb05e40498d941fe45c71b80a5bb83ee967667e4defdbed578a9f9ff58815c03'),
('function','public.create_employee_directory_record_with_employment_type(text, text, text, text, text, text, text, uuid, text, date, date, date, text, boolean, text, text, text, text, text[], text, text, integer)','f41bdf52b7887a4ec2e1bfeef6e0ea5e95cee9c22463085446ac1cc9bd62b61a','82bde1816a2a6d513bd108e127ffd0496a13b2d7f490d75b103552773a0b3f24'),
('function','public.create_employee_directory_record_with_work_schedule(text, text, text, text, text, text, text, uuid, text, date, date, date, text, boolean, text, text, text, text, text[], text, text, smallint[], integer)','00ef5f35964aa2d43768fb284cdac2483e63a1c3b1ee92f408620645993c8677','0afc8134e2ac01ed6e9cb7b9a69e33fdc145c1ed579961036cb9aa53f02fc4ab'),
('function','public.create_employee_directory_record_with_work_schedule_times(text, text, text, text, text, text, text, uuid, text, date, date, date, text, boolean, text, text, text, text, text[], text, text, smallint[], jsonb, integer)','412c5aa3d0d2ce395c48aa6153cc219fa13123f25c625f594b3b704f5e8d93f6','0ddac431a807e2f856221acc2e8376ef80f4da4eef0afb4dbe7f1c278684a248'),
('function','public.create_internal_org_node(text, text, text, text, uuid, date, integer)','4154fd04cec17628afe001bfc64b3f801433c33115abd4c4998d3f939a363a1e','9e09d5cc9ee1c1bbd9e72a3384aef783754446efd70309b2307dbc8aebd20d24'),
('function','public.create_it_asset(text, uuid, text, text, text)','626f1a742cf26a655f1a0f29bfcf1fde45c1154c202a38dd0febe29be5de8165','726116d58382cc1df25a4b5d62bab960aa686178554905e2dc11a0b682f8f713'),
('function','public.create_portal_account(uuid, uuid, text, text, bigint)','7c5a3955cedb8d84f5cfb5b836c42452263e9691f8651ad26b6e9ca8f7de0d40','7b80be0ba018ffbd4398151f2237882a3eb707583063a384c10b2d3db0b9b6d2'),
('function','public.create_subscription(text, text, text, text, integer, date, uuid, uuid[])','40d7f6bd78c05f128dd6c23eab0df50465e76cf49f1704b09d4439835e855443','89c403b97327f9915b1e9eacdef1c39bfa64e234e27b378c6659440c95b9b10f'),
('function','public.create_subscription_v2(text, text, text, text, integer, date, integer, boolean, date, uuid, uuid[])','bf2e6a51b4fcc669aeced4e8aad04a01ee6011c30c3896de0dab67131c73111a','8b698f3d895732e8f7c9e9d675f041b84a50e4c4d15cfbfa07f58b4f028dabf5'),
('function','public.create_subscription_v3(text, text, text, text, integer, date, integer, boolean, text, date, uuid, uuid[])','06baaab60face26ba45d5a137fd8c559f5d7370e73204eca23da7dd56e20f742','c776b780876e0a4d1bcd1b239bc39e7790b382ae73b3820158b1332f0e1af924'),
('function','public.create_subscription_v4(text, text, text, text, integer, date, integer, boolean, text, date, uuid, text, uuid[])','a6a42ce8ab9e983f770b8fcb84d662c58c4917b5368fc67cfb7957710705371e','57013d78575ffab2bebbdf48d1cc79051536bd6dc559fde26a9079760350259e'),
('function','public.decide_employee_work_schedule_change_request(uuid, text, text)','7e3da2f93235bd00862361471492fd3e918de682c9d95388b768c43c9c99f6dd','b0b1a2afc6162a4ba2ec7333c50e76a239d948a210f983872a3afcc10728ac45'),
('function','public.decide_leave_with_balance(uuid, text, text)','d8de791bb59d7511ed7fc7a822c52a7b5c9323f37785bb165708a9d34d9639af','40e0e349f2e32bfb8ebb7941ea4a1eb2b8dc4ddb0b9d0b5452fd913e3b1c7822'),
('function','public.decide_my_managed_leave_request(uuid, text, text)','05a887294ffea5a5134081588440cd3e487ef58d5aac8cf53c34fc96ca71dfa1','7c355635350aa346f99c108632698a21bee303047b8ba42b29c42f8c278ccd4c'),
('function','public.delete_employee_directory_record(uuid, bigint)','118aaae7953efba7c0764a1c5db7f83b0bd569e33caacb7f2115c24105f85cad','b67bce74091067f4f8e85b97f0f360e9bc7ebfb2722a031b7bb709a3ce169f8a'),
('function','public.discard_my_leave_request_attachment_upload(text)','b3cd2e15bf68bddd417a22db348cb8cb4f45bc0b557eb8e080e6138109f9beab','fd8c719456cb0ee40e6c60c3031086bd623075cb2b207418ad379f0a66a1c74c'),
('function','public.enrol_employee_check_in_reminders(uuid)','85bb46f295a3f2517a1001efd6d0e1b89d4f81cf045b4b1ccbd09a76d896a112','c9de99d80330f7dca5721cfddbc4b99bca2c9565896b2165a52a76f1cd5e0d81'),
('function','public.finalise_portal_account_status_change(uuid, uuid, uuid)','025cb4f552865d54cb9e383c4da74240ef0be06f174e9bb18d1d2ea417d44616','61ba36c671f280728d474a191b3b6c24d3c578741d995af73b9d8d4929d28792'),
('function','public.get_it_asset_with_custody(uuid)','271254eea9cb6bcb1f662fedf6bb29283bb06ec61f187cf530ff53cb786d2bd6','53c46255c8e3bf095e17fca82966ce12318b8c10dc83964948b774638f97de5a'),
('function','public.get_leave_priority_workspace_before_accrual(uuid)','72cf7b2f59af4ea68ced1a68cb1403a73c497cd8fdba694dfc0b66aec90ee3f8','df5fcba0237d51a08464e53e92043cae52423823a213965712729269f8ba1317'),
('function','public.get_leave_priority_workspace_before_approved_deductions(uuid)','cd6d5b98bb4893ec8c154df5dadd54c39c9ee5c5c3ef9d69acc3e171509591bc','c9e40ed65aec2c45a4e4f606e462918fc1c24397c2a9140d332caa835b921419'),
('function','public.get_leave_workspace_for_preview(uuid)','ed75c662ebc4b64dfa373e0edfc806b15876142d462e83b8f6e67221a517d62e','ad245a978b582de8d3cd1663cab36eb72a278b28248ec23f2b8fc8e3733ed0c8'),
('function','public.get_my_employee_work_schedule_workspace()','455c1facd7b006b3ecb3eee4ec0312259ab29d9b74e98c8b783d8a73dfdbdfa5','fccd5c292ced9e60e4a6c460e482f92b9383e6f2c2393307d29342754ea44831'),
('function','public.get_payroll_balance_import_batch(uuid)','a4afcb9efb65991d26fc097d02ccd154311c5dfefe8aa7b7442840472b8b2fc4','1cfa2593ba29bf87bcca04ddd0a4633730e554245fd8a4c3b53ea5d26d346ba4'),
('function','public.get_payroll_balance_import_workspace()','165d3c0d006f76bc00eafab4e56f607275c874d9492a6060573a580f470afbe1','bd18a5fcb6330fcab170838ad1a5e5758bc9c279b32376a5cc0e2fdc284468fa'),
('function','public.get_payroll_balance_import_workspace_for_preview(uuid)',NULL,'b5e76b5ece2c00305a779636cc82191866d677e791ea8a8c1ff8e661dd76acd0'),
('function','public.get_portal_role_capabilities(uuid)',NULL,'2cccbc6af5df8aeeb1455a3335830532b89b3f2b860cddcf4b6c8e18ce3ea2c8'),
('function','public.get_selected_employee_leave_entitlement_policy(uuid)','e0016a75edacf616bf6f210f6145b19fbae4762de553c1fbaf83e979d6835f28','16c83e318f900111f1ecb211315b7877bd6d350c24f5f68b56a3eebd61579aa2'),
('function','public.get_selected_employee_profile_access_role_for_preview(uuid)','e168df82782e69580b6bbcff5725d8439585bcd96021f9ce709d8012774d93ca','0ccc5f0f28211d6cfe7d68c69a8fde51714f4bbfe3f33a6b422fdabedb662c49'),
('function','public.get_selected_employee_profile_for_hr(uuid)','96ea45443b746084a14cd4adcffc690f91101718562af89996c389ce5382f0c0','d0dc6d9bb55d99fcfd5eed3884ca9fa2e8e92ab5d411a0a00c96ada5cd297938'),
('function','public.get_selected_employee_work_schedule_workspace(uuid)','118b1431266f5e702088eb70e4e4e6923f3524a209edae06afa7328463fb603b','ed98e8ba4e706ce629e932dbc14fe0d2417d42fe91d6b53a7fdb089efc0e9491'),
('function','public.get_subscription_credential(uuid)','6a6d612acf9fc892f981f9fc45c8abbf0a5c242b0dcb541f360f2c75af963d7a','a0839a87834ecceb3a17b148d4e0e403ea97a8ed691320763b1b156396e1fe13'),
('function','public.inspect_portal_account_status_change(uuid, uuid)','ec8d939eca698bc2ded7854d37251f083eee7742a17d8e26319fccb5f4d23e32','89d2d25289179ed06c0356d2052ddfbc2c0c168abf44ca2839988f362a9dd868'),
('function','public.inspect_portal_account_status_request(uuid, uuid, boolean, bigint)','872e5ca15f7d754eef65932011882f4248544ee766533ee01cc66a736f81613e','06f0098b6fe20bb8988f2f2d50fd95c53f02eabd78c589f30986fb80179fffef'),
('function','public.list_calendar_birthdays()','bfcf24ad0401dbd69581b4961c89578f92e895840e1a51df7130f0feac1f8be1','bbb22525340a39a2c8ac4059be3e6b946cd19c1e9e22a6133727e6ece136f7a4'),
('function','public.list_calendar_birthdays_for_preview(uuid)','22e0608bcc5ae6278f63a8b5a973f3b3729e2ad590288b3c5194b665988e2f87','a0b58295bae904d1a5520371e5f5e29af5b51a386449b58366c4cbd7bbd5ccdb'),
('function','public.list_employee_check_in_calendar_entries_for_preview(uuid)','aef46b49ad9145f61a020b36316225ae095fbc2be943be5cdaad222917838352','3193995f1d6d9f5491223820f0591fcd9d9facd50ff6842ec7d08a06a8817b48'),
('function','public.list_employee_check_in_workspace_for_preview(uuid)','fbaadd59c9472072a8c1c10a2e41a22a1d01bdc2d7853d78ef6dfb47f299b7f4','02cba2c3e2f6463cb2cad45911a017e846d5f79b25b37fed7dc8e5797cedeee9'),
('function','public.list_employee_it_assets_for_preview(uuid)','bff9a6e33e5528857182522eace25989fff28337ea2a268cef0e6212e5518e79','4b5181fa764a88014bf0aadeed88fa6fd2fc5d82da93fcc56f2df92f16625b22'),
('function','public.list_employee_subscriptions_for_preview(uuid)','66b4f2a6f3f7f429a34b8a53245ea744a99103be3a1c0a658a3de873a88601b7','27c0b0b9dff6546f8c79a3de8e7aec312fa96334e0ff27df6ebba40a589a47d8'),
('function','public.list_employee_team_directory(uuid)','28066f72c02293c85066228d69ca4c15e930a008148e791ab8bf28901e17574d','074f26706dde4a31d04b68df8bf8fbbefc8c92cbb3e1ec77e6f38216400001f8'),
('function','public.list_it_asset_assignees()','0ea317e5370c0d0129d7fb5be3f15a8485c4ddb026cbabf74cc92492eff17221','c748cc7899319098f361d946b00ce1e4bb88d71c2d94bfeb6d31713f6af93eec'),
('function','public.list_it_asset_custody_history(uuid)','24fd8c4dc2746808588715580791b583676c42e5d87ecffdbab6ff2b12fd6e9d','b021b4574dbb197ea465fed2731a507d29922b94291bffd3d436956fd386d5aa'),
('function','public.list_it_assets()','9d62cafcc79fa944148feb340361f01c2162dc3ec4be95767f8f2bf2d06b727e','1a83872076ec7e328ab0cf779ae37d2d4f19a66058dff59d4b42acc90000359f'),
('function','public.list_it_assets_for_employee(uuid)','75ee2afbb9c47a07ae784812ff7a686593afb5eb58325e86995f59fecccc1425','d27c734011e4b899a754b7042282a85f16672359314f915b8fac1de45199d459'),
('function','public.list_it_assets_for_employee_with_custody(uuid)','9d8acc1d85f3ed65b7919e647e020e11c100b2b795af2e3ced46aa3a4067dea9','fd81b89929ad435f21ece66a7df3a579ab5e22247f3e0cf611ffe49bb3570a76'),
('function','public.list_it_assets_with_custody()','2b5d7f2e157dd675663e54d602af5233ee0552d5d691709dabe4638fa80988a5','d51483f21894971ea85d140c6a10605d496bbcb88ab4d413872787e97caf3d58'),
('function','public.list_leave_calendar_entries()','16204db11beb11a7912a701146f63a822b286d372c0987fcb3e200085e87fbf9','fb6de62eec55e6360fc615b3521fd7d4c50bbe97a3c12d5d8fcba3a50039ef28'),
('function','public.list_leave_calendar_entries_for_preview(uuid)','74cce0d0756774c57bc590f561641943fd572180c175f9f8e1bf10680f5df597','19a6137566ead4269bd9d3e797e9632a436df63dbd1b7bc0a0c7bfadc51892a6'),
('function','public.list_leave_workspace_requests()','484be64675836160dca1f1b2ca8d609fb371416ee6750aede95287c419e7f4d3','e4473c3b03ac8f860facf632535eec17dd8087562b7ceea5e77696365e5f1bce'),
('function','public.list_managed_employee_directory_records_for_preview(uuid)','3077537ff6de331c1451cf0f86a7d8b4cbde487e41ddf979bc055c07265bf8df','048e8c49159092d1f40bce69f6052c6eb75c166a9f6af0c946aa44adbacfcd02'),
('function','public.list_portal_account_summaries()','465e0af89775be520784038a98fda4fea2ca20b8d902de20c45564cb3b04a390','d3c3e18ad65760a350be084718ca13584d0113066eb6fa9ed0772e9dd61c1e9d'),
('function','public.list_staff_leave_calendar_entries_for_preview(uuid)','1729ae66f3e393c637799fc9859b1e0dd01728e4ac055bdc3ea205843a8a492d','3ee29da1a552fd2cd8cd309f091e9c6f7a2df71e6cf047a655f9df0267aafbaf'),
('function','public.list_subscription_credential_access_grants()','6b8b3fc8b7eaa1d14dcb1450315963f630da5f9d7421c9455fca6240dd2f893c','36c51de8a22b020a57806d6e379e3b41cdb5bf093bfe5325975b8459c1c2240b'),
('function','public.list_subscription_credential_grant_candidates()','e7d98615c53915b359899e06cc30c2414a1f98dbb754b8b28a1ff0703cfa7182','46d1bb38b78ea7dcd0164e320f89d13d96ab12e6fdd6fc45f8ebb48dacb6de5c'),
('function','public.list_subscription_management_delegates()',NULL,'4ac41c44e0be2f24d45855c6889e603f8ea1600e483a1568c145a363446117fa'),
('function','public.list_subscription_review_calendar_entries()','aca420ab580eabc3e5921ade1fb3b8e5c4b54efeab3cdc7c0c8d564dea4c790b','6bd65cba93d96b9f6fc1bffeaab604d58dd573267b332e5ec4ca4efd0d8df057'),
('function','public.list_subscription_review_calendar_entries_for_preview(uuid)','7c2773690c6de2a10fc8b999e028413f23d8fea929c9e28f488ee42de72f0e8c','150441169fd5c1571cd2c4f528b4fdf4933688dfcee02811fc8b5eb6275ebcba'),
('function','public.mark_subscription_reviewed(uuid, bigint)','a8dbc3297bd0493ec6673f7cfd01f776527860ba4198151b58d5eea37ea7a04b','c37eb103f9c03b9f92ff35b0f8a999e7ab725af377aa00757aa9bd49e081e690'),
('function','public.mark_subscription_reviewed_v2(uuid, bigint)','3035b2569ff7f4112853626fc02bf6dc9642b7fc2c7cb2aaf8f469fe4b84e674','222407d76e41e554b3e55c1ba7b2d267a5da2ef7f7fd2c10ebb9707a33f1c30c'),
('function','public.patch_subscription_v1(uuid, bigint, jsonb)','c1317b875b101f92c0ea8ad2eafb9716252868bff964469b52d0c71a60365bac','02cc4fd11fa5afba72a909dac917ee1196089b4db0d6b7ef5c55e3d57cb67440'),
('function','public.prepare_my_leave_request_attachment_upload(uuid, text, text, bigint)','66590a4b309713e3290b323c4f16fd16b3725f2bcec8eb494c7b1b574868b3ac','3c0c64124696daea1c32e481415eb954c09585889d4585553c5fff3896573cbf'),
('function','public.queue_employee_check_in_catch_up(uuid)','b6e6d82384410b0ef1c483146ae571c5d185dc19256763167fe62435c541ab18','20276309c1a50c543279037d34bac4c2c8774c69a240309070a6bf8d138ad397'),
('function','public.reassign_it_asset(uuid, uuid, bigint)','6b292c7a2c4a62604d31c0057d7aed4066124bfa9a09b4a13f9e1eb5ccf19e1c','87d25bae1b28a22894aed7ce41c411b09ddaab29748c36c341dbf427f400dfaa'),
('function','public.record_employee_check_in_review(uuid, text, date, text, bigint)','844678cc79a8d991e1e8d2c07b78cc01107720af0e44ba2eb33a7ec6679ca018','ee1570388004d057e1048b312b42988485dd90396272e83f4a5a7e9dc2185561'),
('function','public.remove_subscription_credential(uuid, bigint)','f1f5141e32fd28f384f0152712f5a23563ccc39787cdce34c908ba996beaad58','4cb31c9ca6a0225c9c7d400a238c8a1ae9de5195ee6f8ca7262bd5f26cb33acf'),
('function','public.replace_payroll_balance_import_grants(uuid[])','b412f11504065a2270bf24ee2f3803323ab0ddccfb6b31d183e01d1710cd2d5b','e997c4fb89738d51110ddc5c961fc4c1188e2e2b6d957292502a334280b9baee'),
('function','public.replace_subscription_credential_access_grants(uuid[])','2f60f89883814c802e33464670e4d9d671b5ae30d8f3f6fd239a15d0d9578e93','6f5f6f3743c043ae9943991b69969d66f52ac4ba9b763bae113ca12b3e0c11ef'),
('function','public.replace_subscription_management_delegates(uuid[])',NULL,'b49eca182c99434129ce6f9cc636f40b76ac2d3fc2cfec1a59559fdc8727c271'),
('function','public.resolve_leave_notification_manager(uuid)','0e6e76348ac5aeaeeba2def48445e367d43e9446db743afda862c2f2817e3397','a04fa81cd5f2cfa0cd7475622f48f6bb3c2334d2a3b53759d4b4f0ae3954c46b'),
('function','public.retire_it_asset(uuid, bigint)','1977be37c03255ec9a8fd2b9df27afe18786d055f96e6e513519fc6ddc2a275d','83ea67e7161b8d4acad287b0b6740d1d8e700f6cba74c1fda893fad3b92b6531'),
('function','public.return_it_asset(uuid, bigint, date)','494647e0f69ce2af196fe70d559111356d8cedc941f485bae9f8ba57ba919ac9','4cacba76fb18cb0dbff10461e7c852c76715c186da28a3ba30e76014ff0790fc'),
('function','public.review_employee_leave_accrual_day(uuid, date, numeric, numeric, numeric, numeric, text)','ba2a2a3fc4dcbab37ec9ed8d4d633f4017b9d014beaaa716980147057b9c2d8a','aef248b362e8b4c406cec4a537f1234ce1d41bfc08b0a42321d1ed3d6dc3cd1a'),
('function','public.save_subscription_credential(uuid, bigint, text, text, text, integer)','4b01d64ade16e6d38c487539498a8e5b2a2a6e771fbffd8e3ac0458de435da72','9fba2124ce95fdc1f1714a3904c0042bb8326101cdade090c8e275553759e2e3'),
('function','public.schedule_employee_offboarding(uuid, bigint, bigint, date, text)','5d86a974500ae866d4f63b804a58b765610df2ccb7167a67183a66846dedfe39','c21f535097e2cef3a04ff1ee62cfd3cf3870715e23e48f856c416aec8e1ef587'),
('function','public.set_employee_annual_leave_balance(uuid, numeric, date, boolean)','4d022cbf672c497f677e527caabd2cc43220947ce1ef3c461def95755aedb830','963f37f005c300882dccc259b6e5b927084031e0eab6e37327aab05cc5aeeecb'),
('function','public.set_employee_check_in_contract_classification(uuid, text)','cd3d503a7e360dc8b41fecf1288d8f4022fe62b42a78da12fa3ad11c7750b34a','412bea71cc0487d743480282ea78e91480670aa3f8c7373a5de92dd492834d55'),
('function','public.set_employee_leave_accrual_policy(uuid, numeric, numeric, numeric, boolean, boolean, text)','3d11f57a257628ecd453ed6661529a8152092f003a906894b5fea424a1e87a7a','5801f93155c7b4e9d6cb40e51bacbff7643c8dc7cffbb0f644165d6a5b5fa8d6'),
('function','public.set_employee_sick_leave_balance(uuid, numeric, date)','81ccce13fb37d1bf5718627120155e6879d8d2319e293144cd075f5ebd2b0ea5','6f6580fbfad6c5b6da6a96be24518b5ff9581cbc1df01bfafcc4a2dbf374b3ed'),
('function','public.set_leave_balance_required_hours(uuid, numeric)','a094dabac3961cec8cef43082266aebd3e57c0dcf1bd7319da37f2ae277e12c6','c618e94e016e3957054705c9aa61ab45875a4e493ad98306b8dcba1dca0abfc5'),
('function','public.set_portal_account_admin(uuid, boolean)','724519c94ddf8a818c5b2c1d1eed83f8daa637b7b2f9520c21c309ce41adecc3','a718ade47f589883625970d3ca2d990313d026e21814870912fdf1a7017ac3a8'),
('function','public.set_portal_account_enabled(uuid, uuid, boolean, bigint)','702c708c670d94107690e3e694aaf9af85bbb3e37410e79a4773752fe5e9bd0a','a514ec2608d22a4f65c71376fa30568e0355013b049216f41d3aa9dae2e4e599'),
('function','public.stage_payroll_balance_import(uuid, text, jsonb, jsonb)','a2b05e9f238439a989dd57b34e8ce19b58ce349687f57a3f30adae33a1fe0457','df1e25106f7352bd6e47d409833595520072aac3773a7afbca33e4d31e8af600'),
('function','public.stage_payroll_balance_import_for_preview(uuid, uuid, text, jsonb, jsonb)',NULL,'09fd3a0d238958736b79787150c9679eae2d18a0e2859c26cc77a2c67024285a'),
('function','public.submit_leave_request_once(uuid, uuid, text, date, date, time without time zone, time without time zone, text)','0baefdc95925debca85120368bc9724f645af1195bc023cb426ee5c497a109ca','73c7eb494d541a64b4a30dd859fac739fceb325ea06c5c3dedcc087c29a1d87e'),
('function','public.submit_selected_employee_leave_request(uuid, text, date, date, time without time zone, time without time zone, text)','6384e36432e1e7a3a59807292f794e077c37374bb7e671a397af067d9ade4656','86c48e29da1aad4a3bca871bacaa7e58f8cd79ddffd741239653e3211cb8e22e'),
('function','public.update_employee_directory_address(uuid, text, bigint)','318bacb16e22da5287cc5c9a6962edbd081612cf9d50cba468aa6ce455173695','de0b703fcfb7859a5bfb53d3e2b34337dab2ee45532f71fee595974be723af54'),
('function','public.update_employee_directory_record(uuid, text, text, text, text, text, text, text, uuid, text, date, date, date, text, boolean, bigint, bigint, text, text, text, text, text[], integer)','5c5acf5ab3c264d186334e7fe88d4038d7e755ae43e687cbc5592a872aa0c6aa','c9812b86ed7732fed7a54aed3d012c06f745a1b9e1452eaa627e05558efdcd35'),
('function','public.update_employee_directory_record_with_address(uuid, text, text, text, text, text, text, text, uuid, text, date, date, date, text, boolean, bigint, bigint, text, text, text, text, text[], text, integer)','facffa86f44b9a0a0b3941eb9f8cdbba49c13a4369c9a86a09a777935064744b','0dfcbba8431c50cfe2c4982df18bae31a5290aadaa8791dfb7a6379d15c36c6f'),
('function','public.update_employee_directory_record_with_employment_type(uuid, text, text, text, text, text, text, text, uuid, text, date, date, date, text, boolean, bigint, bigint, text, text, text, text, text[], text, text, integer)','e000cf86ac208e2687f43d873067582d838c020a06a8da7cd663de4419c5cdd6','b12a748b76e505ef6d040f9d9997aeca8dc1d5ca4b8fbdf9c95996b11e6ff5bd'),
('function','public.update_employee_directory_record_with_work_schedule(uuid, text, text, text, text, text, text, text, uuid, text, date, date, date, text, boolean, bigint, bigint, text, text, text, text, text[], text, text, smallint[], integer)','16cbb40cf6ba78909e3abc5bee5aa0bb8e4e3549fc612c2a1943f7159a8b5e87','3d49d4110ae860492049a0fd4d39ece6aff3bfb8879c1b2a5788b49b891a5abe'),
('function','public.update_employee_directory_record_with_work_schedule_times(uuid, text, text, text, text, text, text, text, uuid, text, date, date, date, text, boolean, bigint, bigint, text, text, text, text, text[], text, text, smallint[], jsonb, integer)','c0c2b45aef75a94e87546ddfc0bdfec4288df66b172b9d0f6a317882bb78737a','e8faa6b2146ee325bffffab2b050312bb43900478db0c4579da9ff5daa7d6c71'),
('function','public.update_employee_directory_role(uuid, text, text)','c8a7b7baa1742d27ce859148888088eb963bf56a92cd4dd2d8d7a59bddba9b43','17d007a203b2e22c5e03d3e2ebe304e30b9163781873da21154537ae62162ff7'),
('function','public.update_internal_org_node(uuid, text, text, text, text, uuid, date, integer, boolean, bigint)','f5079c317a1f0b9c491769fda98bb0478afba9e6eff211208f996a0b92dcffd9','00c655f1fe20c842b04f51126f9c270ca99afab7a5a3953f3a1de84f4a64d60c'),
('function','public.update_managed_employee_directory_record(uuid, text, text, text, text, text, bigint, bigint)','ed1e3a5c47b86c347c1b9fd69ae626214e396009a3f334135d181ba92c99226f','cbbcc2d0fa65d586e6736178436df156866d0527a82bb09bab09fd8af5291918'),
('function','public.update_managed_employee_directory_record_for_preview(uuid, uuid, text, text, text, text, text, bigint, bigint)','c0a48c6c4887092f1e437d749cfe3cb38703df874ee12706bd4a0bf3922c942e','797f89fdcdda645f83f287f137a9f798c3d689ff1d8feebb62b078b9605a926c'),
('function','public.update_selected_employee_profile_for_hr(uuid, text, text, date, bigint)','bff13125e7e4d8c433b0943480c25adb16552accae5c875e39afc6f34cdc75e7','09b96b45ce541d9753dc5f538dd307ddd66cbad041d8d02233e357289bba2af7'),
('function','public.update_subscription(uuid, bigint, text, text, text, text, text, integer, date, uuid, uuid[])','621f898840a83c1c28225183e63f54c1fdfbc73fa17618e918bff1ca9be1bf33','2a3583cad54faada0390277af9b46a6b9957d450320467ca77a4f72df51d7620'),
('function','public.update_subscription_v2(uuid, bigint, text, text, text, text, text, integer, date, integer, boolean, date, uuid, uuid[])','4e478a2bdde35148c8cac9bae81bb68d016cb19362dcde4a48644c6fee87b1b0','e433ea4a38de93d26229035dcc940e1ad369a618e0b7e15a4a20e7e2c77d0762'),
('function','public.update_subscription_v3(uuid, bigint, text, text, text, text, text, integer, date, integer, boolean, text, date, uuid, uuid[])','3cc169c591e57564b9b7cc6d2e620ea2d0a0857589fe26267fec4d2285abca02','bb8707b0a457b48af2c927999d0d5729535cedd0f6e9ac459fcd361fbeb2a649'),
('function','public.update_subscription_v4(uuid, bigint, text, text, text, text, text, integer, date, integer, boolean, text, date, uuid, text, uuid[])','f08082d3baa4f3ce45d2685260054b62a016d6258ea46dbc7e582595a2d0e554','8badacd7e2e9ae72d497e50da252771d866d70bdf84d0bfc8afb964fea9fd60a'),
('function_security','private.employee_work_schedule_workspace_json_for_actor(uuid, boolean, uuid, boolean, uuid)',NULL,'5bccdf3da99b758cc3e64720c62dab402268e833c9a6127bc7896f981f0e0d80'),
('function_security','private.freeze_payroll_balance_comparison(uuid)',NULL,'67f77240be35694c25f9a905775c20494865d6890bee22272ca82d458643a37d'),
('function_security','private.has_current_portal_access()','5bccdf3da99b758cc3e64720c62dab402268e833c9a6127bc7896f981f0e0d80','9b6712489182a62306a6b7f682d82499b0f0a7d56c7811574e26df13f6c6f404'),
('function_security','private.is_operational_portal_admin()',NULL,'5bccdf3da99b758cc3e64720c62dab402268e833c9a6127bc7896f981f0e0d80'),
('function_security','private.is_portal_account_admin()','5bccdf3da99b758cc3e64720c62dab402268e833c9a6127bc7896f981f0e0d80','67f77240be35694c25f9a905775c20494865d6890bee22272ca82d458643a37d'),
('function_security','private.lock_portal_role_actor()',NULL,'67f77240be35694c25f9a905775c20494865d6890bee22272ca82d458643a37d'),
('function_security','private.lock_subscription_role_authority(boolean)',NULL,'67f77240be35694c25f9a905775c20494865d6890bee22272ca82d458643a37d'),
('function_security','private.portal_role_policy(uuid)',NULL,'5bccdf3da99b758cc3e64720c62dab402268e833c9a6127bc7896f981f0e0d80'),
('function_security','private.validate_subscription_role_delegates(uuid[])',NULL,'67f77240be35694c25f9a905775c20494865d6890bee22272ca82d458643a37d'),
('function_security','public.get_payroll_balance_import_workspace_for_preview(uuid)',NULL,'9b6712489182a62306a6b7f682d82499b0f0a7d56c7811574e26df13f6c6f404'),
('function_security','public.get_portal_role_capabilities(uuid)',NULL,'9b6712489182a62306a6b7f682d82499b0f0a7d56c7811574e26df13f6c6f404'),
('function_security','public.list_subscription_credential_access_grants()','d143b2d680a6bedafbea62e4ff2f74d088c9706042585673b98ef9be3d8a60f4','9b6712489182a62306a6b7f682d82499b0f0a7d56c7811574e26df13f6c6f404'),
('function_security','public.list_subscription_credential_grant_candidates()','d143b2d680a6bedafbea62e4ff2f74d088c9706042585673b98ef9be3d8a60f4','9b6712489182a62306a6b7f682d82499b0f0a7d56c7811574e26df13f6c6f404'),
('function_security','public.list_subscription_management_delegates()',NULL,'9b6712489182a62306a6b7f682d82499b0f0a7d56c7811574e26df13f6c6f404'),
('function_security','public.replace_subscription_credential_access_grants(uuid[])','3006c30f3017f437b37915295eb68b2baf1c68468e0820903466930884ca8499','9854602ac8fba4e8fb0b56304eb3b5cbb4259a3189d7acd7e5d977127b3f3f1e'),
('function_security','public.replace_subscription_management_delegates(uuid[])',NULL,'9854602ac8fba4e8fb0b56304eb3b5cbb4259a3189d7acd7e5d977127b3f3f1e'),
('function_security','public.stage_payroll_balance_import_for_preview(uuid, uuid, text, jsonb, jsonb)',NULL,'c8dc8f274369710266018b19f1a1f63f49158d16fde0f707e92f4f4ddd0d20de'),
('global_function_acl','private.employee_work_schedule_workspace_json_for_actor(uuid, boolean, uuid, boolean, uuid)',NULL,'c027e95beca64045f15d2075c66162eeeeb192e6756be61c73f91c7ce14dd4f3'),
('global_function_acl','private.freeze_payroll_balance_comparison(uuid)',NULL,'c027e95beca64045f15d2075c66162eeeeb192e6756be61c73f91c7ce14dd4f3'),
('global_function_acl','private.has_current_portal_access()','c027e95beca64045f15d2075c66162eeeeb192e6756be61c73f91c7ce14dd4f3','48cbe0bdca3235e1dba22f9504e61b3c8e254ede516a33fa6fe51f6537916ca9'),
('global_function_acl','private.is_operational_portal_admin()',NULL,'c027e95beca64045f15d2075c66162eeeeb192e6756be61c73f91c7ce14dd4f3'),
('global_function_acl','private.lock_portal_role_actor()',NULL,'c027e95beca64045f15d2075c66162eeeeb192e6756be61c73f91c7ce14dd4f3'),
('global_function_acl','private.lock_subscription_role_authority(boolean)',NULL,'c027e95beca64045f15d2075c66162eeeeb192e6756be61c73f91c7ce14dd4f3'),
('global_function_acl','private.portal_role_policy(uuid)',NULL,'c027e95beca64045f15d2075c66162eeeeb192e6756be61c73f91c7ce14dd4f3'),
('global_function_acl','private.validate_subscription_role_delegates(uuid[])',NULL,'c027e95beca64045f15d2075c66162eeeeb192e6756be61c73f91c7ce14dd4f3'),
('global_function_acl','public.get_payroll_balance_import_workspace_for_preview(uuid)',NULL,'48cbe0bdca3235e1dba22f9504e61b3c8e254ede516a33fa6fe51f6537916ca9'),
('global_function_acl','public.get_portal_role_capabilities(uuid)',NULL,'48cbe0bdca3235e1dba22f9504e61b3c8e254ede516a33fa6fe51f6537916ca9'),
('global_function_acl','public.list_subscription_credential_access_grants()','d8a0d533a0726ff8f11f20efbb38b4c17a5aff604a9fad0ab29f419e4d45a77d','48cbe0bdca3235e1dba22f9504e61b3c8e254ede516a33fa6fe51f6537916ca9'),
('global_function_acl','public.list_subscription_credential_grant_candidates()','d8a0d533a0726ff8f11f20efbb38b4c17a5aff604a9fad0ab29f419e4d45a77d','48cbe0bdca3235e1dba22f9504e61b3c8e254ede516a33fa6fe51f6537916ca9'),
('global_function_acl','public.list_subscription_management_delegates()',NULL,'48cbe0bdca3235e1dba22f9504e61b3c8e254ede516a33fa6fe51f6537916ca9'),
('global_function_acl','public.replace_subscription_credential_access_grants(uuid[])','d8a0d533a0726ff8f11f20efbb38b4c17a5aff604a9fad0ab29f419e4d45a77d','48cbe0bdca3235e1dba22f9504e61b3c8e254ede516a33fa6fe51f6537916ca9'),
('global_function_acl','public.replace_subscription_management_delegates(uuid[])',NULL,'48cbe0bdca3235e1dba22f9504e61b3c8e254ede516a33fa6fe51f6537916ca9'),
('global_function_acl','public.stage_payroll_balance_import_for_preview(uuid, uuid, text, jsonb, jsonb)',NULL,'fbafe3bfaed21ba605e4c84f054cfe31484d3df07d5445aa6ebfb7f1a277f4e3'),
('global_relation_acl','private.subscription_management_grant_events',NULL,case current_setting('server_version_num')::integer/10000 when 16 then 'c0e6bb2dbd327bd3c3ef5cf70c329910a5853d629417887f257e091ff5b73577' when 17 then 'd51696be62bea2471822f7114b081fc4989012a076cf2721dc1bf1139b89773d' end),
('index','private.subscription_management_grant_events_pkey',NULL,'75bab90db0202af89d416d884057753d39eb118933a0e6cb4987eb6bb0b4a841'),
('policy','public.leave_requests:leave_requests_select_authorized','ab207b7516a74a51d4a212edd2597a953d96de784873c111ea9ce7e18afec810','34efb878711dea3d37340cc7cb06f00d80ffa5cc4092b40f6b3e5764b6228310'),
('relation','private.subscription_management_grant_events',NULL,case current_setting('server_version_num')::integer/10000 when 16 then '23004a5648ab8cfd403aca4079c055b0b556ecdd61e6f8fc787ccf8765642d19' when 17 then 'ee62aacc4551fcd30dfc8f51c25773931805de7d6aa6210d0466c5aa1be5b89b' end),
('relation','private.subscription_management_grant_events_id_seq',NULL,'cc7407f5139027cc3c2c99e881b10ba0072e0ef3d4c30abbb5c5fa08b76d9377'),
('sequence','private.subscription_management_grant_events_id_seq',NULL,'ce568c15e2ab0bfb83716dc1b9e9321097e9ff3ba55bb89fe4e3486475e5e77b'),
('trigger','private.subscription_management_grant_events:reject_retired_test_identity_reference',NULL,'2a317f081ee7987da7e83821265f0d9c6f3a617b55db597a6f289eb23d6ab4de');

do $$ begin
  if exists(select 1 from pg_temp.unified_role_catalog_delta d
    left join pg_temp.unified_role_catalog_before b using(kind,object_identity)
    where d.before_sha256 is distinct from encode(extensions.digest(b.definition,'sha256'),'hex')) then
    raise exception 'Unified role migration predecessor metadata differs from the enumerated role delta.' using errcode='55000';
  end if;
end $$;
create temp table pg_temp.unified_role_catalog_expected on commit drop as
  select b.kind,b.object_identity,encode(extensions.digest(b.definition,'sha256'),'hex') as sha256
    from pg_temp.unified_role_catalog_before b
    where not exists(select 1 from pg_temp.unified_role_catalog_delta d where (d.kind,d.object_identity)=(b.kind,b.object_identity))
  union all select d.kind,d.object_identity,d.after_sha256 from pg_temp.unified_role_catalog_delta d;
alter table pg_temp.unified_role_catalog_expected add primary key(kind,object_identity);
create temp table pg_temp.unified_role_receipts_before on commit drop as
  select encode(extensions.digest(coalesce(jsonb_agg(to_jsonb(r) order by r.id),'[]'::jsonb)::text,'sha256'),'hex') as sha256
  from private.confirmed_test_identity_purges r;

-- Private exact-ID inputs are supplied inside this release transaction, never committed.
-- Actor: migration 20261006104000; reason: user-approved release migration 2026-10-06.
-- Approval: COORD-20261006-ROLES-CONVERSION-IN-RELEASE-MIGRATION-1.
create temp table pg_temp.unified_role_release_plan on commit drop as
  select current_setting('mam.roles.release_plan',true)::jsonb as plan;
do $$ declare plan jsonb; item jsonb; actual jsonb; begin
  select p.plan into strict plan from pg_temp.unified_role_release_plan p;
  if plan is null or jsonb_typeof(plan->'targets') is distinct from 'array'
    or jsonb_typeof(plan->'p0') is distinct from 'array'
    or jsonb_array_length(plan->'targets')<>6 or jsonb_array_length(plan->'p0')<>2
    or (select count(distinct x->>'user_id') from jsonb_array_elements(plan->'targets') x)<>6
    or (select count(distinct x->>'person_id') from jsonb_array_elements(plan->'targets') x)<>6
    or (select count(distinct x->>'id') from jsonb_array_elements(plan->'p0') x)<>2
    or (select count(*) from jsonb_array_elements(plan->'targets') x
        where x->>'before_role'='system_admin' and x->>'after_role'='admin')<>4
    or (select count(*) from jsonb_array_elements(plan->'targets') x
        where x->>'before_role'='employee' and x->>'after_role'='account')<>2
    or exists(select 1 from jsonb_array_elements(plan->'targets') t
              join jsonb_array_elements(plan->'p0') p on t->>'user_id'=p->>'id') then
    raise exception 'MAM_ROLE_RELEASE_PLAN_MISMATCH' using errcode='55000';
  end if;
  if (select auth.uid()) is not null or current_user<>'postgres' then
    raise exception 'MAM_ROLE_RELEASE_REQUIRES_MIGRATION_ACTOR' using errcode='42501';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('MAM-six-roles-20261006',0));
  if exists(select 1 from supabase_migrations.schema_migrations where version='20261006103000') then
    raise exception 'MAM_ROLE_RELEASE_ALREADY_RECORDED_READBACK_ONLY' using errcode='55000';
  end if;
  perform p.id from public.profiles p where p.id in
    (select (x->>'user_id')::uuid from jsonb_array_elements(plan->'targets') x
     union select (x->>'id')::uuid from jsonb_array_elements(plan->'p0') x)
    order by p.id for update nowait;
  perform p.id from public.internal_org_people p where p.id in
    (select (x->>'person_id')::uuid from jsonb_array_elements(plan->'targets') x)
    order by p.id for update nowait;
  perform u.id from auth.users u where u.id in
    (select (x->>'user_id')::uuid from jsonb_array_elements(plan->'targets') x)
    order by u.id for update nowait;
  for item in select value from jsonb_array_elements(plan->'p0') loop
    select to_jsonb(p) into actual from public.profiles p where p.id=(item->>'id')::uuid;
    if item->>'app_role' is distinct from 'system_admin' or actual is distinct from item then
      raise exception 'MAM_P0_PREVALUE_MISMATCH' using errcode='55000';
    end if;
  end loop;
  for item in select value from jsonb_array_elements(plan->'targets') loop
    select jsonb_build_object('id',p.id,'auth_user_id',p.auth_user_id,'node_kind',p.node_kind,
      'company_key',p.company_key,'is_active',p.is_active) into actual
      from public.internal_org_people p where p.id=(item->>'person_id')::uuid;
    if actual is distinct from item->'person_before'
      or item->'person_before'->>'is_active' is distinct from 'true'
      or item->'person_before'->>'auth_user_id' is distinct from item->>'user_id' then
      raise exception 'MAM_PERSON_PREVALUE_MISMATCH' using errcode='55000';
    end if;
    select jsonb_build_object('id',p.id,'app_role',p.app_role,'account_status',p.account_status,
      'account_version',p.account_version,'credentials_valid_after',p.credentials_valid_after) into actual
      from public.profiles p where p.id=(item->>'user_id')::uuid;
    if actual is distinct from item->'account_before'
      or actual->>'app_role' is distinct from item->>'before_role'
      or actual->>'account_status' is distinct from 'active'
      or not exists(select 1 from auth.users u where u.id=(item->>'user_id')::uuid) then
      raise exception 'MAM_ACCOUNT_PREVALUE_MISMATCH' using errcode='55000';
    end if;
    if exists(select 1 from public.internal_org_people p where p.auth_user_id=(item->>'user_id')::uuid
      and p.is_active and p.id<>(item->>'person_id')::uuid) then
      raise exception 'MAM_IDENTITY_LINK_CONFLICT' using errcode='55000';
    end if;
  end loop;
end $$;
create temp table pg_temp.unified_role_release_before on commit drop as
  select p.id as user_id,to_jsonb(p) as profile_before,to_jsonb(u) as auth_before
  from public.profiles p join auth.users u on u.id=p.id
  where p.id in(select (x->>'user_id')::uuid from pg_temp.unified_role_release_plan r,
               jsonb_array_elements(r.plan->'targets') x);
create temp table pg_temp.unified_role_release_audit(id bigint primary key,expected jsonb) on commit drop;

create function pg_temp.unified_role_identity_state() returns text language sql stable set search_path='' as $state$
  select encode(extensions.digest(jsonb_build_object(
    'auth',(select coalesce(jsonb_agg(case when b.user_id is null then to_jsonb(r)
      else (to_jsonb(r)-array['raw_app_meta_data','updated_at'])||jsonb_build_object(
        'raw_app_meta_data',b.auth_before->'raw_app_meta_data','updated_at',b.auth_before->'updated_at') end
      order by r.id),'[]'::jsonb) from auth.users r left join pg_temp.unified_role_release_before b on b.user_id=r.id),
    'profiles',(select coalesce(jsonb_agg(case when b.user_id is null then to_jsonb(r)
      else (to_jsonb(r)-array['app_role','updated_at'])||jsonb_build_object(
        'app_role',b.profile_before->'app_role','updated_at',b.profile_before->'updated_at') end
      order by r.id),'[]'::jsonb) from public.profiles r left join pg_temp.unified_role_release_before b on b.user_id=r.id),
    'people',(select coalesce(jsonb_agg(to_jsonb(r) order by r.id),'[]'::jsonb) from public.internal_org_people r),
    'reset_claims',(select coalesce(jsonb_agg(to_jsonb(r) order by r.auth_user_id),'[]'::jsonb) from private.portal_password_reset_claims r),
    'status_claims',(select coalesce(jsonb_agg(to_jsonb(r) order by r.auth_user_id),'[]'::jsonb) from private.portal_account_status_change_claims r),
    'account_admins',(select coalesce(jsonb_agg(to_jsonb(r) order by r.auth_user_id),'[]'::jsonb) from private.portal_account_admins r),
    'account_events',(select coalesce(jsonb_agg(to_jsonb(r) order by r.id),'[]'::jsonb) from private.portal_account_admin_events r),
    'directory_events',(select coalesce(jsonb_agg(to_jsonb(r) order by r.id),'[]'::jsonb)
      from private.employee_directory_audit_events r
      where not exists(select 1 from pg_temp.unified_role_release_audit a where a.id=r.id)),
    'credentials',(select coalesce(jsonb_agg(to_jsonb(r) order by r.id),'[]'::jsonb) from private.employee_onboarding_credentials r),
    'credential_events',(select coalesce(jsonb_agg(to_jsonb(r) order by r.id),'[]'::jsonb) from private.employee_onboarding_credential_events r))::text,'sha256'),'hex');
$state$;
create temp table pg_temp.unified_role_identity_before on commit drop as
  select pg_temp.unified_role_identity_state() as sha256;

alter table public.profiles drop constraint profiles_app_role_check;
alter table public.profiles add constraint profiles_app_role_check
  check (app_role in ('employee','manager','account','admin','system_admin','hr'));

create function private.portal_role_policy(p_user_id uuid default null)
returns table (
  app_role text, person_id uuid, account_status text,
  is_super_admin boolean, can_manage_accounts boolean,
  can_view_employee_directory boolean, can_manage_employee_directory boolean,
  can_view_organisation_chart boolean, can_edit_organisation_chart boolean,
  can_change_employee_view boolean, can_view_check_in_workspace boolean,
  can_manage_assets boolean, can_view_subscription_register boolean,
  can_manage_subscriptions boolean, can_manage_subscription_credentials boolean,
  can_manage_subscription_credential_grants boolean,
  can_manage_subscription_management_grants boolean, can_manage_roles boolean,
  can_manage_analytics_api boolean, can_import_payroll_balances boolean,
  payroll_comparison_only boolean, can_manage_leave_balances boolean,
  can_view_all_leave_requests boolean, can_review_leave_workspace boolean,
  can_approve_employment_decisions boolean
)
language sql stable security definer set search_path = ''
as $$
  with target as (
    select profile.app_role, profile.account_status,
      (select person.id from public.internal_org_people person
       where person.auth_user_id=profile.id and person.node_kind='person' and person.is_active
       limit 1) as person_id,
      profile.id as user_id
    from public.profiles profile
    where profile.id=coalesce(p_user_id,(select auth.uid()))
      and profile.app_role in ('employee','manager','account','admin','system_admin')
      and profile.account_status='active' and profile.login_name is not null
      and private.is_active_portal_account(profile.id)
      and (
        (p_user_id is not null and p_user_id is distinct from (select auth.uid()))
        or ((select auth.uid()) is not null and private.is_active_portal_account()
          and not coalesce(((select auth.jwt())->>'is_anonymous')::boolean,false))
      )
      and (profile.app_role='system_admin' or (
        (select count(*) from public.internal_org_people person where person.auth_user_id=profile.id)=1
        and exists(select 1 from public.internal_org_people person
          where person.auth_user_id=profile.id and person.node_kind='person' and person.is_active)
      ))
  ), policy as (
    select target.*, target.app_role='system_admin' as p0,
      target.app_role in ('admin','system_admin') as operational,
      target.app_role='manager' as manager,
      target.app_role='account' as account
    from target
  )
  select policy.app_role, policy.person_id, policy.account_status,
    p0, operational, manager or operational, operational,
    manager or operational, operational, p0, manager or operational,
    operational, manager or operational,
    operational or (manager and exists(select 1 from private.subscription_management_grants g where g.person_id=policy.person_id)),
    operational or (manager and exists(select 1 from private.subscription_credential_access_grants g
      where g.person_id=policy.person_id and g.auth_user_id=policy.user_id)),
    p0, p0, p0, p0, account or operational, account, operational,
    account or operational, manager or operational, operational
  from policy;
$$;
revoke all on function private.portal_role_policy(uuid) from public,anon,authenticated,service_role;

create function public.get_portal_role_capabilities(p_person_id uuid default null)
returns table (
  app_role text, person_id uuid, account_status text,
  is_super_admin boolean, can_manage_accounts boolean,
  can_view_employee_directory boolean, can_manage_employee_directory boolean,
  can_view_organisation_chart boolean, can_edit_organisation_chart boolean,
  can_change_employee_view boolean, can_view_check_in_workspace boolean,
  can_manage_assets boolean, can_view_subscription_register boolean,
  can_manage_subscriptions boolean, can_manage_subscription_credentials boolean,
  can_manage_subscription_credential_grants boolean,
  can_manage_subscription_management_grants boolean, can_manage_roles boolean,
  can_manage_analytics_api boolean, can_import_payroll_balances boolean,
  payroll_comparison_only boolean, can_manage_leave_balances boolean,
  can_view_all_leave_requests boolean, can_review_leave_workspace boolean,
  can_approve_employment_decisions boolean
)
language plpgsql stable security definer set search_path = ''
as $$
declare v_target uuid;
begin
  if not exists(select 1 from private.portal_role_policy()) then
    raise exception 'An active portal account is required.' using errcode='42501';
  end if;
  if p_person_id is not null then
    if not private.is_system_portal_account_admin() then
      raise exception 'Only System Admin may preview role capabilities.' using errcode='42501';
    end if;
    select person.auth_user_id into v_target
    from public.internal_org_people person
    where person.id=p_person_id and person.node_kind='person' and person.is_active;
    if v_target is null or not exists(select 1 from private.portal_role_policy(v_target) policy where policy.person_id=p_person_id) then
      raise exception 'The selected active portal account is unavailable.' using errcode='42501';
    end if;
  end if;
  return query select * from private.portal_role_policy(v_target);
end;
$$;
revoke all on function public.get_portal_role_capabilities(uuid) from public,anon,authenticated,service_role;
grant execute on function public.get_portal_role_capabilities(uuid) to authenticated;

create or replace function private.is_system_portal_account_admin()
returns boolean language sql stable security definer set search_path = ''
as $$
  select (select auth.uid()) is not null
    and not coalesce(((select auth.jwt())->>'is_anonymous')::boolean,false)
    and private.is_active_portal_account()
    and exists(select 1 from public.profiles profile
      where profile.id=(select auth.uid()) and profile.app_role='system_admin'
        and profile.account_status='active' and profile.login_name is not null);
$$;

create or replace function private.is_operational_portal_admin()
returns boolean language sql stable security definer set search_path = ''
as $$ select coalesce((select policy.can_manage_accounts from private.portal_role_policy() policy),false); $$;

create or replace function private.is_portal_account_admin()
returns boolean language sql stable security definer set search_path = ''
as $$ select coalesce((select policy.can_manage_accounts from private.portal_role_policy() policy),false); $$;

create or replace function private.is_internal_org_hr()
returns boolean language sql stable security definer set search_path = ''
as $$ select coalesce((select policy.can_manage_employee_directory from private.portal_role_policy() policy),false); $$;

create or replace function private.can_view_archived_employee_profiles()
returns boolean language sql stable security definer set search_path = ''
as $$ select coalesce((select policy.can_manage_employee_directory from private.portal_role_policy() policy),false); $$;

create or replace function private.can_view_people_operational_tabs()
returns boolean language sql stable security definer set search_path = ''
as $$ select coalesce((select policy.can_view_organisation_chart from private.portal_role_policy() policy),false); $$;

create or replace function private.has_employee_check_in_workspace_access()
returns boolean language sql stable security definer set search_path = ''
as $$ select coalesce((select policy.can_view_check_in_workspace from private.portal_role_policy() policy),false); $$;

create or replace function private.is_current_subscription_credential_manager()
returns boolean language sql stable security definer set search_path = ''
as $$ select coalesce((select policy.can_manage_subscription_credentials from private.portal_role_policy() policy),false); $$;

create or replace function private.has_payroll_balance_import_access()
returns boolean language sql stable security definer set search_path = ''
as $$ select coalesce((select policy.can_import_payroll_balances from private.portal_role_policy() policy),false); $$;

create or replace function public.can_manage_portal_accounts()
returns boolean language sql stable security definer set search_path = ''
as $$ select coalesce((select policy.can_manage_accounts from private.portal_role_policy() policy),false); $$;

create or replace function public.can_manage_employee_directory()
returns boolean language sql stable security definer set search_path = ''
as $$ select coalesce((select policy.can_manage_employee_directory from private.portal_role_policy() policy),false); $$;

create or replace function public.can_view_employee_directory()
returns boolean language sql stable security definer set search_path = ''
as $$ select coalesce((select policy.can_view_employee_directory from private.portal_role_policy() policy),false); $$;

create or replace function public.can_edit_internal_org()
returns boolean language sql stable security definer set search_path = ''
as $$ select coalesce((select policy.can_edit_organisation_chart from private.portal_role_policy() policy),false); $$;

create or replace function public.can_manage_it_assets()
returns boolean language sql stable security definer set search_path = ''
as $$ select coalesce((select policy.can_manage_assets from private.portal_role_policy() policy),false); $$;

create or replace function public.can_manage_subscriptions()
returns boolean language sql stable security definer set search_path = ''
as $$ select coalesce((select policy.can_manage_subscriptions from private.portal_role_policy() policy),false); $$;

create or replace function public.can_view_subscription_register()
returns boolean language sql stable security definer set search_path = ''
as $$ select coalesce((select policy.can_view_subscription_register from private.portal_role_policy() policy),false); $$;

create or replace function public.can_review_leave_workspace()
returns boolean language sql stable security definer set search_path = ''
as $$ select coalesce((select policy.can_review_leave_workspace from private.portal_role_policy() policy),false); $$;

create or replace function public.can_view_all_leave_requests()
returns boolean language sql stable security definer set search_path = ''
as $$ select coalesce((select policy.can_view_all_leave_requests from private.portal_role_policy() policy),false); $$;

revoke all on function private.is_operational_portal_admin() from public,anon,authenticated,service_role;

create or replace function private.is_internal_org_member()
returns boolean language sql stable security definer set search_path = ''
as $$ select exists(select 1 from private.portal_role_policy()); $$;

create or replace function private.has_current_portal_access()
returns boolean language sql stable security definer set search_path = ''
as $$ select exists(select 1 from private.portal_role_policy()); $$;

create or replace function private.has_configured_global_employee_check_in_access(p_user_id uuid)
returns boolean language sql stable security definer set search_path = ''
as $$ select coalesce((select policy.can_approve_employment_decisions from private.portal_role_policy(p_user_id) policy),false) and p_user_id is not null; $$;

create or replace function private.has_leave_register_read_grant(p_actor uuid)
returns boolean language sql stable security definer set search_path = ''
as $$ select coalesce((select policy.can_view_all_leave_requests from private.portal_role_policy(p_actor) policy),false) and p_actor is not null; $$;

create or replace function private.has_payroll_balance_import_access_for(p_actor uuid)
returns boolean language sql stable security definer set search_path = ''
as $$ select coalesce((select policy.can_import_payroll_balances from private.portal_role_policy(p_actor) policy),false) and p_actor is not null; $$;

create or replace function private.payroll_comparison_only(p_actor uuid)
returns boolean language sql stable security definer set search_path = ''
as $$ select coalesce((select policy.payroll_comparison_only from private.portal_role_policy(p_actor) policy),false) and p_actor is not null; $$;

create or replace function private.can_view_all_approved_leave_calendar_for(p_actor uuid)
returns boolean language sql stable security definer set search_path = ''
as $$ select coalesce((select policy.can_view_all_leave_requests from private.portal_role_policy(p_actor) policy),false) and p_actor is not null; $$;

do $migration$
declare item record; definition text; anchor constant text := 'private.is_system_portal_account_admin()';
begin
  for item in select * from (values
    ('public.create_it_asset(text,uuid,text,text,text)',1),
    ('public.get_it_asset_with_custody(uuid)',1),
    ('public.list_it_asset_assignees()',1),
    ('public.list_it_asset_custody_history(uuid)',1),
    ('public.list_it_assets()',1),
    ('public.list_it_assets_for_employee(uuid)',1),
    ('public.list_it_assets_for_employee_with_custody(uuid)',1),
    ('public.list_it_assets_with_custody()',1),
    ('public.reassign_it_asset(uuid,uuid,bigint)',1),
    ('public.retire_it_asset(uuid,bigint)',1),
    ('public.return_it_asset(uuid,bigint,date)',1),
    ('public.create_internal_org_node(text,text,text,text,uuid,date,integer)',1),
    ('public.update_internal_org_node(uuid,text,text,text,text,uuid,date,integer,boolean,bigint)',1),
    ('public.create_employee_directory_record_with_employment_type(text,text,text,text,text,text,text,uuid,text,date,date,date,text,boolean,text,text,text,text,text[],text,text,integer)',1),
    ('public.create_employee_directory_record_with_work_schedule(text,text,text,text,text,text,text,uuid,text,date,date,date,text,boolean,text,text,text,text,text[],text,text,smallint[],integer)',1),
    ('public.update_employee_directory_record_with_employment_type(uuid,text,text,text,text,text,text,text,uuid,text,date,date,date,text,boolean,bigint,bigint,text,text,text,text,text[],text,text,integer)',1),
    ('public.update_employee_directory_record_with_work_schedule(uuid,text,text,text,text,text,text,text,uuid,text,date,date,date,text,boolean,bigint,bigint,text,text,text,text,text[],text,text,smallint[],integer)',1),
    ('public.get_selected_employee_profile_for_hr(uuid)',1),
    ('public.update_selected_employee_profile_for_hr(uuid,text,text,date,bigint)',1),
    ('public.get_selected_employee_leave_entitlement_policy(uuid)',1),
    ('public.decide_employee_work_schedule_change_request(uuid,text,text)',1),
    ('public.set_employee_annual_leave_balance(uuid,numeric,date,boolean)',1),
    ('public.set_employee_sick_leave_balance(uuid,numeric,date)',1),
    ('public.set_employee_leave_accrual_policy(uuid,numeric,numeric,numeric,boolean,boolean,text)',1),
    ('public.review_employee_leave_accrual_day(uuid,date,numeric,numeric,numeric,numeric,text)',1),
    ('public.cancel_my_approved_leave_request(uuid)',1),
    ('public.submit_selected_employee_leave_request(uuid,text,date,date,time without time zone,time without time zone,text)',1),
    ('private.payroll_balance_import_projection()',1)
  ) reviewed(signature,occurrences) loop
    definition := pg_get_functiondef(item.signature::regprocedure);
    if (length(definition)-length(replace(definition,anchor,'')))/length(anchor) <> item.occurrences then
      raise exception 'Operational authorization baseline differs: %',item.signature;
    end if;
    execute replace(definition,anchor,'private.is_operational_portal_admin()');
  end loop;
end;
$migration$;

do $migration$
declare signature text; definition text; anchor constant text := 'not private.is_internal_org_hr()';
begin
  foreach signature in array array[
    'public.can_import_payroll_balances_for_preview(uuid)',
    'public.list_leave_calendar_entries_for_preview(uuid)',
    'public.list_staff_leave_calendar_entries_for_preview(uuid)',
    'public.list_employee_check_in_calendar_entries_for_preview(uuid)',
    'public.list_employee_team_directory(uuid)'
  ] loop
    definition := pg_get_functiondef(signature::regprocedure);
    if (length(definition)-length(replace(definition,anchor,'')))/length(anchor) <> 1 then
      raise exception 'Preview authorization baseline differs: %',signature;
    end if;
    execute replace(definition,anchor,'not private.is_system_portal_account_admin()');
  end loop;
end;
$migration$;

create or replace function public.list_leave_calendar_entries()
returns table (
  id uuid,
  person_id uuid,
  employee_name text,
  company_key text,
  leave_type_label text,
  start_date date,
  end_date date,
  start_time time without time zone,
  end_time time without time zone,
  business_days integer,
  hours numeric,
  status text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_actor_user_id uuid := (select auth.uid());
  v_actor_person_id uuid := private.current_active_portal_employee_id();
  v_team_ids uuid[] := array(select scope.person_id from private.manager_calendar_team_ids(v_actor_person_id) scope);
  v_peer_ids uuid[] := array(select peer.person_id from private.employee_calendar_peer_ids(v_actor_person_id) peer);

  v_is_manager boolean := private.is_calendar_manager(v_actor_user_id);
  v_can_view_all_approved boolean := private.can_view_all_approved_leave_calendar();
begin
  if v_actor_user_id is null
    or coalesce(((select auth.jwt()) ->> 'is_anonymous')::boolean, false)
    or not private.has_current_portal_access() then
    raise exception 'An active portal account is required to view the calendar.'
      using errcode = '42501';
  end if;

  if v_actor_person_id is null and not v_can_view_all_approved then
    raise exception 'An active linked employee account is required to view the calendar.'
      using errcode = '42501';
  end if;

  return query
  with scoped_leave as (
    select
      request.id,
      request.employee_person_id as person_id,
      employee.full_name as employee_name,
      employee.company_key,
      case when request.employee_person_id = v_actor_person_id then request.request_type_label
        when request.status = 'approved' then 'Approved leave' else 'Pending leave' end as leave_type_label,
      request.start_date,
      request.end_date,
      request.start_time,
      request.end_time,
      request.business_days,
      request.hours,
      case request.status
        when 'approved' then 'Approved'
        else 'Pending'
      end as status,
      request.created_at
    from public.leave_requests request
    join public.internal_org_people employee
      on employee.id = request.employee_person_id
     and employee.node_kind = 'person'
    where v_actor_person_id is not null
      and (request.employee_person_id = v_actor_person_id or request.employee_person_id = any(v_team_ids))
      and request.status in ('submitted', 'approved')

    union all

    select
      request.id,
      request.employee_person_id as person_id,
      case
        when employee.is_active then employee.full_name
        else employee.full_name || ' (archived)'
      end as employee_name,
      employee.company_key,
      case when request.status='approved' then 'Approved leave' else 'Pending leave' end as leave_type_label,
      request.start_date,
      request.end_date,
      request.start_time,
      request.end_time,
      request.business_days,
      request.hours,
      case when request.status='approved' then 'Approved' else 'Pending' end as status,
      request.created_at
    from public.leave_requests request
    join public.internal_org_people employee
      on employee.id = request.employee_person_id
     and employee.node_kind = 'person'
    where (v_can_view_all_approved or (v_is_manager and employee.is_active)
      or request.employee_person_id = any(v_peer_ids))
      and not (request.employee_person_id = any(v_team_ids))
      and (request.status='approved'
        or (v_can_view_all_approved and employee.is_active and request.status='submitted'))
      and (
        v_actor_person_id is null
        or request.employee_person_id <> v_actor_person_id
      )
  )
  select
    scoped_leave.id,
    scoped_leave.person_id,
    scoped_leave.employee_name,
    scoped_leave.company_key,
    scoped_leave.leave_type_label,
    scoped_leave.start_date,
    scoped_leave.end_date,
    scoped_leave.start_time,
    scoped_leave.end_time,
    scoped_leave.business_days,
    scoped_leave.hours,
    scoped_leave.status
  from scoped_leave
  order by scoped_leave.start_date, scoped_leave.created_at, scoped_leave.id;
end;
$$;

create or replace function public.list_leave_calendar_entries_for_preview(p_person_id uuid)
returns table (
  id uuid,
  person_id uuid,
  employee_name text,
  company_key text,
  leave_type_label text,
  start_date date,
  end_date date,
  start_time time without time zone,
  end_time time without time zone,
  business_days integer,
  hours numeric,
  status text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_target_user_id uuid;
  v_is_manager boolean;

  v_can_view_all_approved boolean;
  v_team_ids uuid[];
  v_peer_ids uuid[];
begin
  if not private.is_system_portal_account_admin() then
    raise exception 'Only a Super Admin may preview Leave Calendar scope.' using errcode = '42501';
  end if;

  select person.auth_user_id
  into v_target_user_id
  from public.internal_org_people person
  join public.profiles profile on profile.id = person.auth_user_id
  where person.id = p_person_id
    and person.node_kind = 'person'
    and person.is_active
    and profile.account_status = 'active'
    and profile.login_name is not null
    and private.is_active_portal_account(profile.id);

  if not found or v_target_user_id is null
    or not exists(select 1 from private.portal_role_policy(v_target_user_id) policy where policy.person_id=p_person_id) then
    raise exception 'The selected employee is unavailable.' using errcode = '23503';
  end if;

  v_peer_ids := array(select peer.person_id from private.employee_calendar_peer_ids(p_person_id) peer);
  v_is_manager := private.is_calendar_manager(v_target_user_id);
  v_team_ids := array(select scope.person_id from private.manager_calendar_team_ids(p_person_id) scope);
  v_can_view_all_approved := private.can_view_all_approved_leave_calendar_for(v_target_user_id);

  return query
  with scoped_leave as (
    select
      request.id,
      request.employee_person_id as person_id,
      employee.full_name as employee_name,
      employee.company_key,
      case when request.employee_person_id = p_person_id then request.request_type_label
        when request.status = 'approved' then 'Approved leave' else 'Pending leave' end as leave_type_label,
      request.start_date,
      request.end_date,
      request.start_time,
      request.end_time,
      request.business_days,
      request.hours,
      case request.status
        when 'approved' then 'Approved'
        else 'Pending'
      end as status,
      request.created_at
    from public.leave_requests request
    join public.internal_org_people employee
      on employee.id = request.employee_person_id
     and employee.node_kind = 'person'
    where (request.employee_person_id = p_person_id or request.employee_person_id = any(v_team_ids))
      and request.status in ('submitted', 'approved')

    union all

    select
      request.id,
      request.employee_person_id as person_id,
      case
        when employee.is_active then employee.full_name
        else employee.full_name || ' (archived)'
      end as employee_name,
      employee.company_key,
      case when request.status='approved' then 'Approved leave' else 'Pending leave' end as leave_type_label,
      request.start_date,
      request.end_date,
      request.start_time,
      request.end_time,
      request.business_days,
      request.hours,
      case when request.status='approved' then 'Approved' else 'Pending' end as status,
      request.created_at
    from public.leave_requests request
    join public.internal_org_people employee
      on employee.id = request.employee_person_id
     and employee.node_kind = 'person'
    where (v_can_view_all_approved or (v_is_manager and employee.is_active)
      or request.employee_person_id = any(v_peer_ids))
      and not (request.employee_person_id = any(v_team_ids))
      and (request.status='approved'
        or (v_can_view_all_approved and employee.is_active and request.status='submitted'))
      and request.employee_person_id <> p_person_id
  )
  select
    scoped_leave.id,
    scoped_leave.person_id,
    scoped_leave.employee_name,
    scoped_leave.company_key,
    scoped_leave.leave_type_label,
    scoped_leave.start_date,
    scoped_leave.end_date,
    scoped_leave.start_time,
    scoped_leave.end_time,
    scoped_leave.business_days,
    scoped_leave.hours,
    scoped_leave.status
  from scoped_leave
  order by scoped_leave.start_date, scoped_leave.created_at, scoped_leave.id;
end;
$$;

create or replace function private.can_submit_team_leave(p_person_id uuid,p_actor uuid default auth.uid())
returns boolean language sql stable security definer set search_path = '' as $$
  select p_actor is not null and exists(
    select 1 from private.portal_role_policy(p_actor) policy
    join public.internal_org_people employee on employee.id=p_person_id
    left join lateral private.resolve_internal_org_employee_manager(employee.id) manager on true
    left join public.internal_org_people manager_person on manager_person.id=manager.manager_id
    where employee.is_active and employee.node_kind='person'
      and employee.auth_user_id is distinct from p_actor
      and (policy.can_manage_accounts or (policy.app_role='manager' and manager_person.auth_user_id=p_actor))
  );
$$;

create or replace function private.can_review_leave_request(p_leave_request_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists(select 1 from private.portal_role_policy() policy
    join public.leave_requests request on request.id=p_leave_request_id
    where request.user_id is distinct from (select auth.uid())
      and (policy.can_manage_accounts or (policy.can_review_leave_workspace
        and private.is_current_leave_request_reviewer(request.id,(select auth.uid())))));
$$;

create or replace function private.is_current_leave_request_reviewer(p_leave_request_id uuid,p_reviewer_user_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select p_reviewer_user_id is not null and exists(
    select 1 from private.portal_role_policy(p_reviewer_user_id) policy
    join public.leave_requests request on request.id=p_leave_request_id
    where request.user_id is distinct from p_reviewer_user_id
      and (policy.can_manage_accounts or (
        policy.app_role='manager' and not private.is_manager_leave_person(request.employee_person_id)
        and exists(select 1 from private.leave_request_reviewer_assignments assignment
          cross join lateral private.resolve_leave_approval_grants(request.employee_person_id) current_grant
          where assignment.leave_request_id=request.id and assignment.reviewer_user_id=p_reviewer_user_id
            and current_grant.reviewer_user_id=p_reviewer_user_id and current_grant.scope_kind='subtree'
            and (assignment.assignment_kind='legacy' or assignment.source_grant_id=current_grant.grant_id))
      )));
$$;

CREATE OR REPLACE FUNCTION private.resolve_leave_approval_grants(p_person_id uuid)
 RETURNS TABLE(grant_id uuid, reviewer_user_id uuid, reviewer_label text, scope_kind text, scope_priority integer, scope_depth integer)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  with recursive ancestors as (
    select person.id, person.parent_id, 0::integer as depth
    from public.internal_org_people person
    where person.id = p_person_id
      and person.node_kind = 'person'
      and person.is_active

    union all

    select parent.id, parent.parent_id, ancestors.depth + 1
    from public.internal_org_people parent
    join ancestors on ancestors.parent_id = parent.id
    where parent.is_active
  ), candidates(grant_id, reviewer_user_id, reviewer_label, scope_kind, scope_priority, scope_depth) as (
  select
    approval_grant.id,
    approval_grant.reviewer_user_id,
    approval_grant.reviewer_label,
    approval_grant.scope_kind,
    approval_grant.priority::integer,
    coalesce(
      (
        select min(ancestor.depth)
        from ancestors ancestor
        where ancestor.id = approval_grant.scope_root_person_id
      ),
      2147483647
    )
  from private.leave_approval_grants approval_grant
  where approval_grant.revoked_at is null
    and private.is_active_portal_account(approval_grant.reviewer_user_id)
    and exists(select 1 from private.portal_role_policy(approval_grant.reviewer_user_id) policy
      where (approval_grant.scope_kind='global' and policy.can_manage_accounts)
        or (approval_grant.scope_kind='subtree' and policy.app_role='manager'))
    and (
      not private.is_manager_leave_person(p_person_id)
      or (approval_grant.scope_kind = 'global' and exists(
        select 1 from private.manager_leave_reviewers configured
        where configured.reviewer_user_id=approval_grant.reviewer_user_id))
    )
    and approval_grant.reviewer_user_id is distinct from
      (select p.auth_user_id from public.internal_org_people p where p.id=p_person_id)
    and (
      approval_grant.scope_kind = 'global'
      or (
        approval_grant.scope_kind = 'subtree'
        and exists (
          select 1
          from public.internal_org_people root_person
          join public.profiles manager_profile
            on manager_profile.id = root_person.auth_user_id
          where root_person.id = approval_grant.scope_root_person_id
            and root_person.node_kind = 'person'
            and root_person.is_active
            and root_person.auth_user_id = approval_grant.reviewer_user_id
            and manager_profile.app_role = 'manager'
            and manager_profile.account_status = 'active'
            and manager_profile.login_name is not null
        )
        and exists (
          select 1
          from ancestors ancestor
          where ancestor.id = approval_grant.scope_root_person_id
        )
      )
    )
  )
  select candidate.*
  from candidates candidate
  where candidate.scope_kind = 'global'
    or candidate.scope_depth = (
      select min(nearest.scope_depth) from candidates nearest where nearest.scope_kind = 'subtree'
    );
$function$
;

CREATE OR REPLACE FUNCTION private.can_add_my_leave_request_attachment(p_leave_request_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select p_leave_request_id is not null
    and (select auth.uid()) is not null
    and coalesce(((select auth.jwt()) ->> 'is_anonymous')::boolean, false) = false
    and private.has_current_portal_access()
    and (
      private.current_active_portal_employee_id() is not null
      or (
        private.is_portal_account_admin()
        and exists (
          select 1
          from public.profiles profile
          where profile.id = (select auth.uid())
            and profile.app_role in ('admin','system_admin')
            and profile.login_name is not null
            and profile.account_status = 'active'
        )
      )
    )
    and exists (
      select 1
      from public.leave_requests request
      where request.id = p_leave_request_id
        and (
          (request.user_id = (select auth.uid()) or private.can_submit_team_leave(request.employee_person_id))
          or (
            private.is_portal_account_admin()
            and exists (
              select 1
              from public.profiles profile
              where profile.id = (select auth.uid())
                and profile.app_role in ('admin','system_admin')
                and profile.login_name is not null
                and profile.account_status = 'active'
            )
          )
        )
        and request.status in ('submitted', 'approved')
    );
$function$
;

CREATE OR REPLACE FUNCTION public.prepare_my_leave_request_attachment_upload(p_request_id uuid, p_file_name text, p_mime_type text, p_size_bytes bigint)
 RETURNS TABLE(storage_path text, file_name text, mime_type text, size_bytes bigint)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_actor_user_id uuid := (select auth.uid());
  v_actor_is_system_admin boolean := private.is_portal_account_admin()
    and exists (
      select 1
      from public.profiles profile
      where profile.id = (select auth.uid())
        and profile.app_role in ('admin','system_admin')
        and profile.login_name is not null
        and profile.account_status = 'active'
    );
  v_request public.leave_requests%rowtype;
  v_file_name text := nullif(btrim(p_file_name), '');
  v_mime_type text := lower(nullif(btrim(p_mime_type), ''));
  v_extension text;
  v_existing_count integer;
  v_intent_count integer;
  v_actor_attempt_count integer;
  v_global_attempt_count integer;
  v_storage_path text;
begin
  if v_actor_user_id is null
    or coalesce(((select auth.jwt()) ->> 'is_anonymous')::boolean, false)
    or not private.has_current_portal_access()
    or (
      private.current_active_portal_employee_id() is null
      and not v_actor_is_system_admin
    ) then
    raise exception 'An active linked portal account is required to attach a supporting file.'
      using errcode = '42501';
  end if;

  if p_request_id is null
    or v_file_name is null
    or char_length(v_file_name) > 255
    or v_file_name ~ '[/\\]'
    or v_file_name ~ '[[:cntrl:]]'
    or v_mime_type is null
    or v_mime_type not in (
      'application/pdf',
      'image/heic',
      'image/heif',
      'image/jpeg',
      'image/png',
      'image/webp'
    )
    or p_size_bytes is null
    or p_size_bytes < 1
    or p_size_bytes > 5242880 then
    raise exception 'Choose a PDF or supported image up to 5 MB.' using errcode = '22023';
  end if;

  -- Lock the request before calculating remaining slots, so concurrent tabs
  -- cannot allocate more than ten active/registered files for one request.
  select request.*
  into v_request
  from public.leave_requests request
  where request.id = p_request_id
  for update;

  if not found
    or (
      v_request.user_id is distinct from v_actor_user_id
      and not v_actor_is_system_admin and not private.can_submit_team_leave(v_request.employee_person_id)
    )
    or v_request.status not in ('submitted', 'approved') then
    raise exception 'This supporting file cannot be attached to that leave request.'
      using errcode = '42501';
  end if;

  -- Serialize the rolling quota across requests and browser tabs. The per-
  -- account cap permits the normal ten-file request plus reasonable retries;
  -- the portal-wide cap remains below one cleanup run's object capacity.
  perform pg_advisory_xact_lock(739110, 19);

  select count(*)::integer
  into v_actor_attempt_count
  from private.leave_attachment_upload_attempts attempt
  where attempt.attempted_by = v_actor_user_id
    and attempt.created_at > clock_timestamp() - interval '24 hours';

  select count(*)::integer
  into v_global_attempt_count
  from private.leave_attachment_upload_attempts attempt
  where attempt.created_at > clock_timestamp() - interval '24 hours';

  if v_actor_attempt_count >= 15 or v_global_attempt_count >= 750 then
    -- Deliberately do not reveal whether the actor or the portal-wide cap was
    -- reached, nor any history/count that could expose other employee use.
    raise exception 'Supporting-file uploads are temporarily limited. Please try again later or contact HR.'
      using errcode = '22023';
  end if;

  delete from private.leave_attachment_upload_intents intent
  where intent.leave_request_id = v_request.id
    and intent.expires_at <= clock_timestamp();

  select count(*)::integer
  into v_existing_count
  from public.leave_request_attachments attachment
  where attachment.leave_request_id = v_request.id;

  select count(*)::integer
  into v_intent_count
  from private.leave_attachment_upload_intents intent
  where intent.leave_request_id = v_request.id
    and intent.expires_at > clock_timestamp();

  if v_existing_count + v_intent_count >= 10 then
    raise exception 'A leave request can have up to 10 supporting files.' using errcode = '22023';
  end if;

  insert into private.leave_attachment_upload_attempts (
    attempted_by,
    leave_request_id
  )
  values (
    v_actor_user_id,
    v_request.id
  );

  v_extension := case v_mime_type
    when 'application/pdf' then '.pdf'
    when 'image/heic' then '.heic'
    when 'image/heif' then '.heif'
    when 'image/jpeg' then '.jpg'
    when 'image/png' then '.png'
    when 'image/webp' then '.webp'
  end;
  v_storage_path := v_request.id::text || '/' || gen_random_uuid()::text || v_extension;

  insert into private.leave_attachment_upload_intents (
    storage_path,
    leave_request_id,
    uploaded_by,
    file_name,
    mime_type,
    size_bytes,
    expires_at
  )
  values (
    v_storage_path,
    v_request.id,
    v_actor_user_id,
    v_file_name,
    v_mime_type,
    p_size_bytes,
    clock_timestamp() + interval '20 minutes'
  );

  return query
  select v_storage_path, v_file_name, v_mime_type, p_size_bytes;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.complete_my_leave_request_attachment_upload(p_storage_path text)
 RETURNS TABLE(id uuid, leave_request_id uuid, file_name text, mime_type text, size_bytes bigint, created_at timestamp with time zone)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_actor_user_id uuid := (select auth.uid());
  v_actor_is_system_admin boolean := private.is_portal_account_admin()
    and exists (
      select 1
      from public.profiles profile
      where profile.id = (select auth.uid())
        and profile.app_role in ('admin','system_admin')
        and profile.login_name is not null
        and profile.account_status = 'active'
    );
  v_intent private.leave_attachment_upload_intents%rowtype;
  v_request public.leave_requests%rowtype;
  v_object_metadata jsonb;
  v_object_size_text text;
  v_attachment public.leave_request_attachments%rowtype;
begin
  if v_actor_user_id is null
    or coalesce(((select auth.jwt()) ->> 'is_anonymous')::boolean, false)
    or not private.has_current_portal_access()
    or (
      private.current_active_portal_employee_id() is null
      and not v_actor_is_system_admin
    )
    or p_storage_path is null
    or char_length(p_storage_path) > 500 then
    raise exception 'This supporting file could not be attached. Refresh and try again.'
      using errcode = '42501';
  end if;

  select intent.*
  into v_intent
  from private.leave_attachment_upload_intents intent
  where intent.storage_path = p_storage_path
  for update;

  if not found
    or v_intent.uploaded_by is distinct from v_actor_user_id
    or v_intent.expires_at <= clock_timestamp() then
    raise exception 'This supporting file could not be attached. Refresh and try again.'
      using errcode = '42501';
  end if;

  select request.*
  into v_request
  from public.leave_requests request
  where request.id = v_intent.leave_request_id
  for update;

  if not found
    or (
      v_request.user_id is distinct from v_actor_user_id
      and not v_actor_is_system_admin and not private.can_submit_team_leave(v_request.employee_person_id)
    )
    or v_request.status not in ('submitted', 'approved') then
    raise exception 'This supporting file could not be attached. Refresh and try again.'
      using errcode = '42501';
  end if;

  select object.metadata
  into v_object_metadata
  from storage.objects object
  where object.bucket_id = 'leave-evidence'
    and object.name = v_intent.storage_path;

  if not found then
    raise exception 'The supporting file upload was not found. Please try again.'
      using errcode = '42501';
  end if;

  v_object_size_text := coalesce(v_object_metadata ->> 'size', '');
  if (
    case
      when v_object_size_text ~ '^[0-9]+$' then v_object_size_text::bigint
      else -1
    end
  ) <> v_intent.size_bytes
    or lower(coalesce(v_object_metadata ->> 'mimetype', '')) <> v_intent.mime_type then
    raise exception 'The uploaded file did not match the approved file details.'
      using errcode = '22023';
  end if;

  insert into public.leave_request_attachments (
    leave_request_id,
    uploaded_by,
    storage_path,
    file_name,
    mime_type,
    size_bytes
  )
  values (
    v_intent.leave_request_id,
    v_actor_user_id,
    v_intent.storage_path,
    v_intent.file_name,
    v_intent.mime_type,
    v_intent.size_bytes
  )
  returning * into v_attachment;

  delete from private.leave_attachment_upload_intents intent
  where intent.storage_path = v_intent.storage_path;

  -- Retain only the fact of the update, never a sensitive file name or path.
  insert into public.leave_request_events (
    leave_request_id,
    actor_user_id,
    event_type,
    note
  )
  values (
    v_request.id,
    v_actor_user_id,
    'updated',
    'Supporting file added.'
  );

  return query
  select
    v_attachment.id,
    v_attachment.leave_request_id,
    v_attachment.file_name,
    v_attachment.mime_type,
    v_attachment.size_bytes,
    v_attachment.created_at;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.discard_my_leave_request_attachment_upload(p_storage_path text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_actor_user_id uuid := (select auth.uid());
  v_actor_is_system_admin boolean := private.is_portal_account_admin()
    and exists (
      select 1
      from public.profiles profile
      where profile.id = (select auth.uid())
        and profile.app_role in ('admin','system_admin')
        and profile.login_name is not null
        and profile.account_status = 'active'
    );
  v_intent private.leave_attachment_upload_intents%rowtype;
begin
  if v_actor_user_id is null
    or coalesce(((select auth.jwt()) ->> 'is_anonymous')::boolean, false)
    or not private.has_current_portal_access()
    or (
      private.current_active_portal_employee_id() is null
      and not v_actor_is_system_admin
    )
    or p_storage_path is null
    or char_length(p_storage_path) > 500 then
    raise exception 'This supporting file upload cannot be cleared.' using errcode = '42501';
  end if;

  select intent.*
  into v_intent
  from private.leave_attachment_upload_intents intent
  where intent.storage_path = p_storage_path
  for update;

  if not found
    or v_intent.uploaded_by is distinct from v_actor_user_id
    or not private.can_add_my_leave_request_attachment(v_intent.leave_request_id) then
    raise exception 'This supporting file upload cannot be cleared.' using errcode = '42501';
  end if;

  delete from private.leave_attachment_upload_intents intent
  where intent.storage_path = v_intent.storage_path;
end;
$function$
;

CREATE OR REPLACE FUNCTION private.list_calendar_birthday_person_ids_for(p_person_id uuid)
 RETURNS TABLE(person_id uuid)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  with recursive target as (
    select
      person.id as person_id,
      profile.app_role
    from public.internal_org_people person
    join public.profiles profile on profile.id = person.auth_user_id
    where person.id = p_person_id
      and person.node_kind = 'person'
      and person.is_active
      and profile.account_status = 'active'
      and profile.login_name is not null
    limit 1
  ), descendants as (
    select target.person_id as node_id, 0::integer as depth
    from target

    union all

    select child.id, descendants.depth + 1
    from descendants
    join public.internal_org_people child
      on child.parent_id = descendants.node_id
    where child.is_active
  )
  select person.id
  from target
  join public.internal_org_people person
    on person.node_kind = 'person'
   and person.is_active
  where target.app_role in ('admin','system_admin')
    or person.id = target.person_id
    or (
      target.app_role = 'manager'
      and exists (
        select 1
        from descendants
        where descendants.node_id = person.id
          and descendants.depth > 0
      )
    );
$function$
;

CREATE OR REPLACE FUNCTION public.list_calendar_birthdays()
 RETURNS TABLE(employee_name text, birthday_month smallint, birthday_day smallint)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_actor_user_id uuid := (select auth.uid());
  v_actor_person_id uuid;
  v_actor_role text;
begin
  if v_actor_user_id is null
    or coalesce(((select auth.jwt()) ->> 'is_anonymous')::boolean, false)
    or not private.has_current_portal_access() then
    raise exception 'An active portal account is required to view calendar birthdays.'
      using errcode = '42501';
  end if;

  select profile.app_role
    into v_actor_role
  from public.profiles profile
  where profile.id = v_actor_user_id
    and profile.account_status = 'active'
    and profile.login_name is not null;

  if not found then
    raise exception 'An active portal account is required to view calendar birthdays.'
      using errcode = '42501';
  end if;

  v_actor_person_id := private.current_active_portal_employee_id();

  -- A System Admin may intentionally sit outside the employee roster. No
  -- other unlinked account receives birthday data.
  if v_actor_person_id is null and v_actor_role <> 'system_admin' then
    raise exception 'An active linked employee account is required to view calendar birthdays.'
      using errcode = '42501';
  end if;

  return query
  select
    person.full_name,
    extract(month from detail.date_of_birth)::smallint,
    extract(day from detail.date_of_birth)::smallint
  from public.internal_org_people person
  join private.employee_directory_details detail
    on detail.person_id = person.id
  where person.node_kind = 'person'
    and person.is_active
    and person.full_name is not null
    and detail.date_of_birth is not null
    and (
      (v_actor_person_id is null and v_actor_role = 'system_admin')
      or person.id in (
        select visible.person_id
        from private.list_calendar_birthday_person_ids_for(v_actor_person_id) visible
      )
    )
  order by
    extract(month from detail.date_of_birth),
    extract(day from detail.date_of_birth),
    lower(person.full_name),
    person.id;
end;
$function$
;

create or replace function public.list_calendar_birthdays_for_preview(p_person_id uuid)
returns table(employee_name text,birthday_month smallint,birthday_day smallint)
language plpgsql stable security definer set search_path = '' as $$
begin
  if p_person_id is null then
    raise exception 'The selected employee is unavailable.' using errcode='23503';
  end if;
  perform public.get_portal_role_capabilities(p_person_id);
  return query
  select person.full_name,
    extract(month from detail.date_of_birth)::smallint,
    extract(day from detail.date_of_birth)::smallint
  from private.list_calendar_birthday_person_ids_for(p_person_id) visible
  join public.internal_org_people person on person.id=visible.person_id
  join private.employee_directory_details detail on detail.person_id=person.id
  where person.full_name is not null and detail.date_of_birth is not null
  order by extract(month from detail.date_of_birth),extract(day from detail.date_of_birth),lower(person.full_name),person.id;
end;
$$;

CREATE OR REPLACE FUNCTION private.list_visible_employee_check_in_person_ids()
 RETURNS TABLE(person_id uuid)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  with recursive
  caller as (
    select (select auth.uid()) as user_id
  ),
  session as (
    select caller.user_id,
      private.has_current_portal_access()
      and caller.user_id is not null
      and coalesce(((select auth.jwt()) ->> 'is_anonymous')::boolean, false) = false
        as is_valid
    from caller
  ),
  actor as (
    select person.id as person_id
    from public.internal_org_people person
    join public.profiles profile
      on profile.id = person.auth_user_id
    join session on person.auth_user_id = session.user_id
    where session.is_valid
      and private.is_active_linked_internal_employee(session.user_id)
      and profile.app_role in ('manager','admin','system_admin')
      and profile.account_status = 'active'
      and profile.login_name is not null
      and person.node_kind = 'person'
      and person.is_active
    limit 1
  ),
  global_scope as (
    select private.has_global_employee_check_in_scope() as is_global
  ),
  scoped_roots as (
    select actor.person_id
    from actor

    union

    select access_grant.scope_root_person_id
    from private.employee_check_in_access_grants access_grant
    join session on access_grant.reviewer_user_id = session.user_id
    join public.profiles reviewer_profile
      on reviewer_profile.id = access_grant.reviewer_user_id
    join public.internal_org_people root_person
      on root_person.id = access_grant.scope_root_person_id
    where session.is_valid
      and private.is_active_linked_internal_employee(session.user_id)
      and reviewer_profile.app_role in ('manager','admin','system_admin')
      and reviewer_profile.account_status = 'active'
      and reviewer_profile.login_name is not null
      and access_grant.scope_kind = 'subtree'
      and access_grant.revoked_at is null
      and root_person.node_kind = 'person'
      and root_person.is_active
      and root_person.auth_user_id = session.user_id
  ),
  descendants as (
    select scoped_roots.person_id as root_person_id,
           scoped_roots.person_id as node_id,
           0::integer as depth
    from scoped_roots

    union all

    select descendants.root_person_id,
           child.id as node_id,
           descendants.depth + 1
    from descendants
    join public.internal_org_people child on child.parent_id = descendants.node_id
    where child.is_active
  )
  select person.id
  from public.internal_org_people person
  cross join session
  cross join global_scope
  where session.is_valid
    and person.node_kind = 'person'
    and person.is_active
    and (
      global_scope.is_global
      or exists (
        select 1
        from descendants
        where descendants.node_id = person.id
          and descendants.depth > 0
      )
    );
$function$
;

CREATE OR REPLACE FUNCTION public.list_employee_check_in_workspace_for_preview(p_person_id uuid)
 RETURNS TABLE(person_id uuid, full_name text, position_title text, company_key text, start_date date, reminders jsonb)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_target_auth_user_id uuid;
  v_target_can_access boolean := false;
  v_target_is_global boolean := false;
begin
  if not private.is_system_portal_account_admin() then
    raise exception 'Only a Super Admin may preview check-in scope.' using errcode = '42501';
  end if;

  select person.auth_user_id into v_target_auth_user_id
  from public.internal_org_people person
  where person.id = p_person_id
    and person.node_kind = 'person'
    and person.is_active;

  if not found then
    raise exception 'The selected employee is unavailable.' using errcode = '23503';
  end if;

  select exists (
    select 1
    from public.profiles profile
    join public.internal_org_people target
      on target.auth_user_id = profile.id
    where profile.id = v_target_auth_user_id
      and profile.app_role in ('manager','admin','system_admin')
      and profile.account_status = 'active'
      and profile.login_name is not null
      and target.id = p_person_id
      and target.node_kind = 'person'
      and target.is_active
      and private.is_active_linked_internal_employee(profile.id)
  ) into v_target_can_access;

  select exists (
    select 1
    from public.profiles profile
    where profile.id = v_target_auth_user_id
      and profile.app_role in ('admin','system_admin')
      and profile.account_status = 'active'
      and profile.login_name is not null
  ) into v_target_is_global;

  return query
  with recursive descendants as (
    select person.id, person.parent_id, 0::integer as depth
    from public.internal_org_people person
    where person.id = p_person_id
      and person.node_kind = 'person'
      and person.is_active
    union all
    select child.id, child.parent_id, descendants.depth + 1
    from public.internal_org_people child
    join descendants on child.parent_id = descendants.id
    where child.is_active
  )
  select
    person.id,
    person.full_name,
    person.position_title,
    person.company_key,
    person.started_date,
    coalesce(schedule.reminders, '[]'::jsonb)
  from public.internal_org_people person
  left join lateral (
    select jsonb_agg(
      jsonb_build_object(
        'id', reminder.id,
        'milestone', reminder.milestone,
        'sequence', reminder.reminder_sequence,
        'dueDate', reminder.due_date,
        'notifyDate', reminder.notify_date,
        'status', reminder.delivery_status,
        'deliveredAt', reminder.delivered_at,
        'completedAt', reminder.completed_at,
        'needsReviewReason', reminder.needs_review_reason,
        'reviewOutcome', review.outcome_code,
        'reviewDate', review.review_date,
        'reviewNotes', review.notes,
        'reviewVersion', review.version,
        'reviewRecordedAt', review.recorded_at,
        'peopleCultureApproved', coalesce(review.people_culture_approved_version = review.version, false)
      )
      order by reminder.due_date, reminder.reminder_sequence
    ) as reminders
    from private.employee_check_in_reminders reminder
    left join private.employee_check_in_reminders canonical
      on canonical.person_id = reminder.person_id
      and canonical.milestone = reminder.milestone
      and canonical.due_date = reminder.due_date
      and canonical.reminder_sequence = 'initial'
    left join private.employee_check_in_reviews review on review.reminder_id = canonical.id
    where reminder.person_id = person.id
      and reminder.delivery_status not in ('superseded', 'cancelled')
  ) schedule on true
  where v_target_can_access
    and person.node_kind = 'person'
    and person.is_active
    and (
      v_target_is_global
      or exists (
        select 1 from descendants
        where descendants.id = person.id and descendants.depth > 0
      )
    )
  order by lower(person.full_name), person.id;
end;
$function$
;

CREATE OR REPLACE FUNCTION private.resolve_internal_org_employee_manager(p_person_id uuid)
 RETURNS TABLE(manager_id uuid, manager_name text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  with recursive ancestors as (
    select
      parent.id,
      parent.full_name,
      parent.parent_id,
      parent.node_kind,
      parent.auth_user_id,
      parent.is_active,
      1::integer as depth
    from public.internal_org_people person
    join public.internal_org_people parent on parent.id = person.parent_id
    where person.id = p_person_id

    union all

    select
      parent.id,
      parent.full_name,
      parent.parent_id,
      parent.node_kind,
      parent.auth_user_id,
      parent.is_active,
      ancestors.depth + 1
    from public.internal_org_people parent
    join ancestors on parent.id = ancestors.parent_id
  ), authorised_manager as (
    select ancestor.*
    from ancestors ancestor
    join public.profiles profile
      on profile.id = ancestor.auth_user_id
    where ancestor.node_kind = 'person'
      and ancestor.is_active
      and ancestor.auth_user_id is not null
      and profile.app_role in ('manager','admin','system_admin')
      and profile.account_status = 'active'
      and profile.login_name is not null
    order by ancestor.depth, ancestor.id
    limit 1
  )
  select
    (select manager.id from authorised_manager manager) as manager_id,
    coalesce(
      (select manager.full_name from authorised_manager manager),
      (
        select root.manager_label
        from ancestors ancestor
        join private.employee_roster_external_manager_roots root
          on root.org_unit_id = ancestor.id
        where ancestor.node_kind = 'org_unit'
        order by ancestor.depth, ancestor.id
        limit 1
      )
    ) as manager_name;
$function$
;

CREATE OR REPLACE FUNCTION public.resolve_leave_notification_manager(p_request_id uuid)
 RETURNS TABLE(manager_user_id uuid, manager_name text, manager_email text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  with request_route as (
    select r.*,private.is_manager_leave_person(r.employee_person_id) as manager_owned
    from public.leave_requests r where r.id=p_request_id
  ), group_recipients as (
    select ap.id,ap.full_name,lower(nullif(btrim(d.work_email),'')) email,c.priority
    from request_route r
    join private.manager_leave_reviewers c on r.manager_owned
    join public.profiles ap on ap.id=c.reviewer_user_id
    join public.internal_org_people mp on mp.auth_user_id=ap.id and mp.is_active and mp.node_kind='person'
    left join private.employee_directory_details d on d.person_id=mp.id
    where ap.id is distinct from r.user_id and private.is_active_portal_account(ap.id)
      and private.is_current_leave_request_reviewer(r.id,ap.id)
  ), candidates as (
    select mp.auth_user_id,mp.full_name,d.work_email,0 priority
    from request_route r
    join lateral private.resolve_internal_org_employee_manager(r.employee_person_id) m on true
    join public.internal_org_people mp on mp.id=m.manager_id and mp.is_active
    join public.profiles ap on ap.id=mp.auth_user_id and ap.app_role in ('manager','admin','system_admin')
    left join private.employee_directory_details d on d.person_id=mp.id
    where r.id=p_request_id and not r.manager_owned and mp.auth_user_id is distinct from r.user_id
      and private.is_active_portal_account(mp.auth_user_id)
      and private.is_current_leave_request_reviewer(r.id,mp.auth_user_id)
    union all
    select ap.id,coalesce(mp.full_name,ap.full_name),d.work_email,case when a.is_primary then 1 else 2 end
    from request_route r join private.leave_request_reviewer_assignments a on a.leave_request_id=r.id
    join public.profiles ap on ap.id=a.reviewer_user_id and ap.app_role in ('manager','admin','system_admin')
    join public.internal_org_people mp on mp.auth_user_id=ap.id and mp.is_active and mp.node_kind='person'
    left join private.employee_directory_details d on d.person_id=mp.id
    where r.id=p_request_id and not r.manager_owned and ap.id is distinct from r.user_id and private.is_active_portal_account(ap.id)
      and private.is_current_leave_request_reviewer(r.id,ap.id)
  )
  (select c.auth_user_id,c.full_name,lower(nullif(btrim(c.work_email),'')) from candidates c
    order by c.priority,c.auth_user_id limit 1)
  union all
  select (array_agg(g.id order by g.priority,g.id))[1],
    string_agg(g.full_name,', ' order by g.priority,g.id),
    -- A missing address must not silently drop one of the required reviewers.
    case when bool_and(g.email is not null) then string_agg(g.email,',' order by g.priority,g.id) end
  from group_recipients g having count(*)>0;
$function$
;

CREATE OR REPLACE FUNCTION public.get_leave_workspace_for_preview(p_person_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_target_user_id uuid;
  v_target_role text;
  v_target_is_system_admin boolean;
  v_target_can_review_workspace boolean;
  v_target_can_read_all boolean;
  v_workspace jsonb;
begin
  perform public.get_portal_role_capabilities(p_person_id);
  if not private.is_system_portal_account_admin() then
    raise exception 'Only the active System Admin may preview another employee leave workspace.'
      using errcode = '42501';
  end if;

  select person.auth_user_id, profile.app_role
  into v_target_user_id, v_target_role
  from public.internal_org_people person
  join public.profiles profile on profile.id = person.auth_user_id
  where person.id = p_person_id
    and person.node_kind = 'person'
    and person.is_active
    and person.auth_user_id is not null
    and profile.account_status = 'active'
    and profile.login_name is not null
    and private.is_active_portal_account(profile.id)
  limit 1;

  if not found then
    raise exception 'The selected employee does not have an active linked portal account.'
      using errcode = '42501';
  end if;

  v_target_is_system_admin := v_target_role in ('admin','system_admin');
  v_target_can_read_all := private.has_leave_register_read_grant(v_target_user_id);
  v_target_can_review_workspace := coalesce((select policy.can_review_leave_workspace
    from private.portal_role_policy(v_target_user_id) policy),false);

  with visible_requests as materialized (
    select
      request.id,
      request.employee_person_id,
      request.user_id,
      request.request_type_label,
      request.start_date,
      request.end_date,
      request.start_time,
      request.end_time,
      request.business_days,
      request.hours,
      request.approval_required,
      request.status,
      request.submitted_at,
      request.manager_name_snapshot,
      request.reason,
      request.manager_note,
      request.created_at,
      coalesce(employee.full_name, profile.full_name, 'Employee') as employee_name,
      coalesce(employee.company_key, 'mam') as employee_company_key,
      coalesce(primary_assignment.reviewer_label, request.manager_name_snapshot) as assigned_reviewer_label,
      (
        v_target_is_system_admin
        or private.is_current_leave_request_reviewer(request.id, v_target_user_id)
      ) as target_can_review
    from public.leave_requests request
    join public.internal_org_people employee
      on employee.id = request.employee_person_id
     and employee.node_kind = 'person'
    left join public.profiles profile on profile.id = request.user_id
    left join lateral (
      select assignment.reviewer_label
      from private.leave_request_reviewer_assignments assignment
      where assignment.leave_request_id = request.id
        and assignment.is_primary
      limit 1
    ) primary_assignment on true
    where request.status in ('submitted', 'approved', 'rejected', 'changes_requested', 'cancelled')
      and (
        request.employee_person_id = p_person_id
        or request.user_id = v_target_user_id
        or v_target_is_system_admin
        or private.is_current_leave_request_reviewer(request.id, v_target_user_id)
        or v_target_can_read_all
      )
    order by request.start_date desc, request.created_at desc, request.id
    limit 1001
  ), bounded_requests as materialized (
    select request.*
    from visible_requests request
    order by request.start_date desc, request.created_at desc, request.id
    limit 1000
  ), request_projection as (
    select coalesce(
      jsonb_agg(
        jsonb_build_object(
          'id', request.id,
          'person_id', request.employee_person_id,
          'employee_name', request.employee_name,
          'company_key', request.employee_company_key,
          'leave_type_label', request.request_type_label,
          'start_date', request.start_date,
          'end_date', request.end_date,
          'start_time', request.start_time,
          'end_time', request.end_time,
          'business_days', request.business_days,
          'hours', request.hours,
          'approval_required', request.approval_required,
          'status', case request.status
            when 'approved' then 'Approved'
            when 'rejected' then 'Declined'
            when 'cancelled' then 'Cancelled'
            else 'Pending'
          end,
          'submitted_at', request.submitted_at,
          'assigned_reviewer_label', request.assigned_reviewer_label,
          'can_decide', request.employee_person_id is distinct from p_person_id
            and request.approval_required
            and request.status = 'submitted'
            and request.target_can_review,
          'can_cancel', (request.employee_person_id = p_person_id or v_target_is_system_admin)
            and request.status <> 'cancelled',
          'can_attach', (request.employee_person_id = p_person_id or v_target_is_system_admin)
            and request.status in ('submitted', 'approved'),
          'employee_note', request.reason,
          'manager_note', request.manager_note
        )
        order by request.start_date desc, request.created_at desc, request.id
      ),
      '[]'::jsonb
    ) as value
    from bounded_requests request
  ), attachment_projection as (
    select coalesce(
      jsonb_agg(
        jsonb_build_object(
          'id', attachment.id,
          'leave_request_id', attachment.leave_request_id,
          'file_name', attachment.file_name,
          'mime_type', attachment.mime_type,
          'size_bytes', attachment.size_bytes,
          'created_at', attachment.created_at
        )
        order by attachment.created_at, attachment.id
      ),
      '[]'::jsonb
    ) as value
    from public.leave_request_attachments attachment
    join bounded_requests request on request.id = attachment.leave_request_id
  )
  select jsonb_build_object(
    'requests', request_projection.value,
    'attachments', attachment_projection.value,
    'can_review_leave', v_target_can_review_workspace,
    'can_view_all_leave', v_target_can_read_all,
    'is_truncated', (select count(*) > 1000 from visible_requests)
  )
  into v_workspace
  from request_projection
  cross join attachment_projection;

  return coalesce(v_workspace, jsonb_build_object(
    'requests', '[]'::jsonb,
    'attachments', '[]'::jsonb,
    'can_review_leave', v_target_can_review_workspace,
    'can_view_all_leave', v_target_can_read_all,
    'is_truncated', false
  ));
end;
$function$
;

CREATE OR REPLACE FUNCTION public.list_leave_workspace_requests()
 RETURNS TABLE(id uuid, person_id uuid, employee_name text, company_key text, leave_type_label text, start_date date, end_date date, start_time time without time zone, end_time time without time zone, business_days integer, hours numeric, approval_required boolean, status text, submitted_at timestamp with time zone, assigned_reviewer_label text, can_decide boolean, can_cancel boolean, can_attach boolean, employee_note text, manager_note text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_actor_user_id uuid := (select auth.uid());
  v_actor_is_hr boolean := private.is_internal_org_hr();
  v_actor_is_system_admin boolean := private.is_operational_portal_admin();
  v_actor_person_id uuid := private.current_active_portal_employee_id();
  v_actor_can_read_all boolean := private.has_leave_register_read_grant((select auth.uid()));
begin
  if v_actor_user_id is null
    or coalesce(((select auth.jwt()) ->> 'is_anonymous')::boolean, false)
    or not private.is_active_portal_account() then
    raise exception 'An active portal account is required to view leave.'
      using errcode = '42501';
  end if;

  if not v_actor_is_hr and v_actor_person_id is null then
    raise exception 'An active linked employee account is required to view leave.'
      using errcode = '42501';
  end if;

  return query
  select
    request.id,
    employee.id,
    coalesce(employee.full_name, profile.full_name, 'Employee'),
    employee.company_key,
    request.request_type_label,
    request.start_date,
    request.end_date,
    request.start_time,
    request.end_time,
    request.business_days,
    request.hours,
    request.approval_required,
    case request.status
      when 'approved' then 'Approved'
      when 'rejected' then 'Declined'
      when 'cancelled' then 'Cancelled'
      else 'Pending'
    end,
    request.submitted_at,
    coalesce(primary_assignment.reviewer_label, request.manager_name_snapshot),
    (
      request.user_id is distinct from v_actor_user_id
      and request.approval_required
      and request.status = 'submitted'
      and private.can_review_leave_request(request.id)
    ),
    (
      request.user_id is not null
      and (request.user_id = v_actor_user_id or v_actor_is_system_admin)
      and (v_actor_person_id is not null or v_actor_is_system_admin)
      and request.status <> 'cancelled'
    ),
    (
      request.user_id is not null
      and (request.user_id = v_actor_user_id or v_actor_is_system_admin)
      and (v_actor_person_id is not null or v_actor_is_system_admin)
      and request.status in ('submitted', 'approved')
    ),
    request.reason,
    request.manager_note
  from public.leave_requests request
  join public.internal_org_people employee
    on employee.id = request.employee_person_id
   and employee.node_kind = 'person'
  left join public.profiles profile
    on profile.id = request.user_id
  left join lateral (
    select assignment.reviewer_label
    from private.leave_request_reviewer_assignments assignment
    where assignment.leave_request_id = request.id
      and assignment.is_primary
    limit 1
  ) primary_assignment on true
  where request.status in ('submitted', 'approved', 'rejected', 'changes_requested', 'cancelled')
    and (
      request.user_id = v_actor_user_id
      or request.employee_person_id = v_actor_person_id
      or private.can_review_leave_request(request.id)
      or v_actor_can_read_all
    )
  order by request.start_date desc, request.created_at desc, request.id;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.get_leave_priority_workspace_before_accrual(p_preview_person_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare actor uuid := auth.uid(); scope_actor uuid; scope_person uuid; scope_admin boolean; requests jsonb; calendar_ids uuid[];
begin
  if actor is null or not private.is_active_portal_account(actor)
    or coalesce((auth.jwt()->>'is_anonymous')::boolean,false) then
    raise exception 'An active portal account is required.' using errcode = '42501';
  end if;
  scope_actor := actor;
  scope_person := private.current_active_portal_employee_id();
  if p_preview_person_id is not null then
    if not private.is_system_portal_account_admin() then raise exception 'Only Super Admin can change profile.' using errcode = '42501'; end if;
    select auth_user_id into scope_actor from public.internal_org_people
    where id = p_preview_person_id and is_active and node_kind = 'person';
    if scope_actor is null or not private.is_active_portal_account(scope_actor) then
      raise exception 'An active linked employee is required.' using errcode = '42501';
    end if;
    scope_person := p_preview_person_id;
    requests := public.get_leave_workspace_for_preview(p_preview_person_id)->'requests';
  else
    select coalesce(jsonb_agg(to_jsonb(r)), '[]'::jsonb) into requests from public.list_leave_workspace_requests() r;
  end if;
  scope_admin := coalesce((select policy.can_manage_leave_balances from public.get_portal_role_capabilities(p_preview_person_id) policy),false);
  select array_agg(c.id) into calendar_ids from public.list_leave_calendar_entries() c;
  return jsonb_build_object(
    'people', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'personId', p.id, 'name', p.full_name,
        'canSubmit', private.can_submit_team_leave(p.id,scope_actor) and p.auth_user_id is not null and private.is_active_portal_account(p.auth_user_id),
        -- Delegating managers need category eligibility to offer the correct
        -- request types (not a balance). Do not mask it with financial fields.
        'paidLeave', coalesce(d.employment_type in ('full_time','part_time'),false),
        'canViewBalance', coalesce(p.id = scope_person or scope_admin or private.can_view_team_leave_balance(p.id,scope_actor), false),
        'hours', case when (p.id = scope_person or scope_admin or private.can_view_team_leave_balance(p.id,scope_actor)) and d.employment_type in ('full_time','part_time') then coalesce(b.hours,80) else null end,
        'asOf', case when p.id = scope_person or scope_admin or private.can_view_team_leave_balance(p.id,scope_actor) then b.as_of else null end,
        'canViewSickBalance', scope_admin or private.can_view_team_leave_balance(p.id,scope_actor),
        'sickHours', case when scope_admin or private.can_view_team_leave_balance(p.id,scope_actor) then s.hours else null end,
        'sickAsOf', case when scope_admin or private.can_view_team_leave_balance(p.id,scope_actor) then s.as_of else null end,
        'isExample', case when p.id = scope_person or scope_admin or private.can_view_team_leave_balance(p.id,scope_actor) then coalesce(b.is_example,true) else false end
      ) order by lower(p.full_name)), '[]'::jsonb)
      from public.internal_org_people p
      left join private.employee_directory_details d on d.person_id = p.id
      left join private.employee_annual_leave_balances b on b.person_id = p.id
      left join private.employee_sick_leave_balances s on s.person_id=p.id
      where p.is_active and p.node_kind = 'person'
        and (p.id = scope_person or scope_admin or private.can_view_team_leave_balance(p.id,scope_actor) or private.can_submit_team_leave(p.id,scope_actor))
    ),
    'payrollImports', case when scope_admin then private.payroll_balance_import_projection() else '[]'::jsonb end,
'canManageBalances', scope_admin,
    'requests', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'id', r.id, 'pendingBalance', r.status = 'submitted' and a.request_id is not null,
        'evidenceDueDate', r.evidence_due_date,
        'requiredHours', coalesce(a.required_hours,r.hours),
        'balanceSufficient', private.leave_payroll_balance_sufficient(r.id),
        'canAttach', case when p_preview_person_id is null then private.can_add_my_leave_request_attachment(r.id) else ((r.user_id=scope_actor or scope_admin or private.can_submit_team_leave(r.employee_person_id,scope_actor)) and r.status in ('submitted','approved')) end
      )), '[]'::jsonb)
      from public.leave_requests r left join private.leave_balance_approvals a on a.request_id = r.id
      where r.id in (select (entry->>'id')::uuid from jsonb_array_elements(requests) entry)
    ),
    'pendingBalanceCalendarIds', (
      select coalesce(jsonb_agg(r.id),'[]'::jsonb)
      from public.leave_requests r join private.leave_balance_approvals a on a.request_id = r.id
      where r.status = 'submitted' and (
        (p_preview_person_id is null and r.id = any(calendar_ids)
          and (r.user_id=actor or private.can_review_leave_request(r.id)))
        or r.id in (select (entry->>'id')::uuid from jsonb_array_elements(requests) entry)
      )
    )
  );
end;
$function$
;

CREATE OR REPLACE FUNCTION public.get_leave_priority_workspace_before_approved_deductions(p_preview_person_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare w jsonb; people jsonb:='[]'; person jsonb; c jsonb; pol private.leave_accrual_policies%rowtype;
begin
  w:=public.get_leave_priority_workspace_before_accrual(p_preview_person_id);
  for person in select * from jsonb_array_elements(w->'people') loop
    if coalesce((person->>'canViewBalance')::boolean,false) or coalesce((person->>'canViewSickBalance')::boolean,false) then
      c:=private.calculate_employee_leave_accrual((person->>'personId')::uuid,(now() at time zone 'Australia/Melbourne')::date-1);
      if c->>'status'<>'not_configured' and (person->>'canViewBalance')::boolean and (person->>'paidLeave')::boolean then
        person:=person||jsonb_build_object('hours',coalesce(c->'annualHours',person->'hours'),'asOf',c->'annualAsOf',
          'annualPayrollHours',c->'annualPayrollHours','annualPayrollDate',c->'annualPayrollDate');
      end if;
      if c->>'status'<>'not_configured' and (person->>'canViewSickBalance')::boolean then
        person:=person||jsonb_build_object('sickHours',c->'personalHours','sickAsOf',c->'personalAsOf',
          'sickPayrollHours',c->'personalPayrollHours','sickPayrollDate',c->'personalPayrollDate');
      end if;
      -- A neutral reconciliation status contains no leave type, amount or reason.
      person:=person||jsonb_build_object('accrualStatus',c->'status');
      if coalesce((select policy.can_manage_leave_balances from public.get_portal_role_capabilities(p_preview_person_id) policy),false) then
        select * into pol from private.leave_accrual_policies where person_id=(person->>'personId')::uuid order by effective_from desc,created_at desc,id desc limit 1;
        person:=person||jsonb_build_object('accrualReviewDate',c->'reviewDate','accrualPolicy',case when pol.id is null then null else jsonb_build_object('weeklyHours',pol.weekly_hours,'annualWeeks',pol.annual_weeks,'personalWeeks',pol.personal_weeks,'shiftworker',pol.shiftworker,'enabled',pol.enabled,'note',pol.note) end);
      end if;
    end if;
    people:=people||jsonb_build_array(person);
  end loop;
  return jsonb_set(w,'{people}',people);
end;
$function$
;

create or replace function public.update_employee_directory_role(p_person_id uuid,p_role text,p_expected_role text)
returns text language plpgsql volatile security definer set search_path = '' as $$
declare v_user_id uuid; v_old_role text; v_actor_role text;
begin
  if not private.is_system_portal_account_admin() then
    raise exception 'Directory access denied.' using errcode='42501';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('mam:directory-role-control',0));
  select profile.app_role into v_actor_role from public.profiles profile
    where profile.id=(select auth.uid()) for update;
  if v_actor_role is distinct from 'system_admin' or not private.is_system_portal_account_admin() then
    raise exception 'Directory access denied.' using errcode='42501';
  end if;
  if p_role is null or p_role not in ('employee','manager','account','admin') then
    raise exception 'Invalid role.' using errcode='23514';
  end if;
  if p_person_id is null or p_expected_role is null then
    raise exception 'Invalid role target.' using errcode='23514';
  end if;
  select person.auth_user_id into v_user_id from public.internal_org_people person
    where person.id=p_person_id and person.node_kind='person' and person.is_active;
  if v_user_id is null or not private.is_active_portal_account(v_user_id) then
    raise exception 'An active linked portal account is required.' using errcode='42501';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('portal_account:' || v_user_id::text,0));
  perform credential.id from private.employee_onboarding_credentials credential
    where credential.auth_user_id=v_user_id or credential.person_id=p_person_id
    order by credential.id for update;
  if exists(select 1 from private.portal_password_reset_claims claim
    where (claim.auth_user_id=v_user_id or claim.person_id=p_person_id) and claim.status='pending') then
    raise exception 'A password reset is in progress. Resolve it before changing this role.' using errcode='55000';
  end if;
  if exists(select 1 from private.employee_onboarding_credentials credential
    where (credential.auth_user_id=v_user_id or credential.person_id=p_person_id)
      and (credential.status in ('claimed','sending') or (credential.status='needs_review' and credential.claimed_login is not null))) then
    raise exception 'Onboarding credential delivery in progress' using errcode='55000';
  end if;
  perform person.id from public.internal_org_people person
    where person.id=p_person_id and person.auth_user_id=v_user_id and person.node_kind='person' and person.is_active for update;
  if not found or not private.is_active_portal_account(v_user_id) then
    raise exception 'An active linked portal account is required.' using errcode='42501';
  end if;
  select profile.app_role into v_old_role from public.profiles profile where profile.id=v_user_id for update;
  if v_old_role='system_admin' then
    raise exception 'System Admin accounts cannot be changed through ordinary role management.' using errcode='42501';
  end if;
  if v_old_role is distinct from p_expected_role then
    raise exception 'Role has changed. Refresh and try again.' using errcode='PT409';
  end if;
  if v_old_role is distinct from p_role then
    update public.profiles set app_role=p_role where id=v_user_id;
    insert into private.employee_directory_audit_events(person_id,actor_user_id,event_type,changed_fields)
      values(p_person_id,(select auth.uid()),'updated',array['app_role']::text[]);
  end if;
  return p_role;
end;
$$;

CREATE OR REPLACE FUNCTION public.create_portal_account(p_person_id uuid, p_auth_user_id uuid, p_login_name text, p_app_role text DEFAULT 'employee'::text, p_expected_person_version bigint DEFAULT NULL::bigint)
 RETURNS TABLE(person_id uuid, auth_user_id uuid, login_name text, account_status text, account_version bigint)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_actor uuid := (select auth.uid());
  v_login_name text := lower(btrim(p_login_name));
  v_person public.internal_org_people;
  v_before jsonb;
  v_account_version bigint;
begin
  if not private.is_portal_account_admin() then
    raise exception 'Only an account administrator can create a portal account.'
      using errcode = '42501';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('mam:directory-role-control',0));
  perform 1 from public.profiles profile where profile.id=v_actor for share;
  if not private.is_portal_account_admin() then
    raise exception 'Only an account administrator can create a portal account.' using errcode='42501';
  end if;

  if not private.is_valid_portal_login(v_login_name) then
    raise exception 'Choose a valid email or username.' using errcode = '22023';
  end if;

  if p_app_role is null
    or p_app_role not in ('employee','manager','account','admin') then
    raise exception 'Choose a valid application role.' using errcode = '22023';
  end if;

  if p_app_role <> 'employee' and not private.is_system_portal_account_admin() then
    raise exception 'Only System Admin may assign ordinary application roles.' using errcode='42501';
  end if;
  if exists(select 1 from public.profiles profile where profile.id=p_auth_user_id
    and (profile.app_role='system_admin' or (profile.login_name is not null and profile.app_role is distinct from p_app_role))) then
    raise exception 'Use the audited role editor for existing ordinary accounts.' using errcode='42501';
  end if;

  if p_expected_person_version is null then
    raise exception 'The expected person version is required.' using errcode = '22004';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('portal_account:' || p_auth_user_id::text, 0));

  select person.*
  into v_person
  from public.internal_org_people person
  where person.id = p_person_id
    and person.version = p_expected_person_version
    and person.node_kind = 'person'
    and person.is_active
  for update;

  if not found then
    raise exception 'The selected person changed, is archived, or is not a person.'
      using errcode = '40001';
  end if;

  if not exists (select 1 from auth.users auth_user where auth_user.id = p_auth_user_id) then
    raise exception 'The Auth user does not exist.' using errcode = '23503';
  end if;

  if v_person.auth_user_id is not null and v_person.auth_user_id <> p_auth_user_id then
    raise exception 'This person is already linked to another account.'
      using errcode = '23505';
  end if;

  if exists (
    select 1
    from public.internal_org_people other_person
    where other_person.auth_user_id = p_auth_user_id
      and other_person.id <> p_person_id
  ) then
    raise exception 'This account is already linked to another person.'
      using errcode = '23505';
  end if;

  perform 1 from public.profiles profile where profile.id=p_auth_user_id for update;
  if exists(select 1 from public.profiles profile where profile.id=p_auth_user_id
    and (profile.app_role='system_admin' or (profile.login_name is not null and profile.app_role is distinct from p_app_role))) then
    raise exception 'Use the audited role editor for existing ordinary accounts.' using errcode='42501';
  end if;

  select jsonb_build_object(
    'login_name', profile.login_name,
    'account_status', profile.account_status,
    'must_change_password', profile.must_change_password,
    'account_version', profile.account_version,
    'person_id', linked_person.id
  )
  into v_before
  from public.profiles profile
  left join public.internal_org_people linked_person
    on linked_person.auth_user_id = profile.id
  where profile.id = p_auth_user_id;

  insert into public.profiles as profile (
    id,
    full_name,
    preferred_name,
    app_role,
    login_name,
    account_status,
    must_change_password,
    temporary_password_issued_at,
    disabled_at,
    credentials_valid_after
  )
  values (
    p_auth_user_id,
    v_person.full_name,
    null,
    lower(btrim(p_app_role)),
    v_login_name,
    'active',
    false,
    null,
    null,
    clock_timestamp()
  )
  on conflict (id) do update
  set full_name = excluded.full_name,
      app_role = excluded.app_role,
      login_name = excluded.login_name,
      account_status = 'active',
      must_change_password = false,
      password_changed_at = clock_timestamp(),
      temporary_password_issued_at = null,
      disabled_at = null,
      credentials_valid_after = clock_timestamp(),
      account_version = profile.account_version + 1,
      updated_at = clock_timestamp()
  returning profile.account_version into v_account_version;

  update public.internal_org_people person
  set auth_user_id = p_auth_user_id,
      updated_by = v_actor
  where person.id = p_person_id;

  insert into private.portal_account_admin_events (
    actor_user_id,
    target_user_id,
    event_type,
    before_state,
    after_state
  )
  values (
    v_actor,
    p_auth_user_id,
    'account_linked',
    v_before,
    jsonb_build_object(
      'login_name', v_login_name,
      'account_status', 'active',
      'must_change_password', false,
      'account_version', v_account_version,
      'person_id', p_person_id
    )
  );

  return query
  select p_person_id, p_auth_user_id, v_login_name, 'active'::text, v_account_version;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.set_portal_account_admin(p_auth_user_id uuid, p_is_admin boolean)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if not private.is_system_portal_account_admin() then
    raise exception 'Only an account administrator can change account administrators.'
      using errcode = '42501';
  end if;

  if p_is_admin is null then
    raise exception 'Choose whether this account is an administrator.' using errcode = '22004';
  end if;

  if not private.is_active_portal_account(p_auth_user_id) then
    raise exception 'Only an active portal account can be an administrator.'
      using errcode = '23503';
  end if;

  if not p_is_admin and p_auth_user_id = (select auth.uid()) then
    raise exception 'You cannot remove your own account-administrator access.'
      using errcode = '42501';
  end if;

  if p_is_admin then
    insert into private.portal_account_admins (auth_user_id, added_by, revoked_at)
    values (p_auth_user_id, (select auth.uid()), null)
    on conflict (auth_user_id) do update
    set added_at = clock_timestamp(),
        added_by = (select auth.uid()),
        revoked_at = null;
  else
    update private.portal_account_admins administrator
    set revoked_at = clock_timestamp()
    where administrator.auth_user_id = p_auth_user_id
      and administrator.revoked_at is null;
  end if;

  insert into private.portal_account_admin_events (
    actor_user_id, target_user_id, event_type, after_state
  )
  values (
    (select auth.uid()),
    p_auth_user_id,
    case when p_is_admin then 'account_admin_added' else 'account_admin_removed' end,
    jsonb_build_object('account_admin', p_is_admin)
  );

  return p_is_admin;
end;
$function$
;

create table private.subscription_management_grant_events (
  id bigint generated always as identity primary key,
  actor_user_id uuid references auth.users(id) on delete set null,
  before_person_ids uuid[] not null,
  after_person_ids uuid[] not null,
  created_at timestamptz not null default clock_timestamp()
);
alter table private.subscription_management_grant_events enable row level security;
revoke all on private.subscription_management_grant_events from public,anon,authenticated,service_role;
create trigger reject_retired_test_identity_reference before insert or update on private.subscription_management_grant_events
  for each row execute function private.reject_retired_test_identity_reference();

create function private.validate_subscription_role_delegates(p_person_ids uuid[])
returns uuid[] language plpgsql volatile security definer set search_path = '' as $$
declare requested uuid[]:=coalesce(p_person_ids,array[]::uuid[]); valid uuid[];
begin
  if not private.is_system_portal_account_admin() then
    raise exception 'Only System Admin may configure subscription delegates.' using errcode='42501';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('mam:directory-role-control',0));
  perform 1 from public.profiles profile where profile.id=(select auth.uid()) for update;
  if not private.is_system_portal_account_admin() then
    raise exception 'Only System Admin may configure subscription delegates.' using errcode='42501';
  end if;
  if cardinality(requested)>24 or array_position(requested,null) is not null
    or (select count(distinct id) from unnest(requested) id)<>cardinality(requested) then
    raise exception 'Choose up to 24 distinct active Managers.' using errcode='22023';
  end if;
  perform person.id from public.internal_org_people person
    join public.profiles profile on profile.id=person.auth_user_id
    where person.id=any(requested) order by person.id for share of person,profile;
  select coalesce(array_agg(person.id order by person.id),array[]::uuid[]) into valid
    from public.internal_org_people person
    cross join lateral private.portal_role_policy(person.auth_user_id) policy
    where person.id=any(requested) and policy.person_id=person.id and policy.app_role='manager';
  if cardinality(valid)<>cardinality(requested) then
    raise exception 'Choose active linked Managers for subscription delegation.' using errcode='22023';
  end if;
  return valid;
end;
$$;
revoke all on function private.validate_subscription_role_delegates(uuid[]) from public,anon,authenticated,service_role;

create function public.list_subscription_management_delegates()
returns table(person_id uuid,full_name text,position_title text)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not private.is_system_portal_account_admin() then
    raise exception 'Only System Admin may configure subscription delegates.' using errcode='42501';
  end if;
  return query select person.id,person.full_name,person.position_title
    from private.subscription_management_grants access_grant
    join public.internal_org_people person on person.id=access_grant.person_id
    cross join lateral private.portal_role_policy(person.auth_user_id) policy
    where policy.person_id=person.id and policy.app_role='manager'
    order by lower(person.full_name),person.id;
end;
$$;

create function public.replace_subscription_management_delegates(p_person_ids uuid[])
returns void language plpgsql volatile security definer set search_path = '' as $$
declare requested uuid[]; previous uuid[];
begin
  requested:=private.validate_subscription_role_delegates(p_person_ids);
  perform pg_advisory_xact_lock(hashtextextended('mam:subscription-management-grants',0));
  select coalesce(array_agg(access_grant.person_id order by access_grant.person_id),array[]::uuid[])
    into previous from private.subscription_management_grants access_grant;
  delete from private.subscription_management_grants access_grant where not access_grant.person_id=any(requested);
  insert into private.subscription_management_grants(person_id)
    select id from unnest(requested) id on conflict(person_id) do nothing;
  insert into private.subscription_management_grant_events(actor_user_id,before_person_ids,after_person_ids)
    values((select auth.uid()),previous,requested);
end;
$$;
revoke all on function public.list_subscription_management_delegates(),public.replace_subscription_management_delegates(uuid[]) from public,anon,authenticated,service_role;
grant execute on function public.list_subscription_management_delegates(),public.replace_subscription_management_delegates(uuid[]) to authenticated;

create or replace function public.replace_subscription_credential_access_grants(p_person_ids uuid[])
returns void language plpgsql volatile security definer set search_path = '' as $$
declare requested uuid[];
begin
  requested:=private.validate_subscription_role_delegates(p_person_ids);
  perform pg_advisory_xact_lock(hashtextextended('mam:subscription-credential-access-grants',0));
  delete from private.subscription_credential_access_grants access_grant where not access_grant.person_id=any(requested);
  insert into private.subscription_credential_access_grants(auth_user_id,person_id,granted_by)
    select person.auth_user_id,person.id,(select auth.uid()) from public.internal_org_people person
    where person.id=any(requested) on conflict(auth_user_id) do nothing;
  insert into private.subscription_credential_access_audit_events(actor_user_id,delegate_count)
    values((select auth.uid()),cardinality(requested));
end;
$$;

CREATE OR REPLACE FUNCTION public.list_subscription_credential_access_grants()
 RETURNS TABLE(person_id uuid, full_name text, position_title text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if not private.is_system_portal_account_admin() then
    raise exception 'You do not have permission to manage credential access.' using errcode = '42501';
  end if;

  return query
  select
    person.id,
    person.full_name,
    person.position_title
  from private.subscription_credential_access_grants access_grant
  join public.internal_org_people person
    on person.id = access_grant.person_id
    and person.auth_user_id = access_grant.auth_user_id
    and person.node_kind = 'person'
    and person.is_active
  join public.profiles profile
    on profile.id = access_grant.auth_user_id
    and profile.account_status = 'active'
    and profile.login_name is not null
    and profile.app_role='manager'
  order by lower(person.full_name), person.id;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.list_subscription_credential_grant_candidates()
 RETURNS TABLE(person_id uuid, full_name text, position_title text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if not private.is_system_portal_account_admin() then
    raise exception 'You do not have permission to manage credential access.' using errcode = '42501';
  end if;

  return query
  select
    person.id,
    person.full_name,
    person.position_title
  from public.internal_org_people person
  join public.profiles profile
    on profile.id = person.auth_user_id
    and profile.account_status = 'active'
    and profile.login_name is not null
    and profile.app_role='manager'
  where person.node_kind = 'person'
    and person.is_active
  order by lower(person.full_name), person.id;
end;
$function$
;

revoke execute on function public.list_subscription_credential_access_grants(),public.list_subscription_credential_grant_candidates(),public.replace_subscription_credential_access_grants(uuid[]) from service_role;

alter table private.payroll_balance_import_batches add column preview_person_id uuid
  references public.internal_org_people(id) on delete restrict;

create function private.freeze_payroll_balance_comparison(p_batch_id uuid)
returns void language plpgsql volatile security definer set search_path = '' as $$
declare comparison jsonb; differences integer;
begin
  perform 1 from private.payroll_balance_import_batches where id=p_batch_id for update;
  if not found then raise exception 'The payroll import is unavailable.' using errcode='42501'; end if;
  update private.payroll_balance_import_batches set comparison_only=true where id=p_batch_id and not comparison_only;
  if not exists(select 1 from private.payroll_balance_comparisons where batch_id=p_batch_id) then
    with values_to_compare as (
      select s.id,s.employee_name,s.company_key,s.as_of,s.match_status,
        v.kind,v.uploaded,v.system_hours,v.system_as_of
      from private.payroll_balance_import_stage_rows s
      left join private.employee_annual_leave_balances a on a.person_id=s.person_id
      left join private.employee_sick_leave_balances k on k.person_id=s.person_id
      cross join lateral (values
        ('annual',s.annual_hours,case when not a.is_example then a.hours-private.approved_leave_hours_after(s.person_id,array['Annual leave'],a.as_of) end,a.as_of),
        ('sick',s.sick_hours,k.hours-private.approved_leave_hours_after(s.person_id,array['Sick leave','Carer''s leave'],k.as_of),k.as_of)
      ) v(kind,uploaded,system_hours,system_as_of)
      where s.batch_id=p_batch_id and v.uploaded is not null
    ), compared as (
      select *,match_status<>'linked' or system_hours is null or round(uploaded,2) is distinct from round(system_hours,2) as different
      from values_to_compare
    )
    select jsonb_agg(jsonb_build_object('rowId',id,'employeeName',employee_name,'company',company_key,'kind',kind,
      'uploadedHours',uploaded,'systemHours',system_hours,'fileAsOf',as_of,'systemAsOf',system_as_of,
      'matchStatus',match_status,'different',different) order by company_key,employee_name,kind),count(*) filter(where different)
      into comparison,differences from compared;
    insert into private.payroll_balance_comparisons(batch_id,rows,difference_count)
      values(p_batch_id,coalesce(comparison,'[]'),differences);
  end if;
end;
$$;
revoke all on function private.freeze_payroll_balance_comparison(uuid) from public,anon,authenticated,service_role;

create or replace function public.stage_payroll_balance_import(p_actor_user_id uuid,p_source_digest text,p_files jsonb,p_rows jsonb)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare result jsonb; bid uuid;
begin
  perform 1 from public.profiles profile where profile.id=p_actor_user_id for share;
  result:=public.stage_payroll_balance_import_before_comparison(p_actor_user_id,p_source_digest,p_files,p_rows);
  bid:=(result->>'batchId')::uuid;
  if private.payroll_comparison_only(p_actor_user_id) then
    perform private.freeze_payroll_balance_comparison(bid);
  end if;
  return private.payroll_balance_import_batch_projection(bid);
end;
$$;

create function public.stage_payroll_balance_import_for_preview(
  p_actor_user_id uuid,p_person_id uuid,p_source_digest text,p_files jsonb,p_rows jsonb
)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare target_policy record; result jsonb; bid uuid; scoped_digest text;
begin
  if p_actor_user_id is null or not exists(select 1 from private.portal_role_policy(p_actor_user_id) policy where policy.is_super_admin) then
    raise exception 'Only active System Admin may stage a preview upload.' using errcode='42501';
  end if;
  perform 1 from public.profiles profile where profile.id=p_actor_user_id for share;
  perform person.id from public.internal_org_people person join public.profiles profile on profile.id=person.auth_user_id
    where person.id=p_person_id for share of person,profile;
  if not exists(select 1 from private.portal_role_policy(p_actor_user_id) policy where policy.is_super_admin) then
    raise exception 'Only active System Admin may stage a preview upload.' using errcode='42501';
  end if;
  select policy.* into target_policy from public.internal_org_people person
    cross join lateral private.portal_role_policy(person.auth_user_id) policy
    where person.id=p_person_id and policy.person_id=p_person_id and policy.can_import_payroll_balances;
  if not found then raise exception 'The selected payroll importer is unavailable.' using errcode='42501'; end if;
  if p_source_digest is null or p_source_digest !~ '^[0-9a-f]{64}$' then
    raise exception 'The payroll balance upload is invalid.' using errcode='22023';
  end if;
  scoped_digest:=encode(extensions.digest('portal-role-preview:'||p_person_id::text||':'||p_source_digest,'sha256'),'hex');
  result:=public.stage_payroll_balance_import_before_comparison(p_actor_user_id,scoped_digest,p_files,p_rows);
  bid:=(result->>'batchId')::uuid;
  update private.payroll_balance_import_batches set preview_person_id=p_person_id
    where id=bid and (preview_person_id is null or preview_person_id=p_person_id);
  if not found then raise exception 'The payroll preview scope changed.' using errcode='40001'; end if;
  if target_policy.payroll_comparison_only then
    perform private.freeze_payroll_balance_comparison(bid);
  end if;
  return private.payroll_balance_import_batch_projection(bid);
end;
$$;
revoke all on function public.stage_payroll_balance_import_for_preview(uuid,uuid,text,jsonb,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.stage_payroll_balance_import_for_preview(uuid,uuid,text,jsonb,jsonb) to service_role;

CREATE OR REPLACE FUNCTION public.commit_payroll_balance_import_before_comparison(p_batch_id uuid, p_expected_version bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  actor uuid := (select auth.uid());
  batch private.payroll_balance_import_batches%rowtype;
begin
  if actor is null or not private.is_operational_portal_admin() then
    raise exception 'You do not have permission to import payroll balances.' using errcode = '42501';
  end if;
  if p_batch_id is null or p_expected_version is null or p_expected_version < 1 then
    raise exception 'The payroll import is invalid.' using errcode = '22023';
  end if;

  select source.* into batch
  from private.payroll_balance_import_batches source
  where source.id = p_batch_id
  for update;
  if not found then
    raise exception 'The payroll import is no longer available.' using errcode = 'P0002';
  end if;
  if batch.uploaded_by <> actor and not private.is_operational_portal_admin() then
    raise exception 'You do not have permission to commit this payroll import.' using errcode = '42501';
  end if;
  if batch.comparison_only or exists(select 1 from private.payroll_balance_comparisons comparison where comparison.batch_id=batch.id)
    or private.payroll_comparison_only(batch.uploaded_by) then
    raise exception 'This upload is comparison only. Existing balances have not changed.' using errcode='42501';
  end if;
  if batch.batch_status = 'committed' then
    return private.payroll_balance_import_batch_projection(batch.id);
  end if;
  if batch.version <> p_expected_version then
    raise exception 'This payroll import has changed. Re-open it and try again.' using errcode = '40001';
  end if;

  lock table public.internal_org_people, private.employee_directory_details in share mode;
  perform private.reconcile_payroll_balance_import_batch(batch.id);

  insert into private.payroll_balance_imports (
    company_key,
    employee_name,
    annual_hours,
    sick_hours,
    as_of,
    source_file,
    source_sha256,
    person_id,
    match_status,
    batch_id
  )
  select
    stage.company_key,
    stage.employee_name,
    stage.annual_hours,
    stage.sick_hours,
    stage.as_of,
    stage.source_file,
    stage.source_sha256,
    stage.person_id,
    stage.match_status,
    batch.id
  from private.payroll_balance_import_stage_rows stage
  where stage.batch_id = batch.id;

  -- Migration 20260910015007 makes these audit actors nullable only when a
  -- source_import_id is present. Imported snapshots deliberately use that
  -- immutable source identity instead of presenting the uploader as a manual
  -- balance editor; the prerequisite assertion above verifies this contract.
  insert into private.employee_annual_leave_balances as balance (
    person_id,
    hours,
    as_of,
    is_example,
    updated_by,
    source_import_id
  )
  select distinct on (imported.person_id)
    imported.person_id,
    imported.annual_hours,
    imported.as_of,
    false,
    null,
    imported.id
  from private.payroll_balance_imports imported
  where imported.batch_id = batch.id
    and imported.match_status = 'linked'
    and imported.person_id is not null
    and imported.annual_hours is not null
  order by imported.person_id, imported.as_of desc, imported.id desc
  on conflict (person_id) do update
  set hours = excluded.hours,
      as_of = excluded.as_of,
      is_example = false,
      updated_by = null,
      source_import_id = excluded.source_import_id,
      updated_at = clock_timestamp()
  where balance.as_of < excluded.as_of
    or (
      balance.as_of = excluded.as_of
      and (
        balance.hours is distinct from excluded.hours
        or balance.is_example
      )
    );

  insert into private.employee_sick_leave_balances as balance (
    person_id,
    hours,
    as_of,
    updated_by,
    source_import_id
  )
  select distinct on (imported.person_id)
    imported.person_id,
    imported.sick_hours,
    imported.as_of,
    null,
    imported.id
  from private.payroll_balance_imports imported
  where imported.batch_id = batch.id
    and imported.match_status = 'linked'
    and imported.person_id is not null
    and imported.sick_hours is not null
  order by imported.person_id, imported.as_of desc, imported.id desc
  on conflict (person_id) do update
  set hours = excluded.hours,
      as_of = excluded.as_of,
      updated_by = null,
      source_import_id = excluded.source_import_id,
      updated_at = clock_timestamp()
  where balance.as_of < excluded.as_of
    or (
      balance.as_of = excluded.as_of
      and balance.hours is distinct from excluded.hours
    );

  insert into private.annual_leave_balance_history (
    person_id,
    hours,
    as_of,
    is_example,
    actor_user_id,
    source_import_id
  )
  select balance.person_id, balance.hours, balance.as_of, false, null, balance.source_import_id
  from private.employee_annual_leave_balances balance
  join private.payroll_balance_imports imported on imported.id = balance.source_import_id
  where imported.batch_id = batch.id
    and balance.source_import_id is not null
  on conflict do nothing;

  insert into private.sick_leave_balance_history (
    person_id,
    hours,
    as_of,
    actor_user_id,
    source_import_id
  )
  select balance.person_id, balance.hours, balance.as_of, null, balance.source_import_id
  from private.employee_sick_leave_balances balance
  join private.payroll_balance_imports imported on imported.id = balance.source_import_id
  where imported.batch_id = batch.id
    and balance.source_import_id is not null
  on conflict do nothing;

  update private.payroll_balance_import_batches target
  set batch_status = 'committed',
      committed_at = clock_timestamp(),
      version = target.version + 1
  where target.id = batch.id;

  return private.payroll_balance_import_batch_projection(batch.id);
end;
$function$
;

CREATE OR REPLACE FUNCTION public.commit_payroll_balance_import(p_batch_id uuid, p_expected_version bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
 if auth.uid() is null or not private.is_operational_portal_admin() then raise exception 'Not authorised' using errcode='42501'; end if;
 perform 1 from private.payroll_balance_import_batches where id=p_batch_id for update;
 if private.payroll_comparison_only(auth.uid()) or exists(select 1 from private.payroll_balance_import_batches where id=p_batch_id and (comparison_only or private.payroll_comparison_only(uploaded_by))) then
  raise exception 'This upload is comparison only. Existing balances have not changed.' using errcode='42501';
 end if;
 return public.commit_payroll_balance_import_before_comparison(p_batch_id,p_expected_version);
end;
$function$
;

CREATE OR REPLACE FUNCTION public.get_payroll_balance_import_batch(p_batch_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  batch private.payroll_balance_import_batches%rowtype;
begin
  if not private.has_payroll_balance_import_access() or p_batch_id is null then
    raise exception 'You do not have permission to view this payroll import.' using errcode = '42501';
  end if;
  select source.* into batch
  from private.payroll_balance_import_batches source
  where source.id = p_batch_id;
  if not found then
    raise exception 'The payroll import is no longer available.' using errcode = 'P0002';
  end if;
  if batch.uploaded_by <> (select auth.uid()) and not private.is_operational_portal_admin() then
    raise exception 'You do not have permission to view this payroll import.' using errcode = '42501';
  end if;
  return private.payroll_balance_import_batch_projection(batch.id);
end;
$function$
;

CREATE OR REPLACE FUNCTION public.get_payroll_balance_import_workspace()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if (select auth.uid()) is null then
    raise exception 'An active portal account is required.' using errcode = '42501';
  end if;
  if not private.has_payroll_balance_import_access() then
    return jsonb_build_object('canImport', false, 'canManageAccess', false);
  end if;
  return jsonb_build_object(
    'canImport', true,
    'comparisonOnly',private.payroll_comparison_only((select auth.uid())),
    'canManageBalances',private.is_operational_portal_admin(),
    'canManageAccess', false,
    'reminder', private.payroll_balance_monthly_reminder_projection(),
    'recentBatches', coalesce((
      select jsonb_agg(jsonb_build_object(
        'batchId', recent.id,
        'status', recent.batch_status,
        'files', recent.source_files,
        'rowCount', recent.row_count,
        'createdAt', recent.created_at,
        'committedAt', recent.committed_at
      ) order by recent.created_at desc, recent.id)
      from (
        select batch.*
        from private.payroll_balance_import_batches batch
        where batch.uploaded_by = (select auth.uid())
          or private.is_operational_portal_admin()
        order by batch.created_at desc, batch.id
        limit 6
      ) recent
    ), '[]'::jsonb)
  );
end;
$function$
;

create function public.get_payroll_balance_import_workspace_for_preview(p_person_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare policy record;
begin
  select * into strict policy from public.get_portal_role_capabilities(p_person_id);
  if p_person_id is null or not private.is_system_portal_account_admin() then
    raise exception 'Only System Admin may preview payroll scope.' using errcode='42501';
  end if;
  if not policy.can_import_payroll_balances then
    return jsonb_build_object('canImport',false,'canManageAccess',false,'comparisonOnly',false,'canManageBalances',false);
  end if;
  return jsonb_build_object('canImport',policy.can_import_payroll_balances,'canManageAccess',false,
    'comparisonOnly',policy.payroll_comparison_only,'canManageBalances',policy.can_manage_leave_balances,
    'reminder',private.payroll_balance_monthly_reminder_projection(),
    'recentBatches',coalesce((select jsonb_agg(jsonb_build_object(
      'batchId',recent.id,'status',recent.batch_status,'files',recent.source_files,
      'rowCount',recent.row_count,'createdAt',recent.created_at,'committedAt',recent.committed_at
    ) order by recent.created_at desc,recent.id) from (
      select batch.* from private.payroll_balance_import_batches batch
      where batch.preview_person_id=p_person_id and batch.uploaded_by=(select auth.uid())
      order by batch.created_at desc,batch.id limit 6
    ) recent),'[]'::jsonb));
end;
$$;
revoke all on function public.get_payroll_balance_import_workspace_for_preview(uuid) from public,anon,authenticated,service_role;
grant execute on function public.get_payroll_balance_import_workspace_for_preview(uuid) to authenticated;

do $migration$
declare signature text; definition text; anchor constant text := 'private.is_system_portal_account_admin()';
begin
  foreach signature in array array[
    'public.create_subscription(text,text,text,text,integer,date,uuid,uuid[])',
    'public.update_subscription(uuid,bigint,text,text,text,text,text,integer,date,uuid,uuid[])',
    'public.mark_subscription_reviewed(uuid,bigint)'
  ] loop
    definition:=pg_get_functiondef(signature::regprocedure);
    if (length(definition)-length(replace(definition,anchor,'')))/length(anchor)<>1 then
      raise exception 'Legacy subscription authorization baseline differs: %',signature;
    end if;
    execute replace(definition,anchor,'public.can_manage_subscriptions()');
  end loop;
  foreach signature in array array['public.can_view_subscription_review_calendar()','public.list_subscription_review_calendar_entries()'] loop
    definition:=pg_get_functiondef(signature::regprocedure);
    if (length(definition)-length(replace(definition,anchor,'')))/length(anchor)<>1 then
      raise exception 'Subscription calendar authorization baseline differs: %',signature;
    end if;
    execute replace(definition,anchor,'private.is_operational_portal_admin()');
  end loop;
  foreach signature in array array['public.can_view_subscription_review_calendar_for_preview(uuid)','public.list_subscription_review_calendar_entries_for_preview(uuid)'] loop
    definition:=pg_get_functiondef(signature::regprocedure);
    if (length(definition)-length(replace(definition,'profile.app_role = ''system_admin''','')))/length('profile.app_role = ''system_admin''')<>1 then
      raise exception 'Subscription preview authorization baseline differs: %',signature;
    end if;
    definition:=replace(definition,'profile.app_role = ''system_admin''','profile.app_role in (''admin'',''system_admin'')');
    execute replace(definition,E'begin\n',E'begin\n  perform public.get_portal_role_capabilities(p_person_id);\n');
  end loop;
end;
$migration$;

do $migration$
declare definition text; source_header constant text := 'private.employee_work_schedule_workspace_json(p_person_id uuid, p_is_profile_preview boolean, p_review_person_id uuid, p_global_reviews boolean)';
begin
  definition:=pg_get_functiondef('private.employee_work_schedule_workspace_json(uuid,boolean,uuid,boolean)'::regprocedure);
  if strpos(definition,source_header)=0 or (length(definition)-length(replace(definition,'(select auth.uid())','')))/length('(select auth.uid())')<>1 then
    raise exception 'Work-schedule scope authorization baseline differs.';
  end if;
  definition:=replace(definition,source_header,'private.employee_work_schedule_workspace_json_for_actor(p_person_id uuid, p_is_profile_preview boolean, p_review_person_id uuid, p_global_reviews boolean, p_scope_user_id uuid)');
  execute replace(definition,'(select auth.uid())','p_scope_user_id');
end;
$migration$;
revoke all on function private.employee_work_schedule_workspace_json_for_actor(uuid,boolean,uuid,boolean,uuid) from public,anon,authenticated,service_role;

create or replace function public.get_my_employee_work_schedule_workspace()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare policy record;
begin
  select * into strict policy from public.get_portal_role_capabilities();
  return private.employee_work_schedule_workspace_json_for_actor(policy.person_id,false,
    case when policy.can_review_leave_workspace then policy.person_id else null end,
    policy.can_manage_employee_directory,(select auth.uid()));
end;
$$;

create or replace function public.get_selected_employee_work_schedule_workspace(p_person_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare policy record; target_user_id uuid;
begin
  if p_person_id is null then raise exception 'Choose an employee profile.' using errcode='22004'; end if;
  select * into strict policy from public.get_portal_role_capabilities(p_person_id);
  select person.auth_user_id into strict target_user_id from public.internal_org_people person where person.id=p_person_id;
  return private.employee_work_schedule_workspace_json_for_actor(policy.person_id,true,
    case when policy.can_review_leave_workspace then policy.person_id else null end,
    policy.can_manage_employee_directory,target_user_id);
end;
$$;

create or replace function public.get_selected_employee_profile_access_role_for_preview(p_person_id uuid)
returns text language plpgsql stable security definer set search_path = '' as $$
declare v_role text;
begin
  if p_person_id is null then raise exception 'Choose an employee profile.' using errcode='22004'; end if;
  select policy.app_role into strict v_role from public.get_portal_role_capabilities(p_person_id) policy;
  return v_role;
end;
$$;

grant execute on function private.has_current_portal_access() to authenticated;
alter policy leave_requests_select_authorized on public.leave_requests
  using ((select private.has_current_portal_access()) and (
    (select auth.uid())=user_id or private.can_review_leave_request(id)
    or ((select public.can_view_all_leave_requests()) and status in ('submitted','approved','rejected','changes_requested','cancelled'))
  ));

do $migration$
declare signature text; definition text;
begin
  foreach signature in array array[
    'public.can_import_payroll_balances_for_preview(uuid)',
    'public.list_employee_check_in_calendar_entries_for_preview(uuid)',
    'public.list_employee_check_in_workspace_for_preview(uuid)',
    'public.list_employee_it_assets_for_preview(uuid)',
    'public.list_employee_subscriptions_for_preview(uuid)',
    'public.list_staff_leave_calendar_entries_for_preview(uuid)'
  ] loop
    definition:=pg_get_functiondef(signature::regprocedure);
    if strpos(definition,E'begin\n')=0 or strpos(definition,'public.get_portal_role_capabilities(')>0 then
      raise exception 'Selected-target preview authorization baseline differs: %',signature;
    end if;
    execute replace(definition,E'begin\n',E'begin\n  if p_person_id is null then raise exception ''The selected employee is unavailable.'' using errcode=''23503''; end if;\n  perform public.get_portal_role_capabilities(p_person_id);\n');
  end loop;
  foreach signature in array array[
    'public.list_managed_employee_directory_records_for_preview(uuid)',
    'public.update_managed_employee_directory_record_for_preview(uuid,uuid,text,text,text,text,text,bigint,bigint)'
  ] loop
    definition:=pg_get_functiondef(signature::regprocedure);
    if strpos(definition,E'begin\n')=0 or strpos(definition,'public.get_portal_role_capabilities(')>0 then
      raise exception 'Selected-manager preview authorization baseline differs: %',signature;
    end if;
    execute replace(definition,E'begin\n',E'begin\n  if p_manager_person_id is null then raise exception ''The selected manager profile is unavailable.'' using errcode=''23503''; end if;\n  perform public.get_portal_role_capabilities(p_manager_person_id);\n');
  end loop;
  definition:=pg_get_functiondef('public.list_employee_team_directory(uuid)'::regprocedure);
  if strpos(definition,E'begin\n')=0 or strpos(definition,'public.get_portal_role_capabilities(')>0 then
    raise exception 'Selected-team preview authorization baseline differs.';
  end if;
  execute replace(definition,E'begin\n',E'begin\n  if p_preview_person_id is not null then perform public.get_portal_role_capabilities(p_preview_person_id); end if;\n');
end;
$migration$;

create function private.lock_subscription_role_authority(p_credentials boolean)
returns boolean language plpgsql volatile security definer set search_path = '' as $$
declare actor uuid := (select auth.uid());
begin
  if p_credentials is null or actor is null then return false; end if;
  if not (case when p_credentials then private.is_current_subscription_credential_manager()
    else public.can_manage_subscriptions() end) then return false; end if;
  perform pg_advisory_xact_lock_shared(hashtextextended('mam:directory-role-control',0));
  perform 1 from public.profiles profile where profile.id=actor for share;
  return case when p_credentials then private.is_current_subscription_credential_manager()
    else public.can_manage_subscriptions() end;
end;
$$;
revoke all on function private.lock_subscription_role_authority(boolean) from public,anon,authenticated,service_role;

do $migration$
declare item record; definition text; anchor text;
begin
  for item in select * from (values
    ('public.create_subscription(text,text,text,text,integer,date,uuid,uuid[])',false),
    ('public.create_subscription_v2(text,text,text,text,integer,date,integer,boolean,date,uuid,uuid[])',false),
    ('public.create_subscription_v3(text,text,text,text,integer,date,integer,boolean,text,date,uuid,uuid[])',false),
    ('public.create_subscription_v4(text,text,text,text,integer,date,integer,boolean,text,date,uuid,text,uuid[])',false),
    ('public.update_subscription(uuid,bigint,text,text,text,text,text,integer,date,uuid,uuid[])',false),
    ('public.update_subscription_v2(uuid,bigint,text,text,text,text,text,integer,date,integer,boolean,date,uuid,uuid[])',false),
    ('public.update_subscription_v3(uuid,bigint,text,text,text,text,text,integer,date,integer,boolean,text,date,uuid,uuid[])',false),
    ('public.update_subscription_v4(uuid,bigint,text,text,text,text,text,integer,date,integer,boolean,text,date,uuid,text,uuid[])',false),
    ('public.mark_subscription_reviewed(uuid,bigint)',false),
    ('public.mark_subscription_reviewed_v2(uuid,bigint)',false),
    ('public.patch_subscription_v1(uuid,bigint,jsonb)',false),
    ('private.set_subscription_company(uuid,text)',false),
    ('public.get_subscription_credential(uuid)',true),
    ('public.save_subscription_credential(uuid,bigint,text,text,text,integer)',true),
    ('public.remove_subscription_credential(uuid,bigint)',true)
  ) reviewed(signature,credentials) loop
    definition:=pg_get_functiondef(item.signature::regprocedure);
    anchor:=case when item.credentials then 'private.is_current_subscription_credential_manager()'
      else 'public.can_manage_subscriptions()' end;
    if (length(definition)-length(replace(definition,anchor,'')))/length(anchor)<>1 then
      raise exception 'Subscription consumer authorization baseline differs: %',item.signature;
    end if;
    execute replace(definition,anchor,'private.lock_subscription_role_authority('||item.credentials::text||')');
  end loop;
end;
$migration$;

create or replace function public.can_manage_payroll_balance_import_grants()
returns boolean language sql stable security definer set search_path = '' as $$ select false; $$;

create or replace function public.replace_payroll_balance_import_grants(p_person_ids uuid[])
returns void language plpgsql volatile security definer set search_path = '' as $$
begin
  raise exception 'Payroll import access is controlled by application roles.' using errcode='42501';
end;
$$;

create function private.lock_portal_role_actor()
returns boolean language plpgsql volatile security definer set search_path = '' as $$
declare actor uuid := (select auth.uid());
begin
  if actor is null or not exists(select 1 from private.portal_role_policy()) then return false; end if;
  perform pg_advisory_xact_lock(hashtextextended('mam:directory-role-control',0));
  perform 1 from public.profiles profile where profile.id=actor for share;
  return exists(select 1 from private.portal_role_policy());
end;
$$;
revoke all on function private.lock_portal_role_actor() from public,anon,authenticated,service_role;

create or replace function private.is_portal_account_admin()
returns boolean language plpgsql volatile security definer set search_path = '' as $$
begin
  if not private.is_operational_portal_admin() then return false; end if;
  if not private.lock_portal_role_actor() then return false; end if;
  return private.is_operational_portal_admin();
end;
$$;

do $migration$
declare item record; definition text;
begin
  for item in select * from (values
    ('public.can_access_non_roster_system_admin_workspace()','0f030ab9e26a89475237e7861c8eff7d412251235775181bbf7fc4f3a7a0ca1e',1),
    ('public.inspect_portal_account_status_change(uuid,uuid)','ec8d939eca698bc2ded7854d37251f083eee7742a17d8e26319fccb5f4d23e32',1),
    ('public.inspect_portal_account_status_request(uuid,uuid,boolean,bigint)','872e5ca15f7d754eef65932011882f4248544ee766533ee01cc66a736f81613e',1),
    ('public.list_portal_account_summaries()','465e0af89775be520784038a98fda4fea2ca20b8d902de20c45564cb3b04a390',1),
    ('private.can_add_my_leave_request_attachment(uuid)','6161b9b7ad066cdf0cc805d13c316ac14ee691c07e2f6b23130ecef0c1e8bcd7',2)
  ) reviewed(signature,sha256,occurrences) loop
    definition:=pg_get_functiondef(item.signature::regprocedure);
    if encode(extensions.digest(definition,'sha256'),'hex')<>item.sha256
      or (length(definition)-length(replace(definition,'private.is_portal_account_admin()','')))/length('private.is_portal_account_admin()')<>item.occurrences then
      raise exception 'Account authorization read baseline differs: %',item.signature;
    end if;
    execute replace(definition,'private.is_portal_account_admin()','private.is_operational_portal_admin()');
  end loop;
end;
$migration$;

do $migration$
declare item record; definition text; declaration text;
begin
  for item in select * from (values
    ('public.approve_employee_check_in_employment_decision(uuid,bigint)','3fd96e798b4744249ec09e5b688a17f42f607d46c889ab68f5241ed97fa3ec21'),
    ('public.archive_employee_directory_record(uuid,bigint,bigint,date,text)','9e07fe800745add49b3e3c93d3b1d81a3bfb848f33c0833fb1f119b1eaecc50f'),
    ('public.begin_portal_account_status_change(uuid,uuid,boolean,bigint)','7d2876cfb4752e52ce519a68229055f38f51975f5f9a941ae7dd058a90673cd8'),
    ('public.cancel_my_approved_leave_request(uuid)','7459865abfba96a6e78c77d7290881a7b00e8780d534831928f055edfa0ec751'),
    ('public.cancel_portal_account_status_change(uuid,uuid)','145fffba4bedf8776113bfc996510c72b80e124cd7c346d564687e9d27ce2fb6'),
    ('public.commit_payroll_balance_import(uuid,bigint)','df614f470792066522120f5ea1cae96ffcabbad98f78ad1ff1d75f8e638c12ff'),
    ('public.commit_payroll_balance_import_before_comparison(uuid,bigint)','ec64dfa0af3e20e546689a9e06ecc165a52a41784d4f43fa206b1c49b8fd3f65'),
    ('public.complete_employee_check_in_reminder(uuid)','a64e546e5cd6d78f6b02ec0c9d5988fdeb660cd05fd42310c6292fd6e3fddd48'),
    ('public.complete_my_employee_check_in_task(uuid)','2485128dfaa635a4eb4e19dd0de3a6f6236d4a56827cc72d31d3f236685d6784'),
    ('public.complete_my_leave_request_attachment_upload(text)','4e4455186f732afb7a1e502682866eab8b2eef61ab76006c05443667a26deca4'),
    ('public.complete_visible_employee_check_in_reminder(uuid)','11b4bd3bf091d6297e9cd28123d9d90c78b4622b199cdd805f042a8e6e883dbe'),
    ('public.create_employee_directory_record(text,text,text,text,text,text,text,uuid,text,date,date,date,text,boolean,text,text,text,text,text[],integer)','3fbf519a1eda98f2f69b676289b4b0c6ab160b499c3502aad6c1c1cf76ac888c'),
    ('public.create_employee_directory_record_with_address(text,text,text,text,text,text,text,uuid,text,date,date,date,text,boolean,text,text,text,text,text[],text,integer)','77e7ec1595c63563ae6d6e03905719180c3d41618fe474a1c2aa051b7f47d44a'),
    ('public.create_employee_directory_record_with_employment_type(text,text,text,text,text,text,text,uuid,text,date,date,date,text,boolean,text,text,text,text,text[],text,text,integer)','0015c52b8005c1b4a1ccace9c1ee74ee6c8e57980e924759e1b1d2892356aaf7'),
    ('public.create_employee_directory_record_with_work_schedule(text,text,text,text,text,text,text,uuid,text,date,date,date,text,boolean,text,text,text,text,text[],text,text,smallint[],integer)','c65a3831f35ad748282fba5ad2a9a8ef6d4755284fc424c52dc160080d40c04c'),
    ('public.create_employee_directory_record_with_work_schedule_times(text,text,text,text,text,text,text,uuid,text,date,date,date,text,boolean,text,text,text,text,text[],text,text,smallint[],jsonb,integer)','412c5aa3d0d2ce395c48aa6153cc219fa13123f25c625f594b3b704f5e8d93f6'),
    ('public.create_internal_org_node(text,text,text,text,uuid,date,integer)','bbad281100f537294af716a4ad1ec04ed8d453b7c20ece706a92a78870dd01c1'),
    ('public.create_it_asset(text,uuid,text,text,text)','afb9e984d19133f0b845bbee584e04f47b287a05e7b4a421c3a9e8a1fcf0a6eb'),
    ('public.create_portal_account(uuid,uuid,text,text,bigint)','214983d28291f057debda97971dad90eeec67bc2557186f319cd4ac5909d0901'),
    ('public.decide_employee_work_schedule_change_request(uuid,text,text)','d8f64bb4e562c088d7a9e093d68a9b2452194877f346a320b2f0e875bfeed797'),
    ('public.decide_leave_with_balance(uuid,text,text)','d8de791bb59d7511ed7fc7a822c52a7b5c9323f37785bb165708a9d34d9639af'),
    ('public.decide_my_managed_leave_request(uuid,text,text)','05a887294ffea5a5134081588440cd3e487ef58d5aac8cf53c34fc96ca71dfa1'),
    ('public.delete_employee_directory_record(uuid,bigint)','118aaae7953efba7c0764a1c5db7f83b0bd569e33caacb7f2115c24105f85cad'),
    ('public.discard_my_leave_request_attachment_upload(text)','1ff6fba3983223a832aaea51facc12310520059b656776fc6a2a07f914f1d2de'),
    ('public.enrol_employee_check_in_reminders(uuid)','85bb46f295a3f2517a1001efd6d0e1b89d4f81cf045b4b1ccbd09a76d896a112'),
    ('public.finalise_portal_account_status_change(uuid,uuid,uuid)','025cb4f552865d54cb9e383c4da74240ef0be06f174e9bb18d1d2ea417d44616'),
    ('public.prepare_my_leave_request_attachment_upload(uuid,text,text,bigint)','c9872e939113bcc450badb12ae595c24f0a1761f0fff4f96d235a0a6e65ce099'),
    ('public.queue_employee_check_in_catch_up(uuid)','b6e6d82384410b0ef1c483146ae571c5d185dc19256763167fe62435c541ab18'),
    ('public.reassign_it_asset(uuid,uuid,bigint)','18f0774d66f89ef0654d8289ec268e5e2c9e29164f86c4d185880f374f34298f'),
    ('public.record_employee_check_in_review(uuid,text,date,text,bigint)','844678cc79a8d991e1e8d2c07b78cc01107720af0e44ba2eb33a7ec6679ca018'),
    ('public.retire_it_asset(uuid,bigint)','a744b8d05b2fc7d5113229d7e8798d41a41fd84a87f39e56b4b7b8a77dfbe6eb'),
    ('public.return_it_asset(uuid,bigint,date)','06b339170934f1d04507f3d83291a068e82bd8f2ae505cd9e2d83a3928406399'),
    ('public.review_employee_leave_accrual_day(uuid,date,numeric,numeric,numeric,numeric,text)','1e8b79b9f053c03f0a42738dba4f038dda23b8a0e3005603598c906fa0f21938'),
    ('public.schedule_employee_offboarding(uuid,bigint,bigint,date,text)','5d86a974500ae866d4f63b804a58b765610df2ccb7167a67183a66846dedfe39'),
    ('public.set_employee_annual_leave_balance(uuid,numeric,date,boolean)','ed5bf688b730a8e2bd26739a96339ad2755d832e0326e0f766fc3f9662c452cc'),
    ('public.set_employee_check_in_contract_classification(uuid,text)','cd3d503a7e360dc8b41fecf1288d8f4022fe62b42a78da12fa3ad11c7750b34a'),
    ('public.set_employee_leave_accrual_policy(uuid,numeric,numeric,numeric,boolean,boolean,text)','2e06d796ac4ed89544e9abbfca0b92e73fd2c66352625d4a6492eea6de4b3d05'),
    ('public.set_employee_sick_leave_balance(uuid,numeric,date)','b53fcd88a011033b9665dade12adb759535b320f5dc675007e1db6888f9e95bc'),
    ('public.set_leave_balance_required_hours(uuid,numeric)','a094dabac3961cec8cef43082266aebd3e57c0dcf1bd7319da37f2ae277e12c6'),
    ('public.set_portal_account_enabled(uuid,uuid,boolean,bigint)','702c708c670d94107690e3e694aaf9af85bbb3e37410e79a4773752fe5e9bd0a'),
    ('public.submit_leave_request_once(uuid,uuid,text,date,date,time without time zone,time without time zone,text)','0baefdc95925debca85120368bc9724f645af1195bc023cb426ee5c497a109ca'),
    ('public.submit_selected_employee_leave_request(uuid,text,date,date,time without time zone,time without time zone,text)','66f198473482c3a3ba3ea8d6091d3929f47bb21ada4e5c839c6884282cf6f84c'),
    ('public.update_employee_directory_address(uuid,text,bigint)','318bacb16e22da5287cc5c9a6962edbd081612cf9d50cba468aa6ce455173695'),
    ('public.update_employee_directory_record(uuid,text,text,text,text,text,text,text,uuid,text,date,date,date,text,boolean,bigint,bigint,text,text,text,text,text[],integer)','5c5acf5ab3c264d186334e7fe88d4038d7e755ae43e687cbc5592a872aa0c6aa'),
    ('public.update_employee_directory_record_with_address(uuid,text,text,text,text,text,text,text,uuid,text,date,date,date,text,boolean,bigint,bigint,text,text,text,text,text[],text,integer)','facffa86f44b9a0a0b3941eb9f8cdbba49c13a4369c9a86a09a777935064744b'),
    ('public.update_employee_directory_record_with_employment_type(uuid,text,text,text,text,text,text,text,uuid,text,date,date,date,text,boolean,bigint,bigint,text,text,text,text,text[],text,text,integer)','e9ae625e6396517b0890317630886e58cccd96fe4ec7162a179e320e64559ece'),
    ('public.update_employee_directory_record_with_work_schedule(uuid,text,text,text,text,text,text,text,uuid,text,date,date,date,text,boolean,bigint,bigint,text,text,text,text,text[],text,text,smallint[],integer)','f1c2566e294202752ef2a68843caa10d24d6d5bb0f2af5ac0c706f8141b9eb89'),
    ('public.update_employee_directory_record_with_work_schedule_times(uuid,text,text,text,text,text,text,text,uuid,text,date,date,date,text,boolean,bigint,bigint,text,text,text,text,text[],text,text,smallint[],jsonb,integer)','c0c2b45aef75a94e87546ddfc0bdfec4288df66b172b9d0f6a317882bb78737a'),
    ('public.update_internal_org_node(uuid,text,text,text,text,uuid,date,integer,boolean,bigint)','d98b2f8f3fb75a98fd9c80879c49be912f514b3fea624f9dd38e828bc4700323'),
    ('public.update_managed_employee_directory_record(uuid,text,text,text,text,text,bigint,bigint)','ed1e3a5c47b86c347c1b9fd69ae626214e396009a3f334135d181ba92c99226f'),
    ('public.update_managed_employee_directory_record_for_preview(uuid,uuid,text,text,text,text,text,bigint,bigint)','5f04f454c3dd7402a03d691375707e23817c89992d226094fd4778d503da2df3'),
    ('public.update_selected_employee_profile_for_hr(uuid,text,text,date,bigint)','fe2867e321f406c24e06728f4977b758b686bcdd7110230015aed76cc1133711')
  ) reviewed(signature,sha256) loop
    definition:=pg_get_functiondef(item.signature::regprocedure);
    if encode(extensions.digest(definition,'sha256'),'hex')<>item.sha256 then
      raise exception 'Operational mutation authorization baseline differs: %',item.signature;
    end if;
    declaration:=E'declare\n  v_unified_role_fence boolean := private.lock_portal_role_actor();';
    if position(E'AS $function$\ndeclare' in definition)>0 then
      definition:=replace(definition,E'AS $function$\ndeclare',E'AS $function$\n'||declaration);
    elsif position(E'AS $function$\nbegin' in definition)>0 then
      definition:=replace(definition,E'AS $function$\nbegin',E'AS $function$\n'||declaration||E'\nbegin');
    else
      raise exception 'Operational mutation declaration baseline differs: %',item.signature;
    end if;
    execute definition;
  end loop;
end;
$migration$;

-- Approved data step precedes the unchanged daily-operation P0 guard.
create temp table pg_temp.unified_role_release_receipt(expected jsonb,role_changed_at timestamptz) on commit drop;
do $$
declare plan jsonb; item jsonb; changed bigint; event private.employee_directory_audit_events%rowtype;
  applied_at timestamptz:=clock_timestamp(); receipt jsonb;
begin
  select r.plan into strict plan from pg_temp.unified_role_release_plan r;
  for item in select value from jsonb_array_elements(plan->'targets') loop
    update public.profiles set app_role=item->>'after_role',updated_at=applied_at
      where id=(item->>'user_id')::uuid and app_role=item->>'before_role' and account_status='active';
    get diagnostics changed=row_count;
    if changed<>1 then raise exception 'MAM_ROLE_COMPARE_AND_SET_FAILED' using errcode='55000'; end if;
    insert into private.employee_directory_audit_events(person_id,actor_user_id,event_type,changed_fields)
      values((item->>'person_id')::uuid,null,'updated',array['app_role']) returning * into event;
    insert into pg_temp.unified_role_release_audit values(event.id,to_jsonb(event));
  end loop;
  receipt:=jsonb_build_object('actor_kind','release_migration','actor','20261006104000_unified_portal_roles',
    'database_actor',current_user,'reason','user-approved release migration 2026-10-06',
    'approval','COORD-20261006-ROLES-CONVERSION-IN-RELEASE-MIGRATION-1',
    'plan_sha256',encode(extensions.digest(plan::text,'sha256'),'hex'),
    'target_count',6,'admin_count',4,'account_count',2,'role_changed_at',applied_at,
    'directory_audit_ids',(select jsonb_agg(a.id order by a.id) from pg_temp.unified_role_release_audit a));
  insert into supabase_migrations.schema_migrations(version,name,statements)
    values('20261006103000','mam_six_canonical_role_assignments',array[receipt::text]);
  insert into pg_temp.unified_role_release_receipt values(receipt,applied_at);
end $$;
create function pg_temp.unified_role_assert_release_data() returns void
language plpgsql set search_path='' as $$
declare plan jsonb; item jsonb; actual_profile jsonb; actual_auth jsonb;
  original pg_temp.unified_role_release_before%rowtype;
  receipt pg_temp.unified_role_release_receipt%rowtype;
begin
  select r.plan into strict plan from pg_temp.unified_role_release_plan r;
  select * into strict receipt from pg_temp.unified_role_release_receipt;
  if (select count(*) from pg_temp.unified_role_release_before)<>6 then
    raise exception 'MAM_ROLE_RELEASE_SCOPE_MISMATCH' using errcode='55000';
  end if;
  for item in select value from jsonb_array_elements(plan->'targets') loop
    select * into strict original from pg_temp.unified_role_release_before b where b.user_id=(item->>'user_id')::uuid;
    select to_jsonb(p) into strict actual_profile from public.profiles p where p.id=original.user_id;
    select to_jsonb(u) into strict actual_auth from auth.users u where u.id=original.user_id;
    if actual_profile->>'app_role' is distinct from item->>'after_role'
      or (actual_profile->>'updated_at')::timestamptz is distinct from receipt.role_changed_at
      or (actual_profile-array['app_role','updated_at']) is distinct from (original.profile_before-array['app_role','updated_at'])
      or (actual_auth-array['raw_app_meta_data','updated_at']) is distinct from (original.auth_before-array['raw_app_meta_data','updated_at'])
      or actual_auth->'raw_app_meta_data'->>'org_role' is distinct from item->>'after_role'
      or (coalesce(actual_auth->'raw_app_meta_data','{}'::jsonb)-'org_role')
        is distinct from (coalesce(original.auth_before->'raw_app_meta_data','{}'::jsonb)-'org_role')
      or ((actual_auth->>'updated_at')::timestamptz is distinct from (original.auth_before->>'updated_at')::timestamptz
          and not coalesce((actual_auth->>'updated_at')::timestamptz between receipt.role_changed_at and clock_timestamp(),false)) then
      raise exception 'MAM_ROLE_RELEASE_UNAPPROVED_ACCOUNT_DELTA' using errcode='55000';
    end if;
  end loop;
  if (select count(*) from pg_temp.unified_role_release_audit)<>6
    or exists(select 1 from pg_temp.unified_role_release_audit a
      left join private.employee_directory_audit_events e on e.id=a.id where to_jsonb(e) is distinct from a.expected)
    or not exists(select 1 from supabase_migrations.schema_migrations m
      where m.version='20261006103000' and m.name='mam_six_canonical_role_assignments'
        and m.statements=array[receipt.expected::text]) then
    raise exception 'MAM_ROLE_RELEASE_AUDIT_OR_MARKER_MISMATCH' using errcode='55000';
  end if;
end $$;

create function private.guard_system_admin_account_target()
returns trigger language plpgsql volatile security definer set search_path = '' as $$
declare targets uuid[]; actor uuid := (select auth.uid()); delegated_actor uuid; protected_profile boolean := false;
begin
  if tg_table_schema='public' and tg_table_name='profiles' then
    if old.app_role is distinct from 'system_admin' and (tg_op='DELETE' or new.app_role is distinct from 'system_admin') then
      return case when tg_op='DELETE' then old else new end;
    end if;
    targets:=array[old.id];
    protected_profile:=true;
  elsif tg_table_schema='public' and tg_table_name='internal_org_people' then
    targets:=array[old.auth_user_id,case when tg_op='DELETE' then null else new.auth_user_id end];
  else
    targets:=array[case when tg_op='INSERT' then null else old.auth_user_id end,
      case when tg_op='DELETE' then null else new.auth_user_id end];
  end if;
  if not protected_profile and not exists(select 1 from public.profiles p where p.id=any(targets) and p.app_role='system_admin') then
    return case when tg_op='DELETE' then old else new end;
  end if;
  if tg_table_schema='private' and tg_table_name='portal_account_status_change_claims'
    and tg_op='UPDATE' and actor is null and (select auth.role())='service_role'
    and (to_jsonb(new)-array['provider_status','executor_token','provider_started_at','provider_finished_at'])
      is not distinct from (to_jsonb(old)-array['provider_status','executor_token','provider_started_at','provider_finished_at'])
    and to_jsonb(old)->>'status'='pending' then
    delegated_actor:=old.claimed_by;
  else
    if not private.is_system_portal_account_admin() then
      raise exception 'System Admin account access denied.' using errcode='42501';
    end if;
    delegated_actor:=actor;
  end if;
  if not pg_try_advisory_xact_lock(hashtextextended('mam:directory-role-control',0)) then
    raise exception 'System Admin account access denied.' using errcode='42501';
  end if;
  perform 1 from public.profiles p where p.id=delegated_actor for share nowait;
  if not coalesce((select policy.is_super_admin from private.portal_role_policy(delegated_actor) policy),false) then
    raise exception 'System Admin account access denied.' using errcode='42501';
  end if;
  return case when tg_op='DELETE' then old else new end;
exception when lock_not_available then
  raise exception 'System Admin account access denied.' using errcode='42501';
end;
$$;
revoke all on function private.guard_system_admin_account_target() from public,anon,authenticated,service_role;
create trigger aa_system_admin_account_target before update or delete on public.profiles
  for each row execute function private.guard_system_admin_account_target();
create trigger aa_system_admin_account_target before update or delete on public.internal_org_people
  for each row execute function private.guard_system_admin_account_target();
create trigger aa_system_admin_account_target before insert or update or delete on private.portal_password_reset_claims
  for each row execute function private.guard_system_admin_account_target();
create trigger aa_system_admin_account_target before insert or update or delete on private.portal_account_status_change_claims
  for each row execute function private.guard_system_admin_account_target();

do $migration$
declare definition text; anchor text;
begin
  definition:=pg_get_functiondef('public.set_portal_account_admin(uuid,boolean)'::regprocedure);
  anchor:=E'begin\n';
  if (length(definition)-length(replace(definition,anchor,'')))/length(anchor)<>1 then
    raise exception 'Legacy administrator setter baseline differs.' using errcode='55000';
  end if;
  execute replace(definition,anchor,anchor||E'  if not private.is_system_portal_account_admin() or not private.lock_portal_role_actor() then\n    raise exception \'Only System Admin may change administrator access.\' using errcode=\'42501\';\n  end if;\n  if exists(select 1 from public.profiles p where p.id=p_auth_user_id and p.app_role=\'system_admin\') then\n    raise exception \'System Admin accounts cannot be changed through ordinary role management.\' using errcode=\'42501\';\n  end if;\n');
end;
$migration$;

set constraints all immediate;

do $$ begin
  if exists(
    (select c.kind,c.object_identity,encode(extensions.digest(c.definition,'sha256'),'hex') from pg_temp.unified_role_transition_catalog() c
      except all select e.kind,e.object_identity,e.sha256 from pg_temp.unified_role_catalog_expected e)
    union all
    (select e.kind,e.object_identity,e.sha256 from pg_temp.unified_role_catalog_expected e
      except all select c.kind,c.object_identity,encode(extensions.digest(c.definition,'sha256'),'hex') from pg_temp.unified_role_transition_catalog() c)
  ) then
    raise exception 'Unified role migration contains metadata outside the exact enumerated role delta.' using errcode='55000';
  end if;
  if pg_temp.unified_role_identity_state() is distinct from (select sha256 from pg_temp.unified_role_identity_before) then
    raise exception 'Unified role migration must preserve complete Auth and account identity state.' using errcode='55000';
  end if;
  if (select encode(extensions.digest(coalesce(jsonb_agg(to_jsonb(r) order by r.id),'[]'::jsonb)::text,'sha256'),'hex')
    from private.confirmed_test_identity_purges r) is distinct from (select sha256 from pg_temp.unified_role_receipts_before) then
    raise exception 'Unified role migration must preserve the complete purge receipts.' using errcode='55000';
  end if;
end $$;

update private.confirmed_test_purge_schema set schema_hash=private.confirmed_test_purge_schema_hash() where singleton;

set constraints all immediate;

do $$ begin
  if exists(
    (select c.kind,c.object_identity,encode(extensions.digest(c.definition,'sha256'),'hex') from pg_temp.unified_role_transition_catalog() c
      except all select e.kind,e.object_identity,e.sha256 from pg_temp.unified_role_catalog_expected e)
    union all
    (select e.kind,e.object_identity,e.sha256 from pg_temp.unified_role_catalog_expected e
      except all select c.kind,c.object_identity,encode(extensions.digest(c.definition,'sha256'),'hex') from pg_temp.unified_role_transition_catalog() c)
  ) then
    raise exception 'Unified role migration contains metadata outside the exact enumerated role delta.' using errcode='55000';
  end if;
  if pg_temp.unified_role_identity_state() is distinct from (select sha256 from pg_temp.unified_role_identity_before) then
    raise exception 'Unified role migration must preserve complete Auth and account identity state.' using errcode='55000';
  end if;
  if (select encode(extensions.digest(coalesce(jsonb_agg(to_jsonb(r) order by r.id),'[]'::jsonb)::text,'sha256'),'hex')
    from private.confirmed_test_identity_purges r) is distinct from (select sha256 from pg_temp.unified_role_receipts_before) then
    raise exception 'Unified role migration must preserve the complete purge receipts.' using errcode='55000';
  end if;
end $$;
do $$ begin
  perform pg_temp.unified_role_assert_release_data();
  if private.confirmed_test_purge_schema_hash() is distinct from (select schema_hash from private.confirmed_test_purge_schema) then
    raise exception 'Unified role migration reviewed purge fingerprint changed after transition.' using errcode='55000';
  end if;
end $$;
drop function pg_temp.unified_role_transition_catalog();
drop function pg_temp.unified_role_identity_state();
drop function pg_temp.unified_role_assert_release_data();


commit;
