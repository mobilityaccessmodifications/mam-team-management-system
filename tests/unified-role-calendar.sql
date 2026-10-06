\set ON_ERROR_STOP on
begin;
\ir unified-role-fixture.sql
insert into private.employee_directory_details(person_id,first_name,last_name,team_name,employment_type)
select id,'Synthetic',right(id::text,2),'Major','full_time'
from public.internal_org_people where id::text like 'a1000000%';
update public.internal_org_people set company_key='equipsy'
where id in ('a1000000-0000-4000-8000-000000000011','a1000000-0000-4000-8000-000000000016');
update public.internal_org_people set is_active=true where id='a1000000-0000-4000-8000-000000000011';
insert into public.leave_requests(id,user_id,employee_person_id,leave_type,request_type_label,
 start_date,end_date,business_days,hours,status,submitted_at,reason,manager_note,record_origin,source_record_sha256)
select ('a4000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,
 ('a1000000-0000-4000-8000-'||lpad(u::text,12,'0'))::uuid,
 ('a1000000-0000-4000-8000-'||lpad(u::text,12,'0'))::uuid,
 'unpaid','Unpaid leave',current_date+offset_days,current_date+offset_days,1,7.6,s,now(),
 'Synthetic private note','Synthetic private reviewer note',
 case when offset_days<0 then 'historical_import' else 'portal' end,
 case when offset_days<0 then repeat('a',64) end
from (values (1,1,'submitted',30),(2,16,'submitted',31),(3,16,'approved',32),
 (4,11,'approved',-30),(5,16,'rejected',33),(6,16,'changes_requested',34),
 (7,16,'cancelled',35),(8,3,'submitted',36),(9,6,'submitted',37)) data(n,u,s,offset_days);
update public.internal_org_people set is_active=false where id='a1000000-0000-4000-8000-000000000011';
do $$ declare n integer; actor uuid; actual jsonb; preview jsonb; begin
 for n in select unnest(array[3,6,4,9]) loop
  actor:=('a1000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid;
  perform pg_temp.set_test_actor(actor);
  assert (select can_view_all_leave_requests from public.get_portal_role_capabilities()), 'Canonical role grants all-scope Calendar without personal grants';
  assert exists(select 1 from public.list_leave_calendar_entries() where id='a4000000-0000-4000-8000-000000000001' and status='Pending'), 'Generic actual Calendar must include pending staff';
  assert exists(select 1 from public.list_leave_calendar_entries_with_teams() where id='a4000000-0000-4000-8000-000000000002' and status='Pending' and company_key='equipsy' and team_name='Major'), 'With-teams actual Calendar must include cross-company pending staff';
  assert exists(select 1 from public.list_leave_calendar_entries_with_teams() where id='a4000000-0000-4000-8000-000000000004' and status='Approved' and company_key='equipsy' and employee_name like '%(archived)%'), 'Generic Calendar retains approved archived cross-company history';
  assert not exists(select 1 from public.list_leave_calendar_entries_with_teams() where id in ('a4000000-0000-4000-8000-000000000005','a4000000-0000-4000-8000-000000000006','a4000000-0000-4000-8000-000000000007')), 'Calendar never includes rejected/changes-requested/cancelled requests';
  assert (select count(*)=count(distinct id) from public.list_leave_calendar_entries_with_teams()), 'Calendar owns each request exactly once';
  assert not exists(select 1 from public.list_leave_calendar_entries_with_teams() where person_id is distinct from actor and leave_type_label not in ('Approved leave','Pending leave')), 'Generic peer rows remain category-minimised';
  select coalesce(jsonb_agg(to_jsonb(c) order by c.id),'[]'::jsonb) into actual from public.list_leave_calendar_entries_with_teams() c;
  assert not exists(select 1 from jsonb_array_elements(actual) c where c ? 'reason' or c ? 'manager_note'), 'Generic Calendar never exposes notes';
  if n<>9 then
   assert (select array_agg(id order by id) from public.list_leave_calendar_entries())=(select array_agg(id order by id) from public.list_staff_leave_calendar_entries()), 'Staff-primary and generic-fallback Calendar IDs agree for all-scope roles';
   perform pg_temp.set_test_actor('a1000000-0000-4000-8000-000000000009');
   select coalesce(jsonb_agg(to_jsonb(c) order by c.id),'[]'::jsonb) into preview from public.list_leave_calendar_entries_with_teams_for_preview(actor) c;
   assert preview=actual, 'Generic actual/preview Calendar exact scope parity';
   assert (select array_agg(id order by id) from public.list_leave_calendar_entries_for_preview(actor))=(select array_agg(id order by id) from public.list_staff_leave_calendar_entries_for_preview(actor)), 'Preview staff-primary and generic-fallback Calendar IDs agree';
  end if;
 end loop;
 for n in select unnest(array[1,2,8]) loop
  actor:=('a1000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid;
  perform pg_temp.set_test_actor(actor);
  assert not (select can_view_all_leave_requests from public.get_portal_role_capabilities()), 'Employee and Manager do not inherit obsolete global Calendar grants';
  assert not exists(select 1 from public.list_leave_calendar_entries_with_teams() where id='a4000000-0000-4000-8000-000000000002'), 'Unrelated pending staff remain hidden from Employee/Manager';
  select coalesce(jsonb_agg(to_jsonb(c) order by c.id),'[]'::jsonb) into actual from public.list_leave_calendar_entries_with_teams() c;
  perform pg_temp.set_test_actor('a1000000-0000-4000-8000-000000000009');
  select coalesce(jsonb_agg(to_jsonb(c) order by c.id),'[]'::jsonb) into preview from public.list_leave_calendar_entries_with_teams_for_preview(actor) c;
  assert preview=actual, 'Employee/Manager preview cannot inherit P0 all-scope Calendar';
 end loop;
end $$;
select pg_temp.set_test_actor('a1000000-0000-4000-8000-000000000003');
set local role authenticated;
select count(*) from public.list_leave_calendar_entries_with_teams();
do $$ begin
 begin perform public.list_leave_calendar_entries_with_teams_for_preview('a1000000-0000-4000-8000-000000000003');
  raise exception 'Account preview bypass'; exception when insufficient_privilege then null; end;
end $$;
reset role;
rollback;
\echo PASS: generic/staff Calendar actual/preview parity, pending global scope and retained category-minimised history
