-- Disposable permission-boundary test. Dependencies model active accounts,
-- delegated submissions and current (revocable) request assignments.
\set ON_ERROR_STOP on
do $$begin assert current_database()='reviewer_balance_test', 'Synthetic database only'; end$$;
create schema private;
do $$begin
 if not exists(select 1 from pg_roles where rolname='anon') then create role anon; end if;
 if not exists(select 1 from pg_roles where rolname='authenticated') then create role authenticated; end if;
end$$;
create table public.profiles(id uuid primary key,app_role text,active boolean default true);
create table public.internal_org_people(id uuid primary key,auth_user_id uuid,is_active boolean default true);
create table public.leave_requests(id uuid primary key,employee_person_id uuid,status text);
create table private.test_assignments(request_id uuid,actor_id uuid,revoked boolean default false);
create table private.test_delegation(person_id uuid,actor_id uuid);
create function private.is_active_portal_account(actor uuid) returns boolean language sql as $$select coalesce((select active from public.profiles where id=actor),false)$$;
create function private.can_submit_team_leave(person uuid,actor uuid) returns boolean language sql as $$select exists(select 1 from private.test_delegation where person_id=person and actor_id=actor)$$;
create function private.is_current_leave_request_reviewer(request uuid,actor uuid) returns boolean language sql as $$select exists(select 1 from private.test_assignments where request_id=request and actor_id=actor and not revoked)$$;
\ir ../supabase/migrations/20260911020000_reviewer_leave_balance_access.sql
insert into public.profiles(id,app_role) values
('10000000-0000-4000-8000-000000000001','system_admin'),
('10000000-0000-4000-8000-000000000002','employee'),
('10000000-0000-4000-8000-000000000003','manager'),
('10000000-0000-4000-8000-000000000004','employee'),
('10000000-0000-4000-8000-000000000005','system_admin');
insert into public.internal_org_people select id,id,true from public.profiles;
insert into public.leave_requests values ('20000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000004','submitted');
insert into private.test_assignments values
('20000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001',false),
('20000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000002',false);
insert into private.test_delegation values ('10000000-0000-4000-8000-000000000004','10000000-0000-4000-8000-000000000003');
do $$declare applicant uuid:='10000000-0000-4000-8000-000000000004'; begin
 assert private.can_view_team_leave_balance(applicant,'10000000-0000-4000-8000-000000000001'), 'Assigned administrator reviewer can view balances in preview scope';
 assert private.can_view_team_leave_balance(applicant,'10000000-0000-4000-8000-000000000002'), 'Assigned reviewer does not need manager app_role';
 assert private.can_view_team_leave_balance(applicant,'10000000-0000-4000-8000-000000000003'), 'Existing delegated manager access remains';
 assert not private.can_view_team_leave_balance(applicant,applicant), 'Ordinary applicant does not gain sick visibility';
 assert not private.can_view_team_leave_balance(applicant,'10000000-0000-4000-8000-000000000005'), 'Unassigned admin preview does not inherit blanket balance access';
 assert not private.can_view_team_leave_balance('10000000-0000-4000-8000-000000000005','10000000-0000-4000-8000-000000000001'), 'Assignment cannot expose unrelated employee';
 assert not private.can_view_team_leave_balance(applicant,null), 'Anonymous denied';
 update public.profiles set active=false where id='10000000-0000-4000-8000-000000000001';
 assert not private.can_view_team_leave_balance(applicant,'10000000-0000-4000-8000-000000000001'), 'Inactive reviewer denied';
 update private.test_assignments set revoked=true where actor_id='10000000-0000-4000-8000-000000000002';
 assert not private.can_view_team_leave_balance(applicant,'10000000-0000-4000-8000-000000000002'), 'Revoked reviewer denied';
 update public.profiles set active=true;
 update public.leave_requests set status='approved';
 assert not private.can_view_team_leave_balance(applicant,'10000000-0000-4000-8000-000000000001'), 'Historic assignment alone does not grant ongoing balances';
 assert not has_function_privilege('authenticated','private.can_view_team_leave_balance(uuid,uuid)','EXECUTE'), 'Private helper is not callable by staff';
end$$;
