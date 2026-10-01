begin;
set local search_path='';
do $guard$ declare r record; previous_hash text; begin
  if not pg_try_advisory_xact_lock(hashtextextended('confirmed-test-purge',0)) then raise exception 'Concurrent purge; defer migration' using errcode='55P03'; end if;
  lock table private.confirmed_test_purge_schema in share row exclusive mode nowait;
  if (select count(*) from private.confirmed_test_purge_schema)<>1 then raise exception 'Exact purge schema predecessor required' using errcode='55000'; end if;
  select schema_hash into previous_hash from private.confirmed_test_purge_schema;
  if private.confirmed_test_purge_schema_hash() is distinct from previous_hash then raise exception 'Schema/projection/trigger drift requires independent review before forward correction' using errcode='55000'; end if;
  for r in select * from (values
    ('private.confirmed_test_purge_census(uuid,uuid)','9e40009d7554977897e9bf8094b7e83b9660482ddf426d43dc937678f777ecda'),
    ('public.prepare_confirmed_test_identity_purge(uuid,uuid,text,text,text,bigint,bigint,text,boolean,boolean)','ce8b2822cb0f6d5196afee8479bdde22f75271c33eecf1df4777071514ea3cc0'),
    ('private.reject_retired_test_identity_reference()','def7c75521aee210234c157381e6e26c77dfb0c099d4f80f64d4960efbc9aebb'),
    ('public.complete_confirmed_test_identity_purge(uuid)','dddfd431a841c0859d831670b2bddc5c8e113d42fbcac312c46c3fd91824a178'),
    ('private.confirmed_test_purge_schema_hash()','c142665fb247c8761de408ce241e2f97aabe719c5d0801a5c53905892dd3de16')
  ) x(signature,body_sha256) loop
    if (select encode(extensions.digest(prosrc,'sha256'),'hex') from pg_proc where oid=r.signature::regprocedure) is distinct from r.body_sha256 then
      raise exception 'Exact purge function predecessor required (%)',r.signature using errcode='55000';
    end if;
  end loop;
  perform set_config('mam.purge_forward_previous_hash',previous_hash,true);
  perform set_config('mam.purge_forward_previous_definitions',(select jsonb_object_agg(p.oid::text,pg_get_functiondef(p.oid))::text from pg_proc p where p.oid in (
'private.confirmed_test_purge_census(uuid,uuid)'::regprocedure,'public.prepare_confirmed_test_identity_purge(uuid,uuid,text,text,text,bigint,bigint,text,boolean,boolean)'::regprocedure,'private.reject_retired_test_identity_reference()'::regprocedure,'public.complete_confirmed_test_identity_purge(uuid)'::regprocedure)),true);
end $guard$;

create function private.confirmed_test_retained_leave_receipt(p_document jsonb)
returns boolean language sql stable security definer set search_path='' as $$
select exists(select 1 from private.confirmed_test_identity_purges p
  cross join lateral jsonb_array_elements(coalesce(p.retained_audit->'private.notification_delivery_receipts','[]'::jsonb)) proof
  where p_document->>'event_key'=proof->>'event_key'
    and ((p_document->>'state'='sent' and encode(extensions.digest((p_document||jsonb_build_object(
        'created_at',extract(epoch from (p_document->>'created_at')::timestamptz),'sent_at',extract(epoch from (p_document->>'sent_at')::timestamptz)))::text,'sha256'),'hex')=proof->>'row_sha256')
      or (p_document->>'state'='sent_tombstone'
        and p_document-array['created_at','sent_at','minimized_at']=jsonb_build_object('event_key',proof->'event_key','state','sent_tombstone',
          'delivery_token',null,'recipient',null,'cc',null,'provider_receipt',null)
        and (p_document->>'created_at')::timestamptz=(proof->>'created_at')::timestamptz
        and (p_document->>'sent_at')::timestamptz=(proof->>'sent_at')::timestamptz
        and (p_document->>'minimized_at')::timestamptz>=(proof->>'sent_at')::timestamptz+interval '90 days'
        and (p_document->>'minimized_at')::timestamptz<=clock_timestamp())));
$$;
revoke all on function private.confirmed_test_retained_leave_receipt(jsonb) from public,anon,authenticated,service_role;

create or replace function private.confirmed_test_purge_census(p_person uuid,p_user uuid)
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
      if r.tbl='private.leave_notification_outbox' then
        if nullif(document->>'claim_token','') is not null or nullif(document->>'claimed_until','') is not null
          or not coalesce(((document->>'attempts')::integer=0 and document->>'delivered_at' is null)
            or ((document->>'attempts')::integer>0 and document->>'delivered_at' is not null
              and document->>'last_error' is null
              and (document->>'delivered_at')::timestamptz>=(document->>'created_at')::timestamptz
              and jsonb_typeof(document->'delivery_payload')='object'
              and document#>>'{payload,requestId}'=document->>'request_id'
              and document#>>'{delivery_payload,requestId}'=document->>'request_id'
              and document#>>'{payload,event}'=document->>'event'
              and document#>>'{delivery_payload,event}'=document->>'event'
              and jsonb_typeof(document#>'{delivery_payload,employeeEmails}')='array'
              and not exists(select 1 from jsonb_array_elements(case when jsonb_typeof(document#>'{delivery_payload,employeeEmails}')='array' then document#>'{delivery_payload,employeeEmails}' else '[]'::jsonb end) e
                where jsonb_typeof(e)<>'string' or length(e#>>'{}') not between 3 and 254
                  or (e#>>'{}') !~ '^[^[:space:]@,;]+@[^[:space:]@,;]+\.[^[:space:]@,;]+$')
              and (document#>'{delivery_payload,employeeEmail}') is not distinct from coalesce(to_jsonb(nullif(array_to_string(array(select jsonb_array_elements_text(case when jsonb_typeof(document#>'{delivery_payload,employeeEmails}')='array' then document#>'{delivery_payload,employeeEmails}' else '[]'::jsonb end)),','),'')),'null'::jsonb)
              and (document#>>'{delivery_payload,managerEmail}' is null or private.valid_leave_email_recipients(document#>>'{delivery_payload,managerEmail}'))
              and case when document->>'event' in ('leave-submitted','leave-cancelled') then private.valid_leave_email_recipients(document#>>'{delivery_payload,managerEmail}')
                else jsonb_array_length(case when jsonb_typeof(document#>'{delivery_payload,employeeEmails}')='array' then document#>'{delivery_payload,employeeEmails}' else '[]'::jsonb end)>0 end),false) then
          raise exception 'purge_blocked: leave delivery not finalized/unclaimed with bound recipient evidence' using errcode='23503';
        end if;
      end if;
      if r.tbl='private.employee_onboarding_credential_events' and document->>'event_type' not in ('pending_account','scheduled','cancelled') then raise exception 'purge_blocked: onboarding event evidence' using errcode='23503'; end if;
      if r.tbl like '%reminder_events' or r.tbl like '%day_one_events' then
        if document->>'event_type' in ('claimed','delivered','delivery_failed','retry_scheduled') then raise exception 'purge_blocked: delivery event evidence (%)',r.tbl using errcode='23503'; end if;
      end if;
    end loop;
  end loop;
  select coalesce(jsonb_agg(to_jsonb(s) order by to_jsonb(s)::text),'[]'::jsonb) into owned
    from private.leave_submission_receipts s where s.actor_user_id=p_user;
  rows:=rows||jsonb_build_object('private.leave_submission_receipts',owned);
  for document in select value from jsonb_array_elements(owned) loop
    if jsonb_typeof(document->'result') is distinct from 'object'
      or (select array_agg(key order by key) from jsonb_object_keys(document->'result') key) is distinct from array['approval_required','assigned_reviewer_label','id','status']::text[]
      or jsonb_typeof(document#>'{result,approval_required}') is distinct from 'boolean'
      or document#>>'{result,status}' is distinct from 'Pending'
      or document->>'input_hash' !~ '^[0-9a-f]{64}$'
      or not exists(select 1 from jsonb_array_elements(rows->'public.leave_requests') l where l->>'id'=document#>>'{result,id}') then
      raise exception 'purge_blocked: unbound/shared leave submission receipt' using errcode='23503';
    end if;
    ids:=array_append(ids,(document->>'submission_key')::uuid);
  end loop;
  select coalesce(jsonb_agg(to_jsonb(c) order by to_jsonb(c)::text),'[]'::jsonb) into owned
    from private.portal_account_status_change_claims c where c.auth_user_id=p_user;
  rows:=rows||jsonb_build_object('private.portal_account_status_change_claims',owned);
  for document in select value from jsonb_array_elements(owned) loop
    if document->>'person_id' is distinct from p_person::text or document->>'status' is distinct from 'finalised'
      or document->>'requested_enabled' is distinct from 'false' or document->>'finalised_at' is null
      or document->>'provider_status' is distinct from 'succeeded'
      or document->>'executor_token' is null or document->>'provider_started_at' is null or document->>'provider_finished_at' is null
      or (document->>'final_account_version')::bigint is distinct from (select account_version from public.profiles where id=p_user) then
      raise exception 'purge_blocked: account status claim not finalized disabled/owned/provider-confirmed' using errcode='23503';
    end if;
    ids:=ids||array[(document->>'change_token')::uuid,(document->>'executor_token')::uuid];
  end loop;
  select coalesce(jsonb_agg(to_jsonb(n) order by to_jsonb(n)::text),'[]'::jsonb) into owned
    from private.notification_delivery_receipts n where split_part(n.event_key,':',1)='leave'
      and split_part(n.event_key,':',2) in (select l->>'id' from jsonb_array_elements(rows->'public.leave_requests') l);
  rows:=rows||jsonb_build_object('private.notification_delivery_receipts',owned);
  for document in select value from jsonb_array_elements(owned) loop
    if document->>'state' is distinct from 'sent' or document->>'sent_at' is null
      or document->>'delivery_token' is null or document->'provider_receipt'='null'::jsonb
      or not private.notification_event_key_valid(document->>'event_key')
      or not exists(select 1 from jsonb_array_elements(rows->'private.leave_notification_outbox') o
        cross join lateral unnest(case when o->>'event'='leave-submitted' then array['reviewers','employee'] else array['shared'] end) audience
        cross join lateral (select
          array(select distinct lower(btrim(e)) collate "C" from unnest(string_to_array(o#>>'{delivery_payload,managerEmail}',',')) e order by 1) managers,
          array(select distinct lower(btrim(e)) collate "C" from jsonb_array_elements_text(o#>'{delivery_payload,employeeEmails}') e order by 1) employees) addresses
        cross join lateral (select array(select distinct e collate "C" from unnest(case
          when audience='reviewers' then array(select e from unnest(addresses.managers||array['hr@mobilityaccess.com.au']) e where not e=any(addresses.employees))
          when audience='employee' then addresses.employees
          when o->>'event'='leave-cancelled' then addresses.managers else addresses.employees end) e order by 1) recipients) envelope
        where o->>'delivered_at' is not null and (o->>'attempts')::integer>0
          and document->>'event_key'='leave:'||(o->>'request_id')||':'||(o->>'event')||':'||left(encode(extensions.digest((o->>'id')||case when o->>'event'='leave-submitted' then ':'||audience else '' end,'sha256'),'hex'),24)
          and document->>'recipient'=array_to_string(envelope.recipients,',')
          and document->>'cc'=array_to_string(array(select e collate "C" from unnest(case
            when o->>'event'='leave-submitted' then array[]::text[]
            else array['hr@mobilityaccess.com.au']||case when o->>'event'='leave-approved'
              or (o->>'event'='leave-cancelled' and o#>'{delivery_payload,wasApproved}' is distinct from 'false'::jsonb)
              then array['accounts@mobilityaccess.com.au'] else array[]::text[] end end) e
            where not e=any(envelope.recipients) order by 1),',')) then
      raise exception 'purge_blocked: nonfinalized/unbound leave delivery receipt' using errcode='23503';
    end if;
    ids:=array_append(ids,(document->>'delivery_token')::uuid);
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

create or replace function public.prepare_confirmed_test_identity_purge(p_person_id uuid,p_auth_user_id uuid,p_company_key text,p_full_name text,p_login_name text,p_person_version bigint,p_account_version bigint,p_manifest_hash text,p_confirm_test_only boolean,p_destroy_exclusive_history boolean)
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
  audit:=audit||jsonb_build_object('private.portal_account_status_change_claims',census->'rows'->'private.portal_account_status_change_claims');
  audit:=audit||jsonb_build_object('private.leave_submission_receipts',(select coalesce(jsonb_agg(jsonb_build_object(
    'actor_user_id',d->'actor_user_id','submission_key',d->'submission_key','input_hash',d->'input_hash','created_at',d->'created_at',
    'result',(d->'result')-'assigned_reviewer_label','result_sha256',encode(extensions.digest((d->'result')::text,'sha256'),'hex')) order by d->>'submission_key'),'[]'::jsonb)
    from jsonb_array_elements(census->'rows'->'private.leave_submission_receipts') d));
  audit:=audit||jsonb_build_object('private.leave_notification_outbox',(select coalesce(jsonb_agg(jsonb_build_object(
    'id',d->'id','request_id',d->'request_id','event',d->'event','created_at',d->'created_at','delivered_at',d->'delivered_at','attempts',d->'attempts',
    'recipient_snapshot',jsonb_build_object('source','delivery_payload',
      'manager',to_jsonb(array(select encode(extensions.digest(lower(btrim(e)),'sha256'),'hex') from unnest(string_to_array(d#>>'{delivery_payload,managerEmail}',',')) e order by e)),
      'employee',to_jsonb(array(select encode(extensions.digest(lower(btrim(e)),'sha256'),'hex') from jsonb_array_elements_text(d#>'{delivery_payload,employeeEmails}') e order by e)))) order by d->>'id'),'[]'::jsonb)
    from jsonb_array_elements(census->'rows'->'private.leave_notification_outbox') d where d->>'delivered_at' is not null));
  audit:=audit||jsonb_build_object('private.notification_delivery_receipts',(select coalesce(jsonb_agg(jsonb_build_object(
    'event_key',d->'event_key','created_at',d->'created_at','sent_at',d->'sent_at','row_sha256',encode(extensions.digest((d||jsonb_build_object(
      'created_at',extract(epoch from (d->>'created_at')::timestamptz),'sent_at',extract(epoch from (d->>'sent_at')::timestamptz)))::text,'sha256'),'hex'),
    'recipient_sha256',encode(extensions.digest(d->>'recipient','sha256'),'hex'),'cc_sha256',encode(extensions.digest(d->>'cc','sha256'),'hex'),
    'provider_receipt_sha256',encode(extensions.digest((d->'provider_receipt')::text,'sha256'),'hex')) order by d->>'event_key'),'[]'::jsonb)
    from jsonb_array_elements(census->'rows'->'private.notification_delivery_receipts') d));
  insert into private.confirmed_test_identity_purges(person_id,auth_user_id,actor_user_id,company_key,manifest_hash,manifest,retained_audit,retired_identifiers,phase,completed_at)
    values(p_person_id,p_auth_user_id,auth.uid(),p_company_key,p_manifest_hash,census->'manifest',audit,array(select jsonb_array_elements_text(census->'identifiers')::uuid),
      case when p_auth_user_id is null then 'complete' else 'business_purged' end,case when p_auth_user_id is null then clock_timestamp() else null end) returning id into receipt;
  foreach tbl in array array[
    'private.employee_onboarding_credential_events','private.employee_check_in_reminder_events','private.employee_new_starter_day_one_events',
    'private.leave_submission_receipts','private.portal_account_status_change_claims',
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
    execute format('select count(*) from %I.%I t where private.confirmed_test_has_reference(to_jsonb(t),array(select jsonb_array_elements_text($1)::uuid)) and not ($2 and private.confirmed_test_retained_leave_receipt(to_jsonb(t)))',r.nspname,r.relname) into deleted using census->'identifiers',(r.nspname,r.relname)=('private','notification_delivery_receipts');
    if deleted<>0 then raise exception 'Post-purge reference remains in %.%',r.nspname,r.relname using errcode='23503'; end if;
  end loop;
  return receipt;
end $$;

create or replace function private.reject_retired_test_identity_reference()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if tg_table_schema='private' and tg_table_name='notification_delivery_receipts' and tg_op='UPDATE' then
    if private.confirmed_test_retained_leave_receipt(to_jsonb(old)) and old.state='sent' and new.state='sent_tombstone'
      and old.sent_at<clock_timestamp()-interval '90 days'
      and private.confirmed_test_retained_leave_receipt(to_jsonb(new)) then return new; end if;
  end if;
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

create or replace function public.complete_confirmed_test_identity_purge(p_receipt_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare receipt private.confirmed_test_identity_purges%rowtype; r record; remaining bigint;
begin
  if auth.uid() is null or not private.is_system_portal_account_admin() or not private.is_active_portal_account() then raise exception 'Active System Admin required' using errcode='42501'; end if;
  if private.confirmed_test_purge_schema_hash() is distinct from (select schema_hash from private.confirmed_test_purge_schema) then raise exception 'Schema drift requires review' using errcode='55000'; end if;
  select * into receipt from private.confirmed_test_identity_purges where id=p_receipt_id and actor_user_id=auth.uid() for update nowait;
  if receipt.id is null then raise exception 'Unknown owned purge receipt' using errcode='42501'; end if;
  if receipt.auth_user_id is not null and (receipt.phase='business_purged' or exists(select 1 from auth.users where id=receipt.auth_user_id)) then raise exception 'Auth deletion remains unconfirmed; reconcile' using errcode='55000'; end if;
  for r in select n.nspname,c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname in ('public','private','storage') and c.relkind in ('r','p','m') and (n.nspname,c.relname) not in (('private','confirmed_test_identity_purges'),('private','confirmed_test_purge_schema')) loop
    execute format('select count(*) from %I.%I t where private.confirmed_test_has_reference(to_jsonb(t),$1) and not ($2 and private.confirmed_test_retained_leave_receipt(to_jsonb(t)))',r.nspname,r.relname) into remaining using receipt.retired_identifiers,(r.nspname,r.relname)=('private','notification_delivery_receipts');
    if remaining<>0 then raise exception 'Operational reference remains in %.%',r.nspname,r.relname using errcode='23503'; end if;
  end loop;
  update private.confirmed_test_identity_purges set phase='complete',completed_at=coalesce(completed_at,clock_timestamp()) where id=p_receipt_id;
  return public.get_confirmed_test_identity_purge(receipt.person_id);
end $$;

revoke all on function private.confirmed_test_purge_census(uuid,uuid),private.reject_retired_test_identity_reference(),
  public.prepare_confirmed_test_identity_purge(uuid,uuid,text,text,text,bigint,bigint,text,boolean,boolean),public.complete_confirmed_test_identity_purge(uuid)
  from public,anon,authenticated,service_role;
grant execute on function public.prepare_confirmed_test_identity_purge(uuid,uuid,text,text,text,bigint,bigint,text,boolean,boolean),public.complete_confirmed_test_identity_purge(uuid) to authenticated;

do $guard$ declare query text; previous_hash text:=current_setting('mam.purge_forward_previous_hash'); normalized_hash text; candidate_hash text; reviewed_functions boolean; begin
  select prosrc into query from pg_proc where oid='private.confirmed_test_purge_schema_hash()'::regprocedure;
  if encode(extensions.digest(query,'sha256'),'hex')<>'c142665fb247c8761de408ce241e2f97aabe719c5d0801a5c53905892dd3de16' then raise exception 'Purge schema hash implementation changed' using errcode='55000'; end if;
  query:=replace(query,'pg_get_functiondef(p.oid)','case when $1 ? p.oid::text then $1->>p.oid::text else pg_get_functiondef(p.oid) end');
  query:=replace(query,'and p.prokind=''f''','and p.prokind=''f'' and p.oid<>''private.confirmed_test_retained_leave_receipt(jsonb)''::regprocedure');
  query:=regexp_replace(query,';[[:space:]]*$','');
  execute format($verified$
    select normalized.schema_hash, private.confirmed_test_purge_schema_hash(),
      (select bool_and(coalesce(encode(extensions.digest(pg_get_functiondef(to_regprocedure(signature)),'sha256'),'hex')=definition_sha256,false))
        from (values
          ('private.confirmed_test_purge_census(uuid,uuid)','3e22a29dd6f6c60828803afc1dbd74833552c8c72f44659bc0cb37c9298ae5e2'),
          ('public.prepare_confirmed_test_identity_purge(uuid,uuid,text,text,text,bigint,bigint,text,boolean,boolean)','07294ec1a4342ae89d4c83feb18f2f7f11f9492e2c3fc205ed0d2f364c0ef084'),
          ('private.reject_retired_test_identity_reference()','bbd7503fa072b9606dfefe24ff4ced9c9d81a284f3169af115a79978e43d64cb'),
          ('public.complete_confirmed_test_identity_purge(uuid)','c2c7a425a73ad12c093f10b9e2527e2bcd404c613fe2f408387e17e2da6c5186'),
          ('private.confirmed_test_purge_schema_hash()','3385d5a0140df3995e3196ffea442b4829f9a5357de3ccf5a8d521fbe9011a54'),
          ('private.confirmed_test_retained_leave_receipt(jsonb)','09b0d3b2a30787f9e2cbbef1c5d2b4b41368d10b85faead97ef4672d7f2b691d')
        ) expected(signature,definition_sha256))
      and (select p.proowner=(select proowner from pg_proc where oid='private.confirmed_test_purge_schema_hash()'::regprocedure)
        and not exists(select 1 from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a where a.grantee<>p.proowner or a.privilege_type<>'EXECUTE')
        from pg_proc p where p.oid='private.confirmed_test_retained_leave_receipt(jsonb)'::regprocedure)
    from (%s) normalized(schema_hash)
  $verified$,query) into normalized_hash,candidate_hash,reviewed_functions using current_setting('mam.purge_forward_previous_definitions')::jsonb;
  if not coalesce(reviewed_functions,false) then raise exception 'Reviewed function definition/owner/ACL drift during forward correction' using errcode='55000'; end if;
  if normalized_hash is distinct from previous_hash then raise exception 'Unreviewed schema change during forward correction' using errcode='55000'; end if;
  update private.confirmed_test_purge_schema set schema_hash=candidate_hash where singleton and schema_hash=previous_hash;
  if not found then raise exception 'Purge schema predecessor changed' using errcode='40001'; end if;
end $guard$;
commit;
