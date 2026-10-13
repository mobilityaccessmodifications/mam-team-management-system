begin;
set local search_path='';
lock table private.confirmed_test_identity_purges,private.confirmed_test_purge_schema in share row exclusive mode nowait;
lock table public.internal_org_people,public.profiles,private.employee_directory_details,private.employee_directory_audit_events,private.employee_onboarding_credentials,private.portal_password_reset_claims,private.scheduled_employee_offboarding in share row exclusive mode nowait;
do $reporting_splice_predecessor$ begin
 if encode(extensions.digest(pg_get_functiondef('private.confirmed_test_purge_schema_hash()'::regprocedure),'sha256'),'hex') is distinct from '3385d5a0140df3995e3196ffea442b4829f9a5357de3ccf5a8d521fbe9011a54'
 or (select count(*) from private.confirmed_test_purge_schema)<>1
 or private.confirmed_test_purge_schema_hash() is distinct from (select schema_hash from private.confirmed_test_purge_schema where singleton)
 or not exists(select 1 from pg_attribute where attrelid='private.employee_directory_details'::regclass and attname='trade_school_enabled' and atttypid='boolean'::regtype and attnotnull and not attisdropped)
 or to_regprocedure('private.enforce_trade_school_leave()') is null then
  raise exception 'Reporting splice requires the exact reviewed predecessor.' using errcode='55000';
 end if;
end $reporting_splice_predecessor$;
create temporary table reporting_splice_function_spec(signature text primary key,is_existing boolean not null,before_sha256 text,after_sha256 text,new_metadata jsonb) on commit drop;
insert into reporting_splice_function_spec values
('private.plan_employee_removal_reporting_splice(uuid)',false,null,'ed84b454c1f3b9bb790c569e9098a880f5228456400c67f4876e58f92d1fc292','{"acl": "{postgres=X/postgres}", "owner": "postgres", "config": ["search_path=\"\""], "security_definer": true}'::jsonb),
('private.apply_employee_removal_reporting_splice(uuid,uuid)',false,null,'a8f7ea1bce19f6224c08e158eb95cdb708d69b0567f79a408a7ede43687c6ee2','{"acl": "{postgres=X/postgres}", "owner": "postgres", "config": ["search_path=\"\""], "security_definer": true}'::jsonb),
('public.archive_employee_directory_record(uuid,bigint,bigint,date,text)',true,'9fbb4e10f6b99ebdcc6d773efdfadeea42b2b546687c32a73fdbb8ed42673fc8','801a9f690a30f3f2842f37c1a3e7e3f24339eb7b766b5e289a4740c1fa1782df',null),
('public.preflight_employee_removal_reporting_splice(uuid,bigint,bigint,date,text)',false,null,'096ef3cf33e6cd6a78dab5722e0b8f50370abbfbdba6e9f81d9c1ccb15db4dca','{"acl": "{postgres=X/postgres,authenticated=X/postgres}", "owner": "postgres", "config": ["search_path=\"\""], "security_definer": true}'::jsonb),
('public.run_scheduled_employee_offboarding(uuid,timestamptz)',true,'0f3861f5253241454432fd6f2f7529187810d7ef7b58bd101700960548b9e8ab','a4b89c3ebeffdc4297cbeb195cd1575ec9cb07ba8ecf086c3be4ba8f21a9235f',null),
('public.delete_employee_directory_record(uuid,bigint)',true,'b67bce74091067f4f8e85b97f0f360e9bc7ebfb2722a031b7bb709a3ce169f8a','8bf12b755abe5f78b4e74f856ae5a931f7156f617f576f9e54662f327a1a4a66',null);
do $reporting_splice_functions_before$ declare item record; begin
 for item in select * from reporting_splice_function_spec loop
  if item.is_existing then
   if encode(extensions.digest(pg_get_functiondef(to_regprocedure(item.signature)),'sha256'),'hex') is distinct from item.before_sha256 then
    raise exception 'Reporting splice predecessor function differs: %',item.signature using errcode='55000';
   end if;
  elsif to_regprocedure(item.signature) is not null then
   raise exception 'Reporting splice function already exists: %',item.signature using errcode='55000';
  end if;
 end loop;
end $reporting_splice_functions_before$;
create temporary table reporting_splice_function_before on commit drop as
select s.signature,pg_get_functiondef(p.oid) definition,
 (to_jsonb(p)-array['prosrc','prosqlbody','proargdefaults'])||jsonb_build_object('parameter_defaults',pg_get_expr(p.proargdefaults,0)) metadata
from reporting_splice_function_spec s join pg_proc p on p.oid=to_regprocedure(s.signature) where s.is_existing;
do $reporting_splice_collector$ declare query text; anchor text; begin
 select prosrc into query from pg_proc where oid='private.confirmed_test_purge_schema_hash()'::regprocedure;
 anchor:=E'select encode(extensions.digest(coalesce(string_agg(definition,E''\\n'' order by definition),''''),''sha256''),''hex'') from (';
 if (length(query)-length(replace(query,anchor,'')))/length(anchor)<>1 then
  raise exception 'Trade-school collector differs.' using errcode='55000';
 end if;
 execute 'create function pg_temp.reporting_splice_catalog() returns table(definition text) language sql stable set search_path='''' as '
  ||quote_literal(replace(query,anchor,'select definition from ('));
end $reporting_splice_collector$;
create temporary table reporting_splice_catalog_before on commit drop as select * from pg_temp.reporting_splice_catalog();
create temporary table reporting_splice_catalog_hash_before on commit drop as select schema_hash value from private.confirmed_test_purge_schema where singleton;
create function pg_temp.reporting_splice_security() returns jsonb language sql stable set search_path='' as $$
select jsonb_build_object(
 'schemas',(select jsonb_agg(to_jsonb(n) order by n.oid) from pg_namespace n where n.nspname !~ '^pg_temp_' and n.nspname !~ '^pg_toast_temp_'),
 'default_acls',(select jsonb_agg(to_jsonb(d) order by d.oid) from pg_default_acl d),
 'column_defaults',(select jsonb_agg(to_jsonb(d) order by d.oid) from pg_attrdef d join pg_class c on c.oid=d.adrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname !~ '^pg_temp_' and n.nspname !~ '^pg_toast_temp_'),
 'types',(select jsonb_agg(to_jsonb(t) order by t.oid) from pg_type t join pg_namespace n on n.oid=t.typnamespace where n.nspname !~ '^pg_temp_' and n.nspname !~ '^pg_toast_temp_'),
 'enums',(select jsonb_agg(to_jsonb(e) order by e.oid) from pg_enum e),
 'rewrites',(select jsonb_agg(to_jsonb(w) order by w.oid) from pg_rewrite w),
 'roles',(select jsonb_agg(to_jsonb(r) order by r.oid) from pg_roles r),
 'columns',(select jsonb_agg(to_jsonb(a) order by a.attrelid,a.attnum) from pg_attribute a join pg_class c on c.oid=a.attrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname !~ '^pg_temp_' and n.nspname !~ '^pg_toast_temp_' and not a.attisdropped and a.attnum>0),
 'relations',(select jsonb_agg(jsonb_build_object('oid',c.oid,'owner',c.relowner,'acl',c.relacl,'rls',c.relrowsecurity,'force_rls',c.relforcerowsecurity,'options',c.reloptions) order by c.oid) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname !~ '^pg_temp_' and n.nspname !~ '^pg_toast_temp_'),
 'policies',(select jsonb_agg(to_jsonb(p) order by p.oid) from pg_policy p join pg_class c on c.oid=p.polrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname !~ '^pg_temp_' and n.nspname !~ '^pg_toast_temp_'),
 'constraints',(select jsonb_agg(to_jsonb(k) order by k.oid) from pg_constraint k where not exists(select 1 from pg_namespace n where n.oid=k.connamespace and (n.nspname ~ '^pg_temp_' or n.nspname ~ '^pg_toast_temp_'))),
 'role_memberships',(select jsonb_agg(to_jsonb(m) order by m.oid) from pg_auth_members m),
 'functions',(select jsonb_agg(to_jsonb(p) order by p.oid) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname !~ '^pg_temp_' and n.nspname !~ '^pg_toast_temp_' and p.oid not in(select to_regprocedure(signature) from reporting_splice_function_spec where to_regprocedure(signature) is not null)),
 'triggers',(select jsonb_agg(to_jsonb(t) order by t.oid) from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname !~ '^pg_temp_' and n.nspname !~ '^pg_toast_temp_'),
 'indexes',(select jsonb_agg(to_jsonb(i) order by i.indexrelid) from pg_index i join pg_class c on c.oid=i.indexrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname !~ '^pg_temp_' and n.nspname !~ '^pg_toast_temp_')
);
$$;
create temporary table reporting_splice_security_before on commit drop as select pg_temp.reporting_splice_security() value;
create function pg_temp.reporting_splice_data() returns jsonb language sql stable set search_path='' as $$
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
create temporary table reporting_splice_data_before on commit drop as select pg_temp.reporting_splice_data() value;
create function private.plan_employee_removal_reporting_splice(p_person_id uuid)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare
 v_target public.internal_org_people%rowtype;
 v_node public.internal_org_people%rowtype;
 v_next uuid; v_successor uuid; v_ancestors uuid[]; v_children uuid[]; v_users uuid[];
 v_first jsonb; v_plan jsonb; v_id uuid; v_pass integer;
begin
 if p_person_id is null then
  raise exception 'The employee record is invalid.' using errcode='22023';
 end if;
 if not pg_try_advisory_xact_lock(hashtextextended('internal_org_people_hierarchy',0)) then
  raise exception 'Reporting hierarchy changed. Refresh and try again.' using errcode='40001';
 end if;
 for v_pass in 1..2 loop
  select * into v_target from public.internal_org_people where id=p_person_id and node_kind='person';
  if not found then
   raise exception 'The employee record no longer exists.' using errcode='23503';
  end if;
  select coalesce(array_agg(id order by id),'{}'::uuid[]) into v_children
   from public.internal_org_people where parent_id=p_person_id;
  v_ancestors:='{}'::uuid[]; v_successor:=null; v_next:=v_target.parent_id;
  while v_next is not null loop
   if v_next=p_person_id or v_next=any(v_ancestors) or v_next=any(v_children) or cardinality(v_ancestors)>=10000 then
    raise exception 'Reporting hierarchy is invalid.' using errcode='55000';
   end if;
   select * into v_node from public.internal_org_people where id=v_next;
   if not found or v_node.node_kind not in ('person','org_unit','vacancy') or v_node.is_active is null then
    raise exception 'Reporting hierarchy is invalid.' using errcode='55000';
   end if;
   v_ancestors:=array_append(v_ancestors,v_node.id);
   if v_successor is null and v_node.is_active then v_successor:=v_node.id; end if;
   v_next:=v_node.parent_id;
  end loop;
  v_plan:=jsonb_build_object('target_id',p_person_id,'parent_id',v_target.parent_id,
   'successor_id',v_successor,'ancestor_ids',v_ancestors,'child_ids',v_children);
  if v_pass=1 then
   v_first:=v_plan;
   select coalesce(array_agg(distinct auth_user_id order by auth_user_id),'{}'::uuid[]) into v_users
    from public.internal_org_people where id=any(array[p_person_id]||v_children) and auth_user_id is not null;
   foreach v_id in array v_users loop
    if not pg_try_advisory_xact_lock(hashtextextended('portal_account:'||v_id::text,0)) then
     raise exception 'Onboarding credential delivery in progress' using errcode='55000';
    end if;
   end loop;
   begin
    perform c.id from private.employee_onboarding_credentials c
     where c.person_id=any(array[p_person_id]||v_children) or c.auth_user_id=any(v_users)
     order by c.id for update nowait;
    perform r.auth_user_id from private.portal_password_reset_claims r
     where r.person_id=any(array[p_person_id]||v_children) or r.auth_user_id=any(v_users)
     order by r.auth_user_id for update nowait;
    perform p.id from public.profiles p where p.id=any(v_users) order by p.id for share nowait;
    perform p.id from public.internal_org_people p
     where p.id=any(array[p_person_id]||v_children||v_ancestors) order by p.id for update nowait;
   exception when lock_not_available then
    raise exception 'Onboarding credential delivery in progress' using errcode='55000';
   end;
  elsif v_plan is distinct from v_first then
   raise exception 'Reporting hierarchy changed. Refresh and try again.' using errcode='40001';
  end if;
 end loop;
 if exists(select 1 from private.employee_onboarding_credentials c
  where (c.person_id=any(array[p_person_id]||v_children) or c.auth_user_id=any(v_users))
   and (c.status in ('claimed','sending') or (c.status='needs_review' and c.claimed_login is not null))) then
  raise exception 'Onboarding credential delivery in progress' using errcode='55000';
 end if;
 if exists(select 1 from private.portal_password_reset_claims r
  where (r.person_id=any(array[p_person_id]||v_children) or r.auth_user_id=any(v_users)) and r.status='pending') then
  raise exception 'A password reset is already in progress. Refresh and try again.' using errcode='40001';
 end if;
 if exists(select 1 from public.profiles p where p.id=any(v_users) and p.app_role='system_admin')
  and not private.is_system_portal_account_admin() then
  raise exception 'System Admin account access denied.' using errcode='42501';
 end if;
 return v_plan;
end $$;
revoke all on function private.plan_employee_removal_reporting_splice(uuid) from public,anon,authenticated,service_role;
create function private.apply_employee_removal_reporting_splice(p_person_id uuid,p_actor_user_id uuid)
returns void language plpgsql volatile security definer set search_path='' as $$
declare v_plan jsonb; v_child uuid; v_successor uuid;
begin
 v_plan:=private.plan_employee_removal_reporting_splice(p_person_id);
 v_successor:=(v_plan->>'successor_id')::uuid;
 for v_child in select value::uuid from jsonb_array_elements_text(v_plan->'child_ids') order by value::uuid loop
  update public.internal_org_people set parent_id=v_successor,updated_by=p_actor_user_id
   where id=v_child and parent_id=p_person_id;
  if not found then
   raise exception 'Reporting hierarchy changed. Refresh and try again.' using errcode='40001';
  end if;
  insert into private.employee_directory_audit_events(person_id,actor_user_id,event_type,changed_fields)
   values(v_child,p_actor_user_id,'updated',array['manager_id']::text[]);
 end loop;
end $$;
revoke all on function private.apply_employee_removal_reporting_splice(uuid,uuid) from public,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION public.archive_employee_directory_record(p_person_id uuid, p_expected_person_version bigint, p_expected_detail_version bigint, p_end_date date, p_archive_reason text)
 RETURNS TABLE(person_id uuid, person_version bigint, detail_version bigint)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_unified_role_fence boolean := private.lock_portal_role_actor();
  v_actor uuid := (select auth.uid());
  v_person public.internal_org_people%rowtype;
  v_detail private.employee_directory_details%rowtype;
  v_profile public.profiles%rowtype;
  v_reason text := nullif(btrim(p_archive_reason), '');
  v_profile_before jsonb;
  v_profile_version bigint;
  v_updated_person public.internal_org_people%rowtype;
  v_updated_detail private.employee_directory_details%rowtype;
begin
  if not private.can_view_archived_employee_profiles() then
    raise exception 'Only authorised HR and global reviewers can archive employee profiles.'
      using errcode = '42501';
  end if;

  if p_person_id is null or p_expected_person_version is null or p_expected_person_version < 1
    or p_expected_detail_version is null or p_expected_detail_version < 0 then
    raise exception 'The employee record is invalid.' using errcode = '22023';
  end if;

  if p_end_date is null then
    raise exception 'Choose an employment end date.' using errcode = '22004';
  end if;

  if v_reason is null or v_reason not in ('Resigned', 'End of contract', 'Terminated', 'Redundant', 'Other') then
    raise exception 'Choose an archive reason.' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('internal_org_people_hierarchy', 0));

  select person.* into v_person
  from public.internal_org_people person
  where person.id = p_person_id
    and person.node_kind = 'person'
  for update;

  if not found then
    raise exception 'The employee record no longer exists.' using errcode = '23503';
  end if;

  if v_person.version <> p_expected_person_version then
    raise exception 'This employee changed since it was opened. Refresh and try again.' using errcode = '40001';
  end if;

  if v_person.started_date is not null and p_end_date < v_person.started_date then
    raise exception 'The end date cannot be before the start date.' using errcode = '22023';
  end if;

  select detail.* into v_detail
  from private.employee_directory_details detail
  where detail.person_id = p_person_id
  for update;

  if not found then
    raise exception 'The employee detail does not exist.' using errcode = '23503';
  end if;

  if v_detail.version <> p_expected_detail_version then
    raise exception 'This employee detail changed since it was opened. Refresh and try again.' using errcode = '40001';
  end if;

  perform private.apply_employee_removal_reporting_splice(p_person_id,v_actor);

  if v_person.auth_user_id is not null then
    select profile.* into v_profile
    from public.profiles profile
    where profile.id = v_person.auth_user_id
    for update;

    if found and v_profile.account_status = 'active' then
      if v_person.auth_user_id = v_actor then
        raise exception 'You cannot end employment and disable your own portal account.'
          using errcode = '42501';
      end if;

      if (
        exists (
          select 1
          from private.portal_account_admins administrator
          where administrator.auth_user_id = v_person.auth_user_id
            and administrator.revoked_at is null
        )
        or v_profile.app_role = 'system_admin'
      )
      and not exists (
        select 1
        from public.profiles other_profile
        where other_profile.id <> v_person.auth_user_id
          and other_profile.account_status = 'active'
          and other_profile.login_name is not null
          and (
            other_profile.app_role = 'system_admin'
            or exists (
              select 1
              from private.portal_account_admins other_administrator
              where other_administrator.auth_user_id = other_profile.id
                and other_administrator.revoked_at is null
            )
          )
      ) then
        raise exception 'The last active account administrator cannot be disabled.'
          using errcode = '42501';
      end if;

      v_profile_before := jsonb_build_object(
        'account_status', v_profile.account_status,
        'account_version', v_profile.account_version
      );

      update public.profiles profile
      set account_status = 'disabled',
          disabled_at = clock_timestamp(),
          credentials_valid_after = clock_timestamp(),
          account_version = profile.account_version + 1,
          updated_at = clock_timestamp()
      where profile.id = v_person.auth_user_id
        and profile.account_version = v_profile.account_version
      returning profile.account_version into v_profile_version;

      if not found then
        raise exception 'The portal account changed. Refresh and try again.'
          using errcode = '40001';
      end if;

      insert into private.portal_account_admin_events (
        actor_user_id,
        target_user_id,
        event_type,
        before_state,
        after_state
      )
      values (
        v_actor,
        v_person.auth_user_id,
        'account_disabled',
        v_profile_before,
        jsonb_build_object(
          'account_status', 'disabled',
          'account_version', v_profile_version
        )
      );
    end if;
  end if;

  update public.internal_org_people person
  set is_active = false,
      updated_by = v_actor
  where person.id = p_person_id
  returning * into v_updated_person;

  update private.employee_directory_details detail
  set scheduled_employment_end_date = p_end_date,
      archive_reason = v_reason,
      updated_by = v_actor
  where detail.person_id = p_person_id
  returning * into v_updated_detail;

  insert into private.employee_directory_audit_events (
    person_id,
    actor_user_id,
    event_type,
    changed_fields
  )
  values (
    p_person_id,
    v_actor,
    'updated',
    array['is_active', 'scheduled_employment_end_date']::text[]
  );

  return query select v_updated_person.id, v_updated_person.version, v_updated_detail.version;
end;
$function$
;

create function public.preflight_employee_removal_reporting_splice(
 p_person_id uuid,p_expected_person_version bigint,p_expected_detail_version bigint,p_end_date date,p_archive_reason text)
returns boolean language plpgsql volatile security definer set search_path='' as $$
declare
 v_unified_role_fence boolean:=private.lock_portal_role_actor();
 v_actor uuid:=(select auth.uid());
 v_person public.internal_org_people%rowtype;
 v_detail private.employee_directory_details%rowtype;
 v_profile public.profiles%rowtype;
 v_reason text:=nullif(btrim(p_archive_reason),'');
begin
 if v_actor is null or (select auth.role())='service_role' or not private.can_view_archived_employee_profiles() then
  raise exception 'Only authorised administrators can archive employee profiles.' using errcode='42501';
 end if;
 if p_person_id is null or p_expected_person_version is null or p_expected_person_version<1
  or p_expected_detail_version is null or p_expected_detail_version<0 then
  raise exception 'The employee record is invalid.' using errcode='22023';
 end if;
 if p_end_date is null then
  raise exception 'Choose an employment end date.' using errcode='22004';
 end if;
 if v_reason is null or v_reason not in ('Resigned','End of contract','Terminated','Redundant','Other') then
  raise exception 'Choose an archive reason.' using errcode='22023';
 end if;
 if not pg_try_advisory_xact_lock(hashtextextended('internal_org_people_hierarchy',0)) then
  raise exception 'Reporting hierarchy changed. Refresh and try again.' using errcode='40001';
 end if;
 select * into v_person from public.internal_org_people where id=p_person_id and node_kind='person' for update nowait;
 if not found or not v_person.is_active then
  raise exception 'The employee record no longer exists.' using errcode='23503';
 end if;
 if v_person.version<>p_expected_person_version then
  raise exception 'This employee changed since it was opened. Refresh and try again.' using errcode='40001';
 end if;
 if v_person.started_date is not null and p_end_date<v_person.started_date then
  raise exception 'The end date cannot be before the start date.' using errcode='22023';
 end if;
 select * into v_detail from private.employee_directory_details where person_id=p_person_id for share nowait;
 if not found then
  raise exception 'The employee detail does not exist.' using errcode='23503';
 end if;
 if v_detail.version<>p_expected_detail_version then
  raise exception 'This employee detail changed since it was opened. Refresh and try again.' using errcode='40001';
 end if;
 if v_person.auth_user_id=v_actor then
  raise exception 'You cannot end employment and disable your own portal account.' using errcode='42501';
 end if;
 perform private.plan_employee_removal_reporting_splice(p_person_id);
 if v_person.auth_user_id is not null then
  select * into v_profile from public.profiles where id=v_person.auth_user_id;
  if not found then
   raise exception 'The portal account changed. Refresh and try again.' using errcode='40001';
  end if;
  if v_profile.account_status='active'
   and (v_profile.app_role='system_admin' or exists(select 1 from private.portal_account_admins where auth_user_id=v_profile.id and revoked_at is null))
   and not exists(select 1 from public.profiles other where other.id<>v_profile.id and other.account_status='active' and other.login_name is not null
    and (other.app_role='system_admin' or exists(select 1 from private.portal_account_admins admin where admin.auth_user_id=other.id and admin.revoked_at is null))) then
   raise exception 'The last active account administrator cannot be disabled.' using errcode='42501';
  end if;
 end if;
 if exists(select 1 from private.it_assets where assigned_person_id=p_person_id and asset_status='assigned') then
  raise exception 'Record the return of this employee''s active IT devices before ending employment.' using errcode='23514';
 end if;
 return true;
exception when lock_not_available then
 raise exception 'Onboarding credential delivery in progress' using errcode='55000';
end $$;
revoke all on function public.preflight_employee_removal_reporting_splice(uuid,bigint,bigint,date,text) from public,anon,authenticated,service_role;
grant execute on function public.preflight_employee_removal_reporting_splice(uuid,bigint,bigint,date,text) to authenticated;

CREATE OR REPLACE FUNCTION public.run_scheduled_employee_offboarding(p_person_id uuid, p_now timestamp with time zone DEFAULT clock_timestamp())
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_person public.internal_org_people%rowtype;
  v_schedule private.scheduled_employee_offboarding%rowtype;
  v_profile public.profiles%rowtype;
  v_version bigint;
begin
  if (select auth.role()) is distinct from 'service_role' and session_user not in ('service_role','postgres') then
    raise exception 'Service role required.' using errcode='42501';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('mam:directory-role-control', 0));
  perform pg_advisory_xact_lock(hashtextextended('internal_org_people_hierarchy', 0));
  select * into v_person from public.internal_org_people where id=p_person_id and node_kind='person' for update;
  select * into v_schedule from private.scheduled_employee_offboarding where person_id=p_person_id for update;
  if v_person.id is null or not v_person.is_active or v_schedule.person_id is null
    or v_schedule.end_date >= (p_now at time zone 'Australia/Melbourne')::date then
    return false;
  end if;
  if exists(select 1 from private.it_assets where assigned_person_id=p_person_id and asset_status <> 'retired') then
    raise exception 'Reassign active IT devices before ending employment.' using errcode='23514';
  end if;
  perform private.apply_employee_removal_reporting_splice(p_person_id,v_schedule.scheduled_by);
  if v_person.auth_user_id is not null then
    select * into v_profile from public.profiles where id=v_person.auth_user_id for update;
    if v_profile.id is not null and v_profile.account_status='active' then
      if (v_profile.app_role='system_admin' or exists(select 1 from private.portal_account_admins where auth_user_id=v_profile.id and revoked_at is null))
        and not exists(select 1 from public.profiles other where other.id<>v_profile.id and other.account_status='active' and other.login_name is not null
          and (other.app_role='system_admin' or exists(select 1 from private.portal_account_admins admin where admin.auth_user_id=other.id and admin.revoked_at is null))) then
        raise exception 'The last active account administrator cannot be disabled.' using errcode='42501';
      end if;
      update public.profiles set account_status='disabled',disabled_at=clock_timestamp(),credentials_valid_after=clock_timestamp(),
        account_version=account_version+1,updated_at=clock_timestamp() where id=v_profile.id returning account_version into v_version;
      insert into private.portal_account_admin_events(actor_user_id,target_user_id,event_type,before_state,after_state)
      values(v_schedule.scheduled_by,v_profile.id,'account_disabled',
        jsonb_build_object('account_status',v_profile.account_status,'account_version',v_profile.account_version),
        jsonb_build_object('account_status','disabled','account_version',v_version));
    end if;
  end if;
  update public.internal_org_people set is_active=false,updated_by=v_schedule.scheduled_by where id=p_person_id;
  update private.employee_directory_details set archive_reason=v_schedule.reason,updated_by=v_schedule.scheduled_by where person_id=p_person_id;
  insert into private.employee_directory_audit_events(person_id,actor_user_id,event_type,changed_fields)
  values(p_person_id,v_schedule.scheduled_by,'updated',array['is_active','scheduled_employment_end_date']::text[]);
  return true;
end $function$
;

CREATE OR REPLACE FUNCTION public.delete_employee_directory_record(p_person_id uuid, p_expected_person_version bigint)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_unified_role_fence boolean := private.lock_portal_role_actor();
  v_person public.internal_org_people%rowtype;
  v_has_roster_link boolean := false;
begin
  if not public.can_delete_employee_directory_profile() then
    raise exception 'Only authorised HR, Super Admin, Steven or Penny can delete archived employee profiles.'
      using errcode = '42501';
  end if;

  if p_person_id is null or p_expected_person_version is null or p_expected_person_version < 1 then
    raise exception 'The employee record is invalid.' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('internal_org_people_hierarchy', 0));

  select person.* into v_person
  from public.internal_org_people person
  where person.id = p_person_id
    and person.node_kind = 'person'
  for update;

  if not found then
    raise exception 'The employee record no longer exists.' using errcode = '23503';
  end if;

  if v_person.version <> p_expected_person_version then
    raise exception 'This employee changed since it was opened. Refresh and try again.' using errcode = '40001';
  end if;

  if v_person.is_active then
    raise exception 'Archive the employee before deleting the profile.' using errcode = '23503';
  end if;

  if v_person.auth_user_id is not null then
    raise exception 'Unlink the portal account before deleting the profile.' using errcode = '23503';
  end if;


  if to_regclass('private.employee_check_in_reminders') is not null
    and exists (select 1 from private.employee_check_in_reminders reminder where reminder.person_id = p_person_id) then
    raise exception 'This profile has check-in history. Keep it archived instead.' using errcode = '23503';
  end if;

  if to_regclass('private.employee_check_in_enrolments') is not null
    and exists (select 1 from private.employee_check_in_enrolments enrolment where enrolment.person_id = p_person_id) then
    raise exception 'This profile has check-in history. Keep it archived instead.' using errcode = '23503';
  end if;

  if to_regclass('private.employee_roster_person_links') is not null then
    execute 'select exists (select 1 from private.employee_roster_person_links where person_id = $1)'
      into v_has_roster_link using p_person_id;
    if v_has_roster_link then
      raise exception 'This profile is part of the authoritative roster. Keep it archived instead.' using errcode = '23503';
    end if;
  end if;

  begin
    perform private.apply_employee_removal_reporting_splice(p_person_id,(select auth.uid()));
    delete from public.internal_org_people person where person.id = p_person_id;
  exception
    when foreign_key_violation then
      raise exception 'This profile is referenced by existing records. Keep it archived instead.' using errcode = '23503';
  end;

  return p_person_id;
end;
$function$
;

create temporary table reporting_splice_function_after on commit drop as
select s.signature,s.is_existing,pg_get_functiondef(p.oid) definition,
 (to_jsonb(p)-array['prosrc','prosqlbody','proargdefaults'])||jsonb_build_object('parameter_defaults',pg_get_expr(p.proargdefaults,0)) metadata,
 jsonb_build_object('owner',pg_get_userbyid(p.proowner),'acl',p.proacl::text,'security_definer',p.prosecdef,'config',p.proconfig) portable_metadata
from reporting_splice_function_spec s join pg_proc p on p.oid=to_regprocedure(s.signature);
create temporary table reporting_splice_catalog_added on commit drop as
 select definition from reporting_splice_function_after
 union all select p.oid::regprocedure::text||':'||p.proowner::text||':'||coalesce(p.proacl::text,'default') from reporting_splice_function_spec s join pg_proc p on p.oid=to_regprocedure(s.signature) where not s.is_existing;
create function pg_temp.reporting_splice_assert_delta() returns void language plpgsql set search_path='' as $$
begin
 if (select count(*) from reporting_splice_function_after)<>(select count(*) from reporting_splice_function_spec)
 or exists(select 1 from reporting_splice_function_spec s left join pg_proc p on p.oid=to_regprocedure(s.signature)
  where p.oid is null or encode(extensions.digest(pg_get_functiondef(p.oid),'sha256'),'hex') is distinct from s.after_sha256
  or (not s.is_existing and jsonb_build_object('owner',pg_get_userbyid(p.proowner),'acl',p.proacl::text,'security_definer',p.prosecdef,'config',p.proconfig) is distinct from s.new_metadata))
 or exists(select 1 from reporting_splice_function_before b left join pg_proc p on p.oid=to_regprocedure(b.signature)
  where p.oid is null or b.metadata is distinct from ((to_jsonb(p)-array['prosrc','prosqlbody','proargdefaults'])||jsonb_build_object('parameter_defaults',pg_get_expr(p.proargdefaults,0))))
 or pg_temp.reporting_splice_security() is distinct from (select value from reporting_splice_security_before)
 or pg_temp.reporting_splice_data() is distinct from (select value from reporting_splice_data_before) then
  raise exception 'Reporting splice differs from its exact reviewed delta.' using errcode='55000';
 end if;
 if exists((select definition collate "C" from reporting_splice_catalog_before except all
  (select definition collate "C" from pg_temp.reporting_splice_catalog() except all select definition collate "C" from reporting_splice_catalog_added
   union all select definition collate "C" from reporting_splice_function_before))
 union all
 ((select definition collate "C" from pg_temp.reporting_splice_catalog() except all select definition collate "C" from reporting_splice_catalog_added
   union all select definition collate "C" from reporting_splice_function_before)
  except all select definition collate "C" from reporting_splice_catalog_before)) then
  raise exception 'Reporting splice includes unknown catalog drift.' using errcode='55000';
 end if;
end $$;
set constraints all immediate;
select pg_temp.reporting_splice_assert_delta();
do $reporting_splice_transition$ begin
 update private.confirmed_test_purge_schema set schema_hash=private.confirmed_test_purge_schema_hash()
  where singleton and schema_hash=(select value from reporting_splice_catalog_hash_before);
 if not found then
  raise exception 'Reporting splice predecessor fingerprint changed.' using errcode='55000';
 end if;
end $reporting_splice_transition$;
create temporary table reporting_splice_catalog_after on commit drop as select private.confirmed_test_purge_schema_hash() value;
set constraints all immediate;
select pg_temp.reporting_splice_assert_delta();
do $reporting_splice_final$ begin
 if private.confirmed_test_purge_schema_hash() is distinct from (select value from reporting_splice_catalog_after)
 or (select count(*) from private.confirmed_test_purge_schema)<>1
 or (select schema_hash from private.confirmed_test_purge_schema where singleton) is distinct from (select value from reporting_splice_catalog_after) then
  raise exception 'Reporting splice final catalog differs.' using errcode='55000';
 end if;
end $reporting_splice_final$;
commit;
