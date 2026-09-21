create schema auth;
create schema private;
create schema extensions;
create extension pgcrypto with schema extensions;
do $$begin
 if not exists(select from pg_roles where rolname='anon') then create role anon; end if;
 if not exists(select from pg_roles where rolname='authenticated') then create role authenticated; end if;
end$$;
create table auth.users(id uuid primary key);
create function auth.uid() returns uuid language sql as $$select nullif(current_setting('test.actor',true),'')::uuid$$;
create function auth.jwt() returns jsonb language sql as $$select '{}'::jsonb$$;
create function private.is_active_portal_account() returns boolean language sql as $$select coalesce(current_setting('test.active',true),'yes') <> 'no'$$;
create table public.synthetic_requests(id uuid default gen_random_uuid(), target uuid);
create function public.submit_my_leave_request(text,date,date,time,time,text)
returns table(id uuid,status text,approval_required boolean,assigned_reviewer_label text)
language plpgsql as $$begin
 if $1='reject' then raise exception 'Policy rejection' using errcode='22023'; end if;
 return query with r as(insert into public.synthetic_requests(target)values(auth.uid())returning synthetic_requests.id)
 select r.id,'Pending',true,'Synthetic reviewer' from r;
end$$;
create function public.submit_selected_employee_leave_request(uuid,text,date,date,time,time,text)
returns table(id uuid,status text,approval_required boolean,assigned_reviewer_label text)
language plpgsql as $$begin
 if $1 <> '30000000-0000-4000-8000-000000000001'::uuid then raise exception 'Not a manager' using errcode='42501'; end if;
 return query select * from public.submit_my_leave_request($2,$3,$4,$5,$6,$7);
end$$;
\ir ../supabase/migrations/20260921190000_reliable_leave_submission.sql
insert into auth.users values('10000000-0000-4000-8000-000000000001'),('10000000-0000-4000-8000-000000000002');
do $$declare k uuid := gen_random_uuid(); a uuid; b uuid; begin
 perform set_config('test.actor','10000000-0000-4000-8000-000000000001',true);
 select id into a from public.submit_leave_request_once(k,null,'Annual leave','2027-01-01','2027-01-02');
 select id into b from public.submit_leave_request_once(k,null,'Annual leave','2027-01-01','2027-01-02');
 assert a=b; assert (select count(*)=1 from public.synthetic_requests);
 begin
  perform public.submit_leave_request_once(k,null,'Sick leave','2027-01-01','2027-01-02');
  raise exception 'Changed input reused key';
 exception when invalid_parameter_value then null; end;
 perform set_config('test.active','no',true);
 begin
  perform public.submit_leave_request_once(k,null,'Annual leave','2027-01-01','2027-01-02');
  raise exception 'Inactive actor replayed';
 exception when insufficient_privilege then null; end;
 perform set_config('test.active','yes',true);
 perform set_config('test.actor','10000000-0000-4000-8000-000000000002',true);
 select id into b from public.submit_leave_request_once(k,null,'Annual leave','2027-01-01','2027-01-02');
 assert a<>b; assert (select count(*)=2 from public.synthetic_requests);
 begin
  perform public.submit_leave_request_once(gen_random_uuid(),gen_random_uuid(),'Annual leave','2027-01-01','2027-01-02');
  raise exception 'Delegation bypassed';
 exception when insufficient_privilege then null; end;
 begin
  perform public.submit_leave_request_once(gen_random_uuid(),null,'reject','2027-01-01','2027-01-02');
  raise exception 'Policy bypassed';
 exception when invalid_parameter_value then null; end;
 assert (select count(*)=2 from private.leave_submission_receipts),'Failed mutation must not reserve key';
 assert not has_table_privilege('authenticated','private.leave_submission_receipts','select');
 assert not has_function_privilege('anon','public.submit_leave_request_once(uuid,uuid,text,date,date,time,time,text)','execute');
end$$;
