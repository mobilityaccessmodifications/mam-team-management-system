-- Disposable synthetic database; exercise the deployed resolver, not staff data.
\set ON_ERROR_STOP on
do $$begin assert current_database()='leave_email_route_test','Synthetic database only';end$$;
create schema private;
do $$begin
 if not exists(select 1 from pg_roles where rolname='anon') then create role anon;end if;
 if not exists(select 1 from pg_roles where rolname='authenticated') then create role authenticated;end if;
 if not exists(select 1 from pg_roles where rolname='service_role') then create role service_role;end if;
end$$;
create table public.profiles(id uuid primary key,full_name text,app_role text,active boolean default true);
create table public.internal_org_people(id uuid primary key,auth_user_id uuid,full_name text,parent_id uuid,is_active boolean default true,node_kind text default 'person');
create table public.leave_requests(id uuid primary key,user_id uuid,employee_person_id uuid);
create table private.employee_directory_details(person_id uuid primary key,work_email text);
create table private.manager_leave_reviewers(reviewer_user_id uuid primary key,priority int);
create table private.leave_request_reviewer_assignments(leave_request_id uuid,reviewer_user_id uuid,is_primary boolean,authorised boolean default true);
-- Dependency fixtures represent existing account and assignment checks. The
-- changed public resolver is loaded verbatim from the production migration.
create function private.is_active_portal_account(uuid) returns boolean language sql as $$select coalesce((select active from public.profiles where id=$1),false)$$;
create function private.is_manager_leave_person(uuid) returns boolean language sql as $$select exists(select 1 from public.internal_org_people p join public.profiles a on a.id=p.auth_user_id where p.id=$1 and a.app_role='manager')$$;
create function private.is_current_leave_request_reviewer(uuid,uuid) returns boolean language sql as $$select exists(select 1 from private.leave_request_reviewer_assignments where leave_request_id=$1 and reviewer_user_id=$2 and authorised)$$;
create function private.resolve_internal_org_employee_manager(uuid) returns table(manager_id uuid) language sql as $$select parent_id from public.internal_org_people where id=$1$$;
\ir ../supabase/migrations/20260922170000_restore_authorised_leave_email_route.sql
insert into public.profiles(id,full_name,app_role) values
('10000000-0000-4000-8000-000000000001','Applicant','employee'),
('10000000-0000-4000-8000-000000000002','Intermediate employee','employee'),
('10000000-0000-4000-8000-000000000003','Team manager','manager'),
('10000000-0000-4000-8000-000000000004','Global one','system_admin'),
('10000000-0000-4000-8000-000000000005','Global two','system_admin'),
('10000000-0000-4000-8000-000000000006','HR','system_admin');
insert into public.internal_org_people(id,auth_user_id,full_name) select id,id,full_name from public.profiles;
update public.internal_org_people set parent_id='10000000-0000-4000-8000-000000000002' where full_name='Applicant';
update public.internal_org_people set parent_id='10000000-0000-4000-8000-000000000003' where full_name='Intermediate employee';
insert into private.employee_directory_details select id,case full_name
when 'Applicant' then 'applicant@example.test' when 'Intermediate employee' then 'intermediate@example.test'
when 'Team manager' then 'manager@example.test' when 'Global one' then 'one@example.test'
when 'Global two' then 'two@example.test' else 'hr@example.test' end from public.profiles;
insert into private.manager_leave_reviewers values
('10000000-0000-4000-8000-000000000004',1),('10000000-0000-4000-8000-000000000005',2),('10000000-0000-4000-8000-000000000006',3);
insert into public.leave_requests values('20000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001');
insert into private.leave_request_reviewer_assignments
select '20000000-0000-4000-8000-000000000001',id,app_role='manager',true from public.profiles where app_role in ('manager','system_admin');
do $$begin
 assert (select manager_email='manager@example.test' from public.resolve_leave_notification_manager('20000000-0000-4000-8000-000000000001')),'Skip intermediate ordinary employee';
 assert not has_function_privilege('anon','public.resolve_leave_notification_manager(uuid)','execute');
 assert not has_function_privilege('authenticated','public.resolve_leave_notification_manager(uuid)','execute');
 assert has_function_privilege('service_role','public.resolve_leave_notification_manager(uuid)','execute');
 assert not exists(select 1 from public.resolve_leave_notification_manager('20000000-0000-4000-8000-000000000099')),'Unknown request returns nothing';
end$$;
-- A stale assignment to the non-manager cannot redirect mail even if the
-- assignment predicate were to accept it.
insert into private.leave_request_reviewer_assignments values('20000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000002',true,true);
do $$begin assert (select manager_email='manager@example.test' from public.resolve_leave_notification_manager('20000000-0000-4000-8000-000000000001'));end$$;
-- Reviewer revocation and account disablement must both be respected.
update private.leave_request_reviewer_assignments set authorised=false where reviewer_user_id='10000000-0000-4000-8000-000000000003';
do $$begin assert (select manager_email='one@example.test' from public.resolve_leave_notification_manager('20000000-0000-4000-8000-000000000001')),'Revoked manager excluded';end$$;
update private.leave_request_reviewer_assignments set authorised=true;
update public.profiles set active=false where full_name='Team manager';
do $$begin assert (select manager_email='one@example.test' from public.resolve_leave_notification_manager('20000000-0000-4000-8000-000000000001')),'Disabled manager excluded';end$$;
update public.profiles set active=true;
-- Manager-owned leave goes to all three explicitly configured reviewers.
update public.profiles set app_role='manager' where full_name='Applicant';
do $$begin assert (select manager_email='one@example.test,two@example.test,hr@example.test' from public.resolve_leave_notification_manager('20000000-0000-4000-8000-000000000001')),'All configured reviewers';end$$;
update private.employee_directory_details set work_email=null where person_id='10000000-0000-4000-8000-000000000005';
do $$begin assert (select manager_email is null from public.resolve_leave_notification_manager('20000000-0000-4000-8000-000000000001')),'Missing required email fails closed';end$$;
update private.leave_request_reviewer_assignments set authorised=false where reviewer_user_id='10000000-0000-4000-8000-000000000005';
do $$begin assert (select manager_email='one@example.test,hr@example.test' from public.resolve_leave_notification_manager('20000000-0000-4000-8000-000000000001')),'Revoked group member excluded';end$$;
-- Even an erroneous configured self-assignment must never email the applicant.
insert into private.manager_leave_reviewers values('10000000-0000-4000-8000-000000000001',4);
insert into private.leave_request_reviewer_assignments values('20000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001',true,true);
do $$begin assert (select manager_email='one@example.test,hr@example.test' from public.resolve_leave_notification_manager('20000000-0000-4000-8000-000000000001')),'Self-recipient excluded';end$$;
