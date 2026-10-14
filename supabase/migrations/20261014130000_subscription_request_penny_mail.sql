begin;
set local search_path='';
select pg_advisory_xact_lock(hashtextextended('mam:directory-role-control',0));
lock table private.confirmed_test_identity_purges,private.confirmed_test_purge_schema,
  private.subscription_requests,private.subscription_request_notifications,private.subscription_request_mail_deliveries,private.notification_delivery_receipts in share row exclusive mode nowait;
do $subscription_penny_predecessor$ begin
  if encode(extensions.digest(pg_get_functiondef('private.confirmed_test_purge_schema_hash()'::regprocedure),'sha256'),'hex')
      is distinct from '3385d5a0140df3995e3196ffea442b4829f9a5357de3ccf5a8d521fbe9011a54'
    or (select count(*) from private.confirmed_test_purge_schema)<>1
    or private.confirmed_test_purge_schema_hash() is distinct from
      (select schema_hash from private.confirmed_test_purge_schema where singleton) then
    raise exception 'Subscription request approval tasks require the reviewed predecessor catalog.' using errcode='55000';
  end if;
end $subscription_penny_predecessor$;
create temporary table subscription_penny_function_spec(signature text primary key,is_existing boolean not null,before_sha256 text,after_sha256 text,new_metadata jsonb) on commit drop;
insert into subscription_penny_function_spec values
('public.claim_subscription_request_mail(uuid, integer)',true,'d936b77ac884dbb772de1216e7211451f8e5057b2726a1f7c974c2796f4b8f76','a7030b8589b21d1280605e4803ae96772fa982faa8cd181ea7d6b0ee919092b8',null),
('private.sr_mail_recipients(uuid)',false,null,'699ed605250534d16ad0db3875b397ac50f8bf59b2fefc921ffa40f0935e8b9a','{"owner":"postgres","acl":"{postgres=X/postgres}","security_definer":false,"config":["search_path=\"\""]}'::jsonb),
('public.reserve_subscription_request_mail(text, text, text, text)',false,null,'b6f5e28b71fca6767bf9897ccb0c38bcc68f241129bd78fc5f9be437fd8c24dc','{"owner":"postgres","acl":"{postgres=X/postgres,service_role=X/postgres}","security_definer":true,"config":["search_path=\"\""]}'::jsonb);
do $subscription_penny_before$ declare item record; begin
  for item in select * from subscription_penny_function_spec loop
    if item.is_existing then
      if encode(extensions.digest(pg_get_functiondef(to_regprocedure(item.signature)),'sha256'),'hex') is distinct from item.before_sha256 then
        raise exception 'Subscription request approval predecessor differs: %',item.signature using errcode='55000';
      end if;
    elsif to_regprocedure(item.signature) is not null then
      raise exception 'Subscription request approval function already exists: %',item.signature using errcode='55000';
    end if;
  end loop;
end $subscription_penny_before$;
create temporary table subscription_penny_function_before on commit drop as
select s.signature,pg_get_functiondef(p.oid) definition,
  (to_jsonb(p)-array['prosrc','prosqlbody','proargdefaults'])||jsonb_build_object('parameter_defaults',pg_get_expr(p.proargdefaults,0)) metadata,
  p.oid::regprocedure::text||':'||p.proowner::text||':'||coalesce(p.proacl::text,'default') acl_definition
from subscription_penny_function_spec s join pg_proc p on p.oid=to_regprocedure(s.signature) where s.is_existing;
do $subscription_penny_collector$ declare query text; anchor text; begin
  select prosrc into query from pg_proc where oid='private.confirmed_test_purge_schema_hash()'::regprocedure;
  anchor:=E'select encode(extensions.digest(coalesce(string_agg(definition,E''\\n'' order by definition),''''),''sha256''),''hex'') from (';
  if (length(query)-length(replace(query,anchor,'')))/length(anchor)<>1 then
    raise exception 'Subscription request approval collector differs.' using errcode='55000';
  end if;
  execute 'create function pg_temp.subscription_penny_catalog() returns table(definition text) language sql stable set search_path='''' as '
    ||quote_literal(replace(query,anchor,'select definition from ('));
end $subscription_penny_collector$;
create temporary table subscription_penny_catalog_before on commit drop as select * from pg_temp.subscription_penny_catalog();
create function pg_temp.subscription_penny_security() returns jsonb language sql stable set search_path='' as $$
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
    and not exists(select 1 from subscription_penny_function_spec s where p.oid=to_regprocedure(s.signature)))
);
$$;
create temporary table subscription_penny_security_before on commit drop as select pg_temp.subscription_penny_security() value;
create function pg_temp.subscription_penny_data() returns jsonb language plpgsql set search_path='' as $$
declare item record; value text; result jsonb:='{}';
begin
 for item in select format('%I.%I',n.nspname,c.relname) name from pg_class c join pg_namespace n on n.oid=c.relnamespace
   where n.nspname in ('public','private','storage') and c.relkind in ('r','p') and c.oid<>'private.confirmed_test_purge_schema'::regclass order by 1 loop
  execute 'select encode(extensions.digest(coalesce(string_agg(to_jsonb(t)::text,E''\n'' order by to_jsonb(t)::text collate "C"),''''),''sha256''),''hex'') from '||item.name||' t' into value;
  result:=result||jsonb_build_object(item.name,value);
 end loop;
 return result;
end $$;
create temporary table subscription_penny_data_before on commit drop as select pg_temp.subscription_penny_data() value;

create function private.sr_mail_recipients(p_request_id uuid)
returns table(applicant_name text,applicant_email text,approver_email text)
language sql stable set search_path='' as $$
  select applicant.full_name,lower(btrim(applicant_details.work_email)),lower(btrim(approver_details.work_email))
  from private.subscription_requests request
  join public.internal_org_people applicant on applicant.auth_user_id=request.applicant and applicant.is_active and applicant.node_kind='person'
  join private.employee_directory_details applicant_details on applicant_details.person_id=applicant.id
  cross join private.subscription_request_config config
  join public.internal_org_people approver on approver.id=config.approver_person_id and approver.auth_user_id=config.approver_user_id and approver.is_active and approver.node_kind='person'
  join private.employee_directory_details approver_details on approver_details.person_id=approver.id
  cross join lateral private.portal_role_policy(request.applicant) applicant_policy
  cross join lateral private.portal_role_policy(config.approver_user_id) approver_policy
  where request.id=p_request_id and request.status='submitted' and config.singleton and config.enabled
    and applicant_policy.person_id=applicant.id and approver_policy.person_id=approver.id
    and (select count(*) from public.internal_org_people person where person.auth_user_id=request.applicant)=1
    and (select count(*) from public.internal_org_people person where person.auth_user_id=config.approver_user_id)=1
    and length(btrim(applicant_details.work_email))<=254 and lower(btrim(applicant_details.work_email)) ~ '^[^[:space:]@,;]+@[^[:space:]@,;]+\.[^[:space:]@,;]+$'
    and length(btrim(approver_details.work_email))<=254 and lower(btrim(approver_details.work_email)) ~ '^[^[:space:]@,;]+@[^[:space:]@,;]+\.[^[:space:]@,;]+$'
    and (select count(*) from private.employee_directory_details d where lower(btrim(d.work_email))=lower(btrim(applicant_details.work_email)))=1
    and (select count(*) from private.employee_directory_details d where lower(btrim(d.work_email))=lower(btrim(approver_details.work_email)))=1
$$;
revoke all on function private.sr_mail_recipients(uuid) from public,anon,authenticated,service_role;

create or replace function public.claim_subscription_request_mail(p_request_id uuid default null,p_limit integer default 25)
returns table(request_id uuid,version bigint,claim_token uuid,payload jsonb)
language plpgsql security definer set search_path='' as $$
declare item record; token uuid; previous private.subscription_request_mail_deliveries;
begin
  if p_limit is null or p_limit<1 or p_limit>25 then raise exception 'Invalid claim limit.' using errcode='22023'; end if;
  perform pg_advisory_xact_lock_shared(hashtextextended('mam:directory-role-control',0));
  perform 1 from private.subscription_request_config c where c.singleton for share;
  if not exists(select 1 from private.subscription_request_config c where c.singleton and c.enabled) then return; end if;
  if not exists(select 1 from private.subscription_request_config c
    join public.internal_org_people person on person.id=c.approver_person_id and person.auth_user_id=c.approver_user_id
    join private.employee_directory_details details on details.person_id=person.id
    cross join lateral private.portal_role_policy(c.approver_user_id) policy
    where c.singleton and c.enabled and policy.person_id=person.id
      and (select count(*) from public.internal_org_people p where p.auth_user_id=c.approver_user_id)=1
      and length(btrim(details.work_email))<=254 and lower(btrim(details.work_email)) ~ '^[^[:space:]@,;]+@[^[:space:]@,;]+\.[^[:space:]@,;]+$'
      and (select count(*) from private.employee_directory_details d where lower(btrim(d.work_email))=lower(btrim(details.work_email)))=1) then
    raise exception 'Subscription request approver is unavailable.' using errcode='55000';
  end if;
  for item in
    select n.request_id,n.version,e.payload,recipients.applicant_name,recipients.applicant_email,recipients.approver_email
    from private.subscription_request_notifications n
    join private.subscription_requests r on r.id=n.request_id and r.version=n.version and r.status='submitted'
    join private.subscription_request_events e on e.request_id=n.request_id and e.version=n.version and e.operation='submit'
    cross join lateral private.sr_mail_recipients(r.id) recipients
    left join private.subscription_request_mail_deliveries d on d.request_id=n.request_id and d.version=n.version
    where n.event='submit' and (p_request_id is null or n.request_id=p_request_id)
      and d.delivered_at is null and (d.claimed_at is null or d.claimed_at<clock_timestamp()-interval '15 minutes')
      and not exists(select 1 from private.notification_delivery_receipts receipt
        where receipt.event_key='subscription-request:'||n.request_id::text||':'||n.version::text)
    order by n.created_at,n.request_id limit p_limit for update of r skip locked
  loop
    insert into private.subscription_request_mail_deliveries(request_id,version) values(item.request_id,item.version) on conflict do nothing;
    select * into previous from private.subscription_request_mail_deliveries d where d.request_id=item.request_id and d.version=item.version for update;
    if previous.delivered_at is not null or previous.claimed_at>clock_timestamp()-interval '15 minutes' then continue; end if;
    token:=extensions.gen_random_uuid();
    update private.subscription_request_mail_deliveries d set claim_token=token,claimed_at=clock_timestamp() where d.request_id=item.request_id and d.version=item.version;
    return query select item.request_id,item.version,token,jsonb_build_object(
      'version',2,'event','subscription-request-submitted','deliveryId','subscription-request:'||item.request_id::text||':'||item.version::text,
      'applicantName',item.applicant_name,'applicantWorkEmail',item.applicant_email,'approverWorkEmail',item.approver_email,
      'request',jsonb_build_object('service',item.payload->>'service','plan',item.payload->>'plan','purpose',item.payload->>'purpose',
        'company',item.payload->>'company','duration',item.payload->>'duration','billing',item.payload->>'billing',
        'currency',item.payload->>'currency','quoteCents',item.payload->'quoteCents','audEstimateCents',item.payload->'audEstimateCents',
        'noQuoteReason',item.payload->>'noQuoteReason','intendedUsers',item.payload->>'intendedUsers','formVersion',item.payload->'formVersion',
        'monthlyCostCents',item.payload->'monthlyCostCents','annualCostCents',item.payload->'annualCostCents',
        'comparisonUnavailableReason',item.payload->>'comparisonUnavailableReason','payment',item.payload->>'payment',
        'cardLabel',case when item.payload->>'payment'='card' then item.payload->>'cardLabel' end,
        'cardHolder',case when item.payload->>'payment'='card' then item.payload->>'cardHolder' end));
  end loop;
end $$;

create function public.reserve_subscription_request_mail(p_event_key text,p_recipient text,p_cc text,p_legacy_event_key text default null)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare target private.subscription_requests%rowtype; applicant_email text; approver_email text; expected_cc text;
begin
  if p_event_key is null or length(p_event_key)>160
    or p_event_key !~ '^subscription-request:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:[1-9][0-9]*$'
    or split_part(p_event_key,':',3)::numeric>9223372036854775807 or p_legacy_event_key is not null then
    raise exception 'Invalid subscription request reservation.' using errcode='22023';
  end if;
  perform pg_advisory_xact_lock_shared(hashtextextended('mam:directory-role-control',0));
  perform 1 from private.subscription_request_config c where c.singleton for share;
  select r.* into target from private.subscription_requests r where r.id=split_part(p_event_key,':',2)::uuid for update;
  if exists(select 1 from private.notification_delivery_receipts r where r.event_key=p_event_key) then
    return public.reserve_notification_delivery(p_event_key,p_recipient,p_cc,null);
  end if;
  perform 1 from public.profiles p where p.id=target.applicant
    or p.id in(select approver_user_id from private.subscription_request_config c where c.singleton) for share;
  perform 1 from public.internal_org_people p where p.auth_user_id=target.applicant
    or p.id in(select approver_person_id from private.subscription_request_config c where c.singleton) for share;
  perform 1 from private.employee_directory_details d where d.person_id in(
    select p.id from public.internal_org_people p where p.auth_user_id=target.applicant
      or p.id in(select approver_person_id from private.subscription_request_config c where c.singleton)) for share;
  if target.id is not null and target.status='submitted' and target.version=split_part(p_event_key,':',3)::bigint
    and exists(select 1 from private.subscription_request_events e
      join private.subscription_request_notifications n on n.request_id=e.request_id and n.version=e.version and n.event='submit'
      where e.request_id=target.id and e.version=target.version and e.operation='submit') then
    select r.applicant_email,r.approver_email into applicant_email,approver_email from private.sr_mail_recipients(target.id) r;
  end if;
  expected_cc:=case when applicant_email=approver_email then '' else applicant_email end;
  if approver_email is null or approver_email is distinct from p_recipient or expected_cc is distinct from p_cc then
    return private.notification_delivery_rejection(p_event_key,'subscription-request-unavailable',false);
  end if;
  return public.reserve_notification_delivery(p_event_key,p_recipient,p_cc,null);
end;
$$;
revoke all on function public.reserve_subscription_request_mail(text,text,text,text) from public,anon,authenticated,service_role;
grant execute on function public.reserve_subscription_request_mail(text,text,text,text) to service_role;

create temporary table subscription_penny_function_after on commit drop as
select s.signature,pg_get_functiondef(p.oid) definition,
  (to_jsonb(p)-array['prosrc','prosqlbody','proargdefaults'])||jsonb_build_object('parameter_defaults',pg_get_expr(p.proargdefaults,0)) metadata,
  p.oid::regprocedure::text||':'||p.proowner::text||':'||coalesce(p.proacl::text,'default') acl_definition,
  jsonb_build_object('owner',pg_get_userbyid(p.proowner),'acl',p.proacl::text,'security_definer',p.prosecdef,'config',p.proconfig) portable
from subscription_penny_function_spec s join pg_proc p on p.oid=to_regprocedure(s.signature);
create temporary table subscription_penny_catalog_after on commit drop as select * from pg_temp.subscription_penny_catalog();
create temporary table subscription_penny_catalog_normalized on commit drop as
select definition from subscription_penny_catalog_after
except all (select definition from subscription_penny_function_after union all select acl_definition from subscription_penny_function_after);
insert into subscription_penny_catalog_normalized
select definition from subscription_penny_function_before union all select acl_definition from subscription_penny_function_before;
create function pg_temp.subscription_penny_assert_delta() returns void language plpgsql set search_path='' as $$
begin
  if (select count(*) from subscription_penny_function_after)<>3
    or exists(select 1 from subscription_penny_function_spec s join subscription_penny_function_after a using(signature)
      where encode(extensions.digest(a.definition,'sha256'),'hex') is distinct from s.after_sha256
        or (not s.is_existing and a.portable is distinct from s.new_metadata))
    or exists(select 1 from subscription_penny_function_before b join subscription_penny_function_after a using(signature)
      where b.metadata is distinct from a.metadata or b.acl_definition is distinct from a.acl_definition)
    or exists((select definition collate "C" from subscription_penny_catalog_before except all select definition collate "C" from subscription_penny_catalog_normalized)
      union all (select definition collate "C" from subscription_penny_catalog_normalized except all select definition collate "C" from subscription_penny_catalog_before))
    or exists((select definition collate "C" from pg_temp.subscription_penny_catalog() except all select definition collate "C" from subscription_penny_catalog_after)
      union all (select definition collate "C" from subscription_penny_catalog_after except all select definition collate "C" from pg_temp.subscription_penny_catalog()))
    or exists(select 1 from subscription_penny_function_after a join pg_proc p on p.oid=to_regprocedure(a.signature)
      where a.metadata is distinct from (to_jsonb(p)-array['prosrc','prosqlbody','proargdefaults'])||jsonb_build_object('parameter_defaults',pg_get_expr(p.proargdefaults,0)))
    or pg_temp.subscription_penny_security() is distinct from (select value from subscription_penny_security_before)
    or pg_temp.subscription_penny_data() is distinct from (select value from subscription_penny_data_before) then
    raise exception 'Subscription request approval tasks contain changes outside the reviewed delta.' using errcode='55000';
  end if;
end;
$$;
set constraints all immediate;
select pg_temp.subscription_penny_assert_delta();
update private.confirmed_test_purge_schema set schema_hash=private.confirmed_test_purge_schema_hash() where singleton;
set constraints all immediate;
select pg_temp.subscription_penny_assert_delta();
do $subscription_penny_final$ begin
  if private.confirmed_test_purge_schema_hash() is distinct from
    (select schema_hash from private.confirmed_test_purge_schema where singleton) then
    raise exception 'Subscription request approval final fingerprint differs.' using errcode='55000';
  end if;
end $subscription_penny_final$;
commit;
