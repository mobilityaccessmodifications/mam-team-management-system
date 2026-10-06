begin;

set local search_path='';

do $$ begin
  if encode(extensions.digest(pg_get_functiondef('private.confirmed_test_purge_schema_hash()'::regprocedure),'sha256'),'hex')
    is distinct from '3385d5a0140df3995e3196ffea442b4829f9a5357de3ccf5a8d521fbe9011a54' then
    raise exception 'Annual leave gate catalog collector differs.' using errcode='55000';
  end if;
end $$;

do $$ declare signature text; expected text; begin
  for signature,expected in values
    ('private.enforce_banked_annual_leave_request()','1bb3697fa52dd3c7b7ad6edab3896c926ae6d91eb9d25fba9dc95a67a3ed057c'),
    ('private.fill_leave_balance_required_hours()','7740bdac9a0969b6d4d00d6a6df55d01b78189bfedef041223381eba6d7741da'),
    ('public.decide_leave_with_balance(uuid,text,text)','40e0e349f2e32bfb8ebb7941ea4a1eb2b8dc4ddb0b9d0b5452fd913e3b1c7822'),
    ('public.decide_my_managed_leave_request(uuid,text,text)','7c355635350aa346f99c108632698a21bee303047b8ba42b29c42f8c278ccd4c')
  loop
    if encode(extensions.digest(pg_get_functiondef(to_regprocedure(signature)),'sha256'),'hex') is distinct from expected then
      raise exception 'Annual leave gate predecessor definition differs: %',signature using errcode='55000';
    end if;
  end loop;
end $$;

lock table public.leave_requests,private.employee_annual_leave_balances,private.employee_directory_details,
  private.leave_accrual_policies,private.leave_accrual_day_reviews,private.payroll_carryforward_events,
  private.leave_balance_approvals,public.internal_org_people in access exclusive mode nowait;

do $$ declare query text; anchor text;
begin
  if private.confirmed_test_purge_schema_hash() is distinct from
    (select schema_hash from private.confirmed_test_purge_schema where singleton) then
    raise exception 'Annual leave gate predecessor catalog differs.' using errcode='55000';
  end if;
  select prosrc into query from pg_proc where oid='private.confirmed_test_purge_schema_hash()'::regprocedure;
  anchor:=E'select encode(extensions.digest(coalesce(string_agg(definition,E''\\n'' order by definition),''''),''sha256''),''hex'') from (';
  if (length(query)-length(replace(query,anchor,'')))/length(anchor)<>1 then
    raise exception 'Annual leave gate catalog collector differs.' using errcode='55000';
  end if;
  execute 'create function pg_temp.annual_gate_catalog() returns table(definition text) language sql stable set search_path='''' as '
    ||quote_literal(replace(query,anchor,'select definition from ('));
end;
$$;

create temporary table annual_gate_catalog_before on commit drop as select * from pg_temp.annual_gate_catalog();
create temporary table annual_gate_functions(signature text primary key,is_new boolean) on commit drop;
insert into annual_gate_functions values
  ('private.enforce_banked_annual_leave_request()',false),('private.fill_leave_balance_required_hours()',false),
  ('public.decide_my_managed_leave_request(uuid,text,text)',false),('public.decide_leave_with_balance(uuid,text,text)',false),
  ('private.lock_annual_leave_budget(boolean)',true),('private.lock_annual_leave_budget_statement()',true),
  ('private.refresh_annual_leave_required_hours()',true),('private.guard_legacy_annual_leave_classification()',true);
create temporary table annual_gate_function_before on commit drop as
select a.signature,pg_get_functiondef(p.oid) definition,
  p.oid::regprocedure::text||':'||p.proowner::text||':'||coalesce(p.proacl::text,'default') acl_definition,
  (to_jsonb(p)-array['oid','prosrc','prosqlbody','proargdefaults'])
    ||jsonb_build_object('parameter_defaults',pg_get_expr(p.proargdefaults,0)) metadata
from annual_gate_functions a join pg_proc p on p.oid=to_regprocedure(a.signature);
do $$ begin
  if (select count(*) from annual_gate_function_before)<>4 or exists(
    select 1 from annual_gate_functions where is_new and to_regprocedure(signature) is not null) then
    raise exception 'Annual leave gate function predecessor differs.' using errcode='55000';
  end if;
end $$;
create temporary table annual_gate_triggers(relation regclass,name text,signature text,trigger_type integer,
  definition_sha256 text,primary key(relation,name)) on commit drop;
insert into annual_gate_triggers(relation,name,signature,trigger_type) values
  ('public.leave_requests','z_leave_requests_banked_annual_limit','private.enforce_banked_annual_leave_request()',23),
  ('private.leave_balance_approvals','leave_balance_approvals_fill_required_hours','private.fill_leave_balance_required_hours()',23),
  ('public.leave_requests','z_leave_requests_refresh_required_hours','private.refresh_annual_leave_required_hours()',17),
  ('private.employee_directory_details','aa_guard_legacy_annual_leave_classification','private.guard_legacy_annual_leave_classification()',19);
insert into annual_gate_triggers(relation,name,signature,trigger_type)
select relation::regclass,'aa_lock_annual_leave_budget','private.lock_annual_leave_budget_statement()',
  case when relation='public.internal_org_people' then 26 else 30 end
from unnest(array['private.employee_annual_leave_balances','private.employee_directory_details',
  'private.leave_accrual_policies','private.leave_accrual_day_reviews','private.payroll_carryforward_events',
  'private.leave_balance_approvals','public.internal_org_people']) relation;
update annual_gate_triggers a set definition_sha256=p.sha256 from (values
  ('private.employee_annual_leave_balances','aa_lock_annual_leave_budget','57703982a8e928d96c1c0eee3a73625cd0ac69589471e42432164fbf1c74ce38'),
  ('private.employee_directory_details','aa_guard_legacy_annual_leave_classification','bd151883ec6de51189c7a14df522565d5a5dfb68517b248cf51c149a49951c08'),
  ('private.employee_directory_details','aa_lock_annual_leave_budget','bff1d31011d13842bf125493a01572b60be3933ba03e559a78999c8163c46f72'),
  ('private.leave_accrual_day_reviews','aa_lock_annual_leave_budget','9f128b2804651f87147851bc72d87ae781f36becd9541e55b6d02b0638afa70c'),
  ('private.leave_accrual_policies','aa_lock_annual_leave_budget','9f02a3d4c95f5a392a746fc625e817fe76f0867fb242fcb813bc4fbd44d7d539'),
  ('private.leave_balance_approvals','aa_lock_annual_leave_budget','ba66ada3d85510f4df6e1cd86f70a104c469ce1f0c083ecc4858c4f0c6ade685'),
  ('private.leave_balance_approvals','leave_balance_approvals_fill_required_hours','a4faa4a415710a6b1e49dd3b095ad50b17dfd13198dd3013ac43c94c26fd39e5'),
  ('private.payroll_carryforward_events','aa_lock_annual_leave_budget','9650175efcbf1053abdcbdbaa1ed5d0fd9d79c3930d76cacaf202b9d3e760e8c'),
  ('public.internal_org_people','aa_lock_annual_leave_budget','d77bd824e98cf162fd5faab4080f9a8781a8c9d83d2896106f4ccbc98efd3ca0'),
  ('public.leave_requests','z_leave_requests_banked_annual_limit','6c9dda69b324fe9db9b62afb132c9c042ed7d810e3afa51c78304cdd5cc3100a'),
  ('public.leave_requests','z_leave_requests_refresh_required_hours','947bd66ad705a1662d70c7f0018827de1473b1940cee078f3737edd2b6696d43')
) p(relation,name,sha256) where a.relation=p.relation::regclass and a.name=p.name;
create function pg_temp.annual_gate_assert_triggers() returns void language plpgsql set search_path='' as $$
begin
  if (select count(*) from pg_temp.annual_gate_triggers)<>11 or exists(
    select 1 from pg_temp.annual_gate_triggers a left join pg_trigger t on t.tgrelid=a.relation and t.tgname=a.name
    where a.definition_sha256 is null or t.oid is null or t.tgenabled<>'O' or t.tgtype<>a.trigger_type
      or t.tgfoid<>to_regprocedure(a.signature)
      or encode(extensions.digest(pg_get_triggerdef(t.oid),'sha256'),'hex') is distinct from a.definition_sha256) then
    raise exception 'Annual leave gate exact trigger definition differs.' using errcode='55000';
  end if;
end;
$$;
create temporary table annual_gate_trigger_before on commit drop as
select t.tgrelid::regclass::text||':'||t.tgenabled::text||':'||pg_get_triggerdef(t.oid) definition
from pg_trigger t join annual_gate_triggers a on a.relation=t.tgrelid and a.name=t.tgname;
do $$ begin
  if (select count(*) from annual_gate_trigger_before)<>2 then
    raise exception 'Annual leave gate trigger predecessor differs.' using errcode='55000';
  end if;
end $$;
create function pg_temp.annual_gate_data_hash() returns text language sql stable set search_path='' as $$
  select encode(extensions.digest(jsonb_build_object(
    'requests',(select coalesce(jsonb_agg(to_jsonb(r) order by r.id),'[]') from public.leave_requests r),
    'balances',(select coalesce(jsonb_agg(to_jsonb(r) order by r.person_id),'[]') from private.employee_annual_leave_balances r),
    'directory',(select coalesce(jsonb_agg(to_jsonb(r) order by r.person_id),'[]') from private.employee_directory_details r),
    'conditional',(select coalesce(jsonb_agg(to_jsonb(r) order by r.request_id),'[]') from private.leave_balance_approvals r),
    'retained',(select coalesce(jsonb_agg(to_jsonb(r) order by r.id),'[]') from private.payroll_carryforward_events r)
  )::text,'sha256'),'hex');
$$;
create temporary table annual_gate_data_before on commit drop as select pg_temp.annual_gate_data_hash() sha256;

create function private.lock_annual_leave_budget(p_wait boolean default false)
returns void language plpgsql volatile security definer set search_path='' as $$
begin
  if p_wait then
    perform pg_advisory_xact_lock(hashtextextended('mam:annual-leave-budget',0));
  elsif not pg_try_advisory_xact_lock(hashtextextended('mam:annual-leave-budget',0)) then
    raise exception 'Annual leave budget is being updated. Refresh and try again.' using errcode='55P03';
  end if;
end;
$$;
revoke all on function private.lock_annual_leave_budget(boolean) from public,anon,authenticated,service_role;

create function private.lock_annual_leave_budget_statement()
returns trigger language plpgsql volatile security definer set search_path='' as $$
begin
  perform private.lock_annual_leave_budget();
  return null;
end;
$$;
revoke all on function private.lock_annual_leave_budget_statement() from public,anon,authenticated,service_role;

create trigger aa_lock_annual_leave_budget before insert or update or delete on private.employee_annual_leave_balances
for each statement execute function private.lock_annual_leave_budget_statement();
create trigger aa_lock_annual_leave_budget before insert or update or delete on private.employee_directory_details
for each statement execute function private.lock_annual_leave_budget_statement();
create trigger aa_lock_annual_leave_budget before insert or update or delete on private.leave_accrual_policies
for each statement execute function private.lock_annual_leave_budget_statement();
create trigger aa_lock_annual_leave_budget before insert or update or delete on private.leave_accrual_day_reviews
for each statement execute function private.lock_annual_leave_budget_statement();
create trigger aa_lock_annual_leave_budget before insert or update or delete on private.payroll_carryforward_events
for each statement execute function private.lock_annual_leave_budget_statement();
create trigger aa_lock_annual_leave_budget before insert or update or delete on private.leave_balance_approvals
for each statement execute function private.lock_annual_leave_budget_statement();
create trigger aa_lock_annual_leave_budget before update of started_date,is_active,company_key or delete on public.internal_org_people
for each statement execute function private.lock_annual_leave_budget_statement();

do $$
declare signature text; definition text; anchor text;
begin
  for signature,anchor in values
    ('public.decide_my_managed_leave_request(uuid,text,text)',E'  select request.*\n  into v_request\n  from public.leave_requests request\n  where request.id = p_request_id\n  for update;'),
    ('public.decide_leave_with_balance(uuid,text,text)',E'  select *\n  into r\n  from public.leave_requests\n  where leave_requests.id = p_request_id\n  for update;')
  loop
    definition:=pg_get_functiondef(to_regprocedure(signature));
    if definition is null or (length(definition)-length(replace(definition,anchor,'')))/length(anchor)<>1 then
      raise exception 'Annual leave decision predecessor differs: %',signature using errcode='55000';
    end if;
    execute replace(definition,anchor,case when signature='public.decide_my_managed_leave_request(uuid,text,text)'
      then E'  if p_status = ''Approved'' then perform private.lock_annual_leave_budget(true); end if;\n\n'
      else E'  perform private.lock_annual_leave_budget(true);\n\n' end||anchor);
  end loop;
end;
$$;

create or replace function private.enforce_banked_annual_leave_request()
returns trigger language plpgsql volatile security definer set search_path = '' as $$
declare projection jsonb; required numeric; available numeric; own_hours numeric := 0;
  bank_date date; classification text; budget_classification text; changed boolean := true; timed_hours numeric; days integer;
begin
  if tg_op='UPDATE' then
    changed := row(new.employee_person_id,new.leave_type,new.request_type_label,new.start_date,new.end_date,
      new.start_time,new.end_time,new.business_days,new.hours,new.employment_type_snapshot,new.pay_treatment)
      is distinct from row(old.employee_person_id,old.leave_type,old.request_type_label,old.start_date,old.end_date,
        old.start_time,old.end_time,old.business_days,old.hours,old.employment_type_snapshot,old.pay_treatment);
    if new.status in ('cancelled','rejected') and not changed then return new; end if;
    if not changed and (new.status is not distinct from old.status
      or (old.status='approved' and new.status<>'approved')) then return new; end if;
  end if;
  if new.request_type_label <> 'Annual leave' and new.leave_type <> 'annual' then return new; end if;
  perform private.lock_annual_leave_budget();
  if current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'Annual leave changes require a fresh READ COMMITTED transaction.' using errcode='55000';
  end if;
  if new.request_type_label is distinct from 'Annual leave' or new.leave_type is distinct from 'annual'
    or new.pay_treatment is distinct from 'paid_entitlement' then
    raise exception 'Annual leave classification is inconsistent.' using errcode='22023';
  end if;
  perform private.assert_leave_date_range(new.start_date,new.end_date);
  select employment_type into classification from private.employee_directory_details where person_id=new.employee_person_id;
  if tg_op='INSERT' and new.employment_type_snapshot is null then new.employment_type_snapshot:=classification; end if;
  budget_classification:=coalesce(new.employment_type_snapshot,classification);
  if budget_classification not in ('full_time','part_time')
    or budget_classification is null
    or (tg_op='INSERT' and new.employment_type_snapshot is distinct from classification)
    or (tg_op='UPDATE' and (new.employment_type_snapshot is distinct from old.employment_type_snapshot
      or new.employee_person_id is distinct from old.employee_person_id)
      and budget_classification is distinct from classification) then
    raise exception 'Annual leave employment snapshot is inconsistent.' using errcode='22023';
  end if;
  select count(*)::integer into days from generate_series(new.start_date,new.end_date,interval '1 day') day
    where extract(isodow from day) between 1 and 5;
  if days<1 or new.business_days is distinct from days then
    raise exception 'Annual leave working days are inconsistent.' using errcode='22023';
  end if;
  if new.start_time is not null or new.end_time is not null then
    select round(sum(case when day::date=new.start_date and day::date=new.end_date then extract(epoch from(new.end_time-new.start_time))/3600
      when day::date=new.start_date then extract(epoch from(time '18:00'-new.start_time))/3600
      when day::date=new.end_date then extract(epoch from(new.end_time-time '06:00'))/3600 else 12 end),2)
    into timed_hours from generate_series(new.start_date,new.end_date,interval '1 day') day
      where extract(isodow from day) between 1 and 5;
    if new.start_time is null or new.end_time is null or new.hours is distinct from timed_hours then
      raise exception 'Annual leave timed hours are inconsistent.' using errcode='22023';
    end if;
  end if;
  projection := private.project_annual_leave_balance(new.employee_person_id,new.start_date);
  required := coalesce(new.hours,new.business_days*case when budget_classification='full_time' then 7.6 else 7.5 end);
  if tg_op='UPDATE' and old.status='approved' and old.request_type_label='Annual leave'
    and old.employee_person_id=new.employee_person_id then
    select as_of into bank_date from private.employee_annual_leave_balances where person_id=new.employee_person_id;
    own_hours:=private.payroll_request_hours_after(old.id,bank_date);
    select own_hours+coalesce((select e.pending_hours from private.payroll_carryforward_events e
      where e.request_id=old.id and e.leave_kind='annual' and e.through_date<=bank_date order by e.id desc limit 1),0) into own_hours;
  end if;
  available:=(projection->>'availableHours')::numeric+own_hours;
  if projection->>'status'='unavailable' or required is null or required<=0 or available is null
    or required::text in ('NaN','Infinity','-Infinity') then
    raise exception 'Your annual leave projection is unavailable. Please contact payroll before requesting annual leave.' using errcode='22023';
  end if;
  if required>available then
    if projection->>'status'='banked_only' then
      raise exception 'Future accrual could not be confirmed and your banked balance is insufficient. Please contact payroll.' using errcode='22023';
    end if;
    raise exception 'Not enough balance. Your projected annual leave balance at the start of this leave is insufficient. Request fewer paid hours or submit a separate unpaid leave request.' using errcode='22023';
  end if;
  return new;
end;
$$;
revoke all on function private.enforce_banked_annual_leave_request() from public,anon,authenticated,service_role;

drop trigger z_leave_requests_banked_annual_limit on public.leave_requests;
create trigger z_leave_requests_banked_annual_limit before insert or update on public.leave_requests
for each row execute function private.enforce_banked_annual_leave_request();

create or replace function private.fill_leave_balance_required_hours()
returns trigger language plpgsql volatile security definer set search_path='' as $$
declare required numeric;
begin
  required:=private.leave_request_required_hours(new.request_id);
  if required is null or required<=0 or (new.required_hours is not null and new.required_hours is distinct from required) then
    raise exception 'Paid hours are calculated automatically for this request.' using errcode='22023';
  end if;
  new.required_hours:=required;
  return new;
end;
$$;
revoke all on function private.fill_leave_balance_required_hours() from public,anon,authenticated,service_role;
drop trigger leave_balance_approvals_fill_required_hours on private.leave_balance_approvals;
create trigger leave_balance_approvals_fill_required_hours before insert or update on private.leave_balance_approvals
for each row execute function private.fill_leave_balance_required_hours();

create function private.refresh_annual_leave_required_hours()
returns trigger language plpgsql volatile security definer set search_path='' as $$
begin
  if row(new.employee_person_id,new.hours,new.business_days,new.employment_type_snapshot)
    is distinct from row(old.employee_person_id,old.hours,old.business_days,old.employment_type_snapshot) then
    update private.leave_balance_approvals set required_hours=private.leave_request_required_hours(new.id)
      where request_id=new.id;
  end if;
  return new;
end;
$$;
revoke all on function private.refresh_annual_leave_required_hours() from public,anon,authenticated,service_role;
create trigger z_leave_requests_refresh_required_hours after update on public.leave_requests
for each row execute function private.refresh_annual_leave_required_hours();

create function private.guard_legacy_annual_leave_classification()
returns trigger language plpgsql volatile security definer set search_path='' as $$
begin
  if (new.employment_type='full_time') is distinct from (old.employment_type='full_time')
    and exists(select 1 from public.leave_requests r where r.employee_person_id=old.person_id
      and r.request_type_label='Annual leave' and r.status not in ('cancelled','rejected')
      and r.hours is null and r.employment_type_snapshot is null
      and not (r.status='approved' and exists(select 1 from private.payroll_carryforward_events e
        where e.request_id=r.id and e.person_id=r.employee_person_id and e.leave_kind='annual'))) then
    raise exception 'Legacy annual leave hours require review before changing employment classification.' using errcode='55000';
  end if;
  return new;
end;
$$;
revoke all on function private.guard_legacy_annual_leave_classification() from public,anon,authenticated,service_role;
create trigger aa_guard_legacy_annual_leave_classification before update of employment_type on private.employee_directory_details
for each row execute function private.guard_legacy_annual_leave_classification();

create temporary table annual_gate_function_after on commit drop as
select a.signature,pg_get_functiondef(p.oid) definition,
  p.oid::regprocedure::text||':'||p.proowner::text||':'||coalesce(p.proacl::text,'default') acl_definition,
  (to_jsonb(p)-array['oid','prosrc','prosqlbody','proargdefaults'])
    ||jsonb_build_object('parameter_defaults',pg_get_expr(p.proargdefaults,0)) metadata
from annual_gate_functions a join pg_proc p on p.oid=to_regprocedure(a.signature);
create temporary table annual_gate_trigger_after on commit drop as
select t.tgrelid::regclass::text||':'||t.tgenabled::text||':'||pg_get_triggerdef(t.oid) definition
from pg_trigger t join annual_gate_triggers a on a.relation=t.tgrelid and a.name=t.tgname;
do $$ begin perform pg_temp.annual_gate_assert_triggers(); end $$;
create temporary table annual_gate_catalog_after on commit drop as select * from pg_temp.annual_gate_catalog();
create temporary table annual_gate_catalog_normalized on commit drop as
select definition from annual_gate_catalog_after
except all (select definition from annual_gate_function_after union all select acl_definition from annual_gate_function_after
  union all select definition from annual_gate_trigger_after);
insert into annual_gate_catalog_normalized
select definition from annual_gate_function_before union all select acl_definition from annual_gate_function_before
union all select definition from annual_gate_trigger_before;
set constraints all immediate;
do $$ begin
  if (select count(*) from annual_gate_function_after)<>8 or exists(
    select 1 from annual_gate_function_before b join annual_gate_function_after a using(signature)
      where a.metadata is distinct from b.metadata) then
    raise exception 'Annual leave gate changed predecessor function security or signature metadata.' using errcode='55000';
  end if;
  if exists(select 1 from annual_gate_functions a join pg_proc p on p.oid=to_regprocedure(a.signature)
    where a.is_new and (not p.prosecdef or p.provolatile<>'v'
      or p.proowner<>(select proowner from pg_proc where oid='private.enforce_banked_annual_leave_request()'::regprocedure)
      or (select count(*) from aclexplode(p.proacl))<>1
      or exists(select 1 from aclexplode(p.proacl) x where x.grantee<>p.proowner or x.grantor<>p.proowner
        or x.privilege_type<>'EXECUTE' or x.is_grantable))) then
    raise exception 'Annual leave gate private function privileges differ.' using errcode='55000';
  end if;
  if (select count(*) from annual_gate_trigger_after)<>11 or exists(
    select 1 from annual_gate_triggers a left join pg_trigger t on t.tgrelid=a.relation and t.tgname=a.name
      where t.oid is null or t.tgenabled<>'O' or t.tgtype<>a.trigger_type or t.tgfoid<>to_regprocedure(a.signature)) then
    raise exception 'Annual leave gate trigger contract differs.' using errcode='55000';
  end if;
  if exists((select definition collate "C" from annual_gate_catalog_normalized
    except all select definition collate "C" from annual_gate_catalog_before)
    union all (select definition collate "C" from annual_gate_catalog_before
    except all select definition collate "C" from annual_gate_catalog_normalized)) then
    raise exception 'Annual leave gate contains metadata outside the declared delta.' using errcode='55000';
  end if;
  if pg_temp.annual_gate_data_hash() is distinct from (select sha256 from annual_gate_data_before) then
    raise exception 'Annual leave gate must not change requests balances classifications or allocations.' using errcode='55000';
  end if;
end $$;
update private.confirmed_test_purge_schema set schema_hash=private.confirmed_test_purge_schema_hash() where singleton;
set constraints all immediate;
do $$ begin
  perform pg_temp.annual_gate_assert_triggers();
  if exists((select definition collate "C" from pg_temp.annual_gate_catalog()
    except all select definition collate "C" from annual_gate_catalog_after)
    union all (select definition collate "C" from annual_gate_catalog_after
    except all select definition collate "C" from pg_temp.annual_gate_catalog()))
    or private.confirmed_test_purge_schema_hash() is distinct from
      (select schema_hash from private.confirmed_test_purge_schema where singleton)
    or pg_temp.annual_gate_data_hash() is distinct from (select sha256 from annual_gate_data_before) then
    raise exception 'Annual leave gate final protected catalog or data changed.' using errcode='55000';
  end if;
end $$;
drop function pg_temp.annual_gate_catalog();
drop function pg_temp.annual_gate_data_hash();
drop function pg_temp.annual_gate_assert_triggers();

commit;
