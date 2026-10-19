begin;
set local search_path='';
select pg_advisory_xact_lock(hashtextextended('mam:directory-role-control',0));

do $delegate_catalog_lock$
begin
  if not pg_try_advisory_xact_lock(hashtextextended('confirmed-test-purge',0)) then
    raise exception 'Performance delegate purge catalog busy.' using errcode='55P03';
  end if;
  lock table private.confirmed_test_purge_schema in share row exclusive mode nowait;
  if (select count(*) from private.confirmed_test_purge_schema)<>1 then
    raise exception 'Performance delegate purge baseline differs.' using errcode='55000';
  end if;
end $delegate_catalog_lock$;
create temporary table performance_delegate_catalog_before on commit drop as
select schema_hash stored_hash,private.confirmed_test_purge_schema_hash() actual_hash
from private.confirmed_test_purge_schema where singleton;
create temporary table performance_delegate_function_spec(signature text primary key) on commit drop;
insert into performance_delegate_function_spec values
  ('private.performance_review_delegate_project(private.performance_reviews,uuid,uuid)'),
  ('public.performance_review_workspace_for_delegate(uuid)'),
  ('public.start_performance_review_for_delegate(uuid,uuid,uuid,text,text)'),
  ('public.mutate_performance_review_for_delegate(uuid,uuid,uuid,text,text,jsonb)'),
  ('public.get_performance_review_operation_for_delegate(uuid,uuid,uuid)');
do $delegate_catalog_projection$
declare query text; anchor text;
begin
  select prosrc into query from pg_proc where oid='private.confirmed_test_purge_schema_hash()'::regprocedure;
  if encode(extensions.digest(query,'sha256'),'hex') is distinct from 'c142665fb247c8761de408ce241e2f97aabe719c5d0801a5c53905892dd3de16' then
    raise exception 'Performance delegate catalog collector differs.' using errcode='55000';
  end if;
  anchor:=E'select encode(extensions.digest(coalesce(string_agg(definition,E''\\n'' order by definition),''''),''sha256''),''hex'') from (';
  query:=replace(query,anchor,'select definition from (');
  query:=replace(query,'and p.prokind=''f''',
    'and p.prokind=''f'' and not exists(select 1 from pg_temp.performance_delegate_function_spec s where to_regprocedure(s.signature)=p.oid)');
  execute 'create function pg_temp.performance_delegate_preserved_catalog() returns table(definition text) language sql stable set search_path='''' as '||quote_literal(query);
end $delegate_catalog_projection$;
create temporary table performance_delegate_preserved_before on commit drop as
select * from pg_temp.performance_delegate_preserved_catalog();

create function private.performance_review_delegate_project(p_review private.performance_reviews,p_person_id uuid,p_target_user_id uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare result jsonb; editable boolean;
begin
  result:=private.performance_review_preview_project(p_review,p_person_id,'manager',p_target_user_id);
  if result->>'audience'<>'manager' then return result; end if;
  editable:=p_review.self_submitted_at is not null and p_review.finalised_at is null;
  return result||jsonb_build_object('capabilities',jsonb_build_object('saveSelf',false,'submitSelf',false,
    'saveManager',editable,'completeManager',editable,'saveMeeting',editable and p_review.manager_completed_at is not null,
    'submitReview',editable and p_review.manager_completed_at is not null,'downloadDocument',true));
end $$;
revoke all on function private.performance_review_delegate_project(private.performance_reviews,uuid,uuid) from public,anon,authenticated,service_role;

create function public.performance_review_workspace_for_delegate(p_person_id uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare viewer record; candidates jsonb; reviews jsonb;
begin
  select * into strict viewer from private.performance_review_preview_actor(p_person_id);
  if viewer.role<>'manager' then raise exception 'Assigned Manager required.' using errcode='42501'; end if;
  select coalesce(jsonb_agg(private.performance_review_identity(p.id) order by p.company_key,p.full_name,p.id),'[]') into candidates
    from public.internal_org_people p where private.performance_review_candidate(p.id,viewer.person_id);
  select coalesce(jsonb_agg(private.performance_review_delegate_project(r,viewer.person_id,viewer.target_user_id)
    order by r.cycle,r.due_date,r.review_no),'[]') into reviews from private.performance_reviews r
    where private.performance_review_preview_audience(r,viewer.person_id,'manager') is not null;
  return jsonb_build_object('viewerContext',jsonb_build_object('actorUserId',viewer.actor_user_id,'personId',viewer.person_id,
    'role',viewer.role,'displayName',viewer.display_name),'reviews',reviews,'startablePeople',candidates);
end $$;
revoke all on function public.performance_review_workspace_for_delegate(uuid) from public,anon,authenticated,service_role;
grant execute on function public.performance_review_workspace_for_delegate(uuid) to authenticated;

create function public.start_performance_review_for_delegate(p_person_id uuid,p_operation_id uuid,p_employee_person_id uuid,p_cycle text,p_due_date text)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare actor record; review private.performance_reviews%rowtype; operation private.performance_review_operations%rowtype; body jsonb; receipt jsonb; due date; existing boolean; employee_snapshot jsonb; manager_snapshot jsonb;
begin
  select * into actor from private.performance_review_preview_actor(p_person_id);
  if actor.role<>'manager' or not private.lock_portal_role_actor() then raise exception 'Assigned Manager required.' using errcode='42501'; end if;
  if p_operation_id is null or p_employee_person_id is null or p_cycle is null or p_cycle !~ '^[0-9]{4}$' then raise exception 'Invalid review input.' using errcode='22023'; end if;
  due:=private.performance_review_date(p_due_date);
  perform private.performance_review_lock_people(array[actor.person_id,p_employee_person_id]);
  select * into actor from private.performance_review_preview_actor(p_person_id);
  if actor.role<>'manager' or not coalesce(private.performance_review_candidate(p_employee_person_id,actor.person_id),false) then raise exception 'Assigned Manager required.' using errcode='42501'; end if;
  select * into review from private.performance_reviews r where r.employee_person_id=p_employee_person_id and r.cycle=p_cycle for update;
  existing:=found;
  select * into strict actor from private.performance_review_preview_actor(p_person_id);
  if actor.role<>'manager' or not coalesce(private.performance_review_candidate(p_employee_person_id,actor.person_id),false) then raise exception 'Assigned Manager required.' using errcode='42501'; end if;
  if existing and private.performance_review_preview_audience(review,actor.person_id,'manager') is distinct from 'manager' then raise exception 'Assigned Manager required.' using errcode='42501'; end if;
  body:=jsonb_build_object('delegatePersonId',p_person_id,'command','start','employeePersonId',p_employee_person_id,'cycle',p_cycle,'dueDate',p_due_date);
  select * into operation from private.performance_review_operations o where o.actor_user_id=actor.actor_user_id and o.operation_id=p_operation_id;
  if found then
    if operation.body<>body then raise exception 'Operation collision.' using errcode='PT409'; end if;
    return operation.receipt;
  end if;
  if not existing then
    employee_snapshot:=private.performance_review_identity(p_employee_person_id);
    manager_snapshot:=jsonb_build_object('id',actor.person_id,'name',actor.display_name);
    if not private.performance_review_text(employee_snapshot->'name') or not private.performance_review_text(employee_snapshot->'jobTitle') or not private.performance_review_text(employee_snapshot->'team') or not private.performance_review_text(manager_snapshot->'name') then raise exception 'Invalid review identity.' using errcode='22023'; end if;
    insert into private.performance_reviews(employee_person_id,assigned_manager_person_id,cycle,due_date,employee_identity,manager_identity)
      values(p_employee_person_id,actor.person_id,p_cycle,due,employee_snapshot,manager_snapshot) returning * into review;
    insert into private.performance_review_events(review_id,subject_person_id,actor_user_id,kind) values(review.id,review.employee_person_id,actor.actor_user_id,'start');
  end if;
  receipt:=jsonb_build_object('committed',true,'operationId',p_operation_id,'review',private.performance_review_delegate_project(review,actor.person_id,actor.target_user_id),'existing',existing);
  insert into private.performance_review_operations(actor_user_id,operation_id,review_id,body,receipt) values(actor.actor_user_id,p_operation_id,review.id,body,receipt);
  return receipt;
end $$;
revoke all on function public.start_performance_review_for_delegate(uuid,uuid,uuid,text,text) from public,anon,authenticated,service_role;
grant execute on function public.start_performance_review_for_delegate(uuid,uuid,uuid,text,text) to authenticated;

create function public.mutate_performance_review_for_delegate(p_person_id uuid,p_operation_id uuid,p_review_id uuid,p_expected_revision text,p_command text,p_input jsonb)
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
  insert into private.performance_review_events(review_id,subject_person_id,actor_user_id,kind) values(review.id,review.employee_person_id,actor.actor_user_id,p_command);
  receipt:=jsonb_build_object('committed',true,'operationId',p_operation_id,'review',private.performance_review_delegate_project(review,actor.person_id,actor.target_user_id));
  insert into private.performance_review_operations(actor_user_id,operation_id,review_id,body,receipt) values(actor.actor_user_id,p_operation_id,review.id,body,receipt);
  return receipt;
end $$;
revoke all on function public.mutate_performance_review_for_delegate(uuid,uuid,uuid,text,text,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.mutate_performance_review_for_delegate(uuid,uuid,uuid,text,text,jsonb) to authenticated;

create function public.get_performance_review_operation_for_delegate(p_person_id uuid,p_operation_id uuid,p_review_id uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare actor record; operation private.performance_review_operations%rowtype; review private.performance_reviews%rowtype;
begin
  select * into strict actor from private.performance_review_preview_actor(p_person_id);
  if actor.role<>'manager' then raise exception 'Assigned Manager required.' using errcode='42501'; end if;
  if p_operation_id is null then raise exception 'Invalid operation identity.' using errcode='22023'; end if;
  select * into operation from private.performance_review_operations o where o.actor_user_id=actor.actor_user_id and o.operation_id=p_operation_id;
  if not found then return jsonb_build_object('status','not_found','review',null); end if;
  if operation.body->>'delegatePersonId' is distinct from p_person_id::text
    or (p_review_id is not null and operation.review_id<>p_review_id) then raise exception 'Performance review access denied.' using errcode='42501'; end if;
  select * into review from private.performance_reviews r where r.id=operation.review_id;
  if not found then raise exception 'Performance review access denied.' using errcode='42501'; end if;
  select * into strict actor from private.performance_review_preview_actor(p_person_id);
  if actor.role<>'manager' or private.performance_review_preview_audience(review,actor.person_id,'manager') is distinct from 'manager' then
    raise exception 'Performance review access denied.' using errcode='42501'; end if;
  return jsonb_build_object('status','committed','review',private.performance_review_delegate_project(review,actor.person_id,actor.target_user_id));
end $$;
revoke all on function public.get_performance_review_operation_for_delegate(uuid,uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function public.get_performance_review_operation_for_delegate(uuid,uuid,uuid) to authenticated;

do $delegate_catalog_after$
declare baseline record;
begin
  select * into strict baseline from pg_temp.performance_delegate_catalog_before;
  if exists((select definition collate "C" from pg_temp.performance_delegate_preserved_before
      except all select definition collate "C" from pg_temp.performance_delegate_preserved_catalog())
    union all (select definition collate "C" from pg_temp.performance_delegate_preserved_catalog()
      except all select definition collate "C" from pg_temp.performance_delegate_preserved_before))
    or (select schema_hash from private.confirmed_test_purge_schema where singleton) is distinct from baseline.stored_hash then
    raise exception 'Performance delegate unrelated catalog delta.' using errcode='55000';
  end if;
  if baseline.actual_hash=baseline.stored_hash then
    update private.confirmed_test_purge_schema set schema_hash=private.confirmed_test_purge_schema_hash()
      where singleton and schema_hash=baseline.stored_hash;
    if not found or private.confirmed_test_purge_schema_hash() is distinct from (select schema_hash from private.confirmed_test_purge_schema where singleton) then
      raise exception 'Performance delegate final purge fingerprint differs.' using errcode='55000';
    end if;
  end if;
end $delegate_catalog_after$;

commit;
