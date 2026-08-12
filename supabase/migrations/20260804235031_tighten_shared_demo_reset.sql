begin;

create index if not exists demo_profiles_manager_profile_idx
  on public.demo_profiles (manager_profile_id);

revoke all on function public.reset_demo_leave_requests() from public, anon, authenticated;
drop function public.reset_demo_leave_requests();

create function public.reset_demo_leave_requests(p_confirm_synthetic boolean)
returns setof public.demo_leave_requests
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_confirm_synthetic is distinct from true then
    raise exception 'Confirm that only synthetic demo data will be reset.';
  end if;

  delete from public.demo_leave_requests;
  perform setval('public.demo_leave_request_number_seq', 2500, false);
  perform private.seed_demo_leave_requests();

  return query
  select request.*
  from public.demo_leave_requests request
  order by request.submitted_at desc, request.id desc;
end;
$$;

revoke all on function public.reset_demo_leave_requests(boolean) from public;
grant execute on function public.reset_demo_leave_requests(boolean) to anon, authenticated;

comment on function public.reset_demo_leave_requests(boolean) is
  'Demo-only reset for the fixed synthetic leave dataset. Must not be reused for staff data.';

commit;
