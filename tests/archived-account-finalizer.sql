\if :{?finalizer_scenario}
\else
\set finalizer_scenario leaf
\endif
\set ON_ERROR_STOP on
begin;
set local role postgres;
set local statement_timeout='5s';
set local lock_timeout='1s';
set local search_path='';
do $$ begin
  assert current_database() ~ '^mam_test_', 'Owned synthetic database required';
  assert current_user='postgres';
  assert inet_server_addr() is null and current_setting('listen_addresses')='';
end $$;
create temporary table diag_params as select
 :'finalizer_scenario'::text scenario,
 'a7200000-0000-4000-8000-000000000001'::uuid actor,
 'a7200000-0000-4000-8000-000000000002'::uuid target,
 'a7200000-0000-4000-8000-000000000003'::uuid child,
 'a7200000-0000-4000-8000-000000000004'::uuid ancestor,
 gen_random_uuid() executor,
 'diag-target@example.test'::text initial_login;
grant select on diag_params to authenticated,service_role;
create temporary table diag_outcome(state text,message text,context text);
grant insert,select on diag_outcome to authenticated;
insert into auth.users(id,email,email_confirmed_at)
 select actor,'diag-actor@example.test',clock_timestamp() from diag_params
 union all select target,initial_login,clock_timestamp() from diag_params;
insert into public.profiles(id,full_name,app_role,login_name,account_status,credentials_valid_after)
 select actor,'Synthetic Diagnosis Actor','admin','diag-actor@example.test','active',clock_timestamp()-interval '1 day' from diag_params
 union all select target,'Synthetic Diagnosis Target','employee',initial_login,'active',clock_timestamp()-interval '1 day' from diag_params;
insert into public.internal_org_people(id,full_name,company_key,position_title,auth_user_id,is_active)
 select actor,'Synthetic Diagnosis Actor','mam','Synthetic role',actor,true from diag_params
 union all select target,'Synthetic Diagnosis Target','mam','Synthetic role',target,true from diag_params;
insert into private.employee_directory_details(person_id,first_name,employment_type,work_email,team_name)
 select target,'Synthetic','full_time',initial_login,'Major' from diag_params;
do $$ begin
 if (select scenario='one-child' from diag_params) then
   insert into public.internal_org_people(id,node_kind,full_name,company_key,position_title,is_active)
     select ancestor,'org_unit',null,'mam','Synthetic ancestor',true from diag_params;
   update public.internal_org_people set parent_id=(select ancestor from diag_params) where id=(select target from diag_params);
   insert into public.internal_org_people(id,node_kind,full_name,company_key,position_title,is_active,parent_id)
     select child,'person','Synthetic Diagnosis Child','mam','Synthetic child',true,target from diag_params;
 end if;
end $$;
create temporary table diag_versions as
 select p.version person_version,d.version detail_version,f.account_version
 from diag_params x join public.internal_org_people p on p.id=x.target
 join private.employee_directory_details d on d.person_id=x.target
 join public.profiles f on f.id=x.target;
grant select on diag_versions to authenticated;
create function pg_temp.diag_actor(service boolean default false) returns void language plpgsql as $$
declare a uuid:=(select actor from diag_params);
begin
 if service then
   perform set_config('request.jwt.claim.sub','',true);
   perform set_config('request.jwt.claim.role','service_role',true);
   perform set_config('request.jwt.claims','{"role":"service_role"}',true);
 else
   perform set_config('request.jwt.claim.sub',a::text,true);
   perform set_config('request.jwt.claim.role','authenticated',true);
   perform set_config('request.jwt.claims',jsonb_build_object('sub',a,'role','authenticated','iat',extract(epoch from clock_timestamp())::bigint,'is_anonymous',false,'app_metadata',jsonb_build_object('org_role','admin'))::text,true);
 end if;
end $$;
create function pg_temp.diag_snapshot() returns jsonb language sql security definer set search_path='' as $$
 select jsonb_build_object(
   'personExists',p.id is not null,'nodeKind',p.node_kind,'personActive',p.is_active,'personVersion',p.version,
   'linkCorrect',p.auth_user_id=x.target,
   'profileExists',f.id is not null,'loginPresent',f.login_name is not null,'accountStatus',f.account_status,'accountVersion',f.account_version,
   'authUserExists',u.id is not null,'syntheticAuthBanPresent',coalesce(u.banned_until>clock_timestamp(),false),
   'claimExists',c.auth_user_id is not null,'claimStatus',c.status,'providerStatus',c.provider_status,
   'claimActorCorrect',c.claimed_by=x.actor,'claimPersonCorrect',c.person_id=x.target,
   'requestedEnabled',c.requested_enabled,'claimedStatus',c.claimed_account_status,'claimedVersion',c.claimed_account_version,
   'finalVersion',c.final_account_version,
   'changeTokenSha256',encode(extensions.digest(c.change_token::text,'sha256'),'hex'),
   'executorTokenSha256',encode(extensions.digest(c.executor_token::text,'sha256'),'hex'),
   'eligibleProfilePredicate',f.id is not null and f.login_name is not null and p.id is not null and p.auth_user_id=x.target and p.node_kind='person' and (p.is_active or f.account_status=case when c.requested_enabled then 'active' else 'disabled' end),
   'statusAndVersionMismatchPredicate',f.account_status<>case when c.requested_enabled then 'active' else 'disabled' end and f.account_version<>c.claimed_account_version,
   'childExists',ch.id is not null,'childActive',ch.is_active,'childParentIsTarget',ch.parent_id=x.target,'childParentIsAncestor',ch.parent_id=x.ancestor,
   'onboardingStatus',(select status from private.employee_onboarding_credentials where person_id=x.target),
   'actorAuthority',private.is_operational_portal_admin())
 from pg_temp.diag_params x
 left join public.internal_org_people p on p.id=x.target
 left join public.internal_org_people ch on ch.id=x.child
 left join public.profiles f on f.id=x.target
 left join auth.users u on u.id=x.target
 left join private.portal_account_status_change_claims c on c.auth_user_id=x.target;
$$;
create function pg_temp.diag_frame(phase text) returns jsonb language sql as $$
 select jsonb_build_object('phase',phase,'database',current_database(),'scenario',(select scenario from diag_params),'dbRole',current_user,'sessionRole',session_user,'authRole',auth.role(),'actorUidMatches',auth.uid()=(select actor from diag_params),'state',pg_temp.diag_snapshot());
$$;
select pg_temp.diag_actor();
select pg_temp.diag_frame('before_preflight');
set local role authenticated;
do $$ begin
 assert public.can_manage_employee_directory(), 'Actual linked admin capability required';
 if to_regprocedure('public.preflight_employee_removal_reporting_splice(uuid,bigint,bigint,date,text)') is not null then
   assert public.preflight_employee_removal_reporting_splice((select target from diag_params),(select person_version from diag_versions),(select detail_version from diag_versions),(clock_timestamp() at time zone 'Australia/Melbourne')::date,'Other');
 end if;
end $$;
select pg_temp.diag_frame('after_preflight');
create temporary table diag_claim as
 select * from public.begin_portal_account_status_change((select target from diag_params),(select target from diag_params),false,(select account_version from diag_versions));
grant select on diag_claim to postgres,service_role;
do $$ begin
 assert (select count(*)=1 from diag_claim);
 assert (select account_status='active' and account_version=1 from diag_claim);
 assert (pg_temp.diag_snapshot()->>'claimStatus')='pending';
 assert (pg_temp.diag_snapshot()->>'providerStatus')='not_started';
 assert (pg_temp.diag_snapshot()->>'loginPresent')::boolean;
end $$;
select pg_temp.diag_frame('after_begin');
set local role postgres;
select pg_temp.diag_actor(true);
set local role service_role;
do $$ begin
 assert current_user='service_role' and auth.uid() is null and auth.role()='service_role';
 assert public.claim_portal_account_status_execution((select target from diag_params),(select change_token from diag_claim),(select actor from diag_params),(select executor from diag_params))='execute';
 assert (pg_temp.diag_snapshot()->>'providerStatus')='executing';
end $$;
select pg_temp.diag_frame('after_executor');
do $$ begin
 assert public.record_portal_account_status_execution((select target from diag_params),(select change_token from diag_claim),(select executor from diag_params),true);
 assert (pg_temp.diag_snapshot()->>'providerStatus')='succeeded';
end $$;
select pg_temp.diag_frame('after_synthetic_provider_receipt');
set local role postgres;
select pg_temp.diag_actor();
savepoint ordinary_login_control;
set local role authenticated;
do $$ declare r record; begin
 select * into strict r from public.finalise_portal_account_status_change((select target from diag_params),(select target from diag_params),(select change_token from diag_claim));
 assert r.account_status='disabled' and r.account_version=2 and r.login_name is not null;
 assert (pg_temp.diag_snapshot()->>'personActive')::boolean;
 assert (pg_temp.diag_snapshot()->>'claimStatus')='finalised';
end $$;
select pg_temp.diag_frame('ordinary_login_control_finalised');
rollback to ordinary_login_control;
select pg_temp.diag_frame('before_archive');
set local role authenticated;
do $$ declare r record; begin
 select * into strict r from public.archive_employee_directory_record((select target from diag_params),(select person_version from diag_versions),(select detail_version from diag_versions),(clock_timestamp() at time zone 'Australia/Melbourne')::date,'Other');
 assert r.person_id=(select target from diag_params);
 assert not (pg_temp.diag_snapshot()->>'personActive')::boolean;
 assert (pg_temp.diag_snapshot()->>'linkCorrect')::boolean;
 assert (pg_temp.diag_snapshot()->>'profileExists')::boolean;
 assert not (pg_temp.diag_snapshot()->>'loginPresent')::boolean;
 assert (pg_temp.diag_snapshot()->>'accountStatus')='disabled';
 assert (pg_temp.diag_snapshot()->>'accountVersion')::bigint=2;
 assert (pg_temp.diag_snapshot()->>'claimStatus')='pending';
 assert (pg_temp.diag_snapshot()->>'providerStatus')='succeeded';
 assert not (pg_temp.diag_snapshot()->>'eligibleProfilePredicate')::boolean;
 assert not (pg_temp.diag_snapshot()->>'statusAndVersionMismatchPredicate')::boolean;
 if (select scenario='one-child' from diag_params) then
   assert (pg_temp.diag_snapshot()->>'childParentIsAncestor')::boolean;
 end if;
end $$;
select pg_temp.diag_frame('after_actual_archive');
set local role postgres;
create function pg_temp.assert_finalizer_rejected(person uuid, account uuid, token uuid, expected text) returns void language plpgsql as $$
declare before jsonb:=pg_temp.diag_snapshot(); state text;
begin
 begin
  perform public.finalise_portal_account_status_change(person,account,token);
  raise exception 'Unexpected finalizer acceptance' using errcode='ZX001';
 exception when others then
  get stacked diagnostics state=returned_sqlstate;
  assert state=expected, 'Finalizer did not return the exact expected denial';
 end;
 assert pg_temp.diag_snapshot()=before, 'Rejected finalizer changed native state';
end $$;
set local role authenticated;
select pg_temp.assert_finalizer_rejected((select target from diag_params),(select target from diag_params),gen_random_uuid(),'40001');
select pg_temp.diag_frame('negative_wrong_token');
select pg_temp.assert_finalizer_rejected((select ancestor from diag_params),(select target from diag_params),(select change_token from diag_claim),'40001');
select pg_temp.diag_frame('negative_wrong_person');
select pg_temp.assert_finalizer_rejected((select target from diag_params),(select actor from diag_params),(select change_token from diag_claim),'40001');
select pg_temp.diag_frame('negative_wrong_auth_link');
savepoint negative_wrong_claimed_actor;
set local role postgres;
update private.portal_account_status_change_claims set claimed_by=(select target from diag_params) where auth_user_id=(select target from diag_params);
set local role authenticated;
select pg_temp.assert_finalizer_rejected((select target from diag_params),(select target from diag_params),(select change_token from diag_claim),'40001');
select pg_temp.diag_frame('negative_wrong_claimed_actor');
rollback to negative_wrong_claimed_actor;
savepoint negative_requested_enabled;
set local role postgres;
update private.portal_account_status_change_claims set requested_enabled=true where auth_user_id=(select target from diag_params);
set local role authenticated;
select pg_temp.assert_finalizer_rejected((select target from diag_params),(select target from diag_params),(select change_token from diag_claim),'40001');
select pg_temp.diag_frame('negative_requested_enabled');
rollback to negative_requested_enabled;
savepoint negative_claimed_disabled;
set local role postgres;
update private.portal_account_status_change_claims set claimed_account_status='disabled' where auth_user_id=(select target from diag_params);
set local role authenticated;
select pg_temp.assert_finalizer_rejected((select target from diag_params),(select target from diag_params),(select change_token from diag_claim),'40001');
select pg_temp.diag_frame('negative_claimed_disabled');
rollback to negative_claimed_disabled;
savepoint negative_version_not_incremented;
set local role postgres;
update public.profiles set account_version=1 where id=(select target from diag_params);
set local role authenticated;
select pg_temp.assert_finalizer_rejected((select target from diag_params),(select target from diag_params),(select change_token from diag_claim),'40001');
select pg_temp.diag_frame('negative_version_not_incremented');
rollback to negative_version_not_incremented;
savepoint negative_version_incremented_twice;
set local role postgres;
update public.profiles set account_version=3 where id=(select target from diag_params);
set local role authenticated;
select pg_temp.assert_finalizer_rejected((select target from diag_params),(select target from diag_params),(select change_token from diag_claim),'40001');
select pg_temp.diag_frame('negative_version_incremented_twice');
rollback to negative_version_incremented_twice;
savepoint negative_missing_profile;
set local role postgres;
delete from public.profiles where id=(select target from diag_params);
set local role authenticated;
select pg_temp.assert_finalizer_rejected((select target from diag_params),(select target from diag_params),(select change_token from diag_claim),'40001');
select pg_temp.diag_frame('negative_missing_profile');
rollback to negative_missing_profile;
savepoint negative_active_without_login;
set local role postgres;
update public.internal_org_people set is_active=true where id=(select target from diag_params);update public.profiles set login_name=null where id=(select target from diag_params);
set local role authenticated;
select pg_temp.assert_finalizer_rejected((select target from diag_params),(select target from diag_params),(select change_token from diag_claim),'40001');
select pg_temp.diag_frame('negative_active_without_login');
rollback to negative_active_without_login;
savepoint negative_cancelled;
set local role postgres;
update private.portal_account_status_change_claims set provider_status='not_started' where auth_user_id=(select target from diag_params);update private.portal_account_status_change_claims set status='cancelled',cancelled_at=clock_timestamp() where auth_user_id=(select target from diag_params);
set local role authenticated;
select pg_temp.assert_finalizer_rejected((select target from diag_params),(select target from diag_params),(select change_token from diag_claim),'40001');
select pg_temp.diag_frame('negative_cancelled');
rollback to negative_cancelled;
savepoint negative_actor_lost_authority;
set local role postgres;
update public.profiles set app_role='employee' where id=(select actor from diag_params);
set local role authenticated;
select pg_temp.assert_finalizer_rejected((select target from diag_params),(select target from diag_params),(select change_token from diag_claim),'42501');
select pg_temp.diag_frame('negative_actor_lost_authority');
rollback to negative_actor_lost_authority;
savepoint negative_stale_actor;
set local role postgres;
update public.profiles set credentials_valid_after=clock_timestamp()+interval '1 day' where id=(select actor from diag_params);
set local role authenticated;
select pg_temp.assert_finalizer_rejected((select target from diag_params),(select target from diag_params),(select change_token from diag_claim),'42501');
select pg_temp.diag_frame('negative_stale_actor');
rollback to negative_stale_actor;
savepoint negative_provider_not_started;
set local role postgres;
update private.portal_account_status_change_claims set provider_status='not_started' where auth_user_id=(select target from diag_params);
set local role authenticated;
select pg_temp.assert_finalizer_rejected((select target from diag_params),(select target from diag_params),(select change_token from diag_claim),'40001');
select pg_temp.diag_frame('negative_provider_not_started');
rollback to negative_provider_not_started;
savepoint negative_provider_executing;
set local role postgres;
update private.portal_account_status_change_claims set provider_status='executing' where auth_user_id=(select target from diag_params);
set local role authenticated;
select pg_temp.assert_finalizer_rejected((select target from diag_params),(select target from diag_params),(select change_token from diag_claim),'40001');
select pg_temp.diag_frame('negative_provider_executing');
rollback to negative_provider_executing;
savepoint negative_provider_unknown;
set local role postgres;
update private.portal_account_status_change_claims set provider_status='unknown' where auth_user_id=(select target from diag_params);
set local role authenticated;
select pg_temp.assert_finalizer_rejected((select target from diag_params),(select target from diag_params),(select change_token from diag_claim),'40001');
select pg_temp.diag_frame('negative_provider_unknown');
rollback to negative_provider_unknown;
set local role postgres;
select pg_temp.diag_actor(true);
set local role service_role;
select pg_temp.assert_finalizer_rejected((select target from diag_params),(select target from diag_params),(select change_token from diag_claim),'42501');
select pg_temp.diag_frame('negative_service_without_actor');
set local role postgres;
select pg_temp.diag_actor();
set local role authenticated;

do $$ declare r record; before jsonb:=pg_temp.diag_snapshot(); begin
 select * into strict r from public.finalise_portal_account_status_change((select target from diag_params),(select target from diag_params),(select change_token from diag_claim));
 assert r.account_status='disabled' and r.account_version=2 and r.login_name is null;
 assert (pg_temp.diag_snapshot()->>'claimStatus')='finalised';
 assert (pg_temp.diag_snapshot()->>'providerStatus')='succeeded';
 assert (pg_temp.diag_snapshot()->>'finalVersion')::bigint=2;
 assert not (pg_temp.diag_snapshot()->>'loginPresent')::boolean;
 assert pg_temp.diag_snapshot()-array['claimStatus','finalVersion']=before-array['claimStatus','finalVersion'];
end $$;
select pg_temp.diag_frame('after_actual_finalise');
do $$ declare r record; before jsonb:=pg_temp.diag_snapshot(); begin
 select * into strict r from public.finalise_portal_account_status_change((select target from diag_params),(select target from diag_params),(select change_token from diag_claim));
 assert r.account_status='disabled' and r.account_version=2 and r.login_name is null;
 assert pg_temp.diag_snapshot()=before;
end $$;
select pg_temp.diag_frame('after_idempotent_finalise');
rollback;
