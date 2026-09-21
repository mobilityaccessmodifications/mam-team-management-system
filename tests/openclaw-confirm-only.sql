\set ON_ERROR_STOP on
do $$begin
 assert current_database() ~ '^openclaw_leave_test(_[0-9]+)?$';
 assert has_function_privilege('service_role','public.openclaw_leave_v3_snapshot(text,uuid)','execute');
 assert has_function_privilege('service_role','public.openclaw_leave_v3_submit(text,text,text,jsonb,uuid,jsonb,text)','execute');
 assert not has_function_privilege('anon','public.openclaw_leave_v3_snapshot(text,uuid)','execute');
 assert not has_function_privilege('authenticated','public.openclaw_leave_v3_submit(text,text,text,jsonb,uuid,jsonb,text)','execute');
 assert not has_table_privilege('service_role','private.openclaw_leave_drafts','insert');
 assert (select count(*)=4 from public.leave_requests);
end$$;

create table public.fixture_openclaw_v3_plan(person uuid,draft jsonb,packet jsonb,snapshot jsonb,token_hash text);
grant select on public.fixture_openclaw_v3_plan to service_role;
do $$declare p uuid:='10000000-0000-4000-8000-000000000001'; d jsonb; pkt jsonb;
 t bigint:=floor(extract(epoch from clock_timestamp())*1000)::bigint;
begin
 d:=jsonb_build_object('id',gen_random_uuid(),'consentVersion',3,'personId',p,'userId','20000000-0000-4000-8000-000000000001',
 'identity',jsonb_build_object('account','synthetic','sender','+61400000001','session','v3-self'),
 'employmentType','full_time','fullName','Synthetic Employee','issuedAt',t,'expiresAt',t+600000,
 'summary','Synthetic v3 summary','digest',encode(sha256(convert_to('Synthetic v3 summary','UTF8')),'hex'),
 'fields',jsonb_build_object('leaveType','Annual leave','startDate','2028-03-06','endDate','2028-03-06','startTime',null,'endTime',null,'employeeNote','Synthetic only'));
 pkt:=jsonb_build_object('version',3,'account','synthetic','channel','whatsapp','sender','+61400000001','session','v3-self','eventId','v3-confirm','operation','confirm',
 'payload',jsonb_build_object('draftToken','synthetic-opaque-token','shownMessageId','synthetic-receipt','replyToMessageId',null,'text','Confirm'));
 insert into public.fixture_openclaw_v3_plan values(p,d,pkt,public.openclaw_leave_v3_snapshot(repeat('b3',32),(d->>'id')::uuid),encode(sha256(convert_to('synthetic-opaque-token','UTF8')),'hex'));
end$$;

-- Read-only snapshot must work in a READ ONLY transaction and leave no records.
begin read only;
set local role service_role;
select public.openclaw_leave_v3_snapshot(repeat('b3',32),null)->>'complete';
commit;

-- Every failed confirmation leaves ALL HR, nonce and receipt counts unchanged.
do $$declare x public.fixture_openclaw_v3_plan%rowtype; d jsonb; pkt jsonb;
 drafts bigint; receipts bigint; i integer;
begin
 select * into x from public.fixture_openclaw_v3_plan;
 select count(*) into drafts from private.openclaw_leave_drafts;
 select count(*) into receipts from private.openclaw_leave_receipts;
 for i in 1..6 loop
  d:=x.draft; pkt:=x.packet;
  if i=1 then d:=jsonb_set(d,'{expiresAt}',to_jsonb(1::bigint)); end if;
  if i=2 then d:=jsonb_set(d,'{fullName}','"Different"'); end if;
  if i=3 then d:=jsonb_set(d,'{employmentType}','"casual"'); end if;
  if i=4 then pkt:=jsonb_set(pkt,'{payload,replyToMessageId}','"other"'); end if;
  if i=5 then pkt:=jsonb_set(pkt,'{payload,text}','"yes"'); end if;
  if i=6 then d:=jsonb_set(d,'{fields,endDate}','"2028-03-01"'); end if;
  begin
   perform public.openclaw_leave_v3_submit(repeat('b3',32),repeat('f',64),x.snapshot->>'fingerprint',pkt,x.person,d,x.token_hash);
   raise exception 'Unexpected successful invalid confirmation case %',i using errcode='ZX001';
  exception when others then if sqlstate='ZX001' then raise; end if; end;
 end loop;
 assert (select count(*)=drafts from private.openclaw_leave_drafts);
 assert (select count(*)=receipts from private.openclaw_leave_receipts);
 assert (select count(*)=4 from public.leave_requests);
 -- Directory update AFTER snapshot invalidates even valid decrypted token.
 update public.internal_org_people set full_name='Changed during confirmation' where id=x.person;
 begin
  perform public.openclaw_leave_v3_submit(repeat('b3',32),repeat('f',64),x.snapshot->>'fingerprint',x.packet,x.person,x.draft,x.token_hash);
  raise exception 'Unexpected stale identity success' using errcode='ZX001';
 exception when serialization_failure then null; end;
 update public.internal_org_people set full_name='Synthetic Employee' where id=x.person;
end$$;

-- A late failure AFTER leave/outbox insertion must roll back all effects.
create function private.fixture_v3_receipt_failure() returns trigger language plpgsql as $$begin
 if new.key=repeat('b3',32) then raise exception 'synthetic late failure'; end if; return new; end$$;
create trigger fixture_v3_receipt_failure before insert on private.openclaw_leave_receipts for each row execute function private.fixture_v3_receipt_failure();
do $$declare x public.fixture_openclaw_v3_plan%rowtype;begin
 select * into x from public.fixture_openclaw_v3_plan;
 begin
  perform public.openclaw_leave_v3_submit(repeat('b3',32),repeat('f',64),x.snapshot->>'fingerprint',x.packet,x.person,x.draft,x.token_hash);
  raise exception 'Unexpected late failure success' using errcode='ZX001';
 exception when others then
  if sqlstate='ZX001' or sqlerrm<>'synthetic late failure' then raise; end if;
 end;
 assert (select count(*)=4 from public.leave_requests);
 assert (select count(*)=4 from private.leave_notification_outbox);
 assert not exists(select 1 from private.openclaw_leave_drafts where id=(x.draft->>'id')::uuid);
end$$;
drop trigger fixture_v3_receipt_failure on private.openclaw_leave_receipts;
drop function private.fixture_v3_receipt_failure();
