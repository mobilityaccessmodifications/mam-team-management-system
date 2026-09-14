-- Run against a disposable synthetic priority fixture database with current migrations.
\set ON_ERROR_STOP on
do $$begin assert current_database() ~ '^priority_v[0-9]+$', 'Synthetic database only';end$$;
begin;
\ir sql-test-auth.sql
insert into public.profiles(id,full_name,app_role,login_name,credentials_valid_after) values
('10000000-0000-4000-8000-000000000001','Reviewer One','system_admin','reviewer1',now()-interval '1 day'),
('10000000-0000-4000-8000-000000000002','Reviewer Two','system_admin','reviewer2',now()-interval '1 day'),
('10000000-0000-4000-8000-000000000003','Reviewer HR','system_admin','reviewer3',now()-interval '1 day'),
('10000000-0000-4000-8000-000000000004','Manager Applicant','manager','applicant',now()-interval '1 day'),
('10000000-0000-4000-8000-000000000005','Parent Manager','manager','parent',now()-interval '1 day'),
('10000000-0000-4000-8000-000000000006','Employee Applicant','employee','employee',now()-interval '1 day');
-- Parent validation fires per row, so build this two-level reporting chain top down.
insert into public.internal_org_people(id,full_name,company_key,position_title,auth_user_id,parent_id)
select id,full_name,'mam','Synthetic role',id,null
from public.profiles where login_name not in ('applicant','employee');
insert into public.internal_org_people(id,full_name,company_key,position_title,auth_user_id,parent_id)
select id,full_name,'mam','Synthetic role',id,'10000000-0000-4000-8000-000000000005'
from public.profiles where login_name='applicant';
insert into public.internal_org_people(id,full_name,company_key,position_title,auth_user_id,parent_id)
select id,full_name,'mam','Synthetic role',id,'10000000-0000-4000-8000-000000000004'
from public.profiles where login_name='employee';
insert into private.employee_directory_details(person_id,employment_type,work_email)
select id,'full_time',login_name||'@example.test' from public.profiles;
insert into private.leave_approval_grants(reviewer_user_id,scope_kind,scope_root_person_id,reviewer_label,priority)
select id,case when app_role='system_admin' then 'global' else 'subtree' end,
 case when app_role='manager' then id end,full_name,case when app_role='manager' then 10 else 100 end
from public.profiles p where app_role in ('manager','system_admin')
  and not exists(select 1 from private.leave_approval_grants g where g.reviewer_user_id=p.id and g.revoked_at is null);
insert into private.manager_leave_reviewers select id,row_number() over(order by id) from public.profiles where app_role='system_admin';
select pg_temp.set_test_actor('10000000-0000-4000-8000-000000000001');
create temp table submitted as select id from public.submit_selected_employee_leave_request('10000000-0000-4000-8000-000000000004','Annual leave','2030-12-09','2030-12-13');
do $$declare r uuid:=(select id from submitted); reviewer record; recipients text;begin
 assert (select count(*)=3 from private.leave_request_reviewer_assignments where leave_request_id=r),'All group accounts assigned';
 assert not private.is_current_leave_request_reviewer(r,'10000000-0000-4000-8000-000000000005'),'Reporting manager excluded';
 assert not private.is_current_leave_request_reviewer(r,'10000000-0000-4000-8000-000000000004'),'Applicant excluded';
 select manager_email into recipients from public.resolve_leave_notification_manager(r);
 assert recipients='reviewer1@example.test,reviewer2@example.test,reviewer3@example.test','All group email addresses';
 for reviewer in select reviewer_user_id from private.manager_leave_reviewers loop
  assert private.is_current_leave_request_reviewer(r,reviewer.reviewer_user_id);
  perform pg_temp.set_test_actor(reviewer.reviewer_user_id);
  assert private.can_review_leave_request(r),'Reviewer account can open approval';
  -- Each real decision function must succeed, then rollback just that decision.
  begin
   perform public.decide_leave_with_balance(r,'Approved',null);
   assert (select status='approved' and decided_by=reviewer.reviewer_user_id from public.leave_requests where id=r);
   raise exception 'rollback synthetic decision' using errcode='P0004';
  exception when assert_failure then
   if sqlerrm <> 'rollback synthetic decision' then raise;end if;
  end;
 end loop;
 perform pg_temp.set_test_actor('10000000-0000-4000-8000-000000000004');
 begin
  perform public.decide_leave_with_balance(r,'Approved',null);
  raise exception 'Self approval succeeded';
 exception when insufficient_privilege then null;end;
 perform pg_temp.set_test_actor('10000000-0000-4000-8000-000000000005');
 begin
  perform public.decide_leave_with_balance(r,'Approved',null);
  raise exception 'Former reporting manager approved';
 exception when insufficient_privilege then null;end;
 assert private.valid_leave_email_recipients(recipients);
 assert not private.valid_leave_email_recipients('a@example.test,broken');
 assert not private.valid_leave_email_recipients(E'a@example.test,\r\nb@example.test');
 assert not has_table_privilege('authenticated','private.manager_leave_reviewers','SELECT');
end$$;
-- The outbox freezes the entire reviewer group, not just the primary label.
create temp table group_claim as select * from public.claim_leave_notification_outbox((select id from submitted),50);
do $$begin
 assert (select payload->>'managerEmail'='reviewer1@example.test,reviewer2@example.test,reviewer3@example.test' from group_claim);
end$$;
-- Simulate a pre-existing pending snapshot, then migrate it to the group.
delete from private.leave_request_reviewer_assignments where leave_request_id in(select id from submitted);
insert into private.leave_request_reviewer_assignments(leave_request_id,reviewer_user_id,source_grant_id,assignment_kind,reviewer_label,is_primary)
select r.id,g.reviewer_user_id,g.id,g.scope_kind,g.reviewer_label,true from submitted r
cross join private.leave_approval_grants g where g.reviewer_user_id='10000000-0000-4000-8000-000000000005';
select private.reroute_pending_leave_requests_to_current_manager();
do $$begin assert (select count(*)=3 from private.leave_request_reviewer_assignments where leave_request_id in(select id from submitted));end$$;
select pg_temp.set_test_actor('10000000-0000-4000-8000-000000000001');
create temp table ordinary as select id from public.submit_selected_employee_leave_request('10000000-0000-4000-8000-000000000006','Annual leave','2031-12-08','2031-12-12');
do $$begin
 assert (select manager_email='applicant@example.test' from public.resolve_leave_notification_manager((select id from ordinary))),'Employee goes to nearest manager';
 assert private.is_current_leave_request_reviewer((select id from ordinary),'10000000-0000-4000-8000-000000000004');
end$$;
-- Promotion reroutes an existing employee request immediately.
update public.profiles set app_role='manager' where id='10000000-0000-4000-8000-000000000006';
do $$begin
 assert (select manager_email='reviewer1@example.test,reviewer2@example.test,reviewer3@example.test' from public.resolve_leave_notification_manager((select id from ordinary)));
end$$;
-- Demotion below a still-active parent restores the employee reporting route.
update public.profiles set app_role='employee' where id='10000000-0000-4000-8000-000000000006';
do $$begin
 assert (select manager_email='applicant@example.test' from public.resolve_leave_notification_manager((select id from ordinary)));
end$$;
-- Demoting the top reporting manager leaves an explicit global fallback.
update public.profiles set app_role='employee' where id='10000000-0000-4000-8000-000000000005';
update public.profiles set app_role='employee' where id='10000000-0000-4000-8000-000000000004';
do $$begin
 assert not private.is_current_leave_request_reviewer((select id from ordinary),'10000000-0000-4000-8000-000000000004');
 assert (select manager_email like 'reviewer%@example.test' from public.resolve_leave_notification_manager((select id from ordinary)));
 assert (select assignment_kind='global' from private.leave_request_reviewer_assignments where leave_request_id=(select id from ordinary) and is_primary);
end$$;
-- Restore manager ownership for the group revocation check.
update public.profiles set app_role='manager' where id='10000000-0000-4000-8000-000000000004';
-- Removing and restoring a configured reviewer refreshes pending assignments.
delete from private.manager_leave_reviewers where reviewer_user_id='10000000-0000-4000-8000-000000000002';
do $$begin assert (select count(*)=2 from private.leave_request_reviewer_assignments where leave_request_id in(select id from submitted));end$$;
insert into private.manager_leave_reviewers values('10000000-0000-4000-8000-000000000002',2);
do $$begin assert (select count(*)=3 from private.leave_request_reviewer_assignments where leave_request_id in(select id from submitted));end$$;
update public.profiles set account_status='disabled',disabled_at=now() where id='10000000-0000-4000-8000-000000000002';
do $$begin assert not private.is_current_leave_request_reviewer((select id from submitted),'10000000-0000-4000-8000-000000000002');end$$;
update public.profiles set account_status='active',disabled_at=null where id='10000000-0000-4000-8000-000000000002';
do $$begin assert private.is_current_leave_request_reviewer((select id from submitted),'10000000-0000-4000-8000-000000000002');end$$;
update public.internal_org_people set is_active=false where id='10000000-0000-4000-8000-000000000004';
update public.internal_org_people set is_active=true where id='10000000-0000-4000-8000-000000000004';
-- An inactive or revoked reviewer loses approval and delivery authority.
update private.leave_approval_grants set revoked_at=now(),revoked_by='10000000-0000-4000-8000-000000000001' where reviewer_user_id='10000000-0000-4000-8000-000000000002';
do $$begin
 assert not private.is_current_leave_request_reviewer((select id from submitted),'10000000-0000-4000-8000-000000000002');
 assert (select manager_email='reviewer1@example.test,reviewer3@example.test' from public.resolve_leave_notification_manager((select id from submitted)));
end$$;
rollback;
