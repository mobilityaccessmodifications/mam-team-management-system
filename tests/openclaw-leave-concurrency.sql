-- Isolated fixture state used by two independent psql sessions. No live data.
create table public.fixture_openclaw_plan(packet jsonb,draft jsonb,snapshot jsonb,person uuid);
revoke all on public.fixture_openclaw_plan from public,anon,authenticated;
grant select on public.fixture_openclaw_plan to service_role;
do $$declare
 person uuid:='10000000-0000-4000-8000-000000000001';
 draft jsonb; snap jsonb; packet jsonb; draft_id uuid:=gen_random_uuid();
begin
 packet:=jsonb_build_object('version',1,'channel','whatsapp','account','test','sender','+61400000001','session','self','operation','prepare','payload','{}'::jsonb);
 draft:=jsonb_build_object('id',draft_id,'personId',person,'userId','20000000-0000-4000-8000-000000000001',
  'identity',jsonb_build_object('account','test','sender','+61400000001','session','self'),
  'fields',jsonb_build_object('leaveType','Annual leave','startDate','2031-10-13','endDate','2031-10-13','startTime',null,'endTime',null,'employeeNote','Synthetic concurrency'),
  'summary','Synthetic concurrency summary','digest',encode(sha256(convert_to('Synthetic concurrency summary','UTF8')),'hex'),
  'challenge',gen_random_uuid(),'expiresAt',floor(extract(epoch from clock_timestamp())*1000)+600000);
 snap:=public.openclaw_leave_snapshot(repeat('3',64),null);
 perform public.openclaw_leave_commit(repeat('3',64),repeat('4',64),snap->>'fingerprint',snap->>'draftFingerprint',packet,person,draft,
  jsonb_build_object('code','prepared','draftId',draft_id,'summary',draft->>'summary','digest',draft->>'digest'),false);
 snap:=public.openclaw_leave_snapshot(repeat('5',64),draft_id);
 packet:=jsonb_set(packet,'{operation}','"shown"');
 packet:=jsonb_set(packet,'{payload}',jsonb_build_object('draftId',draft_id,'digest',draft->>'digest','outboundMessageId','concurrent-out'));
 perform public.openclaw_leave_commit(repeat('5',64),repeat('6',64),snap->>'fingerprint',snap->>'draftFingerprint',packet,person,draft,'{"code":"shown"}',false);
 snap:=public.openclaw_leave_snapshot(repeat('7',64),draft_id);draft:=snap->'draft';
 packet:=jsonb_set(packet,'{operation}','"confirm"');
 packet:=jsonb_set(packet,'{payload}',jsonb_build_object('draftId',draft_id,'digest',draft->>'digest','replyToMessageId','concurrent-out','text','CONFIRM '||(draft->>'challenge')));
 insert into public.fixture_openclaw_plan values(packet,draft,snap,person);
end$$;
