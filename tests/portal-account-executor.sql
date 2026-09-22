\set ON_ERROR_STOP on
-- Run only in a new task-owned disposable database containing synthetic data.
\ir portal-account-status-claim-bootstrap.sql
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin; end if;
end; $$;
alter table auth.users add column email text;
\ir ../supabase/migrations/20260916120000_serialise_portal_account_status_changes.sql

insert into auth.users(id, email) select
  ('10000000-0000-4000-8000-' || lpad(i::text, 12, '0'))::uuid,
  'portal-10000000-0000-4000-8000-' || lpad(i::text, 12, '0') || '@accounts.mobilityaccess.com.au'
from generate_series(1, 6) i;
insert into public.profiles(id, login_name, account_status) select id,
  case when right(id::text, 1) = '6' then null else 'synthetic-' || right(id::text, 1) end,
  case when right(id::text, 1) = '2' then 'disabled' else 'active' end
from auth.users;
insert into public.internal_org_people(id, auth_user_id, node_kind)
select ('20000000-0000-4000-8000-' || lpad(i::text, 12, '0'))::uuid,
  ('10000000-0000-4000-8000-' || lpad(i::text, 12, '0'))::uuid, 'person'
from generate_series(1, 5) i;
insert into private.portal_account_admins(auth_user_id)
values ('10000000-0000-4000-8000-000000000001'), ('10000000-0000-4000-8000-000000000003');
select set_config('test.actor', '10000000-0000-4000-8000-000000000001', false);

-- Pending operations from the old application cannot be granted a fresh
-- executor: there might already be untracked Auth requests in flight.
create temporary table legacy_claim as select * from public.begin_portal_account_status_change(
  '20000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000003', false, 1);
\ir ../supabase/migrations/20260922210000_exclusive_portal_account_status_executor.sql

create function pg_temp.assert(p_value boolean, p_message text) returns void language plpgsql as $$
begin if p_value is distinct from true then raise exception '%', p_message; end if; end;
$$;
select pg_temp.assert(public.claim_portal_account_status_execution(
  '10000000-0000-4000-8000-000000000003', (select change_token from legacy_claim),
  '10000000-0000-4000-8000-000000000001', gen_random_uuid()) = 'unknown', 'legacy pending claim stays fenced');

select pg_temp.assert(not has_function_privilege('authenticated',
  'public.claim_portal_account_status_execution(uuid,uuid,uuid,uuid)', 'execute'), 'browser cannot grant an executor');
select pg_temp.assert(not has_function_privilege('authenticated',
  'public.record_portal_account_status_execution(uuid,uuid,uuid,boolean)', 'execute'), 'browser cannot forge a provider receipt');
select pg_temp.assert(not has_function_privilege('anon',
  'public.inspect_portal_account_status_request(uuid,uuid,boolean,bigint)', 'execute'), 'anonymous cannot inspect requests');
select pg_temp.assert(has_function_privilege('service_role',
  'public.claim_portal_account_status_execution(uuid,uuid,uuid,uuid)', 'execute'), 'server may claim executor');
select pg_temp.assert(not has_table_privilege('authenticated',
  'private.portal_account_creation_cleanup', 'select'), 'cleanup reservation is private');

create temporary table first_claim as select * from public.begin_portal_account_status_change(
  '20000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000002', true, 1);
create temporary table duplicate_claim as select * from public.begin_portal_account_status_change(
  '20000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000002', true, 1);
select pg_temp.assert((select change_token from first_claim) = (select change_token from duplicate_claim),
  'duplicate operation identity does not itself authorise Auth');
select pg_temp.assert(public.claim_portal_account_status_execution(
  '10000000-0000-4000-8000-000000000002', (select change_token from first_claim),
  '10000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000001') = 'execute', 'first request has executor');
select pg_temp.assert(public.claim_portal_account_status_execution(
  '10000000-0000-4000-8000-000000000002', (select change_token from duplicate_claim),
  '10000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000002') = 'executing', 'duplicate request has no executor');
select pg_temp.assert(public.claim_portal_account_status_execution(
  '10000000-0000-4000-8000-000000000002', (select change_token from first_claim),
  '10000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000001') = 'executing', 'same executor UUID cannot execute twice');

do $$ begin
  perform public.cancel_portal_account_status_change('10000000-0000-4000-8000-000000000002', (select change_token from first_claim));
  raise exception 'expected cancel rejection';
exception when sqlstate '55000' then null; end; $$;
do $$ begin
  perform public.finalise_portal_account_status_change('20000000-0000-4000-8000-000000000002',
    '10000000-0000-4000-8000-000000000002', (select change_token from first_claim));
  raise exception 'expected unconfirmed finalise rejection';
exception when sqlstate '55000' then null; end; $$;
select pg_temp.assert((select account_status = 'disabled' and account_version = 1 from public.profiles
  where id = '10000000-0000-4000-8000-000000000002'), 'failed finalise rolls back the profile update');
select pg_temp.assert(not public.record_portal_account_status_execution(
  '10000000-0000-4000-8000-000000000002', (select change_token from first_claim),
  '30000000-0000-4000-8000-000000000002', true), 'only actual executor may record success');
select pg_temp.assert(public.record_portal_account_status_execution(
  '10000000-0000-4000-8000-000000000002', (select change_token from first_claim),
  '30000000-0000-4000-8000-000000000001', true), 'provider success is durable');
select pg_temp.assert(public.record_portal_account_status_execution(
  '10000000-0000-4000-8000-000000000002', (select change_token from first_claim),
  '30000000-0000-4000-8000-000000000001', true), 'lost receipt response safely replays');
select pg_temp.assert(public.claim_portal_account_status_execution(
  '10000000-0000-4000-8000-000000000002', (select change_token from first_claim),
  '10000000-0000-4000-8000-000000000001', gen_random_uuid()) = 'succeeded', 'completion retry reads success without re-execution');
select * from public.finalise_portal_account_status_change('20000000-0000-4000-8000-000000000002',
  '10000000-0000-4000-8000-000000000002', (select change_token from first_claim));
select * from public.finalise_portal_account_status_change('20000000-0000-4000-8000-000000000002',
  '10000000-0000-4000-8000-000000000002', (select change_token from first_claim));
select pg_temp.assert((select account_status = 'active' and account_version = 2 from public.profiles
  where id = '10000000-0000-4000-8000-000000000002'), 'DB-only finalise retry increments version once');

create temporary table opposite_claim as select * from public.begin_portal_account_status_change(
  '20000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000002', false, 2);
select pg_temp.assert(public.claim_portal_account_status_execution(
  '10000000-0000-4000-8000-000000000002', (select change_token from opposite_claim),
  '10000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000002') = 'execute', 'new operation resets execution state');
select pg_temp.assert(not public.record_portal_account_status_execution(
  '10000000-0000-4000-8000-000000000002', (select change_token from first_claim),
  '30000000-0000-4000-8000-000000000001', true), 'stale executor cannot acknowledge newer operation');
select pg_temp.assert(public.record_portal_account_status_execution(
  '10000000-0000-4000-8000-000000000002', (select change_token from opposite_claim),
  '30000000-0000-4000-8000-000000000002', false), 'unknown outcome persists');
do $$ begin
  perform public.begin_portal_account_status_change('20000000-0000-4000-8000-000000000002',
    '10000000-0000-4000-8000-000000000002', true, 2);
  raise exception 'expected opposite operation rejection';
exception when sqlstate '40001' then null; end; $$;

create temporary table archive_claim as select * from public.begin_portal_account_status_change(
  '20000000-0000-4000-8000-000000000004', '10000000-0000-4000-8000-000000000004', false, 1);
select public.claim_portal_account_status_execution('10000000-0000-4000-8000-000000000004',
  (select change_token from archive_claim), '10000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000004');
-- Model the existing archive transaction committing before status finalise.
update public.profiles set account_status = 'disabled', account_version = 2 where id = '10000000-0000-4000-8000-000000000004';
update public.internal_org_people set is_active = false where id = '20000000-0000-4000-8000-000000000004';
select pg_temp.assert((select count(*) = 0 from public.inspect_portal_account_status_request(
  '20000000-0000-4000-8000-000000000004', '10000000-0000-4000-8000-000000000004', false, 2)), 'archive version+1 cannot borrow executing receipt');
select public.record_portal_account_status_execution('10000000-0000-4000-8000-000000000004',
  (select change_token from archive_claim), '30000000-0000-4000-8000-000000000004', true);
select pg_temp.assert((select count(*) = 1 from public.inspect_portal_account_status_request(
  '20000000-0000-4000-8000-000000000004', '10000000-0000-4000-8000-000000000004', false, 2)), 'archive version+1 recovers confirmed success');
select pg_temp.assert((select count(*) = 0 from public.inspect_portal_account_status_request(
  '20000000-0000-4000-8000-000000000004', '10000000-0000-4000-8000-000000000004', false, 3)), 'unrelated version does not recover');
select set_config('test.actor', '10000000-0000-4000-8000-000000000003', false);
select pg_temp.assert((select count(*) = 0 from public.inspect_portal_account_status_request(
  '20000000-0000-4000-8000-000000000004', '10000000-0000-4000-8000-000000000004', false, 2)), 'other admin cannot borrow archive receipt');
select set_config('test.actor', '10000000-0000-4000-8000-000000000001', false);
select * from public.finalise_portal_account_status_change('20000000-0000-4000-8000-000000000004',
  '10000000-0000-4000-8000-000000000004', (select change_token from archive_claim));
select pg_temp.assert((select account_version = 2 from public.profiles where id = '10000000-0000-4000-8000-000000000004'),
  'archive completion preserves committed version');

select pg_temp.assert(not public.reserve_portal_account_creation_cleanup('10000000-0000-4000-8000-000000000006', 'wrong@example.test'), 'cleanup checks exact Auth identity');
select pg_temp.assert(not public.reserve_portal_account_creation_cleanup('10000000-0000-4000-8000-000000000002',
  'portal-10000000-0000-4000-8000-000000000002@accounts.mobilityaccess.com.au'), 'linked account cannot be cleaned');
select pg_temp.assert(public.reserve_portal_account_creation_cleanup('10000000-0000-4000-8000-000000000006',
  'portal-10000000-0000-4000-8000-000000000006@accounts.mobilityaccess.com.au'), 'exact orphan is reserved');
do $$ begin
  insert into public.internal_org_people(id, auth_user_id, node_kind) values
    ('20000000-0000-4000-8000-000000000006', '10000000-0000-4000-8000-000000000006', 'person');
  raise exception 'expected cleanup link rejection';
exception when sqlstate '55000' then null; end; $$;
do $$ begin
  update public.profiles set login_name = 'late-link@example.test' where id = '10000000-0000-4000-8000-000000000006';
  raise exception 'expected cleanup profile rejection';
exception when sqlstate '55000' then null; end; $$;
select pg_temp.assert(not has_function_privilege('authenticated',
  'public.reserve_portal_account_creation_cleanup(uuid,text)', 'execute'), 'browser cannot reserve cleanup');

-- Target 5 remains untouched for the independent two-connection concurrency test.
\echo Account executor, recovery, cleanup, and permission assertions passed.
