\set ON_ERROR_STOP on
begin;
do $$ declare item record; definition text; checked integer:=0; begin
  for item in select * from (values
    ('public.approve_employee_check_in_employment_decision(uuid,bigint)'),
    ('public.archive_employee_directory_record(uuid,bigint,bigint,date,text)'),
    ('public.begin_portal_account_status_change(uuid,uuid,boolean,bigint)'),
    ('public.cancel_my_approved_leave_request(uuid)'),
    ('public.cancel_portal_account_status_change(uuid,uuid)'),
    ('public.commit_payroll_balance_import(uuid,bigint)'),
    ('public.commit_payroll_balance_import_before_comparison(uuid,bigint)'),
    ('public.complete_employee_check_in_reminder(uuid)'),
    ('public.complete_my_employee_check_in_task(uuid)'),
    ('public.complete_my_leave_request_attachment_upload(text)'),
    ('public.complete_visible_employee_check_in_reminder(uuid)'),
    ('public.create_employee_directory_record(text,text,text,text,text,text,text,uuid,text,date,date,date,text,boolean,text,text,text,text,text[],integer)'),
    ('public.create_employee_directory_record_with_address(text,text,text,text,text,text,text,uuid,text,date,date,date,text,boolean,text,text,text,text,text[],text,integer)'),
    ('public.create_employee_directory_record_with_employment_type(text,text,text,text,text,text,text,uuid,text,date,date,date,text,boolean,text,text,text,text,text[],text,text,integer)'),
    ('public.create_employee_directory_record_with_work_schedule(text,text,text,text,text,text,text,uuid,text,date,date,date,text,boolean,text,text,text,text,text[],text,text,smallint[],integer)'),
    ('public.create_employee_directory_record_with_work_schedule_times(text,text,text,text,text,text,text,uuid,text,date,date,date,text,boolean,text,text,text,text,text[],text,text,smallint[],jsonb,integer)'),
    ('public.create_internal_org_node(text,text,text,text,uuid,date,integer)'),
    ('public.create_it_asset(text,uuid,text,text,text)'),
    ('public.create_portal_account(uuid,uuid,text,text,bigint)'),
    ('public.decide_employee_work_schedule_change_request(uuid,text,text)'),
    ('public.decide_leave_with_balance(uuid,text,text)'),
    ('public.decide_my_managed_leave_request(uuid,text,text)'),
    ('public.delete_employee_directory_record(uuid,bigint)'),
    ('public.discard_my_leave_request_attachment_upload(text)'),
    ('public.enrol_employee_check_in_reminders(uuid)'),
    ('public.finalise_portal_account_status_change(uuid,uuid,uuid)'),
    ('public.prepare_my_leave_request_attachment_upload(uuid,text,text,bigint)'),
    ('public.queue_employee_check_in_catch_up(uuid)'),
    ('public.reassign_it_asset(uuid,uuid,bigint)'),
    ('public.record_employee_check_in_review(uuid,text,date,text,bigint)'),
    ('public.retire_it_asset(uuid,bigint)'),
    ('public.return_it_asset(uuid,bigint,date)'),
    ('public.review_employee_leave_accrual_day(uuid,date,numeric,numeric,numeric,numeric,text)'),
    ('public.schedule_employee_offboarding(uuid,bigint,bigint,date,text)'),
    ('public.set_employee_annual_leave_balance(uuid,numeric,date,boolean)'),
    ('public.set_employee_check_in_contract_classification(uuid,text)'),
    ('public.set_employee_leave_accrual_policy(uuid,numeric,numeric,numeric,boolean,boolean,text)'),
    ('public.set_employee_sick_leave_balance(uuid,numeric,date)'),
    ('public.set_leave_balance_required_hours(uuid,numeric)'),
    ('public.set_portal_account_enabled(uuid,uuid,boolean,bigint)'),
    ('public.submit_leave_request_once(uuid,uuid,text,date,date,time without time zone,time without time zone,text)'),
    ('public.submit_selected_employee_leave_request(uuid,text,date,date,time without time zone,time without time zone,text)'),
    ('public.update_employee_directory_address(uuid,text,bigint)'),
    ('public.update_employee_directory_record(uuid,text,text,text,text,text,text,text,uuid,text,date,date,date,text,boolean,bigint,bigint,text,text,text,text,text[],integer)'),
    ('public.update_employee_directory_record_with_address(uuid,text,text,text,text,text,text,text,uuid,text,date,date,date,text,boolean,bigint,bigint,text,text,text,text,text[],text,integer)'),
    ('public.update_employee_directory_record_with_employment_type(uuid,text,text,text,text,text,text,text,uuid,text,date,date,date,text,boolean,bigint,bigint,text,text,text,text,text[],text,text,integer)'),
    ('public.update_employee_directory_record_with_work_schedule(uuid,text,text,text,text,text,text,text,uuid,text,date,date,date,text,boolean,bigint,bigint,text,text,text,text,text[],text,text,smallint[],integer)'),
    ('public.update_employee_directory_record_with_work_schedule_times(uuid,text,text,text,text,text,text,text,uuid,text,date,date,date,text,boolean,bigint,bigint,text,text,text,text,text[],text,text,smallint[],jsonb,integer)'),
    ('public.update_internal_org_node(uuid,text,text,text,text,uuid,date,integer,boolean,bigint)'),
    ('public.update_managed_employee_directory_record(uuid,text,text,text,text,text,bigint,bigint)'),
    ('public.update_managed_employee_directory_record_for_preview(uuid,uuid,text,text,text,text,text,bigint,bigint)'),
    ('public.update_selected_employee_profile_for_hr(uuid,text,text,date,bigint)')
  ) reviewed(signature) loop
    definition:=pg_get_functiondef(item.signature::regprocedure);
    assert position(E'AS $function$\ndeclare\n  v_unified_role_fence boolean := private.lock_portal_role_actor();' in definition)>0,
      'Mutation must fence its actor before any captured authorization, target or resource: '||item.signature;
    checked:=checked+1;
  end loop;
  assert checked=52, 'Every enumerated effective operational sibling executes the role/actor fence';
  assert encode(extensions.digest(pg_get_functiondef('private.prevent_password_reset_during_account_status_change()'::regprocedure),'sha256'),'hex')
    ='94dee52b868e3fe4dd410bc09ddf4cbc4abcaf20cb39db3fd5a870f8164588ef',
    'Independent password-reset/account-status guard bytes must remain unchanged';
  assert not exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname in ('public','private') and p.prokind='f' and p.provolatile<>'v'
      and (position('private.is_portal_account_admin()' in pg_get_functiondef(p.oid))>0
        or position('private.lock_portal_role_actor()' in pg_get_functiondef(p.oid))>0)),
    'Read projections must not inherit mutation fencing';
  assert not exists(select 1 from pg_policy p where
    position('is_portal_account_admin' in coalesce(pg_get_expr(p.polqual,p.polrelid),''))>0
    or position('is_portal_account_admin' in coalesce(pg_get_expr(p.polwithcheck,p.polrelid),''))>0),
    'RLS reads must not inherit mutation fencing';
  assert not has_function_privilege('anon','private.lock_portal_role_actor()','execute');
  assert not has_function_privilege('authenticated','private.lock_portal_role_actor()','execute');
  assert not has_function_privilege('service_role','private.lock_portal_role_actor()','execute');
  assert private.confirmed_test_purge_schema_hash()=(select schema_hash from private.confirmed_test_purge_schema),
    'Only the exact reviewed fence metadata delta updates the purge catalog';
end $$;
rollback;
\echo PASS: 52 operational mutation siblings fence before snapshots/resources; reads and RLS remain unfenced; exact private ACL and purge metadata
