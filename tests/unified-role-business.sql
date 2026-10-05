\set ON_ERROR_STOP on
begin;
\ir unified-role-fixture.sql
insert into private.employee_directory_details(person_id,first_name,last_name,team_name,employment_type,date_of_birth)
select id,'Synthetic',right(id::text,2),'Major','full_time',date '1990-01-01'
from public.internal_org_people where id::text like 'a1000000%';
update public.internal_org_people set company_key='equipsy'
where id='a1000000-0000-4000-8000-000000000016';
update public.internal_org_people set is_active=true where id='a1000000-0000-4000-8000-000000000011';
insert into public.leave_requests(id,user_id,employee_person_id,leave_type,request_type_label,
 start_date,end_date,business_days,hours,status,submitted_at,reason,manager_note)
select ('a2000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,
  ('a1000000-0000-4000-8000-'||lpad(u::text,12,'0'))::uuid,
  ('a1000000-0000-4000-8000-'||lpad(u::text,12,'0'))::uuid,
  'unpaid','Unpaid leave',current_date+20+n,current_date+20+n,1,7.6,s,now(),
  'Synthetic existing employee note','Synthetic existing reviewer note'
from (values (1,1,'submitted'),(2,6,'submitted'),(3,14,'rejected'),(4,11,'approved'),
 (5,3,'submitted'),(6,16,'changes_requested'),(7,16,'cancelled'),(8,2,'submitted')) data(n,u,s);
update public.internal_org_people set is_active=false where id='a1000000-0000-4000-8000-000000000011';
insert into public.leave_request_attachments(id,leave_request_id,uploaded_by,storage_path,file_name,mime_type,size_bytes)
values ('a3000000-0000-4000-8000-000000000001','a2000000-0000-4000-8000-000000000001',
 'a1000000-0000-4000-8000-000000000001','a2000000-0000-4000-8000-000000000001/synthetic.pdf','synthetic.pdf','application/pdf',10);
insert into private.leave_request_reviewer_assignments(leave_request_id,reviewer_user_id,source_grant_id,assignment_kind,reviewer_label,is_primary)
select 'a2000000-0000-4000-8000-000000000001',g.reviewer_user_id,g.id,'global',g.reviewer_label,false
from private.leave_approval_grants g where g.reviewer_user_id in
 ('a1000000-0000-4000-8000-000000000006','a1000000-0000-4000-8000-000000000008') and g.scope_kind='global';
insert into private.employee_work_schedule_change_requests(person_id,submitted_by_user_id,requested_working_weekdays,request_reason)
values ('a1000000-0000-4000-8000-000000000001','a1000000-0000-4000-8000-000000000002',array[1,2,3]::smallint[],'Synthetic Manager-submitted request'),
  ('a1000000-0000-4000-8000-000000000006','a1000000-0000-4000-8000-000000000006',array[1,2,3]::smallint[],'Synthetic unrelated request'),
  ('a1000000-0000-4000-8000-000000000003','a1000000-0000-4000-8000-000000000009',array[1,2,3]::smallint[],'Synthetic P0-submitted request');
do $$ declare n integer; u uuid; actual jsonb; preview jsonb; begin
  for n in 1..6 loop
    u:=('a1000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid;
    perform pg_temp.set_test_actor(u);
    actual:=public.get_my_employee_work_schedule_workspace();
    if n=4 then assert jsonb_array_length(actual->'reviews')=3, 'Admin daily work-schedule global review scope'; end if;
    perform pg_temp.set_test_actor('a1000000-0000-4000-8000-000000000009');
    preview:=public.get_selected_employee_work_schedule_workspace(u);
    assert actual->'reviews'=preview->'reviews', 'Work-schedule preview uses target role/reporting/submitter scope, never actual P0';
    assert actual->'history'=preview->'history', 'Own work-schedule history preview parity';
  end loop;
end $$;
select private.reroute_pending_leave_requests_to_current_manager();
select pg_temp.set_test_actor('a1000000-0000-4000-8000-000000000004');
set local role authenticated;
do $$ declare a record; s record; begin
  select * into strict s from public.create_subscription('Synthetic legacy Admin subscription',null,'paid','monthly',100,current_date,
    'a1000000-0000-4000-8000-000000000001','{}'::uuid[]);
  assert s.subscription_id is not null, 'Admin daily subscription authority also applies to legacy public API';
  perform public.mark_subscription_reviewed(s.subscription_id,s.version);
  assert public.can_view_subscription_review_calendar(), 'Admin operational subscription calendar capability';
  assert exists(select 1 from public.list_subscription_review_calendar_entries() where subscription_id=s.subscription_id),
    'Admin subscription review calendar retains global operational scope';
  select * into strict a from public.create_it_asset('mouse','a1000000-0000-4000-8000-000000000001');
  assert a.asset_id is not null, 'Admin daily asset management uses operational helper';
  perform public.set_employee_annual_leave_balance('a1000000-0000-4000-8000-000000000001',80,current_date,false);
  perform public.set_employee_sick_leave_balance('a1000000-0000-4000-8000-000000000001',40,current_date);
  assert exists(select 1 from public.list_employee_directory_records() where person_id='a1000000-0000-4000-8000-000000000001'), 'Admin all-staff Directory';
  begin perform public.list_employee_check_in_workspace_for_preview('a1000000-0000-4000-8000-000000000004');
    raise exception 'Ordinary Admin used Change profile'; exception when insufficient_privilege then null; end;
  begin perform public.list_leave_calendar_entries_for_preview('a1000000-0000-4000-8000-000000000003');
    raise exception 'Ordinary Admin previewed calendar'; exception when insufficient_privilege then null; end;
  begin perform public.can_import_payroll_balances_for_preview('a1000000-0000-4000-8000-000000000003');
    raise exception 'Ordinary Admin previewed payroll'; exception when insufficient_privilege then null; end;
  begin perform public.list_employee_check_in_calendar_entries_for_preview('a1000000-0000-4000-8000-000000000003');
    raise exception 'Ordinary Admin previewed check-ins'; exception when insufficient_privilege then null; end;
end $$;
reset role;
select pg_temp.set_test_actor('a1000000-0000-4000-8000-000000000006');
set local role authenticated;
do $$ begin
  assert (select count(*)=8 from public.list_leave_workspace_requests() where id::text like 'a2000000%'), 'Account all-status leave including retained history';
  assert exists(select 1 from public.list_leave_workspace_requests() where employee_note='Synthetic existing employee note' and manager_note='Synthetic existing reviewer note'), 'Account existing notes are explicitly allowed';
  assert public.can_download_leave_request_attachment('a3000000-0000-4000-8000-000000000001'), 'Account evidence read';
  assert not exists(select 1 from public.list_leave_workspace_requests() where id='a2000000-0000-4000-8000-000000000001' and (can_decide or can_cancel or can_attach)), 'Stale globals cannot create Account action controls';
  assert exists(select 1 from public.list_staff_leave_calendar_entries() where id='a2000000-0000-4000-8000-000000000004' and employee_name like '%(archived)%'), 'Account retained approved calendar history';
  assert exists(select 1 from public.list_staff_leave_calendar_entries() where id='a2000000-0000-4000-8000-000000000001' and status='Pending'), 'Account pending staff calendar';
  begin perform public.decide_my_managed_leave_request('a2000000-0000-4000-8000-000000000001','Approved');
    raise exception 'Stale global Account approved leave'; exception when insufficient_privilege then null; end;
  begin perform public.cancel_my_approved_leave_request('a2000000-0000-4000-8000-000000000001');
    raise exception 'Account cancelled another owner'; exception when insufficient_privilege then null; end;
  begin perform public.prepare_my_leave_request_attachment_upload('a2000000-0000-4000-8000-000000000001','new.pdf','application/pdf',10);
    raise exception 'Account attached another owner'; exception when insufficient_privilege then null; end;
  begin perform public.delete_my_leave_request_attachment('a3000000-0000-4000-8000-000000000001');
    raise exception 'Account deleted another uploader'; exception when insufficient_privilege then null; end;
  begin perform public.submit_selected_employee_leave_request('a1000000-0000-4000-8000-000000000001','Unpaid leave',current_date+20,current_date+20,null,null,'Synthetic');
    raise exception 'Account submitted on behalf'; exception when insufficient_privilege then null; end;
  assert (select count(*)=1 from public.list_calendar_birthdays()), 'Account no global birthdays';
end $$;
reset role;
select pg_temp.set_test_actor('a1000000-0000-4000-8000-000000000002');
set local role authenticated;
do $$ begin
  assert exists(select 1 from public.list_leave_workspace_requests() where id='a2000000-0000-4000-8000-000000000001' and can_decide), 'Manager reporting-scoped decision';
  assert not exists(select 1 from public.list_leave_workspace_requests() where id='a2000000-0000-4000-8000-000000000002'), 'Manager unrelated request remains hidden';
  begin perform public.decide_my_managed_leave_request('a2000000-0000-4000-8000-000000000008','Approved');
    raise exception 'Manager self-approved'; exception when insufficient_privilege then null; end;
  begin perform public.decide_my_managed_leave_request('a2000000-0000-4000-8000-000000000002','Approved');
    raise exception 'Manager decided unrelated request'; exception when insufficient_privilege then null; end;
end $$;
reset role;
select pg_temp.set_test_actor('a1000000-0000-4000-8000-000000000009');
set local role authenticated;
do $$ declare projected jsonb; begin
  assert public.can_view_subscription_review_calendar_for_preview('a1000000-0000-4000-8000-000000000004'), 'Admin preview operational subscription calendar capability';
  assert exists(select 1 from public.list_subscription_review_calendar_entries_for_preview('a1000000-0000-4000-8000-000000000004')
    where service_name='Synthetic legacy Admin subscription'), 'Admin preview subscription calendar matches actual global scope';
  projected:=public.get_leave_workspace_for_preview('a1000000-0000-4000-8000-000000000006');
  assert not (projected->>'can_review_leave')::boolean and (projected->>'can_view_all_leave')::boolean, 'Account preview role policy, not stale globals';
  assert not exists(select 1 from jsonb_array_elements(projected->'requests') r
    where r->>'id'='a2000000-0000-4000-8000-000000000001' and ((r->>'can_decide')::boolean or (r->>'can_cancel')::boolean or (r->>'can_attach')::boolean)), 'Account preview has no other-owner actions';
  projected:=public.get_leave_workspace_for_preview('a1000000-0000-4000-8000-000000000004');
  assert (projected->>'can_review_leave')::boolean and (projected->>'can_view_all_leave')::boolean, 'Admin operational preview';
  assert exists(select 1 from jsonb_array_elements(projected->'requests') r where r->>'id'='a2000000-0000-4000-8000-000000000001' and (r->>'can_decide')::boolean), 'Admin preview decision capability';
  assert exists(select 1 from public.list_employee_check_in_workspace_for_preview('a1000000-0000-4000-8000-000000000004') where person_id='a1000000-0000-4000-8000-000000000016'), 'Admin preview global check-in scope';
  assert not exists(select 1 from public.list_employee_check_in_workspace_for_preview('a1000000-0000-4000-8000-000000000006')), 'Account preview check-ins denied';
  assert (public.get_leave_priority_workspace('a1000000-0000-4000-8000-000000000004')->>'canManageBalances')::boolean, 'Admin preview balance policy';
  assert not (public.get_leave_priority_workspace('a1000000-0000-4000-8000-000000000006')->>'canManageBalances')::boolean, 'Account preview cannot inherit real P0 balance mutation';
end $$;
reset role;
do $$ begin
  assert not private.is_current_leave_request_reviewer('a2000000-0000-4000-8000-000000000001','a1000000-0000-4000-8000-000000000006'), 'Stale reviewer assignment cannot override Account role';
  assert not private.is_current_leave_request_reviewer('a2000000-0000-4000-8000-000000000001','a1000000-0000-4000-8000-000000000008'), 'Stale reviewer assignment cannot override Employee role';
  assert not exists(select 1 from private.resolve_leave_approval_grants('a1000000-0000-4000-8000-000000000001') where reviewer_user_id in ('a1000000-0000-4000-8000-000000000006','a1000000-0000-4000-8000-000000000008')), 'Stale personal grants do not route new approvals';
  assert exists(select 1 from private.leave_approval_grants where reviewer_user_id='a1000000-0000-4000-8000-000000000006' and scope_kind='global'), 'Historical personal grants preserved';
end $$;
rollback;
\echo PASS: Admin daily business, Account leave/evidence, scoped Manager and no P0 preview inheritance
