\set ON_ERROR_STOP on
create schema private;
create table public.internal_org_people(id int primary key, company_key text, position_title text, parent_id int);
create table private.employee_directory_details(person_id int primary key, team_name text, work_email text);
create table private.employee_directory_audit_events(person_id int,event_type text,changed_fields text[]);
create function private.unexpected_reminder() returns trigger language plpgsql as $$begin raise exception 'Team migration must not reschedule reminders';end$$;
create trigger employee_directory_details_sync_employee_check_in_manager_email after update on private.employee_directory_details for each row execute function private.unexpected_reminder();
insert into public.internal_org_people values
(1,'mam','Installer',3),(2,'mam','Scheduler',3),(3,'mam','Minor Mods Team Leader',null),
(4,'mam','Major Mods Team Leader',null),(5,'mam','Warehouse Manager',null),
(6,'mam','Welder',5),(7,'mam','Finance',null),(8,'mam','Marketing',null),
(9,'equipsy','Equipsy Team Leader',null),(10,'mam','Former employee',null),
(11,'mam','Carpenter',4),(12,'mam','Director',null);
insert into private.employee_directory_details select id,case id
when 1 then 'Minor Modifications Trades' when 2 then 'Minor Modifications Admin'
when 3 then 'Management Team' when 4 then 'Management Team' when 5 then 'Management Team'
when 6 then 'Metal' when 7 then 'Finance' when 8 then 'Projects' when 9 then 'Management Team'
when 10 then null when 11 then 'Major Modifications Trades' when 12 then 'Management Team' end,
'synthetic@example.test' from public.internal_org_people;
create temp table people_before as select * from public.internal_org_people;
\ir ../supabase/migrations/20260923150000_five_employee_teams.sql
do $$begin
  assert (select array_agg(team_name order by person_id) = array['Minor','Minor','Minor','Major','Warehouse','Warehouse','MAM admin','MAM admin','Equipsy',null,'Major','MAM admin'] from private.employee_directory_details), 'Mappings, leaders and archived unknowns';
  assert not exists((select * from people_before except select * from public.internal_org_people) union all (select * from public.internal_org_people except select * from people_before)), 'Company and hierarchy unchanged';
  assert (select bool_and(work_email='synthetic@example.test') from private.employee_directory_details), 'Other details unchanged';
  assert (select count(*)=11 from private.employee_directory_audit_events), 'Only changed labels audited';
  assert exists(select 1 from pg_trigger where tgname='employee_directory_details_sync_employee_check_in_manager_email' and tgenabled='O'), 'Reminder trigger restored';
  begin
    insert into private.employee_directory_details values(20,'Unapproved category','synthetic@example.test');
    raise exception 'Invalid team accepted';
  exception when check_violation then null; end;
end$$;
