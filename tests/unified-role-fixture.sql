\ir sql-test-auth.sql
insert into auth.users(id,email,email_confirmed_at)
select ('a1000000-0000-4000-8000-' || lpad(n::text,12,'0'))::uuid,
  'unified-role-' || n || '@example.test',now() from generate_series(1,16) n;
insert into public.profiles(id,full_name,app_role,login_name,credentials_valid_after,account_status,disabled_at)
select id,'Synthetic role ' || right(id::text,2),
  case right(id::text,2)::integer when 1 then 'employee' when 2 then 'manager'
    when 3 then 'account' when 4 then 'admin' when 5 then 'system_admin'
    when 6 then 'account' when 7 then 'hr' when 8 then 'employee' when 9 then 'system_admin'
    when 10 then 'account' when 11 then 'manager' when 12 then 'admin' when 13 then 'admin' else 'manager' end,
  'unified-role-' || right(id::text,2),now()-interval '1 day',
  case when right(id::text,2)::integer=10 then 'disabled' else 'active' end,
  case when right(id::text,2)::integer=10 then now() end
from auth.users where id::text like 'a1000000%';
insert into public.internal_org_people(id,full_name,position_title,company_key,auth_user_id,is_active)
select id,full_name,'Synthetic unrelated title','mam',id,right(id::text,2)::integer<>11 from public.profiles
where id::text like 'a1000000%' and right(id::text,2)::integer not in (9,12);
update public.internal_org_people set parent_id='a1000000-0000-4000-8000-000000000002'
where id='a1000000-0000-4000-8000-000000000001';
insert into private.payroll_balance_import_grants(person_id,granted_by)
select id,'a1000000-0000-4000-8000-000000000009' from public.internal_org_people
where id::text like 'a1000000%' and right(id::text,2)::integer in (6,8);
insert into private.leave_register_read_grants(person_id)
select id from public.internal_org_people where id::text like 'a1000000%' and right(id::text,2)::integer in (6,8);
insert into private.approved_leave_calendar_grants(person_id)
select id from public.internal_org_people where id::text like 'a1000000%' and right(id::text,2)::integer in (6,8);
insert into private.payroll_comparison_only_importers(person_id)
values ('a1000000-0000-4000-8000-000000000008');
insert into private.leave_approval_grants(reviewer_user_id,scope_kind,reviewer_label)
select id,'global','Synthetic stale grant' from public.profiles
where id::text like 'a1000000%' and right(id::text,2)::integer in (6,8);
insert into private.employee_check_in_access_grants(reviewer_user_id,scope_kind)
select id,'global' from public.profiles
where id::text like 'a1000000%' and right(id::text,2)::integer in (6,8);
insert into private.subscription_management_grants(person_id)
select id from public.internal_org_people where id::text like 'a1000000%' and right(id::text,2)::integer in (6,8,15);
insert into private.subscription_credential_access_grants(auth_user_id,person_id)
select auth_user_id,id from public.internal_org_people where id::text like 'a1000000%' and right(id::text,2)::integer in (6,8,16);
