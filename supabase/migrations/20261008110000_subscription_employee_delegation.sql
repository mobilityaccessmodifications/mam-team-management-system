begin;
set local search_path='';

select pg_advisory_xact_lock(hashtextextended('mam:directory-role-control',0));
lock table private.subscription_management_grants,private.subscription_credential_access_grants,
  private.subscription_management_grant_events,private.subscription_credential_access_audit_events,
  private.confirmed_test_identity_purges,private.confirmed_test_purge_schema in share row exclusive mode nowait;

do $$ begin
  if encode(extensions.digest(pg_get_functiondef('private.confirmed_test_purge_schema_hash()'::regprocedure),'sha256'),'hex')
    is distinct from '3385d5a0140df3995e3196ffea442b4829f9a5357de3ccf5a8d521fbe9011a54'
    or private.confirmed_test_purge_schema_hash() is distinct from
      (select schema_hash from private.confirmed_test_purge_schema where singleton) then
    raise exception 'Subscription delegation requires the reviewed predecessor catalog.' using errcode='55000';
  end if;
  if exists(select 1 from pg_attribute where attrelid in
    ('private.subscription_management_grants'::regclass,'private.subscription_credential_access_grants'::regclass)
    and attname='employee_delegation_confirmed' and not attisdropped) then
    raise exception 'Subscription employee confirmation column already exists.' using errcode='55000';
  end if;
end $$;

create temporary table subscription_employee_functions(signature text primary key,sha256 text,after_sha256 text) on commit drop;
insert into subscription_employee_functions values
  ('public.list_subscription_credential_access_grants()','36c51de8a22b020a57806d6e379e3b41cdb5bf093bfe5325975b8459c1c2240b','3c3edd39a7b9a713a17d6b5d1303c8f002f504cecda0a2a851ab5cf8c88a6532'),
  ('public.list_subscription_credential_grant_candidates()','46d1bb38b78ea7dcd0164e320f89d13d96ab12e6fdd6fc45f8ebb48dacb6de5c','695b84ff8af9a5cd707b20439993430c7b66cb40d4ba2a8386178ec57021818f'),
  ('public.replace_subscription_credential_access_grants(uuid[])','6f5f6f3743c043ae9943991b69969d66f52ac4ba9b763bae113ca12b3e0c11ef','7fb15c7fe05c8605401eaabf9bf2d3f27219784b445e82928e7ceb4509d83491'),
  ('private.portal_role_policy(uuid)','8f6bba78aefb558d8bce5ee3e91a4c6f7aeabd0fecd01495b54ee03389ae2b54','bc7ac471475356cfd84169d13d0f7c12d64f118ad18a728e7725958542b9448c'),
  ('private.validate_subscription_role_delegates(uuid[])','d7fa828df293f3bfec247e78ead54de571c52a22219e546c20f20ba55b566793','a87ece9df6873bb0aaec6501ec2351974a40f2a7e4a5e8a3f03e77949cb3f60b'),
  ('public.list_subscription_management_delegates()','4ac41c44e0be2f24d45855c6889e603f8ea1600e483a1568c145a363446117fa','10284bed3fda3f8ed6e765c76d1864296d93923fe4274cb123b5ad3878517e51'),
  ('public.replace_subscription_management_delegates(uuid[])','b49eca182c99434129ce6f9cc636f40b76ac2d3fc2cfec1a59559fdc8727c271','c5863c4066a24caba6f3acf31ba0a4f82002ed47c69750283f0d29115f197e3b');
do $$ declare item record; begin
  for item in select * from subscription_employee_functions loop
    if encode(extensions.digest(pg_get_functiondef(to_regprocedure(item.signature)),'sha256'),'hex')
      is distinct from item.sha256 then
      raise exception 'Subscription delegation predecessor definition differs: %',item.signature using errcode='55000';
    end if;
  end loop;
end $$;
create temporary table subscription_employee_function_before on commit drop as
select a.signature,pg_get_functiondef(p.oid) definition,
  (to_jsonb(p)-array['prosrc','prosqlbody','proargdefaults'])
    ||jsonb_build_object('parameter_defaults',pg_get_expr(p.proargdefaults,0)) metadata
from subscription_employee_functions a join pg_proc p on p.oid=to_regprocedure(a.signature);

do $$ declare query text; anchor text; begin
  select prosrc into query from pg_proc where oid='private.confirmed_test_purge_schema_hash()'::regprocedure;
  anchor:=E'select encode(extensions.digest(coalesce(string_agg(definition,E''\\n'' order by definition),''''),''sha256''),''hex'') from (';
  if (length(query)-length(replace(query,anchor,'')))/length(anchor)<>1 then
    raise exception 'Subscription delegation catalog collector differs.' using errcode='55000';
  end if;
  execute 'create function pg_temp.subscription_employee_catalog() returns table(definition text) language sql stable set search_path='''' as '
    ||quote_literal(replace(query,anchor,'select definition from ('));
end $$;
create temporary table subscription_employee_catalog_before on commit drop as select * from pg_temp.subscription_employee_catalog();

create function pg_temp.subscription_employee_security() returns jsonb language sql stable set search_path='' as $$
select jsonb_build_object(
  'schemas',(select jsonb_agg(to_jsonb(n) order by n.oid) from pg_namespace n where n.nspname !~ '^pg_temp_' and n.nspname !~ '^pg_toast_temp_'),
  'default_acls',(select jsonb_agg(to_jsonb(d) order by d.oid) from pg_default_acl d),
  'column_defaults',(select jsonb_agg(to_jsonb(d) order by d.oid) from pg_attrdef d
    join pg_attribute a on a.attrelid=d.adrelid and a.attnum=d.adnum
    where not (a.attrelid in ('private.subscription_management_grants'::regclass,'private.subscription_credential_access_grants'::regclass)
      and a.attname='employee_delegation_confirmed')),
  'types',(select jsonb_agg(to_jsonb(t) order by t.oid) from pg_type t
    join pg_namespace n on n.oid=t.typnamespace where n.nspname !~ '^pg_temp_' and n.nspname !~ '^pg_toast_temp_'),
  'enums',(select jsonb_agg(to_jsonb(e) order by e.oid) from pg_enum e),
  'rewrites',(select jsonb_agg(to_jsonb(w) order by w.oid) from pg_rewrite w),
  'roles',(select jsonb_agg(to_jsonb(r) order by r.oid) from pg_roles r),
  'columns',(select jsonb_agg(to_jsonb(a) order by a.attrelid,a.attnum) from pg_attribute a
    join pg_class c on c.oid=a.attrelid join pg_namespace n on n.oid=c.relnamespace
    where n.nspname in ('public','private','auth','storage') and not a.attisdropped and a.attnum>0
      and not (a.attrelid in ('private.subscription_management_grants'::regclass,'private.subscription_credential_access_grants'::regclass)
        and a.attname='employee_delegation_confirmed')),
  'relations',(select jsonb_agg(jsonb_build_object('oid',c.oid,'owner',c.relowner,'acl',c.relacl,
    'rls',c.relrowsecurity,'force_rls',c.relforcerowsecurity,'options',c.reloptions) order by c.oid)
    from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname in ('public','private','auth','storage'))
);
$$;
create temporary table subscription_employee_security_before on commit drop as select pg_temp.subscription_employee_security() value;
create function pg_temp.subscription_employee_data() returns jsonb language sql stable set search_path='' as $$
select jsonb_build_object(
  'management',(select jsonb_agg(to_jsonb(g)-'employee_delegation_confirmed' order by g.person_id) from private.subscription_management_grants g),
  'vault',(select jsonb_agg(to_jsonb(g)-'employee_delegation_confirmed' order by g.auth_user_id) from private.subscription_credential_access_grants g),
  'management_audit',(select jsonb_agg(to_jsonb(g) order by g.id) from private.subscription_management_grant_events g),
  'vault_audit',(select jsonb_agg(to_jsonb(g) order by g.id) from private.subscription_credential_access_audit_events g),
  'purge_receipts',(select jsonb_agg(to_jsonb(g) order by g.id) from private.confirmed_test_identity_purges g)
);
$$;
create temporary table subscription_employee_data_before on commit drop as select pg_temp.subscription_employee_data() value;

alter table private.subscription_management_grants add column employee_delegation_confirmed boolean not null default false;
alter table private.subscription_credential_access_grants add column employee_delegation_confirmed boolean not null default false;

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
    and profile.app_role in ('manager','employee')
  cross join lateral private.portal_role_policy(profile.id) policy
  where policy.person_id=person.id
    and (profile.app_role='manager' or access_grant.employee_delegation_confirmed)
  order by lower(person.full_name), person.id;
end;
$function$;

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
    and profile.app_role in ('manager','employee')
  cross join lateral private.portal_role_policy(profile.id) policy
  where person.node_kind = 'person'
    and person.is_active
    and policy.person_id=person.id
  order by lower(person.full_name), person.id;
end;
$function$;

CREATE OR REPLACE FUNCTION public.replace_subscription_credential_access_grants(p_person_ids uuid[])
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare requested uuid[];
begin
  requested:=private.validate_subscription_role_delegates(p_person_ids);
  perform pg_advisory_xact_lock(hashtextextended('mam:subscription-credential-access-grants',0));
  delete from private.subscription_credential_access_grants access_grant where not access_grant.person_id=any(requested);
  insert into private.subscription_credential_access_grants(auth_user_id,person_id,granted_by,employee_delegation_confirmed)
    select person.auth_user_id,person.id,(select auth.uid()),profile.app_role='employee' from public.internal_org_people person
    join public.profiles profile on profile.id=person.auth_user_id
    where person.id=any(requested) on conflict(auth_user_id) do update set employee_delegation_confirmed=excluded.employee_delegation_confirmed;
  insert into private.subscription_credential_access_audit_events(actor_user_id,delegate_count)
    values((select auth.uid()),cardinality(requested));
end;
$function$;

CREATE OR REPLACE FUNCTION private.portal_role_policy(p_user_id uuid DEFAULT NULL::uuid)
 RETURNS TABLE(app_role text, person_id uuid, account_status text, is_super_admin boolean, can_manage_accounts boolean, can_view_employee_directory boolean, can_manage_employee_directory boolean, can_view_organisation_chart boolean, can_edit_organisation_chart boolean, can_change_employee_view boolean, can_view_check_in_workspace boolean, can_manage_assets boolean, can_view_subscription_register boolean, can_manage_subscriptions boolean, can_manage_subscription_credentials boolean, can_manage_subscription_credential_grants boolean, can_manage_subscription_management_grants boolean, can_manage_roles boolean, can_manage_analytics_api boolean, can_import_payroll_balances boolean, payroll_comparison_only boolean, can_manage_leave_balances boolean, can_view_all_leave_requests boolean, can_review_leave_workspace boolean, can_approve_employment_decisions boolean)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
    operational, manager or operational or (policy.app_role='employee' and exists(
      select 1 from private.subscription_management_grants g where g.person_id=policy.person_id and g.employee_delegation_confirmed)),
    operational or (policy.app_role in ('manager','employee') and exists(
      select 1 from private.subscription_management_grants g where g.person_id=policy.person_id
        and (manager or g.employee_delegation_confirmed))),
    operational or (policy.app_role in ('manager','employee') and exists(select 1 from private.subscription_credential_access_grants g
      where g.person_id=policy.person_id and g.auth_user_id=policy.user_id and (manager or g.employee_delegation_confirmed))),
    p0, p0, p0, p0, account or operational, account, operational,
    account or operational, manager or operational, operational
  from policy;
$function$;

CREATE OR REPLACE FUNCTION private.validate_subscription_role_delegates(p_person_ids uuid[])
 RETURNS uuid[]
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
    raise exception 'Choose up to 24 distinct active Managers or Employees.' using errcode='22023';
  end if;
  perform person.id from public.internal_org_people person
    join public.profiles profile on profile.id=person.auth_user_id
    where person.id=any(requested) order by person.id for share of person,profile;
  select coalesce(array_agg(person.id order by person.id),array[]::uuid[]) into valid
    from public.internal_org_people person
    cross join lateral private.portal_role_policy(person.auth_user_id) policy
    where person.id=any(requested) and policy.person_id=person.id and policy.app_role in ('manager','employee');
  if cardinality(valid)<>cardinality(requested) then
    raise exception 'Choose active linked Managers or Employees for subscription delegation.' using errcode='22023';
  end if;
  return valid;
end;
$function$;

CREATE OR REPLACE FUNCTION public.list_subscription_management_delegates()
 RETURNS TABLE(person_id uuid, full_name text, position_title text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if not private.is_system_portal_account_admin() then
    raise exception 'Only System Admin may configure subscription delegates.' using errcode='42501';
  end if;
  return query select person.id,person.full_name,person.position_title
    from private.subscription_management_grants access_grant
    join public.internal_org_people person on person.id=access_grant.person_id
    cross join lateral private.portal_role_policy(person.auth_user_id) policy
    where policy.person_id=person.id and policy.app_role in ('manager','employee')
      and (policy.app_role='manager' or access_grant.employee_delegation_confirmed)
    order by lower(person.full_name),person.id;
end;
$function$;

CREATE OR REPLACE FUNCTION public.replace_subscription_management_delegates(p_person_ids uuid[])
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare requested uuid[]; previous uuid[];
begin
  requested:=private.validate_subscription_role_delegates(p_person_ids);
  perform pg_advisory_xact_lock(hashtextextended('mam:subscription-management-grants',0));
  select coalesce(array_agg(access_grant.person_id order by access_grant.person_id),array[]::uuid[])
    into previous from private.subscription_management_grants access_grant;
  delete from private.subscription_management_grants access_grant where not access_grant.person_id=any(requested);
  insert into private.subscription_management_grants(person_id,employee_delegation_confirmed)
    select person.id,profile.app_role='employee' from public.internal_org_people person
    join public.profiles profile on profile.id=person.auth_user_id where person.id=any(requested)
    on conflict(person_id) do update set employee_delegation_confirmed=excluded.employee_delegation_confirmed;
  insert into private.subscription_management_grant_events(actor_user_id,before_person_ids,after_person_ids)
    values((select auth.uid()),previous,requested);
end;
$function$;

create temporary table subscription_employee_function_after on commit drop as
select a.signature,pg_get_functiondef(p.oid) definition,
  (to_jsonb(p)-array['prosrc','prosqlbody','proargdefaults'])
    ||jsonb_build_object('parameter_defaults',pg_get_expr(p.proargdefaults,0)) metadata
from subscription_employee_functions a join pg_proc p on p.oid=to_regprocedure(a.signature);
create temporary table subscription_employee_catalog_after on commit drop as select * from pg_temp.subscription_employee_catalog();
create temporary table subscription_employee_new_columns on commit drop as
select a.attrelid::regclass::text||':'||a.attname||':'||format_type(a.atttypid,a.atttypmod)||':'||a.attnotnull definition
from pg_attribute a where a.attrelid in
  ('private.subscription_management_grants'::regclass,'private.subscription_credential_access_grants'::regclass)
  and a.attname='employee_delegation_confirmed' and not a.attisdropped and a.atttypid='boolean'::regtype
  and a.attnotnull and a.attacl is null and a.attidentity='' and a.attgenerated=''
  and exists(select 1 from pg_attrdef d where d.adrelid=a.attrelid and d.adnum=a.attnum and pg_get_expr(d.adbin,d.adrelid)='false');
create temporary table subscription_employee_catalog_normalized on commit drop as
select definition from subscription_employee_catalog_after
except all (select definition from subscription_employee_function_after union all select definition from subscription_employee_new_columns);
insert into subscription_employee_catalog_normalized select definition from subscription_employee_function_before;
set constraints all immediate;
do $$ begin
  if (select count(*) from subscription_employee_function_after)<>7
    or (select count(*) from subscription_employee_new_columns)<>2
    or exists(select 1 from subscription_employee_functions expected join subscription_employee_function_after actual using(signature)
      where encode(extensions.digest(actual.definition,'sha256'),'hex') is distinct from expected.after_sha256)
    or exists(select 1 from subscription_employee_function_before b join subscription_employee_function_after a using(signature)
      where b.metadata is distinct from a.metadata)
    or exists((select definition collate "C" from subscription_employee_catalog_before
      except all select definition collate "C" from subscription_employee_catalog_normalized)
      union all (select definition collate "C" from subscription_employee_catalog_normalized
      except all select definition collate "C" from subscription_employee_catalog_before))
    or pg_temp.subscription_employee_security() is distinct from (select value from subscription_employee_security_before)
    or pg_temp.subscription_employee_data() is distinct from (select value from subscription_employee_data_before)
    or exists(select 1 from private.subscription_management_grants where employee_delegation_confirmed)
    or exists(select 1 from private.subscription_credential_access_grants where employee_delegation_confirmed) then
    raise exception 'Subscription delegation contains changes outside the reviewed delta.' using errcode='55000';
  end if;
end $$;
update private.confirmed_test_purge_schema set schema_hash=private.confirmed_test_purge_schema_hash() where singleton;
set constraints all immediate;
do $$ begin
  if exists((select definition collate "C" from pg_temp.subscription_employee_catalog()
      except all select definition collate "C" from subscription_employee_catalog_after)
      union all (select definition collate "C" from subscription_employee_catalog_after
      except all select definition collate "C" from pg_temp.subscription_employee_catalog()))
    or private.confirmed_test_purge_schema_hash() is distinct from
      (select schema_hash from private.confirmed_test_purge_schema where singleton)
    or pg_temp.subscription_employee_security() is distinct from (select value from subscription_employee_security_before)
    or pg_temp.subscription_employee_data() is distinct from (select value from subscription_employee_data_before) then
    raise exception 'Subscription delegation final catalog, security or retained data differs.' using errcode='55000';
  end if;
end $$;
drop function pg_temp.subscription_employee_catalog();
drop function pg_temp.subscription_employee_security();
drop function pg_temp.subscription_employee_data();
commit;
