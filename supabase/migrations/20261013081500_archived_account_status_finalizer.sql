begin;
set local search_path='';
lock table private.confirmed_test_identity_purges,private.confirmed_test_purge_schema in share row exclusive mode nowait;
lock table public.internal_org_people,public.profiles,private.employee_directory_details,private.employee_directory_audit_events,private.employee_onboarding_credentials,private.portal_password_reset_claims,private.scheduled_employee_offboarding in share row exclusive mode nowait;
do $archived_finalizer_predecessor$ begin
 if encode(extensions.digest(pg_get_functiondef('private.confirmed_test_purge_schema_hash()'::regprocedure),'sha256'),'hex') is distinct from '3385d5a0140df3995e3196ffea442b4829f9a5357de3ccf5a8d521fbe9011a54'
 or (select count(*) from private.confirmed_test_purge_schema)<>1
 or private.confirmed_test_purge_schema_hash() is distinct from (select schema_hash from private.confirmed_test_purge_schema where singleton)
 or encode(extensions.digest(pg_get_functiondef(to_regprocedure('private.plan_employee_removal_reporting_splice(uuid)')),'sha256'),'hex') is distinct from 'ed84b454c1f3b9bb790c569e9098a880f5228456400c67f4876e58f92d1fc292'
 or encode(extensions.digest(pg_get_functiondef(to_regprocedure('private.apply_employee_removal_reporting_splice(uuid,uuid)')),'sha256'),'hex') is distinct from 'a8f7ea1bce19f6224c08e158eb95cdb708d69b0567f79a408a7ede43687c6ee2'
 or encode(extensions.digest(pg_get_functiondef(to_regprocedure('public.archive_employee_directory_record(uuid,bigint,bigint,date,text)')),'sha256'),'hex') is distinct from '801a9f690a30f3f2842f37c1a3e7e3f24339eb7b766b5e289a4740c1fa1782df'
 or encode(extensions.digest(pg_get_functiondef(to_regprocedure('public.preflight_employee_removal_reporting_splice(uuid,bigint,bigint,date,text)')),'sha256'),'hex') is distinct from '096ef3cf33e6cd6a78dab5722e0b8f50370abbfbdba6e9f81d9c1ccb15db4dca'
 or encode(extensions.digest(pg_get_functiondef(to_regprocedure('public.run_scheduled_employee_offboarding(uuid,timestamptz)')),'sha256'),'hex') is distinct from 'a4b89c3ebeffdc4297cbeb195cd1575ec9cb07ba8ecf086c3be4ba8f21a9235f'
 or encode(extensions.digest(pg_get_functiondef(to_regprocedure('public.delete_employee_directory_record(uuid,bigint)')),'sha256'),'hex') is distinct from '8bf12b755abe5f78b4e74f856ae5a931f7156f617f576f9e54662f327a1a4a66' then
  raise exception 'Archived finalizer requires the exact reviewed predecessor.' using errcode='55000';
 end if;
end $archived_finalizer_predecessor$;
create temporary table archived_finalizer_function_spec(signature text primary key,is_existing boolean not null,before_sha256 text,after_sha256 text,new_metadata jsonb) on commit drop;
insert into archived_finalizer_function_spec values
('public.finalise_portal_account_status_change(uuid,uuid,uuid)',true,'61ba36c671f280728d474a191b3b6c24d3c578741d995af73b9d8d4929d28792','b63463e0bca9fe0d737338865e2ad0620ed089d634f55a233d0366720e4b0b3c',null);
do $archived_finalizer_functions_before$ declare item record; begin
 for item in select * from archived_finalizer_function_spec loop
  if item.is_existing then
   if encode(extensions.digest(pg_get_functiondef(to_regprocedure(item.signature)),'sha256'),'hex') is distinct from item.before_sha256 then
    raise exception 'Archived finalizer predecessor function differs: %',item.signature using errcode='55000';
   end if;
  elsif to_regprocedure(item.signature) is not null then
   raise exception 'Archived finalizer function already exists: %',item.signature using errcode='55000';
  end if;
 end loop;
end $archived_finalizer_functions_before$;
create temporary table archived_finalizer_function_before on commit drop as
select s.signature,pg_get_functiondef(p.oid) definition,
 (to_jsonb(p)-array['prosrc','prosqlbody','proargdefaults'])||jsonb_build_object('parameter_defaults',pg_get_expr(p.proargdefaults,0)) metadata
from archived_finalizer_function_spec s join pg_proc p on p.oid=to_regprocedure(s.signature) where s.is_existing;
do $archived_finalizer_collector$ declare query text; anchor text; begin
 select prosrc into query from pg_proc where oid='private.confirmed_test_purge_schema_hash()'::regprocedure;
 anchor:=E'select encode(extensions.digest(coalesce(string_agg(definition,E''\\n'' order by definition),''''),''sha256''),''hex'') from (';
 if (length(query)-length(replace(query,anchor,'')))/length(anchor)<>1 then
  raise exception 'Exact purge collector differs.' using errcode='55000';
 end if;
 execute 'create function pg_temp.archived_finalizer_catalog() returns table(definition text) language sql stable set search_path='''' as '
  ||quote_literal(replace(query,anchor,'select definition from ('));
end $archived_finalizer_collector$;
create temporary table archived_finalizer_catalog_before on commit drop as select * from pg_temp.archived_finalizer_catalog();
create temporary table archived_finalizer_catalog_hash_before on commit drop as select schema_hash value from private.confirmed_test_purge_schema where singleton;
create function pg_temp.archived_finalizer_security() returns jsonb language sql stable set search_path='' as $$
select jsonb_build_object(
 'schemas',(select jsonb_agg(to_jsonb(n) order by n.oid) from pg_namespace n where n.nspname !~ '^pg_temp_' and n.nspname !~ '^pg_toast_temp_'),
 'default_acls',(select jsonb_agg(to_jsonb(d) order by d.oid) from pg_default_acl d),
 'column_defaults',(select jsonb_agg(to_jsonb(d) order by d.oid) from pg_attrdef d join pg_class c on c.oid=d.adrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname !~ '^pg_temp_' and n.nspname !~ '^pg_toast_temp_'),
 'types',(select jsonb_agg(to_jsonb(t) order by t.oid) from pg_type t join pg_namespace n on n.oid=t.typnamespace where n.nspname !~ '^pg_temp_' and n.nspname !~ '^pg_toast_temp_'),
 'enums',(select jsonb_agg(to_jsonb(e) order by e.oid) from pg_enum e),
 'rewrites',(select jsonb_agg(to_jsonb(w) order by w.oid) from pg_rewrite w),
 'roles',(select jsonb_agg(to_jsonb(r) order by r.oid) from pg_roles r),
 'database_role_settings',(select jsonb_agg((to_jsonb(s)-'setconfig')||jsonb_build_object('configSha256',encode(extensions.digest(coalesce(s.setconfig::text,'<NULL>'),'sha256'),'hex')) order by s.setdatabase,s.setrole) from pg_db_role_setting s),
 'columns',(select jsonb_agg(to_jsonb(a) order by a.attrelid,a.attnum) from pg_attribute a join pg_class c on c.oid=a.attrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname !~ '^pg_temp_' and n.nspname !~ '^pg_toast_temp_' and not a.attisdropped and a.attnum>0),
 'relations',(select jsonb_agg(jsonb_build_object('oid',c.oid,'owner',c.relowner,'acl',c.relacl,'rls',c.relrowsecurity,'force_rls',c.relforcerowsecurity,'options',c.reloptions) order by c.oid) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname !~ '^pg_temp_' and n.nspname !~ '^pg_toast_temp_'),
 'policies',(select jsonb_agg(to_jsonb(p) order by p.oid) from pg_policy p join pg_class c on c.oid=p.polrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname !~ '^pg_temp_' and n.nspname !~ '^pg_toast_temp_'),
 'constraints',(select jsonb_agg(to_jsonb(k) order by k.oid) from pg_constraint k where not exists(select 1 from pg_namespace n where n.oid=k.connamespace and (n.nspname ~ '^pg_temp_' or n.nspname ~ '^pg_toast_temp_'))),
 'role_memberships',(select jsonb_agg(to_jsonb(m) order by m.oid) from pg_auth_members m),
 'functions',(select jsonb_agg(to_jsonb(p) order by p.oid) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname !~ '^pg_temp_' and n.nspname !~ '^pg_toast_temp_' and p.oid not in(select to_regprocedure(signature) from archived_finalizer_function_spec where to_regprocedure(signature) is not null)),
 'triggers',(select jsonb_agg(to_jsonb(t) order by t.oid) from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname !~ '^pg_temp_' and n.nspname !~ '^pg_toast_temp_'),
 'indexes',(select jsonb_agg(to_jsonb(i) order by i.indexrelid) from pg_index i join pg_class c on c.oid=i.indexrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname !~ '^pg_temp_' and n.nspname !~ '^pg_toast_temp_')
);
$$;
create temporary table archived_finalizer_security_before on commit drop as select pg_temp.archived_finalizer_security() value;
create function pg_temp.archived_finalizer_data() returns jsonb language sql stable set search_path='' as $$
select jsonb_object_agg(name,rows) from (
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
create temporary table archived_finalizer_data_before on commit drop as select pg_temp.archived_finalizer_data() value;
CREATE OR REPLACE FUNCTION public.finalise_portal_account_status_change(p_person_id uuid, p_auth_user_id uuid, p_change_token uuid)
 RETURNS TABLE(person_id uuid, auth_user_id uuid, login_name text, account_status text, account_version bigint)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_unified_role_fence boolean := private.lock_portal_role_actor();
  v_claim private.portal_account_status_change_claims;
  v_row record;
  v_target_status text;
begin
  if not private.is_portal_account_admin() then
    raise exception 'Only an account administrator can finalise an account status change.'
      using errcode = '42501';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('portal_account:' || p_auth_user_id::text, 0));

  select claim.*
  into v_claim
  from private.portal_account_status_change_claims claim
  where claim.auth_user_id = p_auth_user_id
    and claim.change_token = p_change_token
    and claim.person_id = p_person_id
    and claim.claimed_by = (select auth.uid())
  for update;

  if not found or v_claim.status = 'cancelled' then
    raise exception 'The account-status claim is no longer valid.' using errcode = '40001';
  end if;

  if v_claim.status = 'finalised' then
    return query
    select p_person_id, p_auth_user_id, profile.login_name, profile.account_status,
      coalesce(v_claim.final_account_version, profile.account_version)
    from public.profiles profile
    where profile.id = p_auth_user_id;
    return;
  end if;

  v_target_status := case when v_claim.requested_enabled then 'active' else 'disabled' end;

  select p_person_id as person_id,
    p_auth_user_id as auth_user_id,
    profile.login_name,
    profile.account_status,
    profile.account_version
  into v_row
  from public.profiles profile
  where profile.id = p_auth_user_id
    and exists (
      select 1
      from public.internal_org_people person
      where person.id = p_person_id
        and person.auth_user_id = p_auth_user_id
        and person.node_kind = 'person'
        and (
          (profile.login_name is not null
            and (person.is_active or profile.account_status = v_target_status))
          or (v_claim.status = 'pending'
            and not person.is_active
            and not v_claim.requested_enabled
            and v_claim.claimed_account_status = 'active'
            and profile.account_status = 'disabled'
            and profile.account_version = v_claim.claimed_account_version + 1
            and v_claim.provider_status = 'succeeded')
        )
    );

  if not found then
    raise exception 'The account changed or no longer exists. Reconcile the login provider before retrying.'
      using errcode = '40001';
  end if;

  if v_row.account_status <> v_target_status
    and v_row.account_version <> v_claim.claimed_account_version then
    raise exception 'The account changed or no longer exists. Reconcile the login provider before retrying.'
      using errcode = '40001';
  end if;

  if v_row.account_status <> v_target_status then
    select changed.*
    into v_row
    from public.set_portal_account_enabled(
      p_person_id,
      p_auth_user_id,
      v_claim.requested_enabled,
      v_claim.claimed_account_version
    ) changed;
  end if;

  update private.portal_account_status_change_claims claim
  set status = 'finalised',
      final_account_version = v_row.account_version,
      finalised_at = clock_timestamp()
  where claim.auth_user_id = p_auth_user_id
    and claim.change_token = p_change_token;

  return query
  select v_row.person_id,
    v_row.auth_user_id,
    v_row.login_name,
    v_row.account_status,
    v_row.account_version;
end;
$function$
;
create temporary table archived_finalizer_function_after on commit drop as
select s.signature,s.is_existing,pg_get_functiondef(p.oid) definition,
 (to_jsonb(p)-array['prosrc','prosqlbody','proargdefaults'])||jsonb_build_object('parameter_defaults',pg_get_expr(p.proargdefaults,0)) metadata,
 jsonb_build_object('owner',pg_get_userbyid(p.proowner),'acl',p.proacl::text,'security_definer',p.prosecdef,'config',p.proconfig) portable_metadata
from archived_finalizer_function_spec s join pg_proc p on p.oid=to_regprocedure(s.signature);
create temporary table archived_finalizer_catalog_added on commit drop as
 select definition from archived_finalizer_function_after
 union all select p.oid::regprocedure::text||':'||p.proowner::text||':'||coalesce(p.proacl::text,'default') from archived_finalizer_function_spec s join pg_proc p on p.oid=to_regprocedure(s.signature) where not s.is_existing;
create function pg_temp.archived_finalizer_assert_delta() returns void language plpgsql set search_path='' as $$
begin
 if (select count(*) from archived_finalizer_function_after)<>(select count(*) from archived_finalizer_function_spec)
 or exists(select 1 from archived_finalizer_function_spec s left join pg_proc p on p.oid=to_regprocedure(s.signature)
  where p.oid is null or encode(extensions.digest(pg_get_functiondef(p.oid),'sha256'),'hex') is distinct from s.after_sha256
  or (not s.is_existing and jsonb_build_object('owner',pg_get_userbyid(p.proowner),'acl',p.proacl::text,'security_definer',p.prosecdef,'config',p.proconfig) is distinct from s.new_metadata))
 or exists(select 1 from archived_finalizer_function_before b left join pg_proc p on p.oid=to_regprocedure(b.signature)
  where p.oid is null or b.metadata is distinct from ((to_jsonb(p)-array['prosrc','prosqlbody','proargdefaults'])||jsonb_build_object('parameter_defaults',pg_get_expr(p.proargdefaults,0))))
 or pg_temp.archived_finalizer_security() is distinct from (select value from archived_finalizer_security_before)
 or pg_temp.archived_finalizer_data() is distinct from (select value from archived_finalizer_data_before) then
  raise exception 'Archived finalizer differs from its exact reviewed delta.' using errcode='55000';
 end if;
 if exists((select definition collate "C" from archived_finalizer_catalog_before except all
  (select definition collate "C" from pg_temp.archived_finalizer_catalog() except all select definition collate "C" from archived_finalizer_catalog_added
   union all select definition collate "C" from archived_finalizer_function_before))
 union all
 ((select definition collate "C" from pg_temp.archived_finalizer_catalog() except all select definition collate "C" from archived_finalizer_catalog_added
   union all select definition collate "C" from archived_finalizer_function_before)
  except all select definition collate "C" from archived_finalizer_catalog_before)) then
  raise exception 'Archived finalizer includes unknown catalog drift.' using errcode='55000';
 end if;
end $$;
set constraints all immediate;
select pg_temp.archived_finalizer_assert_delta();
do $archived_finalizer_transition$ begin
 update private.confirmed_test_purge_schema set schema_hash=private.confirmed_test_purge_schema_hash()
  where singleton and schema_hash=(select value from archived_finalizer_catalog_hash_before);
 if not found then
  raise exception 'Archived finalizer predecessor fingerprint changed.' using errcode='55000';
 end if;
end $archived_finalizer_transition$;
create temporary table archived_finalizer_catalog_after on commit drop as select private.confirmed_test_purge_schema_hash() value;
set constraints all immediate;
select pg_temp.archived_finalizer_assert_delta();
do $archived_finalizer_final$ begin
 if private.confirmed_test_purge_schema_hash() is distinct from (select value from archived_finalizer_catalog_after)
 or (select count(*) from private.confirmed_test_purge_schema)<>1
 or (select schema_hash from private.confirmed_test_purge_schema where singleton) is distinct from (select value from archived_finalizer_catalog_after) then
  raise exception 'Archived finalizer final catalog differs.' using errcode='55000';
 end if;
end $archived_finalizer_final$;
commit;
