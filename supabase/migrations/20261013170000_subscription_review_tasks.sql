begin;
set local search_path='';
select pg_advisory_xact_lock(hashtextextended('mam:directory-role-control',0));
lock table private.confirmed_test_identity_purges,private.confirmed_test_purge_schema,
  private.subscription_register,private.subscription_audit_events in share row exclusive mode nowait;
do $subscription_review_predecessor$ begin
  if encode(extensions.digest(pg_get_functiondef('private.confirmed_test_purge_schema_hash()'::regprocedure),'sha256'),'hex')
      is distinct from '3385d5a0140df3995e3196ffea442b4829f9a5357de3ccf5a8d521fbe9011a54'
    or (select count(*) from private.confirmed_test_purge_schema)<>1
    or private.confirmed_test_purge_schema_hash() is distinct from
      (select schema_hash from private.confirmed_test_purge_schema where singleton) then
    raise exception 'Subscription review tasks require the reviewed predecessor catalog.' using errcode='55000';
  end if;
end $subscription_review_predecessor$;
create temporary table subscription_review_function_spec(signature text primary key,is_existing boolean not null,before_sha256 text,after_sha256 text,new_metadata jsonb) on commit drop;
insert into subscription_review_function_spec values
('private.record_subscription_review(uuid,bigint)',false,null,'c93192128cc5549e47a5e76c251db6fe08bdfbbc4b8a3366d03239d3c9da87c3','{"owner": "postgres", "acl": "{postgres=X/postgres}", "security_definer": true, "config": ["search_path=\"\""]}'::jsonb),
('public.mark_subscription_reviewed_v2(uuid,bigint)',true,'222407d76e41e554b3e55c1ba7b2d267a5da2ef7f7fd2c10ebb9707a33f1c30c','ac588e02123a9898f414ce3715771306748b6ce00d110a744116bf2dd1b945c3',null),
('public.list_my_subscription_review_tasks()',false,null,'fd253a8ec614422290b76958d9ff155661622ae4f61beae3a97361ed5c3c66cc','{"owner": "postgres", "acl": "{postgres=X/postgres,authenticated=X/postgres}", "security_definer": true, "config": ["search_path=\"\""]}'::jsonb),
('public.list_subscription_review_tasks_for_preview(uuid)',false,null,'547c9f5eab9ea48fc73d889ae147947a322c5510a7f9eb06f6805c5815c1cb93','{"owner": "postgres", "acl": "{postgres=X/postgres,authenticated=X/postgres}", "security_definer": true, "config": ["search_path=\"\""]}'::jsonb),
('public.complete_my_subscription_review_task(uuid,bigint)',false,null,'878845e95f824a7510aac430613dbcb83e8bb0c2e050fa0138f1b19a6b4af540','{"owner": "postgres", "acl": "{postgres=X/postgres,authenticated=X/postgres}", "security_definer": true, "config": ["search_path=\"\""]}'::jsonb);
do $subscription_review_before$ declare item record; begin
  for item in select * from subscription_review_function_spec loop
    if item.is_existing then
      if encode(extensions.digest(pg_get_functiondef(to_regprocedure(item.signature)),'sha256'),'hex') is distinct from item.before_sha256 then
        raise exception 'Subscription review predecessor differs: %',item.signature using errcode='55000';
      end if;
    elsif to_regprocedure(item.signature) is not null then
      raise exception 'Subscription review function already exists: %',item.signature using errcode='55000';
    end if;
  end loop;
end $subscription_review_before$;
create temporary table subscription_review_function_before on commit drop as
select s.signature,pg_get_functiondef(p.oid) definition,
  (to_jsonb(p)-array['prosrc','prosqlbody','proargdefaults'])||jsonb_build_object('parameter_defaults',pg_get_expr(p.proargdefaults,0)) metadata,
  p.oid::regprocedure::text||':'||p.proowner::text||':'||coalesce(p.proacl::text,'default') acl_definition
from subscription_review_function_spec s join pg_proc p on p.oid=to_regprocedure(s.signature) where s.is_existing;
do $subscription_review_collector$ declare query text; anchor text; begin
  select prosrc into query from pg_proc where oid='private.confirmed_test_purge_schema_hash()'::regprocedure;
  anchor:=E'select encode(extensions.digest(coalesce(string_agg(definition,E''\\n'' order by definition),''''),''sha256''),''hex'') from (';
  if (length(query)-length(replace(query,anchor,'')))/length(anchor)<>1 then
    raise exception 'Subscription review collector differs.' using errcode='55000';
  end if;
  execute 'create function pg_temp.subscription_review_catalog() returns table(definition text) language sql stable set search_path='''' as '
    ||quote_literal(replace(query,anchor,'select definition from ('));
end $subscription_review_collector$;
create temporary table subscription_review_catalog_before on commit drop as select * from pg_temp.subscription_review_catalog();
create function pg_temp.subscription_review_security() returns jsonb language sql stable set search_path='' as $$
select jsonb_build_object(
  'schemas',(select jsonb_agg(to_jsonb(n) order by n.oid) from pg_namespace n where n.nspname !~ '^pg_temp_' and n.nspname !~ '^pg_toast_temp_'),
  'default_acls',(select jsonb_agg(to_jsonb(d) order by d.oid) from pg_default_acl d),
  'roles',(select jsonb_agg(to_jsonb(r) order by r.oid) from pg_roles r),
  'role_memberships',(select jsonb_agg(to_jsonb(m) order by m.roleid,m.member,m.grantor,m.oid) from pg_auth_members m),
  'role_database_settings',(select jsonb_agg(to_jsonb(s) order by s.setdatabase,s.setrole) from pg_db_role_setting s),
  'types',(select jsonb_agg(to_jsonb(t) order by t.oid) from pg_type t join pg_namespace n on n.oid=t.typnamespace where n.nspname !~ '^pg_temp_' and n.nspname !~ '^pg_toast_temp_'),
  'enums',(select jsonb_agg(to_jsonb(e) order by e.oid) from pg_enum e),
  'rewrites',(select jsonb_agg(to_jsonb(w) order by w.oid) from pg_rewrite w join pg_class c on c.oid=w.ev_class join pg_namespace n on n.oid=c.relnamespace where n.nspname !~ '^pg_temp_' and n.nspname !~ '^pg_toast_temp_'),
  'columns',(select jsonb_agg(to_jsonb(a) order by a.attrelid,a.attnum) from pg_attribute a join pg_class c on c.oid=a.attrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname !~ '^pg_temp_' and n.nspname !~ '^pg_toast_temp_'),
  'relations',(select jsonb_agg(to_jsonb(c) order by c.oid) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname !~ '^pg_temp_' and n.nspname !~ '^pg_toast_temp_'),
  'policies',(select jsonb_agg(to_jsonb(p) order by p.oid) from pg_policy p join pg_class c on c.oid=p.polrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname !~ '^pg_temp_' and n.nspname !~ '^pg_toast_temp_'),
  'constraints',(select jsonb_agg(to_jsonb(k) order by k.oid) from pg_constraint k join pg_namespace n on n.oid=k.connamespace where n.nspname !~ '^pg_temp_' and n.nspname !~ '^pg_toast_temp_'),
  'defaults',(select jsonb_agg(to_jsonb(d) order by d.oid) from pg_attrdef d join pg_class c on c.oid=d.adrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname !~ '^pg_temp_' and n.nspname !~ '^pg_toast_temp_'),
  'routines',(select jsonb_agg(to_jsonb(p) order by p.oid) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname !~ '^pg_temp_' and n.nspname !~ '^pg_toast_temp_'
    and not exists(select 1 from subscription_review_function_spec s where p.oid=to_regprocedure(s.signature)))
);
$$;
create temporary table subscription_review_security_before on commit drop as select pg_temp.subscription_review_security() value;
create function pg_temp.subscription_review_data() returns jsonb language sql stable set search_path='' as $$
select jsonb_build_object(
  'subscriptions',(select encode(extensions.digest(coalesce(jsonb_agg(to_jsonb(s) order by s.id),'[]')::text,'sha256'),'hex') from private.subscription_register s),
  'audit',(select encode(extensions.digest(coalesce(jsonb_agg(to_jsonb(s) order by s.id),'[]')::text,'sha256'),'hex') from private.subscription_audit_events s),
  'purge_receipts',(select encode(extensions.digest(coalesce(jsonb_agg(to_jsonb(s) order by s.id),'[]')::text,'sha256'),'hex') from private.confirmed_test_identity_purges s)
);
$$;
create temporary table subscription_review_data_before on commit drop as select pg_temp.subscription_review_data() value;

CREATE OR REPLACE FUNCTION private.record_subscription_review(p_subscription_id uuid, p_expected_version bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  actor uuid := (select auth.uid());
  v_subscription private.subscription_register%rowtype;
begin
  if p_subscription_id is null or p_expected_version is null or p_expected_version < 1 then
    raise exception 'The subscription record is invalid.' using errcode = '22023';
  end if;
  select target.* into v_subscription
  from private.subscription_register target
  where target.id = p_subscription_id
  for update;
  if not found then
    raise exception 'This subscription is no longer available.' using errcode = 'P0002';
  end if;
  if v_subscription.version <> p_expected_version then
    raise exception 'This subscription has changed. Refresh it, then try again.' using errcode = '40001';
  end if;
  if v_subscription.subscription_status not in ('active', 'paused')
    or v_subscription.pricing_model <> 'paid' then
    raise exception 'Only active paid subscriptions need a quarterly review.' using errcode = '22023';
  end if;

  update private.subscription_register target
  set next_review_on = private.next_paid_subscription_quarter_review_on(
        greatest(
          private.mam_local_calendar_date(),
          coalesce(v_subscription.next_review_on, private.mam_local_calendar_date())
        )
      ),
      updated_by = actor
  where target.id = v_subscription.id
  returning * into v_subscription;

  insert into private.subscription_audit_events (
    subscription_id,
    actor_user_id,
    event_type,
    changed_fields
  ) values (
    v_subscription.id,
    actor,
    'reviewed',
    array['next_review_on']::text[]
  );

  return (
    select projection.item
    from private.subscription_register_v2_projection(v_subscription.id) as projection(item)
  );
end;
$function$;
CREATE OR REPLACE FUNCTION public.mark_subscription_reviewed_v2(p_subscription_id uuid, p_expected_version bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if (select auth.uid()) is null or not private.lock_subscription_role_authority(false) then
    raise exception 'You do not have permission to review subscriptions.' using errcode = '42501';
  end if;
  return private.record_subscription_review(p_subscription_id,p_expected_version);
end;
$function$;
create function public.list_my_subscription_review_tasks()
returns table(subscription_id uuid,service_name text,next_review_on date,subscription_status text,version bigint)
language plpgsql stable security definer set search_path='' as $$
declare v_person_id uuid:=private.current_active_portal_employee_id();
begin
  if v_person_id is null or not private.is_active_linked_internal_employee()
    or not exists(select 1 from private.portal_role_policy() policy where policy.person_id=v_person_id) then
    raise exception 'You do not have permission to view subscription review tasks.' using errcode='42501';
  end if;
  return query select s.id,s.service_name,s.next_review_on,s.subscription_status,s.version
    from private.subscription_register s where s.responsible_person_id=v_person_id
      and s.pricing_model='paid' and s.subscription_status in ('active','paused')
    order by s.next_review_on,s.service_name,s.id;
end;
$$;
create function public.list_subscription_review_tasks_for_preview(p_person_id uuid)
returns table(subscription_id uuid,service_name text,next_review_on date,subscription_status text,version bigint)
language plpgsql stable security definer set search_path='' as $$
begin
  if p_person_id is null then
    raise exception 'The selected employee is unavailable.' using errcode='42501';
  end if;
  perform public.get_portal_role_capabilities(p_person_id);
  return query select s.id,s.service_name,s.next_review_on,s.subscription_status,s.version
    from private.subscription_register s where s.responsible_person_id=p_person_id
      and s.pricing_model='paid' and s.subscription_status in ('active','paused')
    order by s.next_review_on,s.service_name,s.id;
end;
$$;
create function public.complete_my_subscription_review_task(p_subscription_id uuid,p_expected_version bigint)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare v_person_id uuid; target private.subscription_register%rowtype; reviewed jsonb;
begin
  if not private.lock_portal_role_actor() then
    raise exception 'You do not have permission to complete subscription review tasks.' using errcode='42501';
  end if;
  v_person_id:=private.current_active_portal_employee_id();
  if v_person_id is null or not private.is_active_linked_internal_employee() then
    raise exception 'You do not have permission to complete subscription review tasks.' using errcode='42501';
  end if;
  perform 1 from public.internal_org_people p where p.id=v_person_id for share nowait;
  if p_subscription_id is null or p_expected_version is null or p_expected_version<1 then
    raise exception 'The subscription review task is invalid.' using errcode='22023';
  end if;
  select s.* into target from private.subscription_register s where s.id=p_subscription_id for update;
  if not found or target.responsible_person_id is distinct from v_person_id
    or private.current_active_portal_employee_id() is distinct from v_person_id
    or not private.is_active_linked_internal_employee()
    or not exists(select 1 from private.portal_role_policy() policy where policy.person_id=v_person_id) then
    raise exception 'You do not have permission to complete subscription review tasks.' using errcode='42501';
  end if;
  if target.pricing_model<>'paid' or target.subscription_status not in ('active','paused') then
    raise exception 'Only live paid subscriptions need a quarterly review.' using errcode='22023';
  end if;
  if target.version<>p_expected_version then
    raise exception 'This subscription has changed. Refresh it, then try again.' using errcode='40001';
  end if;
  if target.next_review_on is null or target.next_review_on>private.mam_local_calendar_date() then
    raise exception 'This subscription review is not due.' using errcode='42501';
  end if;
  reviewed:=private.record_subscription_review(p_subscription_id,p_expected_version);
  return jsonb_build_object('subscription_id',reviewed->'subscription_id','service_name',reviewed->'service_name',
    'next_review_on',reviewed->'next_review_on','subscription_status',reviewed->'subscription_status','version',reviewed->'version');
end;
$$;

revoke all on function private.record_subscription_review(uuid,bigint) from public,anon,authenticated,service_role;
revoke all on function public.list_my_subscription_review_tasks() from public,anon,authenticated,service_role;
grant execute on function public.list_my_subscription_review_tasks() to authenticated;
revoke all on function public.list_subscription_review_tasks_for_preview(uuid) from public,anon,authenticated,service_role;
grant execute on function public.list_subscription_review_tasks_for_preview(uuid) to authenticated;
revoke all on function public.complete_my_subscription_review_task(uuid,bigint) from public,anon,authenticated,service_role;
grant execute on function public.complete_my_subscription_review_task(uuid,bigint) to authenticated;

create temporary table subscription_review_function_after on commit drop as
select s.signature,pg_get_functiondef(p.oid) definition,
  (to_jsonb(p)-array['prosrc','prosqlbody','proargdefaults'])||jsonb_build_object('parameter_defaults',pg_get_expr(p.proargdefaults,0)) metadata,
  p.oid::regprocedure::text||':'||p.proowner::text||':'||coalesce(p.proacl::text,'default') acl_definition,
  jsonb_build_object('owner',pg_get_userbyid(p.proowner),'acl',p.proacl::text,'security_definer',p.prosecdef,'config',p.proconfig) portable
from subscription_review_function_spec s join pg_proc p on p.oid=to_regprocedure(s.signature);
create temporary table subscription_review_catalog_after on commit drop as select * from pg_temp.subscription_review_catalog();
create temporary table subscription_review_catalog_normalized on commit drop as
select definition from subscription_review_catalog_after
except all (select definition from subscription_review_function_after union all select acl_definition from subscription_review_function_after);
insert into subscription_review_catalog_normalized
select definition from subscription_review_function_before union all select acl_definition from subscription_review_function_before;
create function pg_temp.subscription_review_assert_delta() returns void language plpgsql set search_path='' as $$
begin
  if (select count(*) from subscription_review_function_after)<>5
    or exists(select 1 from subscription_review_function_spec s join subscription_review_function_after a using(signature)
      where encode(extensions.digest(a.definition,'sha256'),'hex') is distinct from s.after_sha256
        or (not s.is_existing and a.portable is distinct from s.new_metadata))
    or exists(select 1 from subscription_review_function_before b join subscription_review_function_after a using(signature)
      where b.metadata is distinct from a.metadata or b.acl_definition is distinct from a.acl_definition)
    or exists((select definition collate "C" from subscription_review_catalog_before except all select definition collate "C" from subscription_review_catalog_normalized)
      union all (select definition collate "C" from subscription_review_catalog_normalized except all select definition collate "C" from subscription_review_catalog_before))
    or exists((select definition collate "C" from pg_temp.subscription_review_catalog() except all select definition collate "C" from subscription_review_catalog_after)
      union all (select definition collate "C" from subscription_review_catalog_after except all select definition collate "C" from pg_temp.subscription_review_catalog()))
    or exists(select 1 from subscription_review_function_after a join pg_proc p on p.oid=to_regprocedure(a.signature)
      where a.metadata is distinct from (to_jsonb(p)-array['prosrc','prosqlbody','proargdefaults'])||jsonb_build_object('parameter_defaults',pg_get_expr(p.proargdefaults,0)))
    or pg_temp.subscription_review_security() is distinct from (select value from subscription_review_security_before)
    or pg_temp.subscription_review_data() is distinct from (select value from subscription_review_data_before) then
    raise exception 'Subscription review tasks contain changes outside the reviewed delta.' using errcode='55000';
  end if;
end;
$$;
set constraints all immediate;
select pg_temp.subscription_review_assert_delta();
update private.confirmed_test_purge_schema set schema_hash=private.confirmed_test_purge_schema_hash() where singleton;
set constraints all immediate;
select pg_temp.subscription_review_assert_delta();
do $subscription_review_final$ begin
  if private.confirmed_test_purge_schema_hash() is distinct from
    (select schema_hash from private.confirmed_test_purge_schema where singleton) then
    raise exception 'Subscription review final fingerprint differs.' using errcode='55000';
  end if;
end $subscription_review_final$;
commit;
