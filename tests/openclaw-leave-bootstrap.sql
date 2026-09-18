\set ON_ERROR_STOP on
do $$begin assert current_database() ~ '^openclaw_leave_test(_[0-9]+)?$','Disposable database only'; end$$;
create schema private;
create schema auth;
create function auth.uid() returns uuid language sql as $$select null::uuid$$;
create function auth.jwt() returns jsonb language sql as $$select '{}'::jsonb$$;
create table public.profiles(id uuid primary key,login_name text,account_status text);
create table public.internal_org_people(id uuid primary key,auth_user_id uuid unique,company_key text,is_active boolean,node_kind text,full_name text);
create table private.employee_directory_details(person_id uuid primary key,phone text,country text,employment_type text);
create function private.is_active_portal_account(p_user_id uuid default null) returns boolean language sql as $$select exists(select 1 from public.profiles where id=p_user_id and account_status='active')$$;
create function private.current_active_portal_employee_id() returns uuid language sql as $$select null::uuid$$;
create table public.leave_requests (
 id uuid primary key default gen_random_uuid(),user_id uuid,employee_person_id uuid,
 leave_type text,request_type_label text,start_date date,end_date date,start_time time,end_time time,
 business_days integer,hours numeric,approval_required boolean,manager_user_id uuid,manager_name_snapshot text,
 reason text,status text,submitted_at timestamptz,decided_at timestamptz,decided_by uuid,created_at timestamptz,updated_at timestamptz,
 submitted_by uuid,record_origin text default 'portal',employment_type_snapshot text,pay_treatment text
);
create table private.leave_request_reviewer_assignments(leave_request_id uuid,reviewer_user_id uuid,source_grant_id uuid,assignment_kind text,reviewer_label text,is_primary boolean);
create table public.leave_request_events(leave_request_id uuid,actor_user_id uuid,event_type text,note text);
create function private.resolve_leave_approval_grants(uuid) returns table(reviewer_user_id uuid,reviewer_label text,scope_kind text,scope_priority integer,scope_depth integer,grant_id uuid)
language sql as $$select '20000000-0000-4000-8000-000000000099'::uuid,'Synthetic reviewer','global',100,0,'30000000-0000-4000-8000-000000000099'::uuid$$;
create table private.leave_notification_outbox(request_id uuid,event text,unique(request_id,event));
create function private.fixture_outbox() returns trigger language plpgsql as $$begin insert into private.leave_notification_outbox values(new.id,'leave-submitted') on conflict do nothing;return new;end$$;
create trigger fixture_outbox after insert on public.leave_requests for each row execute function private.fixture_outbox();
insert into public.profiles values('20000000-0000-4000-8000-000000000001','synthetic','active');
insert into public.internal_org_people values('10000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001','mam',true,'person','Synthetic Employee');
insert into private.employee_directory_details values('10000000-0000-4000-8000-000000000001','0400000001','Australia','full_time');
