-- Disposable synthetic fixtures only. Uses the real subscription migrations.
\set ON_ERROR_STOP on
do $$begin assert current_database() in ('subscription_company_test','subscription_company_test_clean'), 'Disposable database only'; end$$;
do $$begin
  if not exists(select 1 from pg_roles where rolname='anon') then create role anon; end if;
  if not exists(select 1 from pg_roles where rolname='authenticated') then create role authenticated; end if;
  if not exists(select 1 from pg_roles where rolname='service_role') then create role service_role; end if;
end$$;
create schema auth;
create schema private;
grant usage on schema auth, public to authenticated;
create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
create function auth.jwt() returns jsonb language sql stable as $$select coalesce(nullif(current_setting('request.jwt.claims',true),'')::jsonb,'{}'::jsonb)$$;
create table auth.users(id uuid primary key);
create table public.profiles(id uuid primary key, app_role text, account_status text default 'active', login_name text);
create table public.internal_org_people(id uuid primary key, auth_user_id uuid, full_name text, position_title text default 'Synthetic', company_key text default 'mam', node_kind text default 'person', is_active boolean default true);
create table private.employee_directory_details(person_id uuid,team_name text);
create function private.has_current_portal_access() returns boolean language sql stable security definer as $$select exists(select 1 from public.profiles where id=auth.uid() and account_status='active' and login_name is not null)$$;
create function private.is_system_portal_account_admin() returns boolean language sql stable security definer as $$select private.has_current_portal_access() and exists(select 1 from public.profiles where id=auth.uid() and app_role='system_admin')$$;
create function private.is_active_linked_internal_employee(uuid) returns boolean language sql stable security definer as $$select exists(select 1 from public.internal_org_people where auth_user_id=$1 and is_active and node_kind='person')$$;
create function private.current_active_portal_employee_id() returns uuid language sql stable security definer as $$select id from public.internal_org_people where auth_user_id=auth.uid() and is_active limit 1$$;
create function private.can_view_people_operational_tabs() returns boolean language sql stable security definer as $$select private.has_current_portal_access() and exists(select 1 from public.profiles where id=auth.uid() and app_role in ('system_admin','manager','hr'))$$;
create function private.mam_local_calendar_date() returns date language sql stable as $$select current_date$$;
create function private.next_paid_subscription_quarter_review_on(date default current_date) returns date language sql stable as $$select ($1+interval '3 months')::date$$;
\ir ../supabase/migrations/20260828150000_subscription_management.sql
\ir ../supabase/migrations/20260915130000_subscription_billing_details.sql
\ir ../supabase/migrations/20260915160000_subscription_credit_card_holder.sql
\ir ../supabase/migrations/20260922160000_subscription_company_and_managers.sql

insert into auth.users select ('10000000-0000-4000-8000-00000000000'||n)::uuid from generate_series(1,5) n;
insert into public.profiles(id,app_role,login_name) select id,case right(id::text,1) when '1' then 'system_admin' when '4' then 'manager' else 'employee' end,'synthetic-'||id from auth.users;
insert into public.internal_org_people(id,auth_user_id,full_name) select id,id,'Synthetic person '||id from auth.users;
insert into private.subscription_management_grants(person_id) select id from auth.users where right(id::text,1) in ('2','3');

select set_config('request.jwt.claim.sub','10000000-0000-4000-8000-000000000002',false);
set role authenticated;
do $$declare result jsonb; target uuid; version bigint; company text; begin
  assert public.can_manage_subscriptions(), 'First delegate can manage';
  assert public.can_view_subscription_register(), 'Employee delegate sees complete register';
  assert (select count(*)=5 from public.list_subscription_people());
  foreach company in array array['mam','equipsy','both'] loop
    result := public.create_subscription_v4('Synthetic '||company,null,'paid','monthly',0,null,2,false,null,current_date,
      '10000000-0000-4000-8000-000000000005',company,array[]::uuid[]);
    assert result->>'company_scope'=company;
    assert result->>'pricing_model'='paid', 'Zero-cost paid remains paid';
  end loop;
  assert jsonb_array_length(public.list_subscriptions_v2())=3;
  target := (result->>'subscription_id')::uuid;
  version := (result->>'version')::bigint;
  perform set_config('test.subscription_id',target::text,false);
  result := public.update_subscription_v4(target,version,'Synthetic updated',null,'active','paid','monthly',100,null,2,false,null,current_date,
    '10000000-0000-4000-8000-000000000005','mam',array[]::uuid[]);
  assert result->>'company_scope'='mam';
  begin
    perform public.update_subscription_v4(target,version,'Stale',null,'active','free',null,null,null,null,null,null,null,
      '10000000-0000-4000-8000-000000000005','both',array[]::uuid[]);
    raise exception 'Stale update allowed';
  exception when sqlstate '40001' then null; end;
  begin
    perform public.create_subscription_v4('Invalid',null,'free',null,null,null,null,null,null,null,
      '10000000-0000-4000-8000-000000000005','invalid',array[]::uuid[]);
    raise exception 'Invalid company allowed';
  exception when sqlstate '22023' then null; end;
  assert jsonb_array_length(public.list_subscriptions_v2())=3, 'Invalid creation rolled back';
end$$;
reset role;
select set_config('request.jwt.claim.sub','10000000-0000-4000-8000-000000000003',false);
set role authenticated;
do $$declare result jsonb; target uuid:=current_setting('test.subscription_id')::uuid; begin
  assert public.can_manage_subscriptions(), 'Second delegate shares management';
  assert jsonb_array_length(public.list_subscriptions_v2())=3, 'Complete shared list, not owner-filtered';
  select item into result from jsonb_array_elements(public.list_subscriptions_v2()) as projection(item) where item->>'subscription_id'=target::text;
  result := public.mark_subscription_reviewed_v2(target,(result->>'version')::bigint);
  assert result->>'company_scope'='mam', 'Review preserves company';
  begin
    perform private.set_subscription_company(target,'both');
    raise exception 'Private helper exposed';
  exception when insufficient_privilege then null; end;
end$$;
reset role;
select set_config('request.jwt.claim.sub','10000000-0000-4000-8000-000000000004',false);
set role authenticated;
do $$begin
  assert public.can_view_subscription_register();
  assert not public.can_manage_subscriptions(), 'Other managers remain read-only';
  begin
    perform public.create_subscription_v4('Denied',null,'free',null,null,null,null,null,null,null,
      '10000000-0000-4000-8000-000000000005','both',array[]::uuid[]);
    raise exception 'Read-only manager wrote';
  exception when insufficient_privilege then null; end;
end$$;
reset role;
select set_config('request.jwt.claim.sub','10000000-0000-4000-8000-000000000005',false);
set role authenticated;
do $$begin
  assert not public.can_view_subscription_register(), 'Ordinary employee denied full register';
  assert not public.can_manage_subscriptions();
  begin perform public.list_subscriptions_v2(); raise exception 'Employee read full register';
  exception when insufficient_privilege then null; end;
end$$;
reset role;
select set_config('request.jwt.claim.sub','10000000-0000-4000-8000-000000000002',false);
update public.profiles set account_status='disabled' where id=auth.uid();
do $$begin assert not public.can_manage_subscriptions(), 'Disabled account loses grant'; end$$;
update public.profiles set account_status='active' where id=auth.uid();
update public.internal_org_people set is_active=false where auth_user_id=auth.uid();
do $$begin assert not public.can_manage_subscriptions(), 'Archived employee loses grant'; end$$;
update public.internal_org_people set is_active=true where auth_user_id=auth.uid();
select set_config('request.jwt.claims','{"is_anonymous":true}',false);
do $$begin assert not public.can_manage_subscriptions(), 'Anonymous claim denied'; end$$;
select set_config('request.jwt.claims','{}',false);
delete from private.subscription_management_grants where person_id=auth.uid();
do $$begin
  assert not public.can_manage_subscriptions(), 'Revocation effective immediately';
  assert (select count(*) >= 4 from private.subscription_audit_events where 'company_scope'=any(changed_fields)), 'Company changes audited';
  assert not has_table_privilege('authenticated','private.subscription_management_grants','INSERT'), 'Cannot self-grant';
end$$;
