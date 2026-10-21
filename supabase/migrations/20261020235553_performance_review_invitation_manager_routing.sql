begin;
set local search_path='';
select pg_advisory_xact_lock(hashtextextended('mam:directory-role-control',0));

do $invitation_routing_catalog_lock$
begin
  if not pg_try_advisory_xact_lock(hashtextextended('confirmed-test-purge',0)) then
    raise exception 'Performance invitation routing purge catalog busy.' using errcode='55P03';
  end if;
  lock table private.confirmed_test_purge_schema,private.performance_reviews,private.performance_review_events,private.performance_review_operations,private.performance_review_mail_outbox,private.performance_review_notifications,private.performance_review_meeting_requests,private.notification_delivery_receipts in share row exclusive mode nowait;
  if (select count(*) from private.confirmed_test_purge_schema)<>1 then
    raise exception 'Performance invitation routing purge baseline differs.' using errcode='55000';
  end if;
end $invitation_routing_catalog_lock$;
create temporary table performance_invitation_routing_catalog_before on commit drop as
select schema_hash stored_hash,private.confirmed_test_purge_schema_hash() actual_hash
from private.confirmed_test_purge_schema where singleton;
create temporary table performance_invitation_routing_function_spec(signature text primary key) on commit drop;
insert into performance_invitation_routing_function_spec values
  ('private.performance_review_meeting_addresses(private.performance_reviews)'),
  ('public.claim_performance_review_notifications(uuid,integer)'),
  ('public.reserve_performance_review_notification_mail(text,text,text,uuid,text)'),
  ('public.list_performance_review_meeting_imports(integer)'),
  ('public.import_performance_review_meeting(uuid,text,jsonb)'),
  ('public.claim_performance_review_notifications(uuid,integer,integer)');
do $invitation_routing_catalog_projection$
declare query text; anchor text;
begin
  select prosrc into query from pg_proc where oid='private.confirmed_test_purge_schema_hash()'::regprocedure;
  if encode(extensions.digest(query,'sha256'),'hex') is distinct from 'c142665fb247c8761de408ce241e2f97aabe719c5d0801a5c53905892dd3de16' then
    raise exception 'Performance invitation routing catalog collector differs.' using errcode='55000';
  end if;
  anchor:=E'select encode(extensions.digest(coalesce(string_agg(definition,E''\\n'' order by definition),''''),''sha256''),''hex'') from (';
  query:=replace(query,anchor,'select definition from (');
  query:=replace(query,'and p.prokind=''f''',
    'and p.prokind=''f'' and not exists(select 1 from pg_temp.performance_invitation_routing_function_spec s where to_regprocedure(s.signature)=p.oid)');
  execute 'create function pg_temp.performance_invitation_routing_preserved_catalog() returns table(definition text) language sql stable set search_path='''' as '||quote_literal(query);
end $invitation_routing_catalog_projection$;
create temporary table performance_invitation_routing_preserved_before on commit drop as
select * from pg_temp.performance_invitation_routing_preserved_catalog();

create temporary table performance_invitation_routing_metadata_before on commit drop as select signature,to_jsonb(p)-'prosrc' metadata from pg_temp.performance_invitation_routing_function_spec s join pg_proc p on p.oid=to_regprocedure(s.signature);
create temporary table performance_invitation_routing_rows_before on commit drop as
select 'performance_reviews' kind,id::text key,to_jsonb(r) document from private.performance_reviews r union all
select 'performance_review_events' kind,id::text key,to_jsonb(r) document from private.performance_review_events r union all
select 'performance_review_operations' kind,actor_user_id::text||':'||operation_id::text::text key,to_jsonb(r) document from private.performance_review_operations r union all
select 'performance_review_mail_outbox' kind,delivery_id::text key,to_jsonb(r) document from private.performance_review_mail_outbox r union all
select 'performance_review_notifications' kind,delivery_id::text key,to_jsonb(r) document from private.performance_review_notifications r union all
select 'performance_review_meeting_requests' kind,review_id::text key,to_jsonb(r) document from private.performance_review_meeting_requests r union all
select 'notification_delivery_receipts' kind,event_key::text key,to_jsonb(r) document from private.notification_delivery_receipts r;
do $invitation_routing_predecessor$
begin
 if current_setting('server_version_num')::integer/10000 not in(16,17) or to_regprocedure('public.claim_performance_review_notifications(uuid,integer,integer)') is not null or exists(select 1 from (values
  ('private.performance_review_meeting_addresses(private.performance_reviews)','8a47cd1c187fb8ebb1a8b3afcb5b0ad56cf577156c4da3ee93b0432f9a75e50b'),
  ('public.claim_performance_review_notifications(uuid,integer)','021b7bc610b0dd1efdba0fc18e8d005e8433c9c59ee4755afe7ce5b120de45f4'),
  ('public.reserve_performance_review_notification_mail(text,text,text,uuid,text)','7b3c876c1ac1962a1cc6c66aeff1fec90461c5104d96bfc12febefb031c55cb9'),
  ('public.list_performance_review_meeting_imports(integer)','9e99fb86fd60d5480d53289af5904454e2c857b1950dc17db322ad7919fa9de4'),
  ('public.import_performance_review_meeting(uuid,text,jsonb)','3cddd6b8ac8815ca8412ed9e38ad5d5673c7194e7e5cda3a955f6d2d38878970'),
  ('private.resolve_internal_org_employee_manager(uuid)','b7a5bf0f225f50d38538b5ee9882108f791c79353ea05b76061e151e44d6263e'),
  ('private.performance_review_candidate(uuid,uuid)','1c991608e47b3368b79ca7cf5d775b492960583f04b90107b51dc49168db3e38'),
  ('private.portal_role_policy(uuid)','f9c6cc5131294bcf3deb8e7c33109438783884aca8751d3b0cf5b39a67ab39f5')) expected(signature,body_hash) left join pg_proc p on p.oid=to_regprocedure(expected.signature) where encode(extensions.digest(p.prosrc,'sha256'),'hex') is distinct from expected.body_hash) then
  raise exception 'Performance invitation routing predecessor differs.' using errcode='55000';
 end if;
end $invitation_routing_predecessor$;

create or replace function private.performance_review_meeting_addresses(p_review private.performance_reviews)
returns jsonb language sql stable security definer set search_path='' as $$
 with employee as(
  select e.*,ep.app_role,lower(btrim(ed.work_email)) employee_email
  from public.internal_org_people e cross join lateral private.portal_role_policy(e.auth_user_id) ep
  join private.employee_directory_details ed on ed.person_id=e.id
  where e.id=p_review.employee_person_id and e.node_kind='person' and e.is_active and ep.person_id=e.id
   and ep.app_role in('employee','manager','account','admin') and p_review.employee_identity->>'id'=e.id::text
 ),admin_reviewer as(
  select rp.person_id,rp.app_role,lower(btrim(rd.work_email)) email
  from public.profiles reviewer cross join lateral private.portal_role_policy(reviewer.id) rp
  left join private.employee_directory_details rd on rd.person_id=rp.person_id
  where p_review.assigned_manager_person_id is null and reviewer.id=p_review.assigned_admin_user_id
   and rp.app_role in('admin','system_admin') and p_review.manager_identity->>'id'=reviewer.id::text
   and exists(select 1 from employee e where e.id is distinct from rp.person_id)
 ),org_manager as(
  select m.id,lower(btrim(md.work_email)) email
  from employee e cross join lateral private.resolve_internal_org_employee_manager(e.id) candidate
  join public.internal_org_people m on m.id=candidate.manager_id and m.company_key=e.company_key
  cross join lateral private.portal_role_policy(m.auth_user_id) mp
  left join private.employee_directory_details md on md.person_id=m.id
  where exists(select 1 from admin_reviewer) and m.id<>e.id and m.node_kind='person' and m.is_active
   and mp.person_id=m.id and mp.app_role='manager'
   and (e.app_role='admin' or private.performance_review_candidate(e.id,m.id))
 ),addresses as(
  select e.employee_email,lower(btrim(md.work_email)) manager_email
  from employee e join public.internal_org_people m on m.id=p_review.assigned_manager_person_id and m.company_key=e.company_key
  cross join lateral private.portal_role_policy(m.auth_user_id) mp
  join private.employee_directory_details md on md.person_id=m.id
  where e.id<>m.id and e.app_role in('employee','manager','account') and m.node_kind='person' and m.is_active
   and mp.person_id=m.id and mp.app_role='manager' and p_review.manager_identity->>'id'=m.id::text
  union all
  select e.employee_email,m.email from employee e cross join org_manager m
  union all
  select e.employee_email,a.email from employee e cross join admin_reviewer a
  where a.person_id is not null and e.id<>a.person_id and not exists(select 1 from org_manager)
 ),valid as(select * from addresses a where a.employee_email is not null and a.manager_email is not null
  and a.employee_email<>a.manager_email and a.employee_email<>'careers@mobilityaccess.com.au' and a.manager_email<>'careers@mobilityaccess.com.au'
  and length(a.employee_email)<=254 and length(a.manager_email)<=254 and a.employee_email !~ '[[:cntrl:]]' and a.manager_email !~ '[[:cntrl:]]'
  and a.employee_email ~ '^[^[:space:]@,;]+@[^[:space:]@,;]+\.[^[:space:]@,;]+$'
  and a.manager_email ~ '^[^[:space:]@,;]+@(mobilityaccess\.com\.au|equipsy\.com\.au)$'
  and(select count(*) from private.employee_directory_details d where lower(btrim(d.work_email))=a.employee_email)=1
  and(select count(*) from private.employee_directory_details d where lower(btrim(d.work_email))=a.manager_email)=1)
 select jsonb_build_object('employeeEmail',employee_email,'managerEmail',manager_email) from valid
$$;

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
    perform private.performance_review_lock_people(array[review.employee_person_id,review.assigned_manager_person_id,(select manager_id from private.resolve_internal_org_employee_manager(review.employee_person_id) where review.assigned_manager_person_id is null)]);
    perform 1 from public.profiles p where p.id=review.assigned_admin_user_id for share;
    perform private.performance_review_lock_people(array[(select p.id from public.internal_org_people p where p.auth_user_id=review.assigned_admin_user_id and p.node_kind='person' and p.is_active)]);
    perform 1 from private.employee_directory_details d where d.person_id in(review.employee_person_id,review.assigned_manager_person_id,(select manager_id from private.resolve_internal_org_employee_manager(review.employee_person_id) where review.assigned_manager_person_id is null),(select p.id from public.internal_org_people p where p.auth_user_id=review.assigned_admin_user_id and p.node_kind='person' and p.is_active)) order by d.person_id for share;
    message:=private.performance_review_notification_payload(review,item.event);
    if message is null then
      update private.performance_review_notifications n set state='needs_review',finished_at=clock_timestamp() where n.delivery_id=item.delivery_id;
      continue;
    end if;
    message:=message||jsonb_build_object('cc',case when item.event='manager-invited' or 'careers@mobilityaccess.com.au'=any(string_to_array(message->>'recipient',',')) then '' else 'careers@mobilityaccess.com.au' end);
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
  if message is null or message->>'recipient' is distinct from p_recipient then
    update private.performance_review_notifications n set state='needs_review',finished_at=clock_timestamp() where n.delivery_id=delivery.delivery_id;
    return private.notification_delivery_rejection(p_event_key,'performance-notification-unavailable',false);
  end if;
  if delivery.state<>'claimed' then
    return private.notification_delivery_rejection(p_event_key,'performance-notification-unavailable',false);
  end if;
  return public.reserve_notification_delivery(p_event_key,p_recipient,p_cc,null);
end $$;

create or replace function public.list_performance_review_meeting_imports(p_limit integer default 1001)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare result jsonb;
begin
 if p_limit is null or p_limit<1 or p_limit>1001 then raise exception 'Invalid meeting import limit.' using errcode='22023'; end if;
 select coalesce(jsonb_agg(item order by requested_at,review_id),'[]') into result from(
  select q.requested_at,q.review_id,jsonb_build_object('requestToken',q.request_token,'reviewId',r.id,'reviewCode','PR-'||r.cycle||'-'||r.review_no,
   'expectedRevision','manager:'||r.self_version||':'||r.manager_version,'requestedAt',q.requested_at,'managerEmail',addresses->>'managerEmail','employeeEmail',addresses->>'employeeEmail') item
  from private.performance_review_meeting_requests q join private.performance_reviews r on r.id=q.review_id
  join private.performance_review_notifications n on n.review_id=r.id and n.event='manager-invited' and n.state='provider_accepted'
  join private.notification_delivery_receipts receipt on receipt.event_key='performance-review:'||r.id::text||':manager-invited'
   and receipt.state='sent' and receipt.recipient=n.recipient and receipt.cc=n.cc
  cross join lateral private.performance_review_meeting_addresses(r) addresses
  where q.imported_at is null and r.manager_completed_at is not null and r.finalised_at is null and r.meeting is null and addresses is not null and n.recipient=(select string_agg(email,',' order by email collate "C") from(select distinct jsonb_array_elements_text(jsonb_build_array(addresses->>'managerEmail',addresses->>'employeeEmail')) email) recipients)
  order by q.requested_at,q.review_id limit p_limit
 ) pending;
 return result;
end $$;

create or replace function public.import_performance_review_meeting(p_request_token uuid,p_expected_revision text,p_event jsonb)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare request private.performance_review_meeting_requests%rowtype; review private.performance_reviews%rowtype; addresses jsonb; started timestamptz; ended timestamptz; created timestamptz; modified timestamptz; duration integer; start_local timestamp; v_meeting jsonb; attendee text; review_code text;
begin
 if p_request_token is null or p_expected_revision is null or p_expected_revision !~ '^manager:(0|[1-9][0-9]*):(0|[1-9][0-9]*)$'
  or not private.performance_review_closed(p_event,array['id','uid','subject','organizer','attendees','start','end','createdAt','modifiedAt','mode','location','isCancelled','isAllDay','type']) then
  raise exception 'Invalid review meeting event.' using errcode='22023';
 end if;
 if exists(select 1 from unnest(array['id','uid','subject','organizer','start','end','createdAt','modifiedAt','mode','location','type']) key
   where jsonb_typeof(p_event->key) is distinct from 'string' or not private.performance_review_text(p_event->key))
  or length(p_event->>'id') not between 1 and 1024 or p_event->>'id' ~ '[[:cntrl:]]' or length(p_event->>'uid') not between 1 and 1024 or p_event->>'uid' ~ '[[:cntrl:]]'
  or length(p_event->>'subject') not between 1 and 1024 or p_event->>'subject' ~ '[[:cntrl:]]'
  or p_event->'isCancelled' is distinct from 'false'::jsonb or p_event->'isAllDay' is distinct from 'false'::jsonb or p_event->>'type'<>'singleInstance'
  or jsonb_typeof(p_event->'attendees') is distinct from 'array' or jsonb_array_length(p_event->'attendees') not between 1 and 32
  or p_event->>'mode' not in('in_person','teams','phone')
  or p_event->>'start' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:00(\.0{1,7})?Z$'
  or p_event->>'end' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:00(\.0{1,7})?Z$'
  or p_event->>'createdAt' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,7})?Z$'
  or p_event->>'modifiedAt' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,7})?Z$' then
  raise exception 'Invalid review meeting event.' using errcode='22023';
 end if;
 begin
  started:=(p_event->>'start')::timestamptz;ended:=(p_event->>'end')::timestamptz;created:=(p_event->>'createdAt')::timestamptz;modified:=(p_event->>'modifiedAt')::timestamptz;
 exception when others then raise exception 'Invalid review meeting dates.' using errcode='22023'; end;
 if started<'0001-01-01T00:00:00Z'::timestamptz or ended>='10000-01-01T00:00:00Z'::timestamptz
  or created<'0001-01-01T00:00:00Z'::timestamptz or modified>='10000-01-01T00:00:00Z'::timestamptz
  or modified<created or ended-started<interval '5 minutes' or ended-started>interval '480 minutes'
  or extract(epoch from(ended-started))::numeric%60<>0 then raise exception 'Invalid review meeting dates.' using errcode='22023'; end if;
 duration:=(extract(epoch from(ended-started))/60)::integer;
 perform pg_advisory_xact_lock_shared(hashtextextended('mam:directory-role-control',0));
 select * into request from private.performance_review_meeting_requests q where q.request_token=p_request_token;
 if not found then return jsonb_build_object('status','skipped'); end if;
 select * into review from private.performance_reviews r where r.id=request.review_id;
 perform private.performance_review_lock_people(array[review.employee_person_id,review.assigned_manager_person_id,(select manager_id from private.resolve_internal_org_employee_manager(review.employee_person_id) where review.assigned_manager_person_id is null)]);
 perform 1 from public.profiles p where p.id=review.assigned_admin_user_id for share;
 perform private.performance_review_lock_people(array[(select p.id from public.internal_org_people p where p.auth_user_id=review.assigned_admin_user_id and p.node_kind='person' and p.is_active)]);
 perform 1 from private.employee_directory_details d where d.person_id in(review.employee_person_id,review.assigned_manager_person_id,(select manager_id from private.resolve_internal_org_employee_manager(review.employee_person_id) where review.assigned_manager_person_id is null),(select p.id from public.internal_org_people p where p.auth_user_id=review.assigned_admin_user_id and p.node_kind='person' and p.is_active)) order by d.person_id for share;
 select * into review from private.performance_reviews r where r.id=request.review_id for update;
 select * into request from private.performance_review_meeting_requests q where q.request_token=p_request_token for update;
 if request.imported_at is not null then return jsonb_build_object('status','already_imported'); end if;
 if review.manager_completed_at is null or review.finalised_at is not null or review.meeting is not null
  or p_expected_revision is distinct from 'manager:'||review.self_version||':'||review.manager_version then return jsonb_build_object('status','skipped'); end if;
 if not exists(select 1 from private.performance_review_notifications n join private.notification_delivery_receipts r
    on r.event_key='performance-review:'||review.id::text||':manager-invited' and r.state='sent' and r.recipient=n.recipient and r.cc=n.cc
    where n.review_id=review.id and n.event='manager-invited' and n.state='provider_accepted') then return jsonb_build_object('status','skipped'); end if;
 addresses:=private.performance_review_meeting_addresses(review);
 if addresses is null or not exists(select 1 from private.performance_review_notifications n
   where n.review_id=review.id and n.event='manager-invited' and n.state='provider_accepted' and n.recipient=(select string_agg(email,',' order by email collate "C") from(select distinct jsonb_array_elements_text(jsonb_build_array(addresses->>'managerEmail',addresses->>'employeeEmail')) email) recipients)) then return jsonb_build_object('status','skipped'); end if;
 review_code:='PR-'||review.cycle||'-'||review.review_no;
 if p_event->>'organizer' is distinct from addresses->>'managerEmail' or created<request.requested_at
  or (select count(*) from regexp_matches(p_event->>'subject','(^|[^A-Za-z0-9_-])(PR-[0-9]{4}-[1-9][0-9]*)(?=$|[^A-Za-z0-9_-])','g'))<>1
  or not(p_event->>'subject' ~ ('(^|[^A-Za-z0-9_-])'||review_code||'($|[^A-Za-z0-9_-])'))
  or not(p_event->'attendees' ? (addresses->>'employeeEmail')) or not(p_event->'attendees' ? 'ai@mobilityaccess.com.au')
  or (select count(*) from jsonb_array_elements_text(p_event->'attendees'))<>(select count(distinct value) from jsonb_array_elements_text(p_event->'attendees')) then
  raise exception 'Invalid review meeting authority.' using errcode='22023';
 end if;
 for attendee in select jsonb_array_elements_text(p_event->'attendees') loop
  if attendee is null or attendee<>lower(btrim(attendee)) or length(attendee)>254 or attendee ~ '[[:cntrl:]]' or attendee !~ '^[^[:space:]@,;]+@[^[:space:]@,;]+\.[^[:space:]@,;]+$' then
   raise exception 'Invalid review meeting attendees.' using errcode='22023';
  end if;
 end loop;
 start_local:=started at time zone 'Australia/Melbourne';
 v_meeting:=jsonb_build_object('date',to_char(start_local,'YYYY-MM-DD'),'time',to_char(start_local,'HH24:MI'),'duration',duration,'mode',p_event->>'mode','location',p_event->>'location','notes','');
 if private.performance_review_meeting_end(v_meeting,false) is distinct from ended then raise exception 'Invalid review meeting local time.' using errcode='22023'; end if;
 update private.performance_reviews set meeting=v_meeting,manager_version=manager_version+1 where id=review.id;
 update private.performance_review_meeting_requests set imported_at=clock_timestamp(),event_id=p_event->>'id',event_uid=p_event->>'uid',event_created_at=created,event_modified_at=modified where review_id=review.id;
 return jsonb_build_object('status','imported');
end $$;

create function public.claim_performance_review_notifications(p_review_id uuid,p_limit integer,p_policy_version integer)
returns table(delivery_id uuid,review_id uuid,claim_token uuid,payload jsonb)
language plpgsql volatile security invoker set search_path='' as $$
begin
 if p_policy_version is distinct from 2 then raise exception 'Unsupported performance notification policy.' using errcode='22023'; end if;
 return query select * from public.claim_performance_review_notifications(p_review_id,p_limit);
end $$;
revoke all on function public.claim_performance_review_notifications(uuid,integer,integer) from public,anon,authenticated,service_role;
grant execute on function public.claim_performance_review_notifications(uuid,integer,integer) to service_role;

do $invitation_routing_catalog_after$
declare baseline record;
begin
  select * into strict baseline from pg_temp.performance_invitation_routing_catalog_before;
  if exists((select definition collate "C" from pg_temp.performance_invitation_routing_preserved_before
      except all select definition collate "C" from pg_temp.performance_invitation_routing_preserved_catalog())
    union all (select definition collate "C" from pg_temp.performance_invitation_routing_preserved_catalog()
      except all select definition collate "C" from pg_temp.performance_invitation_routing_preserved_before))
    or exists(with current_rows as (select 'performance_reviews' kind,id::text key,to_jsonb(r) document from private.performance_reviews r union all
select 'performance_review_events' kind,id::text key,to_jsonb(r) document from private.performance_review_events r union all
select 'performance_review_operations' kind,actor_user_id::text||':'||operation_id::text::text key,to_jsonb(r) document from private.performance_review_operations r union all
select 'performance_review_mail_outbox' kind,delivery_id::text key,to_jsonb(r) document from private.performance_review_mail_outbox r union all
select 'performance_review_notifications' kind,delivery_id::text key,to_jsonb(r) document from private.performance_review_notifications r union all
select 'performance_review_meeting_requests' kind,review_id::text key,to_jsonb(r) document from private.performance_review_meeting_requests r union all
select 'notification_delivery_receipts' kind,event_key::text key,to_jsonb(r) document from private.notification_delivery_receipts r) (select * from pg_temp.performance_invitation_routing_rows_before except all select * from current_rows) union all (select * from current_rows except all select * from pg_temp.performance_invitation_routing_rows_before))
    or exists(select 1 from pg_temp.performance_invitation_routing_metadata_before b join pg_proc p on p.oid=to_regprocedure(b.signature) where to_jsonb(p)-'prosrc' is distinct from b.metadata)
    or (select schema_hash from private.confirmed_test_purge_schema where singleton) is distinct from baseline.stored_hash then
    raise exception 'Performance invitation routing unrelated catalog delta.' using errcode='55000';
  end if;
  if baseline.actual_hash=baseline.stored_hash then
    update private.confirmed_test_purge_schema set schema_hash=private.confirmed_test_purge_schema_hash()
      where singleton and schema_hash=baseline.stored_hash;
    if not found or private.confirmed_test_purge_schema_hash() is distinct from (select schema_hash from private.confirmed_test_purge_schema where singleton) then
      raise exception 'Performance invitation routing final purge fingerprint differs.' using errcode='55000';
    end if;
  end if;
end $invitation_routing_catalog_after$;

commit;
