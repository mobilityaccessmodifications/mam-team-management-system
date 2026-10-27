\set ON_ERROR_STOP on
begin;
do $$ begin assert current_database() ~ '^mam_test_', 'Disposable synthetic database required'; end $$;
\ir unified-role-fixture.sql
update public.internal_org_people set full_name='Alex Synthetic'
where id in ('a1000000-0000-4000-8000-000000000001','a1000000-0000-4000-8000-000000000002');
update public.internal_org_people set company_key='equipsy' where id='a1000000-0000-4000-8000-000000000002';
update private.subscription_request_config set enabled=false;
insert into private.subscription_register(id,subscription_code,service_name,pricing_model,billing_cycle,amount_cents,
  next_review_on,responsible_person_id,company_scope,created_by,updated_by)
values('b3500000-0000-4000-8000-000000000001','MAM-SUB-998901','Synthetic legacy team access','paid','monthly',22000,
  '2027-01-01','a1000000-0000-4000-8000-000000000004','equipsy',
  'a1000000-0000-4000-8000-000000000004','a1000000-0000-4000-8000-000000000004');
insert into private.subscription_memberships(subscription_id,person_id,created_by)
values('b3500000-0000-4000-8000-000000000001','a1000000-0000-4000-8000-000000000001','a1000000-0000-4000-8000-000000000004');
create temporary table subscription_team_before as
select to_jsonb(s)-array['version','updated_at','updated_by'] value from private.subscription_register s where id='b3500000-0000-4000-8000-000000000001';
create temporary table subscription_member_before as select * from private.subscription_memberships where subscription_id='b3500000-0000-4000-8000-000000000001';
update private.subscription_request_config set enabled=true;
select pg_temp.set_test_actor('a1000000-0000-4000-8000-000000000004');
set local role authenticated;
do $$ declare r jsonb; begin
  r:=public.update_subscription_members_v1('b3500000-0000-4000-8000-000000000001',1,
    array['a1000000-0000-4000-8000-000000000002','a1000000-0000-4000-8000-000000000001','a1000000-0000-4000-8000-000000000002']::uuid[]);
  assert r->'member_person_ids'='["a1000000-0000-4000-8000-000000000001","a1000000-0000-4000-8000-000000000002"]'::jsonb;
  assert r->'member_names'='["Alex Synthetic","Alex Synthetic"]'::jsonb;
  assert r->>'version'='2' and r->'seat_count'='null'::jsonb and r->'billing_anchor_date'='null'::jsonb;
  assert not (r->'member_person_ids' ? 'a1000000-0000-4000-8000-000000000004'), 'Responsible person is not implicitly assigned';
  r:=public.update_subscription_members_v1('b3500000-0000-4000-8000-000000000001',2,
    array['a1000000-0000-4000-8000-000000000002','a1000000-0000-4000-8000-000000000001']::uuid[]);
  assert r->>'version'='2', 'No-op must not increment version';
  begin perform public.update_subscription_members_v1('b3500000-0000-4000-8000-000000000001',1,'{}');raise exception 'Stale access save passed';
    exception when serialization_failure then null;end;
  begin perform public.update_subscription_members_v1('b3500000-0000-4000-8000-000000000001',2,null);raise exception 'Null access passed';
    exception when invalid_parameter_value then null;end;
  begin perform public.update_subscription_members_v1('b3500000-0000-4000-8000-000000000001',2,array[null]::uuid[]);raise exception 'Null member passed';
    exception when invalid_parameter_value then null;end;
  begin perform public.update_subscription_members_v1('b3500000-0000-4000-8000-000000000001',2,array_fill('a1000000-0000-4000-8000-000000000001'::uuid,array[251]));raise exception 'Oversized list passed';
    exception when invalid_parameter_value then null;end;
  begin perform public.update_subscription_members_v1('b3500000-0000-4000-8000-000000000001',2,array['a1000000-0000-4000-8000-000000000011']::uuid[]);raise exception 'Inactive member passed';
    exception when foreign_key_violation then null;end;
  begin perform public.update_subscription_members_v1('b3500000-0000-4000-8000-000000000001',2,array['b3500000-0000-4000-8000-000000000099']::uuid[]);raise exception 'Unknown member passed';
    exception when foreign_key_violation then null;end;
  begin perform public.create_subscription_v4('Unapproved paid',null,'paid','monthly',100,null,2,false,null,'2026-10-01',
    'a1000000-0000-4000-8000-000000000004','mam','{}');raise exception 'Procurement gate bypassed';
    exception when object_not_in_prerequisite_state then null;end;
end $$;
reset role;
do $$ begin
  assert (select to_jsonb(s)-array['version','updated_at','updated_by'] from private.subscription_register s where id='b3500000-0000-4000-8000-000000000001')=(select value from subscription_team_before);
  assert (select to_jsonb(m) from private.subscription_memberships m where subscription_id='b3500000-0000-4000-8000-000000000001' and person_id='a1000000-0000-4000-8000-000000000001')=(select to_jsonb(m) from subscription_member_before m);
  assert (select count(*) from private.subscription_audit_events where subscription_id='b3500000-0000-4000-8000-000000000001')=1;
  assert exists(select 1 from private.subscription_audit_events where subscription_id='b3500000-0000-4000-8000-000000000001' and actor_user_id='a1000000-0000-4000-8000-000000000004' and changed_fields=array['member_person_ids']);
end $$;
select pg_temp.set_test_actor('a1000000-0000-4000-8000-000000000001');
set local role authenticated;
do $$ begin
  assert exists(select 1 from public.list_my_subscriptions() where subscription_id='b3500000-0000-4000-8000-000000000001');
  assert not public.can_manage_subscriptions() and not public.can_manage_subscription_credentials(), 'Assignment must not elevate register or vault authority';
end $$;
reset role;
do $$ declare actor uuid; begin
  foreach actor in array array['a1000000-0000-4000-8000-000000000001','a1000000-0000-4000-8000-000000000002','a1000000-0000-4000-8000-000000000003','a1000000-0000-4000-8000-000000000008','a1000000-0000-4000-8000-000000000016']::uuid[] loop
    perform pg_temp.set_test_actor(actor);
    set local role authenticated;
    begin perform public.update_subscription_members_v1('b3500000-0000-4000-8000-000000000001',2,'{}');raise exception 'Unauthorized team writer passed: %',actor;
      exception when insufficient_privilege then null;end;
    reset role;
  end loop;
  foreach actor in array array['a1000000-0000-4000-8000-000000000004','a1000000-0000-4000-8000-000000000005','a1000000-0000-4000-8000-000000000015']::uuid[] loop
    perform pg_temp.set_test_actor(actor);
    set local role authenticated;
    perform public.update_subscription_members_v1('b3500000-0000-4000-8000-000000000001',2,array['a1000000-0000-4000-8000-000000000001','a1000000-0000-4000-8000-000000000002']::uuid[]);
    reset role;
  end loop;
end $$;
select pg_temp.set_test_actor('a1000000-0000-4000-8000-000000000009');
set local role authenticated;
select public.replace_subscription_management_delegates(array['a1000000-0000-4000-8000-000000000001']::uuid[]);
reset role;
select pg_temp.set_test_actor('a1000000-0000-4000-8000-000000000001');
set local role authenticated;
select public.update_subscription_members_v1('b3500000-0000-4000-8000-000000000001',2,array['a1000000-0000-4000-8000-000000000002']::uuid[]) is not null;
do $$ begin
  assert not exists(select 1 from public.list_my_subscriptions() where subscription_id='b3500000-0000-4000-8000-000000000001'), 'Revoked membership must leave own view';
  assert not public.can_manage_subscription_credentials(), 'Register delegate must not receive vault authority';
end $$;
reset role;
select pg_temp.set_test_actor('a1000000-0000-4000-8000-000000000002');
set local role authenticated;
do $$ begin assert exists(select 1 from public.list_my_subscriptions() where subscription_id='b3500000-0000-4000-8000-000000000001'), 'Same-name remaining person must retain exact access'; end $$;
reset role;
select pg_temp.set_test_actor('a1000000-0000-4000-8000-000000000009');
update public.internal_org_people set is_active=false where id='a1000000-0000-4000-8000-000000000004';
set local role authenticated;
do $$ declare r jsonb; begin
  assert not exists(select 1 from public.list_employee_subscriptions_for_preview('a1000000-0000-4000-8000-000000000001') where subscription_id='b3500000-0000-4000-8000-000000000001');
  r:=public.update_subscription_members_v1('b3500000-0000-4000-8000-000000000001',3,'{}');
  assert r->'member_person_ids'='[]'::jsonb and r->'member_names'='[]'::jsonb and r->>'version'='4';
end $$;
reset role;
do $$ declare role_name text; begin
  foreach role_name in array array['anon','authenticated','service_role'] loop
    assert has_function_privilege(role_name,'public.update_subscription_members_v1(uuid,bigint,uuid[])','EXECUTE')=(role_name='authenticated');
    assert not has_table_privilege(role_name,'private.subscription_memberships','UPDATE');
  end loop;
  assert (select prosecdef and proconfig=array['search_path=""'] from pg_proc where oid='public.update_subscription_members_v1(uuid,bigint,uuid[])'::regprocedure);
  assert private.confirmed_test_purge_schema_hash()=(select schema_hash from private.confirmed_test_purge_schema where singleton);
end $$;
rollback;
\echo PASS: exact same-name identity, legacy billing preservation, no-op, provenance, audit, role and vault boundaries, membership revocation, clear-all, procurement gate, ACL and catalog fence
