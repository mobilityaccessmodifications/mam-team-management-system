-- ONLY a new disposable PostgreSQL database; never run against a portal database.
\set ON_ERROR_STOP on
do $$ begin
  if exists(select 1 from pg_namespace where nspname in ('private','auth')) then
    raise exception 'Use a NEW disposable database, not an application database';
  end if;
  if not exists(select 1 from pg_roles where rolname='anon') then create role anon; end if;
  if not exists(select 1 from pg_roles where rolname='authenticated') then create role authenticated; end if;
  if not exists(select 1 from pg_roles where rolname='service_role') then create role service_role; end if;
end $$;

create schema private;
create schema auth;
grant usage on schema public, private, auth to authenticated;

create function auth.uid()
returns uuid language sql stable
as $$ select nullif(current_setting('test.actor', true), '')::uuid $$;

create function private.has_current_portal_access()
returns boolean language sql stable security definer set search_path=''
as $$ select (select auth.uid()) is not null $$;

create function private.can_review_leave_request(p_leave_request_id uuid)
returns boolean language sql stable security definer set search_path=''
as $$ select p_leave_request_id='20000000-0000-4000-8000-000000000002'::uuid $$;

grant execute on function auth.uid() to authenticated;
grant execute on function private.has_current_portal_access() to authenticated;
grant execute on function private.can_review_leave_request(uuid) to authenticated;

create table public.leave_requests (
  id uuid primary key,
  user_id uuid not null
);
alter table public.leave_requests enable row level security;
grant select on public.leave_requests to authenticated;

create policy leave_requests_select_own
  on public.leave_requests for select to authenticated
  using ((select private.has_current_portal_access()) and (select auth.uid())=user_id);
create policy leave_requests_select_reviewer
  on public.leave_requests for select to authenticated
  using ((select private.has_current_portal_access()) and private.can_review_leave_request(id));

create function public.redeem_portal_test_session_ticket(text)
returns boolean language sql security definer set search_path=''
as $$ select true $$;
revoke all on function public.redeem_portal_test_session_ticket(text)
  from public, anon, authenticated;
grant execute on function public.redeem_portal_test_session_ticket(text)
  to anon, authenticated, service_role;

insert into public.leave_requests(id,user_id) values
  ('20000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001'),
  ('20000000-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000000002'),
  ('20000000-0000-4000-8000-000000000003','10000000-0000-4000-8000-000000000003');
