\set ON_ERROR_STOP on
begin;
\ir unified-role-fixture.sql
insert into private.leave_approval_grants(reviewer_user_id,scope_kind,reviewer_label)
select id,'global',full_name from public.profiles
where id in('a1000000-0000-4000-8000-000000000004','a1000000-0000-4000-8000-000000000005','a1000000-0000-4000-8000-000000000009')
and not exists(select 1 from private.leave_approval_grants g where g.reviewer_user_id=profiles.id and g.scope_kind='global' and g.revoked_at is null);
insert into private.manager_leave_reviewers(reviewer_user_id,priority)
select id,row_number()over(order by id) from public.profiles
where id in('a1000000-0000-4000-8000-000000000004','a1000000-0000-4000-8000-000000000005','a1000000-0000-4000-8000-000000000009');
select pg_temp.set_test_actor('a1000000-0000-4000-8000-000000000009');
insert into public.internal_org_people(id,full_name,position_title,company_key,parent_id)
values('a2000000-0000-4000-8000-000000000001','Synthetic parent-change subject','Synthetic role','mam','a1000000-0000-4000-8000-000000000002');
insert into public.leave_requests(id,user_id,employee_person_id,leave_type,request_type_label,start_date,end_date,business_days,hours,status,submitted_at,approval_required,employment_type_snapshot)
select ('a3000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,p.id,p.id,'unpaid','Unpaid leave','2030-12-09','2030-12-09',1,8,'submitted',clock_timestamp(),true,'full_time'
from (values(1,'a1000000-0000-4000-8000-000000000002'::uuid),(2,'a1000000-0000-4000-8000-000000000014'::uuid))s(n,person)join public.profiles p on p.id=s.person;
select private.reroute_pending_leave_requests_to_current_manager();
create temporary table parent_before_requests as select id,to_jsonb(r)as raw from public.leave_requests r;
create temporary table parent_before_assignments as select * from private.leave_request_reviewer_assignments;
create temporary table parent_before_profiles as select id,to_jsonb(p)as raw from public.profiles p;
create temporary table parent_before_people as select id,to_jsonb(p)as raw from public.internal_org_people p;
create temporary table parent_before_grants as select id,to_jsonb(g)as raw from private.leave_approval_grants g;
create temporary table parent_change_version as select version from public.internal_org_people where id='a2000000-0000-4000-8000-000000000001';
grant select on parent_change_version to authenticated;
set local role authenticated;
select public.update_internal_org_node(
 p_node_id=>'a2000000-0000-4000-8000-000000000001',p_company_key=>'mam',p_node_kind=>'person',p_position_title=>'Synthetic role',p_full_name=>'Synthetic parent-change subject',
 p_parent_id=>'a1000000-0000-4000-8000-000000000014',p_started_date=>null,p_sort_order=>0,p_is_active=>true,p_expected_version=>(select version from parent_change_version));
reset role;
do $effect$
begin
 assert (select count(*)from parent_before_requests)=2;
 assert (select count(*)from parent_before_assignments)=6;
 assert (select count(*)from parent_before_requests b join public.leave_requests r using(id)where r.updated_at>(b.raw->>'updated_at')::timestamptz)=2,
  'An unrelated parent update reroutes both Manager-owned pending requests';
 assert not exists(select 1 from parent_before_requests b join public.leave_requests r using(id)where(b.raw-'manager_user_id'-'manager_name_snapshot'-'updated_at')<>(to_jsonb(r)-'manager_user_id'-'manager_name_snapshot'-'updated_at')),
  'Original status, duration, dates and economic fields must stay unchanged';
 assert not exists(select 1 from parent_before_assignments b join private.leave_request_reviewer_assignments a using(leave_request_id,reviewer_user_id)where a.assigned_at<=b.assigned_at),
  'Existing reviewer assignments are recreated by the original global reroute';
 assert (select count(*)from private.leave_request_reviewer_assignments)=6;
 assert not exists(select 1 from parent_before_profiles b join public.profiles p using(id)where b.raw<>to_jsonb(p));
 assert not exists(select 1 from parent_before_people b join public.internal_org_people p using(id)where p.id<>'a2000000-0000-4000-8000-000000000001' and b.raw<>to_jsonb(p));
 assert not exists(select 1 from parent_before_grants b join private.leave_approval_grants g using(id)where b.raw<>to_jsonb(g));
 assert (select parent_id from public.internal_org_people where id='a2000000-0000-4000-8000-000000000001')='a1000000-0000-4000-8000-000000000014'::uuid;
end;
$effect$;
rollback;
