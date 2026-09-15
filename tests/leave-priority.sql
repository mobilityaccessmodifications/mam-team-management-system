-- Synthetic integration test. Run only against the isolated schema test database.
\set ON_ERROR_STOP on
do $$begin assert current_database() ~ '^priority_v[0-9]+$', 'Never run fixtures in production'; end$$;
begin;
\ir sql-test-auth.sql
insert into public.profiles(id,full_name,app_role,login_name,credentials_valid_after)
values ('10000000-0000-4000-8000-000000000001','Test Admin','system_admin','testadmin',now()-interval '1 day'),
('10000000-0000-4000-8000-000000000002','Test Manager','manager','testmanager',now()-interval '1 day'),
('10000000-0000-4000-8000-000000000003','Test Employee','employee','testemployee',now()-interval '1 day'),
('10000000-0000-4000-8000-000000000004','Test Outsider','manager','testoutsider',now()-interval '1 day');
-- Parent validation fires per row, so roots must exist before their reports.
insert into public.internal_org_people(id,full_name,company_key,position_title,auth_user_id,parent_id)
select id,full_name,'mam','Test role',id,null from public.profiles where app_role<>'employee';
insert into public.internal_org_people(id,full_name,company_key,position_title,auth_user_id,parent_id)
select id,full_name,'mam','Test role',id,'10000000-0000-4000-8000-000000000002' from public.profiles where app_role='employee';
insert into private.employee_directory_details(person_id,first_name,last_name,work_email,employment_type)
select id,'Test','Employee',login_name||'@example.test','full_time' from public.profiles;
do $$begin
  assert (select count(*)=1 from private.leave_approval_grants
    where reviewer_user_id='10000000-0000-4000-8000-000000000002'
      and scope_kind='subtree'
      and scope_root_person_id='10000000-0000-4000-8000-000000000002'
      and revoked_at is null), 'Manager fixture receives one automatic subtree approval grant';
end$$;
select pg_temp.set_test_actor('10000000-0000-4000-8000-000000000002');
do $$begin
  assert private.can_submit_team_leave('10000000-0000-4000-8000-000000000003');
  assert not private.can_submit_team_leave('10000000-0000-4000-8000-000000000004');
end$$;
select * from public.submit_selected_employee_leave_request('10000000-0000-4000-8000-000000000003','Sick leave','2026-10-09','2026-10-12',null,null,'Synthetic test');
do $$declare r public.leave_requests; plan record; begin
  select * into strict r from public.leave_requests;
  assert r.business_days=2; assert r.evidence_due_date='2026-10-19';
  assert r.submitted_by=auth.uid(); assert r.user_id<>auth.uid();
  assert private.can_add_my_leave_request_attachment(r.id);
  select * into strict plan from public.prepare_my_leave_request_attachment_upload(r.id,'proof.pdf','application/pdf',100);
  assert plan.storage_path is not null;
end$$;
select pg_temp.set_test_actor('10000000-0000-4000-8000-000000000004');
do $$declare r uuid; begin
  select id into r from public.leave_requests;
  assert not private.can_add_my_leave_request_attachment(r);
  begin
    perform public.submit_selected_employee_leave_request('10000000-0000-4000-8000-000000000003','Annual leave','2026-11-09','2026-11-10');
    raise exception 'Unauthorised submission was accepted';
  exception when insufficient_privilege then null; end;
end$$;
select pg_temp.set_test_actor('10000000-0000-4000-8000-000000000002');
select * from public.submit_selected_employee_leave_request('10000000-0000-4000-8000-000000000003','Annual leave','2026-11-09','2026-11-10');
do $$declare r uuid; begin
  select id into r from public.leave_requests where request_type_label='Annual leave';
  perform public.decide_leave_with_balance(r,'Approved – pending leave balance',null);
  assert (select status='submitted' from public.leave_requests where id=r);
  assert (select count(*)=1 from private.leave_balance_approvals where request_id=r);
  perform public.decide_leave_with_balance(r,'Approved',null);
  assert (select status='approved' from public.leave_requests where id=r);
end$$;
select pg_temp.set_test_actor('10000000-0000-4000-8000-000000000003');
do $$begin
  begin
    perform public.set_employee_annual_leave_balance('10000000-0000-4000-8000-000000000003',60,current_date,false);
    raise exception 'Employee changed a balance';
  exception when insufficient_privilege then null; end;
end$$;
select pg_temp.set_test_actor('10000000-0000-4000-8000-000000000001');
select public.set_employee_annual_leave_balance('10000000-0000-4000-8000-000000000003',60,current_date,false);
do $$begin assert (select hours=60 from private.employee_annual_leave_balances); end$$;

-- Projection isolation and normal numeric balances.
select pg_temp.set_test_actor('10000000-0000-4000-8000-000000000003');
do $$declare w jsonb; begin
  w:=public.get_leave_priority_workspace();
  assert jsonb_array_length(w->'people')=1;
  assert (w->'people'->0->>'hours')::numeric=60;
  assert (w->'people'->0->>'canViewBalance')::boolean;
  assert not (w->>'canManageBalances')::boolean;
end$$;
select pg_temp.set_test_actor('10000000-0000-4000-8000-000000000002');
do $$declare w jsonb; p text; begin
  w:=public.get_leave_priority_workspace();
  assert jsonb_array_length(w->'people')=2;
  assert not (w->>'canManageBalances')::boolean;
  assert (select count(*)=2 from jsonb_array_elements(w->'people') e where (e->>'canViewBalance')::boolean);
  assert (select (e->>'paidLeave')::boolean from jsonb_array_elements(w->'people') e
    where e->>'personId'='10000000-0000-4000-8000-000000000003'), 'Delegated form retains eligible request categories and scoped balance data';
  assert (select (e->>'hours')::numeric=60 and e->>'asOf' is not null and (e->>'canSubmit')::boolean
    from jsonb_array_elements(w->'people') e where e->>'personId'='10000000-0000-4000-8000-000000000003');
  begin
    perform public.set_employee_annual_leave_balance('10000000-0000-4000-8000-000000000003',10,current_date,false);
    raise exception 'Manager changed a balance';
  exception when insufficient_privilege then null; end;
  select storage_path into p from private.leave_attachment_upload_intents limit 1;
  insert into storage.objects(bucket_id,name,metadata) values('leave-evidence',p,'{"size":100,"mimetype":"application/pdf"}');
  perform public.complete_my_leave_request_attachment_upload(p);
  assert (select count(*)=1 from public.leave_request_attachments);
  assert (select can_delete from public.list_leave_workspace_attachments() limit 1),
    'Original uploader receives the attachment delete capability';
end$$;
select pg_temp.set_test_actor('10000000-0000-4000-8000-000000000004');
do $$declare a uuid; begin
  select id into a from public.leave_request_attachments limit 1;
  begin
    perform public.delete_my_leave_request_attachment(a);
    raise exception 'A non-uploader deleted another account''s supporting file';
  exception when insufficient_privilege then null; end;
  assert (select count(*)=1 from public.leave_request_attachments),
    'Rejected deletion retains attachment metadata';
end$$;
select pg_temp.set_test_actor('10000000-0000-4000-8000-000000000002');
do $$declare a uuid; removed_path text; begin
  select id into a from public.leave_request_attachments limit 1;
  select deleted.storage_path into strict removed_path
  from public.delete_my_leave_request_attachment(a) deleted;
  assert removed_path ~ '^[0-9a-f-]{36}/[0-9a-f-]{36}\.pdf$',
    'Uploader deletion returns only the opaque server cleanup path';
  assert (select count(*)=0 from public.leave_request_attachments),
    'Uploader deletion removes attachment metadata';
  assert (select count(*)=1 from public.leave_request_events
    where event_type='updated' and note='Supporting file removed.'),
    'Uploader deletion records a path-free audit event';
  assert not has_function_privilege('anon','public.delete_my_leave_request_attachment(uuid)','EXECUTE');
end$$;
select pg_temp.set_test_actor('10000000-0000-4000-8000-000000000001');
do $$declare w jsonb; begin
  w:=public.get_leave_priority_workspace();
  assert (w->>'canManageBalances')::boolean;
  assert (select count(*)=4 from jsonb_array_elements(w->'people') e where (e->>'canViewBalance')::boolean);
  w:=public.get_leave_priority_workspace('10000000-0000-4000-8000-000000000002');
  assert (w->>'canManageBalances')::boolean;
  assert (select count(*)=2 from jsonb_array_elements(w->'people') e where (e->>'canViewBalance')::boolean);
  assert (select (e->>'hours')::numeric=60 and e->>'asOf' is not null
    from jsonb_array_elements(w->'people') e where e->>'personId'='10000000-0000-4000-8000-000000000003');
  w:=public.get_leave_priority_workspace('10000000-0000-4000-8000-000000000003');
  assert jsonb_array_length(w->'people')=1;
end$$;
-- No network calls: a claim only returns the server-resolved synthetic recipient.
-- A missed approval remains actionable even after the leave dates have passed.
update public.leave_requests set submitted_at=now()-interval '8 days',
  start_date=(now() at time zone 'Australia/Melbourne')::date-4,
  end_date=(now() at time zone 'Australia/Melbourne')::date-3 where status='submitted';
update private.employee_directory_details set date_of_birth=(now() at time zone 'Australia/Melbourne')::date+1-interval '30 years'
where person_id='10000000-0000-4000-8000-000000000003';
do $$declare r record; n integer:=0; begin
  if extract(isodow from (now() at time zone 'Australia/Melbourne'))<=5 then
    for r in select * from public.claim_leave_priority_reminders(100) loop
      assert r.manager_email='testmanager@example.test';
      assert not public.complete_leave_priority_reminder(r.delivery_id,gen_random_uuid());
      assert public.complete_leave_priority_reminder(r.delivery_id,r.claim_token);
      n:=n+1;
    end loop;
    assert n=2;
    assert (select count(*)=0 from public.claim_leave_priority_reminders(100));
  end if;
  assert not has_function_privilege('authenticated','public.claim_leave_priority_reminders(integer)','EXECUTE');
  assert not has_function_privilege('anon','public.get_leave_priority_workspace(uuid)','EXECUTE');
end$$;
rollback;
