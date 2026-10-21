begin;
set local search_path='';
select pg_advisory_xact_lock(hashtextextended('mam:directory-role-control',0));

do $self_submitted_manager_catalog_lock$
begin
  if not pg_try_advisory_xact_lock(hashtextextended('confirmed-test-purge',0)) then
    raise exception 'Performance self-submitted manager purge catalog busy.' using errcode='55P03';
  end if;
  lock table private.confirmed_test_purge_schema,private.performance_reviews,private.performance_review_events,private.performance_review_operations,private.performance_review_mail_outbox,private.performance_review_notifications,private.performance_review_meeting_requests,private.notification_delivery_receipts in share row exclusive mode nowait;
  if (select count(*) from private.confirmed_test_purge_schema)<>1 then
    raise exception 'Performance self-submitted manager purge baseline differs.' using errcode='55000';
  end if;
end $self_submitted_manager_catalog_lock$;
create temporary table performance_self_submitted_manager_catalog_before on commit drop as
select schema_hash stored_hash,private.confirmed_test_purge_schema_hash() actual_hash
from private.confirmed_test_purge_schema where singleton;
create temporary table performance_self_submitted_manager_function_spec(signature text primary key) on commit drop;
insert into performance_self_submitted_manager_function_spec values
  ('private.performance_review_notification_payload(private.performance_reviews,text)'),
  ('public.reserve_performance_review_notification_mail(text,text,text,uuid,text)');
do $self_submitted_manager_catalog_projection$
declare query text; anchor text;
begin
  select prosrc into query from pg_proc where oid='private.confirmed_test_purge_schema_hash()'::regprocedure;
  if encode(extensions.digest(query,'sha256'),'hex') is distinct from 'c142665fb247c8761de408ce241e2f97aabe719c5d0801a5c53905892dd3de16' then
    raise exception 'Performance self-submitted manager catalog collector differs.' using errcode='55000';
  end if;
  anchor:=E'select encode(extensions.digest(coalesce(string_agg(definition,E''\\n'' order by definition),''''),''sha256''),''hex'') from (';
  query:=replace(query,anchor,'select definition from (');
  query:=replace(query,'and p.prokind=''f''',
    'and p.prokind=''f'' and not exists(select 1 from pg_temp.performance_self_submitted_manager_function_spec s where to_regprocedure(s.signature)=p.oid)');
  execute 'create function pg_temp.performance_self_submitted_manager_preserved_catalog() returns table(definition text) language sql stable set search_path='''' as '||quote_literal(query);
end $self_submitted_manager_catalog_projection$;
create temporary table performance_self_submitted_manager_preserved_before on commit drop as
select * from pg_temp.performance_self_submitted_manager_preserved_catalog();

create temporary table performance_self_submitted_manager_metadata_before on commit drop as
select signature,to_jsonb(p)-'prosrc'-'proargdefaults' metadata,
  regexp_replace(p.proargdefaults::text,' :location -?[0-9]+',' :location -1','g') default_tree
from pg_temp.performance_self_submitted_manager_function_spec s join pg_proc p on p.oid=to_regprocedure(s.signature);
create temporary table performance_self_submitted_manager_rows_before on commit drop as
select 'performance_reviews' kind,id::text key,to_jsonb(r) document from private.performance_reviews r union all
select 'performance_review_events' kind,id::text key,to_jsonb(r) document from private.performance_review_events r union all
select 'performance_review_operations' kind,actor_user_id::text||':'||operation_id::text::text key,to_jsonb(r) document from private.performance_review_operations r union all
select 'performance_review_mail_outbox' kind,delivery_id::text key,to_jsonb(r) document from private.performance_review_mail_outbox r union all
select 'performance_review_notifications' kind,delivery_id::text key,to_jsonb(r) document from private.performance_review_notifications r union all
select 'performance_review_meeting_requests' kind,review_id::text key,to_jsonb(r) document from private.performance_review_meeting_requests r union all
select 'notification_delivery_receipts' kind,event_key::text key,to_jsonb(r) document from private.notification_delivery_receipts r;
do $self_submitted_manager_predecessor$
begin
 if current_setting('server_version_num')::integer/10000 not in(16,17) or exists(select 1 from (values
  ('private.performance_review_notification_payload(private.performance_reviews,text)','8bb85d530ceb4d9e64f4c872964c16268b45ad1e232a55f161b99effe65bcf49'),
  ('public.reserve_performance_review_notification_mail(text,text,text,uuid,text)','74f2ab33d8c2ea476e12cbc55b0e1f0ed4f214a97624bd4993cb8c335e3c9c3b'),
  ('private.performance_review_meeting_addresses(private.performance_reviews)','fc7c152c1b7b658293b49908ec18f4ed80ec36fdf0bbe4b82e11a27d92e932cb'),
  ('public.claim_performance_review_notifications(uuid,integer)','923ca0840fe9d2ee4b13aa5662467da9f3dd0fcbe816fe4ba9506977477468d8'),
  ('private.resolve_internal_org_employee_manager(uuid)','b7a5bf0f225f50d38538b5ee9882108f791c79353ea05b76061e151e44d6263e'),
  ('private.performance_review_candidate(uuid,uuid)','1c991608e47b3368b79ca7cf5d775b492960583f04b90107b51dc49168db3e38'),
  ('private.portal_role_policy(uuid)','f9c6cc5131294bcf3deb8e7c33109438783884aca8751d3b0cf5b39a67ab39f5')) expected(signature,body_hash) left join pg_proc p on p.oid=to_regprocedure(expected.signature) where encode(extensions.digest(p.prosrc,'sha256'),'hex') is distinct from expected.body_hash) then
  raise exception 'Performance self-submitted manager predecessor differs.' using errcode='55000';
 end if;
end $self_submitted_manager_predecessor$;

create or replace function private.performance_review_notification_payload(p_review private.performance_reviews,p_event text)
returns jsonb language sql stable security definer set search_path='' as $$
  select jsonb_build_object(
    'event',p_event,'eventKey','performance-review:'||p_review.id::text||':'||p_event,
    'reviewId',p_review.id,'reviewCode','PR-'||p_review.cycle||'-'||p_review.review_no,
    'cycle',p_review.cycle,'dueDate',p_review.due_date,'recipient',lower(btrim(detail.work_email)),
    'employeeName',p_review.employee_identity->>'name','managerName',p_review.manager_identity->>'name')
  from public.internal_org_people employee
  join public.internal_org_people manager on manager.id=p_review.assigned_manager_person_id and manager.company_key=employee.company_key
  cross join lateral private.portal_role_policy(employee.auth_user_id) ep
  cross join lateral private.portal_role_policy(manager.auth_user_id) mp
  join private.employee_directory_details detail on detail.person_id=case when p_event='started' then employee.id else manager.id end
  where p_event in('started','self-submitted') and employee.id=p_review.employee_person_id and employee.id<>manager.id
    and employee.node_kind='person' and employee.is_active and manager.node_kind='person' and manager.is_active
    and ep.person_id=employee.id and ep.app_role in ('employee','manager','account')
    and mp.person_id=manager.id and mp.app_role='manager'
    and p_review.employee_identity->>'id'=employee.id::text and p_review.manager_identity->>'id'=manager.id::text
    and private.performance_review_text(p_review.employee_identity->'name') and btrim(p_review.employee_identity->>'name')<>''
    and private.performance_review_text(p_review.manager_identity->'name') and btrim(p_review.manager_identity->>'name')<>''
    and ((p_event='started' and p_review.self_submitted_at is null)
      or (p_event='self-submitted' and p_review.self_submitted_at is not null and p_review.manager_completed_at is null and p_review.finalised_at is null))
    and detail.work_email is not null and length(lower(btrim(detail.work_email)))<=254
    and detail.work_email !~ '[[:cntrl:]]'
    and lower(btrim(detail.work_email)) ~ '^[^[:space:]@,;]+@[^[:space:]@,;]+\.[^[:space:]@,;]+$'
    and (p_event='started' or (lower(btrim(detail.work_email))<>'careers@mobilityaccess.com.au' and lower(btrim(detail.work_email)) ~ '@(mobilityaccess\.com\.au|equipsy\.com\.au)$'))
    and (select count(*) from private.employee_directory_details other where lower(btrim(other.work_email))=lower(btrim(detail.work_email)))=1

  union all
  select jsonb_build_object(
    'event',p_event,'eventKey','performance-review:'||p_review.id::text||':'||p_event,
    'reviewId',p_review.id,'reviewCode','PR-'||p_review.cycle||'-'||p_review.review_no,
    'cycle',p_review.cycle,'dueDate',p_review.due_date,'recipient',recipient.email,
    'employeeName',p_review.employee_identity->>'name','managerName',p_review.manager_identity->>'name')
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
    where p_event='self-submitted' and m.id<>employee.id and m.node_kind='person' and m.is_active
      and mp.person_id=m.id and mp.app_role='manager'
      and (ep.app_role='admin' or private.performance_review_candidate(employee.id,m.id))
  ) org_manager on true
  cross join lateral (select lower(btrim(case when p_event='started' then employee_detail.work_email
    when org_manager.id is not null then org_manager.work_email
    when rp.person_id is not null then reviewer_detail.work_email end)) email) recipient
  where p_event in('started','self-submitted') and p_review.assigned_manager_person_id is null and employee.id=p_review.employee_person_id
    and employee.node_kind='person' and employee.is_active and ep.person_id=employee.id
    and ep.app_role in ('employee','manager','account','admin') and rp.app_role in ('admin','system_admin')
    and employee.id is distinct from rp.person_id
    and p_review.employee_identity->>'id'=employee.id::text and p_review.manager_identity->>'id'=reviewer.id::text
    and private.performance_review_text(p_review.employee_identity->'name') and btrim(p_review.employee_identity->>'name')<>''
    and private.performance_review_text(p_review.manager_identity->'name') and btrim(p_review.manager_identity->>'name')<>''
    and ((p_event='started' and p_review.self_submitted_at is null)
      or (p_event='self-submitted' and p_review.self_submitted_at is not null and p_review.manager_completed_at is null and p_review.finalised_at is null))
    and recipient.email is not null and length(recipient.email)<=254 and recipient.email !~ '[[:cntrl:]]'
    and recipient.email ~ '^[^[:space:]@,;]+@[^[:space:]@,;]+\.[^[:space:]@,;]+$'
    and (p_event='started' or (recipient.email<>'careers@mobilityaccess.com.au' and recipient.email ~ '@(mobilityaccess\.com\.au|equipsy\.com\.au)$'))
    and (select count(*) from private.employee_directory_details other where lower(btrim(other.work_email))=recipient.email)=1

 union all
 select jsonb_build_object('event',p_event,'eventKey','performance-review:'||p_review.id::text||':'||p_event,
  'reviewId',p_review.id,'reviewCode','PR-'||p_review.cycle||'-'||p_review.review_no,'cycle',p_review.cycle,'dueDate',p_review.due_date,
  'recipient',(select string_agg(email,',' order by email collate "C") from(select distinct jsonb_array_elements_text(jsonb_build_array(addresses->>'managerEmail',addresses->>'employeeEmail')) email) recipients),
  'employeeName',p_review.employee_identity->>'name','managerName',p_review.manager_identity->>'name')
 from private.performance_review_meeting_requests request
 cross join lateral private.performance_review_meeting_addresses(p_review) addresses
 where p_event='manager-invited' and request.review_id=p_review.id and addresses is not null
  and p_review.manager_completed_at is not null and p_review.finalised_at is null
$$;

create or replace function public.reserve_performance_review_notification_mail(
  p_event_key text,p_recipient text,p_cc text,p_claim_token uuid,p_legacy_event_key text default null
) returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare delivery private.performance_review_notifications%rowtype; review private.performance_reviews%rowtype; message jsonb;
begin
  if p_event_key is null or p_event_key !~ '^performance-review:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:(started|self-submitted|manager-invited)$'
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
  perform private.performance_review_lock_people(array[review.employee_person_id,review.assigned_manager_person_id,(select manager_id from private.resolve_internal_org_employee_manager(review.employee_person_id) where review.assigned_manager_person_id is null)]);
  perform 1 from public.profiles p where p.id=review.assigned_admin_user_id for share;
  perform private.performance_review_lock_people(array[(select p.id from public.internal_org_people p where p.auth_user_id=review.assigned_admin_user_id and p.node_kind='person' and p.is_active)]);
  perform 1 from private.employee_directory_details d where d.person_id in(review.employee_person_id,review.assigned_manager_person_id,(select manager_id from private.resolve_internal_org_employee_manager(review.employee_person_id) where review.assigned_manager_person_id is null),(select p.id from public.internal_org_people p where p.auth_user_id=review.assigned_admin_user_id and p.node_kind='person' and p.is_active)) order by d.person_id for share;
  message:=private.performance_review_notification_payload(review,delivery.event);
  if delivery.event='manager-invited' and (p_cc<>'' or message is null or message->>'recipient' is distinct from p_recipient) then
    return private.notification_delivery_rejection(p_event_key,'performance-notification-unavailable',false);
  end if;
  if exists(select 1 from private.notification_delivery_receipts r where r.event_key=p_event_key) then
    return public.reserve_notification_delivery(p_event_key,p_recipient,p_cc,null);
  end if;
  if delivery.event='self-submitted' and p_cc<>'careers@mobilityaccess.com.au' then
    return private.notification_delivery_rejection(p_event_key,'performance-notification-unavailable',false);
  end if;
  if message is null or message->>'recipient' is distinct from p_recipient then
    update private.performance_review_notifications n set state='needs_review',finished_at=clock_timestamp() where n.delivery_id=delivery.delivery_id;
    return private.notification_delivery_rejection(p_event_key,'performance-notification-unavailable',false);
  end if;
  if delivery.state<>'claimed' then
    return private.notification_delivery_rejection(p_event_key,'performance-notification-unavailable',false);
  end if;
  return public.reserve_notification_delivery(p_event_key,p_recipient,p_cc,null);
end $$;

do $self_submitted_manager_catalog_after$
declare baseline record;
begin
  select * into strict baseline from pg_temp.performance_self_submitted_manager_catalog_before;
  if exists((select definition collate "C" from pg_temp.performance_self_submitted_manager_preserved_before
      except all select definition collate "C" from pg_temp.performance_self_submitted_manager_preserved_catalog())
    union all (select definition collate "C" from pg_temp.performance_self_submitted_manager_preserved_catalog()
      except all select definition collate "C" from pg_temp.performance_self_submitted_manager_preserved_before))
    or exists(with current_rows as (select 'performance_reviews' kind,id::text key,to_jsonb(r) document from private.performance_reviews r union all
select 'performance_review_events' kind,id::text key,to_jsonb(r) document from private.performance_review_events r union all
select 'performance_review_operations' kind,actor_user_id::text||':'||operation_id::text::text key,to_jsonb(r) document from private.performance_review_operations r union all
select 'performance_review_mail_outbox' kind,delivery_id::text key,to_jsonb(r) document from private.performance_review_mail_outbox r union all
select 'performance_review_notifications' kind,delivery_id::text key,to_jsonb(r) document from private.performance_review_notifications r union all
select 'performance_review_meeting_requests' kind,review_id::text key,to_jsonb(r) document from private.performance_review_meeting_requests r union all
select 'notification_delivery_receipts' kind,event_key::text key,to_jsonb(r) document from private.notification_delivery_receipts r) (select * from pg_temp.performance_self_submitted_manager_rows_before except all select * from current_rows) union all (select * from current_rows except all select * from pg_temp.performance_self_submitted_manager_rows_before))
    or exists(select 1 from pg_temp.performance_self_submitted_manager_metadata_before b join pg_proc p on p.oid=to_regprocedure(b.signature) where to_jsonb(p)-'prosrc'-'proargdefaults' is distinct from b.metadata
      or regexp_replace(p.proargdefaults::text,' :location -?[0-9]+',' :location -1','g') is distinct from b.default_tree)
    or (select schema_hash from private.confirmed_test_purge_schema where singleton) is distinct from baseline.stored_hash then
    raise exception 'Performance self-submitted manager unrelated catalog delta.' using errcode='55000';
  end if;
  if baseline.actual_hash=baseline.stored_hash then
    update private.confirmed_test_purge_schema set schema_hash=private.confirmed_test_purge_schema_hash()
      where singleton and schema_hash=baseline.stored_hash;
    if not found or private.confirmed_test_purge_schema_hash() is distinct from (select schema_hash from private.confirmed_test_purge_schema where singleton) then
      raise exception 'Performance self-submitted manager final purge fingerprint differs.' using errcode='55000';
    end if;
  end if;
end $self_submitted_manager_catalog_after$;

commit;
