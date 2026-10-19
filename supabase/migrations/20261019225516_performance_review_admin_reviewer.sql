begin;
set local search_path='';
select pg_advisory_xact_lock(hashtextextended('mam:directory-role-control',0));

do $admin_catalog_lock$
begin
  if not pg_try_advisory_xact_lock(hashtextextended('confirmed-test-purge',0)) then
    raise exception 'Performance Admin purge catalog busy.' using errcode='55P03';
  end if;
  lock table private.confirmed_test_purge_schema in share row exclusive mode nowait;
  lock table private.performance_reviews in access exclusive mode;
  if (select count(*) from private.confirmed_test_purge_schema)<>1 then
    raise exception 'Performance Admin purge baseline differs.' using errcode='55000';
  end if;
end $admin_catalog_lock$;
create temporary table performance_admin_catalog_before on commit drop as
select schema_hash stored_hash,private.confirmed_test_purge_schema_hash() actual_hash
from private.confirmed_test_purge_schema where singleton;
create temporary table performance_admin_rows_before on commit drop as
select id,to_jsonb(r) document from private.performance_reviews r;
create temporary table performance_admin_function_spec(signature text primary key,body_hash text) on commit drop;
insert into performance_admin_function_spec values
  ('private.performance_review_admin_candidate(uuid,uuid)',null),
  ('private.performance_review_audience(private.performance_reviews)','7f759f6cc2d589f214fff388449d87cc34f4a7821029b0642ca8a00cc424268d'),
  ('private.performance_review_project(private.performance_reviews)','be669cabbf9a2ca63532b39c9b1fb130dbb01400784a291e458d4bbae6f87542'),
  ('public.performance_review_workspace()','d761784673220b60b6e2e4b7a4b3b5417884d42d3cb13797ac8078afa94d84a1'),
  ('public.start_performance_review(uuid,uuid,text,text)','7519f8529cf42ddc15d64c26c5662310e9ec072f8336abbe8dab8a0e65e54270'),
  ('public.mutate_performance_review(uuid,uuid,text,text,jsonb)','6474b5afddb07a26889e71c0fe09a178662c518d654ac728f677b0931f49f0a2'),
  ('private.performance_review_preview_audience(private.performance_reviews,uuid,text)','ef9467665ae2f36cd2a58794be6d734bde65538536c49bd03906c3280e630cee'),
  ('public.performance_review_workspace_for_preview(uuid)','176f0c0a0965ef371e484ee18b7936f280e91f01fbfafffc0f5bd1512840ed5b'),
  ('private.performance_review_notification_payload(private.performance_reviews,text)','a33b229285ddf0c609ba057c06c8ba4d7b658d31b1c230fcecd199e7a8d11ef6'),
  ('public.claim_performance_review_notifications(uuid,integer)','edac8d6cb280eea45583aa96a858bab0aabdaa79bb776f18d4be8f7daa3ac9b2'),
  ('public.reserve_performance_review_notification_mail(text,text,text,uuid,text)','9a6060b2a5b2ca8384bf9ce64fc4f0ced59117e3790b4b40f7f56d04a33796c3');

do $admin_catalog_projection$
declare query text; anchor text;
begin
  if exists(select 1 from pg_temp.performance_admin_function_spec s where s.body_hash is not null and
    encode(extensions.digest((select p.prosrc from pg_proc p where p.oid=to_regprocedure(s.signature)),'sha256'),'hex') is distinct from s.body_hash)
    or to_regprocedure('private.performance_review_admin_candidate(uuid,uuid)') is not null then
    raise exception 'Performance Admin function predecessor differs.' using errcode='55000';
  end if;
  if (select attnotnull from pg_attribute where attrelid='private.performance_reviews'::regclass and attname='assigned_manager_person_id') is distinct from true
    or exists(select 1 from pg_attribute where attrelid='private.performance_reviews'::regclass and attname='assigned_admin_user_id' and not attisdropped) then
    raise exception 'Performance Admin reviewer predecessor differs.' using errcode='55000';
  end if;
  select prosrc into query from pg_proc where oid='private.confirmed_test_purge_schema_hash()'::regprocedure;
  if encode(extensions.digest(query,'sha256'),'hex') is distinct from 'c142665fb247c8761de408ce241e2f97aabe719c5d0801a5c53905892dd3de16' then
    raise exception 'Performance Admin catalog collector differs.' using errcode='55000';
  end if;
  anchor:=E'select encode(extensions.digest(coalesce(string_agg(definition,E''\n'' order by definition),''''),''sha256''),''hex'') from (';
  query:=replace(query,anchor,'select definition from (');
  query:=replace(query,'and a.attnum>0 and not a.attisdropped',
    'and a.attnum>0 and not a.attisdropped and not (a.attrelid=''private.performance_reviews''::regclass and a.attname in (''assigned_manager_person_id'',''assigned_admin_user_id''))');
  query:=replace(query,'from pg_constraint where connamespace',
    'from pg_constraint where not (conrelid=''private.performance_reviews''::regclass and conname in (''performance_reviews_assigned_admin_user_id_fkey'',''performance_reviews_reviewer_check'')) and (connamespace');
  query:=replace(query,'union all select tgrelid',') union all select tgrelid');
  query:=replace(query,'and p.prokind=''f''',
    'and p.prokind=''f'' and not exists(select 1 from pg_temp.performance_admin_function_spec s where to_regprocedure(s.signature)=p.oid)');
  execute 'create function pg_temp.performance_admin_preserved_catalog() returns table(definition text) language sql stable set search_path='''' as '||quote_literal(query);
end $admin_catalog_projection$;
create temporary table performance_admin_preserved_before on commit drop as
select * from pg_temp.performance_admin_preserved_catalog();
create temporary table performance_admin_column_before on commit drop as
select to_jsonb(a)-'attnotnull' metadata from pg_attribute a where a.attrelid='private.performance_reviews'::regclass and a.attname='assigned_manager_person_id';
create temporary table performance_admin_function_metadata_before on commit drop as
select s.signature,to_jsonb(p)-'prosrc' metadata from pg_temp.performance_admin_function_spec s join pg_proc p on p.oid=to_regprocedure(s.signature);

alter table private.performance_reviews alter column assigned_manager_person_id drop not null;
alter table private.performance_reviews add column assigned_admin_user_id uuid;
alter table private.performance_reviews add constraint performance_reviews_assigned_admin_user_id_fkey
  foreign key(assigned_admin_user_id) references public.profiles(id) on delete restrict;
alter table private.performance_reviews add constraint performance_reviews_reviewer_check
  check((assigned_manager_person_id is null)<>(assigned_admin_user_id is null));

create function private.performance_review_admin_candidate(p_employee uuid,p_actor_person uuid)
returns boolean language sql stable security definer set search_path='' as $$
  select p_employee is distinct from p_actor_person and exists(
    select 1 from public.internal_org_people e
    cross join lateral private.portal_role_policy(e.auth_user_id) ep
    where e.id=p_employee and e.node_kind='person' and e.is_active
      and ep.person_id=e.id and ep.app_role in ('employee','manager','account','admin'));
$$;
revoke all on function private.performance_review_admin_candidate(uuid,uuid) from public,anon,authenticated,service_role;

create or replace function private.performance_review_audience(p_review private.performance_reviews)
returns text language plpgsql volatile security definer set search_path='' as $$
declare actor record;
begin
  select * into actor from private.performance_review_actor();
  if actor.person_id=p_review.employee_person_id then return 'employee'; end if;
  if actor.role in ('admin','system_admin') then return 'admin'; end if;
  if actor.role='manager' and actor.person_id=p_review.assigned_manager_person_id and exists(
    select 1 from public.internal_org_people e join public.internal_org_people m on m.id=actor.person_id and e.company_key=m.company_key
    cross join lateral private.portal_role_policy(e.auth_user_id) ep
    where e.id=p_review.employee_person_id and e.is_active and e.node_kind='person' and m.is_active and m.node_kind='person' and ep.person_id=e.id and ep.app_role in ('employee','manager','account')) then return 'manager'; end if;
  return null;
end $$;

create or replace function private.performance_review_project(p_review private.performance_reviews)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare audience text; result jsonb; self_events jsonb; manager_events jsonb; editable boolean;
begin
  audience:=private.performance_review_audience(p_review);
  if audience is null then raise exception 'Performance review access denied.' using errcode='42501'; end if;
  select coalesce(jsonb_agg(jsonb_build_object('kind',e.kind,'at',e.at) order by e.id),'[]') into self_events
    from private.performance_review_events e where e.review_id=p_review.id and e.kind in ('save_self','submit_self') and (audience<>'employee' or e.actor_user_id=auth.uid());
  result:=jsonb_build_object('id',p_review.id,'code','PR-'||p_review.cycle||'-'||p_review.review_no,'employee',p_review.employee_identity,'manager',p_review.manager_identity,'cycle',p_review.cycle,'dueDate',to_char(p_review.due_date,'YYYY-MM-DD'),'selfStatus',case when p_review.self_submitted_at is null then 'awaiting_employee' else 'manager_review' end,'selfAnswers',p_review.self_answers,'selfSubmittedAt',p_review.self_submitted_at,'selfRevision','self:'||p_review.self_version,'selfActivity',self_events,'audience',audience);
  if audience='employee' then
    return result||jsonb_build_object('capabilities',jsonb_build_object('saveSelf',p_review.self_submitted_at is null,'submitSelf',p_review.self_submitted_at is null,'downloadDocument',true));
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('kind',e.kind,'at',e.at) order by e.id),'[]') into manager_events from private.performance_review_events e where e.review_id=p_review.id and e.kind not in ('save_self','submit_self');
  editable:=(audience='manager' or (audience='admin' and private.performance_review_admin_candidate(p_review.employee_person_id,(select person_id from private.performance_review_actor())))) and p_review.self_submitted_at is not null and p_review.finalised_at is null;
  return result||jsonb_build_object('managerAnswers',p_review.manager_answers,'ratings',p_review.ratings,'summary',p_review.summary,'overallRating',p_review.overall_rating,'managerNote',p_review.manager_note,'managerCompletedAt',p_review.manager_completed_at,'meeting',p_review.meeting,'meetingHeldAt',p_review.meeting_held_at,'finalisedAt',p_review.finalised_at,'managerActivity',manager_events,case when audience='manager' then 'managerRevision' else 'readRevision' end,case when audience='manager' then 'manager:' else 'read:' end||p_review.self_version||':'||p_review.manager_version,'capabilities',jsonb_build_object('saveSelf',false,'submitSelf',false,'saveManager',editable,'completeManager',editable,'saveMeeting',editable and p_review.manager_completed_at is not null,'submitReview',editable and p_review.manager_completed_at is not null,'downloadDocument',true));
end $$;

create or replace function public.performance_review_workspace()
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare actor record; candidates jsonb; reviews jsonb;
begin
  select * into actor from private.performance_review_actor();
  select coalesce(jsonb_agg(private.performance_review_identity(p.id) order by p.company_key,p.full_name,p.id),'[]') into candidates from public.internal_org_people p where (actor.role='manager' and private.performance_review_candidate(p.id,actor.person_id))
      or (actor.role in ('admin','system_admin') and private.performance_review_admin_candidate(p.id,actor.person_id));
  select coalesce(jsonb_agg(private.performance_review_project(r) order by r.cycle,r.due_date,r.review_no),'[]') into reviews from private.performance_reviews r where private.performance_review_audience(r) is not null;
  return jsonb_build_object('viewerContext',jsonb_build_object('actorUserId',actor.actor_user_id,'personId',actor.person_id,'role',actor.role,'displayName',actor.display_name),'reviews',reviews,'startablePeople',candidates);
end $$;

create or replace function public.start_performance_review(p_operation_id uuid,p_employee_person_id uuid,p_cycle text,p_due_date text)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare actor record; review private.performance_reviews%rowtype; operation private.performance_review_operations%rowtype; body jsonb; receipt jsonb; due date; existing boolean; employee_snapshot jsonb; manager_snapshot jsonb;
begin
  select * into actor from private.performance_review_actor();
  if actor.role not in ('manager','admin','system_admin') or not private.lock_portal_role_actor() then raise exception 'Assigned Manager required.' using errcode='42501'; end if;
  if p_operation_id is null or p_employee_person_id is null or p_cycle is null or p_cycle !~ '^[0-9]{4}$' then raise exception 'Invalid review input.' using errcode='22023'; end if;
  due:=private.performance_review_date(p_due_date);
  perform private.performance_review_lock_people(array[actor.person_id,p_employee_person_id]);
  select * into actor from private.performance_review_actor();
  if not ((actor.role='manager' and coalesce(private.performance_review_candidate(p_employee_person_id,actor.person_id),false))
    or (actor.role in ('admin','system_admin') and private.performance_review_admin_candidate(p_employee_person_id,actor.person_id))) then raise exception 'Assigned Manager required.' using errcode='42501'; end if;
  select * into review from private.performance_reviews r where r.employee_person_id=p_employee_person_id and r.cycle=p_cycle for update;
  existing:=found;
  if existing and not coalesce((private.performance_review_audience(review)='manager' or (actor.role in ('admin','system_admin') and private.performance_review_audience(review)='admin')),false) then raise exception 'Assigned Manager required.' using errcode='42501'; end if;
  body:=jsonb_build_object('command','start','employeePersonId',p_employee_person_id,'cycle',p_cycle,'dueDate',p_due_date);
  select * into operation from private.performance_review_operations o where o.actor_user_id=actor.actor_user_id and o.operation_id=p_operation_id;
  if found then
    if operation.body<>body then raise exception 'Operation collision.' using errcode='PT409'; end if;
    return operation.receipt;
  end if;
  if not existing then
    employee_snapshot:=private.performance_review_identity(p_employee_person_id);
    manager_snapshot:=jsonb_build_object('id',case when actor.role='manager' then actor.person_id else actor.actor_user_id end,'name',actor.display_name);
    if not private.performance_review_text(employee_snapshot->'name') or not private.performance_review_text(employee_snapshot->'jobTitle') or not private.performance_review_text(employee_snapshot->'team') or not private.performance_review_text(manager_snapshot->'name') then raise exception 'Invalid review identity.' using errcode='22023'; end if;
    insert into private.performance_reviews(employee_person_id,assigned_manager_person_id,assigned_admin_user_id,cycle,due_date,employee_identity,manager_identity)
      values(p_employee_person_id,case when actor.role='manager' then actor.person_id end,case when actor.role in ('admin','system_admin') then actor.actor_user_id end,p_cycle,due,employee_snapshot,manager_snapshot) returning * into review;
    insert into private.performance_review_events(review_id,subject_person_id,actor_user_id,kind) values(review.id,review.employee_person_id,actor.actor_user_id,'start');
  end if;
  receipt:=jsonb_build_object('committed',true,'operationId',p_operation_id,'review',private.performance_review_project(review),'existing',existing);
  insert into private.performance_review_operations(actor_user_id,operation_id,review_id,body,receipt) values(actor.actor_user_id,p_operation_id,review.id,body,receipt);
  return receipt;
end $$;

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
      if not private.performance_review_manager_input(p_input,p_command='complete_manager') then raise exception 'Invalid manager assessment.' using errcode='22023'; end if;
      update private.performance_reviews set manager_answers=p_input->'answers',ratings=p_input->'ratings',summary=p_input->>'summary',overall_rating=p_input->>'overallRating',manager_note=p_input->>'managerNote',manager_completed_at=case when p_command='complete_manager' then clock_timestamp() else null end,manager_version=manager_version+1 where id=p_review_id returning * into review;
    else
      if review.manager_completed_at is null or not private.performance_review_manager_input(jsonb_build_object('answers',review.manager_answers,'ratings',review.ratings,'summary',review.summary,'overallRating',review.overall_rating,'managerNote',review.manager_note),true) then raise exception 'Complete manager assessment first.' using errcode='22023'; end if;
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

create or replace function private.performance_review_preview_audience(p_review private.performance_reviews,p_person_id uuid,p_role text)
returns text language plpgsql stable security definer set search_path='' as $$
begin
  if p_role in ('employee','manager','account','admin','system_admin') and p_person_id=p_review.employee_person_id then return 'employee'; end if;
  if p_role in ('admin','system_admin') then return 'admin'; end if;
  if p_role='manager' and p_person_id=p_review.assigned_manager_person_id and exists(
    select 1 from public.internal_org_people e join public.internal_org_people m on m.id=p_person_id and e.company_key=m.company_key
    cross join lateral private.portal_role_policy(e.auth_user_id) ep
    where e.id=p_review.employee_person_id and e.is_active and e.node_kind='person' and m.is_active and m.node_kind='person'
      and ep.person_id=e.id and ep.app_role in ('employee','manager','account')) then return 'manager'; end if;
  return null;
end $$;

create or replace function public.performance_review_workspace_for_preview(p_person_id uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare viewer record; candidates jsonb; reviews jsonb;
begin
  select * into strict viewer from private.performance_review_preview_actor(p_person_id);
  select coalesce(jsonb_agg(private.performance_review_identity(p.id) order by p.company_key,p.full_name,p.id),'[]') into candidates
    from public.internal_org_people p where (viewer.role='manager' and private.performance_review_candidate(p.id,viewer.person_id))
      or (viewer.role in ('admin','system_admin') and private.performance_review_admin_candidate(p.id,viewer.person_id));
  select coalesce(jsonb_agg(private.performance_review_preview_project(r,viewer.person_id,viewer.role,viewer.target_user_id)
    order by r.cycle,r.due_date,r.review_no),'[]') into reviews from private.performance_reviews r
    where private.performance_review_preview_audience(r,viewer.person_id,viewer.role) is not null;
  return jsonb_build_object('viewerContext',jsonb_build_object('actorUserId',viewer.actor_user_id,'personId',viewer.person_id,
    'role',viewer.role,'displayName',viewer.display_name),'reviews',reviews,'startablePeople',candidates);
end $$;

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
  where employee.id=p_review.employee_person_id and employee.id<>manager.id
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
  where p_review.assigned_manager_person_id is null and employee.id=p_review.employee_person_id
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
    perform private.performance_review_lock_people(array[review.employee_person_id,review.assigned_manager_person_id]);
    perform 1 from public.profiles p where p.id=review.assigned_admin_user_id for share;
    perform private.performance_review_lock_people(array[(select p.id from public.internal_org_people p where p.auth_user_id=review.assigned_admin_user_id and p.node_kind='person' and p.is_active)]);
    perform 1 from private.employee_directory_details d where d.person_id in(review.employee_person_id,review.assigned_manager_person_id,(select p.id from public.internal_org_people p where p.auth_user_id=review.assigned_admin_user_id and p.node_kind='person' and p.is_active)) order by d.person_id for share;
    message:=private.performance_review_notification_payload(review,item.event);
    if message is null then
      update private.performance_review_notifications n set state='needs_review',finished_at=clock_timestamp() where n.delivery_id=item.delivery_id;
      continue;
    end if;
    token:=gen_random_uuid();
    update private.performance_review_notifications n set state='claimed',claim_token=token,recipient=message->>'recipient',claimed_at=clock_timestamp() where n.delivery_id=item.delivery_id;
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
    or p_cc is distinct from '' or p_claim_token is null or p_legacy_event_key is not null then
    raise exception 'Invalid performance notification reservation.' using errcode='22023';
  end if;
  perform private.lock_notification_delivery_store();
  perform pg_advisory_xact_lock_shared(hashtextextended('mam:directory-role-control',0));
  select r.* into review from private.performance_reviews r where r.id=split_part(p_event_key,':',2)::uuid for update;
  select n.* into delivery from private.performance_review_notifications n where n.review_id=review.id
    and n.event=split_part(p_event_key,':',3) and n.claim_token=p_claim_token for update;
  if not found or delivery.recipient is distinct from p_recipient then
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

do $admin_catalog_after$
declare baseline record;
begin
  select * into strict baseline from pg_temp.performance_admin_catalog_before;
  if exists((select definition collate "C" from pg_temp.performance_admin_preserved_before
      except all select definition collate "C" from pg_temp.performance_admin_preserved_catalog())
    union all (select definition collate "C" from pg_temp.performance_admin_preserved_catalog()
      except all select definition collate "C" from pg_temp.performance_admin_preserved_before))
    or exists(select 1 from pg_temp.performance_admin_function_metadata_before b
      join pg_proc p on p.oid=to_regprocedure(b.signature) where to_jsonb(p)-'prosrc' is distinct from b.metadata)
    or exists((select id,document from pg_temp.performance_admin_rows_before
      except all select id,to_jsonb(r)-'assigned_admin_user_id' from private.performance_reviews r)
      union all (select id,to_jsonb(r)-'assigned_admin_user_id' from private.performance_reviews r
      except all select id,document from pg_temp.performance_admin_rows_before))
    or exists(select 1 from pg_attribute a cross join pg_temp.performance_admin_column_before b
      where a.attrelid='private.performance_reviews'::regclass and a.attname='assigned_manager_person_id'
      and (a.attnotnull or to_jsonb(a)-'attnotnull' is distinct from b.metadata))
    or not exists(select 1 from pg_attribute a where a.attrelid='private.performance_reviews'::regclass and a.attname='assigned_admin_user_id'
      and a.atttypid='uuid'::regtype and not a.attnotnull and not a.atthasdef and a.attacl is null and a.attgenerated='' and a.attidentity='')
    or exists(select 1 from private.performance_reviews where assigned_admin_user_id is not null)
    or (select schema_hash from private.confirmed_test_purge_schema where singleton) is distinct from baseline.stored_hash then
    raise exception 'Performance Admin unrelated catalog or data delta.' using errcode='55000';
  end if;
  if baseline.actual_hash=baseline.stored_hash then
    update private.confirmed_test_purge_schema set schema_hash=private.confirmed_test_purge_schema_hash()
      where singleton and schema_hash=baseline.stored_hash;
    if not found or private.confirmed_test_purge_schema_hash() is distinct from (select schema_hash from private.confirmed_test_purge_schema where singleton) then
      raise exception 'Performance Admin final purge fingerprint differs.' using errcode='55000';
    end if;
  end if;
end $admin_catalog_after$;

commit;
