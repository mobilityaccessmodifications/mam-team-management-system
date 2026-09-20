-- Run after the legacy/retention suite, in the disposable synthetic database.
create table public.fixture_openclaw_v2_plan(packet jsonb,draft jsonb,snapshot jsonb,person uuid);
revoke all on public.fixture_openclaw_v2_plan from public,anon,authenticated;
grant select on public.fixture_openclaw_v2_plan to service_role;

-- Names are part of the authoritative snapshot fingerprint, not a second read.
do $$declare before_name jsonb; after_name jsonb;begin
 before_name:=public.openclaw_leave_snapshot(repeat('0',64),null);
 assert before_name#>>'{rows,0,fullName}'='Synthetic Employee';
 update public.internal_org_people set full_name='Synthetic Changed Name'
  where id='10000000-0000-4000-8000-000000000001';
 after_name:=public.openclaw_leave_snapshot(repeat('0',64),null);
 assert before_name->>'fingerprint'<>after_name->>'fingerprint';
 update public.internal_org_people set full_name='Synthetic Employee'
  where id='10000000-0000-4000-8000-000000000001';
end$$;

do $$declare
 person uuid:='10000000-0000-4000-8000-000000000001';
 actor uuid:='20000000-0000-4000-8000-000000000001';
 draft_id uuid; snap jsonb; draft jsonb; packet jsonb; result jsonb;
 invalid jsonb; attempt integer; iteration integer; day date;
 key text; prepare_key text; shown_id text;
begin
 for iteration in 1..3 loop
  set local role service_role;
  day:=date '2033-10-10'+((iteration-1)*7);
  draft_id:=gen_random_uuid();shown_id:='v2-shown-'||iteration;
  packet:=jsonb_build_object('version',2,'channel','whatsapp','account','test',
   'sender','+61400000001','session','self','operation','prepare','payload','{}'::jsonb);
  draft:=jsonb_build_object('id',draft_id,'personId',person,'userId',actor,
   'identity',jsonb_build_object('account','test','sender','+61400000001','session','self'),
   'consentVersion',2,'employmentType','full_time',
   'fields',jsonb_build_object('leaveType','Annual leave','startDate',day,'endDate',day,
    'startTime',null,'endTime',null,'employeeNote','Synthetic v2'),
   'summary','Synthetic Employee quoted-Confirm summary '||iteration,
   'digest',encode(sha256(convert_to('Synthetic Employee quoted-Confirm summary '||iteration,'UTF8')),'hex'),
   'challenge',gen_random_uuid(),'expiresAt',floor(extract(epoch from clock_timestamp())*1000)+600000);
  result:=jsonb_build_object('code','prepared','consentVersion',2,'draftId',draft_id,'summary',draft->>'summary','digest',draft->>'digest');
  prepare_key:=encode(sha256(convert_to('v2-prepare-'||iteration,'UTF8')),'hex');
  snap:=public.openclaw_leave_snapshot(prepare_key,null);
  perform public.openclaw_leave_commit(prepare_key,repeat('f',64),snap->>'fingerprint',snap->>'draftFingerprint',packet,person,draft,result,false);
  key:=encode(sha256(convert_to('v2-shown-'||iteration,'UTF8')),'hex');
  snap:=public.openclaw_leave_snapshot(key,draft_id);
  packet:=jsonb_set(packet,'{operation}','"shown"');
  packet:=jsonb_set(packet,'{payload}',jsonb_build_object('draftId',draft_id,'digest',draft->>'digest','outboundMessageId',shown_id));
  perform public.openclaw_leave_commit(key,repeat('f',64),snap->>'fingerprint',snap->>'draftFingerprint',packet,person,draft,'{"code":"shown"}',false);
  key:=encode(sha256(convert_to('v2-confirm-'||iteration,'UTF8')),'hex');
  snap:=public.openclaw_leave_snapshot(key,draft_id);draft:=snap->'draft';
  packet:=jsonb_set(packet,'{operation}','"confirm"');
  packet:=jsonb_set(packet,'{payload}',jsonb_build_object('draftId',draft_id,'digest',draft->>'digest','replyToMessageId',shown_id,'text',E' \tCoNfIrM\r\n'));
  perform pg_sleep(0.01);
  -- Missing/wrong quote, vague consent, legacy token and protocol downgrade.
  for attempt in 1..5 loop
   invalid:=case attempt
    when 1 then packet #- '{payload,replyToMessageId}'
    when 2 then jsonb_set(packet,'{payload,replyToMessageId}','"another-summary"')
    when 3 then jsonb_set(packet,'{payload,text}','"yes"')
    when 4 then jsonb_set(packet,'{payload,text}',to_jsonb('CONFIRM '||(draft->>'challenge')))
    else jsonb_set(packet,'{version}','1') end;
   begin
    perform public.openclaw_leave_commit(key,repeat('f',64),snap->>'fingerprint',snap->>'draftFingerprint',invalid,person,draft,'{}',true);
    raise exception 'Invalid v2 consent accepted';
   exception when serialization_failure then assert attempt=5;
    when raise_exception then assert sqlerrm='Confirmation required';end;
  end loop;
  if iteration=1 then
   -- Arrival order must never mutate another exact-quote-bound draft.
   invalid:=jsonb_set(jsonb_set(packet,'{operation}','"prepare"'),'{payload}','{}');
   perform public.openclaw_leave_commit(repeat('c',64),repeat('f',64),snap->>'fingerprint',snap->>'draftFingerprint',invalid,person,null,'{"code":"needs_input","missing":["startDate"]}',false);
   assert public.openclaw_leave_snapshot(key,draft_id)->'draft'=draft;
  elsif iteration=2 then
   result:=public.openclaw_leave_commit(key,repeat('f',64),snap->>'fingerprint',snap->>'draftFingerprint',packet,person,draft,'{}',true);
   assert result->>'status'='Pending';
   assert public.openclaw_leave_commit(key,repeat('f',64),snap->>'fingerprint',snap->>'draftFingerprint',packet,person,draft,'{}',true)=result;
   assert public.openclaw_leave_commit(repeat('b',64),repeat('f',64),snap->>'fingerprint',snap->>'draftFingerprint',packet,person,draft,'{}',true)=result;
  else
   reset role;
   insert into public.fixture_openclaw_v2_plan values(packet,draft,snap,person);
  end if;
  reset role;
 end loop;
 assert (select count(*)=3 from public.leave_requests);
 assert (select count(*)=3 from private.leave_notification_outbox);
end$$;
