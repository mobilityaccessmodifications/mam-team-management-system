\set ON_ERROR_STOP on
begin;
\ir unified-role-fixture.sql
insert into public.leave_requests(id,user_id,employee_person_id,leave_type,request_type_label,start_date,end_date,business_days,hours,status,submitted_at,reason)
values('a2000000-0000-4000-8000-000000000001','a1000000-0000-4000-8000-000000000001','a1000000-0000-4000-8000-000000000001','unpaid','Unpaid leave',current_date+20,current_date+20,1,7.6,'submitted',now(),'Synthetic approved Account-visible note');
select pg_temp.set_test_actor('a1000000-0000-4000-8000-000000000003');
set local role authenticated;
do $$ begin
  assert (select count(*)=1 from public.leave_requests where id='a2000000-0000-4000-8000-000000000001'), 'Account read policy agrees with all-status register RPC';
  begin update public.leave_requests set status='approved' where id='a2000000-0000-4000-8000-000000000001';
    raise exception 'Account direct table leave write'; exception when insufficient_privilege then null; end;
  begin select * from private.employee_annual_leave_balances;
    raise exception 'Browser direct balance access'; exception when insufficient_privilege then null; end;
  begin perform private.portal_role_policy('a1000000-0000-4000-8000-000000000004');
    raise exception 'Private target policy exposed'; exception when insufficient_privilege then null; end;
end $$;
reset role;
select pg_temp.set_test_actor('a1000000-0000-4000-8000-000000000008');
set local role authenticated;
do $$ begin
  assert (select count(*)=0 from public.leave_requests where id='a2000000-0000-4000-8000-000000000001'), 'Stale Employee global grants cannot widen RLS reads';
end $$;
reset role;
do $$ declare checked record; role_name text; signature text; begin
  assert private.confirmed_test_purge_schema_hash()=(select schema_hash from private.confirmed_test_purge_schema), 'Reviewed schema remains usable by unchanged P0-only confirmed-test purge';
  for checked in select * from (values
    ('private.guard_onboarding_credential_send()','e6c990b2ac13fa5e58cbb29ffb6ae40682013dbb564218afdd1494b7e560be45'),
    ('private.sync_employee_onboarding_credentials()','33274f9676092c82d2fc5b6b7fee7429936583dc6c4f48e5a97724775f9b6cb7'),
    ('public.begin_onboarding_credential_delivery(uuid,uuid,text,text,text)','0f36ca3efe5ee3fca8f4ef80de28050dfaaaf367f970bacf2794543f4b6259aa'),
    ('public.begin_portal_password_reset(uuid,uuid,bigint)','af714c00e5c04a00270d35660a2f5e16005b9cad60aa8302a09459794d2e12db'),
    ('public.cancel_portal_password_reset(uuid,uuid)','61d3310408e438ea0184999e158bcbb40b5d9813bb388e8499f52ef5e0547d45'),
    ('public.claim_due_onboarding_credentials(integer)','2a8d29e944b37a80ff67982ead5c420efec434ead84ab5e90a29b6b5f66925dd'),
    ('public.complete_onboarding_credential_delivery(uuid,uuid)','eeb4faee46c432ed682bf81115cd1784c0e206976542520097c35af9ad001c6f'),
    ('public.fail_onboarding_credential_delivery(uuid,uuid,text)','d775094ef2c6553b23175ca1f2dfe613974c8db13b040f4f3555aa628fb55f3d'),
    ('public.finalise_portal_password_reset(uuid,uuid,uuid)','d541b11711b8256b5bf55f553d9fd1861a993d114c4c11cd00a89f3af7e64b20'),
    ('public.update_portal_login(uuid,uuid,text,bigint)','8cebb025ecc74b2ae3cfcdd20e3e802a4263e8ff089503477b02e2c9c41f4cd0')
  ) expected(signature,definition_sha256) loop
    assert encode(extensions.digest(pg_get_functiondef(checked.signature::regprocedure),'sha256'),'hex')=checked.definition_sha256,
      'Credential reset/delivery guard bytes changed: '||checked.signature;
  end loop;
  foreach signature in array array['public.get_portal_role_capabilities(uuid)','public.list_subscription_management_delegates()',
    'public.replace_subscription_management_delegates(uuid[])','public.get_payroll_balance_import_workspace_for_preview(uuid)'] loop
    assert has_function_privilege('authenticated',signature,'execute'), 'Missing controlled RPC grant: '||signature;
    foreach role_name in array array['anon','service_role'] loop
      assert not has_function_privilege(role_name,signature,'execute'), 'RPC ACL too broad: '||signature||' '||role_name;
    end loop;
  end loop;
  foreach signature in array array['private.portal_role_policy(uuid)','private.validate_subscription_role_delegates(uuid[])',
    'private.employee_work_schedule_workspace_json_for_actor(uuid,boolean,uuid,boolean,uuid)',
    'private.freeze_payroll_balance_comparison(uuid)','private.is_operational_portal_admin()',
    'public.stage_payroll_balance_import_before_comparison(uuid,text,jsonb,jsonb)','public.commit_payroll_balance_import_before_comparison(uuid,bigint)'] loop
    foreach role_name in array array['anon','authenticated','service_role'] loop
      assert not has_function_privilege(role_name,signature,'execute'), 'Internal API ACL too broad: '||signature||' '||role_name;
    end loop;
  end loop;
  assert has_function_privilege('service_role','public.stage_payroll_balance_import_for_preview(uuid,uuid,text,jsonb,jsonb)','execute');
  assert not has_function_privilege('authenticated','public.stage_payroll_balance_import_for_preview(uuid,uuid,text,jsonb,jsonb)','execute');
end $$;
select pg_temp.set_test_actor('a1000000-0000-4000-8000-000000000004');
set local role authenticated;
do $$ begin
  begin perform public.get_confirmed_test_identity_purge(gen_random_uuid());
    raise exception 'Admin accessed destructive test purge'; exception when insufficient_privilege then null; end;
  begin perform public.prepare_confirmed_test_identity_purge(null,null,null,null,null,null,null,null,true,true);
    raise exception 'Admin invoked destructive test purge'; exception when insufficient_privilege then null; end;
end $$;
reset role;
rollback;
\echo PASS: RLS/ACL/service boundaries, unchanged credential guards and reviewed P0-only purge schema
