\set ON_ERROR_STOP on
begin;
\ir sql-test-auth.sql
insert into auth.users(id,email,email_confirmed_at) values ('a7000000-0000-4000-8000-000000000001','splice-p0@example.test',now());
insert into public.profiles(id,full_name,app_role,login_name,credentials_valid_after) values ('a7000000-0000-4000-8000-000000000001','Synthetic Splice P0','system_admin','splice-p0',now()-interval '1 day');
insert into public.internal_org_people(id,full_name,company_key,position_title,node_kind,parent_id,is_active,sort_order) values
('a7000000-0000-4000-8000-000000000010',null,'equipsy','Synthetic Ancestor','org_unit',null,true,1),
('a7000000-0000-4000-8000-000000000020','Synthetic Target','mam','Synthetic role','person','a7000000-0000-4000-8000-000000000010',true,2),
('a7000000-0000-4000-8000-000000000030','Synthetic Child','mam','Synthetic role','person','a7000000-0000-4000-8000-000000000020',true,3),
('a7000000-0000-4000-8000-000000000040',null,'equipsy','Synthetic Group','org_unit','a7000000-0000-4000-8000-000000000020',true,4),
('a7000000-0000-4000-8000-000000000050',null,'mam','Synthetic Vacancy','vacancy','a7000000-0000-4000-8000-000000000020',false,5),
('a7000000-0000-4000-8000-000000000060','Synthetic Grandchild','mam','Synthetic role','person','a7000000-0000-4000-8000-000000000030',true,6);
insert into private.employee_directory_details(person_id,first_name,employment_type,trade_school_enabled) values
('a7000000-0000-4000-8000-000000000020','Synthetic','full_time',true),
('a7000000-0000-4000-8000-000000000030','Synthetic','part_time',true);
create temporary table splice_people_before as select id,to_jsonb(p) value from public.internal_org_people p where id::text like 'a7000000%';
create temporary table splice_detail_before as select person_id,to_jsonb(d) value from private.employee_directory_details d where person_id::text like 'a7000000%';
create temporary table splice_versions as select p.version person_version,d.version detail_version from public.internal_org_people p join private.employee_directory_details d on d.person_id=p.id where p.id='a7000000-0000-4000-8000-000000000020';
grant select on splice_versions to authenticated;
select pg_temp.set_test_actor('a7000000-0000-4000-8000-000000000001');
set local role authenticated;
select * from public.archive_employee_directory_record('a7000000-0000-4000-8000-000000000020',(select person_version from splice_versions),(select detail_version from splice_versions),'2026-10-12','Resigned');
reset role;
do $$ begin
 assert (select count(*)=3 from public.internal_org_people where id in ('a7000000-0000-4000-8000-000000000030','a7000000-0000-4000-8000-000000000040','a7000000-0000-4000-8000-000000000050') and parent_id='a7000000-0000-4000-8000-000000000010'), 'Every direct child spliced to original active structural ancestor';
 assert not exists(select 1 from splice_people_before b join public.internal_org_people p on p.id=b.id where p.id in ('a7000000-0000-4000-8000-000000000030','a7000000-0000-4000-8000-000000000040','a7000000-0000-4000-8000-000000000050') and (to_jsonb(p)-array['parent_id','version','updated_at','updated_by']) is distinct from (b.value-array['parent_id','version','updated_at','updated_by'])), 'Moved identities/company/title/order/employment unchanged';
 assert (select to_jsonb(p)=b.value from public.internal_org_people p join splice_people_before b on b.id=p.id where p.id='a7000000-0000-4000-8000-000000000060'), 'Deeper subtree row byte-equivalent';
 assert not exists(select 1 from splice_people_before b join public.internal_org_people p on p.id=b.id where p.id in ('a7000000-0000-4000-8000-000000000030','a7000000-0000-4000-8000-000000000040','a7000000-0000-4000-8000-000000000050') and (p.version<>(b.value->>'version')::bigint+1 or p.updated_by is distinct from 'a7000000-0000-4000-8000-000000000001'::uuid)), 'Moved versions increment once with actual actor';
 assert (select count(*)=3 from private.employee_directory_audit_events where person_id in ('a7000000-0000-4000-8000-000000000030','a7000000-0000-4000-8000-000000000040','a7000000-0000-4000-8000-000000000050') and event_type='updated' and changed_fields=array['manager_id']::text[] and actor_user_id='a7000000-0000-4000-8000-000000000001'), 'One field-label reporting audit per child';
 assert (select to_jsonb(d)=b.value from private.employee_directory_details d join splice_detail_before b using(person_id) where d.person_id='a7000000-0000-4000-8000-000000000030'), 'Child private detail and trade school entitlement unchanged';
 assert (select not is_active from public.internal_org_people where id='a7000000-0000-4000-8000-000000000020'), 'Target archived';
end $$;
rollback;
\echo PASS: archive splices every direct child and preserves deeper identities
