\ir sql-test-auth.sql
create function pg_temp.splice_id(n integer) returns uuid language sql immutable as $$ select ('a7100000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid $$;
insert into auth.users(id,email,email_confirmed_at) select pg_temp.splice_id(n),'splice'||n||'@example.test',now() from generate_series(1,8)n;
insert into public.profiles(id,full_name,app_role,login_name,credentials_valid_after)
select pg_temp.splice_id(n),'Synthetic Splice '||n,case n when 1 then 'system_admin' when 2 then 'admin' when 3 then 'manager' when 4 then 'account' when 6 then 'system_admin' else 'employee' end,'splice'||n,now()-interval '1 day' from generate_series(1,8)n;
select pg_temp.set_test_actor(pg_temp.splice_id(1));
insert into public.internal_org_people(id,full_name,company_key,position_title,auth_user_id)
select pg_temp.splice_id(n),'Synthetic Linked '||n,'mam','Synthetic role',pg_temp.splice_id(n) from generate_series(2,6)n;
insert into public.internal_org_people(id,node_kind,full_name,company_key,position_title,parent_id,is_active,sort_order) values
(pg_temp.splice_id(10),'org_unit',null,'equipsy','Synthetic Ancestor',pg_temp.splice_id(3),true,10),
(pg_temp.splice_id(20),'person','Synthetic Target','mam','Synthetic role',pg_temp.splice_id(10),true,20),
(pg_temp.splice_id(30),'person','Synthetic Child','mam','Synthetic role',pg_temp.splice_id(20),true,30),
(pg_temp.splice_id(40),'org_unit',null,'equipsy','Synthetic Group',pg_temp.splice_id(20),true,40),
(pg_temp.splice_id(50),'vacancy',null,'mam','Synthetic Vacancy',pg_temp.splice_id(20),false,50),
(pg_temp.splice_id(60),'person','Synthetic Grandchild','mam','Synthetic role',pg_temp.splice_id(30),true,60);
insert into private.employee_directory_details(person_id,first_name,employment_type,trade_school_enabled)
select p.id,'Synthetic','full_time',true from public.internal_org_people p where p.id::text like 'a7100000%' and p.node_kind='person';
create temporary table splice_versions as select p.id,p.version person_version,d.version detail_version from public.internal_org_people p join private.employee_directory_details d on d.person_id=p.id where p.id::text like 'a7100000%';
grant select on splice_versions to authenticated;
