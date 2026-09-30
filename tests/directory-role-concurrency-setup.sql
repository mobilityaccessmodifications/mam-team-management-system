\set ON_ERROR_STOP on
\ir sql-test-auth.sql
insert into auth.users(id,email,email_confirmed_at) values
('93000000-0000-4000-8000-000000000001','role-admin-a@example.test',now()),
('93000000-0000-4000-8000-000000000002','role-admin-b@example.test',now()),
('93000000-0000-4000-8000-000000000003','role-staff@example.test',now());
insert into public.profiles(id,full_name,app_role,login_name,credentials_valid_after)
select id,'Synthetic',case when id::text like '%003' then 'employee' else 'system_admin' end,
  'concurrency'||right(id::text,1),now()-interval '1 day'
from auth.users where id::text like '93000000%';
insert into public.internal_org_people(id,full_name,company_key,position_title,auth_user_id)
select id,'Synthetic','mam','Test',id from public.profiles where id::text like '93000000%';
insert into private.portal_account_admins(auth_user_id) values
('93000000-0000-4000-8000-000000000001'),
('93000000-0000-4000-8000-000000000002');
