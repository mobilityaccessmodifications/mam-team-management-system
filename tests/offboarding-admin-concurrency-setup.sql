\set ON_ERROR_STOP on
\ir sql-test-auth.sql
insert into auth.users(id,email,email_confirmed_at) values
('94000000-0000-4000-8000-000000000001','offboard-admin-a@example.test',now()),
('94000000-0000-4000-8000-000000000002','offboard-admin-b@example.test',now());
insert into public.profiles(id,full_name,app_role,login_name,credentials_valid_after) values
('94000000-0000-4000-8000-000000000001','Synthetic admin A','system_admin','offboard-admin-a',now()-interval '1 day'),
('94000000-0000-4000-8000-000000000002','Synthetic admin B','system_admin','offboard-admin-b',now()-interval '1 day');
insert into public.internal_org_people(id,full_name,company_key,position_title,auth_user_id) values
('94000000-0000-4000-8000-000000000001','Synthetic admin A','mam','Test','94000000-0000-4000-8000-000000000001'),
('94000000-0000-4000-8000-000000000002','Synthetic admin B','mam','Test','94000000-0000-4000-8000-000000000002');
insert into private.employee_directory_details(person_id,first_name) values
('94000000-0000-4000-8000-000000000001','Synthetic'),
('94000000-0000-4000-8000-000000000002','Synthetic');
insert into private.scheduled_employee_offboarding(person_id,end_date,reason,scheduled_by) values
('94000000-0000-4000-8000-000000000001','2020-01-01','Resigned','94000000-0000-4000-8000-000000000002'),
('94000000-0000-4000-8000-000000000002','2020-01-01','Resigned','94000000-0000-4000-8000-000000000001');
