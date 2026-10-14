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
('public.list_my_subscription_review_tasks()',true,'fd253a8ec614422290b76958d9ff155661622ae4f61beae3a97361ed5c3c66cc','f59a07fc79dbfeb27eeab5790b8be99e0fe1a1cd2faef12c5cb89372c5531644',null),
('public.list_subscription_review_tasks_for_preview(uuid)',true,'547c9f5eab9ea48fc73d889ae147947a322c5510a7f9eb06f6805c5815c1cb93','5ed3044e3654d77906bb4b2bafeee409a499edf0d600fa3229758a9209e9c0b9',null),
('public.complete_my_subscription_review_task(uuid,bigint)',true,'878845e95f824a7510aac430613dbcb83e8bb0c2e050fa0138f1b19a6b4af540','e3d22a2558109ecf3b1a202c1778fad39594ca71c8239a6951cfd37b1c4ecf63',null),
('private.notification_event_key_valid(text)',true,'19b31d1a98015146acdd337e198d560dae29aa95a2c519a833dc11c5d81a46ad','c6497aba967d0ebfee7c15c55bd47bf5a19fcad86991dbf92a6f6aefa636af10',null),
('public.list_subscription_review_mail(date,integer)',false,null,'6876e280230e1171b31610ad8352b73fcec0087bb581ddffe4c2940b6520f31c','{"owner":"postgres","acl":"{postgres=X/postgres,service_role=X/postgres}","security_definer":true,"config":["search_path=\"\""]}'::jsonb),
('public.reserve_subscription_review_mail(text,text,text,text)',false,null,'bb37bf815cf49e1a6cfa613302fb3b5e6a2c584b180065ed5eeeb8609e38a4c4','{"owner":"postgres","acl":"{postgres=X/postgres,service_role=X/postgres}","security_definer":true,"config":["search_path=\"\""]}'::jsonb);
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

create or replace function public.list_my_subscription_review_tasks()
returns table(subscription_id uuid,service_name text,next_review_on date,subscription_status text,version bigint)
language plpgsql stable security definer set search_path='' as $$
declare v_person_id uuid:=private.current_active_portal_employee_id();
begin
  if v_person_id is null or not private.is_active_linked_internal_employee()
    or not exists(select 1 from private.portal_role_policy() policy where policy.person_id=v_person_id) then
    raise exception 'You do not have permission to view subscription review tasks.' using errcode='42501';
  end if;
  return query select s.id,s.service_name,s.next_review_on,s.subscription_status,s.version
    from private.subscription_register s where exists(select 1 from private.subscription_management_grants g
      join private.portal_role_policy() policy on policy.person_id=g.person_id and policy.can_manage_subscriptions
      where g.person_id=v_person_id)
      and s.pricing_model='paid' and s.subscription_status in ('active','paused')
    order by s.next_review_on,s.service_name,s.id;
end;
$$;
create or replace function public.list_subscription_review_tasks_for_preview(p_person_id uuid)
returns table(subscription_id uuid,service_name text,next_review_on date,subscription_status text,version bigint)
language plpgsql stable security definer set search_path='' as $$
begin
  if p_person_id is null then
    raise exception 'The selected employee is unavailable.' using errcode='42501';
  end if;
  perform public.get_portal_role_capabilities(p_person_id);
  return query select s.id,s.service_name,s.next_review_on,s.subscription_status,s.version
    from private.subscription_register s where exists(select 1 from private.subscription_management_grants g
      join public.internal_org_people person on person.id=g.person_id
      cross join lateral private.portal_role_policy(person.auth_user_id) policy
      where g.person_id=p_person_id and policy.person_id=g.person_id and policy.can_manage_subscriptions)
      and s.pricing_model='paid' and s.subscription_status in ('active','paused')
    order by s.next_review_on,s.service_name,s.id;
end;
$$;
create or replace function public.complete_my_subscription_review_task(p_subscription_id uuid,p_expected_version bigint)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare v_person_id uuid; target private.subscription_register%rowtype; reviewed jsonb;
begin
  if not private.lock_subscription_role_authority(false) then
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
  if not found or not exists(select 1 from private.subscription_management_grants g where g.person_id=v_person_id)
    or private.current_active_portal_employee_id() is distinct from v_person_id
    or not private.is_active_linked_internal_employee()
    or not exists(select 1 from private.portal_role_policy() policy where policy.person_id=v_person_id and policy.can_manage_subscriptions) then
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
    '|subscription-request:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:[1-9][0-9]*' ||
    '|subscription-review:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01]):(upcoming|due))$'
  ), false)
$$;

create function public.list_subscription_review_mail(p_start_on date,p_limit integer default 100)
returns table(payload jsonb)
language plpgsql stable security definer set search_path='' as $$
declare today date:=private.mam_local_calendar_date(); recipient text; recipients text[]:=array[]::text[]; row record;
begin
  if p_start_on is null or p_start_on>today or p_limit is null or p_limit not between 1 and 100 then
    raise exception 'Invalid subscription review reminder parameters.' using errcode='22023';
  end if;
  if not exists(select 1 from private.subscription_request_config c where c.singleton and c.enabled)
    or not exists(select 1 from private.subscription_management_grants g
      join public.internal_org_people person on person.id=g.person_id
      cross join lateral private.portal_role_policy(person.auth_user_id) policy
      where policy.person_id=g.person_id and policy.can_manage_subscriptions) then return; end if;
  for row in
    select person.id,lower(btrim(d.work_email)) email
    from public.internal_org_people person
    left join private.employee_directory_details d on d.person_id=person.id
    cross join lateral private.portal_role_policy(person.auth_user_id) policy
    where policy.person_id=person.id and (
      exists(select 1 from private.subscription_management_grants g where g.person_id=person.id and policy.can_manage_subscriptions)
      or exists(select 1 from private.subscription_request_config c where c.singleton and c.enabled
        and c.approver_person_id=person.id and c.approver_user_id=person.auth_user_id))
  loop
    if row.email is null or length(row.email)>254 or row.email !~ '^[^[:space:]@,;]+@[^[:space:]@,;]+\.[^[:space:]@,;]+$'
      or (select count(*) from private.employee_directory_details d where lower(btrim(d.work_email))=row.email)<>1 then
      raise exception 'Subscription reminder recipient is unavailable.' using errcode='55000';
    end if;
    recipients:=array_append(recipients,row.email);
  end loop;
  if not exists(select 1 from private.subscription_request_config c
    join public.internal_org_people person on person.id=c.approver_person_id and person.auth_user_id=c.approver_user_id
    cross join lateral private.portal_role_policy(person.auth_user_id) policy
    join private.employee_directory_details d on d.person_id=person.id
    where c.singleton and c.enabled and policy.person_id=person.id
      and lower(btrim(d.work_email))=any(recipients)) then
    raise exception 'Subscription reminder approver is unavailable.' using errcode='55000';
  end if;
  select string_agg(email,',' order by email collate "C") into recipient from (select distinct unnest(recipients) email) unique_recipients;
  return query
    with candidates as (
      select s.id,s.service_name,s.next_review_on,
        case when s.next_review_on>today then 'upcoming' else 'due' end phase
      from private.subscription_register s where s.pricing_model='paid' and s.subscription_status in ('active','paused')
        and s.next_review_on>=p_start_on and s.next_review_on<=today+7
    ), keyed as (
      select c.*,'subscription-review:'||c.id::text||':'||c.next_review_on::text||':'||c.phase delivery_id from candidates c
    )
    select jsonb_build_object('version',1,'event','subscription-review-reminder','deliveryId',k.delivery_id,
      'serviceName',k.service_name,'nextReviewOn',k.next_review_on,'phase',k.phase,'toRecipients',recipient)
    from keyed k where not exists(select 1 from private.notification_delivery_receipts r where r.event_key=k.delivery_id)
    order by k.next_review_on,k.service_name,k.id limit p_limit;
end;
$$;
revoke all on function public.list_subscription_review_mail(date,integer) from public,anon,authenticated,service_role;
grant execute on function public.list_subscription_review_mail(date,integer) to service_role;

create function public.reserve_subscription_review_mail(p_event_key text,p_recipient text,p_cc text,p_legacy_event_key text default null)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare target private.subscription_register%rowtype; current_recipient text;
begin
  if p_event_key is null or p_event_key !~ '^subscription-review:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01]):(upcoming|due)$'
    or p_cc is distinct from '' or p_legacy_event_key is not null then
    raise exception 'Invalid subscription review reservation.' using errcode='22023';
  end if;
  perform pg_advisory_xact_lock_shared(hashtextextended('mam:directory-role-control',0));
  select s.* into target from private.subscription_register s where s.id=split_part(p_event_key,':',2)::uuid for update;
  if exists(select 1 from private.notification_delivery_receipts r where r.event_key=p_event_key) then
    return public.reserve_notification_delivery(p_event_key,p_recipient,p_cc,null);
  end if;
  if target.id is not null and target.pricing_model='paid' and target.subscription_status in ('active','paused')
    and target.next_review_on::text=split_part(p_event_key,':',3)
    and (case when target.next_review_on>private.mam_local_calendar_date() then 'upcoming' else 'due' end)=split_part(p_event_key,':',4) then
    select item.payload->>'toRecipients' into current_recipient
      from public.list_subscription_review_mail(least(target.next_review_on,private.mam_local_calendar_date()),100) item
      where item.payload->>'deliveryId'=p_event_key;
  end if;
  if current_recipient is null or current_recipient is distinct from p_recipient then
    return private.notification_delivery_rejection(p_event_key,'subscription-review-unavailable',false);
  end if;
  return public.reserve_notification_delivery(p_event_key,p_recipient,p_cc,null);
end;
$$;
revoke all on function public.reserve_subscription_review_mail(text,text,text,text) from public,anon,authenticated,service_role;
grant execute on function public.reserve_subscription_review_mail(text,text,text,text) to service_role;

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
  if (select count(*) from subscription_review_function_after)<>6
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
