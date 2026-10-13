\set ON_ERROR_STOP on
begin;
\ir reporting-splice-fixture.sql
grant select on splice_versions to anon,service_role;
create function pg_temp.splice_snapshot() returns jsonb language sql security definer set search_path='' as $$
select jsonb_build_object(
 'people',(select jsonb_agg(to_jsonb(p) order by id) from public.internal_org_people p),
 'details',(select jsonb_agg(to_jsonb(d) order by person_id) from private.employee_directory_details d),
 'profiles',(select jsonb_agg(to_jsonb(p) order by id) from public.profiles p),
 'audits',(select jsonb_agg(to_jsonb(a) order by id) from private.employee_directory_audit_events a),
 'accounts',(select jsonb_agg(to_jsonb(a) order by id) from private.portal_account_admin_events a),
 'credentials',(select jsonb_agg(to_jsonb(c) order by id) from private.employee_onboarding_credentials c),
 'credential_events',(select jsonb_agg(to_jsonb(e) order by id) from private.employee_onboarding_credential_events e),
 'reset_claims',(select jsonb_agg(to_jsonb(r) order by auth_user_id) from private.portal_password_reset_claims r),
 'schedules',(select jsonb_agg(to_jsonb(s) order by person_id) from private.scheduled_employee_offboarding s),
 'leave',(select jsonb_agg(to_jsonb(l) order by id) from public.leave_requests l),
 'checkins',(select jsonb_agg(to_jsonb(c) order by id) from private.employee_check_in_reminders c));
$$;
create function pg_temp.splice_reject(query text,expected_state text) returns void language plpgsql as $$
declare before jsonb:=pg_temp.splice_snapshot();
begin
 begin
  execute query;
  raise exception 'Expected reporting-splice rejection' using errcode='ZX001';
 exception when others then
  if sqlstate<>expected_state then raise; end if;
 end;
 assert pg_temp.splice_snapshot()=before, 'Rejected operation has no partial graph/account/audit/credential/history changes';
end $$;
create function pg_temp.splice_call(operation text,target integer default 20,pv bigint default null,dv bigint default null,ended date default '2026-10-12',reason text default 'Resigned') returns text language sql as $$
 select format('select public.%I(%L::uuid,%s,%s,%L::date,%L::text)',operation,pg_temp.splice_id(target),coalesce(pv::text,(select person_version::text from splice_versions where id=pg_temp.splice_id(target)),'null'),coalesce(dv::text,(select detail_version::text from splice_versions where id=pg_temp.splice_id(target)),'null'),ended,reason)
$$;
select pg_temp.set_test_actor(pg_temp.splice_id(5));
set local role authenticated;
select pg_temp.splice_reject(pg_temp.splice_call('preflight_employee_removal_reporting_splice'),'42501');
select pg_temp.splice_reject(pg_temp.splice_call('archive_employee_directory_record'),'42501');
select pg_temp.splice_reject(format('select public.delete_employee_directory_record(%L,1)',pg_temp.splice_id(20)),'42501');
reset role;
select pg_temp.set_test_actor(pg_temp.splice_id(3));
set local role authenticated;
select pg_temp.splice_reject(pg_temp.splice_call('preflight_employee_removal_reporting_splice'),'42501');
reset role;
select pg_temp.set_test_actor(pg_temp.splice_id(4));
set local role authenticated;
select pg_temp.splice_reject(pg_temp.splice_call('preflight_employee_removal_reporting_splice'),'42501');
reset role;
select set_config('request.jwt.claim.sub','',true),set_config('request.jwt.claims','{}',true);
set local role anon;
select pg_temp.splice_reject(pg_temp.splice_call('preflight_employee_removal_reporting_splice'),'42501');
reset role;
set local role service_role;
select pg_temp.splice_reject(pg_temp.splice_call('preflight_employee_removal_reporting_splice'),'42501');
reset role;
select pg_temp.set_test_actor(pg_temp.splice_id(2));
set local role authenticated;
select pg_temp.splice_reject(pg_temp.splice_call('preflight_employee_removal_reporting_splice',20,999),'PT409');
select pg_temp.splice_reject(pg_temp.splice_call('preflight_employee_removal_reporting_splice',20,null,999),'PT409');
select pg_temp.splice_reject(pg_temp.splice_call('archive_employee_directory_record',20,999),'PT409');
select pg_temp.splice_reject(pg_temp.splice_call('archive_employee_directory_record',20,null,999),'PT409');
select pg_temp.splice_reject(pg_temp.splice_call('preflight_employee_removal_reporting_splice',20,null,null,null),'22004');
select pg_temp.splice_reject(pg_temp.splice_call('preflight_employee_removal_reporting_splice',20,null,null,'2026-10-12','malformed'),'22023');
select pg_temp.splice_reject(pg_temp.splice_call('preflight_employee_removal_reporting_splice',20,0),'22023');
select pg_temp.splice_reject(pg_temp.splice_call('preflight_employee_removal_reporting_splice',2),'42501');
select pg_temp.splice_reject(pg_temp.splice_call('preflight_employee_removal_reporting_splice',6),'42501');
reset role;
select pg_temp.set_test_actor(pg_temp.splice_id(1));
update public.internal_org_people set parent_id=pg_temp.splice_id(20) where id=pg_temp.splice_id(6);
select pg_temp.set_test_actor(pg_temp.splice_id(2));
set local role authenticated;
select pg_temp.splice_reject(pg_temp.splice_call('preflight_employee_removal_reporting_splice'),'42501');
select pg_temp.splice_reject(pg_temp.splice_call('archive_employee_directory_record'),'42501');
reset role;
select pg_temp.set_test_actor(pg_temp.splice_id(1));
update public.internal_org_people set parent_id=null where id=pg_temp.splice_id(6);
insert into private.scheduled_employee_offboarding(person_id,end_date,reason,scheduled_by) values(pg_temp.splice_id(20),'2026-10-12','Resigned',pg_temp.splice_id(1));
update public.internal_org_people set parent_id=pg_temp.splice_id(20) where id=pg_temp.splice_id(6);
select set_config('request.jwt.claim.sub','',true),set_config('request.jwt.claims','{"role":"service_role"}',true),set_config('request.jwt.claim.role','service_role',true);
set local role service_role;
select pg_temp.splice_reject(format('select public.run_scheduled_employee_offboarding(%L,%L)',pg_temp.splice_id(20),'2026-10-12 13:00:00+00'),'42501');
reset role;
select set_config('request.jwt.claim.role','',true);
select pg_temp.set_test_actor(pg_temp.splice_id(1));
update public.internal_org_people set parent_id=null where id=pg_temp.splice_id(6);
update public.internal_org_people set auth_user_id=pg_temp.splice_id(8) where id=pg_temp.splice_id(30);
create temporary table child_credential_before as select to_jsonb(c) value from private.employee_onboarding_credentials c where person_id=pg_temp.splice_id(30);
do $$ declare state text; query text:=pg_temp.splice_call('archive_employee_directory_record'); begin
 foreach state in array array['claimed','sending','needs_review'] loop
  update private.employee_onboarding_credentials set status=state,claimed_login='splice8@example.test' where person_id=pg_temp.splice_id(30);
  perform pg_temp.splice_reject(query,'55000');
  perform pg_temp.splice_reject(pg_temp.splice_call('preflight_employee_removal_reporting_splice'),'55000');
  perform pg_temp.splice_reject(format('select public.run_scheduled_employee_offboarding(%L,%L)',pg_temp.splice_id(20),'2026-10-12 13:00:00+00'),'55000');
 end loop;
 foreach state in array array['scheduled','delivered','cancelled','pending_account','needs_review'] loop
  update private.employee_onboarding_credentials set status=state,claimed_login=null where person_id=pg_temp.splice_id(30);
  begin
   execute query;
   assert (select parent_id=pg_temp.splice_id(10) from public.internal_org_people where id=pg_temp.splice_id(30));
   assert (select to_jsonb(c)-array['status','claimed_login']=(select value-array['status','claimed_login'] from child_credential_before) from private.employee_onboarding_credentials c where person_id=pg_temp.splice_id(30)), 'Reporting update preserves complete delivery outside fixture status';
   raise exception 'Rollback positive control' using errcode='ZX002';
  exception when sqlstate 'ZX002' then null; end;
 end loop;
end $$;
update private.employee_onboarding_credentials set status='scheduled',claimed_login=null where person_id=pg_temp.splice_id(30);
insert into private.portal_password_reset_claims(auth_user_id,person_id,reset_token,claimed_by,claimed_at,status,claimed_account_version) values(pg_temp.splice_id(8),pg_temp.splice_id(30),gen_random_uuid(),pg_temp.splice_id(1),clock_timestamp()-interval '365 days','pending',1);
set local role authenticated;
select pg_temp.splice_reject(pg_temp.splice_call('preflight_employee_removal_reporting_splice'),'40001');
select pg_temp.splice_reject(pg_temp.splice_call('archive_employee_directory_record'),'40001');
reset role;
delete from private.portal_password_reset_claims where auth_user_id=pg_temp.splice_id(8);
select * from public.create_it_asset('laptop',pg_temp.splice_id(20),'Synthetic','Synthetic','synthetic-splice-device');
set local role authenticated;
select pg_temp.splice_reject(pg_temp.splice_call('preflight_employee_removal_reporting_splice'),'23514');
select pg_temp.splice_reject(pg_temp.splice_call('archive_employee_directory_record'),'23514');
reset role;
set local role service_role;
select pg_temp.splice_reject(format('select public.run_scheduled_employee_offboarding(%L,%L)',pg_temp.splice_id(20),'2026-10-12 13:00:00+00'),'23514');
reset role;
rollback;
\echo PASS: authorization/self/P0/stale/credential/reset/asset denials are atomic and eligible credential states remain valid
