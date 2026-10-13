\set ON_ERROR_STOP on
BEGIN;
\ir sql-test-auth.sql
INSERT INTO auth.users(id,email,email_confirmed_at)
SELECT ('e6000000-0000-4000-8000-00000000000'||n)::uuid,'legacy-note-'||n||'@example.test',now() FROM generate_series(1,3) n;
INSERT INTO public.profiles(id,full_name,app_role,login_name,credentials_valid_after)
SELECT ('e6000000-0000-4000-8000-00000000000'||n)::uuid,'Synthetic Legacy Note '||n,
 CASE n WHEN 1 THEN 'system_admin' WHEN 3 THEN 'manager' ELSE 'employee' END,'legacy-note-'||n,now()-interval '1 day' FROM generate_series(1,3) n;
INSERT INTO public.internal_org_people(id,full_name,company_key,position_title,auth_user_id)
SELECT id,full_name,'mam','Synthetic role',id FROM public.profiles WHERE login_name LIKE 'legacy-note-%';
UPDATE public.internal_org_people SET parent_id='e6000000-0000-4000-8000-000000000003' WHERE id='e6000000-0000-4000-8000-000000000002';
INSERT INTO private.employee_directory_details(person_id,employment_type)
SELECT id,'full_time' FROM public.profiles WHERE login_name LIKE 'legacy-note-%';
SELECT pg_temp.set_test_actor('e6000000-0000-4000-8000-000000000002');
SET LOCAL ROLE authenticated;
DO $$ BEGIN
 PERFORM public.submit_leave_request_once('e6000000-0000-4000-8000-000000000004',NULL,'Sick leave','2030-10-14','2030-10-14');
END $$;
RESET ROLE;
COMMIT;
