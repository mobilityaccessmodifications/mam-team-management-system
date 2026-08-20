begin;

-- The public organisation projection deliberately withholds employee start
-- dates from general authenticated directory readers. Organisation-chart
-- edits therefore use null as an explicit "not supplied by this surface"
-- value. Preserve the stored date in that case; HR can still change or clear
-- it through the dedicated employee-directory RPC.
create or replace function public.update_internal_org_node(
  p_node_id uuid,
  p_company_key text,
  p_node_kind text,
  p_position_title text,
  p_full_name text default null,
  p_parent_id uuid default null,
  p_started_date date default null,
  p_sort_order integer default 0,
  p_is_active boolean default true,
  p_expected_version bigint default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_node public.internal_org_people%rowtype;
  v_updated_node public.internal_org_people%rowtype;
  v_node_kind text := lower(btrim(p_node_kind));
  v_company_key text := lower(btrim(p_company_key));
  v_full_name text := case
    when lower(btrim(p_node_kind)) = 'person' then nullif(btrim(p_full_name), '')
    else null
  end;
begin
  if not private.is_internal_org_hr() then
    if not private.is_portal_account_admin() then
      raise exception 'Only an authorized HR user can edit the organisation tree.'
        using errcode = '42501';
    end if;
  end if;

  if p_expected_version is null then
    raise exception 'The expected org node version is required.' using errcode = '22004';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('internal_org_people_hierarchy', 0));

  select node.*
  into v_node
  from public.internal_org_people node
  where node.id = p_node_id
  for update;

  if not found then
    raise exception 'The org node does not exist.' using errcode = '23503';
  end if;

  if v_node.version <> p_expected_version then
    raise exception 'This org node changed since it was opened. Refresh and try again.'
      using errcode = '40001';
  end if;

  if exists (
    select 1
    from private.employee_directory_details detail
    where detail.person_id = p_node_id
  ) and (
    v_node.full_name is distinct from v_full_name
    or v_node.node_kind is distinct from v_node_kind
  ) then
    raise exception 'Use the HR employee directory to change a detailed employee name or type.'
      using errcode = '42501';
  end if;

  if v_node_kind <> 'person' and v_node.auth_user_id is not null then
    raise exception 'Disable or relink the portal account before changing this person node.'
      using errcode = '23503';
  end if;

  if p_is_active is false
    and v_node.auth_user_id is not null
    and exists (
      select 1
      from public.profiles profile
      where profile.id = v_node.auth_user_id
        and profile.account_status = 'active'
    ) then
    raise exception 'Disable the portal account before archiving this person.'
      using errcode = '23503';
  end if;

  update public.internal_org_people node
  set company_key = v_company_key,
      node_kind = v_node_kind,
      position_title = btrim(p_position_title),
      full_name = v_full_name,
      parent_id = p_parent_id,
      started_date = case
        when v_node_kind = 'person' then coalesce(p_started_date, v_node.started_date)
        else null
      end,
      sort_order = p_sort_order,
      is_active = p_is_active,
      updated_by = v_actor
  where node.id = p_node_id
  returning * into v_updated_node;

  if v_node.auth_user_id is not null
    and v_node.full_name is distinct from v_full_name then
    update public.profiles profile
    set full_name = v_full_name,
        updated_at = clock_timestamp()
    where profile.id = v_node.auth_user_id;
  end if;

  return v_updated_node.id;
end;
$$;

comment on function public.update_internal_org_node(
  uuid, text, text, text, text, uuid, date, integer, boolean, bigint
) is
  'Updates a public organisation node; a null start date preserves the HR-owned stored value for person nodes.';

revoke all on function public.update_internal_org_node(
  uuid, text, text, text, text, uuid, date, integer, boolean, bigint
) from public, anon, authenticated;

grant execute on function public.update_internal_org_node(
  uuid, text, text, text, text, uuid, date, integer, boolean, bigint
) to authenticated;

commit;
