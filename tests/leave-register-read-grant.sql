-- Full-schema, synthetic access-control regression for a view-only Leave register grant.
\set ON_ERROR_STOP on
begin;
set local statement_timeout = '10s';
\ir sql-test-auth.sql
insert into auth.users(id,email,email_confirmed_at) values
('90000000-0000-4000-8000-000000000001','viewer@example.test',now()),
('90000000-0000-4000-8000-000000000002','owner@example.test',now()),
('90000000-0000-4000-8000-000000000003','peer@example.test',now()),
('90000000-0000-4000-8000-000000000005','admin@example.test',now());
insert into public.profiles(id,full_name,app_role,login_name,credentials_valid_after) values
('90000000-0000-4000-8000-000000000001','Synthetic Viewer','employee','viewer',now()-interval '1 day'),
('90000000-0000-4000-8000-000000000002','Synthetic Owner','employee','owner',now()-interval '1 day'),
('90000000-0000-4000-8000-000000000003','Synthetic Peer','employee','peer',now()-interval '1 day'),
('90000000-0000-4000-8000-000000000005','Synthetic Admin','system_admin','admin',now()-interval '1 day');
insert into public.internal_org_people(id,full_name,company_key,position_title,auth_user_id) values
('90000000-0000-4000-8000-000000000001','Synthetic Viewer','mam','Synthetic role','90000000-0000-4000-8000-000000000001'),
('90000000-0000-4000-8000-000000000002','Synthetic Owner','equipsy','Synthetic role','90000000-0000-4000-8000-000000000002'),
('90000000-0000-4000-8000-000000000003','Synthetic Peer','mam','Synthetic role','90000000-0000-4000-8000-000000000003'),
('90000000-0000-4000-8000-000000000005','Synthetic Admin','mam','Synthetic role','90000000-0000-4000-8000-000000000005');
insert into private.employee_directory_details(person_id,employment_type,work_email,first_name,last_name,team_name)
select id,'full_time',login_name||'@example.test','Synthetic','Person','MAM admin' from public.profiles where login_name in ('viewer','owner','peer');
insert into private.leave_approval_grants(reviewer_user_id,scope_kind,reviewer_label,priority)
values ('90000000-0000-4000-8000-000000000005','global','Synthetic Admin',100);
select pg_temp.set_test_actor('90000000-0000-4000-8000-000000000002');
create temp table read_grant_request as select id from public.submit_my_leave_request('Unpaid leave','2030-12-09','2030-12-13');
insert into public.leave_request_attachments(id,leave_request_id,uploaded_by,storage_path,file_name,mime_type,size_bytes)
select '90000000-0000-4000-8000-000000000004',id,'90000000-0000-4000-8000-000000000002',id::text||'/90000000-0000-4000-8000-000000000004.pdf','fixture.pdf','application/pdf',123 from read_grant_request;
select pg_temp.set_test_actor('90000000-0000-4000-8000-000000000001');
set local role authenticated;
do $$ begin
  assert (select count(*)=0 from public.list_leave_workspace_requests()), 'Ungrant viewer has no peer requests';
  assert (select count(*)=0 from public.list_leave_workspace_attachments()), 'Ungrant viewer has no evidence metadata';
  assert not public.can_download_leave_request_attachment('90000000-0000-4000-8000-000000000004'), 'Ungrant viewer cannot download';
end $$;
reset role;
with candidates as materialized (
  select person.id, profile.app_role='employee' as eligible
  from public.internal_org_people person
  join public.profiles profile on profile.id=person.auth_user_id
  where person.full_name='Synthetic Viewer' and person.node_kind='person'
    and person.is_active and profile.account_status='active'
    and profile.login_name is not null
), sole as (
  select (array_agg(id))[1] as id from candidates
  having count(*)=1 and bool_and(eligible)
)
insert into private.leave_register_read_grants(person_id)
select id from sole;
select pg_temp.set_test_actor('90000000-0000-4000-8000-000000000001');
set local role authenticated;
do $$ begin
  assert (select count(*)=1 from public.list_leave_workspace_requests() where status='Pending' and can_decide=false and can_cancel=false and can_attach=false and employee_note is null), 'Viewer receives all-company pending record without actions';
  assert (select count(*)=1 from public.list_leave_workspace_attachments() where file_name='fixture.pdf' and can_delete=false), 'Viewer can inspect evidence metadata without deletion';
  assert public.can_download_leave_request_attachment('90000000-0000-4000-8000-000000000004'), 'Viewer can download authorised evidence';
  assert public.can_view_all_leave_requests(), 'Viewer has explicit all-staff read capability';
  assert not public.can_review_leave_workspace(), 'Viewing is not reviewer authority';
  assert not has_table_privilege('authenticated','private.leave_register_read_grants','SELECT'), 'Grant table stays private';
  begin
    perform public.decide_my_managed_leave_request((select id from read_grant_request), 'Approved');
    raise exception 'Viewer unexpectedly decided a pending leave request';
  exception when insufficient_privilege then
    null;
  end;
end $$;
reset role;
update public.leave_requests set status='approved' where id=(select id from read_grant_request);
set local role authenticated;
do $$ begin
  assert (select count(*)=1 from public.list_leave_workspace_requests() where status='Approved'), 'Viewer sees approved records too';
end $$;
reset role;
update public.profiles set account_status='disabled', disabled_at=now() where login_name='viewer';
set local role authenticated;
do $$ begin
  assert not public.can_view_all_leave_requests(), 'Disabled viewer loses capability';
end $$;
reset role;
update public.profiles set account_status='active', disabled_at=null where login_name='viewer';
delete from private.leave_register_read_grants where person_id='90000000-0000-4000-8000-000000000001';
set local role authenticated;
do $$ begin
  assert (select count(*)=0 from public.list_leave_workspace_requests()), 'Revoked viewer loses peer records';
  assert not public.can_download_leave_request_attachment('90000000-0000-4000-8000-000000000004'), 'Revoked viewer loses evidence access';
end $$;
reset role;
select pg_temp.set_test_actor('90000000-0000-4000-8000-000000000003');
set local role authenticated;
do $$ begin
  assert (select count(*)=0 from public.list_leave_workspace_requests()), 'Ordinary peer remains private';
end $$;
reset role;
rollback;
