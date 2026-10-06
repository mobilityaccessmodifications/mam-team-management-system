\set ON_ERROR_STOP on
DO $$ BEGIN ASSERT current_database() ~ '^mam_test_annual_'; ASSERT inet_server_addr() IS NULL; END $$;
BEGIN;
INSERT INTO auth.users(id,email,email_confirmed_at) VALUES
('b2000000-0000-4000-8000-000000000001','annual-legacy-admin@example.test',now()),
('b2000000-0000-4000-8000-000000000002','annual-legacy-employee@example.test',now());
INSERT INTO public.profiles(id,full_name,app_role,login_name,credentials_valid_after) VALUES
('b2000000-0000-4000-8000-000000000001','Synthetic Legacy Admin','system_admin','annual-legacy-admin',now()-interval '1 day'),
('b2000000-0000-4000-8000-000000000002','Synthetic Legacy Employee','employee','annual-legacy-employee',now()-interval '1 day');
INSERT INTO public.internal_org_people(id,full_name,company_key,position_title,auth_user_id)
SELECT id,full_name,'mam','Synthetic legacy role',id FROM public.profiles WHERE login_name LIKE 'annual-legacy-%';
INSERT INTO private.employee_directory_details(person_id,employment_type) VALUES
('b2000000-0000-4000-8000-000000000001','full_time'),('b2000000-0000-4000-8000-000000000002','part_time');
INSERT INTO private.employee_annual_leave_balances(person_id,hours,as_of,is_example,updated_by)
VALUES('b2000000-0000-4000-8000-000000000002',7.5,'2030-12-09',false,'b2000000-0000-4000-8000-000000000001');
INSERT INTO public.leave_requests(id,employee_person_id,record_origin,source_record_sha256,status,submitted_at,
  leave_type,request_type_label,start_date,end_date,business_days)
VALUES('b2000000-0000-4000-8000-000000000010','b2000000-0000-4000-8000-000000000002','historical_import',repeat('d',64),'submitted',now(),
  'annual','Annual leave','2030-12-09','2030-12-09',1);
UPDATE public.leave_requests SET employment_type_snapshot=NULL WHERE id='b2000000-0000-4000-8000-000000000010';
COMMIT;
