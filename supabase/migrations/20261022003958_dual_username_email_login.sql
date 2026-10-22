begin;
set local search_path = '';

lock table private.confirmed_test_identity_purges, private.confirmed_test_purge_schema
  in share row exclusive mode nowait;

do $guard$
declare v_function record;
begin
  if (select count(*) from private.confirmed_test_purge_schema) <> 1
    or private.confirmed_test_purge_schema_hash() is distinct from
      (select schema_hash from private.confirmed_test_purge_schema where singleton) then
    raise exception 'Dual login requires the reviewed predecessor catalog.' using errcode='55000';
  end if;
  select p.* into v_function from pg_proc p
    where p.oid='public.resolve_portal_login_auth_email(text)'::regprocedure;
  if encode(extensions.digest(v_function.prosrc,'sha256'),'hex') <> '618146e7e80b0a17e3d826484b17e76417239698ee2e2f1415a721d098000b3a'
    or not v_function.prosecdef or v_function.provolatile <> 's'
    or v_function.proconfig is distinct from array['search_path=""']
    or v_function.proowner <> (select proowner from pg_proc where oid='private.confirmed_test_purge_schema_hash()'::regprocedure)
    or exists(select 1 from aclexplode(coalesce(v_function.proacl,acldefault('f',v_function.proowner))) a
      where a.grantee not in (v_function.proowner,'service_role'::regrole)
        or a.privilege_type <> 'EXECUTE' or (a.grantee <> v_function.proowner and a.is_grantable))
    or not has_function_privilege('service_role',v_function.oid,'EXECUTE') then
    raise exception 'Dual login resolver predecessor differs.' using errcode='55000';
  end if;
  perform set_config('mam.dual_login.previous_definition',pg_get_functiondef(v_function.oid),true);
  perform set_config('mam.dual_login.previous_hash',private.confirmed_test_purge_schema_hash(),true);
end;
$guard$;

create or replace function public.resolve_portal_login_auth_email(p_login_name text)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_login text := lower(btrim(p_login_name));
  v_status text;
  v_email text;
  v_owners bigint;
  v_user_id uuid;
begin
  if not private.is_valid_portal_login(v_login) then return null; end if;

  select profile.account_status,member.email into v_status,v_email
  from public.profiles profile
  left join auth.users member on member.id=profile.id
  where profile.login_name=v_login;
  if found then
    if v_status='active' then return v_email; end if;
    return null;
  end if;

  if v_login !~ '^[a-z0-9][a-z0-9._-]{2,63}$' then return null; end if;

  select count(distinct event.target_user_id),
    (array_agg(distinct event.target_user_id))[1]
  into v_owners,v_user_id
  from private.portal_account_admin_events event
  where event.event_type='login_renamed' and event.target_user_id is not null
    and jsonb_typeof(event.before_state->'login_name')='string'
    and jsonb_typeof(event.after_state->'login_name')='string'
    and event.before_state->>'login_name'=v_login
    and position('@' in event.after_state->>'login_name')>0
    and private.is_valid_portal_login(event.after_state->>'login_name');
  if v_owners<>1 then return null; end if;

  select member.email into v_email
  from public.profiles profile
  join auth.users member on member.id=profile.id
  join public.internal_org_people person on person.auth_user_id=profile.id
  where profile.id=v_user_id and profile.account_status='active'
    and position('@' in profile.login_name)>0
    and person.node_kind='person' and person.is_active;
  return v_email;
end;
$function$;

revoke all on function public.resolve_portal_login_auth_email(text) from public,anon,authenticated;
grant execute on function public.resolve_portal_login_auth_email(text) to service_role;

do $guard$
declare v_query text; v_normalized text; v_previous text:=current_setting('mam.dual_login.previous_hash');
begin
  select prosrc into v_query from pg_proc where oid='private.confirmed_test_purge_schema_hash()'::regprocedure;
  if encode(extensions.digest(v_query,'sha256'),'hex') <> 'c142665fb247c8761de408ce241e2f97aabe719c5d0801a5c53905892dd3de16' then
    raise exception 'Dual login catalog hash implementation differs.' using errcode='55000';
  end if;
  v_query:=replace(v_query,'pg_get_functiondef(p.oid)',
    'case when $1 ? p.oid::text then $1->>p.oid::text else pg_get_functiondef(p.oid) end');
  execute v_query into v_normalized using jsonb_build_object(
    'public.resolve_portal_login_auth_email(text)'::regprocedure::oid::text,
    current_setting('mam.dual_login.previous_definition'));
  if v_normalized is distinct from v_previous then
    raise exception 'Unreviewed catalog change during dual login migration.' using errcode='55000';
  end if;
  update private.confirmed_test_purge_schema set schema_hash=private.confirmed_test_purge_schema_hash()
    where singleton and schema_hash=v_previous;
  if not found then raise exception 'Dual login catalog predecessor changed.' using errcode='40001'; end if;
end;
$guard$;

commit;
