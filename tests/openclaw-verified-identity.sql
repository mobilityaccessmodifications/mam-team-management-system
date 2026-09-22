\set ON_ERROR_STOP on
do $$begin assert current_database() ~ '^openclaw_leave_test_[0-9]+$','Synthetic database only';end$$;

-- No implicit trust upgrade from existing contact numbers, on ANY legacy path.
set role service_role;
do $$begin
  assert public.openclaw_whatsapp_allowlist_snapshot()->'phones'='[]'::jsonb;
  assert public.openclaw_whatsapp_allowlist_snapshot_v2()->'contacts'='[]'::jsonb;
  assert public.openclaw_self_profile_snapshot()->'rows'='[]'::jsonb;
  assert public.openclaw_leave_snapshot(null,null)->'rows'='[]'::jsonb;
  begin
    perform public.openclaw_leave_commit(null,null,null,null,null,null,null,null,false);
    raise exception 'Legacy commit bypass' using errcode='ZX001';
  exception when insufficient_privilege then
    assert sqlerrm='Legacy bridge retired; prepare a new v3 request';
  end;
end$$;
reset role;

-- Browser roles cannot read/write registry/audit; service bypassrls cannot either.
do $$declare r text; rel text; priv text;begin
  foreach r in array array['anon','authenticated','service_role'] loop
    foreach rel in array array['private.openclaw_phone_identities','private.openclaw_phone_identity_events'] loop
      assert (select relrowsecurity from pg_class where oid=rel::regclass);
      foreach priv in array array['select','insert','update','delete','truncate'] loop
        assert not has_table_privilege(r,rel,priv),r||' '||priv||' '||rel;
      end loop;
    end loop;
    assert not has_function_privilege(r,'private.openclaw_leave_people()','execute');
    assert has_function_privilege(r,'public.set_openclaw_phone_identity(uuid,uuid,text,text)','execute')=(r='authenticated');
    assert has_function_privilege(r,'public.get_openclaw_phone_identity(uuid)','execute')=(r='authenticated');
    execute format('set local role %I',r);
    begin
      execute 'update private.openclaw_phone_identities set phone_e164=''+61400000009''';
      raise exception 'Direct write bypass' using errcode='ZX001';
    exception when insufficient_privilege then null;end;
    reset role;
  end loop;
end$$;

-- Employee cannot manufacture authorization via user_metadata.
select set_config('request.jwt.claim.sub','20000000-0000-4000-8000-000000000001',false);
select set_config('request.jwt.claims','{"is_anonymous":false,"iat":1999999999,"user_metadata":{"org_role":"system_admin"}}',false);
set role authenticated;
do $$begin
  begin
    perform public.set_openclaw_phone_identity('10000000-0000-4000-8000-000000000001',null,'+61400000001','synthetic:employee');
    raise exception 'Employee enrolled identity' using errcode='ZX001';
  exception when insufficient_privilege then null;end;
  begin
    perform public.get_openclaw_phone_identity('10000000-0000-4000-8000-000000000002');
    raise exception 'Employee read coworker identity' using errcode='ZX001';
  exception when insufficient_privilege then null;end;
end$$;
reset role;

select set_config('request.jwt.claim.sub','20000000-0000-4000-8000-000000000099',false);
set role authenticated;
do $$declare p uuid:='10000000-0000-4000-8000-000000000001'; row jsonb; invalid text;begin
  assert public.get_openclaw_phone_identity(p) is null;
  foreach invalid in array array['0400000001','+61 400 000 001','0061400000001','+01400000001','+61400000001 x2','+123','+1234567890123456',E'+61400000001\n'] loop
    begin
      perform public.set_openclaw_phone_identity(p,null,invalid,'synthetic:format');
      raise exception 'Noncanonical number accepted' using errcode='ZX001';
    exception when invalid_parameter_value then null;end;
  end loop;
  begin
    perform public.set_openclaw_phone_identity(p,null,'+61400000001','');
    raise exception 'Missing evidence accepted' using errcode='ZX001';
  exception when invalid_parameter_value then null;end;
  row:=public.set_openclaw_phone_identity(p,null,'+61400000001','synthetic:independent-ownership-1');
  assert row->>'phone'='+61400000001';
  begin
    perform public.set_openclaw_phone_identity(p,null,'+61400000009','synthetic:stale-first-enrollment');
    raise exception 'Stale CAS accepted' using errcode='ZX001';
  exception when serialization_failure then null;end;
  begin
    perform public.set_openclaw_phone_identity('10000000-0000-4000-8000-000000000002',null,'+61400000001','synthetic:duplicate');
    raise exception 'Duplicate identity accepted' using errcode='ZX001';
  exception when unique_violation then null;end;
  perform public.set_openclaw_phone_identity('10000000-0000-4000-8000-000000000002',null,'+61400000002','synthetic:independent-ownership-2');
end$$;
reset role;

-- Actual production self-profile RPC: self contact edits cannot remove a
-- coworker, replace the caller's identity or authorize an arbitrary third phone.
create temporary table identity_before as select private.openclaw_leave_people() as rows;
select set_config('request.jwt.claim.sub','20000000-0000-4000-8000-000000000001',false);
set role authenticated;
select phone from public.update_my_employee_profile('+61400000002',null,null,1);
reset role;
do $$begin
  assert (select phone='+61400000002' from private.employee_directory_details where person_id='10000000-0000-4000-8000-000000000001');
  assert private.openclaw_leave_people()=(select rows from identity_before);
  assert public.openclaw_whatsapp_allowlist_snapshot()->'phones'='["+61400000001","+61400000002"]'::jsonb;
  assert public.openclaw_whatsapp_allowlist_snapshot_v2()->>'rowCount'='2';
  assert public.openclaw_self_profile_snapshot()->'rows'=(select rows from identity_before);
  assert public.openclaw_leave_snapshot(null,null)->'rows'=(select rows from identity_before);
end$$;
set role authenticated;
select phone from public.update_my_employee_profile('+61400000009',null,null,1);
reset role;
do $$begin assert private.openclaw_leave_people()=(select rows from identity_before);end$$;

-- All snapshots revalidate current company, archive, account state and user link.
do $$declare i integer; p uuid:='10000000-0000-4000-8000-000000000001';begin
  for i in 1..5 loop
    if i=1 then update public.internal_org_people set company_key='equipsy' where id=p;end if;
    if i=2 then update public.internal_org_people set is_active=false where id=p;end if;
    if i=3 then update public.profiles set account_status='disabled' where id='20000000-0000-4000-8000-000000000001';end if;
    if i=4 then update public.internal_org_people set auth_user_id=null where id=p;end if;
    if i=5 then update public.internal_org_people set node_kind='team' where id=p;end if;
    assert public.openclaw_whatsapp_allowlist_snapshot()->'phones'='["+61400000002"]'::jsonb;
    assert public.openclaw_whatsapp_allowlist_snapshot_v2()->>'rowCount'='1';
    assert jsonb_array_length(public.openclaw_self_profile_snapshot()->'rows')=1;
    assert jsonb_array_length(public.openclaw_leave_snapshot(null,null)->'rows')=1;
    update public.internal_org_people set company_key='mam',is_active=true,node_kind='person',auth_user_id='20000000-0000-4000-8000-000000000001' where id=p;
    update public.profiles set account_status='active' where id='20000000-0000-4000-8000-000000000001';
  end loop;
end$$;

select set_config('request.jwt.claim.sub','20000000-0000-4000-8000-000000000099',false);
set role authenticated;
do $$declare n integer; p uuid; row jsonb; old_revision uuid;begin
  for n in 3..5 loop
    p:=('10000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid;
    begin
      perform public.set_openclaw_phone_identity(p,null,'+61400000003','synthetic:ineligible');
      raise exception 'Ineligible enrollment accepted' using errcode='ZX001';
    exception when insufficient_privilege then null;end;
  end loop;
  p:='10000000-0000-4000-8000-000000000002';
  old_revision:=(public.get_openclaw_phone_identity(p)->>'revision')::uuid;
  row:=public.set_openclaw_phone_identity(p,old_revision,null,'synthetic:revoke');
  assert row->>'phone' is null and (row->>'revision')::uuid<>old_revision;
  begin
    perform public.set_openclaw_phone_identity(p,old_revision,'+61400000002','synthetic:stale-reenrollment');
    raise exception 'Stale revoke CAS accepted' using errcode='ZX001';
  exception when serialization_failure then null;end;
  -- Explicit revocation releases the number; reassignment is a new verified act.
  perform public.set_openclaw_phone_identity('10000000-0000-4000-8000-000000000001',
    (public.get_openclaw_phone_identity('10000000-0000-4000-8000-000000000001')->>'revision')::uuid,
    '+61400000002','synthetic:verified-reassignment');
  perform public.set_openclaw_phone_identity('10000000-0000-4000-8000-000000000001',
    (public.get_openclaw_phone_identity('10000000-0000-4000-8000-000000000001')->>'revision')::uuid,
    '+61400000001','synthetic:verified-restore');
end$$;
reset role;
do $$begin
  assert (select count(*)=5 from private.openclaw_phone_identity_events),'Failed operations wrote audit or successful operations omitted audit';
  assert not exists(select 1 from private.openclaw_phone_identity_events where actor_user_id<>'20000000-0000-4000-8000-000000000099');
end$$;

-- SystemAdmin role alone is insufficient for disabled or anonymous sessions.
begin;
update public.profiles set account_status='disabled' where id='20000000-0000-4000-8000-000000000099';
set local role authenticated;
do $$begin
  begin
    perform public.get_openclaw_phone_identity('10000000-0000-4000-8000-000000000001');
    raise exception 'Disabled admin accepted' using errcode='ZX001';
  exception when insufficient_privilege then null;end;
end$$;
rollback;
begin;
select set_config('request.jwt.claims','{"is_anonymous":true,"iat":1999999999}',true);
set local role authenticated;
do $$begin
  begin
    perform public.set_openclaw_phone_identity('10000000-0000-4000-8000-000000000001',
      null,'+61400000009','synthetic:anonymous-admin');
    raise exception 'Anonymous admin accepted' using errcode='ZX001';
  exception when insufficient_privilege then null;end;
end$$;
rollback;
begin;
-- Revocation must remain possible after a person leaves the eligible scope.
update public.internal_org_people set is_active=false,company_key='equipsy'
  where id='10000000-0000-4000-8000-000000000001';
set local role authenticated;
do $$declare p uuid:='10000000-0000-4000-8000-000000000001';begin
  assert public.set_openclaw_phone_identity(p,(public.get_openclaw_phone_identity(p)->>'revision')::uuid,
    null,'synthetic:revoke-archived')->>'phone' is null;
end$$;
rollback;

update private.openclaw_leave_release_gate set enabled=true;
create table public.fixture_openclaw_identity_plan(person uuid,draft jsonb,packet jsonb,snapshot jsonb,token_hash text);
grant select on public.fixture_openclaw_identity_plan to service_role;
do $$declare p uuid:='10000000-0000-4000-8000-000000000001'; d jsonb; pkt jsonb;
  t bigint:=floor(extract(epoch from clock_timestamp())*1000)::bigint;
begin
  d:=jsonb_build_object('id',gen_random_uuid(),'consentVersion',3,'personId',p,'userId','20000000-0000-4000-8000-000000000001',
    'phoneIdentityVersion',public.get_openclaw_phone_identity(p)->>'revision',
    'identity',jsonb_build_object('account','synthetic','sender','+61400000001','session','identity-test'),
    'employmentType','full_time','fullName','Synthetic Employee','issuedAt',t,'expiresAt',t+600000,
    'summary','Synthetic identity summary','digest',encode(sha256(convert_to('Synthetic identity summary','UTF8')),'hex'),
    'fields',jsonb_build_object('leaveType','Annual leave','startDate','2028-03-06','endDate','2028-03-06',
      'startTime',null,'endTime',null,'employeeNote','Synthetic only'));
  pkt:=jsonb_build_object('version',3,'account','synthetic','channel','whatsapp','sender','+61400000001',
    'session','identity-test','eventId','identity-confirm','operation','confirm',
    'payload',jsonb_build_object('draftToken','synthetic-opaque-token','shownMessageId','synthetic-receipt','replyToMessageId',null,'text','Confirm'));
  insert into public.fixture_openclaw_identity_plan values(p,d,pkt,public.openclaw_leave_v3_snapshot(repeat('b',64),(d->>'id')::uuid),
    encode(sha256(convert_to('synthetic-opaque-token','UTF8')),'hex'));
end$$;

set role service_role;
do $$declare x public.fixture_openclaw_identity_plan%rowtype; d jsonb; pkt jsonb; result jsonb;begin
  select * into x from public.fixture_openclaw_identity_plan;
  begin
    perform public.openclaw_leave_v3_submit(repeat('a',64),repeat('f',64),x.snapshot->>'fingerprint',x.packet,x.person,x.draft-'phoneIdentityVersion',x.token_hash);
    raise exception 'Unversioned legacy v3 token accepted' using errcode='ZX001';
  exception when serialization_failure then null;end;
  pkt:=jsonb_set(x.packet,'{sender}','"+61400000002"');
  d:=jsonb_set(x.draft,'{identity,sender}','"+61400000002"');
  begin
    perform public.openclaw_leave_v3_submit(repeat('a',64),repeat('f',64),x.snapshot->>'fingerprint',pkt,x.person,d,x.token_hash);
    raise exception 'SQL trusted service-selected person instead of sender' using errcode='ZX001';
  exception when serialization_failure then null;end;
  result:=public.openclaw_leave_v3_submit(repeat('b',64),repeat('f',64),x.snapshot->>'fingerprint',x.packet,x.person,x.draft,x.token_hash);
  assert result->>'status'='Pending';
  assert public.openclaw_leave_v3_submit(repeat('b',64),repeat('f',64),x.snapshot->>'fingerprint',x.packet,x.person,x.draft,x.token_hash)=result;
end$$;
reset role;

-- Revoke then re-enroll same phone. A fresh source fingerprint must not permit
-- old sealed drafts, existing receipts or submitted nonce results to revive.
do $$declare x public.fixture_openclaw_identity_plan%rowtype; fresh jsonb; rev uuid;begin
  select * into x from public.fixture_openclaw_identity_plan;
  rev:=(public.get_openclaw_phone_identity(x.person)->>'revision')::uuid;
  perform public.set_openclaw_phone_identity(x.person,rev,null,'synthetic:revoke-confirmed');
  fresh:=public.openclaw_leave_v3_snapshot(repeat('b',64),(x.draft->>'id')::uuid);
  assert fresh->'rows'='[]'::jsonb;
  begin
    perform public.openclaw_leave_v3_submit(repeat('b',64),repeat('f',64),fresh->>'fingerprint',x.packet,x.person,x.draft,x.token_hash);
    raise exception 'Revoked receipt replay accepted' using errcode='ZX001';
  exception when insufficient_privilege then null;end;
  perform public.set_openclaw_phone_identity(x.person,(public.get_openclaw_phone_identity(x.person)->>'revision')::uuid,
    '+61400000001','synthetic:independent-reenrollment');
  fresh:=public.openclaw_leave_v3_snapshot(repeat('b',64),(x.draft->>'id')::uuid);
  assert fresh->>'fingerprint'<>x.snapshot->>'fingerprint';
  begin
    perform public.openclaw_leave_v3_submit(repeat('b',64),repeat('f',64),x.snapshot->>'fingerprint',x.packet,x.person,x.draft,x.token_hash);
    raise exception 'Stale source accepted' using errcode='ZX001';
  exception when serialization_failure then null;end;
  begin
    perform public.openclaw_leave_v3_submit(repeat('b',64),repeat('f',64),fresh->>'fingerprint',x.packet,x.person,x.draft,x.token_hash);
    raise exception 'Old receipt revived' using errcode='ZX001';
  exception when serialization_failure then null;end;
  begin
    perform public.openclaw_leave_v3_submit(repeat('c',64),repeat('f',64),fresh->>'fingerprint',x.packet,x.person,x.draft,x.token_hash);
    raise exception 'Old nonce revived' using errcode='ZX001';
  exception when serialization_failure then null;end;
  -- New unsubmitted plan for the two-connection race in the runner.
  update public.fixture_openclaw_identity_plan set snapshot=fresh,
    draft=jsonb_set(jsonb_set(x.draft,'{id}',to_jsonb(gen_random_uuid())),
      '{phoneIdentityVersion}',to_jsonb(public.get_openclaw_phone_identity(x.person)->>'revision'));
  assert (select count(*)=1 from public.leave_requests);
  assert (select count(*)=1 from private.leave_notification_outbox);
  assert (select count(*)=1 from private.openclaw_leave_receipts);
end$$;
