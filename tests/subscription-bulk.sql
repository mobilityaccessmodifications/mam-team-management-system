-- Disposable synthetic fixtures only. Uses the real subscription migrations.
\set ON_ERROR_STOP on
do $$begin assert current_database() = 'subscription_bulk_test', 'Disposable database only'; end$$;
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

\ir ../supabase/migrations/20260922200000_subscription_bulk_edit.sql
-- Legacy paid rows legitimately lack newer billing details.
insert into private.subscription_register(id,subscription_code,service_name,pricing_model,billing_cycle,amount_cents,next_review_on,responsible_person_id,company_scope)
values('20000000-0000-4000-8000-000000000001','MAM-SUB-000001','Synthetic legacy','paid','monthly',1200,current_date,'10000000-0000-4000-8000-000000000005','mam');
insert into private.subscription_memberships(subscription_id,person_id) values('20000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000003');
select set_config('request.jwt.claim.sub','10000000-0000-4000-8000-000000000002',false);
set role authenticated;
do $$declare result jsonb; begin
  result := public.patch_subscription_v1('20000000-0000-4000-8000-000000000001',1,'{"company_scope":"both","subscription_status":"paused"}');
  assert result->>'version'='2';
  result := public.patch_subscription_v1('20000000-0000-4000-8000-000000000001',2,'{"company_scope":"both"}');
  assert result->>'version'='2', 'No-op keeps version';
  begin
    perform public.patch_subscription_v1('20000000-0000-4000-8000-000000000001',1,'{"company_scope":"mam"}');
    raise exception 'Stale update allowed';
  exception when sqlstate '40001' then null; end;
  begin
    perform public.patch_subscription_v1('20000000-0000-4000-8000-000000000001',2,'{"company_scope":"mam","amount_cents":1}');
    raise exception 'Unselected billing update allowed';
  exception when sqlstate '22023' then null; end;
  begin
    perform public.patch_subscription_v1('20000000-0000-4000-8000-000000000001',2,'{"company_scope":null}');
    raise exception 'Null patch allowed';
  exception when sqlstate '22023' then null; end;
  begin
    perform public.patch_subscription_v1('20000000-0000-4000-8000-000000000001',2,'[]');
    raise exception 'Array patch allowed';
  exception when sqlstate '22023' then null; end;
  begin
    perform public.patch_subscription_v1('20000000-0000-4000-8000-000000000001',2,'{}');
    raise exception 'Empty patch allowed';
  exception when sqlstate '22023' then null; end;
  begin
    perform public.patch_subscription_v1('20000000-0000-4000-8000-000000000001',2,'{"subscription_status":"unknown"}');
    raise exception 'Invalid status allowed';
  exception when sqlstate '22023' then null; end;
  begin
    perform public.patch_subscription_v1('20000000-0000-4000-8000-000000000001',2,'{"responsible_person_id":"not-a-uuid"}');
    raise exception 'Invalid employee allowed';
  exception when sqlstate '22023' then null; end;
end$$;
reset role;
do $$begin
  assert (select company_scope='both' and subscription_status='paused' and amount_cents=1200 and seat_count is null and credit_card_holder is null and billing_anchor_date is null and version=2
    from private.subscription_register where id='20000000-0000-4000-8000-000000000001'), 'Patch preserves unrelated legacy fields';
  assert (select count(*)=1 from private.subscription_memberships), 'Membership untouched';
  assert (select count(*)=1 from private.subscription_audit_events), 'One audit and no audit for no-op or rejected calls';
  assert (select changed_fields=array['company_scope','subscription_status'] from private.subscription_audit_events), 'Audit exact fields';
end$$;
-- An archived existing owner must not prevent changing an unrelated field.
update public.internal_org_people set is_active=false where id='10000000-0000-4000-8000-000000000005';
set role authenticated;
do $$begin
  perform public.patch_subscription_v1('20000000-0000-4000-8000-000000000001',2,'{"subscription_status":"active"}');
  begin
    perform public.patch_subscription_v1('20000000-0000-4000-8000-000000000001',3,'{"responsible_person_id":"10000000-0000-4000-8000-000000000005"}');
    raise exception 'Inactive new responsible allowed';
  exception when foreign_key_violation then null; end;
  perform public.patch_subscription_v1('20000000-0000-4000-8000-000000000001',3,'{"responsible_person_id":"10000000-0000-4000-8000-000000000003"}');
end$$;
reset role;
select set_config('request.jwt.claim.sub','10000000-0000-4000-8000-000000000004',false);
set role authenticated;
do $$begin
  assert public.can_view_subscription_register() and not public.can_manage_subscriptions();
  begin perform public.patch_subscription_v1('20000000-0000-4000-8000-000000000001',4,'{"company_scope":"mam"}'); raise exception 'Read-only manager wrote';
  exception when insufficient_privilege then null; end;
end$$;
reset role;
select set_config('request.jwt.claim.sub','10000000-0000-4000-8000-000000000002',false);
update public.profiles set account_status='disabled' where id=auth.uid();
set role authenticated;
do $$begin
  begin perform public.patch_subscription_v1('20000000-0000-4000-8000-000000000001',4,'{"company_scope":"mam"}'); raise exception 'Disabled delegate wrote';
  exception when insufficient_privilege then null; end;
end$$;
reset role;
update public.profiles set account_status='active' where id=auth.uid();
select set_config('request.jwt.claims','{"is_anonymous":true}',false);
set role authenticated;
do $$begin
  begin perform public.patch_subscription_v1('20000000-0000-4000-8000-000000000001',4,'{"company_scope":"mam"}'); raise exception 'Anonymous delegate wrote';
  exception when insufficient_privilege then null; end;
end$$;
reset role;
select set_config('request.jwt.claims','{}',false);
select set_config('request.jwt.claim.sub','',false);
set role authenticated;
do $$begin
  begin perform public.patch_subscription_v1('20000000-0000-4000-8000-000000000001',4,'{"company_scope":"mam"}'); raise exception 'Missing identity wrote';
  exception when insufficient_privilege then null; end;
end$$;
reset role;
do $$begin
  assert has_function_privilege('authenticated','public.patch_subscription_v1(uuid,bigint,jsonb)','EXECUTE');
  assert not has_function_privilege('anon','public.patch_subscription_v1(uuid,bigint,jsonb)','EXECUTE');
  assert not has_function_privilege('service_role','public.patch_subscription_v1(uuid,bigint,jsonb)','EXECUTE');
  assert not has_table_privilege('authenticated','private.subscription_register','UPDATE');
  assert (select version=4 from private.subscription_register where id='20000000-0000-4000-8000-000000000001');
  assert (select count(*)=3 from private.subscription_audit_events);
end$$;
