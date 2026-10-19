begin;
set local search_path='';
select pg_advisory_xact_lock(hashtextextended('mam:directory-role-control',0));

do $preview_catalog_lock$
begin
  if not pg_try_advisory_xact_lock(hashtextextended('confirmed-test-purge',0)) then
    raise exception 'Performance preview purge catalog busy.' using errcode='55P03';
  end if;
  lock table private.confirmed_test_purge_schema in share row exclusive mode nowait;
  if (select count(*) from private.confirmed_test_purge_schema)<>1 then
    raise exception 'Performance preview purge baseline differs.' using errcode='55000';
  end if;
end $preview_catalog_lock$;
create temporary table performance_preview_catalog_before on commit drop as
select schema_hash stored_hash,private.confirmed_test_purge_schema_hash() actual_hash
from private.confirmed_test_purge_schema where singleton;
create temporary table performance_preview_function_spec(signature text primary key) on commit drop;
insert into performance_preview_function_spec values
  ('private.performance_review_preview_actor(uuid)'),
  ('private.performance_review_preview_audience(private.performance_reviews,uuid,text)'),
  ('private.performance_review_preview_project(private.performance_reviews,uuid,text,uuid)'),
  ('public.performance_review_workspace_for_preview(uuid)'),
  ('public.get_performance_review_document_for_preview(uuid,uuid)');
do $preview_catalog_projection$
declare query text; anchor text;
begin
  select prosrc into query from pg_proc where oid='private.confirmed_test_purge_schema_hash()'::regprocedure;
  if encode(extensions.digest(query,'sha256'),'hex') is distinct from 'c142665fb247c8761de408ce241e2f97aabe719c5d0801a5c53905892dd3de16' then
    raise exception 'Performance preview catalog collector differs.' using errcode='55000';
  end if;
  anchor:=E'select encode(extensions.digest(coalesce(string_agg(definition,E''\\n'' order by definition),''''),''sha256''),''hex'') from (';
  query:=replace(query,anchor,'select definition from (');
  query:=replace(query,'and p.prokind=''f''',
    'and p.prokind=''f'' and not exists(select 1 from pg_temp.performance_preview_function_spec s where to_regprocedure(s.signature)=p.oid)');
  execute 'create function pg_temp.performance_preview_preserved_catalog() returns table(definition text) language sql stable set search_path='''' as '||quote_literal(query);
end $preview_catalog_projection$;
create temporary table performance_preview_preserved_before on commit drop as
select * from pg_temp.performance_preview_preserved_catalog();

create function private.performance_review_preview_actor(p_person_id uuid)
returns table(actor_user_id uuid,person_id uuid,role text,target_user_id uuid,display_name text)
language plpgsql stable security definer set search_path='' as $$
begin
  if not coalesce(private.is_system_portal_account_admin(),false) then
    raise exception 'Only System Admin may preview performance reviews.' using errcode='42501';
  end if;
  return query select auth.uid(),person.id,policy.app_role,person.auth_user_id,person.full_name
    from public.internal_org_people person
    cross join lateral private.portal_role_policy(person.auth_user_id) policy
    where person.id=p_person_id and person.node_kind='person' and person.is_active
      and person.auth_user_id is not null and policy.person_id=person.id;
  if not found then raise exception 'The selected active portal account is unavailable.' using errcode='42501'; end if;
end $$;
revoke all on function private.performance_review_preview_actor(uuid) from public,anon,authenticated,service_role;

create function private.performance_review_preview_audience(p_review private.performance_reviews,p_person_id uuid,p_role text)
returns text language plpgsql stable security definer set search_path='' as $$
begin
  if p_role in ('admin','system_admin') then return 'admin'; end if;
  if p_role in ('employee','manager','account') and p_person_id=p_review.employee_person_id then return 'employee'; end if;
  if p_role='manager' and p_person_id=p_review.assigned_manager_person_id and exists(
    select 1 from public.internal_org_people e join public.internal_org_people m on m.id=p_person_id and e.company_key=m.company_key
    cross join lateral private.portal_role_policy(e.auth_user_id) ep
    where e.id=p_review.employee_person_id and e.is_active and e.node_kind='person' and m.is_active and m.node_kind='person'
      and ep.person_id=e.id and ep.app_role in ('employee','manager','account')) then return 'manager'; end if;
  return null;
end $$;
revoke all on function private.performance_review_preview_audience(private.performance_reviews,uuid,text) from public,anon,authenticated,service_role;

create function private.performance_review_preview_project(p_review private.performance_reviews,p_person_id uuid,p_role text,p_target_user_id uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare audience text; result jsonb; self_events jsonb; manager_events jsonb;
begin
  audience:=private.performance_review_preview_audience(p_review,p_person_id,p_role);
  if audience is null then raise exception 'Performance review access denied.' using errcode='42501'; end if;
  select coalesce(jsonb_agg(jsonb_build_object('kind',e.kind,'at',e.at) order by e.id),'[]') into self_events
    from private.performance_review_events e where e.review_id=p_review.id and e.kind in ('save_self','submit_self')
      and (audience<>'employee' or e.actor_user_id=p_target_user_id);
  result:=jsonb_build_object('id',p_review.id,'code','PR-'||p_review.cycle||'-'||p_review.review_no,
    'employee',p_review.employee_identity,'manager',p_review.manager_identity,'cycle',p_review.cycle,
    'dueDate',to_char(p_review.due_date,'YYYY-MM-DD'),'selfStatus',case when p_review.self_submitted_at is null then 'awaiting_employee' else 'manager_review' end,
    'selfAnswers',p_review.self_answers,'selfSubmittedAt',p_review.self_submitted_at,'selfRevision','self:'||p_review.self_version,
    'selfActivity',self_events,'audience',audience);
  if audience='employee' then
    return result||jsonb_build_object('capabilities',jsonb_build_object('saveSelf',false,'submitSelf',false,'downloadDocument',true));
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('kind',e.kind,'at',e.at) order by e.id),'[]') into manager_events
    from private.performance_review_events e where e.review_id=p_review.id and e.kind not in ('save_self','submit_self');
  return result||jsonb_build_object('managerAnswers',p_review.manager_answers,'ratings',p_review.ratings,'summary',p_review.summary,
    'overallRating',p_review.overall_rating,'managerNote',p_review.manager_note,'managerCompletedAt',p_review.manager_completed_at,
    'meeting',p_review.meeting,'meetingHeldAt',p_review.meeting_held_at,'finalisedAt',p_review.finalised_at,'managerActivity',manager_events,
    case when audience='manager' then 'managerRevision' else 'readRevision' end,
    case when audience='manager' then 'manager:' else 'read:' end||p_review.self_version||':'||p_review.manager_version,
    'capabilities',jsonb_build_object('saveSelf',false,'submitSelf',false,'saveManager',false,'completeManager',false,
      'saveMeeting',false,'submitReview',false,'downloadDocument',true));
end $$;
revoke all on function private.performance_review_preview_project(private.performance_reviews,uuid,text,uuid) from public,anon,authenticated,service_role;

create function public.performance_review_workspace_for_preview(p_person_id uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare viewer record; candidates jsonb; reviews jsonb;
begin
  select * into strict viewer from private.performance_review_preview_actor(p_person_id);
  select coalesce(jsonb_agg(private.performance_review_identity(p.id) order by p.company_key,p.full_name,p.id),'[]') into candidates
    from public.internal_org_people p where viewer.role='manager' and private.performance_review_candidate(p.id,viewer.person_id);
  select coalesce(jsonb_agg(private.performance_review_preview_project(r,viewer.person_id,viewer.role,viewer.target_user_id)
    order by r.cycle,r.due_date,r.review_no),'[]') into reviews from private.performance_reviews r
    where private.performance_review_preview_audience(r,viewer.person_id,viewer.role) is not null;
  return jsonb_build_object('viewerContext',jsonb_build_object('actorUserId',viewer.actor_user_id,'personId',viewer.person_id,
    'role',viewer.role,'displayName',viewer.display_name),'reviews',reviews,'startablePeople',candidates);
end $$;
revoke all on function public.performance_review_workspace_for_preview(uuid) from public,anon,authenticated,service_role;
grant execute on function public.performance_review_workspace_for_preview(uuid) to authenticated;

create function public.get_performance_review_document_for_preview(p_person_id uuid,p_review_id uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare viewer record; review private.performance_reviews%rowtype; audience text;
begin
  select * into strict viewer from private.performance_review_preview_actor(p_person_id);
  select * into review from private.performance_reviews r where r.id=p_review_id;
  if not found then raise exception 'Performance review access denied.' using errcode='42501'; end if;
  audience:=private.performance_review_preview_audience(review,viewer.person_id,viewer.role);
  if audience is null then raise exception 'Performance review access denied.' using errcode='42501'; end if;
  return private.performance_review_document(review,audience);
end $$;
revoke all on function public.get_performance_review_document_for_preview(uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function public.get_performance_review_document_for_preview(uuid,uuid) to authenticated;

do $preview_catalog_after$
declare baseline record;
begin
  select * into strict baseline from pg_temp.performance_preview_catalog_before;
  if exists((select definition collate "C" from pg_temp.performance_preview_preserved_before
      except all select definition collate "C" from pg_temp.performance_preview_preserved_catalog())
    union all (select definition collate "C" from pg_temp.performance_preview_preserved_catalog()
      except all select definition collate "C" from pg_temp.performance_preview_preserved_before))
    or (select schema_hash from private.confirmed_test_purge_schema where singleton) is distinct from baseline.stored_hash then
    raise exception 'Performance preview unrelated catalog delta.' using errcode='55000';
  end if;
  if baseline.actual_hash=baseline.stored_hash then
    update private.confirmed_test_purge_schema set schema_hash=private.confirmed_test_purge_schema_hash()
      where singleton and schema_hash=baseline.stored_hash;
    if not found or private.confirmed_test_purge_schema_hash() is distinct from (select schema_hash from private.confirmed_test_purge_schema where singleton) then
      raise exception 'Performance preview final purge fingerprint differs.' using errcode='55000';
    end if;
  end if;
end $preview_catalog_after$;

commit;
