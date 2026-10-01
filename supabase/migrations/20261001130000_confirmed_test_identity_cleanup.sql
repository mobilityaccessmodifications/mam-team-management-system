begin;

do $$ begin
  if exists(select 1 from pg_constraint x join pg_class c on c.oid=x.conrelid join pg_namespace n on n.oid=c.relnamespace join pg_class parent on parent.oid=x.confrelid join pg_namespace pn on pn.oid=parent.relnamespace where x.contype='f' and n.nspname not in ('auth','public','private','storage') and (pn.nspname in ('public','private','storage') or x.confrelid='auth.users'::regclass)) then
    raise exception 'Unreviewed external-schema identity dependencies require retention review' using errcode='55000';
  end if;
end $$;

create table private.confirmed_test_identity_purges (
  id uuid primary key default gen_random_uuid(),
  person_id uuid not null unique,
  auth_user_id uuid unique,
  actor_user_id uuid not null,
  company_key text not null,
  manifest_hash text not null,
  manifest jsonb not null,
  retained_audit jsonb not null,
  retired_identifiers uuid[] not null,
  phase text not null check (phase in ('business_purged','auth_delete_started','complete')),
  created_at timestamptz not null default clock_timestamp(),
  auth_delete_started_at timestamptz,
  completed_at timestamptz
);
alter table private.confirmed_test_identity_purges enable row level security;
alter table private.confirmed_test_identity_purges force row level security;
revoke all on private.confirmed_test_identity_purges from public,anon,authenticated,service_role;

create function private.confirmed_test_has_reference(document jsonb, identifiers uuid[])
returns boolean language sql immutable set search_path='' as $$
select exists(select 1 from unnest(identifiers) id where position(id::text in lower(document::text))>0);
$$;
revoke all on function private.confirmed_test_has_reference(jsonb,uuid[]) from public,anon,authenticated,service_role;

create function private.confirmed_test_purge_census(p_person uuid,p_user uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare r record; owned jsonb; rows jsonb:='{}'; ids uuid[]:=array[p_person,p_user]; needle text; document jsonb; candidate jsonb; count_rows bigint; manifest jsonb:='{}';
begin
  for r in select * from (values
    ('public.profiles','id'),
    ('public.internal_org_people','id'),
    ('private.employee_directory_details','person_id'),
    ('private.employee_directory_audit_events','person_id'),
    ('private.employee_check_in_enrolments','person_id'),
    ('private.employee_onboarding_credentials','person_id'),
    ('private.employee_check_in_reminders','person_id'),
    ('private.employee_new_starter_day_one_reminders','person_id'),
    ('private.employee_annual_leave_balances','person_id'),
    ('private.annual_leave_balance_history','person_id'),
    ('private.employee_sick_leave_balances','person_id'),
    ('private.sick_leave_balance_history','person_id'),
    ('public.leave_requests','employee_person_id')
  ) as x(tbl,col) loop
    execute format('select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text),''[]''::jsonb) from %s t where %I=$1',r.tbl,r.col)
      into owned using case when r.tbl='public.profiles' then p_user else p_person end;
    rows:=rows||jsonb_build_object(r.tbl,owned);
    for document in select value from jsonb_array_elements(owned) loop
      if document ? 'id' and length(document->>'id')=36 then ids:=array_append(ids,(document->>'id')::uuid); end if;
      if nullif(document->>'source_import_id','') is not null then raise exception 'purge_blocked: imported/shared balance provenance (%)',r.tbl using errcode='23503'; end if;
      if r.tbl='private.employee_onboarding_credentials' and (document->>'status' not in ('pending_account','scheduled','cancelled') or nullif(document->>'claim_token','') is not null or nullif(document->>'delivered_at','') is not null or nullif(document->>'claimed_login','') is not null or nullif(document->>'claim_expires_at','') is not null or nullif(document->>'claimed_work_email','') is not null or nullif(document->>'claimed_personal_email','') is not null or nullif(document->>'review_code','') is not null or document->>'auth_user_id' is distinct from p_user::text) then raise exception 'purge_blocked: onboarding delivery evidence' using errcode='23503'; end if;
      if r.tbl='public.leave_requests' and (document->>'status'<>'cancelled' or document->>'user_id' is distinct from p_user::text or document->>'record_origin'<>'portal') then
        raise exception 'purge_blocked: only exclusive cancelled portal leave is supported' using errcode='23503';
      end if;
      if r.tbl in ('private.employee_check_in_reminders','private.employee_new_starter_day_one_reminders') and
        (nullif(document->>'claim_token','') is not null or nullif(document->>'claimed_at','') is not null or nullif(document->>'delivered_at','') is not null or nullif(document->>'provider_delivery_id','') is not null
        or coalesce(document->>'delivery_status',document->>'status') not in ('scheduled','completed','superseded','cancelled','needs_review')
        or coalesce((document->>'attempt_count')::integer,(document->>'failure_count')::integer,0)>0) then
        raise exception 'purge_blocked: claimed/attempted/provider reminder (%)',r.tbl using errcode='23503';
      end if;
    end loop;
  end loop;
  for r in select * from (values
    ('private.employee_onboarding_credential_events','delivery_id','private.employee_onboarding_credentials'),
    ('private.employee_check_in_reminder_events','reminder_id','private.employee_check_in_reminders'),
    ('private.employee_new_starter_day_one_events','reminder_id','private.employee_new_starter_day_one_reminders'),
    ('public.leave_request_events','leave_request_id','public.leave_requests'),
    ('private.leave_request_reviewer_assignments','leave_request_id','public.leave_requests'),
    ('private.leave_notification_outbox','request_id','public.leave_requests'),
    ('private.portal_account_admin_events','target_user_id','public.profiles')
  ) as x(tbl,col,parent) loop
    execute format('select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text),''[]''::jsonb) from %s t where %I::text in (select value->>''id'' from jsonb_array_elements($1))',r.tbl,r.col)
      into owned using rows->r.parent;
    rows:=rows||jsonb_build_object(r.tbl,owned);
    for document in select value from jsonb_array_elements(owned) loop
      if document ? 'id' and length(document->>'id')=36 then ids:=array_append(ids,(document->>'id')::uuid); end if;
      if r.tbl='private.leave_notification_outbox' and
        (nullif(document->>'claim_token','') is not null or nullif(document->>'claimed_until','') is not null or nullif(document->>'delivered_at','') is not null or (document->>'attempts')::integer<>0) then
        raise exception 'purge_blocked: leave delivery already attempted/claimed' using errcode='23503';
      end if;
      if r.tbl='private.employee_onboarding_credential_events' and document->>'event_type' not in ('pending_account','scheduled','cancelled') then raise exception 'purge_blocked: onboarding event evidence' using errcode='23503'; end if;
      if r.tbl like '%reminder_events' or r.tbl like '%day_one_events' then
        if document->>'event_type' in ('claimed','delivered','delivery_failed','retry_scheduled') then raise exception 'purge_blocked: delivery event evidence (%)',r.tbl using errcode='23503'; end if;
      end if;
    end loop;
  end loop;
  select array_agg(distinct v) into ids from unnest(ids) v where v is not null;
  if exists(select 1 from auth.users u where u.id is distinct from p_user and private.confirmed_test_has_reference(to_jsonb(u),ids)) then raise exception 'purge_blocked: shared metadata reference in auth.users' using errcode='23503'; end if;
  for r in select n.nspname,c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where n.nspname in ('public','private','storage') and c.relkind in ('r','p','m')
      and (n.nspname,c.relname) not in (('private','confirmed_test_identity_purges'),('private','confirmed_test_purge_schema')) order by n.nspname,c.relname loop
    for document in execute format('select to_jsonb(t) from %I.%I t',r.nspname,r.relname) loop
      if private.confirmed_test_has_reference(document,ids) then
        candidate:=rows->(r.nspname||'.'||r.relname);
        if candidate is null or not candidate @> jsonb_build_array(document) then
          raise exception 'purge_blocked: unreviewed/shared/immutable reference in %.%',r.nspname,r.relname using errcode='23503';
        end if;
      end if;
    end loop;
  end loop;
  for r in select key,value from jsonb_each(rows) loop
    count_rows:=jsonb_array_length(r.value);
    manifest:=manifest||jsonb_build_object(r.key,jsonb_build_object('count',count_rows,'sha256',encode(extensions.digest(r.value::text,'sha256'),'hex')));
  end loop;
  return jsonb_build_object('rows',rows,'manifest',manifest,'manifest_hash',encode(extensions.digest(manifest::text,'sha256'),'hex'),'identifiers',to_jsonb(ids));
end $$;
revoke all on function private.confirmed_test_purge_census(uuid,uuid) from public,anon,authenticated,service_role;

create function public.preview_confirmed_test_identity_purge(p_person_id uuid,p_auth_user_id uuid,p_company_key text,p_full_name text,p_login_name text,p_person_version bigint,p_account_version bigint)
returns jsonb language plpgsql security definer set search_path='' as $$
declare person public.internal_org_people%rowtype; profile public.profiles%rowtype; census jsonb;
begin
  if private.confirmed_test_purge_schema_hash() is distinct from (select schema_hash from private.confirmed_test_purge_schema) then raise exception 'purge_blocked: schema/projection/trigger drift requires review' using errcode='55000'; end if;
  if auth.uid() is null or not private.is_system_portal_account_admin() or not private.is_active_portal_account() then raise exception 'Active System Admin required' using errcode='42501'; end if;
  if auth.uid()=p_auth_user_id then raise exception 'Cannot purge own identity' using errcode='42501'; end if;
  select * into person from public.internal_org_people where id=p_person_id;
  select * into profile from public.profiles where id=p_auth_user_id;
  if person.id is null or (p_auth_user_id is not null and profile.id is null) or (p_auth_user_id is null and (person.is_active or p_account_version is not null or p_login_name is not null)) or person.node_kind<>'person' or person.auth_user_id is distinct from p_auth_user_id or person.company_key is distinct from p_company_key or person.full_name is distinct from p_full_name or profile.login_name is distinct from p_login_name then raise exception 'Exact identity confirmation mismatch' using errcode='23514'; end if;
  if person.version is distinct from p_person_version or profile.account_version is distinct from p_account_version then raise exception 'Stale identity version' using errcode='40001'; end if;
  if (p_auth_user_id is not null and (profile.account_status<>'disabled' or profile.app_role<>'employee'))
    or exists(select 1 from private.portal_account_admins where auth_user_id=p_auth_user_id)
    or (p_auth_user_id is not null and (select count(*) from public.internal_org_people where auth_user_id=p_auth_user_id)<>1)
    or exists(select 1 from public.internal_org_people where parent_id=p_person_id) then raise exception 'purge_blocked: enabled/admin/shared/reporting identity' using errcode='23503'; end if;
  census:=private.confirmed_test_purge_census(p_person_id,p_auth_user_id);
  return jsonb_build_object('manifest',census->'manifest','manifest_hash',census->>'manifest_hash');
end $$;
revoke all on function public.preview_confirmed_test_identity_purge(uuid,uuid,text,text,text,bigint,bigint) from public,anon,authenticated,service_role;
grant execute on function public.preview_confirmed_test_identity_purge(uuid,uuid,text,text,text,bigint,bigint) to authenticated;

create function public.prepare_confirmed_test_identity_purge(p_person_id uuid,p_auth_user_id uuid,p_company_key text,p_full_name text,p_login_name text,p_person_version bigint,p_account_version bigint,p_manifest_hash text,p_confirm_test_only boolean,p_destroy_exclusive_history boolean)
returns uuid language plpgsql security definer set search_path='' as $$
declare r record; reviewed jsonb; census jsonb; receipt uuid; audit jsonb:='{}'; tbl text; deleted bigint;
begin
  if p_confirm_test_only is distinct from true or p_destroy_exclusive_history is distinct from true then raise exception 'Explicit test-only and permanent history destruction confirmations required' using errcode='23514'; end if;
  if auth.uid() is null or not private.is_system_portal_account_admin() or not private.is_active_portal_account() then raise exception 'Active System Admin required' using errcode='42501'; end if;
  if not pg_try_advisory_xact_lock(hashtextextended('confirmed-test-purge',0)) then raise exception 'purge_blocked: concurrent purge; refresh preview' using errcode='55P03'; end if;
  lock table auth.users in share row exclusive mode nowait;
  for r in select n.nspname,c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname in ('public','private','storage') and c.relkind in ('r','p') order by n.nspname,c.relname loop
    execute format('lock table %I.%I in %s mode nowait',r.nspname,r.relname,case when (r.nspname,r.relname) in (('storage','migrations'),('storage','buckets_vectors'),('storage','vector_indexes')) then 'access share' else 'share row exclusive' end);
  end loop;
  reviewed:=public.preview_confirmed_test_identity_purge(p_person_id,p_auth_user_id,p_company_key,p_full_name,p_login_name,p_person_version,p_account_version);
  if p_manifest_hash is distinct from reviewed->>'manifest_hash' then raise exception 'Manifest changed; review again' using errcode='40001'; end if;
  if p_auth_user_id is not null and not exists(select 1 from auth.users where id=p_auth_user_id and banned_until>clock_timestamp()) then raise exception 'Exact linked Auth account must already be banned before business destruction.' using errcode='23514'; end if;
  census:=private.confirmed_test_purge_census(p_person_id,p_auth_user_id);
  for r in select key,value from jsonb_each(census->'rows') order by key loop
    execute format('select 1 from %s t where $1 @> jsonb_build_array(to_jsonb(t)) for update nowait',r.key) using r.value;
  end loop;
  for r in select key,value from jsonb_each(census->'rows') where key like '%events' loop audit:=audit||jsonb_build_object(r.key,r.value); end loop;
  insert into private.confirmed_test_identity_purges(person_id,auth_user_id,actor_user_id,company_key,manifest_hash,manifest,retained_audit,retired_identifiers,phase,completed_at)
    values(p_person_id,p_auth_user_id,auth.uid(),p_company_key,p_manifest_hash,census->'manifest',audit,array(select jsonb_array_elements_text(census->'identifiers')::uuid),
      case when p_auth_user_id is null then 'complete' else 'business_purged' end,case when p_auth_user_id is null then clock_timestamp() else null end) returning id into receipt;
  foreach tbl in array array[
    'private.employee_onboarding_credential_events','private.employee_check_in_reminder_events','private.employee_new_starter_day_one_events',
    'public.leave_request_events','private.leave_request_reviewer_assignments','private.leave_notification_outbox','private.portal_account_admin_events',
    'private.employee_directory_audit_events','private.employee_onboarding_credentials','private.employee_check_in_reminders',
    'private.employee_new_starter_day_one_reminders','private.employee_check_in_enrolments','private.annual_leave_balance_history',
    'private.sick_leave_balance_history','private.employee_annual_leave_balances','private.employee_sick_leave_balances',
    'public.leave_requests','private.employee_directory_details','public.internal_org_people','public.profiles'
  ] loop
    execute format('delete from %s t where $1 @> jsonb_build_array(to_jsonb(t))',tbl) using census->'rows'->tbl;
    get diagnostics deleted=row_count;
    if deleted<>jsonb_array_length(census->'rows'->tbl) then raise exception 'Manifest deletion mismatch (%)',tbl using errcode='40001'; end if;
  end loop;
  for r in select n.nspname,c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname in ('public','private','storage') and c.relkind in ('r','p','m') and (n.nspname,c.relname) not in (('private','confirmed_test_identity_purges'),('private','confirmed_test_purge_schema')) loop
    execute format('select count(*) from %I.%I t where private.confirmed_test_has_reference(to_jsonb(t),array(select jsonb_array_elements_text($1)::uuid))',r.nspname,r.relname) into deleted using census->'identifiers';
    if deleted<>0 then raise exception 'Post-purge reference remains in %.%',r.nspname,r.relname using errcode='23503'; end if;
  end loop;
  return receipt;
end $$;
revoke all on function public.prepare_confirmed_test_identity_purge(uuid,uuid,text,text,text,bigint,bigint,text,boolean,boolean) from public,anon,authenticated,service_role;
grant execute on function public.prepare_confirmed_test_identity_purge(uuid,uuid,text,text,text,bigint,bigint,text,boolean,boolean) to authenticated;

create function private.reject_retired_test_identity_reference()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if tg_table_schema='auth' and tg_table_name='users' and tg_op='UPDATE' then
    if exists(select 1 from private.confirmed_test_identity_purges p where p.auth_user_id=new.id and p.phase<>'complete')
      and not exists(select 1 from pg_catalog.pg_attribute a where a.attrelid=tg_relid and a.attnum>0 and not a.attisdropped and a.attgenerated='' and a.attname not in ('banned_until','updated_at') and (to_jsonb(new)->a.attname) is distinct from (to_jsonb(old)->a.attname))
      and new.updated_at>=old.updated_at
      and new.banned_until>clock_timestamp() and new.banned_until>=old.banned_until then return new; end if;
  end if;
  if exists(select 1 from private.confirmed_test_identity_purges p where private.confirmed_test_has_reference(to_jsonb(new),p.retired_identifiers)) then
    raise exception 'Retired confirmed-test identity reference is prohibited' using errcode='23514';
  end if;
  return new;
end $$;
revoke all on function private.reject_retired_test_identity_reference() from public,anon,authenticated,service_role;
create trigger reject_retired_test_identity_reference before insert or update on auth.users for each row execute function private.reject_retired_test_identity_reference();
do $$ declare r record; begin
  for r in select n.nspname,c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname in ('public','private','storage') and c.relkind in ('r','p') and (n.nspname,c.relname) not in (('private','confirmed_test_identity_purges'),('private','confirmed_test_purge_schema'),('storage','migrations'),('storage','buckets_vectors'),('storage','vector_indexes')) loop
    execute format('create trigger reject_retired_test_identity_reference before insert or update on %I.%I for each row execute function private.reject_retired_test_identity_reference()',r.nspname,r.relname);
  end loop;
end $$;

create function public.get_confirmed_test_identity_purge(p_person_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare receipt private.confirmed_test_identity_purges%rowtype;
begin
  if auth.uid() is null or not private.is_system_portal_account_admin() or not private.is_active_portal_account() then raise exception 'Active System Admin required' using errcode='42501'; end if;
  select * into receipt from private.confirmed_test_identity_purges where person_id=p_person_id and actor_user_id=auth.uid();
  if receipt.id is null then return null; end if;
  return jsonb_build_object('id',receipt.id,'person_id',receipt.person_id,'auth_user_id',receipt.auth_user_id,'phase',receipt.phase,'manifest_hash',receipt.manifest_hash,'manifest',receipt.manifest);
end $$;
create function public.claim_confirmed_test_identity_auth_delete(p_receipt_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare receipt private.confirmed_test_identity_purges%rowtype; authorized boolean:=false;
begin
  if auth.uid() is null or not private.is_system_portal_account_admin() or not private.is_active_portal_account() then raise exception 'Active System Admin required' using errcode='42501'; end if;
  if private.confirmed_test_purge_schema_hash() is distinct from (select schema_hash from private.confirmed_test_purge_schema) then raise exception 'Schema drift requires review' using errcode='55000'; end if;
  select * into receipt from private.confirmed_test_identity_purges where id=p_receipt_id and actor_user_id=auth.uid() for update nowait;
  if receipt.id is null then raise exception 'Unknown owned purge receipt' using errcode='42501'; end if;
  if receipt.phase='business_purged' then
    perform 1 from auth.users where id=receipt.auth_user_id and banned_until>clock_timestamp() for update nowait;
    if not found then raise exception 'Exact linked Auth account must already be banned before Auth deletion.' using errcode='23514'; end if;
    update private.confirmed_test_identity_purges set phase='auth_delete_started',auth_delete_started_at=clock_timestamp() where id=p_receipt_id;
    receipt.phase:='auth_delete_started'; authorized:=true;
  end if;
  return jsonb_build_object('id',receipt.id,'auth_user_id',receipt.auth_user_id,'phase',receipt.phase,'delete_authorized',authorized);
end $$;
create function public.complete_confirmed_test_identity_purge(p_receipt_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare receipt private.confirmed_test_identity_purges%rowtype; r record; remaining bigint;
begin
  if auth.uid() is null or not private.is_system_portal_account_admin() or not private.is_active_portal_account() then raise exception 'Active System Admin required' using errcode='42501'; end if;
  if private.confirmed_test_purge_schema_hash() is distinct from (select schema_hash from private.confirmed_test_purge_schema) then raise exception 'Schema drift requires review' using errcode='55000'; end if;
  select * into receipt from private.confirmed_test_identity_purges where id=p_receipt_id and actor_user_id=auth.uid() for update nowait;
  if receipt.id is null then raise exception 'Unknown owned purge receipt' using errcode='42501'; end if;
  if receipt.auth_user_id is not null and (receipt.phase='business_purged' or exists(select 1 from auth.users where id=receipt.auth_user_id)) then raise exception 'Auth deletion remains unconfirmed; reconcile' using errcode='55000'; end if;
  for r in select n.nspname,c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname in ('public','private','storage') and c.relkind in ('r','p','m') and (n.nspname,c.relname) not in (('private','confirmed_test_identity_purges'),('private','confirmed_test_purge_schema')) loop
    execute format('select count(*) from %I.%I t where private.confirmed_test_has_reference(to_jsonb(t),$1)',r.nspname,r.relname) into remaining using receipt.retired_identifiers;
    if remaining<>0 then raise exception 'Operational reference remains in %.%',r.nspname,r.relname using errcode='23503'; end if;
  end loop;
  update private.confirmed_test_identity_purges set phase='complete',completed_at=coalesce(completed_at,clock_timestamp()) where id=p_receipt_id;
  return public.get_confirmed_test_identity_purge(receipt.person_id);
end $$;
revoke all on function public.get_confirmed_test_identity_purge(uuid),public.claim_confirmed_test_identity_auth_delete(uuid),public.complete_confirmed_test_identity_purge(uuid) from public,anon,authenticated,service_role;
grant execute on function public.get_confirmed_test_identity_purge(uuid),public.claim_confirmed_test_identity_auth_delete(uuid),public.complete_confirmed_test_identity_purge(uuid) to authenticated;

create table private.confirmed_test_purge_schema (singleton boolean primary key default true check(singleton),schema_hash text not null);
alter table private.confirmed_test_purge_schema enable row level security;
alter table private.confirmed_test_purge_schema force row level security;
revoke all on private.confirmed_test_purge_schema from public,anon,authenticated,service_role;
create function private.confirmed_test_purge_schema_hash() returns text language sql stable security definer set search_path='' as $$
select encode(extensions.digest(coalesce(string_agg(definition,E'\n' order by definition),''),'sha256'),'hex') from (
  select n.nspname||'.'||c.relname||':'||c.relkind::text||':'||c.relrowsecurity||':'||c.relforcerowsecurity as definition from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname in ('public','private','storage') and c.relkind in ('r','p','v','m')
  union all select a.attrelid::regclass::text||':'||a.attname||':'||format_type(a.atttypid,a.atttypmod)||':'||a.attnotnull from pg_attribute a join pg_class c on c.oid=a.attrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname in ('public','private','storage') and a.attnum>0 and not a.attisdropped
  union all select conrelid::regclass::text||':'||pg_get_constraintdef(oid) from pg_constraint where connamespace in (select oid from pg_namespace where nspname in ('public','private','storage')) or confrelid='auth.users'::regclass or confrelid in (select c.oid from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname in ('public','private','storage'))
  union all select tgrelid::regclass::text||':'||tgenabled::text||':'||pg_get_triggerdef(t.oid) from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace where (n.nspname in ('public','private','storage') or c.oid='auth.users'::regclass) and not t.tgisinternal
  union all select pg_get_functiondef(p.oid) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('public','private') and p.prokind='f'
  union all select c.oid::regclass::text||':'||pg_get_viewdef(c.oid) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname in ('public','private','storage') and c.relkind in ('v','m')
  union all select p.oid::regprocedure::text||':'||p.proowner::text||':'||coalesce(p.proacl::text,'default') from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('public','private') and p.prokind='f'
  union all select c.oid::regclass::text||':'||c.relowner::text||':'||coalesce(c.relacl::text,'default') from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname in ('public','private','storage') and c.relkind in ('r','p','v','m')
  union all select polrelid::regclass::text||':'||polname||':'||polcmd::text||':'||polpermissive::text||':'||polroles::text||':'||coalesce(pg_get_expr(polqual,polrelid),'')||':'||coalesce(pg_get_expr(polwithcheck,polrelid),'') from pg_policy where polrelid in (select c.oid from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname in ('public','private','storage'))
) definitions;
$$;
revoke all on function private.confirmed_test_purge_schema_hash() from public,anon,authenticated,service_role;
insert into private.confirmed_test_purge_schema(schema_hash) select private.confirmed_test_purge_schema_hash();

commit;
