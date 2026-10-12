begin;
set local search_path='';
lock table private.confirmed_test_identity_purges,private.confirmed_test_purge_schema in share row exclusive mode nowait;
lock table private.employee_directory_details,private.employee_directory_audit_events,public.leave_requests in access exclusive mode nowait;
do $trade_school_predecessor$ begin
 if encode(extensions.digest(pg_get_functiondef('private.confirmed_test_purge_schema_hash()'::regprocedure),'sha256'),'hex') is distinct from '3385d5a0140df3995e3196ffea442b4829f9a5357de3ccf5a8d521fbe9011a54'
 or (select count(*) from private.confirmed_test_purge_schema)<>1
 or private.confirmed_test_purge_schema_hash() is distinct from (select schema_hash from private.confirmed_test_purge_schema where singleton)
 or exists(select 1 from pg_attribute where attrelid='private.employee_directory_details'::regclass and attname='trade_school_enabled' and not attisdropped) then
  raise exception 'Trade-school leave requires the exact reviewed predecessor.' using errcode='55000';
 end if;
end $trade_school_predecessor$;
create temporary table trade_school_function_spec(signature text primary key,is_existing boolean not null,before_sha256 text,after_sha256 text,new_metadata jsonb) on commit drop;
insert into trade_school_function_spec values
('public.list_trade_school_leave_entitlements(uuid)',false,null,'90811f3ed6329ced70b5bf2ff98f18a11f3d65e83dc2104d882afdc3dd0bd3e0','{"owner": "postgres", "acl": "{postgres=X/postgres,authenticated=X/postgres}", "security_definer": true, "config": ["search_path=\"\""]}'::jsonb),
('public.submit_my_leave_request(text,date,date,time,time,text)',true,'f356cac9b4720d4a05c715867fc8a64b216c121adc4c900353e869f40b9ca915','a6b1db5ea5381168236c61073024a43218a10acd7e2984102e342514b9524388',null),
('private.enforce_leave_request_employment_policy()',true,'54c4408e259a91245bdc81e3ab3c5057b0d52bb4212035a2d2ae51b2500aaf76','6535b99e6244c42999825fd79262d29623e109f7af701810dcf4b6b410ff9819',null),
('public.submit_selected_employee_leave_request(uuid,text,date,date,time,time,text)',true,'0d4c6c27b4148950c14fb1e83c23f197ced06fb128502ce345dde75289467c07','88ab7b8f4969290e0a3f95ee50459bc92c14e2c0c70ddbec36156b4ca4569b74',null),
('private.enforce_trade_school_leave()',false,null,'36f22fcce454ec88a5ddf9b0d026b632966722e56a68cff212203414d8b9034b','{"owner": "postgres", "acl": "{postgres=X/postgres}", "security_definer": true, "config": ["search_path=\"\""]}'::jsonb);
create temporary table trade_school_constraint_spec(name text primary key,before_definition text,after_definition text) on commit drop;
insert into trade_school_constraint_spec values
('leave_requests_pay_treatment_check','CHECK (((pay_treatment IS NULL) OR (pay_treatment = ANY (ARRAY[''paid_entitlement''::text, ''unpaid''::text]))))','CHECK (((pay_treatment IS NULL) OR (pay_treatment = ANY (ARRAY[''paid_entitlement''::text, ''unpaid''::text, ''paid_other''::text]))))'),
('leave_requests_request_type_label_check','CHECK ((request_type_label = ANY (ARRAY[''Annual leave''::text, ''Sick leave''::text, ''Carer''''s leave''::text, ''Unpaid leave''::text, ''Other leave''::text])))','CHECK ((request_type_label = ANY (ARRAY[''Annual leave''::text, ''Sick leave''::text, ''Carer''''s leave''::text, ''Unpaid leave''::text, ''Other leave''::text, ''trade school''::text])))'),
('leave_requests_trade_school_classification_check',null,'CHECK ((((request_type_label = ''trade school''::text) AND (leave_type = ''other''::text) AND (NOT (pay_treatment IS DISTINCT FROM ''paid_other''::text))) OR ((request_type_label <> ''trade school''::text) AND (pay_treatment IS DISTINCT FROM ''paid_other''::text))))'),
('employee_directory_audit_events_changed_fields_check','CHECK ((changed_fields <@ ARRAY[''first_name''::text, ''last_name''::text, ''work_email''::text, ''personal_email''::text, ''phone''::text, ''position_title''::text, ''team_name''::text, ''manager_id''::text, ''country''::text, ''address''::text, ''date_of_birth''::text, ''started_date''::text, ''scheduled_employment_end_date''::text, ''company_key''::text, ''is_active''::text, ''sort_order''::text, ''laptop_supplied''::text, ''laptop_id''::text, ''mouse_id''::text, ''keyboard_id''::text, ''asset_tags''::text, ''employment_type''::text, ''working_weekdays''::text, ''working_day_times''::text, ''app_role''::text]))','CHECK ((changed_fields <@ ARRAY[''first_name''::text, ''last_name''::text, ''work_email''::text, ''personal_email''::text, ''phone''::text, ''position_title''::text, ''team_name''::text, ''manager_id''::text, ''country''::text, ''address''::text, ''date_of_birth''::text, ''started_date''::text, ''scheduled_employment_end_date''::text, ''company_key''::text, ''is_active''::text, ''sort_order''::text, ''laptop_supplied''::text, ''laptop_id''::text, ''mouse_id''::text, ''keyboard_id''::text, ''asset_tags''::text, ''employment_type''::text, ''working_weekdays''::text, ''working_day_times''::text, ''app_role''::text, ''trade_school_enabled''::text]))');
do $trade_school_functions_before$ declare item record; begin
 for item in select * from trade_school_function_spec loop
  if item.is_existing then
   if encode(extensions.digest(pg_get_functiondef(to_regprocedure(item.signature)),'sha256'),'hex') is distinct from item.before_sha256 then
    raise exception 'Trade-school predecessor function differs: %',item.signature using errcode='55000';
   end if;
  elsif to_regprocedure(item.signature) is not null then
   raise exception 'Trade-school function already exists: %',item.signature using errcode='55000';
  end if;
 end loop;
 if exists(select 1 from trade_school_constraint_spec s left join pg_constraint k on k.conrelid=case when s.name='employee_directory_audit_events_changed_fields_check' then 'private.employee_directory_audit_events'::regclass else 'public.leave_requests'::regclass end and k.conname=s.name
  where (s.before_definition is null and k.oid is not null) or (s.before_definition is not null and pg_get_constraintdef(k.oid) is distinct from s.before_definition)) then
  raise exception 'Trade-school predecessor constraint differs.' using errcode='55000';
 end if;
end $trade_school_functions_before$;
create temporary table trade_school_function_before on commit drop as
select s.signature,pg_get_functiondef(p.oid) definition,
 (to_jsonb(p)-array['prosrc','prosqlbody','proargdefaults'])||jsonb_build_object('parameter_defaults',pg_get_expr(p.proargdefaults,0)) metadata
from trade_school_function_spec s join pg_proc p on p.oid=to_regprocedure(s.signature) where s.is_existing;
do $trade_school_collector$ declare query text; anchor text; begin
 select prosrc into query from pg_proc where oid='private.confirmed_test_purge_schema_hash()'::regprocedure;
 anchor:=E'select encode(extensions.digest(coalesce(string_agg(definition,E''\\n'' order by definition),''''),''sha256''),''hex'') from (';
 if (length(query)-length(replace(query,anchor,'')))/length(anchor)<>1 then
  raise exception 'Trade-school collector differs.' using errcode='55000';
 end if;
 execute 'create function pg_temp.trade_school_catalog() returns table(definition text) language sql stable set search_path='''' as '
  ||quote_literal(replace(query,anchor,'select definition from ('));
end $trade_school_collector$;
create temporary table trade_school_catalog_before on commit drop as select * from pg_temp.trade_school_catalog();
create function pg_temp.trade_school_security() returns jsonb language sql stable set search_path='' as $$
select jsonb_build_object(
 'schemas',(select jsonb_agg(to_jsonb(n) order by n.oid) from pg_namespace n where n.nspname !~ '^pg_temp_' and n.nspname !~ '^pg_toast_temp_'),
 'default_acls',(select jsonb_agg(to_jsonb(d) order by d.oid) from pg_default_acl d),
 'column_defaults',(select jsonb_agg(to_jsonb(d) order by d.oid) from pg_attrdef d join pg_class c on c.oid=d.adrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname !~ '^pg_temp_' and n.nspname !~ '^pg_toast_temp_' and not(c.oid='private.employee_directory_details'::regclass and d.adnum=coalesce((select attnum from pg_attribute where attrelid=c.oid and attname='trade_school_enabled' and not attisdropped),0))),
 'types',(select jsonb_agg(to_jsonb(t) order by t.oid) from pg_type t join pg_namespace n on n.oid=t.typnamespace where n.nspname !~ '^pg_temp_' and n.nspname !~ '^pg_toast_temp_'),
 'enums',(select jsonb_agg(to_jsonb(e) order by e.oid) from pg_enum e),
 'rewrites',(select jsonb_agg(to_jsonb(w) order by w.oid) from pg_rewrite w),
 'roles',(select jsonb_agg(to_jsonb(r) order by r.oid) from pg_roles r),
 'columns',(select jsonb_agg(to_jsonb(a) order by a.attrelid,a.attnum) from pg_attribute a join pg_class c on c.oid=a.attrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname in ('public','private','auth','storage') and not a.attisdropped and a.attnum>0 and not(a.attrelid='private.employee_directory_details'::regclass and a.attname='trade_school_enabled')),
 'relations',(select jsonb_agg(jsonb_build_object('oid',c.oid,'owner',c.relowner,'acl',c.relacl,'rls',c.relrowsecurity,'force_rls',c.relforcerowsecurity,'options',c.reloptions) order by c.oid) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname in ('public','private','auth','storage')),
 'constraints',(select jsonb_agg(to_jsonb(k) order by k.oid) from pg_constraint k where not exists(select 1 from pg_namespace n where n.oid=k.connamespace and (n.nspname ~ '^pg_temp_' or n.nspname ~ '^pg_toast_temp_')) and not(k.conrelid=case when k.conname='employee_directory_audit_events_changed_fields_check' then 'private.employee_directory_audit_events'::regclass else 'public.leave_requests'::regclass end and k.conname in(select name from trade_school_constraint_spec))),
 'indexes',(select jsonb_agg(to_jsonb(i) order by i.indexrelid) from pg_index i join pg_class c on c.oid=i.indexrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname !~ '^pg_temp_' and n.nspname !~ '^pg_toast_temp_')
);
$$;
create temporary table trade_school_security_before on commit drop as select pg_temp.trade_school_security() value;
create function pg_temp.trade_school_data() returns jsonb language sql stable set search_path='' as $$
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
select 'private.employee_directory_details' name,(select coalesce(jsonb_agg(to_jsonb(t)-'trade_school_enabled' order by to_jsonb(t)::text collate "C"),'[]'::jsonb) from private.employee_directory_details t) rows
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
create temporary table trade_school_data_before on commit drop as select pg_temp.trade_school_data() value;
create temporary table trade_school_column_before on commit drop as select max(attnum)+1 next_attnum from pg_attribute where attrelid='private.employee_directory_details'::regclass and attnum>0;
alter table private.employee_directory_details add column trade_school_enabled boolean not null default false;
create function public.list_trade_school_leave_entitlements(p_preview_person_id uuid default null)
returns table(person_id uuid) language plpgsql stable security definer set search_path='' as $$
declare workspace jsonb; scope_person uuid;
begin
  workspace:=public.get_leave_priority_workspace(p_preview_person_id);
  scope_person:=coalesce(p_preview_person_id,private.current_active_portal_employee_id());
  return query
  select p.id
  from jsonb_array_elements(workspace->'people') entry
  join public.internal_org_people p on p.id=(entry->>'personId')::uuid
  join private.employee_directory_details d on d.person_id=p.id
  where d.trade_school_enabled and d.employment_type in ('full_time','part_time')
    and p.node_kind='person' and p.is_active and p.auth_user_id is not null
    and private.is_active_portal_account(p.auth_user_id)
    and (p.id=scope_person or coalesce((entry->>'canSubmit')::boolean,false))
  order by p.id;
end $$;
revoke all on function public.list_trade_school_leave_entitlements(uuid) from public,anon,authenticated,service_role;
grant execute on function public.list_trade_school_leave_entitlements(uuid) to authenticated;
alter table public.leave_requests
 drop constraint leave_requests_request_type_label_check,
 add constraint leave_requests_request_type_label_check check(request_type_label in ('Annual leave','Sick leave','Carer''s leave','Unpaid leave','Other leave','trade school')),
 drop constraint leave_requests_pay_treatment_check,
 add constraint leave_requests_pay_treatment_check check(pay_treatment is null or pay_treatment in ('paid_entitlement','unpaid','paid_other')),
 add constraint leave_requests_trade_school_classification_check check(
  (request_type_label='trade school' and leave_type='other' and pay_treatment is not distinct from 'paid_other')
  or (request_type_label<>'trade school' and pay_treatment is distinct from 'paid_other'));
alter table private.employee_directory_audit_events
 drop constraint employee_directory_audit_events_changed_fields_check,
 add constraint employee_directory_audit_events_changed_fields_check check(changed_fields <@ array[
  'first_name','last_name','work_email','personal_email','phone','position_title','team_name','manager_id','country','address','date_of_birth','started_date','scheduled_employment_end_date','company_key','is_active','sort_order','laptop_supplied','laptop_id','mouse_id','keyboard_id','asset_tags','employment_type','working_weekdays','working_day_times','app_role','trade_school_enabled']);
CREATE OR REPLACE FUNCTION private.enforce_leave_request_employment_policy()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_person_id uuid;
  v_person_auth_user_id uuid;
  v_employment_type text;
begin
  if new.request_type_label='trade school' then
    select person.id,person.auth_user_id,detail.employment_type
    into v_person_id,v_person_auth_user_id,v_employment_type
    from public.internal_org_people person
    join private.employee_directory_details detail on detail.person_id=person.id
    join public.profiles target_profile on target_profile.id=person.auth_user_id
    where ((new.employee_person_id is not null and person.id=new.employee_person_id)
      or (new.employee_person_id is null and person.auth_user_id=new.user_id))
      and person.node_kind='person' and person.is_active
      and target_profile.account_status='active' and detail.trade_school_enabled
      and detail.employment_type in ('full_time','part_time')
    for share of person,detail,target_profile;
    if v_person_id is null or not private.is_active_portal_account(v_person_auth_user_id)
      or (new.user_id is not null and new.user_id is distinct from v_person_auth_user_id)
      or (new.record_origin='portal' and new.user_id is null) then
      raise exception 'Trade-school leave is not enabled for this employee.' using errcode='42501';
    end if;
    new.employee_person_id:=v_person_id;
    new.employment_type_snapshot:=v_employment_type;
    new.pay_treatment:='paid_other';
    new.leave_type:='other';
    return new;
  end if;

  if new.record_origin = 'historical_import' then
    select person.id, person.auth_user_id, detail.employment_type
    into v_person_id, v_person_auth_user_id, v_employment_type
    from public.internal_org_people person
    left join private.employee_directory_details detail
      on detail.person_id = person.id
    where person.id = new.employee_person_id
      and person.node_kind = 'person'
    limit 1;

    if v_person_id is null then
      raise exception 'A retained employee profile is required for historical leave.'
        using errcode = '23503';
    end if;

    if new.user_id is not null and new.user_id is distinct from v_person_auth_user_id then
      raise exception 'The historical leave login does not belong to the selected employee.'
        using errcode = '23503';
    end if;

    new.employment_type_snapshot := coalesce(new.employment_type_snapshot, v_employment_type);
    new.pay_treatment := coalesce(
      new.pay_treatment,
      case
        when new.request_type_label = 'Unpaid leave' then 'unpaid'
        when v_employment_type in ('full_time', 'part_time') then 'paid_entitlement'
        when v_employment_type in ('abn', 'casual') then 'unpaid'
        else null
      end
    );
    return new;
  end if;

  select person.id, detail.employment_type
  into v_person_id, v_employment_type
  from public.internal_org_people person
  left join private.employee_directory_details detail
    on detail.person_id = person.id
  where person.auth_user_id = new.user_id
    and person.node_kind = 'person'
    and person.is_active
  limit 1;

  if v_person_id is null then
    raise exception 'An active linked employee account is required to submit leave.'
      using errcode = '42501';
  end if;

  if v_employment_type is not null and v_employment_type not in ('full_time', 'part_time')
    and new.request_type_label <> 'Unpaid leave' then
    raise exception 'This employment type only allows Unpaid leave.'
      using errcode = '22023';
  end if;

  if v_employment_type is null
    and new.request_type_label <> 'Unpaid leave' then
    raise exception 'Ask a System Admin to set your employment type before requesting this leave.'
      using errcode = '22023';
  end if;

  new.employee_person_id := v_person_id;
  new.employment_type_snapshot := v_employment_type;
  new.pay_treatment := case
    when new.request_type_label = 'Unpaid leave' then 'unpaid'
    when v_employment_type in ('full_time', 'part_time') then 'paid_entitlement'
    else 'unpaid'
  end;

  return new;
end;
$function$
;
CREATE OR REPLACE FUNCTION public.submit_my_leave_request(p_request_type_label text, p_start_date date, p_end_date date, p_start_time time without time zone DEFAULT NULL::time without time zone, p_end_time time without time zone DEFAULT NULL::time without time zone, p_employee_note text DEFAULT NULL::text)
 RETURNS TABLE(id uuid, status text, approval_required boolean, assigned_reviewer_label text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_actor_user_id uuid := (select auth.uid());
  v_actor_person_id uuid;
  v_request_type_label text := nullif(btrim(p_request_type_label), '');
  v_leave_type text;
  v_employee_note text := nullif(btrim(p_employee_note), '');
  v_business_days integer;
  v_hours numeric(7, 2);
  v_primary_reviewer_user_id uuid;
  v_primary_reviewer_label text;
  v_reviewer_count integer;
  v_request public.leave_requests%rowtype;
begin
  if v_actor_user_id is null
    or coalesce(((select auth.jwt()) ->> 'is_anonymous')::boolean, false)
    or not private.is_active_portal_account() then
    raise exception 'An active portal account is required to submit leave.'
      using errcode = '42501';
  end if;

  v_actor_person_id := private.current_active_portal_employee_id();
  if v_actor_person_id is null then
    raise exception 'An active linked employee account is required to submit leave.'
      using errcode = '42501';
  end if;

  if v_request_type_label is null or v_request_type_label not in (
    'Annual leave',
    'Sick leave',
    'Carer''s leave',
    'Unpaid leave',
    'trade school'
  ) then
    raise exception 'Choose a valid leave type.' using errcode = '22023';
  end if;

  perform private.assert_leave_date_range(p_start_date, p_end_date);
  if p_start_date is null or p_end_date is null or p_end_date < p_start_date then
    raise exception 'End date must be on or after start date.' using errcode = '22023';
  end if;

  if (p_start_time is null) <> (p_end_time is null) then
    raise exception 'Choose both times or neither.' using errcode = '22023';
  end if;

  if v_employee_note is not null and char_length(v_employee_note) > 2000 then
    raise exception 'Leave note is too long.' using errcode = '22001';
  end if;

  if v_request_type_label='Annual leave' and exists(select 1 from private.employee_directory_details where person_id=v_actor_person_id and employment_type in ('full_time','part_time')) then
    select count(*)::integer into v_business_days from generate_series(p_start_date,p_end_date,interval '1 day') day
      cross join lateral(select ap.weekdays from private.leave_accrual_policies ap where ap.person_id=v_actor_person_id and ap.effective_from<=day::date order by ap.effective_from desc,ap.created_at desc,ap.id desc limit 1) policy
      where extract(isodow from day)::integer=any(policy.weekdays);
    if p_start_time is not null and (p_start_time<time '06:00' or p_start_time>=time '18:00' or p_end_time<=time '06:00' or p_end_time>time '18:00' or extract(minute from p_start_time)::integer%15<>0 or extract(minute from p_end_time)::integer%15<>0) then
      raise exception 'Times must use 15-minute intervals within 06:00 to 18:00.' using errcode='22023';
    end if;
    if v_business_days<1 or private.leave_request_quantity(v_actor_person_id,p_start_date,p_end_date,p_start_time,p_end_time,null) is null or private.leave_request_quantity(v_actor_person_id,p_start_date,p_end_date,p_start_time,p_end_time,null)<=0 then
      raise exception 'Your annual leave projection is unavailable. Please contact payroll before requesting annual leave.' using errcode='22023';
    end if;
    if p_start_time is not null then v_hours:=round(private.leave_request_quantity(v_actor_person_id,p_start_date,p_end_date,p_start_time,p_end_time,null),2); end if;
  else
  select count(*)::integer
  into v_business_days
  from generate_series(p_start_date, p_end_date, interval '1 day') day
  where extract(isodow from day) between 1 and 5;

  if v_business_days < 1 then
    raise exception 'Choose at least one weekday for this request.' using errcode = '22023';
  end if;

  if p_start_time is not null then
    if extract(isodow from p_start_date) not between 1 and 5
      or extract(isodow from p_end_date) not between 1 and 5
      or p_start_time < time '06:00'
      or p_start_time >= time '18:00'
      or p_end_time <= time '06:00'
      or p_end_time > time '18:00'
      or (p_start_date = p_end_date and p_end_time <= p_start_time)
      or extract(minute from p_start_time)::integer % 15 <> 0
      or extract(minute from p_end_time)::integer % 15 <> 0 then
      raise exception 'Times must use 15-minute intervals within 06:00 to 18:00.'
        using errcode = '22023';
    end if;

    select round(sum(
      case
        when day::date = p_start_date and day::date = p_end_date then
          (extract(epoch from (p_end_time - p_start_time)) / 3600)::numeric
        when day::date = p_start_date then
          (extract(epoch from (time '18:00' - p_start_time)) / 3600)::numeric
        when day::date = p_end_date then
          (extract(epoch from (p_end_time - time '06:00')) / 3600)::numeric
        else 12::numeric
      end
    ), 2)
    into v_hours
    from generate_series(p_start_date, p_end_date, interval '1 day') day
    where extract(isodow from day) between 1 and 5;

    if v_hours is null or v_hours <= 0 then
      raise exception 'Choose a time range with working hours.' using errcode = '22023';
    end if;
  end if;

  end if;

  -- Lock the hierarchy and the grant configuration in one stable order before
  -- deriving the snapshot. Organisation edits and grant changes therefore
  -- affect either this request or a later request, never half of each.
  perform pg_advisory_xact_lock(hashtextextended('internal_org_people_hierarchy', 0));
  perform pg_advisory_xact_lock(hashtextextended('leave_approval_grants', 0));

  select count(distinct candidate.reviewer_user_id)::integer
  into v_reviewer_count
  from private.resolve_leave_approval_grants(v_actor_person_id) candidate
  where candidate.reviewer_user_id is distinct from v_actor_user_id;

  if coalesce(v_reviewer_count, 0) < 1 then
    raise exception 'No authorised leave reviewer is configured for this request.'
      using errcode = '42501';
  end if;

  select candidate.reviewer_user_id, candidate.reviewer_label
  into v_primary_reviewer_user_id, v_primary_reviewer_label
  from private.resolve_leave_approval_grants(v_actor_person_id) candidate
  where candidate.reviewer_user_id is distinct from v_actor_user_id
  order by
    case candidate.scope_kind
      when 'team' then 0
      when 'subtree' then 1
      else 2
    end,
    candidate.scope_priority,
    candidate.scope_depth,
    candidate.grant_id
  limit 1;

  v_leave_type := case v_request_type_label
    when 'Annual leave' then 'annual'
    when 'Sick leave' then 'personal'
    when 'Carer''s leave' then 'personal'
    when 'Unpaid leave' then 'unpaid'
    when 'trade school' then 'other'
  end;

  insert into public.leave_requests (
    user_id,
    leave_type,
    request_type_label,
    start_date,
    end_date,
    start_time,
    end_time,
    business_days,
    hours,
    approval_required,
    manager_user_id,
    manager_name_snapshot,
    reason,
    status,
    submitted_at,
    decided_at,
    decided_by,
    created_at,
    updated_at
  )
  values (
    v_actor_user_id,
    v_leave_type,
    v_request_type_label,
    p_start_date,
    p_end_date,
    p_start_time,
    p_end_time,
    v_business_days,
    v_hours,
    true,
    v_primary_reviewer_user_id,
    v_primary_reviewer_label,
    v_employee_note,
    'submitted',
    clock_timestamp(),
    null,
    null,
    clock_timestamp(),
    clock_timestamp()
  )
  returning * into v_request;

  with candidates as (
    select candidate.*
    from private.resolve_leave_approval_grants(v_actor_person_id) candidate
    where candidate.reviewer_user_id is distinct from v_actor_user_id
  ),
  distinct_reviewers as (
    select distinct on (candidate.reviewer_user_id)
      candidate.*
    from candidates candidate
    order by
      candidate.reviewer_user_id,
      case candidate.scope_kind
        when 'team' then 0
        when 'subtree' then 1
        else 2
      end,
      candidate.scope_priority,
      candidate.scope_depth,
      candidate.grant_id
  ),
  ranked_reviewers as (
    select
      candidate.*,
      row_number() over (
        order by
          case candidate.scope_kind
            when 'team' then 0
            when 'subtree' then 1
            else 2
          end,
          candidate.scope_priority,
          candidate.scope_depth,
          candidate.grant_id
      ) as route_rank
    from distinct_reviewers candidate
  )
  insert into private.leave_request_reviewer_assignments (
    leave_request_id,
    reviewer_user_id,
    source_grant_id,
    assignment_kind,
    reviewer_label,
    is_primary
  )
  select
    v_request.id,
    candidate.reviewer_user_id,
    candidate.grant_id,
    candidate.scope_kind,
    candidate.reviewer_label,
    candidate.route_rank = 1
  from ranked_reviewers candidate;

  insert into public.leave_request_events (
    leave_request_id,
    actor_user_id,
    event_type,
    note
  )
  values
    (v_request.id, v_actor_user_id, 'created', null),
    (v_request.id, v_actor_user_id, 'submitted', null);

  return query
  select
    v_request.id,
    'Pending',
    v_request.approval_required,
    v_primary_reviewer_label;
end;
$function$
;
CREATE OR REPLACE FUNCTION public.submit_selected_employee_leave_request(p_person_id uuid, p_request_type_label text, p_start_date date, p_end_date date, p_start_time time without time zone DEFAULT NULL::time without time zone, p_end_time time without time zone DEFAULT NULL::time without time zone, p_employee_note text DEFAULT NULL::text)
 RETURNS TABLE(id uuid, status text, approval_required boolean, assigned_reviewer_label text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_unified_role_fence boolean := private.lock_portal_role_actor();
  v_actor_user_id uuid := (select auth.uid());
  v_target_user_id uuid;
  v_request_type_label text := nullif(btrim(p_request_type_label), '');
  v_employee_note text := nullif(btrim(p_employee_note), '');
  v_leave_type text;
  v_business_days integer;
  v_hours numeric(7, 2);
  v_primary_reviewer_user_id uuid;
  v_primary_reviewer_label text;
  v_reviewer_count integer;
  v_request public.leave_requests%rowtype;
begin
  if v_actor_user_id is null
    or coalesce(((select auth.jwt()) ->> 'is_anonymous')::boolean, false)
    or not private.is_active_portal_account()
    or not (private.is_operational_portal_admin() or private.can_submit_team_leave(p_person_id)) then
    raise exception 'Only Super Admin may submit leave for a selected profile.' using errcode = '42501';
  end if;

  select person.auth_user_id into v_target_user_id
  from public.internal_org_people person
  join public.profiles target_profile
    on target_profile.id = person.auth_user_id
   and target_profile.account_status = 'active'
  where person.id = p_person_id
    and person.node_kind = 'person'
    and person.is_active = true
    and person.auth_user_id is not null;

  if v_target_user_id is null or not private.is_active_portal_account(v_target_user_id) then
    raise exception 'The selected profile is not an active linked employee.' using errcode = '42501';
  end if;

  if v_request_type_label is null or v_request_type_label not in ('Annual leave', 'Sick leave', 'Carer''s leave', 'Unpaid leave', 'trade school') then
    raise exception 'Choose a valid leave type.' using errcode = '22023';
  end if;
  perform private.assert_leave_date_range(p_start_date, p_end_date);
  if p_start_date is null or p_end_date is null or p_end_date < p_start_date then
    raise exception 'End date must be on or after start date.' using errcode = '22023';
  end if;
  if (p_start_time is null) <> (p_end_time is null) then
    raise exception 'Choose both times or neither.' using errcode = '22023';
  end if;
  if v_employee_note is not null and char_length(v_employee_note) > 2000 then
    raise exception 'Leave note is too long.' using errcode = '22001';
  end if;

  if v_request_type_label='Annual leave' and exists(select 1 from private.employee_directory_details where person_id=p_person_id and employment_type in ('full_time','part_time')) then
    select count(*)::integer into v_business_days from generate_series(p_start_date,p_end_date,interval '1 day') day
      cross join lateral(select ap.weekdays from private.leave_accrual_policies ap where ap.person_id=p_person_id and ap.effective_from<=day::date order by ap.effective_from desc,ap.created_at desc,ap.id desc limit 1) policy
      where extract(isodow from day)::integer=any(policy.weekdays);
    if p_start_time is not null and (p_start_time<time '06:00' or p_start_time>=time '18:00' or p_end_time<=time '06:00' or p_end_time>time '18:00' or extract(minute from p_start_time)::integer%15<>0 or extract(minute from p_end_time)::integer%15<>0) then
      raise exception 'Times must use 15-minute intervals within 06:00 to 18:00.' using errcode='22023';
    end if;
    if v_business_days<1 or private.leave_request_quantity(p_person_id,p_start_date,p_end_date,p_start_time,p_end_time,null) is null or private.leave_request_quantity(p_person_id,p_start_date,p_end_date,p_start_time,p_end_time,null)<=0 then
      raise exception 'Your annual leave projection is unavailable. Please contact payroll before requesting annual leave.' using errcode='22023';
    end if;
    if p_start_time is not null then v_hours:=round(private.leave_request_quantity(p_person_id,p_start_date,p_end_date,p_start_time,p_end_time,null),2); end if;
  else
  select count(*)::integer into v_business_days
  from generate_series(p_start_date, p_end_date, interval '1 day') day
  where extract(isodow from day) between 1 and 5;
  if v_business_days < 1 then
    raise exception 'Choose at least one weekday for this request.' using errcode = '22023';
  end if;

  if p_start_time is not null then
    if extract(isodow from p_start_date) not between 1 and 5
      or extract(isodow from p_end_date) not between 1 and 5
      or p_start_time < time '06:00' or p_start_time >= time '18:00'
      or p_end_time <= time '06:00' or p_end_time > time '18:00'
      or (p_start_date = p_end_date and p_end_time <= p_start_time)
      or extract(minute from p_start_time)::integer % 15 <> 0
      or extract(minute from p_end_time)::integer % 15 <> 0 then
      raise exception 'Times must use 15-minute intervals within 06:00 to 18:00.' using errcode = '22023';
    end if;
    select round(sum(case
      when day::date = p_start_date and day::date = p_end_date then (extract(epoch from (p_end_time - p_start_time)) / 3600)::numeric
      when day::date = p_start_date then (extract(epoch from (time '18:00' - p_start_time)) / 3600)::numeric
      when day::date = p_end_date then (extract(epoch from (p_end_time - time '06:00')) / 3600)::numeric
      else 12::numeric end), 2)
    into v_hours
    from generate_series(p_start_date, p_end_date, interval '1 day') day
    where extract(isodow from day) between 1 and 5;
    if v_hours is null or v_hours <= 0 then
      raise exception 'Choose a time range with working hours.' using errcode = '22023';
    end if;
  end if;

  end if;

  perform pg_advisory_xact_lock(hashtextextended('internal_org_people_hierarchy', 0));
  perform pg_advisory_xact_lock(hashtextextended('leave_approval_grants', 0));
  select count(distinct candidate.reviewer_user_id)::integer into v_reviewer_count
  from private.resolve_leave_approval_grants(p_person_id) candidate
  where candidate.reviewer_user_id is distinct from v_target_user_id;
  if coalesce(v_reviewer_count, 0) < 1 then
    raise exception 'No authorised leave reviewer is configured for this employee.' using errcode = '42501';
  end if;

  select candidate.reviewer_user_id, candidate.reviewer_label
  into v_primary_reviewer_user_id, v_primary_reviewer_label
  from private.resolve_leave_approval_grants(p_person_id) candidate
  where candidate.reviewer_user_id is distinct from v_target_user_id
  order by case candidate.scope_kind when 'team' then 0 when 'subtree' then 1 else 2 end,
    candidate.scope_priority, candidate.scope_depth, candidate.grant_id
  limit 1;
  v_leave_type := case v_request_type_label
    when 'Annual leave' then 'annual'
    when 'Sick leave' then 'personal'
    when 'Carer''s leave' then 'personal'
    when 'Unpaid leave' then 'unpaid'
    when 'trade school' then 'other'
  end;

  insert into public.leave_requests (
    user_id, leave_type, request_type_label, start_date, end_date, start_time,
    end_time, business_days, hours, approval_required, manager_user_id,
    manager_name_snapshot, reason, status, submitted_at, decided_at, decided_by,
    created_at, updated_at
  ) values (
    v_target_user_id, v_leave_type, v_request_type_label, p_start_date, p_end_date,
    p_start_time, p_end_time, v_business_days, v_hours, true,
    v_primary_reviewer_user_id, v_primary_reviewer_label, v_employee_note,
    'submitted', clock_timestamp(), null, null, clock_timestamp(), clock_timestamp()
  ) returning * into v_request;

  with candidates as (
    select candidate.* from private.resolve_leave_approval_grants(p_person_id) candidate
    where candidate.reviewer_user_id is distinct from v_target_user_id
  ), distinct_reviewers as (
    select distinct on (candidate.reviewer_user_id) candidate.* from candidates candidate
    order by candidate.reviewer_user_id,
      case candidate.scope_kind when 'team' then 0 when 'subtree' then 1 else 2 end,
      candidate.scope_priority, candidate.scope_depth, candidate.grant_id
  ), ranked_reviewers as (
    select candidate.*, row_number() over (
      order by case candidate.scope_kind when 'team' then 0 when 'subtree' then 1 else 2 end,
        candidate.scope_priority, candidate.scope_depth, candidate.grant_id
    ) as route_rank from distinct_reviewers candidate
  )
  insert into private.leave_request_reviewer_assignments (
    leave_request_id, reviewer_user_id, source_grant_id, assignment_kind, reviewer_label, is_primary
  )
  select v_request.id, candidate.reviewer_user_id, candidate.grant_id,
    candidate.scope_kind, candidate.reviewer_label, candidate.route_rank = 1
  from ranked_reviewers candidate;

  insert into public.leave_request_events (leave_request_id, actor_user_id, event_type, note)
  values (v_request.id, v_actor_user_id, 'created', null),
    (v_request.id, v_actor_user_id, 'submitted', null);

  return query select v_request.id, 'Pending', v_request.approval_required, v_primary_reviewer_label;
end;
$function$
;
create function private.enforce_trade_school_leave() returns trigger language plpgsql security definer set search_path='' as $$
declare person uuid; linked_user uuid; employment text;
begin
 if tg_op='UPDATE' then
  if old.request_type_label='trade school' and new.request_type_label is distinct from 'trade school' then
   raise exception 'Trade-school leave cannot be reclassified.' using errcode='22023';
  end if;
  if old.request_type_label='trade school' and old.leave_type='other' and old.pay_treatment='paid_other'
   and (to_jsonb(new)-array['status','manager_user_id','manager_name_snapshot','manager_note','reason','updated_at','decided_at','decided_by'])
    is not distinct from (to_jsonb(old)-array['status','manager_user_id','manager_name_snapshot','manager_note','reason','updated_at','decided_at','decided_by']) then
   return new;
  end if;
 end if;
 if new.request_type_label='trade school' then
  select p.id,p.auth_user_id,d.employment_type into person,linked_user,employment
  from public.internal_org_people p
  join private.employee_directory_details d on d.person_id=p.id
  join public.profiles profile on profile.id=p.auth_user_id
  where p.id=new.employee_person_id and p.node_kind='person' and p.is_active
   and d.trade_school_enabled and d.employment_type in ('full_time','part_time') and profile.account_status='active'
  for share of p,d,profile;
  if person is null or not private.is_active_portal_account(linked_user)
   or (new.user_id is not null and new.user_id is distinct from linked_user)
   or (new.record_origin='portal' and new.user_id is null) then
   raise exception 'Trade-school leave is not enabled for this employee.' using errcode='42501';
  end if;
  new.leave_type:='other';
  new.pay_treatment:='paid_other';
 elsif new.pay_treatment='paid_other' then
  raise exception 'Paid-other treatment is restricted to trade-school leave.' using errcode='22023';
 end if;
 return new;
end $$;
revoke all on function private.enforce_trade_school_leave() from public,anon,authenticated,service_role;
create trigger zz_leave_requests_trade_school_policy before insert or update on public.leave_requests for each row execute function private.enforce_trade_school_leave();

create temporary table trade_school_function_after on commit drop as
select s.signature,s.is_existing,pg_get_functiondef(p.oid) definition,
 (to_jsonb(p)-array['prosrc','prosqlbody','proargdefaults'])||jsonb_build_object('parameter_defaults',pg_get_expr(p.proargdefaults,0)) metadata,
 jsonb_build_object('owner',pg_get_userbyid(p.proowner),'acl',p.proacl::text,'security_definer',p.prosecdef,'config',p.proconfig) portable_metadata
from trade_school_function_spec s join pg_proc p on p.oid=to_regprocedure(s.signature);
create temporary table trade_school_catalog_added on commit drop as
 select definition from trade_school_function_after
 union all select p.oid::regprocedure::text||':'||p.proowner::text||':'||coalesce(p.proacl::text,'default') from trade_school_function_spec s join pg_proc p on p.oid=to_regprocedure(s.signature) where not s.is_existing
 union all select 'private.employee_directory_details:trade_school_enabled:boolean:true'
 union all select (case when s.name='employee_directory_audit_events_changed_fields_check' then 'private.employee_directory_audit_events:' else 'public.leave_requests:' end)||s.after_definition from trade_school_constraint_spec s
 union all select 'public.leave_requests:O:CREATE TRIGGER zz_leave_requests_trade_school_policy BEFORE INSERT OR UPDATE ON public.leave_requests FOR EACH ROW EXECUTE FUNCTION private.enforce_trade_school_leave()';
create function pg_temp.trade_school_assert_delta() returns void language plpgsql set search_path='' as $$
begin
 if (select count(*) from trade_school_function_after)<>(select count(*) from trade_school_function_spec)
 or exists(select 1 from trade_school_function_spec s left join pg_proc p on p.oid=to_regprocedure(s.signature)
  where p.oid is null or encode(extensions.digest(pg_get_functiondef(p.oid),'sha256'),'hex') is distinct from s.after_sha256
  or (not s.is_existing and jsonb_build_object('owner',pg_get_userbyid(p.proowner),'acl',p.proacl::text,'security_definer',p.prosecdef,'config',p.proconfig) is distinct from s.new_metadata))
 or exists(select 1 from trade_school_function_before b left join pg_proc p on p.oid=to_regprocedure(b.signature)
  where p.oid is null or b.metadata is distinct from ((to_jsonb(p)-array['prosrc','prosqlbody','proargdefaults'])||jsonb_build_object('parameter_defaults',pg_get_expr(p.proargdefaults,0))))
 or exists(select 1 from trade_school_constraint_spec s left join pg_constraint k on k.conrelid=case when s.name='employee_directory_audit_events_changed_fields_check' then 'private.employee_directory_audit_events'::regclass else 'public.leave_requests'::regclass end and k.conname=s.name
  where pg_get_constraintdef(k.oid) is distinct from s.after_definition or k.contype<>'c' or not k.convalidated or k.condeferrable or k.condeferred or k.connoinherit)
 or not exists(select 1 from pg_attribute a join pg_attrdef d on d.adrelid=a.attrelid and d.adnum=a.attnum
  where a.attrelid='private.employee_directory_details'::regclass and a.attname='trade_school_enabled'
   and a.attnum=(select next_attnum from trade_school_column_before) and a.atttypid='boolean'::regtype and a.atttypmod=-1
   and a.attnotnull and a.atthasdef and a.atthasmissing and a.attmissingval::text='{f}' and a.attacl is null
   and a.attidentity='' and a.attgenerated='' and a.attcollation=0 and not a.attisdropped and pg_get_expr(d.adbin,d.adrelid)='false')
 or exists(select 1 from private.employee_directory_details where trade_school_enabled)
 or not exists(select 1 from pg_trigger where tgrelid='public.leave_requests'::regclass and tgname='zz_leave_requests_trade_school_policy' and tgenabled='O' and not tgisinternal and pg_get_triggerdef(oid)='CREATE TRIGGER zz_leave_requests_trade_school_policy BEFORE INSERT OR UPDATE ON public.leave_requests FOR EACH ROW EXECUTE FUNCTION private.enforce_trade_school_leave()')
 or pg_temp.trade_school_security() is distinct from (select value from trade_school_security_before)
 or pg_temp.trade_school_data() is distinct from (select value from trade_school_data_before) then
  raise exception 'Trade-school leave differs from its exact reviewed delta.' using errcode='55000';
 end if;
 if exists((select definition collate "C" from trade_school_catalog_before except all
  (select definition collate "C" from pg_temp.trade_school_catalog() except all select definition collate "C" from trade_school_catalog_added
   union all select definition collate "C" from trade_school_function_before
   union all select (case when name='employee_directory_audit_events_changed_fields_check' then 'private.employee_directory_audit_events:' else 'public.leave_requests:' end)||before_definition collate "C" from trade_school_constraint_spec where before_definition is not null))
 union all
 ((select definition collate "C" from pg_temp.trade_school_catalog() except all select definition collate "C" from trade_school_catalog_added
   union all select definition collate "C" from trade_school_function_before
   union all select (case when name='employee_directory_audit_events_changed_fields_check' then 'private.employee_directory_audit_events:' else 'public.leave_requests:' end)||before_definition collate "C" from trade_school_constraint_spec where before_definition is not null)
  except all select definition collate "C" from trade_school_catalog_before)) then
  raise exception 'Trade-school leave includes unknown catalog drift.' using errcode='55000';
 end if;
end $$;
set constraints all immediate;
select pg_temp.trade_school_assert_delta();
update private.confirmed_test_purge_schema set schema_hash=private.confirmed_test_purge_schema_hash() where singleton;
create temporary table trade_school_catalog_after on commit drop as select private.confirmed_test_purge_schema_hash() value;
set constraints all immediate;
select pg_temp.trade_school_assert_delta();
do $trade_school_final$ begin
 if private.confirmed_test_purge_schema_hash() is distinct from (select value from trade_school_catalog_after)
 or (select count(*) from private.confirmed_test_purge_schema)<>1
 or (select schema_hash from private.confirmed_test_purge_schema where singleton) is distinct from (select value from trade_school_catalog_after) then
  raise exception 'Trade-school final catalog differs.' using errcode='55000';
 end if;
end $trade_school_final$;
commit;
