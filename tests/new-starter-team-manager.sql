begin;

do $test$
begin
  if to_regclass('private.employee_team_manager_defaults') is null then
    raise exception 'A company-scoped authoritative Team Manager configuration is required.';
  end if;
  if not exists (select 1 from pg_class where oid='private.employee_team_manager_defaults'::regclass and relrowsecurity and relforcerowsecurity) then
    raise exception 'Team Manager configuration must be RLS protected.';
  end if;
  if has_table_privilege('authenticated','private.employee_team_manager_defaults','SELECT,INSERT,UPDATE,DELETE')
    or has_table_privilege('service_role','private.employee_team_manager_defaults','SELECT,INSERT,UPDATE,DELETE') then
    raise exception 'Team Manager configuration is not a directly writable or readable role surface.';
  end if;
end;
$test$;

rollback;
