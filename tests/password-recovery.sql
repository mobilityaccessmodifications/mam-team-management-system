\set ON_ERROR_STOP on
begin;
insert into auth.users(id,email,email_confirmed_at) values
('96000000-0000-4000-8000-000000000001','opaque-one@accounts.example.test',now()),
('96000000-0000-4000-8000-000000000002','opaque-two@accounts.example.test',now()),
('96000000-0000-4000-8000-000000000003','opaque-admin@accounts.example.test',now());
insert into public.profiles(id,full_name,app_role,login_name,credentials_valid_after) values
('96000000-0000-4000-8000-000000000001','Synthetic Recovery One','employee','work-one@example.test',now()-interval '1 day'),
('96000000-0000-4000-8000-000000000002','Synthetic Recovery Two','employee','work-two@example.test',now()-interval '1 day'),
('96000000-0000-4000-8000-000000000003','Synthetic Recovery Admin','system_admin','admin@example.test',now()-interval '1 day');
insert into public.internal_org_people(id,node_kind,company_key,full_name,position_title,auth_user_id,started_date,is_active) values
('96000000-0000-4000-8000-000000000001','person','mam','Synthetic Recovery One','Tester','96000000-0000-4000-8000-000000000001',current_date-1,true),
('96000000-0000-4000-8000-000000000002','person','mam','Synthetic Recovery Two','Tester','96000000-0000-4000-8000-000000000002',current_date-1,true),
('96000000-0000-4000-8000-000000000003','person','mam','Synthetic Recovery Admin','Tester','96000000-0000-4000-8000-000000000003',current_date-1,true);
insert into private.employee_directory_details(person_id,first_name,work_email,personal_email) values
('96000000-0000-4000-8000-000000000001','Synthetic','work-one@example.test','home-one@example.test'),
('96000000-0000-4000-8000-000000000002','Synthetic','work-two@example.test','home-two@example.test'),
('96000000-0000-4000-8000-000000000003','Synthetic','admin@example.test',null);
select set_config('request.jwt.claim.role','service_role',true);

do $$
declare claimed record; n integer; before_version bigint;
begin
  assert private.confirmed_test_purge_schema_hash()=(select schema_hash from private.confirmed_test_purge_schema where singleton);
  assert not has_table_privilege('authenticated','private.portal_password_recovery_requests','select');
  assert not has_table_privilege('service_role','private.portal_password_recovery_requests','select');
  assert (select relrowsecurity from pg_class where oid='private.portal_password_recovery_requests'::regclass);
  assert not has_function_privilege('anon','public.issue_portal_password_recovery(text,text)','execute');
  assert not has_function_privilege('authenticated','public.begin_portal_password_recovery(text)','execute');
  assert not has_function_privilege('authenticated','public.finish_portal_password_recovery(uuid,uuid,boolean)','execute');
  select count(*) into n from public.issue_portal_password_recovery('admin@example.test',repeat('9',64)); assert n=0,'Protected administrators keep the existing authenticated reset flow';
  insert into private.portal_password_recovery_requests(auth_user_id,person_id,token_hash,recipient,account_version,expires_at)
    select id,id,repeat('9',64),'admin@example.test',account_version,now()+interval '1 hour' from public.profiles where id='96000000-0000-4000-8000-000000000003';
  select count(*) into n from public.begin_portal_password_recovery(repeat('9',64)); assert n=0,'A protected account cannot redeem a forged stored request';
  select count(*) into n from public.issue_portal_password_recovery('unknown@example.test',repeat('a',64)); assert n=0;
  select count(*) into n from public.issue_portal_password_recovery('opaque-one@accounts.example.test',repeat('a',64)); assert n=0;
  update private.employee_directory_details set personal_email='admin@example.test' where person_id='96000000-0000-4000-8000-000000000002';
  select count(*) into n from public.issue_portal_password_recovery('admin@example.test',repeat('8',64)); assert n=0,'Protected accounts also count towards mailbox ambiguity';
  update private.employee_directory_details set personal_email='home-two@example.test' where person_id='96000000-0000-4000-8000-000000000002';
  select count(*) into n from public.issue_portal_password_recovery('work-one@example.test',repeat('a',64)); assert n=1;
  select count(*) into n from public.issue_portal_password_recovery('home-one@example.test',repeat('b',64)); assert n=1;
  select count(*) into n from public.begin_portal_password_recovery(repeat('a',64)); assert n=0,'New request invalidates previous link';
  update private.portal_password_recovery_requests set expires_at=now()-interval '1 second';
  select count(*) into n from public.begin_portal_password_recovery(repeat('b',64)); assert n=0,'Expired link denied';
  perform public.issue_portal_password_recovery('work-one@example.test',repeat('c',64));
  update public.profiles set account_status='disabled',disabled_at=clock_timestamp() where id='96000000-0000-4000-8000-000000000001';
  select count(*) into n from public.begin_portal_password_recovery(repeat('c',64)); assert n=0,'Disabled account denied';
  select count(*) into n from public.issue_portal_password_recovery('work-one@example.test',repeat('a',64)); assert n=0;
  update public.profiles set account_status='active',disabled_at=null where id='96000000-0000-4000-8000-000000000001';
  perform public.issue_portal_password_recovery('home-one@example.test',repeat('d',64));
  update private.employee_directory_details set personal_email='changed@example.test' where person_id='96000000-0000-4000-8000-000000000001';
  select count(*) into n from public.begin_portal_password_recovery(repeat('d',64)); assert n=0,'Removed contact denied';
  update private.employee_directory_details set personal_email='work-one@example.test' where person_id='96000000-0000-4000-8000-000000000002';
  select count(*) into n from public.issue_portal_password_recovery('work-one@example.test',repeat('e',64)); assert n=0,'Shared email denied';
  update private.employee_directory_details set personal_email='home-two@example.test' where person_id='96000000-0000-4000-8000-000000000002';
  perform public.issue_portal_password_recovery('work-one@example.test',repeat('f',64));
  update public.profiles set account_version=account_version+1 where id='96000000-0000-4000-8000-000000000001';
  select count(*) into n from public.begin_portal_password_recovery(repeat('f',64)); assert n=0,'Changed account version denied';
  perform public.issue_portal_password_recovery('work-one@example.test',repeat('1',64));
  select account_version into before_version from public.profiles where id='96000000-0000-4000-8000-000000000001';
  assert exists(select 1 from private.employee_onboarding_credentials where auth_user_id='96000000-0000-4000-8000-000000000001' and status in ('scheduled','pending_account'));
  select * into claimed from public.begin_portal_password_recovery(repeat('1',64));
  assert claimed.auth_user_id='96000000-0000-4000-8000-000000000001';
  select count(*) into n from public.issue_portal_password_recovery('work-one@example.test',repeat('2',64)); assert n=0,'Pending reset cannot be overwritten';
  begin
    perform public.begin_portal_password_recovery(repeat('1',64));
    raise exception 'Duplicate reset was accepted';
  exception when object_not_in_prerequisite_state then null;
  end;
  perform set_config('request.jwt.claim.sub','96000000-0000-4000-8000-000000000003',true);
  perform set_config('request.jwt.claim.role','authenticated',true);
  perform set_config('request.jwt.claims',jsonb_build_object('sub','96000000-0000-4000-8000-000000000003',
    'iat',extract(epoch from clock_timestamp())::bigint,'is_anonymous',false,
    'app_metadata',jsonb_build_object('org_role','system_admin'))::text,true);
  begin
    perform public.update_portal_login(claimed.auth_user_id,claimed.auth_user_id,'renamed@example.test',before_version);
    raise exception 'Login rename during recovery was accepted';
  exception when object_not_in_prerequisite_state then null;
  end;
  begin
    perform public.update_portal_login(claimed.auth_user_id,claimed.auth_user_id,'work-one@example.test',before_version);
    raise exception 'Same-login version update during recovery was accepted';
  exception when object_not_in_prerequisite_state then null;
  end;
  begin
    perform public.set_portal_account_enabled(claimed.auth_user_id,claimed.auth_user_id,true,before_version);
    raise exception 'Same-status version update during recovery was accepted';
  exception when object_not_in_prerequisite_state then null;
  end;
  begin
    perform public.create_portal_account(claimed.auth_user_id,claimed.auth_user_id,'work-one@example.test','employee',
      (select version from public.internal_org_people where id=claimed.auth_user_id));
    raise exception 'Account relink during recovery was accepted';
  exception when object_not_in_prerequisite_state then null;
  end;
  perform set_config('request.jwt.claim.sub','',true);
  perform set_config('request.jwt.claims','{}',true);
  perform set_config('request.jwt.claim.role','service_role',true);
  assert not public.finish_portal_password_recovery(claimed.auth_user_id,gen_random_uuid(),true);
  assert public.finish_portal_password_recovery(claimed.auth_user_id,claimed.reset_token,true);
  assert public.finish_portal_password_recovery(claimed.auth_user_id,claimed.reset_token,true),'Finalisation is idempotent';
  assert (select account_version=before_version+1 and not must_change_password and credentials_valid_after>now()-interval '1 minute'
    from public.profiles where id=claimed.auth_user_id);
  assert exists(select 1 from private.employee_onboarding_credentials where auth_user_id=claimed.auth_user_id and status='cancelled');
  select count(*) into n from public.begin_portal_password_recovery(repeat('1',64)); assert n=0,'Consumed link denied';
  perform public.issue_portal_password_recovery('work-one@example.test',repeat('3',64));
  select * into claimed from public.begin_portal_password_recovery(repeat('3',64));
  assert public.finish_portal_password_recovery(claimed.auth_user_id,claimed.reset_token,false);
  assert not public.finish_portal_password_recovery(claimed.auth_user_id,claimed.reset_token,true),'Cancelled claim cannot finalise';
  perform public.issue_portal_password_recovery('work-one@example.test',repeat('4',64));
  update private.employee_onboarding_credentials set status='claimed',claim_token=gen_random_uuid(),claim_expires_at=now()+interval '5 minutes'
    where auth_user_id='96000000-0000-4000-8000-000000000001';
  begin
    perform public.begin_portal_password_recovery(repeat('4',64));
    raise exception 'In-flight credential delivery was accepted';
  exception when object_not_in_prerequisite_state then null;
  end;
end $$;
rollback;
