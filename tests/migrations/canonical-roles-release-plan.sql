-- Synthetic CI-only release inputs. Never use this plan in a hosted release.
\set ON_ERROR_STOP on
do $$ begin
  assert current_database() ~ '^mam_test_';
  assert inet_server_addr() is null and current_setting('listen_addresses')='';
  assert auth.uid() is null and current_user='postgres';
end $$;
begin;
insert into auth.users(id,email,email_confirmed_at)
select ('89000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,
  'ci-role-release-'||n||'@example.test',now() from generate_series(1,8) n;
insert into public.profiles(id,full_name,app_role,login_name,credentials_valid_after)
select ('89000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,
  'Synthetic CI Release '||n,case when n in (5,6) then 'employee' else 'system_admin' end,
  'ci-role-release-'||n,now()-interval '1 day' from generate_series(1,8) n;
insert into public.internal_org_people(id,full_name,company_key,position_title,auth_user_id)
select id,full_name,'mam','Synthetic CI Release',id from public.profiles
where login_name in ('ci-role-release-1','ci-role-release-2','ci-role-release-3',
  'ci-role-release-4','ci-role-release-5','ci-role-release-6');
create temp table ci_role_release_plan as
select jsonb_build_object('synthetic_ci_only',true,'targets',(
  select jsonb_agg(jsonb_build_object('user_id',p.id,'person_id',person.id,
    'before_role',p.app_role,'after_role',case when p.app_role='system_admin' then 'admin' else 'account' end,
    'account_before',jsonb_build_object('id',p.id,'app_role',p.app_role,'account_status',p.account_status,
      'account_version',p.account_version,'credentials_valid_after',p.credentials_valid_after),
    'person_before',jsonb_build_object('id',person.id,'auth_user_id',person.auth_user_id,
      'node_kind',person.node_kind,'company_key',person.company_key,'is_active',person.is_active)) order by p.id)
  from public.profiles p join public.internal_org_people person on person.auth_user_id=p.id
  where p.login_name in ('ci-role-release-1','ci-role-release-2','ci-role-release-3',
    'ci-role-release-4','ci-role-release-5','ci-role-release-6')),
  'p0',(select jsonb_agg(to_jsonb(p) order by p.id) from public.profiles p
    where p.login_name in ('ci-role-release-7','ci-role-release-8'))) as plan;
commit;
select set_config('mam.roles.release_plan',(select plan::text from ci_role_release_plan),false);
