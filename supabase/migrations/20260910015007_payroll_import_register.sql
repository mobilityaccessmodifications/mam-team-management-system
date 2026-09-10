begin;

-- Preserve every supplied payroll row without manufacturing employee identities.
-- Linked snapshots and history retain the import's provenance instead of
-- attributing a management-API import to an impersonated portal account.
create table private.payroll_balance_imports (
  id uuid primary key default gen_random_uuid(),
  company_key text not null check(company_key in ('mam','equipsy')),
  employee_name text not null check(length(employee_name) between 1 and 200),
  annual_hours numeric(12,4) not null check(annual_hours between -10000 and 100000),
  sick_hours numeric(12,4) not null check(sick_hours between -10000 and 100000),
  as_of date not null,
  source_file text not null,
  source_sha256 text not null check(source_sha256 ~ '^[0-9a-f]{64}$'),
  person_id uuid references public.internal_org_people(id),
  match_status text not null check(match_status in ('linked','inactive','unmatched','company_mismatch')),
  imported_at timestamptz not null default now(),
  check((match_status in ('linked','inactive')) = (person_id is not null)),
  unique(source_sha256,company_key,employee_name,as_of)
);
alter table private.payroll_balance_imports enable row level security;
revoke all on private.payroll_balance_imports from public,anon,authenticated,service_role;

alter table private.employee_annual_leave_balances alter column updated_by drop not null,
  add column source_import_id uuid references private.payroll_balance_imports(id),
  add constraint annual_balance_actor_or_import check(updated_by is not null or source_import_id is not null);
alter table private.employee_sick_leave_balances alter column updated_by drop not null,
  add column source_import_id uuid references private.payroll_balance_imports(id),
  add constraint sick_balance_actor_or_import check(updated_by is not null or source_import_id is not null);
alter table private.annual_leave_balance_history alter column actor_user_id drop not null,
  add column source_import_id uuid references private.payroll_balance_imports(id),
  add constraint annual_history_actor_or_import check(actor_user_id is not null or source_import_id is not null);
alter table private.sick_leave_balance_history alter column actor_user_id drop not null,
  add column source_import_id uuid references private.payroll_balance_imports(id),
  add constraint sick_history_actor_or_import check(actor_user_id is not null or source_import_id is not null);
create unique index annual_history_import_once on private.annual_leave_balance_history(source_import_id) where source_import_id is not null;
create unique index sick_history_import_once on private.sick_leave_balance_history(source_import_id) where source_import_id is not null;

create function private.payroll_balance_import_projection()
returns jsonb language sql stable security definer set search_path='' as $$
  select case when private.is_system_portal_account_admin() then (
    select coalesce(jsonb_agg(jsonb_build_object(
      'id',r.id,'employeeName',r.employee_name,'company',r.company_key,
      'annualHours',r.annual_hours,'sickHours',r.sick_hours,'asOf',r.as_of,
      'status',r.match_status,'linkedName',p.full_name,'sourceFile',r.source_file
    ) order by r.as_of desc,r.company_key,lower(r.employee_name)),'[]'::jsonb)
    from private.payroll_balance_imports r left join public.internal_org_people p on p.id=r.person_id
  ) else '[]'::jsonb end;
$$;
revoke all on function private.payroll_balance_import_projection() from public,anon,authenticated,service_role;

do $$declare definition text; original text; signature text; begin
  original:=pg_get_functiondef('public.get_leave_priority_workspace(uuid)'::regprocedure);
  definition:=replace(original,'''canManageBalances'', private.is_system_portal_account_admin(),',
    '''payrollImports'', case when scope_admin then private.payroll_balance_import_projection() else ''[]''::jsonb end,' || chr(10) ||
    '''canManageBalances'', private.is_system_portal_account_admin(),');
  if definition=original then raise exception 'Leave projection differs from reviewed baseline'; end if;
  execute definition;
  foreach signature in array array['public.set_employee_annual_leave_balance(uuid,numeric,date,boolean)','public.set_employee_sick_leave_balance(uuid,numeric,date)'] loop
    original:=pg_get_functiondef(signature::regprocedure);
    definition:=replace(original,'updated_at=now();','updated_at=now(),source_import_id=null;');
    if definition=original then raise exception 'Balance setter differs from reviewed baseline: %',signature; end if;
    execute definition;
  end loop;
end$$;

commit;
