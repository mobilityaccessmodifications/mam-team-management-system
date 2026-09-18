-- Check catalog grants AND real calls. BYPASSRLS is not EXECUTE permission.
do $$declare role_name text; signature text; relation text; privilege text;begin
 foreach role_name in array array['anon','authenticated','service_role'] loop
  foreach signature in array array[
   'private.openclaw_leave_people()',
   'private.openclaw_leave_snapshot(text,uuid)',
   'private.openclaw_leave_commit(text,text,text,text,jsonb,uuid,jsonb,jsonb,boolean)',
   'private.openclaw_submit_self(uuid,text,date,date,time,time,text)'
  ] loop
   assert not has_function_privilege(role_name,signature,'execute'), role_name||' can call '||signature;
  end loop;
  foreach signature in array array[
   'public.openclaw_leave_snapshot(text,uuid)',
   'public.prune_openclaw_leave_state()',
   'public.openclaw_leave_commit(text,text,text,text,jsonb,uuid,jsonb,jsonb,boolean)'
  ] loop
   assert has_function_privilege(role_name,signature,'execute')=(role_name='service_role');
   assert (select prosecdef and proconfig @> array['search_path=""'] from pg_proc where oid=signature::regprocedure);
   assert not exists(select 1 from pg_proc p cross join lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
    where p.oid=signature::regprocedure and a.grantee=0 and a.privilege_type='EXECUTE');
  end loop;
  foreach relation in array array['private.openclaw_leave_drafts','private.openclaw_leave_receipts','private.openclaw_leave_release_gate'] loop
   foreach privilege in array array['select','insert','update','delete','truncate'] loop
    assert not has_table_privilege(role_name,relation,privilege);
   end loop;
  end loop;
 end loop;
end$$;
-- Existing private-schema USAGE must not bypass function ACLs. Fixture only.
grant usage on schema private to anon,authenticated,service_role;
do $$declare role_name text; statement text; denied boolean;begin
 foreach role_name in array array['anon','authenticated','service_role'] loop
  execute format('set local role %I',role_name);
  foreach statement in array array[
   'select private.openclaw_leave_people()',
   'select private.openclaw_leave_snapshot(null,null)',
   'select private.openclaw_leave_commit(null,null,null,null,null,null,null,null,false)',
   'select private.openclaw_submit_self(null,null,null,null,null,null,null)',
   'select * from private.openclaw_leave_drafts',
   'select * from private.openclaw_leave_receipts',
   'update private.openclaw_leave_release_gate set enabled=true'
  ] || case when role_name<>'service_role' then array[
   'select public.openclaw_leave_snapshot(null,null)',
   'select public.prune_openclaw_leave_state()',
   'select public.openclaw_leave_commit(null,null,null,null,null,null,null,null,false)'
  ] else array[]::text[] end loop
   denied:=false;
   begin execute statement;exception when insufficient_privilege then denied:=true;end;
   assert denied,role_name||' unexpectedly allowed: '||statement;
  end loop;
  reset role;
 end loop;
end$$;
-- Public definer entry must still enforce the default-off DB release gate.
-- Facades also work without private-schema USAGE; this is fixture-only revocation.
revoke usage on schema private from service_role;
set role service_role;
do $$begin
 assert public.openclaw_leave_snapshot(repeat('0',64),null)->>'complete'='true';
 begin
  perform public.openclaw_leave_commit(null,null,null,null,null,null,null,null,false);
  raise exception 'Disabled bridge accepted commit';
 exception when insufficient_privilege then
  assert sqlerrm='Bridge not released','Wrapper did not reach the release gate';
 end;
end$$;
reset role;
-- Enable only this isolated synthetic fixture, never production.
update private.openclaw_leave_release_gate set enabled=true;
set role service_role;
do $$declare
 person uuid:='10000000-0000-4000-8000-000000000001'; actor uuid:='20000000-0000-4000-8000-000000000001';
 draft_id uuid:=gen_random_uuid(); challenge uuid:=gen_random_uuid(); snap jsonb; draft jsonb; packet jsonb; result jsonb; received jsonb;
begin
 packet:=jsonb_build_object('version',1,'channel','whatsapp','account','test','sender','+61400000001','session','self','operation','prepare','payload','{}'::jsonb);
 draft:=jsonb_build_object('id',draft_id,'personId',person,'userId',actor,'identity',jsonb_build_object('account','test','sender','+61400000001','session','self'),
 'fields',jsonb_build_object('leaveType','Annual leave','startDate','2030-10-14','endDate','2030-10-14','startTime',null,'endTime',null,'employeeNote','Synthetic'),
 'summary','Synthetic exact summary','digest',encode(sha256(convert_to('Synthetic exact summary','UTF8')),'hex'),'challenge',challenge,
 'expiresAt',floor(extract(epoch from clock_timestamp())*1000)+600000);
 result:=jsonb_build_object('code','prepared','draftId',draft_id,'summary',draft->>'summary','digest',draft->>'digest');
 snap:=public.openclaw_leave_snapshot(repeat('a',64),null);
 begin
  perform public.openclaw_leave_commit(repeat('a',64),repeat('b',64),repeat('0',64),snap->>'draftFingerprint',packet,person,draft,result,false);
  raise exception 'Stale source accepted';
 exception when serialization_failure then null;end;
 perform public.openclaw_leave_commit(repeat('a',64),repeat('b',64),snap->>'fingerprint',snap->>'draftFingerprint',packet,person,draft,result,false);
 snap:=public.openclaw_leave_snapshot(repeat('c',64),draft_id);
 packet:=jsonb_set(packet,'{operation}','"shown"');
 packet:=jsonb_set(packet,'{payload}',jsonb_build_object('draftId',draft_id,'digest',draft->>'digest','outboundMessageId','shown-1'));
 perform public.openclaw_leave_commit(repeat('c',64),repeat('d',64),snap->>'fingerprint',snap->>'draftFingerprint',packet,person,draft,'{"code":"shown"}',false);
 snap:=public.openclaw_leave_snapshot(repeat('e',64),draft_id);draft:=snap->'draft';
 packet:=jsonb_set(packet,'{operation}','"confirm"');
 packet:=jsonb_set(packet,'{payload}',jsonb_build_object('draftId',draft_id,'digest',draft->>'digest','replyToMessageId','shown-1','text','no'));
 begin
  perform public.openclaw_leave_commit(repeat('e',64),repeat('f',64),snap->>'fingerprint',snap->>'draftFingerprint',packet,person,draft,'{}',true);
  raise exception 'Missing confirmation accepted';
 exception when raise_exception then if sqlerrm <> 'Confirmation required' then raise;end if;end;
 perform pg_sleep(0.01);
 packet:=jsonb_set(packet,'{payload,text}',to_jsonb('CONFIRM '||challenge::text));
 result:=public.openclaw_leave_commit(repeat('e',64),repeat('f',64),snap->>'fingerprint',snap->>'draftFingerprint',packet,person,draft,'{}',true);
 assert result->>'status'='Pending';
 received:=public.openclaw_leave_commit(repeat('e',64),repeat('f',64),snap->>'fingerprint',snap->>'draftFingerprint',packet,person,draft,'{}',true);
 assert received=result,'Retry changed result';
 -- Fresh event with the PRE-submit snapshot models a second concurrent plan.
 received:=public.openclaw_leave_commit(repeat('1',64),repeat('2',64),snap->>'fingerprint',snap->>'draftFingerprint',packet,person,draft,'{}',true);
 assert received=result,'Fresh-event stale confirmation did not return committed result';
end$$;
reset role;
do $$begin
 assert (select count(*)=1 from public.leave_requests);
 assert (select count(*)=1 from private.leave_notification_outbox);
 assert (select count(*)=1 from private.leave_request_reviewer_assignments);
 assert (select count(*)=2 from public.leave_request_events);
 assert (select status='submitted' and submitted_by=user_id and employment_type_snapshot='full_time' and business_days=1 from public.leave_requests);
 assert (select count(*)=4 from private.openclaw_leave_receipts);
end$$;
