begin;
set local lock_timeout='5s';
set local statement_timeout='30s';
set local search_path='';
select pg_advisory_xact_lock(hashtextextended('mam:directory-role-control',0));

do $manager_mail_catalog_lock$
begin
  if not pg_try_advisory_xact_lock(hashtextextended('confirmed-test-purge',0)) then
    raise exception 'Performance manager mail purge catalog busy.' using errcode='55P03';
  end if;
  lock table private.confirmed_test_purge_schema,private.performance_reviews,private.performance_review_events,private.performance_review_operations,private.performance_review_mail_outbox,private.performance_review_notifications,private.performance_review_meeting_requests,private.notification_delivery_receipts in share row exclusive mode nowait;
  if (select count(*) from private.confirmed_test_purge_schema)<>1 then
    raise exception 'Performance manager mail purge baseline differs.' using errcode='55000';
  end if;
end $manager_mail_catalog_lock$;
create temporary table performance_manager_mail_catalog_before on commit drop as
select schema_hash stored_hash,private.confirmed_test_purge_schema_hash() actual_hash
from private.confirmed_test_purge_schema where singleton;
create temporary table performance_manager_mail_function_spec(signature text primary key,body_hash text) on commit drop;
insert into performance_manager_mail_function_spec values
  ('public.claim_performance_review_mail(uuid,integer)','93a24fdf6f9b294ea848dd061d62b213688729dc514a78ab09628c3d9cfbb901'),
  ('public.begin_performance_review_mail(uuid,uuid,text)','272eedabe7bab2ce4473c742519c639e6c3d61157001833c85839c01f84763e5'),
  ('public.list_performance_review_meeting_imports(integer)','aa54a4ce793d379fb52b79a034bcb8712604fafd5ddd9946f53f17eedb5d05f4'),
  ('public.import_performance_review_meeting(uuid,text,jsonb)','0a1603516f471ce0382e5bd294588f2586d82a7848f90d6ebf730dbd38d52262'),
  ('private.performance_review_final_recipient(private.performance_reviews)',null),
  ('public.begin_performance_review_manager_mail(uuid,uuid,text,text)',null);
do $manager_mail_catalog_projection$
declare query text; anchor text;
begin
  if exists(select 1 from pg_temp.performance_manager_mail_function_spec s left join pg_proc p on p.oid=to_regprocedure(s.signature)
    where (s.body_hash is null and p.oid is not null) or (s.body_hash is not null and encode(extensions.digest(p.prosrc,'sha256'),'hex') is distinct from s.body_hash)) then
    raise exception 'Performance manager mail predecessor differs.' using errcode='55000';
  end if;
  select prosrc into query from pg_proc where oid='private.confirmed_test_purge_schema_hash()'::regprocedure;
  if encode(extensions.digest(query,'sha256'),'hex') is distinct from 'c142665fb247c8761de408ce241e2f97aabe719c5d0801a5c53905892dd3de16' then
    raise exception 'Performance manager mail catalog collector differs.' using errcode='55000';
  end if;
  anchor:=E'select encode(extensions.digest(coalesce(string_agg(definition,E''\\n'' order by definition),''''),''sha256''),''hex'') from (';
  query:=replace(query,anchor,'select definition from (');
  query:=replace(query,'and p.prokind=''f''',
    'and p.prokind=''f'' and not exists(select 1 from pg_temp.performance_manager_mail_function_spec s where to_regprocedure(s.signature)=p.oid)');
  execute 'create function pg_temp.performance_manager_mail_preserved_catalog() returns table(definition text) language sql stable set search_path='''' as '||quote_literal(query);
end $manager_mail_catalog_projection$;
create temporary table performance_manager_mail_preserved_before on commit drop as
select * from pg_temp.performance_manager_mail_preserved_catalog();
create temporary table performance_manager_mail_metadata_before on commit drop as
select signature,to_jsonb(p)-'prosrc'-'proacl'-'proargdefaults' metadata,
  regexp_replace(p.proargdefaults::text,' :location -?[0-9]+',' :location -1','g') default_tree
from pg_temp.performance_manager_mail_function_spec s join pg_proc p on p.oid=to_regprocedure(s.signature);
create temporary table performance_manager_mail_rows_before on commit drop as
select 'performance_reviews' kind,id::text key,to_jsonb(r) document from private.performance_reviews r union all
select 'performance_review_events' kind,id::text key,to_jsonb(r) document from private.performance_review_events r union all
select 'performance_review_operations' kind,actor_user_id::text||':'||operation_id::text key,to_jsonb(r) document from private.performance_review_operations r union all
select 'performance_review_mail_outbox' kind,delivery_id::text key,to_jsonb(r) document from private.performance_review_mail_outbox r union all
select 'performance_review_notifications' kind,delivery_id::text key,to_jsonb(r) document from private.performance_review_notifications r union all
select 'performance_review_meeting_requests' kind,review_id::text key,to_jsonb(r) document from private.performance_review_meeting_requests r union all
select 'notification_delivery_receipts' kind,event_key::text key,to_jsonb(r) document from private.notification_delivery_receipts r;

create function private.performance_review_final_recipient(p_review private.performance_reviews)
returns text language sql stable security definer set search_path='' as $$
  select lower(btrim(detail.work_email))
  from public.internal_org_people employee
  join public.internal_org_people manager on manager.id=p_review.assigned_manager_person_id and manager.company_key=employee.company_key
  cross join lateral private.portal_role_policy(employee.auth_user_id) ep
  cross join lateral private.portal_role_policy(manager.auth_user_id) mp
  join private.employee_directory_details detail on detail.person_id=manager.id
  where p_review.finalised_at is not null and p_review.final_document is not null and employee.id=p_review.employee_person_id and employee.id<>manager.id
    and employee.node_kind='person' and employee.is_active and manager.node_kind='person' and manager.is_active
    and ep.person_id=employee.id and ep.app_role in ('employee','manager','account')
    and mp.person_id=manager.id and mp.app_role='manager'
    and p_review.employee_identity->>'id'=employee.id::text and p_review.manager_identity->>'id'=manager.id::text
    and private.performance_review_text(p_review.employee_identity->'name') and btrim(p_review.employee_identity->>'name')<>''
    and private.performance_review_text(p_review.manager_identity->'name') and btrim(p_review.manager_identity->>'name')<>''
    and detail.work_email is not null and length(lower(btrim(detail.work_email)))<=254
    and detail.work_email !~ '[[:cntrl:]]'
    and lower(btrim(detail.work_email)) ~ '^[^[:space:]@,;]+@[^[:space:]@,;]+\.[^[:space:]@,;]+$'
    and (lower(btrim(detail.work_email))<>'careers@mobilityaccess.com.au' and lower(btrim(detail.work_email)) ~ '@(mobilityaccess\.com\.au|equipsy\.com\.au)$')
    and (select count(*) from private.employee_directory_details other where lower(btrim(other.work_email))=lower(btrim(detail.work_email)))=1

  union all
  select recipient.email
  from public.internal_org_people employee
  cross join lateral private.portal_role_policy(employee.auth_user_id) ep
  join public.profiles reviewer on reviewer.id=p_review.assigned_admin_user_id
  cross join lateral private.portal_role_policy(reviewer.id) rp
  left join private.employee_directory_details employee_detail on employee_detail.person_id=employee.id
  left join private.employee_directory_details reviewer_detail on reviewer_detail.person_id=rp.person_id
  left join lateral (
    select m.id,md.work_email
    from private.resolve_internal_org_employee_manager(employee.id) candidate
    join public.internal_org_people m on m.id=candidate.manager_id and m.company_key=employee.company_key
    cross join lateral private.portal_role_policy(m.auth_user_id) mp
    left join private.employee_directory_details md on md.person_id=m.id
    where m.id<>employee.id and m.node_kind='person' and m.is_active
      and mp.person_id=m.id and mp.app_role='manager'
      and (ep.app_role='admin' or private.performance_review_candidate(employee.id,m.id))
  ) org_manager on true
  cross join lateral (select lower(btrim(case when org_manager.id is not null then org_manager.work_email
    when rp.person_id is not null then reviewer_detail.work_email end)) email) recipient
  where p_review.finalised_at is not null and p_review.final_document is not null and p_review.assigned_manager_person_id is null and employee.id=p_review.employee_person_id
    and employee.node_kind='person' and employee.is_active and ep.person_id=employee.id
    and ep.app_role in ('employee','manager','account','admin') and rp.app_role in ('admin','system_admin')
    and employee.id is distinct from rp.person_id
    and p_review.employee_identity->>'id'=employee.id::text and p_review.manager_identity->>'id'=reviewer.id::text
    and private.performance_review_text(p_review.employee_identity->'name') and btrim(p_review.employee_identity->>'name')<>''
    and private.performance_review_text(p_review.manager_identity->'name') and btrim(p_review.manager_identity->>'name')<>''
    and recipient.email is not null and length(recipient.email)<=254 and recipient.email !~ '[[:cntrl:]]'
    and recipient.email ~ '^[^[:space:]@,;]+@[^[:space:]@,;]+\.[^[:space:]@,;]+$'
    and (recipient.email<>'careers@mobilityaccess.com.au' and recipient.email ~ '@(mobilityaccess\.com\.au|equipsy\.com\.au)$')
    and (select count(*) from private.employee_directory_details other where lower(btrim(other.work_email))=recipient.email)=1

$$;
revoke all on function private.performance_review_final_recipient(private.performance_reviews) from public,anon,authenticated,service_role;

create or replace function public.claim_performance_review_mail(p_review_id uuid default null,p_limit integer default 10)
returns table(delivery_id uuid,review_id uuid,claim_token uuid,payload jsonb)
language plpgsql volatile security definer set search_path='' as $$
begin
  if p_limit is null or p_limit not between 1 and 10 then raise exception 'Invalid mail claim limit.' using errcode='22023'; end if;
  perform pg_advisory_xact_lock_shared(hashtextextended('mam:directory-role-control',0));
  return query
    with selected as (
      select o.delivery_id,private.performance_review_final_recipient(r) recipient
      from private.performance_review_mail_outbox o join private.performance_reviews r on r.id=o.review_id
      where o.state='queued' and (p_review_id is null or o.review_id=p_review_id)
        and r.finalised_at is not null and r.final_document is not null
      order by o.queued_at,o.delivery_id limit p_limit for update of o,r skip locked
    ), claimed as (
      update private.performance_review_mail_outbox o set state='claimed',claim_token=gen_random_uuid(),claimed_at=clock_timestamp()
      from selected s where o.delivery_id=s.delivery_id and o.state='queued'
      returning o.delivery_id,o.review_id,o.claim_token,s.recipient
    )
    select c.delivery_id,c.review_id,c.claim_token,jsonb_build_object('reviewId',r.id,'reviewCode',r.final_document->>'code','finalisedAt',r.finalised_at,'managerNote',r.manager_note,'document',r.final_document,'recipient',c.recipient)
    from claimed c join private.performance_reviews r on r.id=c.review_id;
end $$;
revoke all on function public.claim_performance_review_mail(uuid,integer) from public,anon,authenticated;
grant execute on function public.claim_performance_review_mail(uuid,integer) to service_role;
revoke all on function public.list_performance_review_meeting_imports(integer),public.import_performance_review_meeting(uuid,text,jsonb) from public,anon,authenticated,service_role;

create function public.begin_performance_review_manager_mail(p_delivery_id uuid,p_claim_token uuid,p_attachment_sha256 text,p_recipient text)
returns boolean language plpgsql volatile security definer set search_path='' as $$
declare review private.performance_reviews%rowtype; recipient text;
begin
  perform pg_advisory_xact_lock_shared(hashtextextended('mam:directory-role-control',0));
  select r.* into review from private.performance_reviews r
  join private.performance_review_mail_outbox o on o.review_id=r.id
  where o.delivery_id=p_delivery_id and o.claim_token=p_claim_token and o.state='claimed' for share of r;
  if not found then return false; end if;
  recipient:=private.performance_review_final_recipient(review);
  if recipient is null or recipient is distinct from p_recipient then return false; end if;
  return public.begin_performance_review_mail(p_delivery_id,p_claim_token,p_attachment_sha256);
end $$;
revoke all on function public.begin_performance_review_mail(uuid,uuid,text) from public,anon,authenticated,service_role;
revoke all on function public.begin_performance_review_manager_mail(uuid,uuid,text,text) from public,anon,authenticated;
grant execute on function public.begin_performance_review_manager_mail(uuid,uuid,text,text) to service_role;

do $manager_mail_catalog_after$
declare baseline record;
begin
  select * into strict baseline from pg_temp.performance_manager_mail_catalog_before;
  if exists((select definition collate "C" from pg_temp.performance_manager_mail_preserved_before
      except all select definition collate "C" from pg_temp.performance_manager_mail_preserved_catalog())
    union all (select definition collate "C" from pg_temp.performance_manager_mail_preserved_catalog()
      except all select definition collate "C" from pg_temp.performance_manager_mail_preserved_before))
    or exists(with current_rows as (select 'performance_reviews' kind,id::text key,to_jsonb(r) document from private.performance_reviews r union all
select 'performance_review_events' kind,id::text key,to_jsonb(r) document from private.performance_review_events r union all
select 'performance_review_operations' kind,actor_user_id::text||':'||operation_id::text key,to_jsonb(r) document from private.performance_review_operations r union all
select 'performance_review_mail_outbox' kind,delivery_id::text key,to_jsonb(r) document from private.performance_review_mail_outbox r union all
select 'performance_review_notifications' kind,delivery_id::text key,to_jsonb(r) document from private.performance_review_notifications r union all
select 'performance_review_meeting_requests' kind,review_id::text key,to_jsonb(r) document from private.performance_review_meeting_requests r union all
select 'notification_delivery_receipts' kind,event_key::text key,to_jsonb(r) document from private.notification_delivery_receipts r) (select * from pg_temp.performance_manager_mail_rows_before except all select * from current_rows) union all (select * from current_rows except all select * from pg_temp.performance_manager_mail_rows_before))
    or exists(select 1 from pg_temp.performance_manager_mail_metadata_before b join pg_proc p on p.oid=to_regprocedure(b.signature) where to_jsonb(p)-'prosrc'-'proacl'-'proargdefaults' is distinct from b.metadata
      or regexp_replace(p.proargdefaults::text,' :location -?[0-9]+',' :location -1','g') is distinct from b.default_tree)
    or exists(select 1 from pg_temp.performance_manager_mail_function_spec s join pg_proc p on p.oid=to_regprocedure(s.signature),
      lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) acl
      where acl.grantee<>p.proowner and not (acl.grantee='service_role'::regrole and acl.privilege_type='EXECUTE' and not acl.is_grantable and s.signature in ('public.claim_performance_review_mail(uuid,integer)','public.begin_performance_review_manager_mail(uuid,uuid,text,text)')))
    or not has_function_privilege('service_role','public.claim_performance_review_mail(uuid,integer)','execute')
    or not has_function_privilege('service_role','public.begin_performance_review_manager_mail(uuid,uuid,text,text)','execute')
    or (select schema_hash from private.confirmed_test_purge_schema where singleton) is distinct from baseline.stored_hash then
    raise exception 'Performance manager mail unrelated catalog delta.' using errcode='55000';
  end if;
  if baseline.actual_hash=baseline.stored_hash then
    update private.confirmed_test_purge_schema set schema_hash=private.confirmed_test_purge_schema_hash()
      where singleton and schema_hash=baseline.stored_hash;
    if not found or private.confirmed_test_purge_schema_hash() is distinct from (select schema_hash from private.confirmed_test_purge_schema where singleton) then
      raise exception 'Performance manager mail final purge fingerprint differs.' using errcode='55000';
    end if;
  end if;
end $manager_mail_catalog_after$;

commit;
