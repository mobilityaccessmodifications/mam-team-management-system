begin;
set local search_path='';
do $identity_guard$ declare r record; previous_hash text; begin
  if not pg_try_advisory_xact_lock(hashtextextended('confirmed-test-purge',0)) then raise exception 'Concurrent purge; defer consolidation migration' using errcode='55P03'; end if;
  for r in select n.nspname,c.relname from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid=c.relnamespace
    where n.nspname <> 'information_schema' and n.nspname !~ '^pg_' and c.relkind in ('r','p') and not c.relispartition order by n.nspname,c.relname
  loop execute format('lock table %I.%I in %s mode nowait',r.nspname,r.relname,case when (r.nspname,r.relname) in (('storage','migrations'),('storage','buckets_vectors'),('storage','vector_indexes'),('auth','schema_migrations')) then 'access share' else 'exclusive' end); end loop;
  if (select count(*) from private.confirmed_test_purge_schema)<>1 then raise exception 'Exact purge schema predecessor required' using errcode='55000'; end if;
  select schema_hash into previous_hash from private.confirmed_test_purge_schema;
  if private.confirmed_test_purge_schema_hash() is distinct from previous_hash then raise exception 'Schema/projection/trigger drift requires independent review before consolidation' using errcode='55000'; end if;
  if to_regclass('private.employee_identity_consolidations') is not null then raise exception 'Consolidation already installed; do not replay migration' using errcode='55000'; end if;
  for r in select * from (values
    ('private.confirmed_test_purge_census(uuid,uuid)','3e22a29dd6f6c60828803afc1dbd74833552c8c72f44659bc0cb37c9298ae5e2'),
    ('public.prepare_confirmed_test_identity_purge(uuid,uuid,text,text,text,bigint,bigint,text,boolean,boolean)','07294ec1a4342ae89d4c83feb18f2f7f11f9492e2c3fc205ed0d2f364c0ef084'),
    ('private.reject_retired_test_identity_reference()','bbd7503fa072b9606dfefe24ff4ced9c9d81a284f3169af115a79978e43d64cb'),
    ('private.payroll_closing_snapshot_guard()','4e3e5456cd55475f72145dbfc800c0ead367092392ddb6b6dda27d3b478532a1'),
    ('public.complete_confirmed_test_identity_purge(uuid)','c2c7a425a73ad12c093f10b9e2527e2bcd404c613fe2f408387e17e2da6c5186'),
    ('private.confirmed_test_purge_schema_hash()','3385d5a0140df3995e3196ffea442b4829f9a5357de3ccf5a8d521fbe9011a54'),
    ('private.confirmed_test_retained_leave_receipt(jsonb)','09b0d3b2a30787f9e2cbbef1c5d2b4b41368d10b85faead97ef4672d7f2b691d'),
    ('public.list_employee_directory_records_with_archive_visibility(boolean)','cfa0cfcbefcfaf91e7469d775d9967a266be932382823979add169ae301e518b')
  ) x(signature,definition_sha256) loop
    if (select encode(extensions.digest(pg_get_functiondef(to_regprocedure(r.signature)),'sha256'),'hex')) is distinct from r.definition_sha256 then
      raise exception 'Exact consolidation function predecessor required (%)',r.signature using errcode='55000';
    end if;
  end loop;
  if pg_get_indexdef('private.employee_roster_import_row_map_run_person_idx'::regclass)<>'CREATE UNIQUE INDEX employee_roster_import_row_map_run_person_idx ON private.employee_roster_import_row_map USING btree (run_id, person_id) WHERE (person_id IS NOT NULL)' then raise exception 'Exact roster index predecessor required' using errcode='55000'; end if;
  perform set_config('mam.identity_previous_security',(select encode(extensions.digest(coalesce(string_agg(definition,E'\n' order by definition),''),'sha256'),'hex') from (
  select 'column:'||a.attrelid::regclass::text||':'||a.attname||':'||coalesce(a.attacl::text,'default') definition from pg_attribute a join pg_class c on c.oid=a.attrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname <> 'information_schema' and n.nspname !~ '^pg_' and a.attnum>0 and not a.attisdropped
  union all select 'schema:'||nspname||':'||nspowner::text||':'||coalesce(nspacl::text,'default') from pg_namespace where nspname <> 'information_schema' and nspname !~ '^pg_'
  union all select 'default:'||defaclrole::text||':'||defaclnamespace::text||':'||defaclobjtype::text||':'||defaclacl::text from pg_default_acl
  union all select 'role:'||rolname||':'||rolsuper||':'||rolinherit||':'||rolcreaterole||':'||rolcreatedb||':'||rolcanlogin||':'||rolreplication||':'||rolbypassrls from pg_roles
  union all select 'index:'||i.indexrelid::regclass::text||':'||pg_get_indexdef(i.indexrelid) from pg_index i join pg_class c on c.oid=i.indrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname <> 'information_schema' and n.nspname !~ '^pg_'
) security_definitions),true);
  perform set_config('mam.identity_previous_receipts',(select encode(extensions.digest(jsonb_build_array((select coalesce(jsonb_agg(to_jsonb(p) order by to_jsonb(p)::text),'[]'::jsonb) from private.confirmed_test_identity_purges p),(select coalesce(jsonb_agg(to_jsonb(n) order by to_jsonb(n)::text),'[]'::jsonb) from private.notification_delivery_receipts n))::text,'sha256'),'hex')),true);
  perform set_config('mam.identity_previous_hash',previous_hash,true);
  perform set_config('mam.identity_previous_projection',pg_get_functiondef('public.list_employee_directory_records_with_archive_visibility(boolean)'::regprocedure),true);
  perform set_config('mam.identity_previous_payroll_snapshot_guard',pg_get_functiondef('private.payroll_closing_snapshot_guard()'::regprocedure),true);
end $identity_guard$;
alter table private.employee_roster_import_row_map add column source_person_id uuid;
update private.employee_roster_import_row_map set source_person_id=person_id;
alter table private.employee_roster_import_row_map add column original_row jsonb;
update private.employee_roster_import_row_map m set original_row=to_jsonb(m)-'original_row';
alter table private.employee_roster_import_row_map alter column original_row set not null;
drop index private.employee_roster_import_row_map_run_person_idx;
create unique index employee_roster_import_row_map_run_person_idx
  on private.employee_roster_import_row_map(run_id,source_person_id)
  where source_person_id is not null;
create function private.protect_employee_roster_original_row()
returns trigger language plpgsql set search_path='' as $$
begin
  if tg_op='INSERT' then
    new.source_person_id := coalesce(new.source_person_id,new.person_id);
    new.original_row := to_jsonb(new)-'original_row';
  elsif new.original_row is distinct from old.original_row or new.source_person_id is distinct from old.source_person_id then
    raise exception 'Original roster source row is immutable.' using errcode='23514';
  end if;
  if new.source_person_id is distinct from new.person_id then
    perform private.assert_employee_identity_actor();
    if not exists(select 1 from private.employee_identity_consolidations c
      join public.internal_org_people p on p.id=c.canonical_person_id and p.company_key=c.source_company_key
      where c.source_person_id=new.source_person_id and c.canonical_person_id=new.person_id) then
      raise exception 'Roster source identity must resolve to its confirmed canonical target.' using errcode='23514';
    end if;
  end if;
  return new;
end;
$$;
create trigger protect_employee_roster_original_row before insert or update on private.employee_roster_import_row_map
for each row execute function private.protect_employee_roster_original_row();
revoke all on function private.protect_employee_roster_original_row() from public,anon,authenticated,service_role;
create table private.employee_identity_consolidations (
  source_person_id uuid primary key,
  canonical_person_id uuid not null references public.internal_org_people(id) on delete restrict,
  actor_user_id uuid not null references auth.users(id) on delete restrict,
  confirmed_pair_reference text not null,
  source_company_key text not null,
  source_name_key text not null,
  reviewed_plan jsonb not null,
  archived_rows jsonb not null,
  created_at timestamptz not null default clock_timestamp(),
  check (source_person_id <> canonical_person_id)
);
alter table private.employee_identity_consolidations enable row level security;
alter table private.employee_identity_consolidations force row level security;
revoke all on private.employee_identity_consolidations from public,anon,authenticated,service_role;

create function private.protect_employee_identity_consolidation_receipt()
returns trigger language plpgsql set search_path='' as $$
begin
  raise exception 'Employee identity consolidation provenance is immutable.' using errcode='23514';
end;
$$;
create trigger protect_employee_identity_consolidation_receipt before update or delete on private.employee_identity_consolidations
for each row execute function private.protect_employee_identity_consolidation_receipt();
create trigger reject_retired_test_identity_reference before insert or update on private.employee_identity_consolidations
for each row execute function private.reject_retired_test_identity_reference();
revoke all on function private.protect_employee_identity_consolidation_receipt() from public,anon,authenticated,service_role;

create function private.employee_identity_dependency_manifest()
returns jsonb language sql immutable set search_path='' as $$
  select '[{"table":"internal_org_people","constraint":"internal_org_people_parent_id_fkey","definition":"FOREIGN KEY (parent_id) REFERENCES public.internal_org_people(id) ON DELETE RESTRICT"},{"table":"leave_requests","constraint":"leave_requests_employee_person_id_fkey","definition":"FOREIGN KEY (employee_person_id) REFERENCES public.internal_org_people(id) ON DELETE RESTRICT"},{"table":"private.annual_leave_balance_history","constraint":"annual_leave_balance_history_person_id_fkey","definition":"FOREIGN KEY (person_id) REFERENCES public.internal_org_people(id)"},{"table":"private.approved_leave_calendar_grants","constraint":"approved_leave_calendar_grants_person_id_fkey","definition":"FOREIGN KEY (person_id) REFERENCES public.internal_org_people(id) ON DELETE CASCADE"},{"table":"private.employee_annual_leave_balances","constraint":"employee_annual_leave_balances_person_id_fkey","definition":"FOREIGN KEY (person_id) REFERENCES public.internal_org_people(id) ON DELETE CASCADE"},{"table":"private.employee_check_in_access_grants","constraint":"employee_check_in_access_grants_scope_root_person_id_fkey","definition":"FOREIGN KEY (scope_root_person_id) REFERENCES public.internal_org_people(id) ON DELETE RESTRICT"},{"table":"private.employee_check_in_contract_classifications","constraint":"employee_check_in_contract_classifications_person_id_fkey","definition":"FOREIGN KEY (person_id) REFERENCES public.internal_org_people(id) ON DELETE CASCADE"},{"table":"private.employee_check_in_enrolments","constraint":"employee_check_in_enrolments_person_id_fkey","definition":"FOREIGN KEY (person_id) REFERENCES public.internal_org_people(id) ON DELETE CASCADE"},{"table":"private.employee_check_in_reminders","constraint":"employee_check_in_reminders_person_id_fkey","definition":"FOREIGN KEY (person_id) REFERENCES public.internal_org_people(id) ON DELETE CASCADE"},{"table":"private.employee_directory_audit_events","constraint":"employee_directory_audit_events_person_id_fkey","definition":"FOREIGN KEY (person_id) REFERENCES public.internal_org_people(id) ON DELETE CASCADE"},{"table":"private.employee_directory_details","constraint":"employee_directory_details_person_id_fkey","definition":"FOREIGN KEY (person_id) REFERENCES public.internal_org_people(id) ON DELETE CASCADE"},{"table":"private.employee_new_starter_day_one_reminders","constraint":"employee_new_starter_day_one_reminders_person_id_fkey","definition":"FOREIGN KEY (person_id) REFERENCES public.internal_org_people(id) ON DELETE CASCADE"},{"table":"private.employee_onboarding_credentials","constraint":"employee_onboarding_credentials_person_id_fkey","definition":"FOREIGN KEY (person_id) REFERENCES public.internal_org_people(id)"},{"table":"private.employee_roster_external_manager_roots","constraint":"employee_roster_external_manager_roots_org_unit_id_fkey","definition":"FOREIGN KEY (org_unit_id) REFERENCES public.internal_org_people(id) ON DELETE RESTRICT"},{"table":"private.employee_roster_import_row_map","constraint":"employee_roster_import_row_map_manager_person_id_fkey","definition":"FOREIGN KEY (manager_person_id) REFERENCES public.internal_org_people(id) ON DELETE RESTRICT"},{"table":"private.employee_roster_import_row_map","constraint":"employee_roster_import_row_map_person_id_fkey","definition":"FOREIGN KEY (person_id) REFERENCES public.internal_org_people(id) ON DELETE RESTRICT"},{"table":"private.employee_sick_leave_balances","constraint":"employee_sick_leave_balances_person_id_fkey","definition":"FOREIGN KEY (person_id) REFERENCES public.internal_org_people(id) ON DELETE CASCADE"},{"table":"private.employee_work_schedule_change_events","constraint":"employee_work_schedule_change_events_person_id_fkey","definition":"FOREIGN KEY (person_id) REFERENCES public.internal_org_people(id) ON DELETE RESTRICT"},{"table":"private.employee_work_schedule_change_requests","constraint":"employee_work_schedule_change_requests_person_id_fkey","definition":"FOREIGN KEY (person_id) REFERENCES public.internal_org_people(id) ON DELETE RESTRICT"},{"table":"private.it_asset_custody_history","constraint":"it_asset_custody_history_person_id_fkey","definition":"FOREIGN KEY (person_id) REFERENCES public.internal_org_people(id) ON DELETE RESTRICT"},{"table":"private.it_assets","constraint":"it_assets_assigned_person_id_fkey","definition":"FOREIGN KEY (assigned_person_id) REFERENCES public.internal_org_people(id) ON DELETE RESTRICT"},{"table":"private.leave_accrual_calculations","constraint":"leave_accrual_calculations_person_id_fkey","definition":"FOREIGN KEY (person_id) REFERENCES public.internal_org_people(id)"},{"table":"private.leave_accrual_day_reviews","constraint":"leave_accrual_day_reviews_person_id_fkey","definition":"FOREIGN KEY (person_id) REFERENCES public.internal_org_people(id)"},{"table":"private.leave_accrual_policies","constraint":"leave_accrual_policies_person_id_fkey","definition":"FOREIGN KEY (person_id) REFERENCES public.internal_org_people(id)"},{"table":"private.leave_approval_grants","constraint":"leave_approval_grants_scope_root_person_id_fkey","definition":"FOREIGN KEY (scope_root_person_id) REFERENCES public.internal_org_people(id) ON DELETE RESTRICT"},{"table":"private.leave_register_read_grants","constraint":"leave_register_read_grants_person_id_fkey","definition":"FOREIGN KEY (person_id) REFERENCES public.internal_org_people(id) ON DELETE CASCADE"},{"table":"private.openclaw_phone_identities","constraint":"openclaw_phone_identities_person_id_fkey","definition":"FOREIGN KEY (person_id) REFERENCES public.internal_org_people(id)"},{"table":"private.openclaw_phone_identity_events","constraint":"openclaw_phone_identity_events_person_id_fkey","definition":"FOREIGN KEY (person_id) REFERENCES public.internal_org_people(id)"},{"table":"private.payroll_balance_email_recipients","constraint":"payroll_balance_email_recipients_person_id_fkey","definition":"FOREIGN KEY (person_id) REFERENCES public.internal_org_people(id) ON DELETE RESTRICT"},{"table":"private.payroll_balance_import_grant_events","constraint":"payroll_balance_import_grant_events_person_id_fkey","definition":"FOREIGN KEY (person_id) REFERENCES public.internal_org_people(id) ON DELETE RESTRICT"},{"table":"private.payroll_balance_import_grants","constraint":"payroll_balance_import_grants_person_id_fkey","definition":"FOREIGN KEY (person_id) REFERENCES public.internal_org_people(id) ON DELETE CASCADE"},{"table":"private.payroll_balance_import_stage_rows","constraint":"payroll_balance_import_stage_rows_person_id_fkey","definition":"FOREIGN KEY (person_id) REFERENCES public.internal_org_people(id) ON DELETE SET NULL"},{"table":"private.payroll_balance_imports","constraint":"payroll_balance_imports_person_id_fkey","definition":"FOREIGN KEY (person_id) REFERENCES public.internal_org_people(id)"},{"table":"private.payroll_carryforward_events","constraint":"payroll_carryforward_events_person_id_company_key_fkey","definition":"FOREIGN KEY (person_id, company_key) REFERENCES public.internal_org_people(id, company_key)"},{"table":"private.payroll_closing_write_claims","constraint":"payroll_closing_write_claims_person_id_fkey","definition":"FOREIGN KEY (person_id) REFERENCES public.internal_org_people(id)"},{"table":"private.payroll_comparison_only_importers","constraint":"payroll_comparison_only_importers_person_id_fkey","definition":"FOREIGN KEY (person_id) REFERENCES public.internal_org_people(id)"},{"table":"private.portal_account_status_change_claims","constraint":"portal_account_status_change_claims_person_id_fkey","definition":"FOREIGN KEY (person_id) REFERENCES public.internal_org_people(id) ON DELETE CASCADE"},{"table":"private.portal_password_reset_claims","constraint":"portal_password_reset_claims_person_id_fkey","definition":"FOREIGN KEY (person_id) REFERENCES public.internal_org_people(id) ON DELETE CASCADE"},{"table":"private.scheduled_employee_offboarding","constraint":"scheduled_employee_offboarding_person_id_fkey","definition":"FOREIGN KEY (person_id) REFERENCES public.internal_org_people(id) ON DELETE CASCADE"},{"table":"private.sick_leave_balance_history","constraint":"sick_leave_balance_history_person_id_fkey","definition":"FOREIGN KEY (person_id) REFERENCES public.internal_org_people(id)"},{"table":"private.subscription_credential_access_grants","constraint":"subscription_credential_access_grants_person_id_fkey","definition":"FOREIGN KEY (person_id) REFERENCES public.internal_org_people(id) ON DELETE CASCADE"},{"table":"private.subscription_management_grants","constraint":"subscription_management_grants_person_id_fkey","definition":"FOREIGN KEY (person_id) REFERENCES public.internal_org_people(id) ON DELETE CASCADE"},{"table":"private.subscription_memberships","constraint":"subscription_memberships_person_id_fkey","definition":"FOREIGN KEY (person_id) REFERENCES public.internal_org_people(id) ON DELETE RESTRICT"},{"table":"private.subscription_register","constraint":"subscription_register_responsible_person_id_fkey","definition":"FOREIGN KEY (responsible_person_id) REFERENCES public.internal_org_people(id) ON DELETE RESTRICT"}]'::jsonb;
$$;

create function private.employee_identity_retained_account_audit(p_row jsonb)
returns boolean language sql stable security definer set search_path='' as $$
  select exists(select 1 from private.employee_identity_consolidations c
    where c.source_person_id::text=p_row->'after_state'->>'person_id'
      and c.reviewed_plan->>'historical_account_audit_sha256'=encode(extensions.digest((c.archived_rows->'private.portal_account_admin_events')::text,'sha256'),'hex')
      and exists(select 1 from jsonb_array_elements(c.archived_rows->'private.portal_account_admin_events') original where (original-'created_at')=(p_row-'created_at') and (original->>'created_at')::timestamptz=(p_row->>'created_at')::timestamptz));
$$;
revoke all on function private.employee_identity_retained_account_audit(jsonb) from public,anon,authenticated,service_role;

create function private.employee_identity_snapshot(p_ids uuid[])
returns jsonb language plpgsql security definer set search_path='' as $$
declare r record; rows_json jsonb; result jsonb := '{}'::jsonb; scan_ids uuid[];
begin
  select p_ids || coalesce(array_agg(id),array[]::uuid[]) into scan_ids from private.employee_check_in_reminders where person_id=any(p_ids);
  for r in select n.nspname,c.relname from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid=c.relnamespace
    where n.nspname <> 'information_schema' and n.nspname !~ '^pg_' and c.relkind in ('r','p') and not c.relispartition
      and c.oid <> 'private.employee_identity_consolidations'::regclass order by n.nspname,c.relname
  loop
    execute format('select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text),''[]''::jsonb) from %I.%I t where exists (select 1 from unnest($1) id where position(id::text in lower((case when $2 then to_jsonb(t)-''original_row''-''source_person_id'' else to_jsonb(t) end)::text))>0) and case when $3 then not private.employee_identity_retained_account_audit(to_jsonb(t)) else true end',r.nspname,r.relname)
      into rows_json using scan_ids,r.nspname='private' and r.relname='employee_roster_import_row_map',r.nspname='private' and r.relname='portal_account_admin_events';
    if rows_json <> '[]'::jsonb then result := result || jsonb_build_object(r.nspname||'.'||r.relname,rows_json); end if;
  end loop;
  return result;
end;
$$;

create function private.assert_employee_identity_actor()
returns uuid language plpgsql security definer set search_path='' as $$
declare actor uuid := auth.uid();
begin
  if auth.role() is distinct from 'authenticated' or actor is null or not private.is_system_portal_account_admin()
    or not exists(select 1 from public.profiles where id=actor and app_role='system_admin' and private.is_active_portal_account(id)) then
    raise exception 'An authenticated active System Admin is required.' using errcode='42501';
  end if;
  return actor;
end;
$$;

create function private.assert_employee_identity_dependencies(p_source uuid,p_target uuid,p_historical_source_provenance_confirmed boolean)
returns void language plpgsql security definer set search_path='' as $$
declare actual jsonb; snapshot jsonb; k text; source_row jsonb; target_detail jsonb; audit_row jsonb; payroll private.payroll_balance_imports%rowtype; import_snapshot jsonb;
begin
  select jsonb_agg(jsonb_build_object('table',case when n.nspname='public' then cl.relname else n.nspname||'.'||cl.relname end,
    'constraint',c.conname,'definition',pg_get_constraintdef(c.oid)) order by case when n.nspname='public' then cl.relname else n.nspname||'.'||cl.relname end,c.conname)
  into actual from pg_catalog.pg_constraint c join pg_catalog.pg_class cl on cl.oid=c.conrelid join pg_catalog.pg_namespace n on n.oid=cl.relnamespace
  where c.confrelid=any(array['public.internal_org_people'::regclass,'private.employee_directory_details'::regclass,
    'private.employee_directory_audit_events'::regclass,'private.employee_check_in_enrolments'::regclass])
    and c.conrelid <> 'private.employee_identity_consolidations'::regclass;
  if actual is distinct from private.employee_identity_dependency_manifest() then
    raise exception 'Employee identity dependency schema changed; review the manifest.' using errcode='23514';
  end if;
  if exists(select 1 from pg_catalog.pg_trigger t join pg_catalog.pg_class c on c.oid=t.tgrelid join pg_catalog.pg_namespace n on n.oid=c.relnamespace
    where n.nspname in ('public','private') and not t.tgisinternal and t.tgenabled <> 'O') then
    raise exception 'Protection triggers must remain enabled.' using errcode='23514';
  end if;
  snapshot := private.employee_identity_snapshot(array[p_source]);
  for k in select jsonb_object_keys(snapshot) loop
    if k <> all(array['public.internal_org_people','private.employee_directory_details','private.employee_directory_audit_events',
      'private.employee_check_in_enrolments','private.employee_check_in_reminders','private.employee_check_in_reminder_events','private.employee_roster_import_row_map','private.portal_account_admin_events','private.portal_password_reset_claims','private.employee_annual_leave_balances','private.employee_sick_leave_balances','private.annual_leave_balance_history','private.sick_leave_balance_history','private.payroll_balance_imports']) then
      raise exception 'Unsupported source dependency: %',k using errcode='23514';
    end if;
  end loop;
  if snapshot ?| array['private.employee_annual_leave_balances','private.employee_sick_leave_balances','private.annual_leave_balance_history','private.sick_leave_balance_history','private.payroll_balance_imports'] then
    if not exists(select 1 from public.internal_org_people where id=p_source and not is_active and auth_user_id is null)
      or not exists(select 1 from public.internal_org_people target join private.employee_directory_details details on details.person_id=target.id
        where target.id=p_target and target.is_active and target.auth_user_id is not null and target.started_date is not null and details.employment_type='full_time')
      or (select count(*) from private.payroll_balance_imports where person_id=p_source)<>1
      or exists(select 1 from private.employee_annual_leave_balances where person_id=p_target)
      or exists(select 1 from private.employee_sick_leave_balances where person_id=p_target)
      or exists(select 1 from private.leave_accrual_policies where person_id=p_target)
      or exists(select 1 from private.leave_accrual_day_reviews where person_id=p_target)
      or exists(select 1 from private.leave_accrual_calculations where person_id=p_target)
      or exists(select 1 from public.leave_requests where employee_person_id=p_target or user_id=(select auth_user_id from public.internal_org_people where id=p_target)) then
      raise exception 'Unsupported source dependency: historical payroll target collision or incomplete import.' using errcode='23514';
    end if;
    select * into payroll from private.payroll_balance_imports where person_id=p_source;
    if payroll.match_status<>'inactive' or payroll.batch_id is not null or payroll.source_sha256 !~ '^[0-9a-f]{64}$'
      or payroll.company_key is distinct from (select company_key from public.internal_org_people where id=p_target)
      or payroll.annual_hours<=0 or payroll.sick_hours<=0
      or payroll.as_of < (select started_date from public.internal_org_people where id=p_target)
      or payroll.as_of > (now() at time zone 'Australia/Melbourne')::date
      or not exists(select 1 from private.employee_annual_leave_balances b where b.person_id=p_source and b.source_import_id=payroll.id and not b.is_example and b.hours=payroll.annual_hours and b.as_of=payroll.as_of)
      or not exists(select 1 from private.employee_sick_leave_balances b where b.person_id=p_source and b.source_import_id=payroll.id and b.hours=payroll.sick_hours and b.as_of=payroll.as_of)
      or (select count(*) from private.annual_leave_balance_history where person_id=p_source)<>1
      or (select count(*) from private.sick_leave_balance_history where person_id=p_source)<>1
      or not exists(select 1 from private.annual_leave_balance_history h where h.person_id=p_source and h.source_import_id=payroll.id and not h.is_example and h.hours=payroll.annual_hours and h.as_of=payroll.as_of)
      or not exists(select 1 from private.sick_leave_balance_history h where h.person_id=p_source and h.source_import_id=payroll.id and h.hours=payroll.sick_hours and h.as_of=payroll.as_of) then
      raise exception 'Unsupported source dependency: inconsistent historical payroll provenance.' using errcode='23514';
    end if;
    import_snapshot := private.employee_identity_snapshot(array[payroll.id]);
    for k in select jsonb_object_keys(import_snapshot) loop
      if k<>all(array['private.employee_annual_leave_balances','private.employee_sick_leave_balances','private.annual_leave_balance_history','private.sick_leave_balance_history','private.payroll_balance_imports'])
        or exists(select 1 from jsonb_array_elements(import_snapshot->k) row where row->>'person_id' is distinct from p_source::text)
        or exists(select 1 from jsonb_array_elements(import_snapshot->k) row where position(p_source::text in lower((row-'person_id')::text))>0) then
        raise exception 'Unsupported source dependency: shared or unknown historical payroll support.' using errcode='23514';
      end if;
    end loop;
  end if;
  if exists(select 1 from jsonb_array_elements(coalesce(snapshot->'private.portal_password_reset_claims','[]'::jsonb)) claim
    where claim->>'person_id' is distinct from p_source::text or claim->>'status'<>'finalised'
      or claim->>'finalised_at' is null or claim->>'cancelled_at' is not null or claim->>'reset_token' is null
      or claim->>'final_account_version' is null
      or position(p_source::text in lower((claim-'person_id')::text))>0
      or not exists(select 1 from public.internal_org_people where id=p_source and not is_active and auth_user_id is null)
      or not exists(select 1 from public.profiles profile join auth.users account on account.id=profile.id
        where profile.id::text=claim->>'auth_user_id' and profile.app_role='employee' and profile.account_status='disabled'
          and (claim->>'final_account_version')::bigint <= profile.account_version
          and not exists(select 1 from public.internal_org_people person where person.auth_user_id=profile.id))) then
    raise exception 'Unsupported historical finalised password-reset claim.' using errcode='23514';
  end if;
  for audit_row in select value from jsonb_array_elements(coalesce(snapshot->'private.portal_account_admin_events','[]'::jsonb)) loop
    if audit_row->>'event_type'<>'account_linked'
      or not exists(select 1 from private.portal_account_admin_events e where e.id=(audit_row->>'id')::bigint and e.before_state is null)
      or jsonb_typeof(audit_row->'after_state') is distinct from 'object' then
      raise exception 'Unsupported historical account audit shape.' using errcode='23514';
    end if;
    if (select array_agg(key order by key) from jsonb_object_keys(audit_row->'after_state') key) is distinct from array['account_status','account_version','login_name','must_change_password','person_id']
      or audit_row->'after_state'->>'person_id' is distinct from p_source::text
      or jsonb_typeof(audit_row->'after_state'->'person_id') is distinct from 'string'
      or jsonb_typeof(audit_row->'after_state'->'account_status') is distinct from 'string'
      or audit_row->'after_state'->>'account_status' not in ('active','disabled')
      or jsonb_typeof(audit_row->'after_state'->'account_version') is distinct from 'number'
      or audit_row->'after_state'->>'account_version' !~ '^[1-9][0-9]{0,17}$'
      or jsonb_typeof(audit_row->'after_state'->'must_change_password') is distinct from 'boolean'
      or jsonb_typeof(audit_row->'after_state'->'login_name') is distinct from 'string'
      or nullif(btrim(audit_row->'after_state'->>'login_name'),'') is null
      or position(p_source::text in lower((audit_row-'after_state')::text||((audit_row->'after_state')-'person_id')::text))>0
      or exists(select 1 from public.internal_org_people person where person.id<>p_source and position(person.id::text in lower(((audit_row->'after_state')-'person_id')::text))>0)
      or exists(select 1 from private.portal_account_admin_events other where other.target_user_id::text=audit_row->>'target_user_id' and other.event_type='account_linked' and other.after_state->>'person_id' is distinct from p_source::text)
      or not exists(select 1 from public.internal_org_people where id=p_source and not is_active and auth_user_id is null)
      or not exists(select 1 from public.profiles profile join auth.users account on account.id=profile.id
        where profile.id::text=audit_row->>'target_user_id' and profile.app_role='employee' and profile.account_status='disabled'
          and profile.account_version >= (audit_row->'after_state'->>'account_version')::bigint
          and not exists(select 1 from public.internal_org_people person where person.auth_user_id=profile.id)) then
      raise exception 'Unsupported historical account audit shape.' using errcode='23514';
    end if;
  end loop;
  if exists(select 1 from public.internal_org_people where parent_id=p_source) then
    raise exception 'Source reporting descendants require separate review.' using errcode='23514';
  end if;
  select to_jsonb(d) into source_row from private.employee_directory_details d where person_id=p_source;
  select to_jsonb(d) into target_detail from private.employee_directory_details d where person_id=p_target;
  for k in select jsonb_object_keys(coalesce(source_row,'{}'::jsonb)-array['person_id','first_name','last_name','created_at','updated_at','created_by','updated_by','version','archive_reason']) loop
    if source_row->k not in ('null'::jsonb,'""'::jsonb,'[]'::jsonb)
      and source_row->k is distinct from target_detail->k
      and not (p_historical_source_provenance_confirmed is true and k='working_schedule_initial_setup_completed' and source_row->k='false'::jsonb and target_detail->k='true'::jsonb and exists(select 1 from public.internal_org_people where id=p_target and is_active)) then
      raise exception 'Conflicting source detail field: %',k using errcode='23514';
    end if;
  end loop;
  if exists(select 1 from private.employee_check_in_reminders s where s.person_id=p_source
    and (s.delivery_status not in ('delivered','completed','superseded','cancelled')
      or (s.claim_token is not null and s.delivery_status not in ('delivered','completed'))
      or exists(select 1 from private.employee_check_in_reminders t where t.person_id=p_target and t.milestone=s.milestone
        and t.reminder_sequence=s.reminder_sequence and (t.due_date=s.due_date or t.delivery_status in ('scheduled','claimed','needs_review'))))) then
    raise exception 'Check-in schedule collision or unsettled delivery requires review.' using errcode='23514';
  end if;

end;
$$;

create function public.prepare_employee_identity_consolidation(p_source uuid,p_target uuid,p_confirmed_pair_reference text,p_excluded_test_person_ids uuid[],p_historical_inactive_confirmed boolean default false,p_historical_source_provenance_confirmed boolean default false)
returns jsonb language plpgsql security definer set search_path='' as $$
declare actor uuid; s public.internal_org_people%rowtype; t public.internal_org_people%rowtype; ids uuid[]; parent_runs jsonb;
begin
  actor := private.assert_employee_identity_actor();
  if p_source is null or p_target is null or p_source=p_target or nullif(btrim(p_confirmed_pair_reference),'') is null
    or p_excluded_test_person_ids is null or array_position(p_excluded_test_person_ids,null) is not null
    or p_target=any(p_excluded_test_person_ids) then
    raise exception 'A confirmed distinct identity pair and verified test exclusion list are required.' using errcode='23514';
  end if;
  if exists(select 1 from private.employee_identity_consolidations where source_person_id in (p_source,p_target)) then
    raise exception 'Choose current canonical identities; use the original plan for retry.' using errcode='23514';
  end if;
  select * into s from public.internal_org_people where id=p_source;
  select * into t from public.internal_org_people where id=p_target;
  if s.id is null or t.id is null or s.node_kind<>'person' or t.node_kind<>'person' or s.company_key<>t.company_key
    or s.auth_user_id is not null
    or (not t.is_active and (s.is_active or p_historical_inactive_confirmed is distinct from true))
    or (p_historical_inactive_confirmed is true and (s.is_active or t.is_active))
    or (s.started_date is not null and s.started_date is distinct from t.started_date)
    or (s.position_title is distinct from t.position_title and p_historical_source_provenance_confirmed is distinct from true)
    or (s.parent_id is not null and s.parent_id is distinct from t.parent_id) then
    raise exception 'Identity, account or employment conflict; retain the account-linked canonical target.' using errcode='23514';
  end if;
  if p_historical_source_provenance_confirmed is true and (s.is_active or s.started_date is not null
    or (select count(*) from private.employee_roster_import_row_map where person_id=p_source)<>1
    or not exists(select 1 from private.employee_roster_import_row_map m join private.employee_roster_import_runs run on run.id=m.run_id
      where m.person_id=p_source and m.source_person_id=p_source and m.operation='archived' and m.source_row_number is null and m.source_row_sha256 is null
        and run.status='applied' and m.original_row->>'person_id'=p_source::text and m.original_row->>'source_person_id'=p_source::text
        and m.original_row->>'operation'='archived' and m.original_row->>'source_row_number' is null and m.original_row->>'source_row_sha256' is null
        and m.original_row->>'run_id'=m.run_id::text)) then
    raise exception 'Historical source provenance requires an inactive unlinked undated archived-roster source.' using errcode='23514';
  end if;
  if t.auth_user_id is not null and ((t.is_active and not private.is_active_portal_account(t.auth_user_id))
    or (not t.is_active and not exists(select 1 from public.profiles where id=t.auth_user_id and account_status='disabled'))
    or exists(select 1 from public.internal_org_people where auth_user_id=t.auth_user_id and id<>t.id)) then
    raise exception 'Canonical account is inactive or shared.' using errcode='23514';
  end if;

  perform private.assert_employee_identity_dependencies(p_source,p_target,p_historical_source_provenance_confirmed);
  select coalesce(jsonb_agg(to_jsonb(run) order by run.id),'[]'::jsonb) into parent_runs from private.employee_roster_import_runs run
    where exists(select 1 from private.employee_roster_import_row_map m where m.run_id=run.id and (m.person_id=p_source or m.manager_person_id=p_source));
  ids := array_remove(array[p_source,p_target,t.auth_user_id,actor],null) || array(select distinct target_user_id from private.portal_account_admin_events where after_state->>'person_id'=p_source::text and target_user_id is not null) || array(select auth_user_id from private.portal_password_reset_claims where person_id=p_source);
  return jsonb_build_object('source_person_id',p_source,'canonical_person_id',p_target,'actor_user_id',actor,
    'confirmed_pair_reference',p_confirmed_pair_reference,'excluded_test_person_ids',to_jsonb(p_excluded_test_person_ids),
    'historical_inactive_confirmed',p_historical_inactive_confirmed,'historical_source_provenance_confirmed',p_historical_source_provenance_confirmed,
    'historical_account_audit_sha256',encode(extensions.digest(coalesce(private.employee_identity_snapshot(array[p_source])->'private.portal_account_admin_events','[]'::jsonb)::text,'sha256'),'hex'),
    'source_version',s.version,'target_version',t.version,'dependency_fingerprint',md5(jsonb_build_array(private.employee_identity_snapshot(ids),parent_runs)::text));
end;
$$;

create function public.apply_employee_identity_consolidation(p_reviewed_plan jsonb)
returns uuid language plpgsql security definer set search_path='' as $$
declare actor uuid; source_id uuid; target_id uuid; fresh jsonb; r record; excluded uuid[]; snapshot jsonb; parent_runs jsonb; receipt private.employee_identity_consolidations%rowtype;
begin
  if current_setting('transaction_isolation') is distinct from 'read committed' then
    raise exception 'Employee identity mutations require READ COMMITTED isolation.' using errcode='25001';
  end if;
  actor := private.assert_employee_identity_actor();
  source_id := (p_reviewed_plan->>'source_person_id')::uuid;
  target_id := (p_reviewed_plan->>'canonical_person_id')::uuid;
  if actor is distinct from (p_reviewed_plan->>'actor_user_id')::uuid then raise exception 'Reviewed actor does not match the session.' using errcode='42501'; end if;
  if not pg_try_advisory_xact_lock(hashtextextended('internal_org_people_hierarchy',0)) then
    raise exception 'Identity writers are active; retry with a fresh reviewed plan.' using errcode='55P03';
  end if;
  for r in select n.nspname,c.relname from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid=c.relnamespace
    where n.nspname <> 'information_schema' and n.nspname !~ '^pg_' and c.relkind in ('r','p') and not c.relispartition order by n.nspname,c.relname
  loop execute format('lock table %I.%I in %s mode nowait',r.nspname,r.relname,case when (r.nspname,r.relname) in (('storage','migrations'),('storage','buckets_vectors'),('storage','vector_indexes'),('auth','schema_migrations')) then 'access share' else 'exclusive' end); end loop;
  perform private.assert_employee_identity_actor();
  select * into receipt from private.employee_identity_consolidations where source_person_id=source_id;
  if found then
    if receipt.reviewed_plan is distinct from p_reviewed_plan or receipt.canonical_person_id<>target_id
      or not exists(select 1 from public.internal_org_people where id=target_id) then
      raise exception 'Retry does not match the committed receipt.' using errcode='23514';
    end if;
    return target_id;
  end if;
  select array_agg(value::uuid) into excluded from jsonb_array_elements_text(p_reviewed_plan->'excluded_test_person_ids');
  if p_reviewed_plan->'excluded_test_person_ids'='[]'::jsonb then excluded:=array[]::uuid[]; end if;
  fresh := public.prepare_employee_identity_consolidation(source_id,target_id,p_reviewed_plan->>'confirmed_pair_reference',excluded,(p_reviewed_plan->>'historical_inactive_confirmed')::boolean,(p_reviewed_plan->>'historical_source_provenance_confirmed')::boolean);
  if fresh is distinct from p_reviewed_plan then raise exception 'Identity or dependencies changed since review.' using errcode='40001'; end if;
  snapshot := private.employee_identity_snapshot(array[source_id]);
  select coalesce(jsonb_agg(to_jsonb(run) order by run.id),'[]'::jsonb) into parent_runs from private.employee_roster_import_runs run
    where exists(select 1 from private.employee_roster_import_row_map m where m.run_id=run.id and (m.person_id=source_id or m.manager_person_id=source_id));
  if parent_runs<>'[]'::jsonb then snapshot:=snapshot||jsonb_build_object('private.employee_roster_import_runs',parent_runs); end if;
  insert into private.employee_identity_consolidations(source_person_id,canonical_person_id,actor_user_id,confirmed_pair_reference,
    source_company_key,source_name_key,reviewed_plan,archived_rows)
  select source_id,target_id,actor,p_reviewed_plan->>'confirmed_pair_reference',company_key,
    lower(regexp_replace(full_name,'[^[:alnum:]]','','g')),p_reviewed_plan,snapshot from public.internal_org_people where id=source_id;
  update private.employee_annual_leave_balances set person_id=target_id where person_id=source_id;
  update private.employee_sick_leave_balances set person_id=target_id where person_id=source_id;
  update private.annual_leave_balance_history set person_id=target_id where person_id=source_id;
  update private.sick_leave_balance_history set person_id=target_id where person_id=source_id;
  update private.payroll_balance_imports set person_id=target_id where person_id=source_id;
  update private.portal_password_reset_claims set person_id=target_id where person_id=source_id;
  update private.employee_roster_import_row_map set person_id=target_id where person_id=source_id;
  update private.employee_roster_import_row_map set manager_person_id=target_id where manager_person_id=source_id;
  update private.employee_check_in_reminders set person_id=target_id where person_id=source_id;
  delete from public.internal_org_people where id=source_id;
  if exists(select 1 from public.internal_org_people where id=source_id)
    or private.employee_identity_snapshot(array[source_id]) <> '{}'::jsonb then
    raise exception 'Unresolved source reference; consolidation rolled back.' using errcode='23514';
  end if;
  return target_id;
end;
$$;

create function public.read_employee_identity_consolidation(p_source uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare receipt private.employee_identity_consolidations%rowtype;
begin
  perform private.assert_employee_identity_actor();
  select * into receipt from private.employee_identity_consolidations where source_person_id=p_source;
  if not found then raise exception 'No completed consolidation receipt.' using errcode='23514'; end if;
  return jsonb_build_object('phase','complete','source_person_id',receipt.source_person_id,'canonical_person_id',receipt.canonical_person_id,
    'actor_user_id',receipt.actor_user_id,'confirmed_pair_reference',receipt.confirmed_pair_reference,'reviewed_plan',receipt.reviewed_plan,
    'receipt_hash',encode(extensions.digest(jsonb_build_array(receipt.source_person_id,receipt.canonical_person_id,receipt.actor_user_id,receipt.confirmed_pair_reference,receipt.reviewed_plan,receipt.archived_rows)::text,'sha256'),'hex'),
    'source_absent',not exists(select 1 from public.internal_org_people where id=receipt.source_person_id),
    'canonical_present',exists(select 1 from public.internal_org_people where id=receipt.canonical_person_id));
end;
$$;
revoke all on function public.read_employee_identity_consolidation(uuid) from public,anon,authenticated,service_role;
grant execute on function public.read_employee_identity_consolidation(uuid) to authenticated;

create function private.prevent_retired_employee_identity_recreation()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if exists(select 1 from private.employee_identity_consolidations a where a.source_person_id=new.id) then
    raise exception 'Retired employee identity: resolve the confirmed canonical import mapping.' using errcode='23514';
  end if;
  return new;
end;
$$;
create trigger prevent_retired_employee_identity_recreation before insert or update of id,full_name,company_key,node_kind on public.internal_org_people
for each row execute function private.prevent_retired_employee_identity_recreation();

create function private.resolve_consolidated_employee_import(p_company_key text,p_source_person_id uuid,p_source_name text)
returns uuid language plpgsql security definer set search_path='' as $$
declare result uuid;
begin
  perform private.assert_employee_identity_actor();

  select canonical_person_id into result from private.employee_identity_consolidations where source_company_key=p_company_key
    and source_person_id=p_source_person_id;
  if found and not exists(select 1 from public.internal_org_people where id=result and company_key=p_company_key) then
    raise exception 'Canonical import target is no longer present.' using errcode='23514';
  end if;
  return result;
end;
$$;

alter table private.employee_roster_import_runs add column canonical_replay_manifest jsonb;
create function private.protect_canonical_employee_roster_run()
returns trigger language plpgsql set search_path='' as $$
begin
  if old.canonical_replay_manifest is not null then
    raise exception 'Canonical roster replay provenance is immutable.' using errcode='23514';
  end if;
  if tg_op='DELETE' then return old; end if;
  return new;
end;
$$;
create trigger protect_canonical_employee_roster_run before update or delete on private.employee_roster_import_runs
for each row execute function private.protect_canonical_employee_roster_run();
revoke all on function private.protect_canonical_employee_roster_run() from public,anon,authenticated,service_role;

create function public.replay_canonical_employee_roster(p_run_id uuid,p_workbook_sha256 text,p_source_rows jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare actor uuid; entry jsonb; source_id uuid; target_id uuid; resolved jsonb:='[]'; readback jsonb; manifest jsonb;
  old_run private.employee_roster_import_runs%rowtype; row_count integer; canonical_count integer; account_count integer; completed timestamptz;
begin
  if current_setting('transaction_isolation') is distinct from 'read committed' then
    raise exception 'Employee identity mutations require READ COMMITTED isolation.' using errcode='25001';
  end if;
  actor:=private.assert_employee_identity_actor();
  if p_run_id is null or p_workbook_sha256 is null or p_workbook_sha256 !~ '^[0-9a-f]{64}$' or jsonb_typeof(p_source_rows) is distinct from 'array' then
    raise exception 'A literal workbook digest and strict source-row array are required.' using errcode='23514';
  end if;
  row_count:=jsonb_array_length(p_source_rows);
  if row_count not between 1 and 500 then raise exception 'Canonical roster replay requires 1 to 500 rows.' using errcode='23514'; end if;
  for entry in select value from jsonb_array_elements(p_source_rows) loop
    if jsonb_typeof(entry) is distinct from 'object' then raise exception 'Invalid canonical roster source row.' using errcode='23514'; end if;
    if (select array_agg(key order by key) from jsonb_object_keys(entry) key) is distinct from array['company_key','source_person_id','source_row_number','source_row_sha256']
      or jsonb_typeof(entry->'source_person_id') is distinct from 'string' or entry->>'source_person_id' !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
      or jsonb_typeof(entry->'company_key') is distinct from 'string' or entry->>'company_key' not in ('mam','equipsy')
      or jsonb_typeof(entry->'source_row_number') is distinct from 'number' or entry->>'source_row_number' !~ '^[1-9][0-9]{0,9}$'
      or jsonb_typeof(entry->'source_row_sha256') is distinct from 'string' or entry->>'source_row_sha256' !~ '^[0-9a-f]{64}$' then
      raise exception 'Invalid canonical roster source row.' using errcode='23514';
    end if;
    if (entry->>'source_row_number')::numeric>2147483647 then raise exception 'Invalid canonical roster source row number.' using errcode='23514'; end if;
  end loop;
  if (select count(distinct (value->>'source_person_id')::uuid) from jsonb_array_elements(p_source_rows))<>row_count
    or (select count(distinct (value->>'source_row_number')::integer) from jsonb_array_elements(p_source_rows))<>row_count then
    raise exception 'Duplicate canonical roster source identity or row number.' using errcode='23514';
  end if;
  if not pg_try_advisory_xact_lock(hashtextextended('internal_org_people_hierarchy',0))
    or not pg_try_advisory_xact_lock(hashtextextended('canonical-employee-roster:'||p_run_id::text,0)) then
    raise exception 'Canonical roster writers are active.' using errcode='55P03';
  end if;
  lock table auth.users,public.profiles,public.internal_org_people,private.employee_identity_consolidations,private.employee_roster_import_runs,private.employee_roster_import_row_map in exclusive mode nowait;
  perform private.assert_employee_identity_actor();
  for entry in select value from jsonb_array_elements(p_source_rows) order by (value->>'source_row_number')::integer loop
    source_id:=(entry->>'source_person_id')::uuid;
    target_id:=private.resolve_consolidated_employee_import(entry->>'company_key',source_id,null);
    if target_id is null then
      select id into target_id from public.internal_org_people where id=source_id and company_key=entry->>'company_key' and node_kind='person';
    end if;
    if target_id is null or not exists(select 1 from public.internal_org_people p where p.id=target_id and p.company_key=entry->>'company_key' and p.node_kind='person'
      and (p.is_active or p.auth_user_id is null or exists(select 1 from public.profiles account where account.id=p.auth_user_id and account.account_status='disabled'))) then
      raise exception 'Unknown, cross-company or unsafe canonical roster identity.' using errcode='23514';
    end if;
    resolved:=resolved||jsonb_build_array(jsonb_build_object('source_person_id',source_id,'person_id',target_id,'source_row_number',(entry->>'source_row_number')::integer,'source_row_sha256',entry->>'source_row_sha256','company_key',entry->>'company_key'));
  end loop;
  select count(distinct value->>'person_id') into canonical_count from jsonb_array_elements(resolved);
  select count(*) into account_count from public.internal_org_people where id in (select (value->>'person_id')::uuid from jsonb_array_elements(resolved)) and auth_user_id is not null;
  manifest:=jsonb_build_object('adapter','confirmed-source-v1','rows',resolved);
  select * into old_run from private.employee_roster_import_runs where id=p_run_id;
  if found then
    if old_run.canonical_replay_manifest is distinct from manifest or old_run.workbook_sha256 is distinct from p_workbook_sha256
      or old_run.status<>'applied' or old_run.source_row_count<>row_count or old_run.created_by is distinct from actor or old_run.completed_by is distinct from actor
      or old_run.completed_at is null or old_run.completed_at<old_run.created_at or old_run.failure_class is not null
      or old_run.created_person_count<>0 or old_run.updated_person_count<>0 or old_run.archived_person_count<>0
      or old_run.unchanged_person_count<>canonical_count or old_run.preserved_account_count<>account_count then
      raise exception 'Existing run does not exactly match this canonical replay.' using errcode='23514';
    end if;
  else
    completed:=clock_timestamp();
    insert into private.employee_roster_import_runs(id,workbook_sha256,source_row_count,status,created_at,completed_at,created_by,completed_by,
      created_person_count,updated_person_count,unchanged_person_count,archived_person_count,preserved_account_count,failure_class,canonical_replay_manifest)
    values(p_run_id,p_workbook_sha256,row_count,'applied',completed,completed,actor,actor,0,0,canonical_count,0,account_count,null,manifest);
    insert into private.employee_roster_import_row_map(run_id,source_person_id,person_id,source_row_number,source_row_sha256,operation,auth_user_id,manager_source_kind,manager_person_id,external_manager_root_id)
      select p_run_id,(value->>'source_person_id')::uuid,(value->>'person_id')::uuid,(value->>'source_row_number')::integer,value->>'source_row_sha256','unchanged',null,'none',null,null from jsonb_array_elements(resolved);
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('source_person_id',m.source_person_id,'person_id',m.person_id,'source_row_number',m.source_row_number,'source_row_sha256',m.source_row_sha256,'company_key',p.company_key) order by m.source_row_number),'[]'::jsonb)
    into readback from private.employee_roster_import_row_map m join public.internal_org_people p on p.id=m.person_id where m.run_id=p_run_id;
  if readback is distinct from resolved or (select count(*) from private.employee_roster_import_row_map where run_id=p_run_id)<>row_count
    or exists(select 1 from private.employee_roster_import_row_map m where m.run_id=p_run_id and
      (m.operation<>'unchanged' or m.auth_user_id is not null or m.manager_source_kind<>'none' or m.manager_person_id is not null or m.external_manager_root_id is not null
        or (m.original_row-'created_at') is distinct from (to_jsonb(m)-array['original_row','created_at']) or (m.original_row->>'created_at')::timestamptz is distinct from m.created_at)) then
    raise exception 'Canonical roster map readback mismatch.' using errcode='23514';
  end if;
  return jsonb_build_object('run_id',p_run_id,'phase','applied','mapped_row_count',row_count,'canonical_person_count',canonical_count,'rows',readback);
end;
$$;
revoke all on function public.replay_canonical_employee_roster(uuid,text,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.replay_canonical_employee_roster(uuid,text,jsonb) to authenticated;

revoke all on function private.employee_identity_dependency_manifest(), private.employee_identity_snapshot(uuid[]),private.assert_employee_identity_actor(),
  private.assert_employee_identity_dependencies(uuid,uuid,boolean),private.prevent_retired_employee_identity_recreation(),
  private.resolve_consolidated_employee_import(text,uuid,text) from public,anon,authenticated,service_role;
revoke all on function public.prepare_employee_identity_consolidation(uuid,uuid,text,uuid[],boolean,boolean),public.apply_employee_identity_consolidation(jsonb) from public,anon,authenticated,service_role;
grant execute on function public.prepare_employee_identity_consolidation(uuid,uuid,text,uuid[],boolean,boolean),public.apply_employee_identity_consolidation(jsonb) to authenticated;
CREATE OR REPLACE FUNCTION public.list_employee_directory_records_with_archive_visibility(p_include_archived boolean DEFAULT false)
 RETURNS TABLE(person_id uuid, person_version bigint, detail_version bigint, company_key text, is_active boolean, first_name text, last_name text, full_name text, position_title text, team_name text, manager_id uuid, manager_name text, work_email text, personal_email text, phone text, country text, address text, date_of_birth date, started_date date, scheduled_employment_end_date date, archive_reason text, employment_type text, has_paid_leave_entitlement boolean, laptop_supplied text, laptop_id text, mouse_id text, keyboard_id text, asset_tags text[])
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if not private.can_view_archived_employee_profiles() then
    raise exception 'Only authorised HR and global reviewers can access employee directory records.'
      using errcode = '42501';
  end if;

  return query
  select
    person.id,
    person.version,
    coalesce(detail.version, 0::bigint),
    person.company_key,
    person.is_active,
    detail.first_name,
    detail.last_name,
    person.full_name,
    person.position_title,
    detail.team_name,
    manager.manager_id,
    manager.manager_name,
    detail.work_email,
    detail.personal_email,
    detail.phone,
    detail.country,
    detail.address,
    detail.date_of_birth,
    person.started_date,
    detail.scheduled_employment_end_date,
    detail.archive_reason,
    detail.employment_type,
    coalesce(detail.employment_type in ('full_time', 'part_time'), false),
    detail.laptop_supplied,
    detail.laptop_id,
    detail.mouse_id,
    detail.keyboard_id,
    coalesce(detail.asset_tags, array[]::text[])
  from public.internal_org_people person
  left join private.employee_directory_details detail
    on detail.person_id = person.id
  left join lateral private.resolve_internal_org_employee_manager(person.id) manager on true
  where person.node_kind = 'person'
    and (
      person.is_active
      or (
        coalesce(p_include_archived, false)
        and (detail.archive_reason is not null or exists (select 1 from private.employee_identity_consolidations consolidation where consolidation.canonical_person_id=person.id and consolidation.reviewed_plan->>'historical_inactive_confirmed'='true'))
      )
    )
  order by person.is_active desc, lower(person.full_name), person.id;
end;
$function$;
-- Forward compatibility for the already-reviewed exact-bank identity transfer.
-- This definition is embedded in the identity migration, never applied alone.
create or replace function private.payroll_closing_snapshot_guard() returns trigger
language plpgsql security definer set search_path='' as $$
declare person uuid; receipt uuid; actor uuid;
begin
  person:=case when tg_op='DELETE' then old.person_id else new.person_id end;
  if tg_op='UPDATE' and new.person_id is distinct from old.person_id then
    if tg_table_schema='private' and tg_table_name in ('employee_annual_leave_balances','employee_sick_leave_balances') then
      if old.closing_receipt_id is not null then
        raise exception 'Payroll snapshot identity cannot change.' using errcode='55000';
      end if;
    end if;
    actor:=private.assert_employee_identity_actor();
    if tg_table_schema='private' and tg_table_name in ('employee_annual_leave_balances','employee_sick_leave_balances')
      and to_jsonb(new)-'person_id'=to_jsonb(old)-'person_id'
      and old.closing_receipt_id is null
      and exists(select 1 from private.employee_identity_consolidations c
        join public.internal_org_people source on source.id=c.source_person_id
        join public.internal_org_people target on target.id=c.canonical_person_id
        where c.source_person_id=old.person_id and c.canonical_person_id=new.person_id
          and c.actor_user_id=actor and c.reviewed_plan->>'actor_user_id'=actor::text
          and c.reviewed_plan->>'source_person_id'=old.person_id::text
          and c.reviewed_plan->>'canonical_person_id'=new.person_id::text
          and not source.is_active and source.auth_user_id is null
          and source.company_key=c.source_company_key and target.company_key=c.source_company_key
          and target.is_active and target.auth_user_id is not null
          and exists(select 1 from jsonb_array_elements(c.archived_rows->(tg_table_schema||'.'||tg_table_name)) archived
            where archived=to_jsonb(old))) then
      -- Return the unchanged full row apart from its reviewed owner. Do not
      -- reset a closing receipt, synthesize claims, or reinterpret economics.
      return new;
    end if;
    raise exception 'Payroll snapshot identity cannot change.' using errcode='55000';
  end if;
  select receipt_id into receipt from private.payroll_closing_write_claims where person_id=person and transaction_id=pg_current_xact_id();
  if exists(select 1 from (select distinct on(request_id) * from private.payroll_carryforward_events where person_id=person order by request_id,id desc) e where pending_hours>0 or accounted_hours>0)
    and receipt is null then
    raise exception 'Use audited payroll reconciliation for retained commitments.' using errcode='55000';
  end if;
  if tg_op='DELETE' then return old; end if;
  new.closing_receipt_id:=receipt;
  return new;
end;
$$;

do $identity_guard$ declare query text; validation_sql text; previous_hash text:=current_setting('mam.identity_previous_hash'); normalized_hash text; candidate_hash text; verified boolean; final_normalized_hash text; final_candidate_hash text; final_verified boolean; reviewed_functions oid[]; reviewed_triggers oid[]; begin
  select prosrc into query from pg_proc where oid='private.confirmed_test_purge_schema_hash()'::regprocedure;
  if encode(extensions.digest(query,'sha256'),'hex')<>'c142665fb247c8761de408ce241e2f97aabe719c5d0801a5c53905892dd3de16' then raise exception 'Purge schema hash implementation changed' using errcode='55000'; end if;
  query:=replace(query,'pg_get_functiondef(p.oid)','case when p.oid=''public.list_employee_directory_records_with_archive_visibility(boolean)''::regprocedure then $1 when p.oid=''private.payroll_closing_snapshot_guard()''::regprocedure then $4 else pg_get_functiondef(p.oid) end');
  query:=replace(query,'and p.prokind=''f''','and p.prokind=''f'' and p.oid<>all($2)');
  query:=replace(query,'and c.relkind in (''r'',''p'',''v'',''m'')','and c.relkind in (''r'',''p'',''v'',''m'') and c.oid<>''private.employee_identity_consolidations''::regclass');
  query:=replace(query,'and a.attnum>0 and not a.attisdropped','and a.attnum>0 and not a.attisdropped and a.attrelid<>all(array[''private.employee_identity_consolidations''::regclass,''private.employee_identity_consolidations_pkey''::regclass]) and not (a.attrelid=''private.employee_roster_import_row_map''::regclass and a.attname in (''source_person_id'',''original_row'')) and not (a.attrelid=''private.employee_roster_import_runs''::regclass and a.attname=''canonical_replay_manifest'')');
  query:=replace(query,'a.attname||'':''||format_type','case when a.attrelid=''private.employee_roster_import_row_map_run_person_idx''::regclass and a.attname=''source_person_id'' then ''person_id'' else a.attname end||'':''||format_type');
  query:=replace(query,'from pg_constraint where','from (select * from pg_constraint where conrelid<>''private.employee_identity_consolidations''::regclass) pg_constraint where');
  query:=replace(query,'from pg_trigger t join','from (select * from pg_trigger where oid<>all($3)) t join');
  query:=regexp_replace(query,';[[:space:]]*$','');
  validation_sql:=format($verified$
    select normalized.schema_hash, private.confirmed_test_purge_schema_hash(),
      (select bool_and(coalesce(encode(extensions.digest(pg_get_functiondef(to_regprocedure(signature)),'sha256'),'hex')=definition_sha256,false)) from (values
          ('public.replay_canonical_employee_roster(uuid,text,jsonb)','c132a731e4fd7f8852ef678daf766d7117ae3c55506dd598a18a1d12ad0f611f'),
          ('private.protect_canonical_employee_roster_run()','aa06edf3edc7623d5d173ea7fab2339ba045cfda057e983669ce37453e632775'),
          ('public.read_employee_identity_consolidation(uuid)','0c6095e07cfbe555f1b8f166f674af7ac49dcff098406ac5131b84a5653d98fb'),
          ('private.assert_employee_identity_actor()','8e210d842b4457e5b02d1efd36643ceb9afe284f91b019aa1c0bebef15028104'),
          ('private.assert_employee_identity_dependencies(uuid,uuid,boolean)','9e8666e76deea33134ac45d16c6499a49a08ac39a86c04243f4606343f019085'),
          ('private.employee_identity_dependency_manifest()','5701b1565e2cd2bb3a0b97e977ce3052ce555f728fa0345aa0fb3fffa4fef1ff'),
          ('private.payroll_closing_snapshot_guard()','cfa2d5e78095d24027a37c973d3b895f93edc2dfa22fb8b1dee1303544fb8512'),
          ('private.employee_identity_retained_account_audit(jsonb)','ad9e5612401900344dce730830970b2179c6c73a41f5f5b9b39b895bfc759ac4'),
          ('private.employee_identity_snapshot(uuid[])','73d74ae4b31ba2751405c42ed5b604793dc7d8d103dcc97587777b56e235ee58'),
          ('private.prevent_retired_employee_identity_recreation()','c91e18d7657ff3cdf5859e531c912b39bfefc65f8466470c60c81f1204dbb84f'),
          ('private.protect_employee_identity_consolidation_receipt()','413fd8c83fe012d06dde9cfba9d81516e02180f395c610f826e5afc7519c046e'),
          ('private.protect_employee_roster_original_row()','a8fc2f25d631cbc8ea196b777f69423ee84d78e06d3e5ec4143a2ad36d5cc086'),
          ('private.resolve_consolidated_employee_import(text,uuid,text)','fb1565e42a3cc2a0927fc1542d7cff586b9a7a0bf51a80c07177ef101cbb7d69'),
          ('public.apply_employee_identity_consolidation(jsonb)','e829ade2c5a6c1015e29d26f88b9310cbc6822b78b092535a62e9f414d0d27de'),
          ('public.list_employee_directory_records_with_archive_visibility(boolean)','d66c4c89e2a56c270e4bc0570cf80139146d3a4164dd8b1ee2fcb1f93c6cdc6b'),
          ('public.prepare_employee_identity_consolidation(uuid,uuid,text,uuid[],boolean,boolean)','781b19e36294936d50cbd52e9fe6ac9fe2b1a4338474864de3e7a7decccf5018')
      ) expected(signature,definition_sha256))
      and not exists(select 1 from pg_proc p where p.oid=any($2) and (p.proowner<>(select proowner from pg_proc where oid='private.confirmed_test_purge_schema_hash()'::regprocedure)
        or exists(select 1 from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a where a.privilege_type<>'EXECUTE' or (a.grantee<>p.proowner and not (p.oid in ('public.replay_canonical_employee_roster(uuid,text,jsonb)'::regprocedure,'public.read_employee_identity_consolidation(uuid)'::regprocedure,'public.prepare_employee_identity_consolidation(uuid,uuid,text,uuid[],boolean,boolean)'::regprocedure,'public.apply_employee_identity_consolidation(jsonb)'::regprocedure) and a.grantee='authenticated'::regrole)))
        or (p.oid in ('public.replay_canonical_employee_roster(uuid,text,jsonb)'::regprocedure,'public.read_employee_identity_consolidation(uuid)'::regprocedure,'public.prepare_employee_identity_consolidation(uuid,uuid,text,uuid[],boolean,boolean)'::regprocedure,'public.apply_employee_identity_consolidation(jsonb)'::regprocedure) and not has_function_privilege('authenticated',p.oid,'EXECUTE'))))
      and (select relrowsecurity and relforcerowsecurity and relowner=(select proowner from pg_proc where oid='private.confirmed_test_purge_schema_hash()'::regprocedure)
        and not exists(select 1 from aclexplode(coalesce(relacl,acldefault('r',relowner))) a where a.grantee<>relowner)
        from pg_class where oid='private.employee_identity_consolidations'::regclass)
      and not exists(select 1 from pg_attribute a where a.attrelid='private.employee_identity_consolidations'::regclass and a.attacl is not null)
      and not exists(select 1 from pg_policy where polrelid='private.employee_identity_consolidations'::regclass)
      and (select jsonb_build_object(
 'columns',(select jsonb_agg(jsonb_build_array(a.attname,format_type(a.atttypid,a.atttypmod),a.attnotnull,coalesce(pg_get_expr(d.adbin,d.adrelid),'')) order by a.attnum) from pg_attribute a left join pg_attrdef d on d.adrelid=a.attrelid and d.adnum=a.attnum where a.attrelid='private.employee_identity_consolidations'::regclass and a.attnum>0 and not a.attisdropped),
 'constraints',(select jsonb_agg(jsonb_build_array(conname,pg_get_constraintdef(oid)) order by conname) from pg_constraint where conrelid='private.employee_identity_consolidations'::regclass),
 'triggers',(select jsonb_agg(jsonb_build_array(tgrelid::regclass::text,tgname,tgenabled,pg_get_triggerdef(oid)) order by tgrelid::regclass::text,tgname) from pg_trigger where not tgisinternal and ((tgrelid='private.employee_identity_consolidations'::regclass) or (tgrelid='private.employee_roster_import_row_map'::regclass and tgname='protect_employee_roster_original_row') or (tgrelid='public.internal_org_people'::regclass and tgname='prevent_retired_employee_identity_recreation')))))='{"columns":[["source_person_id","uuid",true,""],["canonical_person_id","uuid",true,""],["actor_user_id","uuid",true,""],["confirmed_pair_reference","text",true,""],["source_company_key","text",true,""],["source_name_key","text",true,""],["reviewed_plan","jsonb",true,""],["archived_rows","jsonb",true,""],["created_at","timestamp with time zone",true,"clock_timestamp()"]],"triggers":[["private.employee_identity_consolidations","protect_employee_identity_consolidation_receipt","O","CREATE TRIGGER protect_employee_identity_consolidation_receipt BEFORE DELETE OR UPDATE ON private.employee_identity_consolidations FOR EACH ROW EXECUTE FUNCTION private.protect_employee_identity_consolidation_receipt()"],["private.employee_identity_consolidations","reject_retired_test_identity_reference","O","CREATE TRIGGER reject_retired_test_identity_reference BEFORE INSERT OR UPDATE ON private.employee_identity_consolidations FOR EACH ROW EXECUTE FUNCTION private.reject_retired_test_identity_reference()"],["private.employee_roster_import_row_map","protect_employee_roster_original_row","O","CREATE TRIGGER protect_employee_roster_original_row BEFORE INSERT OR UPDATE ON private.employee_roster_import_row_map FOR EACH ROW EXECUTE FUNCTION private.protect_employee_roster_original_row()"],["public.internal_org_people","prevent_retired_employee_identity_recreation","O","CREATE TRIGGER prevent_retired_employee_identity_recreation BEFORE INSERT OR UPDATE OF id, full_name, company_key, node_kind ON public.internal_org_people FOR EACH ROW EXECUTE FUNCTION private.prevent_retired_employee_identity_recreation()"]],"constraints":[["employee_identity_consolidations_actor_user_id_fkey","FOREIGN KEY (actor_user_id) REFERENCES auth.users(id) ON DELETE RESTRICT"],["employee_identity_consolidations_canonical_person_id_fkey","FOREIGN KEY (canonical_person_id) REFERENCES public.internal_org_people(id) ON DELETE RESTRICT"],["employee_identity_consolidations_check","CHECK ((source_person_id <> canonical_person_id))"],["employee_identity_consolidations_pkey","PRIMARY KEY (source_person_id)"]]}'::jsonb
      and (select jsonb_agg(jsonb_build_array(a.attname,format_type(a.atttypid,a.atttypmod),a.attnotnull,coalesce(pg_get_expr(d.adbin,d.adrelid),''),a.attacl) order by a.attname)
        from pg_attribute a left join pg_attrdef d on d.adrelid=a.attrelid and d.adnum=a.attnum
        where a.attrelid='private.employee_roster_import_row_map'::regclass and a.attname in ('source_person_id','original_row'))='[["original_row","jsonb",true,"",null],["source_person_id","uuid",false,"",null]]'::jsonb
      and (select jsonb_build_array(a.attname,format_type(a.atttypid,a.atttypmod),a.attnotnull,coalesce(pg_get_expr(d.adbin,d.adrelid),''),a.attacl) from pg_attribute a left join pg_attrdef d on d.adrelid=a.attrelid and d.adnum=a.attnum where a.attrelid='private.employee_roster_import_runs'::regclass and a.attname='canonical_replay_manifest')='["canonical_replay_manifest","jsonb",false,"",null]'::jsonb
      and not exists(select 1 from pg_attribute a cross join (values ('anon'),('authenticated'),('service_role')) application_role(name)
        where a.attnum>0 and not a.attisdropped and (a.attrelid='private.employee_identity_consolidations'::regclass
          or (a.attrelid='private.employee_roster_import_row_map'::regclass and a.attname in ('source_person_id','original_row'))
          or (a.attrelid='private.employee_roster_import_runs'::regclass and a.attname='canonical_replay_manifest'))
          and has_column_privilege(application_role.name,a.attrelid,a.attnum,'SELECT,INSERT,UPDATE,REFERENCES'))
      and (select tgenabled='O' and pg_get_triggerdef(oid)='CREATE TRIGGER protect_canonical_employee_roster_run BEFORE DELETE OR UPDATE ON private.employee_roster_import_runs FOR EACH ROW EXECUTE FUNCTION private.protect_canonical_employee_roster_run()' from pg_trigger where tgrelid='private.employee_roster_import_runs'::regclass and tgname='protect_canonical_employee_roster_run')
      and pg_get_indexdef('private.employee_roster_import_row_map_run_person_idx'::regclass)='CREATE UNIQUE INDEX employee_roster_import_row_map_run_person_idx ON private.employee_roster_import_row_map USING btree (run_id, source_person_id) WHERE (source_person_id IS NOT NULL)'
      and (select encode(extensions.digest(coalesce(string_agg(definition,E'\n' order by definition),''),'sha256'),'hex') from (
  select 'column:'||a.attrelid::regclass::text||':'||case when a.attrelid='private.employee_roster_import_row_map_run_person_idx'::regclass and a.attname='source_person_id' then 'person_id' else a.attname end||':'||coalesce(a.attacl::text,'default') definition from pg_attribute a join pg_class c on c.oid=a.attrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname <> 'information_schema' and n.nspname !~ '^pg_' and a.attnum>0 and not a.attisdropped and a.attrelid<>all(array['private.employee_identity_consolidations'::regclass,'private.employee_identity_consolidations_pkey'::regclass]) and not (a.attrelid='private.employee_roster_import_row_map'::regclass and a.attname in ('source_person_id','original_row')) and not (a.attrelid='private.employee_roster_import_runs'::regclass and a.attname='canonical_replay_manifest')
  union all select 'schema:'||nspname||':'||nspowner::text||':'||coalesce(nspacl::text,'default') from pg_namespace where nspname <> 'information_schema' and nspname !~ '^pg_'
  union all select 'default:'||defaclrole::text||':'||defaclnamespace::text||':'||defaclobjtype::text||':'||defaclacl::text from pg_default_acl
  union all select 'role:'||rolname||':'||rolsuper||':'||rolinherit||':'||rolcreaterole||':'||rolcreatedb||':'||rolcanlogin||':'||rolreplication||':'||rolbypassrls from pg_roles
  union all select 'index:'||i.indexrelid::regclass::text||':'||case when i.indexrelid='private.employee_roster_import_row_map_run_person_idx'::regclass then 'CREATE UNIQUE INDEX employee_roster_import_row_map_run_person_idx ON private.employee_roster_import_row_map USING btree (run_id, person_id) WHERE (person_id IS NOT NULL)' else pg_get_indexdef(i.indexrelid) end from pg_index i join pg_class c on c.oid=i.indrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname <> 'information_schema' and n.nspname !~ '^pg_' and i.indrelid<>'private.employee_identity_consolidations'::regclass
) security_definitions)=current_setting('mam.identity_previous_security')
      and (select encode(extensions.digest(jsonb_build_array((select coalesce(jsonb_agg(to_jsonb(p) order by to_jsonb(p)::text),'[]'::jsonb) from private.confirmed_test_identity_purges p),(select coalesce(jsonb_agg(to_jsonb(n) order by to_jsonb(n)::text),'[]'::jsonb) from private.notification_delivery_receipts n))::text,'sha256'),'hex'))=current_setting('mam.identity_previous_receipts')
    from (%s) normalized(schema_hash)
  $verified$,query);
  reviewed_functions:=array['public.replay_canonical_employee_roster(uuid,text,jsonb)'::regprocedure,'private.protect_canonical_employee_roster_run()'::regprocedure,'public.read_employee_identity_consolidation(uuid)'::regprocedure,'private.employee_identity_retained_account_audit(jsonb)'::regprocedure,'private.assert_employee_identity_actor()'::regprocedure,'private.assert_employee_identity_dependencies(uuid,uuid,boolean)'::regprocedure,'private.employee_identity_dependency_manifest()'::regprocedure,'private.employee_identity_snapshot(uuid[])'::regprocedure,'private.prevent_retired_employee_identity_recreation()'::regprocedure,'private.protect_employee_identity_consolidation_receipt()'::regprocedure,'private.protect_employee_roster_original_row()'::regprocedure,'private.resolve_consolidated_employee_import(text,uuid,text)'::regprocedure,'public.apply_employee_identity_consolidation(jsonb)'::regprocedure,'public.prepare_employee_identity_consolidation(uuid,uuid,text,uuid[],boolean,boolean)'::regprocedure]::oid[];
  reviewed_triggers:=array(select oid from pg_trigger where not tgisinternal and ((tgrelid='private.employee_roster_import_runs'::regclass and tgname='protect_canonical_employee_roster_run') or (tgrelid='private.employee_identity_consolidations'::regclass) or (tgrelid='private.employee_roster_import_row_map'::regclass and tgname='protect_employee_roster_original_row') or (tgrelid='public.internal_org_people'::regclass and tgname='prevent_retired_employee_identity_recreation')));
  execute validation_sql into normalized_hash,candidate_hash,verified using current_setting('mam.identity_previous_projection'),reviewed_functions,reviewed_triggers,current_setting('mam.identity_previous_payroll_snapshot_guard');
  if not coalesce(verified,false) then raise exception 'Reviewed consolidation definition/ACL/receipt drift during forward migration' using errcode='55000'; end if;
  if normalized_hash is distinct from previous_hash then raise exception 'Unreviewed schema change during consolidation migration' using errcode='55000'; end if;
  update private.confirmed_test_purge_schema set schema_hash=candidate_hash where singleton and schema_hash=previous_hash;
  if not found then raise exception 'Purge schema predecessor changed' using errcode='40001'; end if;
  if pg_get_indexdef('private.employee_roster_import_row_map_run_person_idx'::regclass) is distinct from 'CREATE UNIQUE INDEX employee_roster_import_row_map_run_person_idx ON private.employee_roster_import_row_map USING btree (run_id, source_person_id) WHERE (source_person_id IS NOT NULL)' then
    raise exception 'Final consolidation index definition drift' using errcode='55000';
  end if;
  execute validation_sql into final_normalized_hash,final_candidate_hash,final_verified using current_setting('mam.identity_previous_projection'),reviewed_functions,reviewed_triggers,current_setting('mam.identity_previous_payroll_snapshot_guard');
  if not coalesce(final_verified,false) or final_normalized_hash is distinct from previous_hash or final_candidate_hash is distinct from candidate_hash
    or (select schema_hash from private.confirmed_test_purge_schema where singleton) is distinct from candidate_hash then
    raise exception 'Final consolidation schema/security/receipt drift' using errcode='55000';
  end if;
end $identity_guard$;
do $management_audit_schema$ declare previous_hash text; query text; normalized_hash text; candidate_hash text; begin
  select schema_hash into strict previous_hash from private.confirmed_test_purge_schema where singleton;
  if private.confirmed_test_purge_schema_hash() is distinct from previous_hash then raise exception 'Management audit schema predecessor mismatch' using errcode='55000'; end if;
  if not exists(select 1 from pg_attribute where attrelid='private.employee_identity_consolidations'::regclass and attname='actor_user_id' and attnotnull and atttypid='uuid'::regtype and attacl is null) then
    raise exception 'Exact original audit attribution column required' using errcode='55000';
  end if;
  select prosrc into query from pg_proc where oid='private.confirmed_test_purge_schema_hash()'::regprocedure;
  if encode(extensions.digest(query,'sha256'),'hex')<>'c142665fb247c8761de408ce241e2f97aabe719c5d0801a5c53905892dd3de16'
    or (length(query)-length(replace(query,'||'':''||a.attnotnull','')))/length('||'':''||a.attnotnull')<>1 then
    raise exception 'Exact protected schema collector required' using errcode='55000';
  end if;
  alter table private.employee_identity_consolidations alter column actor_user_id drop not null;
  query:=replace(query,'||'':''||a.attnotnull','||'':''||(case when a.attrelid=''private.employee_identity_consolidations''::regclass and a.attname=''actor_user_id'' then true else a.attnotnull end)');
  execute query into normalized_hash;
  if normalized_hash is distinct from previous_hash then raise exception 'Unapproved metadata change during management audit adaptation' using errcode='55000'; end if;
  candidate_hash:=private.confirmed_test_purge_schema_hash();
  update private.confirmed_test_purge_schema set schema_hash=candidate_hash where singleton and schema_hash=previous_hash;
  if not found then raise exception 'Management audit predecessor changed' using errcode='40001'; end if;
  execute query into normalized_hash;
  if normalized_hash is distinct from previous_hash or private.confirmed_test_purge_schema_hash() is distinct from candidate_hash
    or (select schema_hash from private.confirmed_test_purge_schema where singleton) is distinct from candidate_hash then
    raise exception 'Final management audit schema drift' using errcode='55000';
  end if;
end $management_audit_schema$;
commit;
