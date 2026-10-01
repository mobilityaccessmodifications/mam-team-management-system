begin;
set local search_path='';
do $payroll_purge_before$
declare r record; previous_hash text; query text; original_definitions text[]; original_functions text[]; owner_id oid;
begin
  if not pg_try_advisory_xact_lock(hashtextextended('confirmed-test-purge',0)) then
    raise exception 'Concurrent purge; defer payroll migration' using errcode='55P03';
  end if;
  lock table private.confirmed_test_purge_schema in share row exclusive mode nowait;
  if (select count(*) from private.confirmed_test_purge_schema)<>1 then
    raise exception 'Exact purge schema predecessor required' using errcode='55000';
  end if;
  select schema_hash into previous_hash from private.confirmed_test_purge_schema where singleton for update nowait;
  if private.confirmed_test_purge_schema_hash() is distinct from previous_hash then
    raise exception 'Schema/projection/trigger drift requires independent review before payroll migration' using errcode='55000';
  end if;
  for r in select * from (values
    ('private.confirmed_test_has_reference(jsonb,uuid[])','efa6a40e67ac616a36dd6820ad204e474277d54e175dff28891e9e11d8ba7094'),
    ('private.confirmed_test_purge_census(uuid,uuid)','3e22a29dd6f6c60828803afc1dbd74833552c8c72f44659bc0cb37c9298ae5e2'),
    ('private.confirmed_test_purge_schema_hash()','3385d5a0140df3995e3196ffea442b4829f9a5357de3ccf5a8d521fbe9011a54'),
    ('private.confirmed_test_retained_leave_receipt(jsonb)','09b0d3b2a30787f9e2cbbef1c5d2b4b41368d10b85faead97ef4672d7f2b691d'),
    ('private.reject_retired_test_identity_reference()','bbd7503fa072b9606dfefe24ff4ced9c9d81a284f3169af115a79978e43d64cb'),
    ('public.claim_confirmed_test_identity_auth_delete(uuid)','c8b1235d105e225aa53ffb231cacd651f7273702a3462309d0a7c56e55edb5f6'),
    ('public.complete_confirmed_test_identity_purge(uuid)','c2c7a425a73ad12c093f10b9e2527e2bcd404c613fe2f408387e17e2da6c5186'),
    ('public.get_confirmed_test_identity_purge(uuid)','1368d80d28761e7cf7fbef42f7904d6a904958bc99168f1bb713965bcde37ac3'),
    ('public.prepare_confirmed_test_identity_purge(uuid,uuid,text,text,text,bigint,bigint,text,boolean,boolean)','07294ec1a4342ae89d4c83feb18f2f7f11f9492e2c3fc205ed0d2f364c0ef084'),
    ('public.preview_confirmed_test_identity_purge(uuid,uuid,text,text,text,bigint,bigint)','52c988842bce043fc8c857970eeb1ddd50e44ea4eec95bd400e74b5893f8c3ab'),
    ('private.approved_leave_hours_after(uuid,text[],date)','156bf011e8a6d47e78ba307528e79fb56c32f5a849a68d0c6fdc740106bfa353'),
    ('private.leave_payroll_balance_sufficient(uuid)','c8271c9d82a827802878e8e8f513ccf0e19980871b87262c17e412efd61ebef8'),
    ('private.project_annual_leave_balance(uuid,date)','c94ed62c7c8a92808583991fc8bf34423ad34c96d2560821ca3320e3cebf0d38'),
    ('public.get_leave_priority_workspace(uuid)','09357ef5b83ff37e38df46a0302ebfc98279b45424ae77f9e55945369090a63e')
  ) expected(signature,definition_sha256) loop
    if encode(extensions.digest(pg_get_functiondef(to_regprocedure(r.signature)),'sha256'),'hex') is distinct from r.definition_sha256 then
      raise exception 'Exact payroll/purge function predecessor required (%)',r.signature using errcode='55000';
    end if;
  end loop;
  select prosrc,proowner into query,owner_id from pg_proc where oid='private.confirmed_test_purge_schema_hash()'::regprocedure;
  if encode(extensions.digest(query,'sha256'),'hex')<>'c142665fb247c8761de408ce241e2f97aabe719c5d0801a5c53905892dd3de16' then
    raise exception 'Purge schema hash implementation changed' using errcode='55000';
  end if;
  lock table private.confirmed_test_identity_purges in share row exclusive mode nowait;
  lock table public.profiles,public.internal_org_people,public.leave_requests,
    private.employee_annual_leave_balances,private.employee_sick_leave_balances,
    private.leave_accrual_day_reviews in access exclusive mode nowait;
  query:=replace(query,'select encode(extensions.digest(coalesce(string_agg(definition,E''\n'' order by definition),''''),''sha256''),''hex'')','select definition');
  execute 'select array_agg(definition order by definition) from ('||regexp_replace(query,';[[:space:]]*$','')||') definitions' into original_definitions;
  select array_agg(definition order by definition) from (select pg_get_functiondef(p.oid) as definition from pg_proc p where p.oid=any(array['private.approved_leave_hours_after(uuid,text[],date)'::regprocedure,'private.leave_payroll_balance_sufficient(uuid)'::regprocedure,'private.project_annual_leave_balance(uuid,date)'::regprocedure,'public.get_leave_priority_workspace(uuid)'::regprocedure]) union all select p.oid::regprocedure::text||':'||p.proowner::text||':'||coalesce(p.proacl::text,'default') from pg_proc p where p.oid=any(array['private.approved_leave_hours_after(uuid,text[],date)'::regprocedure,'private.leave_payroll_balance_sufficient(uuid)'::regprocedure,'private.project_annual_leave_balance(uuid,date)'::regprocedure,'public.get_leave_priority_workspace(uuid)'::regprocedure])) f into original_functions;
  create temporary table payroll_purge_transition on commit drop as
    select previous_hash as schema_hash,query as collector,original_definitions as definitions,original_functions as functions,owner_id as function_owner,
      (select encode(extensions.digest(coalesce(jsonb_agg(to_jsonb(p) order by id),'[]')::text,'sha256'),'hex') from private.confirmed_test_identity_purges p) as receipts_hash,
      (select jsonb_build_object(
    'column_acls',(select coalesce(jsonb_agg(jsonb_build_array(a.attrelid::regclass::text,a.attname,a.attacl::text) order by a.attrelid,a.attnum),'[]') from pg_attribute a join pg_class c on c.oid=a.attrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname in ('public','private','storage') and a.attnum>0 and not a.attisdropped and a.attacl is not null),
    'schema_acls',(select jsonb_agg(jsonb_build_array(nspname,nspowner,nspacl::text) order by nspname) from pg_namespace where nspname in ('public','private','storage','auth')),
    'default_acls',(select coalesce(jsonb_agg(to_jsonb(d) order by oid),'[]') from pg_default_acl d),
    'roles',(select jsonb_agg(jsonb_build_array(oid,rolname,rolsuper,rolinherit,rolcreaterole,rolcreatedb,rolcanlogin,rolreplication,rolbypassrls) order by oid) from pg_roles))) as extra_catalog;
end $payroll_purge_before$;


alter table public.internal_org_people add constraint payroll_closing_person_company unique(id,company_key);
alter table public.leave_requests add constraint payroll_closing_request_person unique(id,employee_person_id);

create table private.payroll_closing_receipts (
  id uuid primary key default gen_random_uuid(),
  owner_key text not null unique check(length(owner_key) between 1 and 160),
  actor_user_id uuid not null references public.profiles(id),
  operation text not null check(operation in ('closing','settlement','cancellation')),
  provenance text not null check(provenance in ('owner_estimate','confirmed_usage','request_cancellation')),
  note text not null check(length(btrim(note)) between 1 and 1000),
  payload jsonb not null,
  result jsonb not null,
  created_at timestamptz not null default clock_timestamp()
);
create table private.payroll_carryforward_events (
  id bigint generated always as identity primary key,
  receipt_id uuid not null references private.payroll_closing_receipts(id),
  request_id uuid not null,
  person_id uuid not null,
  company_key text not null check(company_key in ('mam','equipsy')),
  leave_kind text not null check(leave_kind in ('annual','personal')),
  origin_after date not null,
  through_date date not null check(through_date>=origin_after),
  total_hours numeric(12,4) not null check(total_hours>0 and total_hours<=100000),
  accounted_hours numeric(12,4) not null check(accounted_hours>=0 and accounted_hours<=total_hours),
  pending_hours numeric(12,4) not null check(pending_hours>=0 and pending_hours+accounted_hours<=total_hours),
  request_fingerprint text not null check(request_fingerprint ~ '^[0-9a-f]{64}$'),
  foreign key(request_id,person_id) references public.leave_requests(id,employee_person_id),
  foreign key(person_id,company_key) references public.internal_org_people(id,company_key),
  unique(receipt_id,request_id)
);
create index payroll_carryforward_latest on private.payroll_carryforward_events(request_id,id desc);
alter table private.payroll_closing_receipts enable row level security;
alter table private.payroll_closing_receipts force row level security;
alter table private.payroll_carryforward_events enable row level security;
alter table private.payroll_carryforward_events force row level security;
revoke all on private.payroll_closing_receipts,private.payroll_carryforward_events from public,anon,authenticated,service_role;
revoke all on sequence private.payroll_carryforward_events_id_seq from public,anon,authenticated,service_role;

create function private.payroll_closing_immutable() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  raise exception 'Payroll reconciliation evidence is immutable.' using errcode='55000';
end;
$$;
revoke all on function private.payroll_closing_immutable() from public,anon,authenticated,service_role;
create trigger payroll_closing_immutable before update or delete on private.payroll_closing_receipts
for each row execute function private.payroll_closing_immutable();
create trigger payroll_carryforward_immutable before update or delete on private.payroll_carryforward_events
for each row execute function private.payroll_closing_immutable();
create trigger payroll_closing_no_truncate before truncate on private.payroll_closing_receipts
for each statement execute function private.payroll_closing_immutable();
create trigger payroll_carryforward_no_truncate before truncate on private.payroll_carryforward_events
for each statement execute function private.payroll_closing_immutable();

create function private.payroll_closing_assert_actor() returns void
language plpgsql security definer set search_path='' as $$
begin
  if auth.uid() is null or not private.is_system_portal_account_admin()
    or not private.is_active_portal_account()
    or coalesce((auth.jwt()->>'is_anonymous')::boolean,false)
    or not exists(select 1 from private.portal_account_admins where auth_user_id=auth.uid() and revoked_at is null) then
    raise exception 'Payroll reconciliation requires an active P0 administrator.' using errcode='42501';
  end if;
end;
$$;
revoke all on function private.payroll_closing_assert_actor() from public,anon,authenticated,service_role;

create function private.payroll_request_money(p_row jsonb) returns jsonb
language sql immutable set search_path='' as $$
  select jsonb_build_array(p_row->'id',p_row->'employee_person_id',p_row->'user_id',p_row->'status',
    p_row->'start_date',p_row->'end_date',p_row->'start_time',p_row->'end_time',p_row->'hours',
    p_row->'business_days',p_row->'request_type_label',p_row->'employment_type_snapshot',
    p_row->'pay_treatment',p_row->'record_origin',p_row->'source_record_sha256');
$$;
create function private.payroll_request_fingerprint(p_row jsonb) returns text
language sql stable security definer set search_path='' as $$
  select encode(sha256(convert_to(jsonb_build_array(private.payroll_request_money(p_row),
    case when p_row->>'hours' is null and p_row->>'employment_type_snapshot' is null then
      (select employment_type from private.employee_directory_details where person_id=(p_row->>'employee_person_id')::uuid) end)::text,'UTF8')),'hex');
$$;
revoke all on function private.payroll_request_money(jsonb),private.payroll_request_fingerprint(jsonb) from public,anon,authenticated,service_role;

create function private.payroll_closing_fingerprint(p_person uuid) returns text
language sql stable security definer set search_path='' as $$
  select encode(sha256(convert_to(jsonb_build_object(
    'person',(select jsonb_build_array(id,company_key,is_active,node_kind,auth_user_id,started_date) from public.internal_org_people where id=p_person),
    'detail',(select jsonb_build_array(employment_type,working_weekdays,scheduled_employment_end_date) from private.employee_directory_details where person_id=p_person),
    'annual',(select to_jsonb(b) from private.employee_annual_leave_balances b where person_id=p_person),
    'personal',(select to_jsonb(b) from private.employee_sick_leave_balances b where person_id=p_person),
    'annualHistory',(select coalesce(jsonb_agg(to_jsonb(h) order by id),'[]') from private.annual_leave_balance_history h where person_id=p_person),
    'personalHistory',(select coalesce(jsonb_agg(to_jsonb(h) order by id),'[]') from private.sick_leave_balance_history h where person_id=p_person),
    'policies',(select coalesce(jsonb_agg(to_jsonb(p) order by id),'[]') from private.leave_accrual_policies p where person_id=p_person),
    'reviews',(select coalesce(jsonb_agg(to_jsonb(r) order by id),'[]') from private.leave_accrual_day_reviews r where person_id=p_person),
    'requests',(select coalesce(jsonb_agg(private.payroll_request_money(to_jsonb(r)) order by id),'[]') from public.leave_requests r where employee_person_id=p_person),
    'carry',(select coalesce(jsonb_agg(to_jsonb(e) order by id),'[]') from private.payroll_carryforward_events e where person_id=p_person)
  )::text,'UTF8')),'hex');
$$;
revoke all on function private.payroll_closing_fingerprint(uuid) from public,anon,authenticated,service_role;

create function public.preview_payroll_closing_reconciliation(p_person_id uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
begin
  perform private.payroll_closing_assert_actor();
  if not exists(select 1 from public.internal_org_people where id=p_person_id and node_kind='person' and is_active) then
    raise exception 'A canonical active employee is required.' using errcode='22023';
  end if;
  return jsonb_build_object('fingerprint',private.payroll_closing_fingerprint(p_person_id),
    'annual',(select to_jsonb(b) from private.employee_annual_leave_balances b where person_id=p_person_id),
    'personal',(select to_jsonb(b) from private.employee_sick_leave_balances b where person_id=p_person_id),
    'reservations',(select coalesce(jsonb_agg(to_jsonb(e)),'[]') from (select distinct on(request_id) * from private.payroll_carryforward_events where person_id=p_person_id order by request_id,id desc) e));
end;
$$;
revoke all on function public.preview_payroll_closing_reconciliation(uuid) from public,anon,authenticated,service_role;
grant execute on function public.preview_payroll_closing_reconciliation(uuid) to authenticated;

create table private.payroll_closing_write_claims (
  person_id uuid primary key references public.internal_org_people(id),
  transaction_id xid8 not null,
  receipt_id uuid not null references private.payroll_closing_receipts(id)
);
alter table private.payroll_closing_write_claims enable row level security;
alter table private.payroll_closing_write_claims force row level security;
revoke all on private.payroll_closing_write_claims from public,anon,authenticated,service_role;

create function private.payroll_closing_lock() returns void
language plpgsql security definer set search_path='' as $$
begin
  perform private.payroll_closing_assert_actor();
  lock table public.profiles,private.portal_account_admins,public.internal_org_people,
    private.employee_directory_details,public.leave_requests,private.leave_accrual_policies,
    private.leave_accrual_day_reviews,private.employee_annual_leave_balances,
    private.employee_sick_leave_balances,private.annual_leave_balance_history,
    private.sick_leave_balance_history,private.payroll_balance_imports,
    private.payroll_carryforward_events,private.payroll_closing_receipts,
    private.payroll_closing_write_claims in share row exclusive mode nowait;
  if to_regclass('private.portal_account_test_sessions') is not null then
    lock table private.portal_account_test_sessions in share row exclusive mode nowait;
  end if;
  perform private.payroll_closing_assert_actor();
end;
$$;
revoke all on function private.payroll_closing_lock() from public,anon,authenticated,service_role;

alter table private.employee_annual_leave_balances add column closing_receipt_id uuid references private.payroll_closing_receipts(id);
alter table private.employee_sick_leave_balances add column closing_receipt_id uuid references private.payroll_closing_receipts(id);

create function private.payroll_closing_snapshot_guard() returns trigger
language plpgsql security definer set search_path='' as $$
declare person uuid; receipt uuid;
begin
  person:=case when tg_op='DELETE' then old.person_id else new.person_id end;
  if tg_op='UPDATE' and new.person_id is distinct from old.person_id then
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
revoke all on function private.payroll_closing_snapshot_guard() from public,anon,authenticated,service_role;
create trigger payroll_closing_snapshot_guard before insert or update or delete on private.employee_annual_leave_balances for each row execute function private.payroll_closing_snapshot_guard();
create trigger payroll_closing_snapshot_guard before insert or update or delete on private.employee_sick_leave_balances for each row execute function private.payroll_closing_snapshot_guard();

alter function private.approved_leave_hours_after(uuid,text[],date) rename to approved_leave_hours_after_before_carryforward;
revoke all on function private.approved_leave_hours_after_before_carryforward(uuid,text[],date) from public,anon,authenticated,service_role;
create function private.approved_leave_hours_after(p_person_id uuid,p_leave_types text[],p_after date) returns numeric
language plpgsql stable security definer set search_path='' as $$
declare pending numeric;
begin
  if p_after is null then return null; end if;
  if exists(select 1 from (select distinct on(request_id) * from private.payroll_carryforward_events where person_id=p_person_id order by request_id,id desc) e
    join public.leave_requests r on r.id=e.request_id
    join public.internal_org_people p on p.id=e.person_id
    where e.request_fingerprint<>private.payroll_request_fingerprint(to_jsonb(r)) or e.company_key<>p.company_key) then
    return null;
  end if;
  select coalesce(sum(e.pending_hours),0) into pending
  from (select distinct on(request_id) * from private.payroll_carryforward_events where person_id=p_person_id order by request_id,id desc) e
  where e.through_date<=p_after and case when e.leave_kind='annual' then 'Annual leave'=any(p_leave_types)
    else ('Sick leave'=any(p_leave_types) or 'Carer''s leave'=any(p_leave_types)) end;
  return private.approved_leave_hours_after_before_carryforward(p_person_id,p_leave_types,p_after)+pending;
end;
$$;
revoke all on function private.approved_leave_hours_after(uuid,text[],date) from public,anon,authenticated,service_role;

create function private.payroll_request_hours_after(p_request uuid,p_after date) returns numeric
language sql stable security definer set search_path='' as $$
  select case when r.status<>'approved' or p_after is null then null else
    case when r.hours is null then (select count(*)*case when coalesce(r.employment_type_snapshot,d.employment_type)='full_time' then 7.6 else 7.5 end
      from generate_series(greatest(r.start_date,p_after+1),r.end_date,interval '1 day') day where extract(isodow from day) between 1 and 5)
    when r.start_time is null or r.end_time is null then r.hours*(select count(*) from generate_series(greatest(r.start_date,p_after+1),r.end_date,interval '1 day') day where extract(isodow from day) between 1 and 5)
      /nullif((select count(*) from generate_series(r.start_date,r.end_date,interval '1 day') day where extract(isodow from day) between 1 and 5),0)
    else (select coalesce(sum(case when day::date=r.start_date and day::date=r.end_date then extract(epoch from(r.end_time-r.start_time))/3600
      when day::date=r.start_date then extract(epoch from(time '18:00'-r.start_time))/3600
      when day::date=r.end_date then extract(epoch from(r.end_time-time '06:00'))/3600 else 12 end),0)
      from generate_series(greatest(r.start_date,p_after+1),r.end_date,interval '1 day') day where extract(isodow from day) between 1 and 5) end end
  from public.leave_requests r left join private.employee_directory_details d on d.person_id=r.employee_person_id where r.id=p_request;
$$;
revoke all on function private.payroll_request_hours_after(uuid,date) from public,anon,authenticated,service_role;

create function public.reconcile_payroll_closing(p_owner_key text,p_payload jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare receipt uuid:=gen_random_uuid(); closing date; person jsonb; allocation jsonb; pid uuid; rid uuid; result jsonb;
  bank_a private.employee_annual_leave_balances%rowtype; bank_s private.employee_sick_leave_balances%rowtype;
  old_event private.payroll_carryforward_events%rowtype; request public.leave_requests%rowtype;
  origin date; previous_through date; total numeric; future numeric; accounted numeric; pending numeric; known numeric;
  kind text; ah numeric; sh numeric; day date; review private.leave_accrual_day_reviews%rowtype; pol private.leave_accrual_policies%rowtype;
begin
  perform private.payroll_closing_assert_actor();
  if p_owner_key is null or length(p_owner_key) not between 1 and 160 or p_payload is null
    or jsonb_typeof(p_payload)<>'object' or p_payload->>'provenance' is distinct from 'owner_estimate'
    or length(btrim(coalesce(p_payload->>'note',''))) not between 1 and 1000
    or jsonb_typeof(p_payload->'people') is distinct from 'array' or jsonb_array_length(p_payload->'people') not between 1 and 20
    or (select count(*) from jsonb_object_keys(p_payload))<>4 then
    raise exception 'Invalid closing reconciliation payload.' using errcode='22023';
  end if;
  perform private.payroll_closing_lock();
  select r.result into result from private.payroll_closing_receipts r where owner_key=p_owner_key and actor_user_id=auth.uid() and operation='closing' and payload=p_payload;
  if found then return result; end if;
  if exists(select 1 from private.payroll_closing_receipts where owner_key=p_owner_key) then
    raise exception 'Reconciliation key has a different payload or actor.' using errcode='22023';
  end if;
  closing:=(p_payload->>'closingDate')::date;
  if closing is null or closing>(now() at time zone 'Australia/Melbourne')::date
    or (select count(distinct value->>'personId') from jsonb_array_elements(p_payload->'people'))<>jsonb_array_length(p_payload->'people') then
    raise exception 'Invalid closing date or duplicate person.' using errcode='22023';
  end if;
  result:=jsonb_build_object('receiptId',receipt,'committed',true,'people',jsonb_array_length(p_payload->'people'));
  insert into private.payroll_closing_receipts(id,owner_key,actor_user_id,operation,provenance,note,payload,result)
    values(receipt,p_owner_key,auth.uid(),'closing','owner_estimate',p_payload->>'note',p_payload,result);
  for person in select value from jsonb_array_elements(p_payload->'people') order by value->>'personId' loop
    pid:=(person->>'personId')::uuid; ah:=(person->>'annualHours')::numeric; sh:=(person->>'personalHours')::numeric;
    if (select count(*) from jsonb_object_keys(person))<>6 or ah is null or sh is null
      or ah::text in ('NaN','Infinity','-Infinity') or sh::text in ('NaN','Infinity','-Infinity')
      or ah not between 0 and 100000 or sh not between 0 and 100000 or ah<>round(ah,4) or sh<>round(sh,4)
      or person->>'expectedFingerprint' is distinct from private.payroll_closing_fingerprint(pid)
      or not exists(select 1 from public.internal_org_people p join private.employee_directory_details d on d.person_id=p.id
        where p.id=pid and p.is_active and p.node_kind='person' and p.company_key=person->>'company' and d.employment_type in ('full_time','part_time')) then
      raise exception 'Closing employee, values or fingerprint changed.' using errcode='22023';
    end if;
    select * into bank_a from private.employee_annual_leave_balances where person_id=pid;
    select * into bank_s from private.employee_sick_leave_balances where person_id=pid;
    if bank_a.person_id is null or bank_s.person_id is null or bank_a.is_example or closing<=greatest(bank_a.as_of,bank_s.as_of)
      or closing-least(bank_a.as_of,bank_s.as_of)>3660 then
      raise exception 'Authoritative opening balances and a newer closing date are required.' using errcode='22023';
    end if;
    for day in select x::date from generate_series(least(bank_a.as_of,bank_s.as_of)+1,closing,interval '1 day') x loop
      select * into pol from private.leave_accrual_policies where person_id=pid and effective_from<=day order by effective_from desc,created_at desc,id desc limit 1;
      if not found or pol.requires_review then raise exception 'Closing interval requires a confirmed accrual policy.' using errcode='55000'; end if;
      select * into review from private.leave_accrual_day_reviews where person_id=pid and service_date=day order by created_at desc,id desc limit 1;
      if found and review.request_fingerprint<>private.leave_accrual_request_fingerprint(pid,day) then
        raise exception 'A dated usage review changed.' using errcode='55000';
      end if;
    end loop;
    if jsonb_typeof(person->'reservations') is distinct from 'array' or jsonb_array_length(person->'reservations')>100
      or (select count(distinct value->>'requestId') from jsonb_array_elements(person->'reservations'))<>jsonb_array_length(person->'reservations') then
      raise exception 'Explicit unique request allocations are required.' using errcode='22023';
    end if;
    if exists(select 1 from public.leave_requests r where r.employee_person_id=pid and r.status='approved' and r.start_date<=closing
      and r.request_type_label in ('Annual leave','Sick leave','Carer''s leave')
      and (r.end_date>case when r.request_type_label='Annual leave' then bank_a.as_of else bank_s.as_of end
        or exists(select 1 from private.payroll_carryforward_events e where e.request_id=r.id and e.pending_hours>0))
      and not exists(select 1 from jsonb_array_elements(person->'reservations') x where x->>'requestId'=r.id::text)) then
      raise exception 'An outstanding approved request was omitted.' using errcode='22023';
    end if;
    for allocation in select value from jsonb_array_elements(person->'reservations') loop
      rid:=(allocation->>'requestId')::uuid; accounted:=(allocation->>'accountedHours')::numeric; pending:=(allocation->>'pendingHours')::numeric;
      select * into request from public.leave_requests where id=rid;
      if request.id is null or request.employee_person_id<>pid or request.status<>'approved' or request.pay_treatment is distinct from 'paid_entitlement'
        or request.request_type_label not in ('Annual leave','Sick leave','Carer''s leave') or request.start_date>closing
        or exists(select 1 from private.leave_balance_approvals where request_id=rid)
        or (select count(*) from jsonb_object_keys(allocation))<>3
        or accounted is null or pending is null or accounted<0 or pending<0
        or accounted::text in ('NaN','Infinity','-Infinity') or pending::text in ('NaN','Infinity','-Infinity')
        or accounted<>round(accounted,4) or pending<>round(pending,4) then
        raise exception 'Invalid canonical approved request allocation.' using errcode='22023';
      end if;
      kind:=case when request.request_type_label='Annual leave' then 'annual' else 'personal' end;
      select * into old_event from private.payroll_carryforward_events where request_id=rid order by id desc limit 1;
      origin:=case when old_event.id is not null then old_event.origin_after when kind='annual' then bank_a.as_of else bank_s.as_of end;
      previous_through:=coalesce(old_event.through_date,origin);
      if old_event.id is not null and (old_event.request_fingerprint<>private.payroll_request_fingerprint(to_jsonb(request)) or old_event.company_key<>person->>'company' or accounted<old_event.accounted_hours) then
        raise exception 'Protected request or cumulative usage changed.' using errcode='55000';
      end if;
      total:=private.payroll_request_hours_after(rid,origin); future:=private.payroll_request_hours_after(rid,closing);
      select coalesce(sum(case when kind='annual' then r.annual_taken_hours else r.personal_taken_hours end),0) into known
      from (select distinct on(service_date) * from private.leave_accrual_day_reviews where person_id=pid and service_date>previous_through and service_date<=closing
        and service_date between request.start_date and request.end_date order by service_date,created_at desc,id desc) r;
      if exists(select 1 from (select distinct on(service_date) * from private.leave_accrual_day_reviews where person_id=pid and service_date>previous_through and service_date<=closing
        and service_date between request.start_date and request.end_date order by service_date,created_at desc,id desc) r
        where (case when kind='annual' then r.annual_taken_hours else r.personal_taken_hours end)>0 and
          (select count(*) from public.leave_requests q where q.employee_person_id=pid and q.status='approved' and r.service_date between q.start_date and q.end_date
            and case when kind='annual' then q.request_type_label='Annual leave' else q.request_type_label in ('Sick leave','Carer''s leave') end)>1) then
        raise exception 'Dated usage allocation is ambiguous.' using errcode='55000';
      end if;
      if total is null or future is null or total<=0 or total>100000 or total<>round(total,4) or future<>round(future,4)
        or accounted<coalesce(old_event.accounted_hours,0)+known or pending<>total-accounted-future or pending<0 then
        raise exception 'Carry-forward must equal approved outstanding hours after cumulative accounted usage.' using errcode='22023';
      end if;
      insert into private.payroll_carryforward_events(receipt_id,request_id,person_id,company_key,leave_kind,origin_after,through_date,total_hours,accounted_hours,pending_hours,request_fingerprint)
      values(receipt,rid,pid,person->>'company',kind,origin,closing,total,accounted,pending,private.payroll_request_fingerprint(to_jsonb(request)));
    end loop;
    insert into private.payroll_closing_write_claims values(pid,pg_current_xact_id(),receipt);
    update private.employee_annual_leave_balances set hours=ah,as_of=closing,is_example=false,updated_by=auth.uid(),updated_at=clock_timestamp(),source_import_id=null where person_id=pid;
    update private.employee_sick_leave_balances set hours=sh,as_of=closing,updated_by=auth.uid(),updated_at=clock_timestamp(),source_import_id=null where person_id=pid;
    insert into private.annual_leave_balance_history(person_id,hours,as_of,is_example,actor_user_id) values(pid,ah,closing,false,auth.uid());
    insert into private.sick_leave_balance_history(person_id,hours,as_of,actor_user_id) values(pid,sh,closing,auth.uid());
    delete from private.payroll_closing_write_claims where person_id=pid;
  end loop;
  return result;
end;
$$;
revoke all on function public.reconcile_payroll_closing(text,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.reconcile_payroll_closing(text,jsonb) to authenticated;

create function public.settle_payroll_carryforward(p_owner_key text,p_payload jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare e private.payroll_carryforward_events%rowtype; r public.leave_requests%rowtype;
  receipt uuid:=gen_random_uuid(); pid uuid; rid uuid; amount numeric; result jsonb;
begin
  perform private.payroll_closing_assert_actor();
  if p_owner_key is null or length(p_owner_key) not between 1 and 160 or p_payload is null
    or jsonb_typeof(p_payload) is distinct from 'object' or (select count(*) from jsonb_object_keys(p_payload))<>6
    or p_payload->>'provenance' is distinct from 'confirmed_usage' or length(btrim(coalesce(p_payload->>'note',''))) not between 1 and 1000 then
    raise exception 'Invalid carry-forward settlement.' using errcode='22023';
  end if;
  perform private.payroll_closing_lock();
  select c.result into result from private.payroll_closing_receipts c where owner_key=p_owner_key and actor_user_id=auth.uid() and operation='settlement' and payload=p_payload;
  if found then return result; end if;
  if exists(select 1 from private.payroll_closing_receipts where owner_key=p_owner_key) then
    raise exception 'Reconciliation key has a different payload or actor.' using errcode='22023';
  end if;
  pid:=(p_payload->>'personId')::uuid; rid:=(p_payload->>'requestId')::uuid; amount:=(p_payload->>'hours')::numeric;
  select * into e from private.payroll_carryforward_events where request_id=rid order by id desc limit 1;
  select * into r from public.leave_requests where id=rid;
  if pid is null or rid is null or e.id is null or r.status is distinct from 'approved' or e.person_id<>pid
    or amount is null or amount<=0 or amount>e.pending_hours or amount<>round(amount,4) or amount::text in ('NaN','Infinity','-Infinity')
    or p_payload->>'expectedFingerprint' is distinct from private.payroll_closing_fingerprint(pid)
    or e.request_fingerprint<>private.payroll_request_fingerprint(to_jsonb(r))
    or not exists(select 1 from public.internal_org_people where id=pid and company_key=e.company_key and is_active and node_kind='person') then
    raise exception 'Carry-forward settlement values or source changed.' using errcode='22023';
  end if;
  if (e.leave_kind='annual' and not exists(select 1 from private.employee_annual_leave_balances b where person_id=pid and not is_example and as_of>=e.through_date and b.hours>=amount))
    or (e.leave_kind='personal' and not exists(select 1 from private.employee_sick_leave_balances b where person_id=pid and as_of>=e.through_date and b.hours>=amount)) then
    raise exception 'Authoritative balance is required.' using errcode='55000';
  end if;
  result:=jsonb_build_object('receiptId',receipt,'committed',true,'settledHours',amount);
  insert into private.payroll_closing_receipts(id,owner_key,actor_user_id,operation,provenance,note,payload,result)
    values(receipt,p_owner_key,auth.uid(),'settlement','confirmed_usage',p_payload->>'note',p_payload,result);
  insert into private.payroll_carryforward_events(receipt_id,request_id,person_id,company_key,leave_kind,origin_after,through_date,total_hours,accounted_hours,pending_hours,request_fingerprint)
    values(receipt,rid,pid,e.company_key,e.leave_kind,e.origin_after,e.through_date,e.total_hours,e.accounted_hours+amount,e.pending_hours-amount,e.request_fingerprint);
  insert into private.payroll_closing_write_claims values(pid,pg_current_xact_id(),receipt);
  if e.leave_kind='annual' then
    update private.employee_annual_leave_balances b set hours=b.hours-amount,updated_by=auth.uid(),updated_at=clock_timestamp(),source_import_id=null where person_id=pid;
    insert into private.annual_leave_balance_history(person_id,hours,as_of,is_example,actor_user_id)
      select pid,b.hours,b.as_of,false,auth.uid() from private.employee_annual_leave_balances b where person_id=pid;
  else
    update private.employee_sick_leave_balances b set hours=b.hours-amount,updated_by=auth.uid(),updated_at=clock_timestamp(),source_import_id=null where person_id=pid;
    insert into private.sick_leave_balance_history(person_id,hours,as_of,actor_user_id)
      select pid,b.hours,b.as_of,auth.uid() from private.employee_sick_leave_balances b where person_id=pid;
  end if;
  delete from private.payroll_closing_write_claims where person_id=pid;
  return result;
end;
$$;
revoke all on function public.settle_payroll_carryforward(text,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.settle_payroll_carryforward(text,jsonb) to authenticated;

create function private.payroll_carryforward_request_guard() returns trigger
language plpgsql security definer set search_path='' as $$
declare e private.payroll_carryforward_events%rowtype; receipt uuid:=gen_random_uuid();
begin
  select * into e from private.payroll_carryforward_events where request_id=old.id order by id desc limit 1;
  if not found then if tg_op='DELETE' then return old; else return new; end if; end if;
  if tg_op='DELETE' then raise exception 'Reconciled payroll requests retain their history.' using errcode='55000'; end if;
  if private.payroll_request_money(to_jsonb(new))=private.payroll_request_money(to_jsonb(old)) then return new; end if;
  if e.request_fingerprint<>private.payroll_request_fingerprint(to_jsonb(old)) or old.status<>'approved' or new.status<>'cancelled'
    or private.payroll_request_money(to_jsonb(new)||jsonb_build_object('status',old.status))<>private.payroll_request_money(to_jsonb(old)) then
    raise exception 'A reconciled request cannot change its payroll allocation.' using errcode='55000';
  end if;
  if auth.uid() is null or not private.is_active_portal_account() or coalesce((auth.jwt()->>'is_anonymous')::boolean,false)
    or (old.user_id is distinct from auth.uid() and not private.is_system_portal_account_admin()) then
    raise exception 'Cancellation requires the active owner or System Admin.' using errcode='42501';
  end if;
  insert into private.payroll_closing_receipts(id,owner_key,actor_user_id,operation,provenance,note,payload,result)
    values(receipt,'request-cancellation:'||old.id::text||':'||e.id::text,auth.uid(),'cancellation','request_cancellation',
      'Released only the unconsumed retained reservation; no balance refund.',
      jsonb_build_object('requestId',old.id,'previousEventId',e.id),jsonb_build_object('releasedHours',e.pending_hours));
  insert into private.payroll_carryforward_events(receipt_id,request_id,person_id,company_key,leave_kind,origin_after,through_date,total_hours,accounted_hours,pending_hours,request_fingerprint)
    values(receipt,old.id,e.person_id,e.company_key,e.leave_kind,e.origin_after,e.through_date,e.total_hours,e.accounted_hours,0,private.payroll_request_fingerprint(to_jsonb(new)));
  return new;
end;
$$;
revoke all on function private.payroll_carryforward_request_guard() from public,anon,authenticated,service_role;
create trigger payroll_carryforward_request_guard before update or delete on public.leave_requests for each row execute function private.payroll_carryforward_request_guard();

create function private.payroll_carryforward_review_guard() returns trigger
language plpgsql security definer set search_path='' as $$
declare person uuid; day date;
begin
  person:=case when tg_op='DELETE' then old.person_id else new.person_id end;
  day:=case when tg_op='DELETE' then old.service_date else new.service_date end;
  if exists(select 1 from private.payroll_carryforward_events where person_id=person and through_date>=day)
    or (tg_op='UPDATE' and exists(select 1 from private.payroll_carryforward_events where person_id=old.person_id and through_date>=old.service_date)) then
    raise exception 'Use audited carry-forward settlement instead of re-accounting a closed date.' using errcode='55000';
  end if;
  if tg_op='DELETE' then return old; end if;
  return new;
end;
$$;
revoke all on function private.payroll_carryforward_review_guard() from public,anon,authenticated,service_role;
create trigger payroll_carryforward_review_guard before insert or update or delete on private.leave_accrual_day_reviews for each row execute function private.payroll_carryforward_review_guard();

create function private.payroll_retained_hours(p_person uuid,p_kind text) returns numeric
language sql stable security definer set search_path='' as $$
  select coalesce(sum(pending_hours),0) from (select distinct on(request_id) * from private.payroll_carryforward_events where person_id=p_person order by request_id,id desc) e where leave_kind=p_kind;
$$;
revoke all on function private.payroll_retained_hours(uuid,text) from public,anon,authenticated,service_role;

alter function public.get_leave_priority_workspace(uuid) rename to get_leave_priority_workspace_before_carryforward;
revoke all on function public.get_leave_priority_workspace_before_carryforward(uuid) from public,anon,authenticated,service_role;
create function public.get_leave_priority_workspace(p_preview_person_id uuid default null) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare workspace jsonb; person jsonb; people jsonb:='[]'; pid uuid;
  a private.employee_annual_leave_balances%rowtype; s private.employee_sick_leave_balances%rowtype;
  approved numeric; provenance text;
begin
  workspace:=public.get_leave_priority_workspace_before_carryforward(p_preview_person_id);
  for person in select value from jsonb_array_elements(workspace->'people') loop
    pid:=(person->>'personId')::uuid;
    if coalesce((person->>'canViewBalance')::boolean,false) and coalesce((person->>'paidLeave')::boolean,false) then
      select * into a from private.employee_annual_leave_balances where person_id=pid;
      select case when r.operation='settlement' then 'owner_estimate' else r.provenance end into provenance from private.payroll_closing_receipts r where r.id=a.closing_receipt_id;
      approved:=private.approved_leave_hours_after(pid,array['Annual leave'],a.as_of);
      person:=person||jsonb_build_object('annualPayrollHours',case when not a.is_example then a.hours end,'annualPayrollDate',a.as_of,
        'annualApprovedHours',approved,'annualAvailableHours',case when not a.is_example then a.hours-approved end,
        'annualRetainedHours',case when not a.is_example then private.payroll_retained_hours(pid,'annual') end,
        'annualBalanceSource',provenance);
    end if;
    if coalesce((person->>'canViewSickBalance')::boolean,false) then
      select * into s from private.employee_sick_leave_balances where person_id=pid;
      select case when r.operation='settlement' then 'owner_estimate' else r.provenance end into provenance from private.payroll_closing_receipts r where r.id=s.closing_receipt_id;
      approved:=private.approved_leave_hours_after(pid,array['Sick leave','Carer''s leave'],s.as_of);
      person:=person||jsonb_build_object('sickPayrollHours',s.hours,'sickPayrollDate',s.as_of,'sickApprovedHours',approved,
        'sickAvailableHours',s.hours-approved,'sickRetainedHours',case when s.person_id is not null then private.payroll_retained_hours(pid,'personal') end,
        'sickBalanceSource',provenance);
    end if;
    people:=people||jsonb_build_array(person);
  end loop;
  return jsonb_set(workspace,'{people}',people);
end;
$$;
revoke all on function public.get_leave_priority_workspace(uuid) from public,anon,authenticated,service_role;
grant execute on function public.get_leave_priority_workspace(uuid) to authenticated;

alter function private.project_annual_leave_balance(uuid,date) rename to project_annual_leave_balance_before_carryforward;
revoke all on function private.project_annual_leave_balance_before_carryforward(uuid,date) from public,anon,authenticated,service_role;
create function private.project_annual_leave_balance(p_person uuid,p_start date) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare result jsonb; bank private.employee_annual_leave_balances%rowtype; provenance text;
begin
  select * into bank from private.employee_annual_leave_balances where person_id=p_person;
  if bank.person_id is null or bank.is_example or p_start is null
    or private.approved_leave_hours_after(p_person,array['Annual leave'],bank.as_of) is null then
    return jsonb_build_object('status','unavailable','projectedDate',p_start);
  end if;
  result:=private.project_annual_leave_balance_before_carryforward(p_person,p_start);
  select case when r.operation='settlement' then 'owner_estimate' else r.provenance end into provenance from private.payroll_closing_receipts r where id=bank.closing_receipt_id;
  return result||jsonb_build_object('retainedHours',private.payroll_retained_hours(p_person,'annual'),'balanceSource',provenance);
end;
$$;
revoke all on function private.project_annual_leave_balance(uuid,date) from public,anon,authenticated,service_role;

create function private.payroll_request_unconsumed_hours(p_person uuid,p_after date,p_through date) returns numeric
language plpgsql stable security definer set search_path='' as $$
declare committed numeric; consumed numeric:=0; day date; request_count integer; request_id uuid;
  scheduled numeric; employment_start date; employment_end date; review private.leave_accrual_day_reviews%rowtype;
begin
  if p_after is null or p_through is null or p_through<p_after or p_through-p_after>3660 then return null; end if;
  committed:=private.approved_leave_hours_after(p_person,array['Annual leave'],p_after);
  if committed is null then return null; end if;
  select p.started_date,d.scheduled_employment_end_date into employment_start,employment_end
    from public.internal_org_people p left join private.employee_directory_details d on d.person_id=p.id where p.id=p_person;
  for day in select x::date from generate_series(p_after+1,p_through,interval '1 day') x loop
    if day<coalesce(employment_start,day) or day>coalesce(employment_end,day) then continue; end if;
    select count(*),min(r.id::text)::uuid into request_count,request_id
    from public.leave_requests r where r.employee_person_id=p_person and r.status='approved'
      and r.request_type_label='Annual leave' and day between r.start_date and r.end_date
      and private.payroll_request_hours_after(r.id,day-1)>private.payroll_request_hours_after(r.id,day);
    select * into review from private.leave_accrual_day_reviews where person_id=p_person and service_date=day order by created_at desc,id desc limit 1;
    if (request_count>0 and review.id is null)
      or (review.id is not null and review.request_fingerprint<>private.leave_accrual_request_fingerprint(p_person,day))
      or (request_count>1 and review.annual_taken_hours>0) then return null; end if;
    if request_count=1 and review.annual_taken_hours>0 then
      scheduled:=private.payroll_request_hours_after(request_id,day-1)-private.payroll_request_hours_after(request_id,day);
      consumed:=consumed+least(review.annual_taken_hours,scheduled);
    end if;
  end loop;
  return committed-consumed;
end;
$$;
revoke all on function private.payroll_request_unconsumed_hours(uuid,date,date) from public,anon,authenticated,service_role;

do $$declare original text; updated text; begin
  original:=pg_get_functiondef('private.leave_payroll_balance_sufficient(uuid)'::regprocedure);
  updated:=replace(replace(original,'- coalesce(private.approved_leave_hours_after(','- (private.approved_leave_hours_after('),'), 0)', '))');
  updated:=replace(updated,E'private.approved_leave_hours_after(\n                person.id,\n                array[''Annual leave'']::text[],\n                (calculated.calculation ->> ''annualAsOf'')::date\n              )',
    E'private.payroll_request_unconsumed_hours(\n                person.id,\n                balance.as_of,\n                (calculated.calculation ->> ''annualAsOf'')::date\n              )');
  if updated=original or position('coalesce(private.approved_leave_hours_after' in updated)>0
    or position('private.payroll_request_unconsumed_hours(' in updated)=0 then
    raise exception 'Conditional balance predecessor differs.' using errcode='55000';
  end if;
  execute updated;
end$$;
revoke all on function private.leave_payroll_balance_sufficient(uuid) from public,anon,authenticated,service_role;

create trigger reject_retired_test_identity_reference before insert or update on private.payroll_closing_receipts
for each row execute function private.reject_retired_test_identity_reference();
create trigger reject_retired_test_identity_reference before insert or update on private.payroll_carryforward_events
for each row execute function private.reject_retired_test_identity_reference();
create trigger reject_retired_test_identity_reference before insert or update on private.payroll_closing_write_claims
for each row execute function private.reject_retired_test_identity_reference();

do $payroll_purge_after$
declare baseline pg_temp.payroll_purge_transition%rowtype; r record; query text; current_definitions text[]; reviewed_functions text[];
  reviewed_metadata text[]; normalized_definitions text[]; normalized_hash text; candidate_hash text; owner_name text;
begin
  select * into strict baseline from pg_temp.payroll_purge_transition;
  owner_name:=quote_ident(pg_get_userbyid(baseline.function_owner));
  select prosrc into query from pg_proc where oid='private.confirmed_test_purge_schema_hash()'::regprocedure;
  if encode(extensions.digest(query,'sha256'),'hex')<>'c142665fb247c8761de408ce241e2f97aabe719c5d0801a5c53905892dd3de16'
    or encode(extensions.digest(pg_get_functiondef('private.confirmed_test_purge_schema_hash()'::regprocedure),'sha256'),'hex')<>'3385d5a0140df3995e3196ffea442b4829f9a5357de3ccf5a8d521fbe9011a54' then
    raise exception 'Purge schema hash implementation changed' using errcode='55000';
  end if;
  for r in select * from (values
    ('private.approved_leave_hours_after(uuid,text[],date)','251bfea3140b47d8067928c2daf65801555b118a612c3cfa5989fae52141648b',false),
    ('private.approved_leave_hours_after_before_carryforward(uuid,text[],date)','4f97d5808c0bcef94a31dd75a3c2a39df3288f44713b6064b8b2be05bd2196fd',false),
    ('private.leave_payroll_balance_sufficient(uuid)','c38b9655a39149fc1d8b6c4d1f538f1cca22cf248ea61c2b9ba18f0022c56814',false),
    ('private.payroll_carryforward_request_guard()','64723760a9656849c5c02e4ed71d96a3b09407b0d3f8d20bb3f8cd880c3dd4dd',false),
    ('private.payroll_carryforward_review_guard()','119995d2c9ae476d30b7eda7fc5cc24a9c713613746e9bb43e67f01f6079680a',false),
    ('private.payroll_closing_assert_actor()','46fedb5c96bd26289271fd8f0daf18453c028f1d0ee82afcfad08ebc6600895a',false),
    ('private.payroll_closing_fingerprint(uuid)','fcb3cd13d50f90db2d48d99b2fe894a1e8a1d276acec44a89636e4ede393f664',false),
    ('private.payroll_closing_immutable()','11be86ce1c1df90c08ef68ab20a174105f81661e445df52c21433f552575e094',false),
    ('private.payroll_closing_lock()','bb684529912c708a04205df47e8b89dccc3bb06ba3d1cec908dc484d1701ced0',false),
    ('private.payroll_closing_snapshot_guard()','4e3e5456cd55475f72145dbfc800c0ead367092392ddb6b6dda27d3b478532a1',false),
    ('private.payroll_request_fingerprint(jsonb)','8484cb8932f3f62f9621f253f336c88ad023e639972a76251b4d859fb09578bf',false),
    ('private.payroll_request_hours_after(uuid,date)','3f4505db5271b025109f00cb7915435e852c5fa46fa20aabdd499e17786cf541',false),
    ('private.payroll_request_money(jsonb)','82cc51f45ad281342bbd563a87642cdc591386cc14a99cbbcce574c1ac748fcc',false),
    ('private.payroll_request_unconsumed_hours(uuid,date,date)','89a010fb374fd93dff5e5e3a6f0be23039a8e3946c31189c71d1696d225375bf',false),
    ('private.payroll_retained_hours(uuid,text)','20291b8a1c2d78212cc0a957dd95bef847d02404ecf2f51e42070b81fb3583eb',false),
    ('private.project_annual_leave_balance(uuid,date)','ee185baa6a8dfa834b77cdfeb60339e70d39f42915ec00112142536126c4de4a',false),
    ('private.project_annual_leave_balance_before_carryforward(uuid,date)','204ba442ebdbf785f79349f6f265389d1bfecba0035a8807362bc13320beb5b1',false),
    ('public.get_leave_priority_workspace(uuid)','14f3fab427dcf668cea958a12c5f63420a2a213a1f042e8ac96d33eb28c8010a',true),
    ('public.get_leave_priority_workspace_before_carryforward(uuid)','bf4994d3bfe0dd8a6fa6d05389b41d273cf59b03bf0541b0f83c212cbf3e73c1',false),
    ('public.preview_payroll_closing_reconciliation(uuid)','25a70dc8133395f81a0b535190697f62078a32ca9711d4ce3a6bcaff50b575e2',true),
    ('public.reconcile_payroll_closing(text,jsonb)','4d2b30bf9f95b65ecfb72b7e76190d9109211c67bba45d08aafec7337397b518',true),
    ('public.settle_payroll_carryforward(text,jsonb)','7a610c4455c7d5190a3d2fe2eed32f7db03c8db3847c2b0dc0ca0f73ce0cd54c',true)
  ) expected(signature,definition_sha256,authenticated_execute) loop
    if not exists(select 1 from pg_proc p where p.oid=to_regprocedure(r.signature)
      and encode(extensions.digest(pg_get_functiondef(p.oid),'sha256'),'hex')=r.definition_sha256
      and p.proowner=baseline.function_owner
      and p.proacl::text=case when r.authenticated_execute then format('{%s=X/%s,authenticated=X/%s}',owner_name,owner_name,owner_name)
        else format('{%s=X/%s}',owner_name,owner_name) end) then
      raise exception 'Reviewed payroll function definition/owner/ACL drift (%)',r.signature using errcode='55000';
    end if;
  end loop;
  select array_agg(definition order by definition) from (select pg_get_functiondef(p.oid) as definition from pg_proc p where p.oid=any(array['private.approved_leave_hours_after(uuid,text[],date)'::regprocedure,'private.approved_leave_hours_after_before_carryforward(uuid,text[],date)'::regprocedure,'private.leave_payroll_balance_sufficient(uuid)'::regprocedure,'private.payroll_carryforward_request_guard()'::regprocedure,'private.payroll_carryforward_review_guard()'::regprocedure,'private.payroll_closing_assert_actor()'::regprocedure,'private.payroll_closing_fingerprint(uuid)'::regprocedure,'private.payroll_closing_immutable()'::regprocedure,'private.payroll_closing_lock()'::regprocedure,'private.payroll_closing_snapshot_guard()'::regprocedure,'private.payroll_request_fingerprint(jsonb)'::regprocedure,'private.payroll_request_hours_after(uuid,date)'::regprocedure,'private.payroll_request_money(jsonb)'::regprocedure,'private.payroll_request_unconsumed_hours(uuid,date,date)'::regprocedure,'private.payroll_retained_hours(uuid,text)'::regprocedure,'private.project_annual_leave_balance(uuid,date)'::regprocedure,'private.project_annual_leave_balance_before_carryforward(uuid,date)'::regprocedure,'public.get_leave_priority_workspace(uuid)'::regprocedure,'public.get_leave_priority_workspace_before_carryforward(uuid)'::regprocedure,'public.preview_payroll_closing_reconciliation(uuid)'::regprocedure,'public.reconcile_payroll_closing(text,jsonb)'::regprocedure,'public.settle_payroll_carryforward(text,jsonb)'::regprocedure]) union all select p.oid::regprocedure::text||':'||p.proowner::text||':'||coalesce(p.proacl::text,'default') from pg_proc p where p.oid=any(array['private.approved_leave_hours_after(uuid,text[],date)'::regprocedure,'private.approved_leave_hours_after_before_carryforward(uuid,text[],date)'::regprocedure,'private.leave_payroll_balance_sufficient(uuid)'::regprocedure,'private.payroll_carryforward_request_guard()'::regprocedure,'private.payroll_carryforward_review_guard()'::regprocedure,'private.payroll_closing_assert_actor()'::regprocedure,'private.payroll_closing_fingerprint(uuid)'::regprocedure,'private.payroll_closing_immutable()'::regprocedure,'private.payroll_closing_lock()'::regprocedure,'private.payroll_closing_snapshot_guard()'::regprocedure,'private.payroll_request_fingerprint(jsonb)'::regprocedure,'private.payroll_request_hours_after(uuid,date)'::regprocedure,'private.payroll_request_money(jsonb)'::regprocedure,'private.payroll_request_unconsumed_hours(uuid,date,date)'::regprocedure,'private.payroll_retained_hours(uuid,text)'::regprocedure,'private.project_annual_leave_balance(uuid,date)'::regprocedure,'private.project_annual_leave_balance_before_carryforward(uuid,date)'::regprocedure,'public.get_leave_priority_workspace(uuid)'::regprocedure,'public.get_leave_priority_workspace_before_carryforward(uuid)'::regprocedure,'public.preview_payroll_closing_reconciliation(uuid)'::regprocedure,'public.reconcile_payroll_closing(text,jsonb)'::regprocedure,'public.settle_payroll_carryforward(text,jsonb)'::regprocedure])) f into reviewed_functions;
  reviewed_metadata:=array[
    'private.employee_annual_leave_balances:FOREIGN KEY (closing_receipt_id) REFERENCES private.payroll_closing_receipts(id)',
    'private.employee_annual_leave_balances:O:CREATE TRIGGER payroll_closing_snapshot_guard BEFORE INSERT OR DELETE OR UPDATE ON private.employee_annual_leave_balances FOR EACH ROW EXECUTE FUNCTION private.payroll_closing_snapshot_guard()',
    'private.employee_annual_leave_balances:closing_receipt_id:uuid:false',
    'private.employee_sick_leave_balances:FOREIGN KEY (closing_receipt_id) REFERENCES private.payroll_closing_receipts(id)',
    'private.employee_sick_leave_balances:O:CREATE TRIGGER payroll_closing_snapshot_guard BEFORE INSERT OR DELETE OR UPDATE ON private.employee_sick_leave_balances FOR EACH ROW EXECUTE FUNCTION private.payroll_closing_snapshot_guard()',
    'private.employee_sick_leave_balances:closing_receipt_id:uuid:false',
    'private.leave_accrual_day_reviews:O:CREATE TRIGGER payroll_carryforward_review_guard BEFORE INSERT OR DELETE OR UPDATE ON private.leave_accrual_day_reviews FOR EACH ROW EXECUTE FUNCTION private.payroll_carryforward_review_guard()',
    'private.payroll_carryforward_events:'||baseline.function_owner::text||':'||acldefault('r',baseline.function_owner)::text,
    'private.payroll_carryforward_events:CHECK (((accounted_hours >= (0)::numeric) AND (accounted_hours <= total_hours)))',
    'private.payroll_carryforward_events:CHECK (((pending_hours >= (0)::numeric) AND ((pending_hours + accounted_hours) <= total_hours)))',
    'private.payroll_carryforward_events:CHECK (((total_hours > (0)::numeric) AND (total_hours <= (100000)::numeric)))',
    'private.payroll_carryforward_events:CHECK ((company_key = ANY (ARRAY[''mam''::text, ''equipsy''::text])))',
    'private.payroll_carryforward_events:CHECK ((leave_kind = ANY (ARRAY[''annual''::text, ''personal''::text])))',
    'private.payroll_carryforward_events:CHECK ((request_fingerprint ~ ''^[0-9a-f]{64}$''::text))',
    'private.payroll_carryforward_events:CHECK ((through_date >= origin_after))',
    'private.payroll_carryforward_events:FOREIGN KEY (person_id, company_key) REFERENCES public.internal_org_people(id, company_key)',
    'private.payroll_carryforward_events:FOREIGN KEY (receipt_id) REFERENCES private.payroll_closing_receipts(id)',
    'private.payroll_carryforward_events:FOREIGN KEY (request_id, person_id) REFERENCES public.leave_requests(id, employee_person_id)',
    'private.payroll_carryforward_events:O:CREATE TRIGGER payroll_carryforward_immutable BEFORE DELETE OR UPDATE ON private.payroll_carryforward_events FOR EACH ROW EXECUTE FUNCTION private.payroll_closing_immutable()',
    'private.payroll_carryforward_events:O:CREATE TRIGGER payroll_carryforward_no_truncate BEFORE TRUNCATE ON private.payroll_carryforward_events FOR EACH STATEMENT EXECUTE FUNCTION private.payroll_closing_immutable()',
    'private.payroll_carryforward_events:PRIMARY KEY (id)',
    'private.payroll_carryforward_events:UNIQUE (receipt_id, request_id)',
    'private.payroll_carryforward_events:accounted_hours:numeric(12,4):true',
    'private.payroll_carryforward_events:company_key:text:true',
    'private.payroll_carryforward_events:id:bigint:true',
    'private.payroll_carryforward_events:leave_kind:text:true',
    'private.payroll_carryforward_events:origin_after:date:true',
    'private.payroll_carryforward_events:pending_hours:numeric(12,4):true',
    'private.payroll_carryforward_events:person_id:uuid:true',
    'private.payroll_carryforward_events:r:true:true',
    'private.payroll_carryforward_events:receipt_id:uuid:true',
    'private.payroll_carryforward_events:request_fingerprint:text:true',
    'private.payroll_carryforward_events:request_id:uuid:true',
    'private.payroll_carryforward_events:through_date:date:true',
    'private.payroll_carryforward_events:total_hours:numeric(12,4):true',
    'private.payroll_carryforward_events_id_seq:is_called:boolean:true',
    'private.payroll_carryforward_events_id_seq:last_value:bigint:true',
    'private.payroll_carryforward_events_id_seq:log_cnt:bigint:true',
    'private.payroll_carryforward_events_pkey:id:bigint:false',
    'private.payroll_carryforward_events_receipt_id_request_id_key:receipt_id:uuid:false',
    'private.payroll_carryforward_events_receipt_id_request_id_key:request_id:uuid:false',
    'private.payroll_carryforward_latest:id:bigint:false',
    'private.payroll_carryforward_latest:request_id:uuid:false',
    'private.payroll_closing_receipts:'||baseline.function_owner::text||':'||acldefault('r',baseline.function_owner)::text,
    'private.payroll_closing_receipts:CHECK (((length(btrim(note)) >= 1) AND (length(btrim(note)) <= 1000)))',
    'private.payroll_closing_receipts:CHECK (((length(owner_key) >= 1) AND (length(owner_key) <= 160)))',
    'private.payroll_closing_receipts:CHECK ((operation = ANY (ARRAY[''closing''::text, ''settlement''::text, ''cancellation''::text])))',
    'private.payroll_closing_receipts:CHECK ((provenance = ANY (ARRAY[''owner_estimate''::text, ''confirmed_usage''::text, ''request_cancellation''::text])))',
    'private.payroll_closing_receipts:FOREIGN KEY (actor_user_id) REFERENCES public.profiles(id)',
    'private.payroll_closing_receipts:O:CREATE TRIGGER payroll_closing_immutable BEFORE DELETE OR UPDATE ON private.payroll_closing_receipts FOR EACH ROW EXECUTE FUNCTION private.payroll_closing_immutable()',
    'private.payroll_closing_receipts:O:CREATE TRIGGER payroll_closing_no_truncate BEFORE TRUNCATE ON private.payroll_closing_receipts FOR EACH STATEMENT EXECUTE FUNCTION private.payroll_closing_immutable()',
    'private.payroll_closing_receipts:PRIMARY KEY (id)',
    'private.payroll_closing_receipts:UNIQUE (owner_key)',
    'private.payroll_closing_receipts:actor_user_id:uuid:true',
    'private.payroll_closing_receipts:created_at:timestamp with time zone:true',
    'private.payroll_closing_receipts:id:uuid:true',
    'private.payroll_closing_receipts:note:text:true',
    'private.payroll_closing_receipts:operation:text:true',
    'private.payroll_closing_receipts:owner_key:text:true',
    'private.payroll_closing_receipts:payload:jsonb:true',
    'private.payroll_closing_receipts:provenance:text:true',
    'private.payroll_closing_receipts:r:true:true',
    'private.payroll_closing_receipts:result:jsonb:true',
    'private.payroll_closing_receipts_owner_key_key:owner_key:text:false',
    'private.payroll_closing_receipts_pkey:id:uuid:false',
    'private.payroll_closing_write_claims:'||baseline.function_owner::text||':'||acldefault('r',baseline.function_owner)::text,
    'private.payroll_closing_write_claims:FOREIGN KEY (person_id) REFERENCES public.internal_org_people(id)',
    'private.payroll_closing_write_claims:FOREIGN KEY (receipt_id) REFERENCES private.payroll_closing_receipts(id)',
    'private.payroll_closing_write_claims:PRIMARY KEY (person_id)',
    'private.payroll_closing_write_claims:person_id:uuid:true',
    'private.payroll_closing_write_claims:r:true:true',
    'private.payroll_closing_write_claims:receipt_id:uuid:true',
    'private.payroll_closing_write_claims:transaction_id:xid8:true',
    'private.payroll_closing_write_claims_pkey:person_id:uuid:false',
    'public.internal_org_people:UNIQUE (id, company_key)',
    'public.leave_requests:O:CREATE TRIGGER payroll_carryforward_request_guard BEFORE DELETE OR UPDATE ON public.leave_requests FOR EACH ROW EXECUTE FUNCTION private.payroll_carryforward_request_guard()',
    'public.leave_requests:UNIQUE (id, employee_person_id)',
    'public.payroll_closing_person_company:company_key:text:false',
    'public.payroll_closing_person_company:id:uuid:false',
    'public.payroll_closing_request_person:employee_person_id:uuid:false',
    'public.payroll_closing_request_person:id:uuid:false',
    'private.payroll_closing_receipts:O:CREATE TRIGGER reject_retired_test_identity_reference BEFORE INSERT OR UPDATE ON private.payroll_closing_receipts FOR EACH ROW EXECUTE FUNCTION private.reject_retired_test_identity_reference()',
    'private.payroll_carryforward_events:O:CREATE TRIGGER reject_retired_test_identity_reference BEFORE INSERT OR UPDATE ON private.payroll_carryforward_events FOR EACH ROW EXECUTE FUNCTION private.reject_retired_test_identity_reference()',
    'private.payroll_closing_write_claims:O:CREATE TRIGGER reject_retired_test_identity_reference BEFORE INSERT OR UPDATE ON private.payroll_closing_write_claims FOR EACH ROW EXECUTE FUNCTION private.reject_retired_test_identity_reference()'
  ];
  execute 'select array_agg(definition order by definition) from ('||regexp_replace(baseline.collector,';[[:space:]]*$','')||') definitions' into current_definitions;
  candidate_hash:=private.confirmed_test_purge_schema_hash();
  if exists(select unnest(reviewed_metadata||reviewed_functions) except all select unnest(current_definitions)) then
    raise exception 'Reviewed payroll catalog delta is missing' using errcode='55000';
  end if;
  select array_agg(definition order by definition),encode(extensions.digest(coalesce(string_agg(definition,E'\n' order by definition),''),'sha256'),'hex')
    into normalized_definitions,normalized_hash from (
    (select unnest(current_definitions) as definition except all select unnest(reviewed_metadata||reviewed_functions))
    union all select unnest(baseline.functions)
  ) normalized;
  if normalized_definitions is distinct from baseline.definitions or normalized_hash is distinct from baseline.schema_hash then
    raise exception 'Unreviewed schema change during payroll migration' using errcode='55000';
  end if;
  if (select jsonb_build_object(
    'column_acls',(select coalesce(jsonb_agg(jsonb_build_array(a.attrelid::regclass::text,a.attname,a.attacl::text) order by a.attrelid,a.attnum),'[]') from pg_attribute a join pg_class c on c.oid=a.attrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname in ('public','private','storage') and a.attnum>0 and not a.attisdropped and a.attacl is not null),
    'schema_acls',(select jsonb_agg(jsonb_build_array(nspname,nspowner,nspacl::text) order by nspname) from pg_namespace where nspname in ('public','private','storage','auth')),
    'default_acls',(select coalesce(jsonb_agg(to_jsonb(d) order by oid),'[]') from pg_default_acl d),
    'roles',(select jsonb_agg(jsonb_build_array(oid,rolname,rolsuper,rolinherit,rolcreaterole,rolcreatedb,rolcanlogin,rolreplication,rolbypassrls) order by oid) from pg_roles))) is distinct from baseline.extra_catalog then
    raise exception 'Unreviewed column/schema/default ACL or role change during payroll migration' using errcode='55000';
  end if;
  if (select encode(extensions.digest(coalesce(jsonb_agg(to_jsonb(p) order by id),'[]')::text,'sha256'),'hex') from private.confirmed_test_identity_purges p) is distinct from baseline.receipts_hash then
    raise exception 'Existing purge receipts changed during payroll migration' using errcode='55000';
  end if;
  update private.confirmed_test_purge_schema set schema_hash=candidate_hash where singleton and schema_hash=baseline.schema_hash;
  if not found then raise exception 'Purge schema predecessor changed' using errcode='40001'; end if;
  execute 'select array_agg(definition order by definition) from ('||regexp_replace(baseline.collector,';[[:space:]]*$','')||') definitions' into normalized_definitions;
  if normalized_definitions is distinct from current_definitions
    or private.confirmed_test_purge_schema_hash() is distinct from candidate_hash
    or (select jsonb_build_object(
    'column_acls',(select coalesce(jsonb_agg(jsonb_build_array(a.attrelid::regclass::text,a.attname,a.attacl::text) order by a.attrelid,a.attnum),'[]') from pg_attribute a join pg_class c on c.oid=a.attrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname in ('public','private','storage') and a.attnum>0 and not a.attisdropped and a.attacl is not null),
    'schema_acls',(select jsonb_agg(jsonb_build_array(nspname,nspowner,nspacl::text) order by nspname) from pg_namespace where nspname in ('public','private','storage','auth')),
    'default_acls',(select coalesce(jsonb_agg(to_jsonb(d) order by oid),'[]') from pg_default_acl d),
    'roles',(select jsonb_agg(jsonb_build_array(oid,rolname,rolsuper,rolinherit,rolcreaterole,rolcreatedb,rolcanlogin,rolreplication,rolbypassrls) order by oid) from pg_roles))) is distinct from baseline.extra_catalog
    or (select encode(extensions.digest(coalesce(jsonb_agg(to_jsonb(p) order by id),'[]')::text,'sha256'),'hex') from private.confirmed_test_identity_purges p) is distinct from baseline.receipts_hash then
    raise exception 'Late unreviewed payroll migration change' using errcode='55000';
  end if;
end $payroll_purge_after$;

commit;
