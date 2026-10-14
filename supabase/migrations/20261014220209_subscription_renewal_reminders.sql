begin;
set local search_path='';
select pg_advisory_xact_lock(hashtextextended('mam:directory-role-control',0));
lock table private.confirmed_test_identity_purges,private.confirmed_test_purge_schema,
  private.subscription_register,private.subscription_audit_events in share row exclusive mode nowait;
do $subscription_renewal_predecessor$ begin
  if encode(extensions.digest(pg_get_functiondef('private.confirmed_test_purge_schema_hash()'::regprocedure),'sha256'),'hex')
      is distinct from '3385d5a0140df3995e3196ffea442b4829f9a5357de3ccf5a8d521fbe9011a54'
    or (select count(*) from private.confirmed_test_purge_schema)<>1
    or private.confirmed_test_purge_schema_hash() is distinct from
      (select schema_hash from private.confirmed_test_purge_schema where singleton) then
    raise exception 'Subscription renewal tasks require the reviewed predecessor catalog.' using errcode='55000';
  end if;
end $subscription_renewal_predecessor$;
create temporary table subscription_renewal_function_spec(signature text primary key,is_existing boolean not null,before_sha256 text,after_sha256 text,new_metadata jsonb) on commit drop;
insert into subscription_renewal_function_spec values
('private.notification_event_key_valid(text)',true,'c6497aba967d0ebfee7c15c55bd47bf5a19fcad86991dbf92a6f6aefa636af10','310c135589fdf5621bb004a19e0827356d3c555aeb4bad6a2ab4147528bbaed3',null),
('public.list_subscription_renewal_calendar_entries()',false,null,'e6f37e2bdab56bf41e1ab9f87b18d2a38f9f370408360bcaa8b7a8e869a852fe','{"owner":"postgres","acl":"{postgres=X/postgres,authenticated=X/postgres}","security_definer":true,"config":["search_path=\"\""]}'::jsonb),
('public.list_subscription_renewal_calendar_entries_for_preview(uuid)',false,null,'966c1a64d8f2d4dd57c9ad4b6608381e9f74f10562f88dec006fabb593cb5617','{"owner":"postgres","acl":"{postgres=X/postgres,authenticated=X/postgres}","security_definer":true,"config":["search_path=\"\""]}'::jsonb),
('public.can_view_subscription_renewal_calendar()',false,null,'acec334038729f574cf0bac778b9bd93c911af0ab3a6d36a891f5be981a923b5','{"owner":"postgres","acl":"{postgres=X/postgres,authenticated=X/postgres}","security_definer":true,"config":["search_path=\"\""]}'::jsonb),
('public.can_view_subscription_renewal_calendar_for_preview(uuid)',false,null,'6100a1f61f444c2460a375daa6f2e43a7aed1fcc4949d09a499a9d9d2bd65978','{"owner":"postgres","acl":"{postgres=X/postgres,authenticated=X/postgres}","security_definer":true,"config":["search_path=\"\""]}'::jsonb),
('public.list_subscription_renewal_mail(date,integer)',false,null,'39d2f6a36d247dcf3e6e0641221888a3b253647a47c1ad6e7c39d6b9bb6c156d','{"owner":"postgres","acl":"{postgres=X/postgres,service_role=X/postgres}","security_definer":true,"config":["search_path=\"\""]}'::jsonb),
('public.reserve_subscription_renewal_mail(text,text,text,text)',false,null,'715592ad6cfda8349e77f3d44a7a6be1d7a84caf67fe09d06ca910bb40d57936','{"owner":"postgres","acl":"{postgres=X/postgres,service_role=X/postgres}","security_definer":true,"config":["search_path=\"\""]}'::jsonb);
do $subscription_renewal_before$ declare item record; begin
  for item in select * from subscription_renewal_function_spec loop
    if item.is_existing then
      if encode(extensions.digest(pg_get_functiondef(to_regprocedure(item.signature)),'sha256'),'hex') is distinct from item.before_sha256 then
        raise exception 'Subscription renewal predecessor differs: %',item.signature using errcode='55000';
      end if;
    elsif to_regprocedure(item.signature) is not null then
      raise exception 'Subscription renewal function already exists: %',item.signature using errcode='55000';
    end if;
  end loop;
end $subscription_renewal_before$;
create temporary table subscription_renewal_function_before on commit drop as
select s.signature,pg_get_functiondef(p.oid) definition,
  (to_jsonb(p)-array['prosrc','prosqlbody','proargdefaults'])||jsonb_build_object('parameter_defaults',pg_get_expr(p.proargdefaults,0)) metadata,
  p.oid::regprocedure::text||':'||p.proowner::text||':'||coalesce(p.proacl::text,'default') acl_definition
from subscription_renewal_function_spec s join pg_proc p on p.oid=to_regprocedure(s.signature) where s.is_existing;
do $subscription_renewal_collector$ declare query text; anchor text; begin
  select prosrc into query from pg_proc where oid='private.confirmed_test_purge_schema_hash()'::regprocedure;
  anchor:=E'select encode(extensions.digest(coalesce(string_agg(definition,E''\\n'' order by definition),''''),''sha256''),''hex'') from (';
  if (length(query)-length(replace(query,anchor,'')))/length(anchor)<>1 then
    raise exception 'Subscription renewal collector differs.' using errcode='55000';
  end if;
  execute 'create function pg_temp.subscription_renewal_catalog() returns table(definition text) language sql stable set search_path='''' as '
    ||quote_literal(replace(query,anchor,'select definition from ('));
end $subscription_renewal_collector$;
create temporary table subscription_renewal_catalog_before on commit drop as select * from pg_temp.subscription_renewal_catalog();
create function pg_temp.subscription_renewal_security() returns jsonb language sql stable set search_path='' as $$
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
    and not exists(select 1 from subscription_renewal_function_spec s where p.oid=to_regprocedure(s.signature)))
);
$$;
create temporary table subscription_renewal_security_before on commit drop as select pg_temp.subscription_renewal_security() value;
create function pg_temp.subscription_renewal_data() returns jsonb language sql stable set search_path='' as $$
select jsonb_build_object(
  'subscriptions',(select encode(extensions.digest(coalesce(jsonb_agg(to_jsonb(s) order by s.id),'[]')::text,'sha256'),'hex') from private.subscription_register s),
  'audit',(select encode(extensions.digest(coalesce(jsonb_agg(to_jsonb(s) order by s.id),'[]')::text,'sha256'),'hex') from private.subscription_audit_events s),
  'purge_receipts',(select encode(extensions.digest(coalesce(jsonb_agg(to_jsonb(s) order by s.id),'[]')::text,'sha256'),'hex') from private.confirmed_test_identity_purges s)
);
$$;
create temporary table subscription_renewal_data_before on commit drop as select pg_temp.subscription_renewal_data() value;

create function public.can_view_subscription_renewal_calendar()
returns boolean language sql stable security definer set search_path='' as $$
  select exists(select 1 from private.portal_role_policy() policy where policy.can_manage_subscriptions);
$$;
create function public.can_view_subscription_renewal_calendar_for_preview(p_person_id uuid)
returns boolean language plpgsql stable security definer set search_path='' as $$
declare enabled boolean;
begin
  if p_person_id is null then raise exception 'The selected employee is unavailable.' using errcode='42501'; end if;
  select capabilities.can_manage_subscriptions into enabled from public.get_portal_role_capabilities(p_person_id) capabilities;
  return coalesce(enabled,false);
end;
$$;
create function public.list_subscription_renewal_calendar_entries()
returns table(subscription_id uuid,service_name text,due_date date,status text)
language plpgsql stable security definer set search_path='' as $$
begin
  if not public.can_view_subscription_renewal_calendar() then return; end if;
  return query select s.id,s.service_name,s.renewal_date,s.subscription_status
    from private.subscription_register s where s.pricing_model='paid' and s.subscription_status in ('active','paused')
      and s.renewal_date is not null
    order by s.renewal_date,s.service_name,s.id;
end;
$$;
create function public.list_subscription_renewal_calendar_entries_for_preview(p_person_id uuid)
returns table(subscription_id uuid,service_name text,due_date date,status text)
language plpgsql stable security definer set search_path='' as $$
begin
  if not public.can_view_subscription_renewal_calendar_for_preview(p_person_id) then return; end if;
  return query select s.id,s.service_name,s.renewal_date,s.subscription_status
    from private.subscription_register s where s.pricing_model='paid' and s.subscription_status in ('active','paused')
      and s.renewal_date is not null
    order by s.renewal_date,s.service_name,s.id;
end;
$$;
revoke all on function public.can_view_subscription_renewal_calendar(),
  public.can_view_subscription_renewal_calendar_for_preview(uuid),
  public.list_subscription_renewal_calendar_entries(),
  public.list_subscription_renewal_calendar_entries_for_preview(uuid) from public,anon,authenticated,service_role;
grant execute on function public.can_view_subscription_renewal_calendar(),
  public.can_view_subscription_renewal_calendar_for_preview(uuid),
  public.list_subscription_renewal_calendar_entries(),
  public.list_subscription_renewal_calendar_entries_for_preview(uuid) to authenticated;

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
    '|subscription-(review|renewal):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01]):(upcoming|due))$'
  ), false)
$$;

create function public.list_subscription_renewal_mail(p_start_on date,p_limit integer default 100)
returns table(payload jsonb)
language plpgsql stable security definer set search_path='' as $$
declare today date:=private.mam_local_calendar_date(); recipient text; recipients text[]:=array[]::text[]; row record;
begin
  if p_start_on is null or p_start_on>today or p_limit is null or p_limit not between 1 and 100 then
    raise exception 'Invalid subscription renewal reminder parameters.' using errcode='22023';
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
      select s.id,s.service_name,s.renewal_date,
        case when s.renewal_date>today then 'upcoming' else 'due' end phase
      from private.subscription_register s where s.pricing_model='paid' and s.subscription_status in ('active','paused')
        and s.renewal_date>=p_start_on and s.renewal_date<=today+7
    ), keyed as (
      select c.*,'subscription-renewal:'||c.id::text||':'||c.renewal_date::text||':'||c.phase delivery_id from candidates c
    )
    select jsonb_build_object('version',1,'event','subscription-renewal-reminder','deliveryId',k.delivery_id,
      'serviceName',k.service_name,'nextRenewalOn',k.renewal_date,'phase',k.phase,'toRecipients',recipient)
    from keyed k where not exists(select 1 from private.notification_delivery_receipts r where r.event_key=k.delivery_id)
    order by k.renewal_date,k.service_name,k.id limit p_limit;
end;
$$;
revoke all on function public.list_subscription_renewal_mail(date,integer) from public,anon,authenticated,service_role;
grant execute on function public.list_subscription_renewal_mail(date,integer) to service_role;

create function public.reserve_subscription_renewal_mail(p_event_key text,p_recipient text,p_cc text,p_legacy_event_key text default null)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare target private.subscription_register%rowtype; current_recipient text;
begin
  if p_event_key is null or p_event_key !~ '^subscription-renewal:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01]):(upcoming|due)$'
    or p_cc is distinct from '' or p_legacy_event_key is not null then
    raise exception 'Invalid subscription renewal reservation.' using errcode='22023';
  end if;
  perform pg_advisory_xact_lock_shared(hashtextextended('mam:directory-role-control',0));
  select s.* into target from private.subscription_register s where s.id=split_part(p_event_key,':',2)::uuid for update;
  if exists(select 1 from private.notification_delivery_receipts r where r.event_key=p_event_key) then
    return public.reserve_notification_delivery(p_event_key,p_recipient,p_cc,null);
  end if;
  if target.id is not null and target.pricing_model='paid' and target.subscription_status in ('active','paused')
    and target.renewal_date::text=split_part(p_event_key,':',3)
    and (case when target.renewal_date>private.mam_local_calendar_date() then 'upcoming' else 'due' end)=split_part(p_event_key,':',4) then
    select item.payload->>'toRecipients' into current_recipient
      from public.list_subscription_renewal_mail(least(target.renewal_date,private.mam_local_calendar_date()),100) item
      where item.payload->>'deliveryId'=p_event_key;
  end if;
  if current_recipient is null or current_recipient is distinct from p_recipient then
    return private.notification_delivery_rejection(p_event_key,'subscription-renewal-unavailable',false);
  end if;
  return public.reserve_notification_delivery(p_event_key,p_recipient,p_cc,null);
end;
$$;
revoke all on function public.reserve_subscription_renewal_mail(text,text,text,text) from public,anon,authenticated,service_role;
grant execute on function public.reserve_subscription_renewal_mail(text,text,text,text) to service_role;

create temporary table subscription_renewal_function_after on commit drop as
select s.signature,pg_get_functiondef(p.oid) definition,
  (to_jsonb(p)-array['prosrc','prosqlbody','proargdefaults'])||jsonb_build_object('parameter_defaults',pg_get_expr(p.proargdefaults,0)) metadata,
  p.oid::regprocedure::text||':'||p.proowner::text||':'||coalesce(p.proacl::text,'default') acl_definition,
  jsonb_build_object('owner',pg_get_userbyid(p.proowner),'acl',p.proacl::text,'security_definer',p.prosecdef,'config',p.proconfig) portable
from subscription_renewal_function_spec s join pg_proc p on p.oid=to_regprocedure(s.signature);
create temporary table subscription_renewal_catalog_after on commit drop as select * from pg_temp.subscription_renewal_catalog();
create temporary table subscription_renewal_catalog_normalized on commit drop as
select definition from subscription_renewal_catalog_after
except all (select definition from subscription_renewal_function_after union all select acl_definition from subscription_renewal_function_after);
insert into subscription_renewal_catalog_normalized
select definition from subscription_renewal_function_before union all select acl_definition from subscription_renewal_function_before;
create function pg_temp.subscription_renewal_assert_delta() returns void language plpgsql set search_path='' as $$
begin
  if (select count(*) from subscription_renewal_function_after)<>7
    or exists(select 1 from subscription_renewal_function_spec s join subscription_renewal_function_after a using(signature)
      where encode(extensions.digest(a.definition,'sha256'),'hex') is distinct from s.after_sha256
        or (not s.is_existing and a.portable is distinct from s.new_metadata))
    or exists(select 1 from subscription_renewal_function_before b join subscription_renewal_function_after a using(signature)
      where b.metadata is distinct from a.metadata or b.acl_definition is distinct from a.acl_definition)
    or exists((select definition collate "C" from subscription_renewal_catalog_before except all select definition collate "C" from subscription_renewal_catalog_normalized)
      union all (select definition collate "C" from subscription_renewal_catalog_normalized except all select definition collate "C" from subscription_renewal_catalog_before))
    or exists((select definition collate "C" from pg_temp.subscription_renewal_catalog() except all select definition collate "C" from subscription_renewal_catalog_after)
      union all (select definition collate "C" from subscription_renewal_catalog_after except all select definition collate "C" from pg_temp.subscription_renewal_catalog()))
    or exists(select 1 from subscription_renewal_function_after a join pg_proc p on p.oid=to_regprocedure(a.signature)
      where a.metadata is distinct from (to_jsonb(p)-array['prosrc','prosqlbody','proargdefaults'])||jsonb_build_object('parameter_defaults',pg_get_expr(p.proargdefaults,0)))
    or pg_temp.subscription_renewal_security() is distinct from (select value from subscription_renewal_security_before)
    or pg_temp.subscription_renewal_data() is distinct from (select value from subscription_renewal_data_before) then
    raise exception 'Subscription renewal tasks contain changes outside the reviewed delta.' using errcode='55000';
  end if;
end;
$$;
set constraints all immediate;
select pg_temp.subscription_renewal_assert_delta();
update private.confirmed_test_purge_schema set schema_hash=private.confirmed_test_purge_schema_hash() where singleton;
set constraints all immediate;
select pg_temp.subscription_renewal_assert_delta();
do $subscription_renewal_final$ begin
  if private.confirmed_test_purge_schema_hash() is distinct from
    (select schema_hash from private.confirmed_test_purge_schema where singleton) then
    raise exception 'Subscription renewal final fingerprint differs.' using errcode='55000';
  end if;
end $subscription_renewal_final$;
commit;
