\set ON_ERROR_STOP on
begin;
\ir unified-role-fixture.sql
update private.subscription_request_config set enabled=true,approver_user_id='a1000000-0000-4000-8000-000000000004',approver_person_id='a1000000-0000-4000-8000-000000000004';
select pg_temp.set_test_actor('a1000000-0000-4000-8000-000000000009');
set local role authenticated;
select public.replace_subscription_management_delegates(array['a1000000-0000-4000-8000-000000000001']::uuid[]);
select public.replace_subscription_credential_access_grants(array['a1000000-0000-4000-8000-000000000008']::uuid[]);
reset role;
select pg_temp.set_test_actor('a1000000-0000-4000-8000-000000000001');
set local role authenticated;
select public.sr_mutate('b1000000-0000-4000-8000-000000000004',0,'save','{}');
reset role;
select pg_temp.set_test_actor('a1000000-0000-4000-8000-000000000008');
set local role authenticated;
do $$ begin
  assert not (public.sr_workspace()->>'canApply')::boolean;
  assert jsonb_array_length(public.sr_workspace()->'requests')=0, 'Vault-only access cannot read a request draft';
  begin perform public.sr_mutate('b1000000-0000-4000-8000-000000000005',0,'save','{}'); raise exception 'Vault-only grant applied'; exception when insufficient_privilege then null; end;
  begin perform public.sr_download('b1000000-0000-4000-8000-000000000004',1,0); raise exception 'Unrelated actor read evidence'; exception when insufficient_privilege then null; end;
end $$;
reset role;
select pg_temp.set_test_actor('a1000000-0000-4000-8000-000000000013');
set local role authenticated;
do $$ begin
  assert jsonb_array_length(public.sr_workspace()->'requests')=0, 'Ordinary Admin cannot view another applicant draft';
  begin perform public.sr_mutate('b1000000-0000-4000-8000-000000000004',1,'approve'); raise exception 'Admin acquired approval rights'; exception when insufficient_privilege then null; end;
  begin perform public.sr_mutate('b1000000-0000-4000-8000-000000000004',1,'save','{}'); raise exception 'Admin edited another draft'; exception when insufficient_privilege then null; end;
  begin perform public.create_subscription_v4('Synthetic forbidden paid',null,'paid','annual',1000,null,1,false,null,current_date,'a1000000-0000-4000-8000-000000000013','mam','{}'::uuid[]); raise exception 'Legacy paid-create bypass'; exception when object_not_in_prerequisite_state then null; end;
end $$;
reset role;
do $$ declare role_name text; signature text; begin
  foreach role_name in array array['anon','authenticated','service_role'] loop
    assert not has_table_privilege(role_name,'private.subscription_requests','SELECT');
    assert not has_table_privilege(role_name,'private.subscription_request_events','UPDATE');
    assert not has_table_privilege(role_name,'private.subscription_request_config','UPDATE');
    assert not has_table_privilege(role_name,'private.subscription_request_notifications','SELECT');
    foreach signature in array array['public.sr_workspace()','public.sr_mutate(uuid,bigint,text,jsonb,text,jsonb)','public.sr_download(uuid,bigint,integer)'] loop
      assert has_function_privilege(role_name,signature,'EXECUTE')=(role_name='authenticated');
    end loop;
  end loop;
  begin update private.subscription_request_events set reason='Tamper'; raise exception 'History overwritten'; exception when object_not_in_prerequisite_state then null; end;
  begin delete from private.subscription_request_events; raise exception 'History deleted'; exception when object_not_in_prerequisite_state then null; end;
  assert private.confirmed_test_purge_schema_hash()=(select schema_hash from private.confirmed_test_purge_schema where singleton), 'Catalog protection remains exact';
end $$;
rollback;
\echo PASS: independent grants, draft privacy, sole approval, legacy paid gate, RLS/ACLs and immutable history
begin;
\ir unified-role-fixture.sql
select pg_temp.set_test_actor('a1000000-0000-4000-8000-000000000004');
set local role authenticated;
do $$ begin
  begin perform public.sr_mutate('b1000000-0000-4000-8000-000000000005',0,'save','{}'); raise exception 'Disabled feature wrote'; exception when object_not_in_prerequisite_state then null; end;
end $$;
reset role;
update private.subscription_request_config set enabled=true;
set local role authenticated;
do $$ begin
  begin perform public.sr_mutate('b1000000-0000-4000-8000-000000000005',0,'submit','{"kind":"new_purchase","service":"Work","purpose":"Work","company":"mam","payer":"MAM","duration":"Year","billing":"annual","currency":"AUD","tax":"Inclusive","quoteCents":1,"audEstimateCents":1,"payment":"non_card","intendedUsers":"Team"}'); raise exception 'Missing approver submitted'; exception when object_not_in_prerequisite_state then null; end;
  assert jsonb_array_length(public.sr_workspace()->'requests')=0, 'Failed submit cannot leave a row or event';
end $$;
rollback;
\echo PASS: missing identity configuration fails closed and submission is atomic

begin;
\ir unified-role-fixture.sql
select pg_temp.set_test_actor('a1000000-0000-4000-8000-000000000013');
set local role authenticated;
select set_config('mam.sr_gate_record',public.create_subscription_v4(
  'Synthetic existing paid service','Existing plan','paid','annual',12000,null,1,false,null,
  date '2026-01-01','a1000000-0000-4000-8000-000000000013','mam','{}'::uuid[])::text,true);
reset role;
select set_config('mam.sr_gate_audits',(select count(*)::text from private.subscription_audit_events
  where subscription_id=(current_setting('mam.sr_gate_record')::jsonb->>'subscription_id')::uuid),true);
update private.subscription_request_config set enabled=true;
set local role authenticated;
do $$ declare r jsonb:=current_setting('mam.sr_gate_record')::jsonb; id uuid:=(r->>'subscription_id')::uuid; version bigint:=(r->>'version')::bigint; begin
  begin
    perform public.update_subscription_v4(id,version,'Replacement paid service','Existing plan','active','paid','annual',12000,null,1,false,null,
      date '2026-01-01','a1000000-0000-4000-8000-000000000013','mam','{}'::uuid[]);
    raise exception 'Legacy service-identity update bypassed the request boundary';
  exception when object_not_in_prerequisite_state then null; end;
  begin
    perform public.update_subscription_v4(id,version,'Synthetic existing paid service','Existing plan','active','paid','annual',12000,null,1,false,null,
      date '2026-02-01','a1000000-0000-4000-8000-000000000013','mam','{}'::uuid[]);
    raise exception 'Legacy billing-anchor update bypassed the request boundary';
  exception when object_not_in_prerequisite_state then null; end;
  begin
    perform public.update_subscription_v2(id,version,'Replacement paid service','Existing plan','active','paid','annual',12000,null,1,false,
      date '2026-01-01','a1000000-0000-4000-8000-000000000013','{}'::uuid[]);
    raise exception 'Old service-identity RPC bypassed the request boundary';
  exception when object_not_in_prerequisite_state then null; end;
end $$;
reset role;
do $$ declare saved jsonb:=current_setting('mam.sr_gate_record')::jsonb; legacy_id uuid:=(saved->>'subscription_id')::uuid; begin
  assert (select service_name='Synthetic existing paid service' and billing_anchor_date=date '2026-01-01' and version=(saved->>'version')::bigint from private.subscription_register where id=legacy_id);
  assert (select count(*)=current_setting('mam.sr_gate_audits')::bigint from private.subscription_audit_events where subscription_id=legacy_id),'Denied changes must not add an audit event';
end $$;
rollback;
\echo PASS: current and predecessor paid-register RPCs cannot replace a service or billing anchor

begin;
\ir unified-role-fixture.sql
select pg_temp.set_test_actor('a1000000-0000-4000-8000-000000000013');
set local role authenticated;
select set_config('mam.sr_gate_record',public.create_subscription_v4(
  'Synthetic maintenance service','Existing plan','paid','annual',12000,null,1,false,null,
  date '2026-01-01','a1000000-0000-4000-8000-000000000013','mam','{}'::uuid[])::text,true);
reset role;
update private.subscription_request_config set enabled=true;
set local role authenticated;
do $$ declare r jsonb:=current_setting('mam.sr_gate_record')::jsonb;
  id uuid:=(r->>'subscription_id')::uuid; version bigint:=(r->>'version')::bigint;
  result jsonb; target text; begin
  result:=public.patch_subscription_v1(id,version,'{"company_scope":"both","responsible_person_id":"a1000000-0000-4000-8000-000000000001","subscription_status":"paused"}');
  result:=public.patch_subscription_v1(id,(result->>'version')::bigint,'{"subscription_status":"active"}');
  result:=public.update_subscription_v4(id,(result->>'version')::bigint,'Synthetic maintenance service','Existing plan','active','paid','annual',12000,null,1,false,null,
    date '2026-01-01','a1000000-0000-4000-8000-000000000001','both',array['a1000000-0000-4000-8000-000000000001']::uuid[]);
  result:=public.mark_subscription_reviewed_v2(id,(result->>'version')::bigint);
  result:=public.patch_subscription_v1(id,(result->>'version')::bigint,'{"subscription_status":"cancelled"}');
  perform set_config('mam.sr_gate_cancelled',result::text,true);
  foreach target in array array['active','paused'] loop
    begin
      perform public.patch_subscription_v1(id,(result->>'version')::bigint,jsonb_build_object('subscription_status',target));
      raise exception 'Legacy status patch reactivated a cancelled paid service';
    exception when object_not_in_prerequisite_state then null; end;
  end loop;
  begin
    perform public.update_subscription_v4(id,(result->>'version')::bigint,'Synthetic maintenance service','Existing plan','active','paid','annual',12000,null,1,false,null,
      date '2026-01-01','a1000000-0000-4000-8000-000000000001','both',array['a1000000-0000-4000-8000-000000000001']::uuid[]);
    raise exception 'Legacy full update reactivated a cancelled paid service';
  exception when object_not_in_prerequisite_state then null; end;
end $$;
reset role;
do $$ declare saved jsonb:=current_setting('mam.sr_gate_cancelled')::jsonb; legacy_id uuid:=(saved->>'id')::uuid; begin
  assert (select subscription_status='cancelled' and version=(saved->>'version')::bigint
    and company_scope='both' and responsible_person_id='a1000000-0000-4000-8000-000000000001'
    and service_name='Synthetic maintenance service' and billing_anchor_date=date '2026-01-01'
    from private.subscription_register where id=legacy_id),'Blocked reactivation must preserve legitimate maintenance';
  assert (select count(*)=1 from private.subscription_memberships where subscription_id=legacy_id);
  assert not exists(select 1 from private.subscription_requests);
  assert not exists(select 1 from private.subscription_request_notifications);
end $$;
rollback;
\echo PASS: cancelled paid reactivation is denied without blocking ownership, company, review, membership or pause/resume maintenance
