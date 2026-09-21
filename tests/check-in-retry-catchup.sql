create schema private;
do $$begin
 if not exists(select from pg_roles where rolname='anon') then create role anon; end if;
 if not exists(select from pg_roles where rolname='authenticated') then create role authenticated; end if;
 if not exists(select from pg_roles where rolname='service_role') then create role service_role; end if;
end$$;
create function private.is_victorian_business_day(date) returns boolean language sql as $$select true$$;
create table public.internal_org_people(id uuid primary key,node_kind text default 'person',is_active boolean default true,started_date date default current_date,position_title text default 'Synthetic role');
create table private.employee_directory_details(person_id uuid,first_name text default 'Synthetic',last_name text default 'Person',team_name text default 'Synthetic',work_email text default 'synthetic@example.test');
create table private.employee_check_in_enrolments(person_id uuid,delivery_mode text default 'automatic');
create table private.employee_check_in_reminders(
 id uuid primary key default gen_random_uuid(),person_id uuid,delivery_status text default 'scheduled',needs_review_reason text,
 claim_token uuid,claimed_at timestamptz,updated_at timestamptz,created_at timestamptz default now(),attempt_count int default 0,
 notify_date date,due_date date,manual_catch_up_requested_at timestamptz,next_attempt_at timestamptz,
 last_delivery_error_code text,last_delivery_error_at timestamptz,milestone text default '2_week',reminder_sequence text default 'initial');
create table private.employee_check_in_reminder_events(reminder_id uuid,event_type text,error_code text);
create function private.resolve_internal_org_employee_manager(uuid) returns table(manager_id uuid,manager_name text) language sql as $$select $1,'Synthetic manager'$$;
create function private.employee_check_in_schedule(date) returns table(milestone text,reminder_sequence text,due_date date,notify_date date) language sql as $$select '2_week','initial',(clock_timestamp() at time zone 'Australia/Melbourne')::date+7,(clock_timestamp() at time zone 'Australia/Melbourne')::date-1$$;
\ir ../supabase/migrations/20260921191000_check_in_retry_catchup.sql
insert into public.internal_org_people(id)values('10000000-0000-4000-8000-000000000001');
insert into private.employee_directory_details(person_id)select id from public.internal_org_people;
insert into private.employee_check_in_enrolments(person_id)select id from public.internal_org_people;
do $$declare person uuid := '10000000-0000-4000-8000-000000000001'; today date := (clock_timestamp() at time zone 'Australia/Melbourne')::date; rid uuid; token uuid; begin
 insert into private.employee_check_in_reminders(person_id,notify_date,due_date)values(person,today-1,today+7) returning id into rid;
 insert into private.employee_check_in_reminders(person_id,notify_date,due_date)values(person,today-3,today-1),(person,today+1,today+8);
 insert into private.employee_check_in_reminders(person_id,notify_date,due_date,delivery_status,needs_review_reason)values(person,today-100,today-90,'needs_review','historic_cutover');
 select claim_token into token from public.claim_due_employee_check_in_reminders(10) where reminder_id=rid;
 assert token is not null,'Missed notification for upcoming check-in must be claimed';
 assert (select count(*)=1 from public.prepare_employee_check_in_reminder_delivery(rid,token)),'Preparation must also allow catch-up';
 assert (select count(*)=0 from public.claim_due_employee_check_in_reminders(10)),'Active lease must prevent duplicate claims';
 assert (select count(*)=1 from private.employee_check_in_reminders where needs_review_reason='missed_delivery'),'Past-due reminder stays a review item';
 assert (select count(*)=1 from private.employee_check_in_reminders where needs_review_reason='historic_cutover'),'Historical reminders remain untouched';
 assert (select count(*)=1 from private.employee_check_in_reminders where delivery_status='scheduled'),'Future reminder stays scheduled';
 assert not has_function_privilege('authenticated','public.claim_due_employee_check_in_reminders(integer)','execute');
end$$;
