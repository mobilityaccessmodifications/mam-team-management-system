begin;
create function pg_temp.performance_admin_assert(ok boolean,label text) returns void language plpgsql as $$
begin
  if ok is distinct from true then raise exception 'FAIL: %',label; end if;
  raise notice 'PASS: %',label;
end $$;
create function pg_temp.performance_admin_actor(i integer) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub','ad100000-0000-4000-8000-'||lpad(i::text,12,'0'),true);
  perform set_config('request.jwt.claims',jsonb_build_object('sub','ad100000-0000-4000-8000-'||lpad(i::text,12,'0'),
    'iat',extract(epoch from clock_timestamp())::bigint,'is_anonymous',false)::text,true);
end $$;
insert into auth.users(id,email,email_confirmed_at)
select ('ad100000-0000-4000-8000-'||lpad(i::text,12,'0'))::uuid,'performance-admin-effective-'||i||'@example.test',clock_timestamp()
from generate_series(1,6) i;
insert into public.profiles(id,full_name,app_role,login_name,credentials_valid_after)
select ('ad100000-0000-4000-8000-'||lpad(i::text,12,'0'))::uuid,'Synthetic Admin review actor '||i,
  case when i in(1,5) then 'manager' when i=3 then 'admin' when i=4 then 'system_admin' else 'employee' end,
  'performance-admin-effective-'||i,clock_timestamp()-interval '1 day'
from generate_series(1,6) i;
insert into public.internal_org_people(id,full_name,company_key,position_title,auth_user_id)
select ('bd100000-0000-4000-8000-'||lpad(i::text,12,'0'))::uuid,'Synthetic Admin review person '||i,
  case when i in(5,6) then 'equipsy' else 'mam' end,'Synthetic role',('ad100000-0000-4000-8000-'||lpad(i::text,12,'0'))::uuid
from generate_series(1,6) i where i<>4;
insert into private.employee_directory_details(person_id,first_name,work_email)
select ('bd100000-0000-4000-8000-'||lpad(i::text,12,'0'))::uuid,'Synthetic','performance-admin-effective-'||i||'@mobilityaccess.com.au'
from generate_series(1,6) i where i<>4
on conflict(person_id) do update set work_email=excluded.work_email;
update public.internal_org_people set parent_id='bd100000-0000-4000-8000-000000000001' where id='bd100000-0000-4000-8000-000000000002';
update public.internal_org_people set parent_id='bd100000-0000-4000-8000-000000000005' where id='bd100000-0000-4000-8000-000000000006';
create temporary table performance_admin_effective_reviews(kind text,id uuid);
grant insert,select on performance_admin_effective_reviews to authenticated;
set local role authenticated;
do $$
declare workspace jsonb; row jsonb; rid uuid; result jsonb;
  answers jsonb:=jsonb_build_object('answers',array_fill('Synthetic self assessment'::text,array[12]));
  assessment jsonb:=jsonb_build_object('answers',array_fill('Synthetic manager assessment'::text,array[12]),
    'ratings',array_fill('2 Meets expectations'::text,array[12]),'summary','Synthetic summary',
    'overallRating','2 Meets expectations','managerNote','PRIVATE-SYNTHETIC-NOTE');
  meeting jsonb:='{"date":"2026-01-02","time":"10:00","duration":30,"mode":"in_person","location":"Synthetic room","notes":"Synthetic notes","held":true}';
begin
  perform pg_temp.performance_admin_actor(4);
  workspace:=public.performance_review_workspace();
  perform pg_temp.performance_admin_assert(workspace->'viewerContext'->>'personId' is null,'effective standalone P0 has no synthetic employee');
  perform pg_temp.performance_admin_assert(exists(select 1 from jsonb_array_elements(workspace->'startablePeople') p
    where p->>'id'='bd100000-0000-4000-8000-000000000001'),'effective P0 sees manager target');
  perform pg_temp.performance_admin_assert(exists(select 1 from jsonb_array_elements(workspace->'startablePeople') p
    where p->>'id'='bd100000-0000-4000-8000-000000000003'),'effective P0 sees linked Admin target');
  row:=public.start_performance_review(gen_random_uuid(),'bd100000-0000-4000-8000-000000000001','2038','2038-12-31')->'review';
  rid:=(row->>'id')::uuid;
  perform pg_temp.performance_admin_assert(row->>'audience'='admin' and row->'manager'->>'id'='ad100000-0000-4000-8000-000000000004',
    'effective P0 start snapshots explicit administrator reviewer');
  insert into performance_admin_effective_reviews values('p0-manager',rid);
  perform pg_temp.performance_admin_actor(1);
  select r into row from jsonb_array_elements(public.performance_review_workspace()->'reviews') r where r->>'id'=rid::text;
  perform pg_temp.performance_admin_assert(row->>'audience'='employee' and not(row ? 'managerNote') and (row->'capabilities'->>'submitSelf')::boolean,
    'effective manager subject receives private self-only assessment');
  perform public.mutate_performance_review(gen_random_uuid(),rid,'self:0','submit_self',answers);
  perform pg_temp.performance_admin_actor(3);
  select r into row from jsonb_array_elements(public.performance_review_workspace()->'reviews') r where r->>'id'=rid::text;
  perform pg_temp.performance_admin_assert(row->>'readRevision'='read:1:0' and (row->'capabilities'->>'completeManager')::boolean,
    'effective Admin receives active manager-side capabilities with read revision');
  perform public.mutate_performance_review(gen_random_uuid(),rid,'read:1:0','complete_manager',assessment);
  result:=public.mutate_performance_review(gen_random_uuid(),rid,'read:1:1','submit_review',meeting);
  perform pg_temp.performance_admin_assert(result->'review'->>'finalisedAt' is not null,'effective Admin completes P0-started manager review');
  perform pg_temp.performance_admin_actor(4);
  row:=public.start_performance_review(gen_random_uuid(),'bd100000-0000-4000-8000-000000000003','2038','2038-12-31')->'review';
  rid:=(row->>'id')::uuid;
  insert into performance_admin_effective_reviews values('admin-self',rid);
  perform pg_temp.performance_admin_actor(3);
  result:=public.mutate_performance_review(gen_random_uuid(),rid,'self:0','submit_self',answers);
  perform pg_temp.performance_admin_assert(result->'review'->>'audience'='employee' and not(result->'review' ? 'managerAnswers'),
    'effective linked Admin retains their own private self assessment');
  begin
    perform public.mutate_performance_review(gen_random_uuid(),rid,'read:1:0','save_manager',assessment);
    raise exception 'Admin assessed own review';
  exception when insufficient_privilege then null; end;
  perform pg_temp.performance_admin_actor(4);
  workspace:=public.performance_review_workspace_for_preview('bd100000-0000-4000-8000-000000000003');
  perform pg_temp.performance_admin_assert(exists(select 1 from jsonb_array_elements(workspace->'startablePeople') p
    where p->>'id'='bd100000-0000-4000-8000-000000000005'),'effective Admin preview sees foreign-company manager');
  perform pg_temp.performance_admin_assert(not exists(select 1 from jsonb_array_elements(workspace->'reviews') r
    where (r->'capabilities'->>'saveManager')::boolean or (r->'capabilities'->>'saveSelf')::boolean),'effective Admin preview stays readonly');
  perform pg_temp.performance_admin_actor(1);
  row:=public.start_performance_review(gen_random_uuid(),'bd100000-0000-4000-8000-000000000002','2038','2038-12-31')->'review';
  perform pg_temp.performance_admin_assert(row->'manager'->>'id'='bd100000-0000-4000-8000-000000000001',
    'effective ordinary manager keeps reviewer-person identity');
  begin
    perform public.start_performance_review(gen_random_uuid(),'bd100000-0000-4000-8000-000000000006','2038','2038-12-31');
    raise exception 'Manager started foreign review';
  exception when insufficient_privilege then null; end;
end $$;
reset role;
select pg_temp.performance_admin_assert((select r.assigned_manager_person_id is null and r.assigned_admin_user_id='ad100000-0000-4000-8000-000000000004'
  from private.performance_reviews r join performance_admin_effective_reviews v using(id) where v.kind='p0-manager'),
  'effective reviewer XOR stores standalone P0 user without fake person');
select pg_temp.performance_admin_assert((select count(*)=1 from private.performance_review_mail_outbox o
  join performance_admin_effective_reviews v on v.id=o.review_id where v.kind='p0-manager'),'effective Admin final creates one Careers outbox');
select pg_temp.performance_admin_assert((select actor_user_id='ad100000-0000-4000-8000-000000000003' from private.performance_review_events e
  join performance_admin_effective_reviews v on v.id=e.review_id where v.kind='p0-manager' and e.kind='submit_review'),
  'effective final audit preserves actual linked Admin operator');
select pg_temp.performance_admin_assert((select private.performance_review_notification_payload(r,'self-submitted')->>'recipient'='careers@mobilityaccess.com.au'
  from private.performance_reviews r join performance_admin_effective_reviews v using(id) where v.kind='admin-self'),
  'effective standalone P0 self-submission notification uses approved Careers mailbox');
select pg_temp.performance_admin_assert(not has_function_privilege('authenticated','private.performance_review_admin_candidate(uuid,uuid)','EXECUTE')
  and not has_table_privilege('authenticated','private.performance_reviews','SELECT'),'effective Admin feature does not expose private SQL objects');
rollback;
