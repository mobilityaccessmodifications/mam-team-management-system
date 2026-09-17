-- Run ONLY in a fresh disposable database. No real employees/credentials.
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role; end if;
end $$;
create schema private;
create table public.internal_org_people (id integer primary key, company_key text, is_active boolean);
create table private.employee_directory_details (person_id integer primary key, phone text);
alter table public.internal_org_people enable row level security;
alter table private.employee_directory_details enable row level security;
insert into public.internal_org_people values (1,'mam',true),(2,'mam',false),(3,'equipsy',true),(4,'mam',true),(5,'mam',true);
insert into private.employee_directory_details values (1,'+61400000001'),(2,'+61400000002'),(3,'+61400000003'),(4,null);
\ir ../supabase/migrations/20260917045203_openclaw_phone_allowlist.sql

do $$ begin
  if has_function_privilege('anon','public.openclaw_whatsapp_allowlist_snapshot()','execute')
    or has_function_privilege('authenticated','public.openclaw_whatsapp_allowlist_snapshot()','execute')
    or has_function_privilege('anon','private.openclaw_whatsapp_allowlist_snapshot()','execute')
    or has_function_privilege('authenticated','private.openclaw_whatsapp_allowlist_snapshot()','execute') then
    raise exception 'Browser role can execute allowlist function';
  end if;
  if has_table_privilege('service_role','private.employee_directory_details','select') then
    raise exception 'Unexpected direct table grant';
  end if;
end $$;
set role service_role;
do $$ declare snapshot jsonb; begin
  snapshot := public.openclaw_whatsapp_allowlist_snapshot();
  if snapshot->>'complete' <> 'true' or snapshot->>'rowCount' <> '2'
     or not (snapshot->'phones' @> '["+61400000001",null]'::jsonb)
     or jsonb_array_length(snapshot->'phones') <> 2 then
    raise exception 'Snapshot scope wrong';
  end if;
end $$;
reset role;
-- More than PostgREST default 1000 rows: aggregate must remain complete.
insert into public.internal_org_people select n,'mam',true from generate_series(100,1200) n;
insert into private.employee_directory_details select n,'+61400000001' from generate_series(100,1200) n;
set role service_role;
do $$ declare snapshot jsonb; begin
  snapshot := public.openclaw_whatsapp_allowlist_snapshot();
  if snapshot->>'rowCount' <> '1103' or jsonb_array_length(snapshot->'phones') <> 1103 then
    raise exception 'Truncated snapshot';
  end if;
end $$;
reset role;
update public.internal_org_people set is_active = false;
set role service_role;
do $$ begin
  if public.openclaw_whatsapp_allowlist_snapshot() <> '{"schemaVersion":1,"complete":true,"rowCount":0,"phones":[]}'::jsonb then
    raise exception 'Valid empty snapshot not returned';
  end if;
end $$;
reset role;
