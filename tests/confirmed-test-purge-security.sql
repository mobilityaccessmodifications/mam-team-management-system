\set ON_ERROR_STOP on
begin;
\ir sql-test-auth.sql
alter table auth.users add column confirmed_at timestamptz generated always as (email_confirmed_at) stored;
insert into auth.users(id,email,email_confirmed_at) values
('96000000-0000-4000-8000-000000000001','security-admin@example.test',now()),
('96000000-0000-4000-8000-000000000002','zed@example.test',now());
insert into public.profiles(id,full_name,app_role,login_name,account_status,credentials_valid_after,disabled_at)
values ('96000000-0000-4000-8000-000000000001','Security Admin Synthetic','system_admin','security-admin@example.test','active',now()-interval '1 day',null),
('96000000-0000-4000-8000-000000000002','Zed','employee','zed@example.test','disabled',now()-interval '1 day',now());
insert into public.internal_org_people(id,full_name,company_key,position_title,auth_user_id,is_active)
values ('96000000-0000-4000-8000-000000000002','Zed','mam','Synthetic', '96000000-0000-4000-8000-000000000002',true);
select pg_temp.set_test_actor('96000000-0000-4000-8000-000000000001');
set local role authenticated;
do $$ declare reviewed jsonb; begin
reviewed:=public.preview_confirmed_test_identity_purge('96000000-0000-4000-8000-000000000002','96000000-0000-4000-8000-000000000002','mam','Zed','zed@example.test',1,1);
begin
perform public.prepare_confirmed_test_identity_purge('96000000-0000-4000-8000-000000000002','96000000-0000-4000-8000-000000000002','mam','Zed','zed@example.test',1,1,reviewed->>'manifest_hash',true,true);
raise exception 'Unbanned direct RPC destroyed business identity';
exception when check_violation then assert sqlerrm like '%already be banned%', 'Wrong ban prerequisite failure'; end;
end $$;
reset role;
update auth.users set banned_until=clock_timestamp()+interval '10 seconds' where id='96000000-0000-4000-8000-000000000002';
set local role authenticated;
do $$ declare reviewed jsonb; begin
reviewed:=public.preview_confirmed_test_identity_purge('96000000-0000-4000-8000-000000000002','96000000-0000-4000-8000-000000000002','mam','Zed','zed@example.test',1,1);
perform public.prepare_confirmed_test_identity_purge('96000000-0000-4000-8000-000000000002','96000000-0000-4000-8000-000000000002','mam','Zed','zed@example.test',1,1,reviewed->>'manifest_hash',true,true);
end $$;
reset role;
select pg_sleep(greatest(0,extract(epoch from banned_until-clock_timestamp()))+0.1)
from auth.users where id='96000000-0000-4000-8000-000000000002';
set local role authenticated;
do $$ declare receipt jsonb; begin
receipt:=public.get_confirmed_test_identity_purge('96000000-0000-4000-8000-000000000002');
begin perform public.claim_confirmed_test_identity_auth_delete((receipt->>'id')::uuid); raise exception 'Expired ban authorized Auth deletion'; exception when check_violation then null; end;
end $$;
reset role;
do $$ begin
assert (select confirmed_at is not null and confirmed_at=email_confirmed_at from auth.users where id='96000000-0000-4000-8000-000000000002'), 'Generated confirmation fixture must be populated';
end $$;
update auth.users set banned_until=now()+interval '2 days',updated_at=clock_timestamp() where id='96000000-0000-4000-8000-000000000002';
insert into public.internal_org_people(id,full_name,company_key,position_title,is_active)
values ('96000000-0000-4000-8000-000000000003','Zedrick','mam','Zed replacement is a legitimate label',false);
insert into auth.users(id,email,email_confirmed_at) values ('96000000-0000-4000-8000-000000000004','zed@example.test',now());
do $$ begin
assert (select confirmed_at=email_confirmed_at from auth.users where id='96000000-0000-4000-8000-000000000002'), 'Containment must preserve generated confirmation';
begin update auth.users set banned_until=now()+interval '3 days',updated_at=clock_timestamp(),email_confirmed_at=email_confirmed_at+interval '1 second' where id='96000000-0000-4000-8000-000000000002'; raise exception 'Generated source confirmation changed during containment'; exception when check_violation then null; end;
begin update auth.users set banned_until=now()+interval '3 days',updated_at=clock_timestamp(),email='changed@example.test' where id='96000000-0000-4000-8000-000000000002'; raise exception 'Protected email changed during containment'; exception when check_violation then null; end;
begin update auth.users set banned_until=now()+interval '1 day',updated_at=clock_timestamp() where id='96000000-0000-4000-8000-000000000002'; raise exception 'Containment ban shortened'; exception when check_violation then null; end;
begin update auth.users set banned_until=now()+interval '3 days',updated_at=updated_at-interval '1 second' where id='96000000-0000-4000-8000-000000000002'; raise exception 'Containment timestamp decreased'; exception when check_violation then null; end;
begin insert into private.openclaw_leave_receipts(key,body) values(repeat('c',64),jsonb_build_object('path','people/96000000-0000-4000-8000-000000000002/evidence.pdf')); raise exception 'Embedded stable retired UUID reference permitted'; exception when check_violation then null; end;
begin update auth.users set banned_until=null where id='96000000-0000-4000-8000-000000000002'; raise exception 'Unresolved target unbanned'; exception when check_violation then null; end;
begin update auth.users set raw_user_meta_data=jsonb_build_object('retired','96000000-0000-4000-8000-000000000002') where id='96000000-0000-4000-8000-000000000004'; raise exception 'New stable retired reference permitted'; exception when check_violation then null; end;
end $$;
rollback;
