create schema auth;
create schema private;
do $$ begin
 if not exists(select 1 from pg_roles where rolname='anon') then create role anon; end if;
 if not exists(select 1 from pg_roles where rolname='authenticated') then create role authenticated; end if;
 if not exists(select 1 from pg_roles where rolname='service_role') then create role service_role; end if;
end $$;
create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('test.actor',true),'')::uuid$$;
create table public.internal_org_people(id uuid,auth_user_id uuid,is_active boolean,node_kind text);
create table private.employee_directory_details(person_id uuid,employment_type text);
create table public.leave_requests(user_id uuid,record_origin text,request_type_label text,start_date date);
\ir ../supabase/migrations/20260921170000_self_service_leave_notice.sql
\ir ../supabase/migrations/20261123124000_remove_14_day_leave_notice.sql
insert into public.internal_org_people values ('10000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001',true,'person');
insert into private.employee_directory_details values ('10000000-0000-4000-8000-000000000001','full_time');
do $$
declare
 owner_id uuid := '20000000-0000-4000-8000-000000000001';
 today date := (now() at time zone 'Australia/Melbourne')::date;
 employment text; category text; offset_days integer;
begin
 perform set_config('test.actor',owner_id::text,true);
 foreach employment in array array['full_time','part_time','casual',null] loop
  update private.employee_directory_details set employment_type=employment;
  foreach category in array array['Annual leave','Unpaid leave'] loop
   foreach offset_days in array array[0,1,7,13,14] loop
    insert into public.leave_requests values(owner_id,'portal',category,today+offset_days);
   end loop;
  end loop;
 end loop;
 assert (select count(*)=40 from public.leave_requests), '40 self-service short and ordinary notice requests must be accepted';
 insert into public.leave_requests values(owner_id,'portal','Sick leave',today),(owner_id,'portal','Carer''s leave',today);
 perform set_config('test.actor','20000000-0000-4000-8000-000000000002',true);
 insert into public.leave_requests values(owner_id,'portal','Annual leave',today),(owner_id,'portal','Unpaid leave',today);
 perform set_config('test.actor','',true);
 insert into public.leave_requests values(owner_id,'portal','Annual leave',today);
 insert into public.leave_requests values(owner_id,'historical_import','Annual leave',today-30);
 assert not exists(select 1 from pg_trigger where tgrelid='public.leave_requests'::regclass and tgname='leave_requests_enforce_notice_period'), 'Notice trigger must be removed';
 assert to_regprocedure('private.enforce_self_service_leave_notice()') is null, 'Notice function must be removed';
end $$;
