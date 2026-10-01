\set ON_ERROR_STOP on
\ir sql-test-auth.sql
insert into auth.users(id,email,email_confirmed_at) values
('95000000-0000-4000-8000-000000000001','reset-admin@example.test',now()),
('95000000-0000-4000-8000-000000000002','reset-staff@example.test',now());
insert into public.profiles(id,full_name,app_role,login_name,credentials_valid_after)
values ('95000000-0000-4000-8000-000000000001','Synthetic Admin','system_admin','reset-admin@example.test',now()-interval '1 day'),
('95000000-0000-4000-8000-000000000002','Synthetic Starter','employee','reset-staff@example.test',now()-interval '1 day');
insert into private.portal_account_admins(auth_user_id) values ('95000000-0000-4000-8000-000000000001');
insert into public.internal_org_people(id,node_kind,company_key,full_name,position_title,auth_user_id,started_date,is_active)
values ('95000000-0000-4000-8000-000000000002','person','mam','Synthetic Starter','Tester','95000000-0000-4000-8000-000000000002',timezone('Australia/Melbourne',clock_timestamp())::date-1,true);
insert into private.employee_directory_details(person_id,first_name,work_email)
values ('95000000-0000-4000-8000-000000000002','Synthetic','reset-staff@example.test');
