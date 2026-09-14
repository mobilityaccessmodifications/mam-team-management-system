-- Emulate the current non-anonymous Supabase JWT contract for synthetic psql fixtures.
create or replace function pg_temp.set_test_actor(p_user_id uuid)
returns void
language plpgsql
as $$
declare
  v_org_role text;
begin
  select profile.app_role
  into strict v_org_role
  from public.profiles profile
  where profile.id=p_user_id;

  perform set_config('request.jwt.claim.sub',p_user_id::text,true);
  perform set_config(
    'request.jwt.claims',
    jsonb_build_object(
      'sub',p_user_id::text,
      'iat',extract(epoch from clock_timestamp())::bigint,
      'is_anonymous',false,
      'app_metadata',jsonb_build_object('org_role',v_org_role)
    )::text,
    true
  );
end;
$$;
