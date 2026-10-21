begin;
set local lock_timeout='5s';
set local statement_timeout='30s';
set local search_path='';
select pg_advisory_xact_lock(hashtextextended('mam:directory-role-control',0));

do $goals_final_catalog_lock$
begin
  if not pg_try_advisory_xact_lock(hashtextextended('confirmed-test-purge',0)) then
    raise exception 'Performance goals purge catalog busy.' using errcode='55P03';
  end if;
  lock table private.confirmed_test_purge_schema,private.performance_reviews,private.performance_review_events,private.performance_review_operations,private.performance_review_mail_outbox,private.performance_review_notifications,private.performance_review_meeting_requests,private.notification_delivery_receipts in share row exclusive mode nowait;
  if (select count(*) from private.confirmed_test_purge_schema)<>1 then
    raise exception 'Performance goals purge baseline differs.' using errcode='55000';
  end if;
end $goals_final_catalog_lock$;
create temporary table performance_goals_final_catalog_before on commit drop as
select schema_hash stored_hash,private.confirmed_test_purge_schema_hash() actual_hash
from private.confirmed_test_purge_schema where singleton;
create temporary table performance_goals_final_function_spec(signature text primary key,body_hash text) on commit drop;
insert into performance_goals_final_function_spec values
  ('private.performance_review_project(private.performance_reviews)','8fed101ff007287da5df2337a5301176c3760673f4091324c82811a7d9e41e80'),
  ('private.performance_review_preview_project(private.performance_reviews,uuid,text,uuid)','be7e2a3fa6b907e1a62d57fc617fd17405e4b01f17644c2d90c3e30b9c3df7b2'),
  ('private.performance_review_manager_input(jsonb,boolean)','ce645f48d63a417a4d908ae84c912452a8476d553aca1bd06d5dcd3ce6cc419b'),
  ('private.performance_review_document(private.performance_reviews,text)','4c994e7e444a7c4fc9247ff9af6a5f13fd3f0eb866219fb6bf237e64f90e9316'),
  ('private.performance_review_docx_bytes(jsonb)','b254eb0e913f9f2fcea51564e5e1e6ba745e1473e43487a0b154e9fa355d3ec3'),
  ('public.mutate_performance_review(uuid,uuid,text,text,jsonb)','e94f69c7dedfd8efd999d31b1de2d88a85dbb4e41827afd5cfa4ab562f792d51'),
  ('public.mutate_performance_review_for_delegate(uuid,uuid,uuid,text,text,jsonb)','703df4eefebddf9415248a957897f265cc488dfd5745d51f11234f7fe6b91c6d'),
  ('public.claim_performance_review_mail(uuid,integer)','af9fdd50eb5b46e3c30d1e847cffb6eaa6a382e10ede0aecdf50452f88dea0f6'),
  ('public.begin_performance_review_manager_mail(uuid,uuid,text,text)','d251c30676e986025defceb6da95bb3d514dc5de79424853e2838e148273559d'),
  ('private.performance_review_goals(jsonb,boolean)',null),
  ('private.performance_review_final_cc_recipients(private.performance_reviews)',null),
  ('public.begin_performance_review_final_mail(uuid,uuid,text,text,text[])',null);
do $goals_final_catalog_projection$
declare query text; anchor text; relations text[]:=array['performance_review_final_recipients','performance_review_final_recipients_pkey','performance_review_final_recipients_auth_user_id_key','performance_review_final_recipients_person_id_key'];
begin
  if exists(select 1 from pg_temp.performance_goals_final_function_spec s left join pg_proc p on p.oid=to_regprocedure(s.signature)
    where (s.body_hash is null and p.oid is not null) or (s.body_hash is not null and encode(extensions.digest(p.prosrc,'sha256'),'hex') is distinct from s.body_hash))
    or to_regclass('private.performance_review_final_recipients') is not null
    or exists(select 1 from pg_attribute where attrelid='private.performance_reviews'::regclass and attname='goals' and not attisdropped) then
    raise exception 'Performance goals predecessor differs.' using errcode='55000';
  end if;
  select prosrc into query from pg_proc where oid='private.confirmed_test_purge_schema_hash()'::regprocedure;
  if encode(extensions.digest(query,'sha256'),'hex') is distinct from 'c142665fb247c8761de408ce241e2f97aabe719c5d0801a5c53905892dd3de16' then
    raise exception 'Performance goals catalog collector differs.' using errcode='55000';
  end if;
  anchor:=E'select encode(extensions.digest(coalesce(string_agg(definition,E''\n'' order by definition),''''),''sha256''),''hex'') from (';
  query:=replace(query,anchor,'select definition from (');
  query:=replace(query,'and c.relkind in (''r'',''p'',''v'',''m'')',
    'and c.relkind in (''r'',''p'',''v'',''m'') and not (n.nspname=''private'' and c.relname=''performance_review_final_recipients'')');
  query:=replace(query,'and a.attnum>0 and not a.attisdropped',
    'and a.attnum>0 and not a.attisdropped and not (a.attrelid=''private.performance_reviews''::regclass and a.attname=''goals'') and not (n.nspname=''private'' and c.relname=any('||quote_literal(relations::text)||'::text[]))');
  query:=replace(query,'from pg_constraint where connamespace',
    'from pg_constraint where not (conrelid=coalesce(to_regclass(''private.performance_review_final_recipients''),0::oid) or (conrelid=''private.performance_reviews''::regclass and conname=''performance_reviews_goals_check'')) and (connamespace');
  query:=replace(query,'union all select tgrelid',') union all select tgrelid');
  query:=replace(query,'and p.prokind=''f''',
    'and p.prokind=''f'' and not exists(select 1 from pg_temp.performance_goals_final_function_spec s where to_regprocedure(s.signature)=p.oid)');
  execute 'create function pg_temp.performance_goals_final_preserved_catalog() returns table(definition text) language sql stable set search_path='''' as '||quote_literal(query);
end $goals_final_catalog_projection$;
create temporary table performance_goals_final_preserved_before on commit drop as
select * from pg_temp.performance_goals_final_preserved_catalog();
create temporary table performance_goals_final_metadata_before on commit drop as
select signature,to_jsonb(p)-'prosrc'-'proacl'-'proargdefaults' metadata,
  regexp_replace(p.proargdefaults::text,' :location -?[0-9]+',' :location -1','g') default_tree
from pg_temp.performance_goals_final_function_spec s join pg_proc p on p.oid=to_regprocedure(s.signature);
create temporary table performance_goals_final_rows_before on commit drop as
select 'performance_reviews' kind,id::text key,to_jsonb(r) document from private.performance_reviews r union all
select 'performance_review_events' kind,id::text key,to_jsonb(r) document from private.performance_review_events r union all
select 'performance_review_operations' kind,actor_user_id::text||':'||operation_id::text key,to_jsonb(r) document from private.performance_review_operations r union all
select 'performance_review_mail_outbox' kind,delivery_id::text key,to_jsonb(r) document from private.performance_review_mail_outbox r union all
select 'performance_review_notifications' kind,delivery_id::text key,to_jsonb(r) document from private.performance_review_notifications r union all
select 'performance_review_meeting_requests' kind,review_id::text key,to_jsonb(r) document from private.performance_review_meeting_requests r union all
select 'notification_delivery_receipts' kind,event_key::text key,to_jsonb(r) document from private.notification_delivery_receipts r;

create function private.performance_review_goals(p_goals jsonb,p_required boolean)
returns boolean language plpgsql immutable set search_path='' as $$
declare goal jsonb; field text; value jsonb;
begin
  if jsonb_typeof(p_goals) is distinct from 'array' or jsonb_array_length(p_goals)>10
    or (p_required and jsonb_array_length(p_goals)=0) then return false; end if;
  for goal in select * from jsonb_array_elements(p_goals) loop
    if not private.performance_review_closed(goal,array['priority','measureOfSuccess','supportAndResponsiblePerson','dueDate','progressCheck']) then return false; end if;
    foreach field in array array['priority','measureOfSuccess','supportAndResponsiblePerson','dueDate','progressCheck'] loop
      value:=goal->field;
      if not private.performance_review_text(value)
        or (select coalesce(sum(case when octet_length(c)=4 then 2 else 1 end),0)>2000 from regexp_split_to_table(value#>>'{}','') c)
        or (p_required and not private.performance_review_nonblank(value)) then return false; end if;
    end loop;
    if goal->>'dueDate'<>'' then perform private.performance_review_date(goal->>'dueDate'); end if;
  end loop;
  return true;
exception when invalid_parameter_value or datetime_field_overflow or invalid_datetime_format then return false;
end $$;
revoke all on function private.performance_review_goals(jsonb,boolean) from public,anon,authenticated,service_role;
alter table private.performance_reviews add column goals jsonb not null default '[]';
alter table private.performance_reviews add constraint performance_reviews_goals_check check(private.performance_review_goals(goals,false));

create table private.performance_review_final_recipients (
  slot text primary key check(slot in ('penny','steven')),
  auth_user_id uuid not null unique references public.profiles(id) on delete restrict,
  person_id uuid not null unique references public.internal_org_people(id) on delete restrict
);
alter table private.performance_review_final_recipients enable row level security;
alter table private.performance_review_final_recipients force row level security;
revoke all on private.performance_review_final_recipients from public,anon,authenticated,service_role;

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
  return result||jsonb_build_object('goals',p_review.goals,'managerAnswers',p_review.manager_answers,'ratings',p_review.ratings,'summary',p_review.summary,'overallRating',p_review.overall_rating,'managerNote',p_review.manager_note,'managerCompletedAt',p_review.manager_completed_at,'meeting',p_review.meeting,'meetingHeldAt',p_review.meeting_held_at,'finalisedAt',p_review.finalised_at,'managerActivity',manager_events,case when audience='manager' then 'managerRevision' else 'readRevision' end,case when audience='manager' then 'manager:' else 'read:' end||p_review.self_version||':'||p_review.manager_version,'capabilities',jsonb_build_object('saveSelf',false,'submitSelf',false,'saveManager',editable,'completeManager',editable,'saveMeeting',editable and p_review.manager_completed_at is not null,'submitReview',editable and p_review.manager_completed_at is not null,'downloadDocument',true));
end $$;

create or replace function private.performance_review_preview_project(p_review private.performance_reviews,p_person_id uuid,p_role text,p_target_user_id uuid)
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
  return result||jsonb_build_object('goals',p_review.goals,'managerAnswers',p_review.manager_answers,'ratings',p_review.ratings,'summary',p_review.summary,
    'overallRating',p_review.overall_rating,'managerNote',p_review.manager_note,'managerCompletedAt',p_review.manager_completed_at,
    'meeting',p_review.meeting,'meetingHeldAt',p_review.meeting_held_at,'finalisedAt',p_review.finalised_at,'managerActivity',manager_events,
    case when audience='manager' then 'managerRevision' else 'readRevision' end,
    case when audience='manager' then 'manager:' else 'read:' end||p_review.self_version||':'||p_review.manager_version,
    'capabilities',jsonb_build_object('saveSelf',false,'submitSelf',false,'saveManager',false,'completeManager',false,
      'saveMeeting',false,'submitReview',false,'downloadDocument',true));
end $$;

create or replace function private.performance_review_manager_input(p_input jsonb,p_required boolean)
returns boolean language plpgsql immutable set search_path='' as $$
declare i integer; rating text; domain text[]:=array['1 Needs improvement','2 Meets expectations','3 Exceeds expectations','N Not enough evidence'];
begin
  if not private.performance_review_closed(p_input,case when p_input ? 'goals' then array['answers','ratings','summary','overallRating','managerNote','goals'] else array['answers','ratings','summary','overallRating','managerNote'] end) or not private.performance_review_answers(p_input->'answers',p_required) or not private.performance_review_answers(p_input->'ratings',false) then return false; end if;
  if p_input ? 'goals' and not private.performance_review_goals(p_input->'goals',false) then return false; end if;
  if not private.performance_review_text(p_input->'summary') or not private.performance_review_text(p_input->'managerNote') or not private.performance_review_text(p_input->'overallRating') then return false; end if;
  if p_input->>'overallRating'<>'' and not (p_input->>'overallRating'=any(domain)) then return false; end if;
  for i in 0..11 loop
    rating:=p_input->'ratings'->>i;
    if rating<>'' and not (rating=any(domain)) then return false; end if;
    if p_required and i=any(array[0,1,2,6,7,8,9]) and rating='' then return false; end if;
  end loop;
  if p_required and (not private.performance_review_nonblank(p_input->'summary') or not private.performance_review_nonblank(p_input->'managerNote') or p_input->>'overallRating'='') then return false; end if;
  return true;
end $$;

create or replace function private.performance_review_document(p_review private.performance_reviews,p_audience text)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare result jsonb;
begin
  result:=jsonb_build_object('audience',p_audience,'code','PR-'||p_review.cycle||'-'||p_review.review_no,'cycle',p_review.cycle,'employee',p_review.employee_identity,'manager',p_review.manager_identity,'selfAnswers',p_review.self_answers);
  if p_audience='employee' then return result; end if;
  if p_review.final_document is not null then return p_review.final_document||jsonb_build_object('audience',p_audience); end if;
  return result||jsonb_build_object('goals',p_review.goals,'managerAnswers',p_review.manager_answers,'ratings',p_review.ratings,'summary',p_review.summary,'overallRating',p_review.overall_rating,'meeting',p_review.meeting);
end $$;

create or replace function private.performance_review_docx_bytes(p_document jsonb)
returns bigint language plpgsql immutable set search_path='' as $$
declare total bigint; value text; i integer; meeting jsonb:=p_document->'meeting'; goals jsonb:=coalesce(p_document->'goals','[]'::jsonb); goal jsonb; field text;
begin
  if p_document->>'audience' not in ('manager','admin') or p_document->'employee'->>'company' not in ('MAM','Equipsy') or jsonb_typeof(meeting) is distinct from 'object' then raise exception 'Invalid review document.' using errcode='22023'; end if;
  if not private.performance_review_goals(goals,false) then raise exception 'Invalid review goals.' using errcode='22023'; end if;
  total:=case p_document->'employee'->>'company' when 'MAM' then 50189 else 50161 end;
  if jsonb_array_length(goals)>0 then
    total:=total-337+1798*(jsonb_array_length(goals)-3);
    for goal in select * from jsonb_array_elements(goals) loop
      foreach field in array array['priority','measureOfSuccess','supportAndResponsiblePerson','dueDate','progressCheck'] loop
        total:=total+private.performance_review_word_text_bytes(goal->>field);
      end loop;
    end loop;
  end if;
  foreach value in array array[p_document->'employee'->>'name',p_document->'employee'->>'jobTitle',p_document->'employee'->>'team',p_document->'manager'->>'name',p_document->>'code',p_document->>'cycle',p_document->>'summary',p_document->>'overallRating',p_document->>'overallRating',meeting->>'date',meeting->>'date',meeting->>'time',meeting->>'time',meeting->>'duration',meeting->>'mode',meeting->>'location',meeting->>'notes'] loop
    total:=total+private.performance_review_word_text_bytes(value);
  end loop;
  for i in 0..11 loop
    total:=total+private.performance_review_word_text_bytes(p_document->'selfAnswers'->>i)+private.performance_review_word_text_bytes(p_document->'managerAnswers'->>i);
    if i=any(array[0,1,2,6,7,8,9]) then total:=total+private.performance_review_word_text_bytes(p_document->'ratings'->>i); end if;
  end loop;
  if total is null then raise exception 'Invalid review document.' using errcode='22023'; end if;
  return total;
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
      if not private.performance_review_manager_input(p_input,false) then raise exception 'Invalid manager assessment.' using errcode='22023'; end if;
      update private.performance_reviews set goals=case when p_input ? 'goals' then p_input->'goals' else goals end,manager_answers=p_input->'answers',ratings=p_input->'ratings',summary=p_input->>'summary',overall_rating=p_input->>'overallRating',manager_note=p_input->>'managerNote',manager_completed_at=case when p_command='complete_manager' then coalesce(manager_completed_at,clock_timestamp()) else manager_completed_at end,manager_version=manager_version+1 where id=p_review_id returning * into review;
    else
      if review.manager_completed_at is null or (p_command='submit_review' and not private.performance_review_manager_input(jsonb_build_object('answers',review.manager_answers,'ratings',review.ratings,'summary',review.summary,'overallRating',review.overall_rating,'managerNote',review.manager_note),true)) then raise exception 'Complete manager assessment first.' using errcode='22023'; end if;
      if p_command='submit_review' and not private.performance_review_goals(review.goals,true) then raise exception 'Complete review goals first.' using errcode='22023'; end if;
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
    update private.performance_reviews set goals=case when p_input ? 'goals' then p_input->'goals' else goals end,manager_answers=p_input->'answers',ratings=p_input->'ratings',summary=p_input->>'summary',overall_rating=p_input->>'overallRating',manager_note=p_input->>'managerNote',manager_completed_at=case when p_command='complete_manager' then coalesce(manager_completed_at,clock_timestamp()) else manager_completed_at end,manager_version=manager_version+1 where id=p_review_id returning * into review;
  else
    if review.manager_completed_at is null or (p_command='submit_review' and not private.performance_review_manager_input(jsonb_build_object('answers',review.manager_answers,'ratings',review.ratings,'summary',review.summary,'overallRating',review.overall_rating,'managerNote',review.manager_note),true)) then raise exception 'Complete manager assessment first.' using errcode='22023'; end if;
    if p_command='submit_review' and not private.performance_review_goals(review.goals,true) then raise exception 'Complete review goals first.' using errcode='22023'; end if;
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

create or replace function public.claim_performance_review_mail(p_review_id uuid default null,p_limit integer default 10)
returns table(delivery_id uuid,review_id uuid,claim_token uuid,payload jsonb)
language plpgsql volatile security definer set search_path='' as $$
begin
  if p_limit is null or p_limit not between 1 and 10 then raise exception 'Invalid mail claim limit.' using errcode='22023'; end if;
  perform pg_advisory_xact_lock_shared(hashtextextended('mam:directory-role-control',0));
  return query
    with selected as (
      select o.delivery_id,private.performance_review_final_recipient(r) recipient,private.performance_review_final_cc_recipients(r) cc_recipients
      from private.performance_review_mail_outbox o join private.performance_reviews r on r.id=o.review_id
      where o.state='queued' and (p_review_id is null or o.review_id=p_review_id)
        and r.finalised_at is not null and r.final_document is not null
      order by o.queued_at,o.delivery_id limit p_limit for update of o,r skip locked
    ), claimed as (
      update private.performance_review_mail_outbox o set state='claimed',claim_token=gen_random_uuid(),claimed_at=clock_timestamp()
      from selected s where o.delivery_id=s.delivery_id and o.state='queued'
      returning o.delivery_id,o.review_id,o.claim_token,s.recipient,s.cc_recipients
    )
    select c.delivery_id,c.review_id,c.claim_token,jsonb_build_object('reviewId',r.id,'reviewCode',r.final_document->>'code','finalisedAt',r.finalised_at,'managerNote',r.manager_note,'document',r.final_document,'recipient',c.recipient,'ccRecipients',c.cc_recipients)
    from claimed c join private.performance_reviews r on r.id=c.review_id;
end $$;

create function private.performance_review_final_cc_recipients(p_review private.performance_reviews)
returns text[] language plpgsql stable security definer set search_path='' as $$
declare recipient text; addresses text[];
begin
  recipient:=private.performance_review_final_recipient(p_review);
  if recipient is null or (select count(*) from private.performance_review_final_recipients)<>2 then return null; end if;
  select array_agg(eligible.email order by eligible.email collate "C") into addresses from (
    select lower(btrim(detail.work_email)) email
    from private.performance_review_final_recipients configured
    join public.internal_org_people p on p.id=configured.person_id and p.auth_user_id=configured.auth_user_id
    cross join lateral private.portal_role_policy(configured.auth_user_id) policy
    join private.employee_directory_details detail on detail.person_id=p.id
    where configured.slot in ('penny','steven') and p.node_kind='person' and p.is_active
      and policy.person_id=p.id and policy.app_role in ('admin','system_admin')
      and detail.work_email is not null and length(lower(btrim(detail.work_email)))<=254
      and detail.work_email !~ '[[:cntrl:]]' and lower(btrim(detail.work_email))<>'careers@mobilityaccess.com.au'
      and lower(btrim(detail.work_email)) ~ '^[^[:space:]@,;]+@(mobilityaccess\.com\.au|equipsy\.com\.au)$'
      and (select count(*) from private.employee_directory_details other where lower(btrim(other.work_email))=lower(btrim(detail.work_email)))=1
  ) eligible;
  if cardinality(addresses) is distinct from 2 or addresses[1]=addresses[2] then return null; end if;
  return array(select email from unnest(addresses) email where email<>recipient and not exists(select 1 from private.performance_review_final_recipients configured join private.employee_directory_details detail on detail.person_id=configured.person_id where configured.person_id=p_review.employee_person_id and lower(btrim(detail.work_email))=email) order by email collate "C");
end $$;
revoke all on function private.performance_review_final_cc_recipients(private.performance_reviews) from public,anon,authenticated,service_role;

create function public.begin_performance_review_final_mail(p_delivery_id uuid,p_claim_token uuid,p_attachment_sha256 text,p_recipient text,p_cc_recipients text[])
returns boolean language plpgsql volatile security definer set search_path='' as $$
declare review private.performance_reviews%rowtype; recipient text; cc_recipients text[];
begin
  perform pg_advisory_xact_lock_shared(hashtextextended('mam:directory-role-control',0));
  lock table private.performance_review_final_recipients in share mode;
  select r.* into review from private.performance_reviews r
  join private.performance_review_mail_outbox o on o.review_id=r.id
  where o.delivery_id=p_delivery_id and o.claim_token=p_claim_token and o.state='claimed' for share of r;
  if not found then return false; end if;
  recipient:=private.performance_review_final_recipient(review);
  cc_recipients:=private.performance_review_final_cc_recipients(review);
  if recipient is null or recipient is distinct from p_recipient or cardinality(cc_recipients) not between 0 and 2
    or cc_recipients is null or cc_recipients is distinct from p_cc_recipients then return false; end if;
  return public.begin_performance_review_mail(p_delivery_id,p_claim_token,p_attachment_sha256);
end $$;
revoke all on function public.begin_performance_review_final_mail(uuid,uuid,text,text,text[]) from public,anon,authenticated;
grant execute on function public.begin_performance_review_final_mail(uuid,uuid,text,text,text[]) to service_role;
revoke all on function public.begin_performance_review_manager_mail(uuid,uuid,text,text) from public,anon,authenticated,service_role;

do $goals_final_catalog_after$
declare baseline record;
begin
  select * into strict baseline from pg_temp.performance_goals_final_catalog_before;
  if exists((select definition collate "C" from pg_temp.performance_goals_final_preserved_before
      except all select definition collate "C" from pg_temp.performance_goals_final_preserved_catalog())
    union all (select definition collate "C" from pg_temp.performance_goals_final_preserved_catalog()
      except all select definition collate "C" from pg_temp.performance_goals_final_preserved_before))
    or exists(with current_rows as (select 'performance_reviews' kind,id::text key,to_jsonb(r)-'goals' document from private.performance_reviews r union all
select 'performance_review_events' kind,id::text key,to_jsonb(r) document from private.performance_review_events r union all
select 'performance_review_operations' kind,actor_user_id::text||':'||operation_id::text key,to_jsonb(r) document from private.performance_review_operations r union all
select 'performance_review_mail_outbox' kind,delivery_id::text key,to_jsonb(r) document from private.performance_review_mail_outbox r union all
select 'performance_review_notifications' kind,delivery_id::text key,to_jsonb(r) document from private.performance_review_notifications r union all
select 'performance_review_meeting_requests' kind,review_id::text key,to_jsonb(r) document from private.performance_review_meeting_requests r union all
select 'notification_delivery_receipts' kind,event_key::text key,to_jsonb(r) document from private.notification_delivery_receipts r) (select * from pg_temp.performance_goals_final_rows_before except all select * from current_rows) union all (select * from current_rows except all select * from pg_temp.performance_goals_final_rows_before))
    or exists(select 1 from private.performance_reviews where goals is distinct from '[]'::jsonb)
    or exists(select 1 from private.performance_review_final_recipients)
    or exists(select 1 from pg_temp.performance_goals_final_metadata_before b join pg_proc p on p.oid=to_regprocedure(b.signature) where to_jsonb(p)-'prosrc'-'proacl'-'proargdefaults' is distinct from b.metadata
      or regexp_replace(p.proargdefaults::text,' :location -?[0-9]+',' :location -1','g') is distinct from b.default_tree)
    or exists(select 1 from pg_temp.performance_goals_final_function_spec s join pg_proc p on p.oid=to_regprocedure(s.signature),
      lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) acl
      where acl.grantee<>p.proowner and not (acl.privilege_type='EXECUTE' and not acl.is_grantable and (
        (acl.grantee='service_role'::regrole and s.signature in ('public.claim_performance_review_mail(uuid,integer)','public.begin_performance_review_final_mail(uuid,uuid,text,text,text[])'))
        or (acl.grantee='authenticated'::regrole and s.signature in ('public.mutate_performance_review(uuid,uuid,text,text,jsonb)','public.mutate_performance_review_for_delegate(uuid,uuid,uuid,text,text,jsonb)')))))
    or not has_function_privilege('service_role','public.claim_performance_review_mail(uuid,integer)','execute')
    or not has_function_privilege('service_role','public.begin_performance_review_final_mail(uuid,uuid,text,text,text[])','execute')
    or not has_function_privilege('authenticated','public.mutate_performance_review(uuid,uuid,text,text,jsonb)','execute')
    or not has_function_privilege('authenticated','public.mutate_performance_review_for_delegate(uuid,uuid,uuid,text,text,jsonb)','execute')
    or exists(select 1 from pg_class c,lateral aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) acl where c.oid='private.performance_review_final_recipients'::regclass and acl.grantee<>c.relowner)
    or not (select relrowsecurity and relforcerowsecurity from pg_class where oid='private.performance_review_final_recipients'::regclass)
    or (select schema_hash from private.confirmed_test_purge_schema where singleton) is distinct from baseline.stored_hash then
    raise exception 'Performance goals unrelated catalog delta.' using errcode='55000';
  end if;
  if baseline.actual_hash=baseline.stored_hash then
    update private.confirmed_test_purge_schema set schema_hash=private.confirmed_test_purge_schema_hash()
      where singleton and schema_hash=baseline.stored_hash;
    if not found or private.confirmed_test_purge_schema_hash() is distinct from (select schema_hash from private.confirmed_test_purge_schema where singleton) then
      raise exception 'Performance goals final purge fingerprint differs.' using errcode='55000';
    end if;
  end if;
end $goals_final_catalog_after$;

commit;
