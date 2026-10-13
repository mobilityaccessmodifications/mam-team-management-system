begin;
set local search_path='';
lock table private.confirmed_test_identity_purges,private.confirmed_test_purge_schema in share row exclusive mode nowait;
lock table public.internal_org_people,private.employee_directory_details,private.employee_new_starter_day_one_reminders,private.employee_new_starter_day_one_events in share row exclusive mode nowait;
create temporary table day_one_splice_function_spec(signature text primary key,before_sha256 text not null,after_sha256 text not null) on commit drop;
insert into day_one_splice_function_spec values
('private.sync_new_starter_after_person_change()','88f9286ad032b1e62bdda9bb822faba73f6489dbea0c63cdaa3d19b7a970e300','f3385de926eaf08c78d25759bc948130a3410aeb0a2ee7725f044081e8699f52');
do $day_one_splice_predecessor$ begin
 if encode(extensions.digest(pg_get_functiondef('private.confirmed_test_purge_schema_hash()'::regprocedure),'sha256'),'hex') is distinct from '3385d5a0140df3995e3196ffea442b4829f9a5357de3ccf5a8d521fbe9011a54'
 or (select count(*) from private.confirmed_test_purge_schema)<>1
 or private.confirmed_test_purge_schema_hash() is distinct from (select schema_hash from private.confirmed_test_purge_schema where singleton)
 or exists(select 1 from day_one_splice_function_spec s where encode(extensions.digest(pg_get_functiondef(to_regprocedure(s.signature)),'sha256'),'hex') is distinct from s.before_sha256) then
  raise exception 'Day1 splice predecessor differs.' using errcode='55000';
 end if;
end $day_one_splice_predecessor$;
create temporary table day_one_splice_function_before on commit drop as
select pg_get_functiondef(to_regprocedure(signature)) definition from day_one_splice_function_spec;
do $day_one_splice_collector$ declare query text; anchor text; begin
 select prosrc into query from pg_proc where oid='private.confirmed_test_purge_schema_hash()'::regprocedure;
 anchor:=E'select encode(extensions.digest(coalesce(string_agg(definition,E''\\n'' order by definition),''''),''sha256''),''hex'') from (';
 if (length(query)-length(replace(query,anchor,'')))/length(anchor)<>1 then
  raise exception 'Day1 splice collector differs.' using errcode='55000';
 end if;
 execute 'create function pg_temp.day_one_splice_catalog() returns table(definition text) language sql stable set search_path='''' as '
  ||quote_literal(replace(query,anchor,'select definition from ('));
end $day_one_splice_collector$;
create temporary table day_one_splice_catalog_before on commit drop as select * from pg_temp.day_one_splice_catalog();
create function pg_temp.day_one_splice_security() returns jsonb language sql stable set search_path='' as $$
select jsonb_build_object(
 'schemas',(select jsonb_agg(to_jsonb(n) order by n.oid) from pg_namespace n where n.nspname !~ '^pg_temp_' and n.nspname !~ '^pg_toast_temp_'),
 'default_acls',(select jsonb_agg(to_jsonb(d) order by d.oid) from pg_default_acl d),
 'roles',(select jsonb_agg(to_jsonb(r) order by r.oid) from pg_roles r),
 'memberships',(select jsonb_agg(to_jsonb(m) order by m.roleid,m.member,m.grantor) from pg_auth_members m),
 'relations',(select jsonb_agg(jsonb_build_object('oid',c.oid,'owner',c.relowner,'acl',c.relacl,'rls',c.relrowsecurity,'force_rls',c.relforcerowsecurity,'options',c.reloptions) order by c.oid) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname !~ '^pg_temp_' and n.nspname !~ '^pg_toast_temp_'),
 'columns',(select jsonb_agg(to_jsonb(a) order by a.attrelid,a.attnum) from pg_attribute a join pg_class c on c.oid=a.attrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname !~ '^pg_temp_' and n.nspname !~ '^pg_toast_temp_' and not a.attisdropped and a.attnum>0),
 'policies',(select jsonb_agg(to_jsonb(p) order by p.oid) from pg_policy p join pg_class c on c.oid=p.polrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname !~ '^pg_temp_' and n.nspname !~ '^pg_toast_temp_'),
 'routines',(select jsonb_agg(case when p.oid='private.sync_new_starter_after_person_change()'::regprocedure then to_jsonb(p)-array['prosrc','prosqlbody'] else to_jsonb(p) end order by p.oid) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname !~ '^pg_temp_' and n.nspname !~ '^pg_toast_temp_'),
 'types',(select jsonb_agg(to_jsonb(t) order by t.oid) from pg_type t join pg_namespace n on n.oid=t.typnamespace where n.nspname !~ '^pg_temp_' and n.nspname !~ '^pg_toast_temp_'),
 'enums',(select jsonb_agg(to_jsonb(e) order by e.oid) from pg_enum e),
 'rewrites',(select jsonb_agg(to_jsonb(w) order by w.oid) from pg_rewrite w),
 'constraints',(select jsonb_agg(to_jsonb(k) order by k.oid) from pg_constraint k join pg_namespace n on n.oid=k.connamespace where n.nspname !~ '^pg_temp_' and n.nspname !~ '^pg_toast_temp_'),
 'defaults',(select jsonb_agg(to_jsonb(d) order by d.oid) from pg_attrdef d join pg_class c on c.oid=d.adrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname !~ '^pg_temp_' and n.nspname !~ '^pg_toast_temp_'),
 'db_role_settings',(select jsonb_agg(jsonb_build_object('row',to_jsonb(s),'arrayText',s.setconfig::text,'dimensions',array_dims(s.setconfig),'cardinality',cardinality(s.setconfig)) order by s.setdatabase,s.setrole) from pg_db_role_setting s),
 'triggers',(select jsonb_agg(to_jsonb(t) order by t.oid) from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname !~ '^pg_temp_' and n.nspname !~ '^pg_toast_temp_'),
 'indexes',(select jsonb_agg(to_jsonb(i) order by i.indexrelid) from pg_index i join pg_class c on c.oid=i.indexrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname !~ '^pg_temp_' and n.nspname !~ '^pg_toast_temp_')
);
$$;
create function pg_temp.day_one_splice_data() returns jsonb language sql stable set search_path='' as $$
select jsonb_object_agg(name,rows) from (
select 'private.annual_leave_day_accounting' name,(select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text collate "C"),'[]'::jsonb) from private.annual_leave_day_accounting t) rows
union all
select 'private.analytics_api_keys' name,(select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text collate "C"),'[]'::jsonb) from private.analytics_api_keys t) rows
union all
select 'private.annual_leave_balance_history' name,(select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text collate "C"),'[]'::jsonb) from private.annual_leave_balance_history t) rows
union all
select 'private.approved_leave_calendar_grants' name,(select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text collate "C"),'[]'::jsonb) from private.approved_leave_calendar_grants t) rows
union all
select 'private.confirmed_test_identity_purges' name,(select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text collate "C"),'[]'::jsonb) from private.confirmed_test_identity_purges t) rows
union all
select 'private.employee_annual_leave_balances' name,(select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text collate "C"),'[]'::jsonb) from private.employee_annual_leave_balances t) rows
union all
select 'private.employee_check_in_access_grants' name,(select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text collate "C"),'[]'::jsonb) from private.employee_check_in_access_grants t) rows
union all
select 'private.employee_check_in_contract_classifications' name,(select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text collate "C"),'[]'::jsonb) from private.employee_check_in_contract_classifications t) rows
union all
select 'private.employee_check_in_enrolments' name,(select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text collate "C"),'[]'::jsonb) from private.employee_check_in_enrolments t) rows
union all
select 'private.employee_check_in_reminder_events' name,(select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text collate "C"),'[]'::jsonb) from private.employee_check_in_reminder_events t) rows
union all
select 'private.employee_check_in_reminders' name,(select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text collate "C"),'[]'::jsonb) from private.employee_check_in_reminders t) rows
union all
select 'private.employee_check_in_review_notifications' name,(select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text collate "C"),'[]'::jsonb) from private.employee_check_in_review_notifications t) rows
union all
select 'private.employee_check_in_reviews' name,(select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text collate "C"),'[]'::jsonb) from private.employee_check_in_reviews t) rows
union all
select 'private.employee_directory_audit_events' name,(select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text collate "C"),'[]'::jsonb) from private.employee_directory_audit_events t) rows
union all
select 'private.employee_directory_details' name,(select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text collate "C"),'[]'::jsonb) from private.employee_directory_details t) rows
union all
select 'private.employee_identity_consolidations' name,(select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text collate "C"),'[]'::jsonb) from private.employee_identity_consolidations t) rows
union all
select 'private.employee_new_starter_day_one_events' name,(select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text collate "C"),'[]'::jsonb) from private.employee_new_starter_day_one_events t) rows
union all
select 'private.employee_new_starter_day_one_reminders' name,(select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text collate "C"),'[]'::jsonb) from private.employee_new_starter_day_one_reminders t) rows
union all
select 'private.employee_onboarding_credential_events' name,(select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text collate "C"),'[]'::jsonb) from private.employee_onboarding_credential_events t) rows
union all
select 'private.employee_onboarding_credentials' name,(select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text collate "C"),'[]'::jsonb) from private.employee_onboarding_credentials t) rows
union all
select 'private.employee_roster_external_manager_roots' name,(select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text collate "C"),'[]'::jsonb) from private.employee_roster_external_manager_roots t) rows
union all
select 'private.employee_roster_import_row_map' name,(select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text collate "C"),'[]'::jsonb) from private.employee_roster_import_row_map t) rows
union all
select 'private.employee_roster_import_runs' name,(select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text collate "C"),'[]'::jsonb) from private.employee_roster_import_runs t) rows
union all
select 'private.employee_sick_leave_balances' name,(select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text collate "C"),'[]'::jsonb) from private.employee_sick_leave_balances t) rows
union all
select 'private.employee_team_manager_defaults' name,(select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text collate "C"),'[]'::jsonb) from private.employee_team_manager_defaults t) rows
union all
select 'private.employee_work_schedule_change_events' name,(select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text collate "C"),'[]'::jsonb) from private.employee_work_schedule_change_events t) rows
union all
select 'private.employee_work_schedule_change_requests' name,(select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text collate "C"),'[]'::jsonb) from private.employee_work_schedule_change_requests t) rows
union all
select 'private.internal_org_domain_allowlist' name,(select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text collate "C"),'[]'::jsonb) from private.internal_org_domain_allowlist t) rows
union all
select 'private.internal_org_hr_allowlist' name,(select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text collate "C"),'[]'::jsonb) from private.internal_org_hr_allowlist t) rows
union all
select 'private.internal_org_member_allowlist' name,(select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text collate "C"),'[]'::jsonb) from private.internal_org_member_allowlist t) rows
union all
select 'private.it_asset_audit_events' name,(select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text collate "C"),'[]'::jsonb) from private.it_asset_audit_events t) rows
union all
select 'private.it_asset_custody_history' name,(select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text collate "C"),'[]'::jsonb) from private.it_asset_custody_history t) rows
union all
select 'private.it_assets' name,(select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text collate "C"),'[]'::jsonb) from private.it_assets t) rows
union all
select 'private.leave_accrual_calculations' name,(select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text collate "C"),'[]'::jsonb) from private.leave_accrual_calculations t) rows
union all
select 'private.leave_accrual_day_reviews' name,(select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text collate "C"),'[]'::jsonb) from private.leave_accrual_day_reviews t) rows
union all
select 'private.leave_accrual_policies' name,(select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text collate "C"),'[]'::jsonb) from private.leave_accrual_policies t) rows
union all
select 'private.leave_approval_grants' name,(select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text collate "C"),'[]'::jsonb) from private.leave_approval_grants t) rows
union all
select 'private.leave_attachment_upload_attempts' name,(select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text collate "C"),'[]'::jsonb) from private.leave_attachment_upload_attempts t) rows
union all
select 'private.leave_attachment_upload_intents' name,(select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text collate "C"),'[]'::jsonb) from private.leave_attachment_upload_intents t) rows
union all
select 'private.leave_balance_approvals' name,(select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text collate "C"),'[]'::jsonb) from private.leave_balance_approvals t) rows
union all
select 'private.leave_bank_adoption_receipts' name,(select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text collate "C"),'[]'::jsonb) from private.leave_bank_adoption_receipts t) rows
union all
select 'private.leave_bank_sources' name,(select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text collate "C"),'[]'::jsonb) from private.leave_bank_sources t) rows
union all
select 'private.leave_notification_outbox' name,(select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text collate "C"),'[]'::jsonb) from private.leave_notification_outbox t) rows
union all
select 'private.leave_payroll_calendars' name,(select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text collate "C"),'[]'::jsonb) from private.leave_payroll_calendars t) rows
union all
select 'private.leave_priority_reminder_deliveries' name,(select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text collate "C"),'[]'::jsonb) from private.leave_priority_reminder_deliveries t) rows
union all
select 'private.leave_register_read_grants' name,(select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text collate "C"),'[]'::jsonb) from private.leave_register_read_grants t) rows
union all
select 'private.leave_request_reviewer_assignments' name,(select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text collate "C"),'[]'::jsonb) from private.leave_request_reviewer_assignments t) rows
union all
select 'private.leave_submission_receipts' name,(select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text collate "C"),'[]'::jsonb) from private.leave_submission_receipts t) rows
union all
select 'private.manager_leave_reviewers' name,(select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text collate "C"),'[]'::jsonb) from private.manager_leave_reviewers t) rows
union all
select 'private.notification_delivery_control' name,(select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text collate "C"),'[]'::jsonb) from private.notification_delivery_control t) rows
union all
select 'private.notification_delivery_receipts' name,(select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text collate "C"),'[]'::jsonb) from private.notification_delivery_receipts t) rows
union all
select 'private.openclaw_leave_drafts' name,(select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text collate "C"),'[]'::jsonb) from private.openclaw_leave_drafts t) rows
union all
select 'private.openclaw_leave_receipts' name,(select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text collate "C"),'[]'::jsonb) from private.openclaw_leave_receipts t) rows
union all
select 'private.openclaw_leave_release_gate' name,(select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text collate "C"),'[]'::jsonb) from private.openclaw_leave_release_gate t) rows
union all
select 'private.openclaw_phone_identities' name,(select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text collate "C"),'[]'::jsonb) from private.openclaw_phone_identities t) rows
union all
select 'private.openclaw_phone_identity_events' name,(select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text collate "C"),'[]'::jsonb) from private.openclaw_phone_identity_events t) rows
union all
select 'private.payroll_balance_comparisons' name,(select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text collate "C"),'[]'::jsonb) from private.payroll_balance_comparisons t) rows
union all
select 'private.payroll_balance_email_recipients' name,(select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text collate "C"),'[]'::jsonb) from private.payroll_balance_email_recipients t) rows
union all
select 'private.payroll_balance_email_reminder_events' name,(select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text collate "C"),'[]'::jsonb) from private.payroll_balance_email_reminder_events t) rows
union all
select 'private.payroll_balance_email_reminders' name,(select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text collate "C"),'[]'::jsonb) from private.payroll_balance_email_reminders t) rows
union all
select 'private.payroll_balance_import_batches' name,(select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text collate "C"),'[]'::jsonb) from private.payroll_balance_import_batches t) rows
union all
select 'private.payroll_balance_import_grant_events' name,(select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text collate "C"),'[]'::jsonb) from private.payroll_balance_import_grant_events t) rows
union all
select 'private.payroll_balance_import_grants' name,(select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text collate "C"),'[]'::jsonb) from private.payroll_balance_import_grants t) rows
union all
select 'private.payroll_balance_import_stage_rows' name,(select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text collate "C"),'[]'::jsonb) from private.payroll_balance_import_stage_rows t) rows
union all
select 'private.payroll_balance_imports' name,(select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text collate "C"),'[]'::jsonb) from private.payroll_balance_imports t) rows
union all
select 'private.payroll_balance_source_archives' name,(select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text collate "C"),'[]'::jsonb) from private.payroll_balance_source_archives t) rows
union all
select 'private.payroll_carryforward_events' name,(select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text collate "C"),'[]'::jsonb) from private.payroll_carryforward_events t) rows
union all
select 'private.payroll_closing_receipts' name,(select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text collate "C"),'[]'::jsonb) from private.payroll_closing_receipts t) rows
union all
select 'private.payroll_closing_write_claims' name,(select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text collate "C"),'[]'::jsonb) from private.payroll_closing_write_claims t) rows
union all
select 'private.payroll_comparison_only_importers' name,(select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text collate "C"),'[]'::jsonb) from private.payroll_comparison_only_importers t) rows
union all
select 'private.people_hub_release_flags' name,(select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text collate "C"),'[]'::jsonb) from private.people_hub_release_flags t) rows
union all
select 'private.portal_account_admin_events' name,(select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text collate "C"),'[]'::jsonb) from private.portal_account_admin_events t) rows
union all
select 'private.portal_account_admins' name,(select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text collate "C"),'[]'::jsonb) from private.portal_account_admins t) rows
union all
select 'private.portal_account_creation_cleanup' name,(select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text collate "C"),'[]'::jsonb) from private.portal_account_creation_cleanup t) rows
union all
select 'private.portal_account_status_change_claims' name,(select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text collate "C"),'[]'::jsonb) from private.portal_account_status_change_claims t) rows
union all
select 'private.portal_account_test_sessions' name,(select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text collate "C"),'[]'::jsonb) from private.portal_account_test_sessions t) rows
union all
select 'private.portal_login_rate_limits' name,(select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text collate "C"),'[]'::jsonb) from private.portal_login_rate_limits t) rows
union all
select 'private.portal_password_reset_claims' name,(select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text collate "C"),'[]'::jsonb) from private.portal_password_reset_claims t) rows
union all
select 'private.scheduled_employee_offboarding' name,(select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text collate "C"),'[]'::jsonb) from private.scheduled_employee_offboarding t) rows
union all
select 'private.sick_leave_balance_history' name,(select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text collate "C"),'[]'::jsonb) from private.sick_leave_balance_history t) rows
union all
select 'private.subscription_audit_events' name,(select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text collate "C"),'[]'::jsonb) from private.subscription_audit_events t) rows
union all
select 'private.subscription_credential_access_audit_events' name,(select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text collate "C"),'[]'::jsonb) from private.subscription_credential_access_audit_events t) rows
union all
select 'private.subscription_credential_access_grants' name,(select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text collate "C"),'[]'::jsonb) from private.subscription_credential_access_grants t) rows
union all
select 'private.subscription_credential_audit_events' name,(select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text collate "C"),'[]'::jsonb) from private.subscription_credential_audit_events t) rows
union all
select 'private.subscription_credential_grant_changes' name,(select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text collate "C"),'[]'::jsonb) from private.subscription_credential_grant_changes t) rows
union all
select 'private.subscription_credential_vault' name,(select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text collate "C"),'[]'::jsonb) from private.subscription_credential_vault t) rows
union all
select 'private.subscription_management_grant_events' name,(select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text collate "C"),'[]'::jsonb) from private.subscription_management_grant_events t) rows
union all
select 'private.subscription_management_grants' name,(select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text collate "C"),'[]'::jsonb) from private.subscription_management_grants t) rows
union all
select 'private.subscription_memberships' name,(select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text collate "C"),'[]'::jsonb) from private.subscription_memberships t) rows
union all
select 'private.subscription_register' name,(select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text collate "C"),'[]'::jsonb) from private.subscription_register t) rows
union all
select 'private.victorian_public_holidays' name,(select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text collate "C"),'[]'::jsonb) from private.victorian_public_holidays t) rows
union all
select 'public.internal_org_people' name,(select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text collate "C"),'[]'::jsonb) from public.internal_org_people t) rows
union all
select 'public.leave_request_attachments' name,(select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text collate "C"),'[]'::jsonb) from public.leave_request_attachments t) rows
union all
select 'public.leave_request_events' name,(select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text collate "C"),'[]'::jsonb) from public.leave_request_events t) rows
union all
select 'public.leave_requests' name,(select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text collate "C"),'[]'::jsonb) from public.leave_requests t) rows
union all
select 'public.profiles' name,(select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text collate "C"),'[]'::jsonb) from public.profiles t) rows
union all
select 'public.team_memberships' name,(select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text collate "C"),'[]'::jsonb) from public.team_memberships t) rows
union all
select 'public.teams' name,(select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text collate "C"),'[]'::jsonb) from public.teams t) rows) retained;
$$;
create temporary table day_one_splice_security_before on commit drop as select pg_temp.day_one_splice_security() value;
create temporary table day_one_splice_data_before on commit drop as select pg_temp.day_one_splice_data() value;
CREATE OR REPLACE FUNCTION private.sync_new_starter_after_person_change()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare child_id uuid; reminder record;
begin
  if tg_op='UPDATE' and new.node_kind='person'
    and new.parent_id is distinct from old.parent_id
    and row(new.node_kind,new.full_name,new.position_title,new.company_key,new.started_date,new.is_active)
      is not distinct from row(old.node_kind,old.full_name,old.position_title,old.company_key,old.started_date,old.is_active) then
    select r.status,r.claim_token,r.claim_expires_at into reminder
    from private.employee_new_starter_day_one_reminders r
    where r.person_id=new.id and r.status in ('scheduled','claimed','needs_review')
    for update;
    if found and reminder.status='claimed' and reminder.claim_token is not null
      and reminder.claim_expires_at>clock_timestamp() then
      return new;
    end if;
    perform private.sync_employee_new_starter_day_one_reminder(new.id);
    return new;
  end if;
  if new.node_kind = 'person' then
    perform private.sync_employee_new_starter_day_one_reminder(new.id);
  end if;
  if new.node_kind = 'person' then
    for child_id in
      select child.id from public.internal_org_people child
      where child.node_kind='person' and child.parent_id=new.id
    loop
      perform private.sync_employee_new_starter_day_one_reminder(child_id);
    end loop;
  end if;
  return new;
end;
$function$;

create temporary table day_one_splice_catalog_added on commit drop as
select pg_get_functiondef(to_regprocedure(signature)) definition from day_one_splice_function_spec;
create function pg_temp.day_one_splice_assert_delta() returns void language plpgsql set search_path='' as $$
begin
 if exists(select 1 from day_one_splice_function_spec s where encode(extensions.digest(pg_get_functiondef(to_regprocedure(s.signature)),'sha256'),'hex') is distinct from s.after_sha256)
 or pg_temp.day_one_splice_security() is distinct from (select value from day_one_splice_security_before)
 or pg_temp.day_one_splice_data() is distinct from (select value from day_one_splice_data_before) then
  raise exception 'Day1 splice exact delta differs.' using errcode='55000';
 end if;
 if exists((select definition collate "C" from day_one_splice_catalog_before except all
  (select definition collate "C" from pg_temp.day_one_splice_catalog() except all select definition collate "C" from day_one_splice_catalog_added
   union all select definition collate "C" from day_one_splice_function_before))
 union all
 ((select definition collate "C" from pg_temp.day_one_splice_catalog() except all select definition collate "C" from day_one_splice_catalog_added
   union all select definition collate "C" from day_one_splice_function_before)
  except all select definition collate "C" from day_one_splice_catalog_before)) then
  raise exception 'Day1 splice unknown catalog drift.' using errcode='55000';
 end if;
end $$;
set constraints all immediate;
select pg_temp.day_one_splice_assert_delta();
update private.confirmed_test_purge_schema set schema_hash=private.confirmed_test_purge_schema_hash() where singleton;
create temporary table day_one_splice_catalog_after on commit drop as select private.confirmed_test_purge_schema_hash() value;
set constraints all immediate;
select pg_temp.day_one_splice_assert_delta();
do $day_one_splice_final$ begin
 if private.confirmed_test_purge_schema_hash() is distinct from (select value from day_one_splice_catalog_after)
 or (select count(*) from private.confirmed_test_purge_schema)<>1
 or (select schema_hash from private.confirmed_test_purge_schema where singleton) is distinct from (select value from day_one_splice_catalog_after) then
  raise exception 'Day1 splice final catalog differs.' using errcode='55000';
 end if;
end $day_one_splice_final$;
commit;
