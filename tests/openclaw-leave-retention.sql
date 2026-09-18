-- Concurrent fresh events must have produced exactly one additional request.
do $$begin
 assert (select count(*)=2 from public.leave_requests),'Concurrent duplicate leave';
 assert (select count(*)=2 from private.leave_notification_outbox),'Duplicate outbox';
 assert (select count(distinct body->'result'->>'requestId')=1 from private.openclaw_leave_receipts where key in(repeat('7',64),repeat('8',64)));
end$$;

-- Expiry bars new submission, not retrieval of an already committed result.
update private.openclaw_leave_drafts set body=jsonb_set(body,'{expiresAt}','0')
 where id=(select (draft->>'id')::uuid from public.fixture_openclaw_plan);
set role service_role;
do $$declare plan public.fixture_openclaw_plan%rowtype; snap jsonb; result jsonb;begin
 select * into plan from public.fixture_openclaw_plan;
 snap:=public.openclaw_leave_snapshot(repeat('b',64),(plan.draft->>'id')::uuid);
 result:=public.openclaw_leave_commit(repeat('b',64),repeat('c',64),snap->>'fingerprint',snap->>'draftFingerprint',plan.packet,plan.person,snap->'draft','{}',false);
 assert result->>'requestId'=snap->'draft'->'result'->>'requestId';
end$$;
reset role;

-- Exercise the authoritative changes_requested status, then remove only the
-- synthetic plan state on rollback. The original request must stay untouched.
update public.leave_requests set status='changes_requested' where start_date='2031-10-13';
do $$declare
 plan public.fixture_openclaw_plan%rowtype; snap jsonb; draft_id uuid:=gen_random_uuid();
begin
 select * into plan from public.fixture_openclaw_plan;
 plan.draft:=jsonb_set(plan.draft,'{id}',to_jsonb(draft_id));
 plan.draft:=plan.draft-array['result'];
 insert into private.openclaw_leave_drafts values(draft_id,plan.draft,clock_timestamp());
 plan.packet:=jsonb_set(plan.packet,'{payload,draftId}',to_jsonb(draft_id));
 snap:=public.openclaw_leave_snapshot(repeat('9',64),draft_id);
 begin
  perform public.openclaw_leave_commit(repeat('9',64),repeat('0',64),snap->>'fingerprint',snap->>'draftFingerprint',plan.packet,plan.person,plan.draft,'{}',true);
  raise exception 'changes_requested overlap accepted';
 exception when exclusion_violation then null;end;
 assert not exists(select 1 from private.openclaw_leave_receipts where key=repeat('9',64));
end$$;

-- Mark ONLY task-owned protocol cache records old; HR records remain intact.
insert into private.openclaw_leave_drafts values('90000000-0000-4000-8000-000000000001','{"synthetic":true}',clock_timestamp()-interval '2 hours');
insert into private.openclaw_leave_receipts values(repeat('9',64),'{"synthetic":true}',clock_timestamp()-interval '2 hours');
set role service_role;
do $$declare result jsonb;begin
 result:=public.prune_openclaw_leave_state();
 assert result='{"drafts":1,"receipts":1,"remaining":false}'::jsonb;
end$$;
reset role;
do $$begin
 assert (select count(*)=2 from public.leave_requests);
 assert (select count(*)=4 from public.leave_request_events);
 assert exists(select 1 from private.openclaw_leave_receipts where key=repeat('7',64)),'Live retry receipt removed';
 assert exists(select 1 from private.openclaw_leave_drafts where id=(select (draft->>'id')::uuid from public.fixture_openclaw_plan));
end$$;
-- Once the replay/confirmation/rate windows have all elapsed, no personal
-- payload must remain in the protocol tables. Durable HR audit stays intact.
update private.openclaw_leave_drafts set created_at=clock_timestamp()-interval '2 hours';
update private.openclaw_leave_receipts set created_at=clock_timestamp()-interval '2 hours';
set role service_role;
select public.prune_openclaw_leave_state();
reset role;
do $$begin
 assert not exists(select 1 from private.openclaw_leave_drafts);
 assert not exists(select 1 from private.openclaw_leave_receipts);
 assert (select count(*)=2 from public.leave_requests);
 assert (select count(*)=4 from public.leave_request_events);
end$$;
-- Real SQL counterpart of the store's needs_input actor regression.
set role service_role;
do $$declare plan public.fixture_openclaw_plan%rowtype; snap jsonb; result jsonb;begin
 select * into plan from public.fixture_openclaw_plan;
 snap:=public.openclaw_leave_snapshot(repeat('d',64),null);
 plan.packet:=jsonb_set(plan.packet,'{operation}','"prepare"');
 plan.packet:=jsonb_set(plan.packet,'{payload}','{}');
 result:=public.openclaw_leave_commit(repeat('d',64),repeat('e',64),snap->>'fingerprint',snap->>'draftFingerprint',plan.packet,plan.person,null,'{"code":"needs_input","missing":["startDate"]}',false);
 assert result->>'code'='needs_input';
end$$;
reset role;
do $$begin assert (select count(*)=2 from public.leave_requests);end$$;
