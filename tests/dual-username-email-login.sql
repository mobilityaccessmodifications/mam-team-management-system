begin;

insert into auth.users(id,email,encrypted_password) values
 ('ee220000-0000-4000-8000-000000000001','dual-one@opaque.invalid','synthetic-password-hash'),
 ('ee220000-0000-4000-8000-000000000002','dual-two@opaque.invalid','synthetic-other-hash'),
 ('ee220000-0000-4000-8000-000000000003','dual-three@opaque.invalid','synthetic-admin-hash'),
 ('ee220000-0000-4000-8000-000000000004','dual-four@opaque.invalid','synthetic-unlinked-hash'),
 ('ee220000-0000-4000-8000-000000000005','dual-five@opaque.invalid','synthetic-operator-hash');
insert into public.profiles(id,full_name,login_name,app_role,account_status) values
 ('ee220000-0000-4000-8000-000000000001','Synthetic Dual One','dual.current@example.test','employee','active'),
 ('ee220000-0000-4000-8000-000000000002','Synthetic Dual Two','dual.other@example.test','employee','active'),
 ('ee220000-0000-4000-8000-000000000003','Synthetic Dual Admin','dual.admin','system_admin','active'),
 ('ee220000-0000-4000-8000-000000000004','Synthetic Dual Unlinked','dual.unlinked@example.test','employee','active');
insert into public.profiles(id,full_name,login_name,app_role,account_status,credentials_valid_after) values
 ('ee220000-0000-4000-8000-000000000005','Synthetic Dual Operator','dual.operator','system_admin','active',now()-interval '1 day');
insert into public.internal_org_people(id,auth_user_id,full_name,position_title,company_key,node_kind,is_active) values
 ('ee220000-0000-4000-8000-000000000011','ee220000-0000-4000-8000-000000000001','Synthetic Dual One','Tester','mam','person',true),
 ('ee220000-0000-4000-8000-000000000012','ee220000-0000-4000-8000-000000000002','Synthetic Dual Two','Tester','mam','person',true);
insert into private.portal_account_admin_events(target_user_id,event_type,before_state,after_state) values
 ('ee220000-0000-4000-8000-000000000001','login_renamed','{"login_name":"dual.legacy"}','{"login_name":"dual.first@example.test"}'),
 ('ee220000-0000-4000-8000-000000000001','login_renamed','{"login_name":"dual.legacy"}','{"login_name":"dual.first@example.test"}'),
 ('ee220000-0000-4000-8000-000000000001','login_renamed','{"login_name":"dual.first@example.test"}','{"login_name":"dual.current@example.test"}'),
 ('ee220000-0000-4000-8000-000000000001','login_renamed','{"login_name":"dual.ambiguous"}','{"login_name":"dual.first@example.test"}'),
 ('ee220000-0000-4000-8000-000000000002','login_renamed','{"login_name":"dual.ambiguous"}','{"login_name":"dual.other@example.test"}'),
 ('ee220000-0000-4000-8000-000000000004','login_renamed','{"login_name":"dual.unlinked"}','{"login_name":"dual.unlinked@example.test"}'),
 ('ee220000-0000-4000-8000-000000000001','password_reset_recorded','{"login_name":"dual.wrong.event"}','{"login_name":"dual.current@example.test"}'),
 ('ee220000-0000-4000-8000-000000000001','login_renamed','{"login_name":"dual.retired"}','{"login_name":"dual.new.username"}'),
 ('ee220000-0000-4000-8000-000000000001','login_renamed','{"login_name":["dual.malformed"]}','{"login_name":"dual.current@example.test"}'),
 ('ee220000-0000-4000-8000-000000000001','login_renamed','{"login_name":"dual.bad.email"}','{"login_name":"invalid@@example.test"}'),
 (null,'login_renamed','{"login_name":"dual.purged"}','{"login_name":"dual.deleted@example.test"}');

select set_config('request.jwt.claim.sub','ee220000-0000-4000-8000-000000000005',true);
select set_config('request.jwt.claim.role','authenticated',true);
select set_config('request.jwt.claims',jsonb_build_object('sub','ee220000-0000-4000-8000-000000000005',
  'role','authenticated','iat',extract(epoch from clock_timestamp())::bigint,'is_anonymous',false)::text,true);

do $test$
declare v_email text; v_login text;
begin
  v_email:=public.resolve_portal_login_auth_email(' DUAL.CURRENT@EXAMPLE.TEST ');
  if v_email is distinct from 'dual-one@opaque.invalid'
    or public.resolve_portal_login_auth_email(' DUAL.LEGACY ') is distinct from v_email
    or public.resolve_portal_login_auth_email('dual.admin') is distinct from 'dual-three@opaque.invalid' then
    raise exception 'Email, existing employee username and standalone admin login must resolve correctly';
  end if;
  for v_login in select unnest(array['dual.ambiguous','dual.first@example.test','dual.current','dual.unlinked',
    'dual.wrong.event','dual.retired','dual.malformed','dual.bad.email','dual.purged','dual-one@opaque.invalid','unknown','']) loop
    if public.resolve_portal_login_auth_email(v_login) is not null then
      raise exception 'Ineligible, retired, ambiguous or guessed login resolved: %',v_login;
    end if;
  end loop;
  if public.resolve_portal_login_auth_email(null) is not null then raise exception 'Null login resolved'; end if;
  if has_function_privilege('anon','public.resolve_portal_login_auth_email(text)','EXECUTE')
    or has_function_privilege('authenticated','public.resolve_portal_login_auth_email(text)','EXECUTE')
    or not has_function_privilege('service_role','public.resolve_portal_login_auth_email(text)','EXECUTE') then
    raise exception 'Resolver must remain service-only';
  end if;

  update auth.users set encrypted_password='synthetic-reset-password-hash' where id='ee220000-0000-4000-8000-000000000001';
  if (select encrypted_password from auth.users where email=public.resolve_portal_login_auth_email('dual.legacy'))
    is distinct from (select encrypted_password from auth.users where email=public.resolve_portal_login_auth_email('dual.current@example.test')) then
    raise exception 'Both identifiers must use the same password record after reset';
  end if;

  update public.profiles set login_name='dual.next@example.test' where id='ee220000-0000-4000-8000-000000000001';
  if public.resolve_portal_login_auth_email('dual.legacy') is distinct from v_email
    or public.resolve_portal_login_auth_email('dual.next@example.test') is distinct from v_email
    or public.resolve_portal_login_auth_email('dual.current@example.test') is not null then
    raise exception 'Later email changes must preserve the existing username without reviving old emails';
  end if;
  update public.profiles set account_status='disabled',disabled_at=clock_timestamp() where id='ee220000-0000-4000-8000-000000000002';
  if public.resolve_portal_login_auth_email('dual.ambiguous') is not null then raise exception 'Disabled conflicting owner must not remove ambiguity'; end if;

  update public.profiles set login_name='dual.legacy' where id='ee220000-0000-4000-8000-000000000003';
  if public.resolve_portal_login_auth_email('dual.legacy') is distinct from 'dual-three@opaque.invalid' then
    raise exception 'Current canonical login must reserve its identifier';
  end if;
  update public.profiles set account_status='disabled',disabled_at=clock_timestamp() where id='ee220000-0000-4000-8000-000000000003';
  if public.resolve_portal_login_auth_email('dual.legacy') is not null then raise exception 'Disabled canonical owner must not fall through'; end if;
  update public.profiles set login_name='dual.admin',account_status='active',disabled_at=null where id='ee220000-0000-4000-8000-000000000003';

  update public.profiles set account_status='disabled',disabled_at=clock_timestamp() where id='ee220000-0000-4000-8000-000000000001';
  if public.resolve_portal_login_auth_email('dual.legacy') is not null
    or public.resolve_portal_login_auth_email('dual.next@example.test') is not null then raise exception 'Disabled account resolved'; end if;
  update public.profiles set account_status='active',disabled_at=null where id='ee220000-0000-4000-8000-000000000001';
  update public.internal_org_people set is_active=false where id='ee220000-0000-4000-8000-000000000011';
  if public.resolve_portal_login_auth_email('dual.legacy') is not null then raise exception 'Archived employee username resolved'; end if;
  update public.internal_org_people set is_active=true,auth_user_id=null where id='ee220000-0000-4000-8000-000000000011';
  if public.resolve_portal_login_auth_email('dual.legacy') is not null then raise exception 'Unlinked employee username resolved'; end if;
  update public.internal_org_people set auth_user_id='ee220000-0000-4000-8000-000000000001' where id='ee220000-0000-4000-8000-000000000011';
  update public.profiles set login_name=null where id='ee220000-0000-4000-8000-000000000001';
  if public.resolve_portal_login_auth_email('dual.legacy') is not null then raise exception 'Removed login restored through history'; end if;
  if (select schema_hash from private.confirmed_test_purge_schema where singleton)
    is distinct from private.confirmed_test_purge_schema_hash() then raise exception 'Purge catalog fingerprint was not preserved'; end if;
end;
$test$;

rollback;
