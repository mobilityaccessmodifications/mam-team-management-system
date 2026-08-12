begin;

create or replace function public.reset_demo_leave_requests(p_confirm_synthetic boolean)
returns setof public.demo_leave_requests
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_confirm_synthetic is distinct from true then
    raise exception 'Confirm that only synthetic demo data will be reset.';
  end if;

  delete from public.demo_leave_requests
  where is_synthetic = true;

  perform setval('public.demo_leave_request_number_seq', 2500, false);
  perform private.seed_demo_leave_requests();

  return query
  select request.*
  from public.demo_leave_requests request
  where request.is_synthetic = true
  order by request.submitted_at desc, request.id desc;
end;
$$;

commit;
