begin;

do $$
begin
  if to_regclass('private.analytics_api_keys') is null
    or to_regprocedure('public.validate_analytics_api_key(text)') is null then
    raise exception 'Analytics API key-management migration must be applied first.' using errcode = '55000';
  end if;
end;
$$;

-- The function is callable only by the database service_role, enforced by its
-- EXECUTE grant below. Supabase secret API keys are intentionally not JWTs,
-- so auth.role() can be unavailable even when PostgREST has correctly selected
-- service_role. Relying on the DB role grant preserves the boundary and lets
-- the pre-existing deployment key work until a managed key is created.
create or replace function public.validate_analytics_api_key(p_key_hash text)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_key_id uuid;
begin
  if lower(trim(coalesce(p_key_hash, ''))) !~ '^[a-f0-9]{64}$' then
    return false;
  end if;

  select id into v_key_id
  from private.analytics_api_keys
  where key_hash = lower(trim(p_key_hash)) and revoked_at is null;

  if v_key_id is not null then
    update private.analytics_api_keys
    set last_used_at = clock_timestamp()
    where id = v_key_id
      and (last_used_at is null or last_used_at < clock_timestamp() - interval '1 hour');
    return true;
  end if;

  if exists (select 1 from private.analytics_api_keys) then
    return false;
  end if;

  return null;
end;
$$;

revoke all on function public.validate_analytics_api_key(text) from public, anon, authenticated;
grant execute on function public.validate_analytics_api_key(text) to service_role;

commit;
