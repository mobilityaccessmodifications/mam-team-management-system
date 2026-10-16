begin;
create table private.performance_reviews (
  id uuid primary key default gen_random_uuid(),
  review_no bigint generated always as identity unique,
  employee_person_id uuid not null references public.internal_org_people(id) on delete restrict,
  assigned_manager_person_id uuid not null references public.internal_org_people(id) on delete restrict,
  cycle text not null check(cycle ~ '^[0-9]{4}$'),
  due_date date not null,
  employee_identity jsonb not null,
  manager_identity jsonb not null,
  self_answers jsonb not null default '["","","","","","","","","","","",""]',
  self_submitted_at timestamptz,
  self_version bigint not null default 0 check(self_version>=0),
  manager_answers jsonb not null default '["","","","","","","","","","","",""]',
  ratings jsonb not null default '["","","","","","","","","","","",""]',
  summary text not null default '',
  overall_rating text not null default '',
  manager_note text not null default '',
  manager_completed_at timestamptz,
  manager_version bigint not null default 0 check(manager_version>=0),
  meeting jsonb,
  meeting_held_at timestamptz,
  finalised_at timestamptz,
  final_document jsonb,
  unique(employee_person_id,cycle),
  check(employee_person_id<>assigned_manager_person_id)
);
create table private.performance_review_events (
  id bigint generated always as identity primary key,
  review_id uuid not null references private.performance_reviews(id) on delete restrict,
  subject_person_id uuid not null references public.internal_org_people(id) on delete restrict,
  actor_user_id uuid not null references auth.users(id) on delete restrict,
  kind text not null check(kind in ('start','save_self','submit_self','save_manager','complete_manager','save_meeting','submit_review')),
  at timestamptz not null default clock_timestamp()
);
create table private.performance_review_operations (
  actor_user_id uuid not null references auth.users(id) on delete restrict,
  operation_id uuid not null,
  review_id uuid not null references private.performance_reviews(id) on delete restrict,
  body jsonb not null,
  receipt jsonb not null,
  created_at timestamptz not null default clock_timestamp(),
  primary key(actor_user_id,operation_id)
);
alter table private.performance_reviews enable row level security;
alter table private.performance_reviews force row level security;
alter table private.performance_review_events enable row level security;
alter table private.performance_review_events force row level security;
alter table private.performance_review_operations enable row level security;
alter table private.performance_review_operations force row level security;
revoke all on private.performance_reviews,private.performance_review_events,private.performance_review_operations from public,anon,authenticated,service_role;
revoke all on sequence private.performance_reviews_review_no_seq,private.performance_review_events_id_seq from public,anon,authenticated,service_role;
create trigger reject_retired_test_identity_reference before insert or update on private.performance_reviews for each row execute function private.reject_retired_test_identity_reference();
create trigger reject_retired_test_identity_reference before insert or update on private.performance_review_events for each row execute function private.reject_retired_test_identity_reference();
create trigger reject_retired_test_identity_reference before insert or update on private.performance_review_operations for each row execute function private.reject_retired_test_identity_reference();
create function private.performance_review_actor()
returns table(actor_user_id uuid,role text,person_id uuid,display_name text)
language plpgsql volatile security definer set search_path='' as $$
begin
  return query select auth.uid(),policy.app_role,policy.person_id,coalesce(person.full_name,'Super Admin')
    from private.portal_role_policy() policy left join public.internal_org_people person on person.id=policy.person_id;
  if not found or auth.uid() is null then raise exception 'Performance review access denied.' using errcode='42501'; end if;
end $$;
create function private.performance_review_identity(p_person_id uuid)
returns jsonb language sql stable security definer set search_path='' as $$
  select jsonb_build_object('id',p.id,'name',p.full_name,'jobTitle',p.position_title,'company',case p.company_key when 'mam' then 'MAM' when 'equipsy' then 'Equipsy' end,'team',coalesce(d.team_name,''))
  from public.internal_org_people p left join private.employee_directory_details d on d.person_id=p.id
  where p.id=p_person_id and p.node_kind='person' and p.is_active;
$$;
create function private.performance_review_candidate(p_employee uuid,p_manager uuid)
returns boolean language sql stable security definer set search_path='' as $$
  select p_employee<>p_manager and exists(
    select 1 from public.internal_org_people e join public.internal_org_people m on m.id=p_manager and m.company_key=e.company_key
    cross join lateral private.portal_role_policy(m.auth_user_id) mp
    cross join lateral private.portal_role_policy(e.auth_user_id) ep
    cross join lateral private.resolve_internal_org_employee_manager(e.id) candidate
    where e.id=p_employee and e.node_kind='person' and e.is_active and m.node_kind='person' and m.is_active
      and ep.person_id=e.id and ep.app_role in ('employee','manager','account') and mp.person_id=m.id and mp.app_role='manager' and candidate.manager_id=m.id);
$$;
revoke all on function private.performance_review_actor(),private.performance_review_identity(uuid),private.performance_review_candidate(uuid,uuid) from public,anon,authenticated,service_role;
create function private.performance_review_date(p_value text)
returns date language plpgsql immutable set search_path='' as $$
declare parsed date;
begin
  if p_value is null or p_value !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then raise exception 'Invalid review date.' using errcode='22023'; end if;
  begin parsed:=p_value::date; exception when others then raise exception 'Invalid review date.' using errcode='22023'; end;
  if to_char(parsed,'YYYY-MM-DD')<>p_value then raise exception 'Invalid review date.' using errcode='22023'; end if;
  return parsed;
end $$;
create function private.performance_review_lock_people(p_ids uuid[])
returns void language plpgsql volatile security definer set search_path='' as $$
begin
  perform 1 from public.profiles profile where profile.id in(select p.auth_user_id from public.internal_org_people p where p.id=any(p_ids)) order by profile.id for share;
  perform 1 from public.internal_org_people p where p.id=any(p_ids) order by p.id for share;
end $$;
create function private.performance_review_audience(p_review private.performance_reviews)
returns text language plpgsql volatile security definer set search_path='' as $$
declare actor record;
begin
  select * into actor from private.performance_review_actor();
  if actor.role in ('admin','system_admin') then return 'admin'; end if;
  if actor.person_id=p_review.employee_person_id then return 'employee'; end if;
  if actor.role='manager' and actor.person_id=p_review.assigned_manager_person_id and exists(
    select 1 from public.internal_org_people e join public.internal_org_people m on m.id=actor.person_id and e.company_key=m.company_key
    cross join lateral private.portal_role_policy(e.auth_user_id) ep
    where e.id=p_review.employee_person_id and e.is_active and e.node_kind='person' and m.is_active and m.node_kind='person' and ep.person_id=e.id and ep.app_role in ('employee','manager','account')) then return 'manager'; end if;
  return null;
end $$;
create function private.performance_review_project(p_review private.performance_reviews)
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
  editable:=audience='manager' and p_review.self_submitted_at is not null and p_review.finalised_at is null;
  return result||jsonb_build_object('managerAnswers',p_review.manager_answers,'ratings',p_review.ratings,'summary',p_review.summary,'overallRating',p_review.overall_rating,'managerNote',p_review.manager_note,'managerCompletedAt',p_review.manager_completed_at,'meeting',p_review.meeting,'meetingHeldAt',p_review.meeting_held_at,'finalisedAt',p_review.finalised_at,'managerActivity',manager_events,case when audience='manager' then 'managerRevision' else 'readRevision' end,case when audience='manager' then 'manager:' else 'read:' end||p_review.self_version||':'||p_review.manager_version,'capabilities',jsonb_build_object('saveSelf',false,'submitSelf',false,'saveManager',editable,'completeManager',editable,'saveMeeting',editable and p_review.manager_completed_at is not null,'submitReview',editable and p_review.manager_completed_at is not null,'downloadDocument',true));
end $$;
create function public.performance_review_workspace()
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare actor record; candidates jsonb; reviews jsonb;
begin
  select * into actor from private.performance_review_actor();
  select coalesce(jsonb_agg(private.performance_review_identity(p.id) order by p.company_key,p.full_name,p.id),'[]') into candidates from public.internal_org_people p where actor.role='manager' and private.performance_review_candidate(p.id,actor.person_id);
  select coalesce(jsonb_agg(private.performance_review_project(r) order by r.cycle,r.due_date,r.review_no),'[]') into reviews from private.performance_reviews r where private.performance_review_audience(r) is not null;
  return jsonb_build_object('viewerContext',jsonb_build_object('actorUserId',actor.actor_user_id,'personId',actor.person_id,'role',actor.role,'displayName',actor.display_name),'reviews',reviews,'startablePeople',candidates);
end $$;
create function public.start_performance_review(p_operation_id uuid,p_employee_person_id uuid,p_cycle text,p_due_date text)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare actor record; review private.performance_reviews%rowtype; operation private.performance_review_operations%rowtype; body jsonb; receipt jsonb; due date; existing boolean;
begin
  select * into actor from private.performance_review_actor();
  if actor.role<>'manager' or not private.lock_portal_role_actor() then raise exception 'Assigned Manager required.' using errcode='42501'; end if;
  if p_operation_id is null or p_employee_person_id is null or p_cycle is null or p_cycle !~ '^[0-9]{4}$' then raise exception 'Invalid review input.' using errcode='22023'; end if;
  due:=private.performance_review_date(p_due_date);
  perform private.performance_review_lock_people(array[actor.person_id,p_employee_person_id]);
  select * into actor from private.performance_review_actor();
  if actor.role<>'manager' or not coalesce(private.performance_review_candidate(p_employee_person_id,actor.person_id),false) then raise exception 'Assigned Manager required.' using errcode='42501'; end if;
  select * into review from private.performance_reviews r where r.employee_person_id=p_employee_person_id and r.cycle=p_cycle for update;
  existing:=found;
  if existing and private.performance_review_audience(review) is distinct from 'manager' then raise exception 'Assigned Manager required.' using errcode='42501'; end if;
  body:=jsonb_build_object('command','start','employeePersonId',p_employee_person_id,'cycle',p_cycle,'dueDate',p_due_date);
  select * into operation from private.performance_review_operations o where o.actor_user_id=actor.actor_user_id and o.operation_id=p_operation_id;
  if found then
    if operation.body<>body then raise exception 'Operation collision.' using errcode='PT409'; end if;
    return operation.receipt;
  end if;
  if not existing then
    insert into private.performance_reviews(employee_person_id,assigned_manager_person_id,cycle,due_date,employee_identity,manager_identity)
      values(p_employee_person_id,actor.person_id,p_cycle,due,private.performance_review_identity(p_employee_person_id),jsonb_build_object('id',actor.person_id,'name',actor.display_name)) returning * into review;
    insert into private.performance_review_events(review_id,subject_person_id,actor_user_id,kind) values(review.id,review.employee_person_id,actor.actor_user_id,'start');
  end if;
  receipt:=jsonb_build_object('committed',true,'operationId',p_operation_id,'review',private.performance_review_project(review),'existing',existing);
  insert into private.performance_review_operations(actor_user_id,operation_id,review_id,body,receipt) values(actor.actor_user_id,p_operation_id,review.id,body,receipt);
  return receipt;
end $$;
revoke all on function private.performance_review_date(text),private.performance_review_lock_people(uuid[]),private.performance_review_audience(private.performance_reviews),private.performance_review_project(private.performance_reviews),public.start_performance_review(uuid,uuid,text,text),public.performance_review_workspace() from public,anon,authenticated,service_role;
grant execute on function public.start_performance_review(uuid,uuid,text,text),public.performance_review_workspace() to authenticated;
create function private.performance_review_closed(p_value jsonb,p_keys text[])
returns boolean language sql immutable set search_path='' as $$
  select coalesce(jsonb_typeof(p_value)='object' and (select array_agg(k order by k) from jsonb_object_keys(p_value) k)=(select array_agg(k order by k) from unnest(p_keys) k),false);
$$;
create function private.performance_review_text(p_value jsonb)
returns boolean language sql immutable set search_path='' as $$
  select coalesce(jsonb_typeof(p_value)='string' and (select coalesce(sum(case when octet_length(c)=4 then 2 else 1 end),0)<=8000 from regexp_split_to_table(p_value#>>'{}','') c),false);
$$;
create function private.performance_review_nonblank(p_value jsonb)
returns boolean language sql immutable set search_path='' as $$
  select private.performance_review_text(p_value) and btrim(p_value#>>'{}',U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF')<>'';
$$;
create function private.performance_review_answers(p_answers jsonb,p_required boolean)
returns boolean language plpgsql immutable set search_path='' as $$
declare i integer;
begin
  if jsonb_typeof(p_answers) is distinct from 'array' or jsonb_array_length(p_answers)<>12 then return false; end if;
  for i in 0..11 loop
    if not private.performance_review_text(p_answers->i) then return false; end if;
    if p_required and i=any(array[0,3,4,5,6,7,8,9,10]) and not private.performance_review_nonblank(p_answers->i) then return false; end if;
  end loop;
  return true;
end $$;
create function private.performance_review_manager_input(p_input jsonb,p_required boolean)
returns boolean language plpgsql immutable set search_path='' as $$
declare i integer; rating text; domain text[]:=array['1 Needs improvement','2 Meets expectations','3 Exceeds expectations','N Not enough evidence'];
begin
  if not private.performance_review_closed(p_input,array['answers','ratings','summary','overallRating','managerNote']) or not private.performance_review_answers(p_input->'answers',p_required) or not private.performance_review_answers(p_input->'ratings',false) then return false; end if;
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
revoke all on function private.performance_review_manager_input(jsonb,boolean) from public,anon,authenticated,service_role;
create function private.performance_review_meeting_end(p_input jsonb,p_held boolean)
returns timestamptz language plpgsql immutable set search_path='' as $$
declare local_time timestamp; initial timestamptz; meeting_start timestamptz; matches integer; duration numeric; location text; port text;
begin
  if not private.performance_review_closed(p_input,case when p_held then array['date','time','duration','mode','location','notes','held'] else array['date','time','duration','mode','location','notes'] end)
    or (p_held and p_input->'held' is distinct from 'true'::jsonb)
    or jsonb_typeof(p_input->'date') is distinct from 'string' or jsonb_typeof(p_input->'time') is distinct from 'string'
    or p_input->>'time' !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
    or jsonb_typeof(p_input->'duration') is distinct from 'number' or jsonb_typeof(p_input->'mode') is distinct from 'string' or p_input->>'mode' not in ('in_person','teams','phone')
    or not private.performance_review_nonblank(p_input->'location') or not private.performance_review_text(p_input->'notes') then raise exception 'Invalid meeting.' using errcode='22023'; end if;
  duration:=(p_input->>'duration')::numeric;
  if duration<5 or duration>480 or duration<>trunc(duration) then raise exception 'Invalid meeting duration.' using errcode='22023'; end if;
  if p_input->>'mode'='teams' then
    location:=btrim(p_input->>'location',E' \t\r\n');
    if location !~* '^https://(teams[.]microsoft[.]com|teams[.]live[.]com)(:[0-9]{1,5})?([/?#][^[:space:]]*)?$' then raise exception 'Invalid Teams URL.' using errcode='22023'; end if;
    port:=substring(location from '^https://[^/:?#]+:([0-9]+)');
    if port is not null and port::integer>65535 then raise exception 'Invalid Teams URL.' using errcode='22023'; end if;
  end if;
  local_time:=private.performance_review_date(p_input->>'date')+(p_input->>'time')::time;
  initial:=local_time at time zone 'Australia/Melbourne';
  select count(*),min(candidate) into matches,meeting_start from (
    select distinct (local_time-((initial+d*interval '1 day') at time zone 'Australia/Melbourne'-(initial+d*interval '1 day') at time zone 'UTC')) at time zone 'UTC' as candidate from generate_series(-2,2) d
  ) candidates where candidate at time zone 'Australia/Melbourne'=local_time;
  if matches<>1 then raise exception 'Invalid or ambiguous Melbourne meeting time.' using errcode='22023'; end if;
  return meeting_start+duration::integer*interval '1 minute';
end $$;
create function private.performance_review_document(p_review private.performance_reviews,p_audience text)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare result jsonb;
begin
  result:=jsonb_build_object('audience',p_audience,'code','PR-'||p_review.cycle||'-'||p_review.review_no,'cycle',p_review.cycle,'employee',p_review.employee_identity,'manager',p_review.manager_identity,'selfAnswers',p_review.self_answers);
  if p_audience='employee' then return result; end if;
  if p_review.final_document is not null then return p_review.final_document||jsonb_build_object('audience',p_audience); end if;
  return result||jsonb_build_object('managerAnswers',p_review.manager_answers,'ratings',p_review.ratings,'summary',p_review.summary,'overallRating',p_review.overall_rating,'meeting',p_review.meeting);
end $$;
revoke all on function private.performance_review_meeting_end(jsonb,boolean),private.performance_review_document(private.performance_reviews,text) from public,anon,authenticated,service_role;
create function private.performance_review_meeting_ended(p_end timestamptz,p_now timestamptz)
returns boolean language sql immutable set search_path='' as $$ select coalesce(p_end<=p_now,false); $$;
revoke all on function private.performance_review_meeting_ended(timestamptz,timestamptz) from public,anon,authenticated,service_role;
create function public.mutate_performance_review(p_operation_id uuid,p_review_id uuid,p_expected_revision text,p_command text,p_input jsonb)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare actor record; review private.performance_reviews%rowtype; operation private.performance_review_operations%rowtype; body jsonb; receipt jsonb; audience text; meeting_end timestamptz;
begin
  select * into actor from private.performance_review_actor();
  if actor.role in ('admin','system_admin') or not private.lock_portal_role_actor() then raise exception 'Performance review access denied.' using errcode='42501'; end if;
  if p_operation_id is null or p_review_id is null then raise exception 'Invalid review input.' using errcode='22023'; end if;
  select * into review from private.performance_reviews r where r.id=p_review_id;
  if not found then raise exception 'Performance review access denied.' using errcode='42501'; end if;
  perform private.performance_review_lock_people(array[review.employee_person_id,review.assigned_manager_person_id]);
  select * into review from private.performance_reviews r where r.id=p_review_id for update;
  select * into actor from private.performance_review_actor();
  audience:=private.performance_review_audience(review);
  if p_command is null or p_command not in ('save_self','submit_self','save_manager','complete_manager','save_meeting','submit_review') then raise exception 'Invalid review command.' using errcode='22023'; end if;
  if (p_command in ('save_self','submit_self') and audience is distinct from 'employee') or (p_command in ('save_manager','complete_manager','save_meeting','submit_review') and audience is distinct from 'manager') then raise exception 'Performance review access denied.' using errcode='42501'; end if;
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
    if p_expected_revision is distinct from 'manager:'||review.self_version||':'||review.manager_version or review.finalised_at is not null or review.self_submitted_at is null then raise exception 'Review changed.' using errcode='PT409'; end if;
    if p_command in ('save_manager','complete_manager') then
      if not private.performance_review_manager_input(p_input,p_command='complete_manager') then raise exception 'Invalid manager assessment.' using errcode='22023'; end if;
      update private.performance_reviews set manager_answers=p_input->'answers',ratings=p_input->'ratings',summary=p_input->>'summary',overall_rating=p_input->>'overallRating',manager_note=p_input->>'managerNote',manager_completed_at=case when p_command='complete_manager' then clock_timestamp() else null end,manager_version=manager_version+1 where id=p_review_id returning * into review;
    else
      if review.manager_completed_at is null or not private.performance_review_manager_input(jsonb_build_object('answers',review.manager_answers,'ratings',review.ratings,'summary',review.summary,'overallRating',review.overall_rating,'managerNote',review.manager_note),true) then raise exception 'Complete manager assessment first.' using errcode='22023'; end if;
      meeting_end:=private.performance_review_meeting_end(p_input,p_command='submit_review');
      if p_command='submit_review' and not private.performance_review_meeting_ended(meeting_end,clock_timestamp()) then raise exception 'The meeting has not ended.' using errcode='22023'; end if;
      update private.performance_reviews set meeting=p_input-'held',meeting_held_at=case when p_command='submit_review' then clock_timestamp() else null end,finalised_at=case when p_command='submit_review' then clock_timestamp() else null end,manager_version=manager_version+1 where id=p_review_id returning * into review;
      if p_command='submit_review' then
        update private.performance_reviews set final_document=private.performance_review_document(review,'manager') where id=p_review_id returning * into review;
      end if;
    end if;
  end if;
  insert into private.performance_review_events(review_id,subject_person_id,actor_user_id,kind) values(review.id,review.employee_person_id,actor.actor_user_id,p_command);
  receipt:=jsonb_build_object('committed',true,'operationId',p_operation_id,'review',private.performance_review_project(review));
  insert into private.performance_review_operations(actor_user_id,operation_id,review_id,body,receipt) values(actor.actor_user_id,p_operation_id,review.id,body,receipt);
  return receipt;
end $$;
revoke all on function private.performance_review_closed(jsonb,text[]),private.performance_review_text(jsonb),private.performance_review_nonblank(jsonb),private.performance_review_answers(jsonb,boolean),public.mutate_performance_review(uuid,uuid,text,text,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.mutate_performance_review(uuid,uuid,text,text,jsonb) to authenticated;
create function public.get_performance_review_document(p_review_id uuid)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare review private.performance_reviews%rowtype; audience text;
begin
  perform private.performance_review_actor();
  select * into review from private.performance_reviews r where r.id=p_review_id;
  if not found then raise exception 'Performance review access denied.' using errcode='42501'; end if;
  audience:=private.performance_review_audience(review);
  if audience is null then raise exception 'Performance review access denied.' using errcode='42501'; end if;
  return private.performance_review_document(review,audience);
end $$;
revoke all on function public.get_performance_review_document(uuid) from public,anon,authenticated,service_role;
grant execute on function public.get_performance_review_document(uuid) to authenticated;
create function public.get_performance_review_operation(p_operation_id uuid,p_review_id uuid)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare actor record; operation private.performance_review_operations%rowtype; review private.performance_reviews%rowtype;
begin
  select * into actor from private.performance_review_actor();
  if p_operation_id is null then raise exception 'Invalid operation identity.' using errcode='22023'; end if;
  select * into operation from private.performance_review_operations o where o.actor_user_id=actor.actor_user_id and o.operation_id=p_operation_id;
  if not found then return jsonb_build_object('status','not_found','review',null); end if;
  if p_review_id is not null and operation.review_id<>p_review_id then raise exception 'Performance review access denied.' using errcode='42501'; end if;
  select * into review from private.performance_reviews r where r.id=operation.review_id;
  if not found then raise exception 'Performance review access denied.' using errcode='42501'; end if;
  return jsonb_build_object('status','committed','review',private.performance_review_project(review));
end $$;
revoke all on function public.get_performance_review_operation(uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function public.get_performance_review_operation(uuid,uuid) to authenticated;
commit;
