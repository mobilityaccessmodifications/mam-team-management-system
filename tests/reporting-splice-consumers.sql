\set ON_ERROR_STOP on
begin;
\ir reporting-splice-fixture.sql
update public.profiles set app_role='manager' where id=pg_temp.splice_id(7);
update public.internal_org_people set auth_user_id=pg_temp.splice_id(7) where id=pg_temp.splice_id(20);
update public.internal_org_people set auth_user_id=pg_temp.splice_id(8),started_date=(clock_timestamp() at time zone 'Australia/Melbourne')::date+14 where id=pg_temp.splice_id(30);
update private.employee_directory_details set work_email='splice8@example.test',working_weekdays=array[1,2,3,4,5]::smallint[] where person_id=pg_temp.splice_id(30);
insert into private.leave_approval_grants(reviewer_user_id,scope_kind,reviewer_label,priority) values(pg_temp.splice_id(1),'global','Synthetic Splice P0',100);
insert into private.manager_leave_reviewers values(pg_temp.splice_id(1),1) on conflict do nothing;
create temporary table splice_leave_ids(id uuid,owner integer,label text,decided boolean);
do $$ declare r uuid; label text; owner integer; day date:=current_date+(8-extract(isodow from current_date)::integer)%7; decided boolean; begin
 foreach owner in array array[20,30] loop
  foreach label in array array['Sick leave','trade school'] loop
   foreach decided in array array[false,true] loop
    select id into r from public.submit_selected_employee_leave_request(pg_temp.splice_id(owner),label,day,day,time '09:00',time '10:00','Synthetic reporting splice leave note');
    if decided then update public.leave_requests set status='approved',decided_by=pg_temp.splice_id(1),decided_at=clock_timestamp() where id=r; end if;
    insert into splice_leave_ids values(r,owner,label,decided);
   end loop;
  end loop;
 end loop;
end $$;
insert into private.employee_work_schedule_change_requests(person_id,submitted_by_user_id,original_working_weekdays,requested_working_weekdays,request_reason) values
(pg_temp.splice_id(20),pg_temp.splice_id(7),array[1,2,3,4,5]::smallint[],array[1,2,3]::smallint[],'Synthetic target request'),
(pg_temp.splice_id(30),pg_temp.splice_id(8),array[1,2,3,4,5]::smallint[],array[1,2,3]::smallint[],'Synthetic child request');
update private.employee_check_in_reminders set delivery_status='claimed',claim_token=gen_random_uuid(),claimed_at=clock_timestamp() where person_id=pg_temp.splice_id(30) and milestone='2_week';
update private.employee_check_in_reminders set delivery_status='delivered',delivered_at=clock_timestamp(),provider_delivery_id='synthetic-provider-receipt' where person_id=pg_temp.splice_id(30) and milestone='1_month';
update private.employee_check_in_reminders set delivery_status='completed',completed_at=clock_timestamp(),completed_by=pg_temp.splice_id(1) where person_id=pg_temp.splice_id(30) and milestone='3_month';
insert into private.scheduled_employee_offboarding(person_id,end_date,reason,scheduled_by) values(pg_temp.splice_id(20),'2026-10-12','Resigned',pg_temp.splice_id(1));
update splice_versions v set person_version=p.version,detail_version=d.version from public.internal_org_people p join private.employee_directory_details d on d.person_id=p.id where p.id=v.id;
create temporary table decided_before as select l.id,to_jsonb(l) value from public.leave_requests l join splice_leave_ids f using(id) where f.decided;
create temporary table decided_assignments_before as select coalesce(jsonb_agg(to_jsonb(a) order by a.leave_request_id,a.reviewer_user_id),'[]'::jsonb) value from private.leave_request_reviewer_assignments a join splice_leave_ids f on f.id=a.leave_request_id where f.decided;
create temporary table history_before as select jsonb_build_object('leave_events',(select jsonb_agg(to_jsonb(e) order by id) from public.leave_request_events e),'outbox',(select jsonb_agg(to_jsonb(e) order by id) from private.leave_notification_outbox e),'annual',(select jsonb_agg(to_jsonb(b) order by person_id) from private.employee_annual_leave_balances b),'sick',(select jsonb_agg(to_jsonb(b) order by person_id) from private.employee_sick_leave_balances b),'balance_history',(select jsonb_agg(to_jsonb(h) order by id) from private.annual_leave_balance_history h),'child_profile',(select to_jsonb(p) from public.profiles p where id=pg_temp.splice_id(8)),'child_detail',(select to_jsonb(d) from private.employee_directory_details d where person_id=pg_temp.splice_id(30)),'child_credentials',(select to_jsonb(c) from private.employee_onboarding_credentials c where person_id=pg_temp.splice_id(30)),'child_work',(select to_jsonb(w) from private.employee_work_schedule_change_requests w where person_id=pg_temp.splice_id(30))) value;
create temporary table leases_before as select id,to_jsonb(r) value from private.employee_check_in_reminders r where person_id=pg_temp.splice_id(30) and delivery_status in ('claimed','delivered','completed');
do $$ declare mode text; begin
 assert (select count(*)=3 from leases_before), 'Actual claimed/delivered/completed fixture leases exist';
 assert (select count(*)=2 from public.leave_requests l join splice_leave_ids f using(id) where f.owner=30 and not f.decided and l.manager_user_id=pg_temp.splice_id(7)), 'Pending ordinary and trade-school child requests initially route to target Manager';
 foreach mode in array array['archive','scheduled'] loop
  begin
   if mode='archive' then
    execute 'set local role authenticated';
    perform public.archive_employee_directory_record(pg_temp.splice_id(20),(select person_version from splice_versions where id=pg_temp.splice_id(20)),(select detail_version from splice_versions where id=pg_temp.splice_id(20)),'2026-10-12','Resigned');
    execute 'reset role';
   else
    perform set_config('request.jwt.claim.sub','',true);
    perform set_config('request.jwt.claims','{"role":"service_role"}',true);
    perform set_config('request.jwt.claim.role','service_role',true);
    execute 'set local role service_role';
    begin
     perform public.run_scheduled_employee_offboarding(pg_temp.splice_id(20),'2026-10-12 13:00:00+00');
     raise exception 'Unattributed worker bypassed pending work-request guard' using errcode='ZX001';
    exception when insufficient_privilege then
     assert sqlerrm='Close the pending work-schedule request with an authenticated administrator before archiving this employee.';
    end;
    execute 'reset role';
    assert (select is_active from public.internal_org_people where id=pg_temp.splice_id(20)), 'Work-request denial rolls back target employment';
    assert (select parent_id=pg_temp.splice_id(20) from public.internal_org_people where id=pg_temp.splice_id(30)), 'Work-request denial rolls back every child edge';
    perform set_config('request.jwt.claim.role','',true);
    perform pg_temp.set_test_actor(pg_temp.splice_id(1));
    perform public.decide_employee_work_schedule_change_request((select id from private.employee_work_schedule_change_requests where person_id=pg_temp.splice_id(20)),'declined','Synthetic close before due execution');
    perform set_config('request.jwt.claim.sub','',true);
    perform set_config('request.jwt.claims','{"role":"service_role"}',true);
    perform set_config('request.jwt.claim.role','service_role',true);
    execute 'set local role service_role';
    assert public.run_scheduled_employee_offboarding(pg_temp.splice_id(20),'2026-10-12 13:00:00+00');
    execute 'reset role';
   end if;
   assert (select count(*)=2 from public.leave_requests l join splice_leave_ids f using(id) where f.owner=30 and not f.decided and l.manager_user_id=pg_temp.splice_id(3)), 'Current pending regular and trade-school routes use nearest remaining Manager';
   assert not exists(select 1 from decided_before b join public.leave_requests l using(id) where to_jsonb(l) is distinct from b.value), 'Decided regular/trade-school rows are byte-equivalent';
   assert (select value from decided_assignments_before)=(select coalesce(jsonb_agg(to_jsonb(a) order by a.leave_request_id,a.reviewer_user_id),'[]'::jsonb) from private.leave_request_reviewer_assignments a join splice_leave_ids f on f.id=a.leave_request_id where f.decided), 'Decided reviewer history unchanged';
   assert not exists(select 1 from leases_before b join private.employee_check_in_reminders r using(id) where to_jsonb(r) is distinct from b.value), 'Existing in-flight lease and delivered/completed receipts preserved exactly';
   assert (select value from history_before)=(select jsonb_build_object('leave_events',(select jsonb_agg(to_jsonb(e) order by id) from public.leave_request_events e),'outbox',(select jsonb_agg(to_jsonb(e) order by id) from private.leave_notification_outbox e),'annual',(select jsonb_agg(to_jsonb(b) order by person_id) from private.employee_annual_leave_balances b),'sick',(select jsonb_agg(to_jsonb(b) order by person_id) from private.employee_sick_leave_balances b),'balance_history',(select jsonb_agg(to_jsonb(h) order by id) from private.annual_leave_balance_history h),'child_profile',(select to_jsonb(p) from public.profiles p where id=pg_temp.splice_id(8)),'child_detail',(select to_jsonb(d) from private.employee_directory_details d where person_id=pg_temp.splice_id(30)),'child_credentials',(select to_jsonb(c) from private.employee_onboarding_credentials c where person_id=pg_temp.splice_id(30)),'child_work',(select to_jsonb(w) from private.employee_work_schedule_change_requests w where person_id=pg_temp.splice_id(30)))), 'Reporting changes do not replay leave mail/events or rewrite balances, child entitlement/employment/accounts/credentials/work request';
   assert (select status=case when mode='archive' then 'cancelled' else 'declined' end from private.employee_work_schedule_change_requests where person_id=pg_temp.splice_id(20)), 'Existing target-only schedule cancellation/explicit administrator close remains';
   assert (select bool_and(l.leave_type='other' and l.pay_treatment='paid_other' and l.employment_type_snapshot='full_time') from public.leave_requests l join splice_leave_ids f using(id) where f.label='trade school'), 'Trade-school classification survives real policy triggers';
   assert (select trade_school_enabled from private.employee_directory_details where person_id=pg_temp.splice_id(20)), 'Target entitlement remains a retained private field';
   raise exception 'Rollback consumer positive control' using errcode='ZX002';
  exception when sqlstate 'ZX002' then null; end;
 end loop;
end $$;
rollback;
\echo PASS: archive/scheduled pending regular and trade-school routing; decided history, claims, receipts, balances, entitlements and child work request unchanged
