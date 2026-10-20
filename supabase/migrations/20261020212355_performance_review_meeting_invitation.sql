begin;
set local search_path='';
select pg_advisory_xact_lock(hashtextextended('mam:directory-role-control',0));
lock table private.confirmed_test_purge_schema,private.performance_reviews,private.performance_review_events,private.performance_review_notifications in share row exclusive mode;
create temporary table meeting_before on commit drop as select private.confirmed_test_purge_schema_hash() actual_hash,(select schema_hash from private.confirmed_test_purge_schema where singleton) stored_hash;
create temporary table meeting_function_spec(signature text primary key,body_hash text) on commit drop;
insert into meeting_function_spec values
('public.mutate_performance_review(uuid,uuid,text,text,jsonb)','17eb86c5770f3155dc606d6395a74c8a85796b1812460caf1e30b6d4613bc3bb'),
('public.mutate_performance_review_for_delegate(uuid,uuid,uuid,text,text,jsonb)','0b215449d36297a3dbe726b66b115fd6fdf1ace7ca7d11092819ceb3fbe9a18b'),
('private.performance_review_notification_payload(private.performance_reviews,text)','0a520866770c94ea1fd90e782663fe5b47eb3b383e60669152c21a81e4832be7'),
('public.claim_performance_review_notifications(uuid,integer)','72e6b533a3c4bee9eedb2f16a93b87497e46637cf9115046994282d98d984019'),
('public.reserve_performance_review_notification_mail(text,text,text,uuid,text)','e15b8b840432c1b897903e7d5041213b02d8f7eb935e8223de952f3b7b7f65ad'),
('private.notification_event_key_valid(text)','0cdbf210466863d8cc77f22f5b30a4bde33a89127da661d1189f9bdf5b8b2414');
do $predecessor$
begin
 if current_setting('server_version_num')::integer/10000 not in(16,17)
   or (select count(*) from private.confirmed_test_purge_schema)<>1
   or to_regclass('private.performance_review_meeting_requests') is not null
   or exists(select 1 from pg_temp.meeting_function_spec s where encode(extensions.digest((select prosrc from pg_proc where oid=to_regprocedure(s.signature)),'sha256'),'hex') is distinct from s.body_hash)
   or exists(select 1 from unnest(array['private.performance_review_meeting_addresses(private.performance_reviews)','private.queue_performance_review_meeting_request()','public.list_performance_review_meeting_imports(integer)','public.import_performance_review_meeting(uuid,text,jsonb)']) signature where to_regprocedure(signature) is not null) then
   raise exception 'Performance meeting predecessor differs.' using errcode='55000';
 end if;
end $predecessor$;
create function pg_temp.meeting_preserved_catalog() returns table(definition text) language sql stable set search_path='' as $catalog$
 select n.nspname||'.'||c.relname||':'||jsonb_build_object('kind',c.relkind,'owner',c.relowner,'acl',c.relacl,'rls',c.relrowsecurity,'forcedRls',c.relforcerowsecurity,'options',c.reloptions,'persistence',c.relpersistence,'replicaIdentity',c.relreplident,'partition',c.relispartition,'partitionBound',pg_get_expr(c.relpartbound,c.oid))::text from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname in('public','private','storage') and not(n.nspname='private' and c.relname in('performance_review_meeting_requests','performance_review_meeting_requests_pkey','performance_review_meeting_requests_request_token_key'))
 union all select a.attrelid::regclass::text||':'||to_jsonb(a)::text from pg_attribute a join pg_class c on c.oid=a.attrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname in('public','private','storage') and a.attnum>0 and not a.attisdropped and not(n.nspname='private' and c.relname in('performance_review_meeting_requests','performance_review_meeting_requests_pkey','performance_review_meeting_requests_request_token_key'))
 union all select conrelid::regclass::text||':'||pg_get_constraintdef(k.oid) from pg_constraint k where (connamespace in(select oid from pg_namespace where nspname in('public','private','storage')) or confrelid='auth.users'::regclass) and conrelid<>coalesce(to_regclass('private.performance_review_meeting_requests'),0) and not(conrelid='private.performance_review_notifications'::regclass and conname in('performance_review_notifications_event_check','performance_review_notifications_cc_check'))
 union all select tgrelid::regclass::text||':'||tgenabled::text||':'||pg_get_triggerdef(t.oid) from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace where(n.nspname in('public','private','storage') or c.oid='auth.users'::regclass) and not t.tgisinternal and not(n.nspname='private' and c.relname in('performance_review_meeting_requests','performance_review_meeting_requests_pkey','performance_review_meeting_requests_request_token_key')) and not(t.tgrelid='private.performance_review_events'::regclass and t.tgname='performance_review_meeting_requested')
 union all select pg_get_functiondef(p.oid)||':'||p.proowner::text||':'||coalesce(p.proacl::text,'default') from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in('public','private') and p.prokind='f' and not exists(select 1 from pg_temp.meeting_function_spec s where to_regprocedure(s.signature)=p.oid) and p.oid<>all(array[coalesce(to_regprocedure('private.performance_review_meeting_addresses(private.performance_reviews)')::oid,0),coalesce(to_regprocedure('private.queue_performance_review_meeting_request()')::oid,0),coalesce(to_regprocedure('public.list_performance_review_meeting_imports(integer)')::oid,0),coalesce(to_regprocedure('public.import_performance_review_meeting(uuid,text,jsonb)')::oid,0)])
 union all select polrelid::regclass::text||':'||to_jsonb(p)::text from pg_policy p where polrelid in(select c.oid from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname in('public','private','storage') and not(n.nspname='private' and c.relname in('performance_review_meeting_requests','performance_review_meeting_requests_pkey','performance_review_meeting_requests_request_token_key')))
 union all select d.adrelid::regclass::text||':'||d.adnum||':'||pg_get_expr(d.adbin,d.adrelid) from pg_attrdef d join pg_class c on c.oid=d.adrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname in('public','private','storage') and d.adrelid<>coalesce(to_regclass('private.performance_review_meeting_requests'),0)
 union all select c.oid::regclass::text||':'||pg_get_viewdef(c.oid) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname in('public','private','storage') and c.relkind in('v','m')
 union all select i.indexrelid::regclass::text||':'||pg_get_indexdef(i.indexrelid)||':'||i.indisvalid||':'||i.indisready||':'||i.indislive from pg_index i join pg_class c on c.oid=i.indrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname in('public','private','storage') and i.indrelid<>coalesce(to_regclass('private.performance_review_meeting_requests'),0)

$catalog$;
create temporary table meeting_catalog_before on commit drop as select * from pg_temp.meeting_preserved_catalog();
create temporary table meeting_function_metadata_before on commit drop as select s.signature,jsonb_build_object('metadata',to_jsonb(p)-'prosrc'-'proargdefaults','arguments',pg_get_function_arguments(p.oid)) metadata from pg_temp.meeting_function_spec s join pg_proc p on p.oid=to_regprocedure(s.signature);
create temporary table meeting_rows_before on commit drop as select 'reviews' kind,id::text key,to_jsonb(r) document from private.performance_reviews r union all select 'events',id::text,to_jsonb(r) from private.performance_review_events r union all select 'notifications',delivery_id::text,to_jsonb(r) from private.performance_review_notifications r;


create or replace function public.mutate_performance_review(p_operation_id uuid,p_review_id uuid,p_expected_revision text,p_command text,p_input jsonb)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare actor record; review private.performance_reviews%rowtype; operation private.performance_review_operations%rowtype; body jsonb; receipt jsonb; audience text; meeting_end timestamptz;
begin
  select * into actor from private.performance_review_actor();
  if not private.lock_portal_role_actor() then raise exception 'Performance review access denied.' using errcode='42501'; end if;
  if p_operation_id is null or p_review_id is null then raise exception 'Invalid review input.' using errcode='22023'; end if;
  select * into review from private.performance_reviews r where r.id=p_review_id;
  if not found then raise exception 'Performance review access denied.' using errcode='42501'; end if;
  perform private.performance_review_lock_people(array[review.employee_person_id,review.assigned_manager_person_id]);
  perform 1 from public.profiles p where p.id=review.assigned_admin_user_id for share;
  select * into review from private.performance_reviews r where r.id=p_review_id for update;
  select * into actor from private.performance_review_actor();
  audience:=private.performance_review_audience(review);
  if p_command is null or p_command not in ('save_self','submit_self','save_manager','complete_manager','save_meeting','submit_review') then raise exception 'Invalid review command.' using errcode='22023'; end if;
  if (p_command in ('save_self','submit_self') and audience is distinct from 'employee') or (p_command in ('save_manager','complete_manager','save_meeting','submit_review') and not coalesce((audience='manager' or (audience='admin' and actor.role in ('admin','system_admin')
      and private.performance_review_admin_candidate(review.employee_person_id,actor.person_id))),false)) then raise exception 'Performance review access denied.' using errcode='42501'; end if;
  body:=jsonb_build_object('reviewId',p_review_id,'expectedRevision',p_expected_revision,'command',p_command,'input',p_input);
  select * into operation from private.performance_review_operations o where o.actor_user_id=actor.actor_user_id and o.operation_id=p_operation_id;
  if found then
    if operation.body<>body then raise exception 'Operation collision.' using errcode='PT409'; end if;
    return operation.receipt;
  end if;
  if p_command in ('save_self','submit_self') then
    if p_expected_revision is distinct from 'self:'||review.self_version or review.self_submitted_at is not null then raise exception 'Review changed.' using errcode='PT409'; end if;
    if not private.performance_review_closed(p_input,array['answers']) or not private.performance_review_answers(p_input->'answers',p_command='submit_self') then raise exception 'Invalid review answers.' using errcode='22023'; end if;
    update private.performance_reviews set self_answers=p_input->'answers',self_submitted_at=case when p_command='submit_self' then clock_timestamp() else null end,self_version=self_version+1 where id=p_review_id returning * into review;
  else
    if p_expected_revision is distinct from (case when audience='admin' then 'read:' else 'manager:' end)||review.self_version||':'||review.manager_version or review.finalised_at is not null or review.self_submitted_at is null then raise exception 'Review changed.' using errcode='PT409'; end if;
    if p_command in ('save_manager','complete_manager') then
      if not private.performance_review_manager_input(p_input,false) then raise exception 'Invalid manager assessment.' using errcode='22023'; end if;
      update private.performance_reviews set manager_answers=p_input->'answers',ratings=p_input->'ratings',summary=p_input->>'summary',overall_rating=p_input->>'overallRating',manager_note=p_input->>'managerNote',manager_completed_at=case when p_command='complete_manager' then coalesce(manager_completed_at,clock_timestamp()) else manager_completed_at end,manager_version=manager_version+1 where id=p_review_id returning * into review;
    else
      if review.manager_completed_at is null or (p_command='submit_review' and not private.performance_review_manager_input(jsonb_build_object('answers',review.manager_answers,'ratings',review.ratings,'summary',review.summary,'overallRating',review.overall_rating,'managerNote',review.manager_note),true)) then raise exception 'Complete manager assessment first.' using errcode='22023'; end if;
      meeting_end:=private.performance_review_meeting_end(p_input,p_command='submit_review');
      if p_command='submit_review' and not private.performance_review_meeting_ended(meeting_end,clock_timestamp()) then raise exception 'The meeting has not ended.' using errcode='22023'; end if;
      if p_command='submit_review' then
        review.meeting:=p_input-'held';
        if private.performance_review_docx_bytes(private.performance_review_document(review,'manager'))>2097152 then raise exception 'Review attachment exceeds the supported size.' using errcode='22023'; end if;
      end if;
      update private.performance_reviews set meeting=p_input-'held',meeting_held_at=case when p_command='submit_review' then clock_timestamp() else null end,finalised_at=case when p_command='submit_review' then clock_timestamp() else null end,manager_version=manager_version+1 where id=p_review_id returning * into review;
      if p_command='submit_review' then
        update private.performance_reviews set final_document=private.performance_review_document(review,'manager') where id=p_review_id returning * into review;
        insert into private.performance_review_mail_outbox(review_id) values(review.id);
      end if;
    end if;
  end if;
  insert into private.performance_review_events(review_id,subject_person_id,actor_user_id,kind) values(review.id,review.employee_person_id,actor.actor_user_id,p_command);
  receipt:=jsonb_build_object('committed',true,'operationId',p_operation_id,'review',private.performance_review_project(review));
  insert into private.performance_review_operations(actor_user_id,operation_id,review_id,body,receipt) values(actor.actor_user_id,p_operation_id,review.id,body,receipt);
  return receipt;
end $$;

create or replace function public.mutate_performance_review_for_delegate(p_person_id uuid,p_operation_id uuid,p_review_id uuid,p_expected_revision text,p_command text,p_input jsonb)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare actor record; review private.performance_reviews%rowtype; operation private.performance_review_operations%rowtype; body jsonb; receipt jsonb; audience text; meeting_end timestamptz;
begin
  select * into actor from private.performance_review_preview_actor(p_person_id);
  if actor.role<>'manager' or not private.lock_portal_role_actor() then raise exception 'Performance review access denied.' using errcode='42501'; end if;
  if p_operation_id is null or p_review_id is null then raise exception 'Invalid review input.' using errcode='22023'; end if;
  select * into review from private.performance_reviews r where r.id=p_review_id;
  if not found then raise exception 'Performance review access denied.' using errcode='42501'; end if;
  perform private.performance_review_lock_people(array[p_person_id,review.employee_person_id,review.assigned_manager_person_id]);
  select * into review from private.performance_reviews r where r.id=p_review_id for update;
  select * into actor from private.performance_review_preview_actor(p_person_id);
  if actor.role<>'manager' then raise exception 'Assigned Manager required.' using errcode='42501'; end if;
  audience:=private.performance_review_preview_audience(review,actor.person_id,'manager');
  if p_command is null or p_command not in ('save_manager','complete_manager','save_meeting','submit_review') then raise exception 'Invalid review command.' using errcode='22023'; end if;
  if audience is distinct from 'manager' then raise exception 'Performance review access denied.' using errcode='42501'; end if;
  body:=jsonb_build_object('delegatePersonId',p_person_id,'reviewId',p_review_id,'expectedRevision',p_expected_revision,'command',p_command,'input',p_input);
  select * into operation from private.performance_review_operations o where o.actor_user_id=actor.actor_user_id and o.operation_id=p_operation_id;
  if found then
    if operation.body<>body then raise exception 'Operation collision.' using errcode='PT409'; end if;
    return operation.receipt;
  end if;
  if p_expected_revision is distinct from 'manager:'||review.self_version||':'||review.manager_version or review.finalised_at is not null or review.self_submitted_at is null then raise exception 'Review changed.' using errcode='PT409'; end if;
  if p_command in ('save_manager','complete_manager') then
    if not private.performance_review_manager_input(p_input,false) then raise exception 'Invalid manager assessment.' using errcode='22023'; end if;
    update private.performance_reviews set manager_answers=p_input->'answers',ratings=p_input->'ratings',summary=p_input->>'summary',overall_rating=p_input->>'overallRating',manager_note=p_input->>'managerNote',manager_completed_at=case when p_command='complete_manager' then coalesce(manager_completed_at,clock_timestamp()) else manager_completed_at end,manager_version=manager_version+1 where id=p_review_id returning * into review;
  else
    if review.manager_completed_at is null or (p_command='submit_review' and not private.performance_review_manager_input(jsonb_build_object('answers',review.manager_answers,'ratings',review.ratings,'summary',review.summary,'overallRating',review.overall_rating,'managerNote',review.manager_note),true)) then raise exception 'Complete manager assessment first.' using errcode='22023'; end if;
    meeting_end:=private.performance_review_meeting_end(p_input,p_command='submit_review');
    if p_command='submit_review' and not private.performance_review_meeting_ended(meeting_end,clock_timestamp()) then raise exception 'The meeting has not ended.' using errcode='22023'; end if;
    if p_command='submit_review' then
      review.meeting:=p_input-'held';
      if private.performance_review_docx_bytes(private.performance_review_document(review,'manager'))>2097152 then raise exception 'Review attachment exceeds the supported size.' using errcode='22023'; end if;
    end if;
    update private.performance_reviews set meeting=p_input-'held',meeting_held_at=case when p_command='submit_review' then clock_timestamp() else null end,finalised_at=case when p_command='submit_review' then clock_timestamp() else null end,manager_version=manager_version+1 where id=p_review_id returning * into review;
    if p_command='submit_review' then
      update private.performance_reviews set final_document=private.performance_review_document(review,'manager') where id=p_review_id returning * into review;
      insert into private.performance_review_mail_outbox(review_id) values(review.id);
    end if;
  end if;
  insert into private.performance_review_events(review_id,subject_person_id,actor_user_id,kind) values(review.id,review.employee_person_id,actor.actor_user_id,p_command);
  receipt:=jsonb_build_object('committed',true,'operationId',p_operation_id,'review',private.performance_review_delegate_project(review,actor.person_id,actor.target_user_id));
  insert into private.performance_review_operations(actor_user_id,operation_id,review_id,body,receipt) values(actor.actor_user_id,p_operation_id,review.id,body,receipt);
  return receipt;
end $$;

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
    message:=message||jsonb_build_object('cc',case when 'careers@mobilityaccess.com.au'=any(string_to_array(message->>'recipient',',')) then '' else 'careers@mobilityaccess.com.au' end);
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

create or replace function private.notification_event_key_valid(p_key text)
returns boolean language sql immutable set search_path='' as $$
  select coalesce(length(p_key)<=160 and p_key ~ (
    '^(leave:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:' ||
    '(leave-submitted|leave-approved|leave-declined|leave-cancelled|leave-conditionally-approved|leave-reminder|team-birthday):[0-9a-f]{24}' ||
    '|payroll-balance:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:[0-9]{4}-(0[1-9]|1[0-2])' ||
    '|payroll-comparison:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' ||
    '|new-starter:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:day-one:(test|live)' ||
    '|checkin:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:(2-week|1-month|2-month|3-month|5-month|6-month|6-month-casual):initial:(test|live)' ||
    '|checkin-review:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:hr:[1-9][0-9]*:(test|live)' ||
    '|onboarding-credential:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' ||
    '|subscription-request:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:[1-9][0-9]*' ||
    '|subscription-review:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01]):(upcoming|due)' ||
    '|performance-review:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:(started|self-submitted|manager-invited))$'
  ),false)
$$;

create table private.performance_review_meeting_requests(
 review_id uuid primary key references private.performance_reviews(id) on delete restrict,
 request_token uuid not null unique default gen_random_uuid(),
 requested_at timestamptz not null,
 requested_by uuid not null references auth.users(id) on delete restrict,
 initial_manager_version bigint not null check(initial_manager_version>=0),
 imported_at timestamptz,
 event_id text,
 event_uid text,
 event_created_at timestamptz,
 event_modified_at timestamptz,
 check((imported_at is null and event_id is null and event_uid is null and event_created_at is null and event_modified_at is null)
  or(imported_at is not null and event_id is not null and event_uid is not null and event_modified_at is not null and length(event_id) between 1 and 1024 and length(event_uid) between 1 and 1024 and event_created_at is not null and event_modified_at>=event_created_at))
);
alter table private.performance_review_meeting_requests enable row level security;
alter table private.performance_review_meeting_requests force row level security;
revoke all on private.performance_review_meeting_requests from public,anon,authenticated,service_role;
create trigger reject_retired_test_identity_reference before insert or update on private.performance_review_meeting_requests for each row execute function private.reject_retired_test_identity_reference();
alter table private.performance_review_notifications drop constraint performance_review_notifications_event_check;
alter table private.performance_review_notifications add constraint performance_review_notifications_event_check check(event in('started','self-submitted','manager-invited'));
alter table private.performance_review_notifications drop constraint performance_review_notifications_cc_check;
alter table private.performance_review_notifications add constraint performance_review_notifications_cc_check
 check((claim_token is null and cc is null) or(claim_token is not null and cc is not null and cc in('','careers@mobilityaccess.com.au') and(not('careers@mobilityaccess.com.au'=any(string_to_array(recipient,','))) or cc='')));

create function private.performance_review_meeting_addresses(p_review private.performance_reviews)
returns jsonb language sql stable security definer set search_path='' as $$
 with addresses as(
 select lower(btrim(ed.work_email)) employee_email,lower(btrim(md.work_email)) manager_email
 from public.internal_org_people employee
 join public.internal_org_people manager on manager.id=p_review.assigned_manager_person_id and manager.company_key=employee.company_key
 cross join lateral private.portal_role_policy(employee.auth_user_id) ep
 cross join lateral private.portal_role_policy(manager.auth_user_id) mp
 join private.employee_directory_details ed on ed.person_id=employee.id
 join private.employee_directory_details md on md.person_id=manager.id
 where employee.id=p_review.employee_person_id and employee.id<>manager.id and employee.node_kind='person' and employee.is_active and manager.node_kind='person' and manager.is_active
  and ep.person_id=employee.id and ep.app_role in('employee','manager','account') and mp.person_id=manager.id and mp.app_role='manager'
  and p_review.employee_identity->>'id'=employee.id::text and p_review.manager_identity->>'id'=manager.id::text
 union all
 select lower(btrim(ed.work_email)),lower(btrim(case when rp.person_id is not null then rd.work_email when rp.app_role='system_admin' then 'careers@mobilityaccess.com.au' end))
 from public.internal_org_people employee
 cross join lateral private.portal_role_policy(employee.auth_user_id) ep
 join public.profiles reviewer on reviewer.id=p_review.assigned_admin_user_id
 cross join lateral private.portal_role_policy(reviewer.id) rp
 join private.employee_directory_details ed on ed.person_id=employee.id
 left join private.employee_directory_details rd on rd.person_id=rp.person_id
 where p_review.assigned_manager_person_id is null and employee.id=p_review.employee_person_id and employee.node_kind='person' and employee.is_active
  and ep.person_id=employee.id and ep.app_role in('employee','manager','account','admin') and rp.app_role in('admin','system_admin') and employee.id is distinct from rp.person_id
  and p_review.employee_identity->>'id'=employee.id::text and p_review.manager_identity->>'id'=reviewer.id::text
 ),valid as(select * from addresses a where a.employee_email is not null and a.manager_email is not null and a.employee_email<>a.manager_email
  and length(a.employee_email)<=254 and length(a.manager_email)<=254 and a.employee_email !~ '[[:cntrl:]]' and a.manager_email !~ '[[:cntrl:]]'
  and a.employee_email ~ '^[^[:space:]@,;]+@[^[:space:]@,;]+\.[^[:space:]@,;]+$' and a.manager_email ~ '^[^[:space:]@,;]+@(mobilityaccess\.com\.au|equipsy\.com\.au)$'
  and(select count(*) from private.employee_directory_details d where lower(btrim(d.work_email))=a.employee_email)=1
  and((a.manager_email='careers@mobilityaccess.com.au' and p_review.assigned_admin_user_id is not null and not exists(select 1 from public.internal_org_people p where p.auth_user_id=p_review.assigned_admin_user_id and p.is_active and p.node_kind='person'))
   or(select count(*) from private.employee_directory_details d where lower(btrim(d.work_email))=a.manager_email)=1))
 select jsonb_build_object('employeeEmail',employee_email,'managerEmail',manager_email) from valid
$$;
revoke all on function private.performance_review_meeting_addresses(private.performance_reviews) from public,anon,authenticated,service_role;

create function private.queue_performance_review_meeting_request()
returns trigger language plpgsql volatile security definer set search_path='' as $$
declare review private.performance_reviews%rowtype;
begin
 select * into strict review from private.performance_reviews where id=new.review_id;
 if new.kind='complete_manager' and review.manager_completed_at is not null and review.finalised_at is null then
  insert into private.performance_review_meeting_requests(review_id,requested_at,requested_by,initial_manager_version)
   values(review.id,new.at,new.actor_user_id,review.manager_version) on conflict(review_id) do nothing;
  if found then insert into private.performance_review_notifications(review_id,event) values(review.id,'manager-invited') on conflict(review_id,event) do nothing; end if;
 end if;
 return new;
end $$;
revoke all on function private.queue_performance_review_meeting_request() from public,anon,authenticated,service_role;
create trigger performance_review_meeting_requested after insert on private.performance_review_events
 for each row when(new.kind='complete_manager') execute function private.queue_performance_review_meeting_request();

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
  cross join lateral (select lower(btrim(case when p_event='started' then employee_detail.work_email
    when rp.person_id is not null then reviewer_detail.work_email
    when rp.app_role='system_admin' then 'careers@mobilityaccess.com.au' end)) email) recipient
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
    and (p_event='started' or recipient.email ~ '@(mobilityaccess\.com\.au|equipsy\.com\.au)$')
    and ((p_event='self-submitted' and rp.person_id is null and rp.app_role='system_admin')
      or (select count(*) from private.employee_directory_details other where lower(btrim(other.work_email))=recipient.email)=1)

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

create function public.list_performance_review_meeting_imports(p_limit integer default 1001)
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
  where q.imported_at is null and r.manager_completed_at is not null and r.finalised_at is null and r.meeting is null and addresses is not null
  order by q.requested_at,q.review_id limit p_limit
 ) pending;
 return result;
end $$;
revoke all on function public.list_performance_review_meeting_imports(integer) from public,anon,authenticated,service_role;
grant execute on function public.list_performance_review_meeting_imports(integer) to service_role;

create function public.import_performance_review_meeting(p_request_token uuid,p_expected_revision text,p_event jsonb)
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
 perform private.performance_review_lock_people(array[review.employee_person_id,review.assigned_manager_person_id]);
 perform 1 from public.profiles p where p.id=review.assigned_admin_user_id for share;
 perform private.performance_review_lock_people(array[(select p.id from public.internal_org_people p where p.auth_user_id=review.assigned_admin_user_id and p.node_kind='person' and p.is_active)]);
 perform 1 from private.employee_directory_details d where d.person_id in(review.employee_person_id,review.assigned_manager_person_id,(select p.id from public.internal_org_people p where p.auth_user_id=review.assigned_admin_user_id and p.node_kind='person' and p.is_active)) order by d.person_id for share;
 select * into review from private.performance_reviews r where r.id=request.review_id for update;
 select * into request from private.performance_review_meeting_requests q where q.request_token=p_request_token for update;
 if request.imported_at is not null then return jsonb_build_object('status','already_imported'); end if;
 if review.manager_completed_at is null or review.finalised_at is not null or review.meeting is not null
  or p_expected_revision is distinct from 'manager:'||review.self_version||':'||review.manager_version then return jsonb_build_object('status','skipped'); end if;
 if not exists(select 1 from private.performance_review_notifications n join private.notification_delivery_receipts r
    on r.event_key='performance-review:'||review.id::text||':manager-invited' and r.state='sent' and r.recipient=n.recipient and r.cc=n.cc
    where n.review_id=review.id and n.event='manager-invited' and n.state='provider_accepted') then return jsonb_build_object('status','skipped'); end if;
 addresses:=private.performance_review_meeting_addresses(review);
 if addresses is null then return jsonb_build_object('status','skipped'); end if;
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
revoke all on function public.import_performance_review_meeting(uuid,text,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.import_performance_review_meeting(uuid,text,jsonb) to service_role;

do $meeting_after$
declare baseline record;
begin
 select * into strict baseline from pg_temp.meeting_before;
 if exists((select definition collate "C" from pg_temp.meeting_catalog_before except all select definition collate "C" from pg_temp.meeting_preserved_catalog())
  union all(select definition collate "C" from pg_temp.meeting_preserved_catalog() except all select definition collate "C" from pg_temp.meeting_catalog_before))
  or exists(select 1 from pg_temp.meeting_function_metadata_before b join pg_proc p on p.oid=to_regprocedure(b.signature) where jsonb_build_object('metadata',to_jsonb(p)-'prosrc'-'proargdefaults','arguments',pg_get_function_arguments(p.oid)) is distinct from b.metadata)
  or exists((select * from pg_temp.meeting_rows_before except all(select 'reviews',id::text,to_jsonb(r) from private.performance_reviews r union all select 'events',id::text,to_jsonb(r) from private.performance_review_events r union all select 'notifications',delivery_id::text,to_jsonb(r) from private.performance_review_notifications r))
   union all((select 'reviews',id::text,to_jsonb(r) from private.performance_reviews r union all select 'events',id::text,to_jsonb(r) from private.performance_review_events r union all select 'notifications',delivery_id::text,to_jsonb(r) from private.performance_review_notifications r) except all select * from pg_temp.meeting_rows_before))
  or exists(select 1 from private.performance_review_meeting_requests)
  or (select schema_hash from private.confirmed_test_purge_schema where singleton) is distinct from baseline.stored_hash then
  raise exception 'Performance meeting unrelated catalog or data delta.' using errcode='55000';
 end if;
 if baseline.actual_hash=baseline.stored_hash then
  update private.confirmed_test_purge_schema set schema_hash=private.confirmed_test_purge_schema_hash() where singleton and schema_hash=baseline.stored_hash;
  if not found then raise exception 'Performance meeting purge baseline changed.' using errcode='55000'; end if;
 end if;
end $meeting_after$;
commit;
