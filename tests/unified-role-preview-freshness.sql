\set ON_ERROR_STOP on
begin;
\ir unified-role-fixture.sql
insert into private.employee_directory_details(person_id,first_name,last_name,date_of_birth)
select id,'Synthetic',right(id::text,2),date '1990-01-01'
from public.internal_org_people where id::text like 'a1000000%';
create temp table freshness_cases(actor uuid,denied boolean,canonical_denied boolean,actual_denied boolean);
grant insert,select on freshness_cases to authenticated;
select pg_temp.set_test_actor('a1000000-0000-4000-8000-000000000009');
set local role authenticated;
do $$ declare actor uuid; denied boolean; canonical_denied boolean; actual_denied boolean; begin
  foreach actor in array array['a1000000-0000-4000-8000-000000000005','a1000000-0000-4000-8000-000000000009']::uuid[] loop
    perform set_config('request.jwt.claim.sub',actor::text,true);
    perform set_config('request.jwt.claims',jsonb_build_object('sub',actor,'iat',extract(epoch from clock_timestamp()-interval '2 days')::bigint,'is_anonymous',false)::text,true);
    denied:=false; canonical_denied:=false; actual_denied:=false;
    begin perform public.get_portal_role_capabilities(); exception when insufficient_privilege then canonical_denied:=true; end;
    begin perform public.list_calendar_birthdays(); exception when insufficient_privilege then actual_denied:=true; end;
    begin perform public.list_calendar_birthdays_for_preview('a1000000-0000-4000-8000-000000000004'); exception when insufficient_privilege then denied:=true; end;
    insert into freshness_cases values(actor,denied,canonical_denied,actual_denied);
  end loop;
  assert (select bool_and(c.canonical_denied and c.actual_denied) from freshness_cases c), 'Stale P0 canonical and actual birthday prerequisites must deny';
  assert (select bool_and(c.denied) from freshness_cases c), 'SQL-01 stale linked/standalone P0 read birthday preview without fresh credentials';
end $$;
reset role;
select pg_temp.set_test_actor('a1000000-0000-4000-8000-000000000009');
set local role authenticated;
do $$ begin
  assert (select count(*)=13 from public.list_calendar_birthdays_for_preview('a1000000-0000-4000-8000-000000000004')), 'Fresh standalone P0 retains Admin birthday preview';
  assert (select count(*)=1 from public.list_calendar_birthdays_for_preview('a1000000-0000-4000-8000-000000000003')), 'Account birthday preview remains own-only';
end $$;
reset role;
rollback;
\echo PASS: birthday preview requires fresh linked/standalone P0 and retains selected-target birthday scope