begin;
set local search_path='';
select private.lock_notification_delivery_store();
select pg_advisory_xact_lock(hashtextextended('mam:directory-role-control',0));

do $cc_catalog_lock$
begin
  if not pg_try_advisory_xact_lock(hashtextextended('confirmed-test-purge',0)) then
    raise exception 'Performance CC purge catalog busy.' using errcode='55P03';
  end if;
  lock table private.confirmed_test_purge_schema in share row exclusive mode nowait;
  lock table private.performance_review_notifications in access exclusive mode;
  if (select count(*) from private.confirmed_test_purge_schema)<>1 then
    raise exception 'Performance CC purge baseline differs.' using errcode='55000';
  end if;
end $cc_catalog_lock$;
create temporary table performance_cc_catalog_before on commit drop as
select schema_hash stored_hash,private.confirmed_test_purge_schema_hash() actual_hash
from private.confirmed_test_purge_schema where singleton;
create temporary table performance_cc_rows_before on commit drop as
select delivery_id,to_jsonb(r) document from private.performance_review_notifications r;
create temporary table performance_cc_function_spec(signature text primary key,body_hash text) on commit drop;
insert into performance_cc_function_spec values
  ('public.claim_performance_review_notifications(uuid,integer)','79c0cd9116ef80d6c8a0790b78c9eabd58d4ef37cd4c6f3e8e24d25c58dbcc2b'),
  ('public.reserve_performance_review_notification_mail(text,text,text,uuid,text)','ea5827a35292fdd1ec26e946ad20fbc23c2ecf15c0be509e94efe08e5f3d5237'),
  ('public.finish_performance_review_notification(uuid,uuid,boolean)','f7f5aeec885dab09a47ae4113ed62e295b71192303f3b4258d58b02bc9b8a584');

do $cc_catalog_projection$
declare query text; anchor text;
begin
  if exists(select 1 from pg_temp.performance_cc_function_spec s where
    encode(extensions.digest((select p.prosrc from pg_proc p where p.oid=to_regprocedure(s.signature)),'sha256'),'hex') is distinct from s.body_hash)
    or exists(select 1 from pg_attribute where attrelid='private.performance_review_notifications'::regclass and attname='cc' and not attisdropped) then
    raise exception 'Performance CC predecessor differs.' using errcode='55000';
  end if;
  select prosrc into query from pg_proc where oid='private.confirmed_test_purge_schema_hash()'::regprocedure;
  if encode(extensions.digest(query,'sha256'),'hex') is distinct from 'c142665fb247c8761de408ce241e2f97aabe719c5d0801a5c53905892dd3de16' then
    raise exception 'Performance CC catalog collector differs.' using errcode='55000';
  end if;
  anchor:=E'select encode(extensions.digest(coalesce(string_agg(definition,E''\n'' order by definition),''''),''sha256''),''hex'') from (';
  query:=replace(query,anchor,'select definition from (');
  query:=replace(query,'and a.attnum>0 and not a.attisdropped',
    'and a.attnum>0 and not a.attisdropped and not (a.attrelid=''private.performance_review_notifications''::regclass and a.attname=''cc'')');
  query:=replace(query,'from pg_constraint where connamespace',
    'from pg_constraint where not (conrelid=''private.performance_review_notifications''::regclass and conname=''performance_review_notifications_cc_check'') and (connamespace');
  query:=replace(query,'union all select tgrelid',') union all select tgrelid');
  query:=replace(query,'and p.prokind=''f''',
    'and p.prokind=''f'' and not exists(select 1 from pg_temp.performance_cc_function_spec s where to_regprocedure(s.signature)=p.oid)');
  execute 'create function pg_temp.performance_cc_preserved_catalog() returns table(definition text) language sql stable set search_path='''' as '||quote_literal(query);
end $cc_catalog_projection$;
create temporary table performance_cc_preserved_before on commit drop as
select * from pg_temp.performance_cc_preserved_catalog();
create temporary table performance_cc_function_metadata_before on commit drop as
select s.signature,to_jsonb(p)-'prosrc'-'proargdefaults' metadata,
  regexp_replace(p.proargdefaults::text,' :location -?[0-9]+',' :location -1','g') default_tree
from pg_temp.performance_cc_function_spec s join pg_proc p on p.oid=to_regprocedure(s.signature);

alter table private.performance_review_notifications add column cc text;
update private.performance_review_notifications set cc='' where claim_token is not null;
alter table private.performance_review_notifications add constraint performance_review_notifications_cc_check
  check((claim_token is null and cc is null) or (claim_token is not null and cc is not null
    and cc in ('','careers@mobilityaccess.com.au') and (recipient<>'careers@mobilityaccess.com.au' or cc='')));

create or replace function public.claim_performance_review_notifications(p_review_id uuid default null,p_limit integer default 1)
returns table(delivery_id uuid,review_id uuid,claim_token uuid,payload jsonb)
language plpgsql volatile security definer set search_path='' as $$
declare item record; review private.performance_reviews%rowtype; message jsonb; token uuid;
begin
  if p_limit is null or p_limit<1 or p_limit>10 then raise exception 'Invalid notification claim limit.' using errcode='22023'; end if;
  perform pg_advisory_xact_lock_shared(hashtextextended('mam:directory-role-control',0));
  for item in select n.delivery_id,n.review_id,n.event from private.performance_review_notifications n
    join private.performance_reviews r on r.id=n.review_id
    where n.state='queued' and (p_review_id is null or n.review_id=p_review_id)
    order by n.queued_at,n.delivery_id limit p_limit for update of n,r skip locked
  loop
    select r.* into review from private.performance_reviews r where r.id=item.review_id;
    perform private.performance_review_lock_people(array[review.employee_person_id,review.assigned_manager_person_id]);
    perform 1 from public.profiles p where p.id=review.assigned_admin_user_id for share;
    perform private.performance_review_lock_people(array[(select p.id from public.internal_org_people p where p.auth_user_id=review.assigned_admin_user_id and p.node_kind='person' and p.is_active)]);
    perform 1 from private.employee_directory_details d where d.person_id in(review.employee_person_id,review.assigned_manager_person_id,(select p.id from public.internal_org_people p where p.auth_user_id=review.assigned_admin_user_id and p.node_kind='person' and p.is_active)) order by d.person_id for share;
    message:=private.performance_review_notification_payload(review,item.event);
    if message is null then
      update private.performance_review_notifications n set state='needs_review',finished_at=clock_timestamp() where n.delivery_id=item.delivery_id;
      continue;
    end if;
    message:=message||jsonb_build_object('cc',case when message->>'recipient'='careers@mobilityaccess.com.au' then '' else 'careers@mobilityaccess.com.au' end);
    token:=gen_random_uuid();
    update private.performance_review_notifications n set state='claimed',claim_token=token,recipient=message->>'recipient',cc=message->>'cc',claimed_at=clock_timestamp() where n.delivery_id=item.delivery_id;
    delivery_id:=item.delivery_id;review_id:=item.review_id;claim_token:=token;payload:=message;
    return next;
  end loop;
end $$;

create or replace function public.reserve_performance_review_notification_mail(
  p_event_key text,p_recipient text,p_cc text,p_claim_token uuid,p_legacy_event_key text default null
) returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare delivery private.performance_review_notifications%rowtype; review private.performance_reviews%rowtype; message jsonb;
begin
  if p_event_key is null or p_event_key !~ '^performance-review:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:(started|self-submitted)$'
    or (p_cc is null or p_cc not in ('','careers@mobilityaccess.com.au')) or p_claim_token is null or p_legacy_event_key is not null then
    raise exception 'Invalid performance notification reservation.' using errcode='22023';
  end if;
  perform private.lock_notification_delivery_store();
  perform pg_advisory_xact_lock_shared(hashtextextended('mam:directory-role-control',0));
  select r.* into review from private.performance_reviews r where r.id=split_part(p_event_key,':',2)::uuid for update;
  select n.* into delivery from private.performance_review_notifications n where n.review_id=review.id
    and n.event=split_part(p_event_key,':',3) and n.claim_token=p_claim_token for update;
  if not found or delivery.recipient is distinct from p_recipient or delivery.cc is distinct from p_cc then
    return private.notification_delivery_rejection(p_event_key,'performance-notification-unavailable',false);
  end if;
  if exists(select 1 from private.notification_delivery_receipts r where r.event_key=p_event_key) then
    return public.reserve_notification_delivery(p_event_key,p_recipient,p_cc,null);
  end if;
  if delivery.state<>'claimed' then
    return private.notification_delivery_rejection(p_event_key,'performance-notification-unavailable',false);
  end if;
  perform private.performance_review_lock_people(array[review.employee_person_id,review.assigned_manager_person_id]);
  perform 1 from public.profiles p where p.id=review.assigned_admin_user_id for share;
  perform private.performance_review_lock_people(array[(select p.id from public.internal_org_people p where p.auth_user_id=review.assigned_admin_user_id and p.node_kind='person' and p.is_active)]);
  perform 1 from private.employee_directory_details d where d.person_id in(review.employee_person_id,review.assigned_manager_person_id,(select p.id from public.internal_org_people p where p.auth_user_id=review.assigned_admin_user_id and p.node_kind='person' and p.is_active)) order by d.person_id for share;
  message:=private.performance_review_notification_payload(review,delivery.event);
  if message is null or message->>'recipient' is distinct from p_recipient then
    update private.performance_review_notifications n set state='needs_review',finished_at=clock_timestamp() where n.delivery_id=delivery.delivery_id;
    return private.notification_delivery_rejection(p_event_key,'performance-notification-unavailable',false);
  end if;
  return public.reserve_notification_delivery(p_event_key,p_recipient,p_cc,null);
end $$;

create or replace function public.finish_performance_review_notification(p_delivery_id uuid,p_claim_token uuid,p_delivered boolean)
returns boolean language plpgsql volatile security definer set search_path='' as $$
declare delivery private.performance_review_notifications%rowtype;
begin
  if p_delivery_id is null or p_claim_token is null or p_delivered is null then return false; end if;
  perform private.lock_notification_delivery_store();
  select n.* into delivery from private.performance_review_notifications n
    where n.delivery_id=p_delivery_id and n.claim_token=p_claim_token for update;
  if not found then return false; end if;
  if delivery.state='provider_accepted' then return p_delivered; end if;
  if delivery.state='needs_review' then return not p_delivered; end if;
  if delivery.state<>'claimed' then return false; end if;
  if p_delivered and not exists(select 1 from private.notification_delivery_receipts r
    where r.event_key='performance-review:'||delivery.review_id::text||':'||delivery.event
      and r.state='sent' and r.recipient=delivery.recipient and r.cc=delivery.cc) then return false; end if;
  update private.performance_review_notifications n set state=case when p_delivered then 'provider_accepted' else 'needs_review' end,
    finished_at=clock_timestamp() where n.delivery_id=delivery.delivery_id;
  return true;
end $$;
do $cc_catalog_after$
declare baseline record;
begin
  select * into strict baseline from pg_temp.performance_cc_catalog_before;
  if exists((select definition collate "C" from pg_temp.performance_cc_preserved_before
      except all select definition collate "C" from pg_temp.performance_cc_preserved_catalog())
    union all (select definition collate "C" from pg_temp.performance_cc_preserved_catalog()
      except all select definition collate "C" from pg_temp.performance_cc_preserved_before))
    or exists(select 1 from pg_temp.performance_cc_function_metadata_before b
      join pg_proc p on p.oid=to_regprocedure(b.signature) where to_jsonb(p)-'prosrc'-'proargdefaults' is distinct from b.metadata
        or regexp_replace(p.proargdefaults::text,' :location -?[0-9]+',' :location -1','g') is distinct from b.default_tree)
    or exists((select delivery_id,document from pg_temp.performance_cc_rows_before
      except all select delivery_id,to_jsonb(r)-'cc' from private.performance_review_notifications r)
      union all (select delivery_id,to_jsonb(r)-'cc' from private.performance_review_notifications r
      except all select delivery_id,document from pg_temp.performance_cc_rows_before))
    or exists(select 1 from private.performance_review_notifications where cc is distinct from case when claim_token is not null then '' end)
    or not exists(select 1 from pg_attribute a where a.attrelid='private.performance_review_notifications'::regclass and a.attname='cc'
      and a.atttypid='text'::regtype and not a.attnotnull and not a.atthasdef and a.attacl is null and a.attgenerated='' and a.attidentity='')
    or (select schema_hash from private.confirmed_test_purge_schema where singleton) is distinct from baseline.stored_hash then
    raise exception 'Performance CC unrelated catalog or data delta.' using errcode='55000';
  end if;
  if baseline.actual_hash=baseline.stored_hash then
    update private.confirmed_test_purge_schema set schema_hash=private.confirmed_test_purge_schema_hash()
      where singleton and schema_hash=baseline.stored_hash;
    if not found or private.confirmed_test_purge_schema_hash() is distinct from (select schema_hash from private.confirmed_test_purge_schema where singleton) then
      raise exception 'Performance CC final purge fingerprint differs.' using errcode='55000';
    end if;
  end if;
end $cc_catalog_after$;

commit;
