begin;
create function pg_temp.completion_assert(ok boolean,label text) returns void language plpgsql as $$ begin if ok is distinct from true then raise exception 'FAIL: %',label; end if; raise notice 'PASS: %',label; end $$;
create function pg_temp.completion_actor(i integer) returns void language plpgsql as $$ begin
 perform set_config('request.jwt.claim.sub','ca000000-0000-4000-8000-'||lpad(i::text,12,'0'),true);
 perform set_config('request.jwt.claims',jsonb_build_object('sub','ca000000-0000-4000-8000-'||lpad(i::text,12,'0'),'iat',extract(epoch from clock_timestamp())::bigint,'is_anonymous',false)::text,true);
end $$;
insert into auth.users(id,email,email_confirmed_at) select ('ca000000-0000-4000-8000-'||lpad(i::text,12,'0'))::uuid,'completion-effective-'||i||'@example.test',clock_timestamp() from generate_series(1,6) i;
insert into public.profiles(id,full_name,app_role,login_name,credentials_valid_after) select ('ca000000-0000-4000-8000-'||lpad(i::text,12,'0'))::uuid,'Synthetic completion actor '||i,case when i in (2,4) then 'manager' when i=5 then 'admin' when i=6 then 'account' else 'employee' end,'completion-effective-'||i,clock_timestamp()-interval '1 day' from generate_series(1,6) i;
insert into public.internal_org_people(id,full_name,company_key,position_title,auth_user_id) select ('cb000000-0000-4000-8000-'||lpad(i::text,12,'0'))::uuid,case when i=1 then repeat('🦽',101) else 'Synthetic completion person '||i end,case when i in (3,4) then 'equipsy' else 'mam' end,'Synthetic role',('ca000000-0000-4000-8000-'||lpad(i::text,12,'0'))::uuid from generate_series(1,6) i;
update public.internal_org_people set parent_id='cb000000-0000-4000-8000-000000000002' where id in ('cb000000-0000-4000-8000-000000000001','cb000000-0000-4000-8000-000000000006');
update public.internal_org_people set parent_id='cb000000-0000-4000-8000-000000000004' where id='cb000000-0000-4000-8000-000000000003';
select pg_temp.completion_assert((select char_length(full_name)=101 from public.internal_org_people where id='cb000000-0000-4000-8000-000000000001'),'real directory constraints accept 101 supplementary codepoints');
create temporary table completion_effective_documents(document jsonb);
grant insert on completion_effective_documents to authenticated;
set local role authenticated;
do $$ declare employee integer; manager integer; kind integer; review jsonb; rid uuid; value text; saved jsonb; note text:='PRIVATE-SYNTHETIC-NOTE'; meeting jsonb:='{"date":"2026-01-02","time":"10:00","duration":30,"mode":"in_person","location":"Synthetic room","notes":"Synthetic notes","held":true}'; begin
 for employee,manager in values(1,2),(3,4) loop
  for kind in 0..1 loop
   perform pg_temp.completion_actor(manager);
   review:=public.start_performance_review(gen_random_uuid(),('cb000000-0000-4000-8000-'||lpad(employee::text,12,'0'))::uuid,(2026+kind)::text,'2026-12-31')->'review';rid:=(review->>'id')::uuid;
   value:=case when kind=0 then repeat('R'||chr(10),3998)||'END' else repeat('x',8000) end;
   perform pg_temp.completion_actor(employee);
   perform public.mutate_performance_review(gen_random_uuid(),rid,'self:0','submit_self',jsonb_build_object('answers',array_fill(value,array[12])));
   perform pg_temp.completion_actor(manager);
   perform public.mutate_performance_review(gen_random_uuid(),rid,'manager:1:0','complete_manager',jsonb_build_object('answers',array_fill(value,array[12]),'ratings',array_fill('2 Meets expectations'::text,array[12]),'summary','Summary','overallRating','2 Meets expectations','managerNote',note));
   if kind=0 then
    begin perform public.mutate_performance_review(gen_random_uuid(),rid,'manager:1:1','submit_review',meeting);raise exception 'Overflow final was admitted';exception when invalid_parameter_value then null;end;
   else
    saved:=public.mutate_performance_review(gen_random_uuid(),rid,'manager:1:1','submit_review',meeting);
    perform pg_temp.completion_assert(saved->'review'->>'finalisedAt' is not null,'full replay positive final succeeds');
    insert into completion_effective_documents values(public.get_performance_review_document(rid));
   end if;
   perform pg_temp.completion_actor(employee);
   perform pg_temp.completion_assert(not(public.get_performance_review_document(rid) ? 'managerAnswers'),'full replay employee remains self-only');
   perform pg_temp.completion_actor(5);
   perform pg_temp.completion_assert(public.get_performance_review_document(rid)->>'audience'='admin','full replay HR read-only audience');
   begin perform public.mutate_performance_review(gen_random_uuid(),rid,'manager:1:1','submit_review',meeting);raise exception 'HR wrote final';exception when insufficient_privilege then null;end;
  end loop;
 end loop;
end $$;
reset role;
select pg_temp.completion_assert((select count(*)=2 from private.performance_review_mail_outbox),'full replay exactly two positive outboxes and zero overflow outboxes');
select pg_temp.completion_assert((select count(*)=2 from private.performance_reviews where finalised_at is null and meeting_held_at is null and manager_version=1),'full replay overflow drafts preserved');
select pg_temp.completion_assert(not exists(select 1 from private.performance_review_operations o join private.performance_reviews r on r.id=o.review_id where r.finalised_at is null and o.body->>'command'='submit_review'),'full replay overflow has zero committed final operations');
select jsonb_build_object('documents',(select jsonb_agg(document order by document->'employee'->>'company') from completion_effective_documents),'outboxes',(select count(*) from private.performance_review_mail_outbox),'classification','SQL_ONLY_FULL_197_ORDERED_REPLAY') as result;
rollback;
