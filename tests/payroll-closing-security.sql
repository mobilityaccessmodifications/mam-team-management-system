begin;
\ir payroll-closing-setup.sql
create function pg_temp.reject_closing(p jsonb,code text default '22023') returns void language plpgsql as $$
begin
  begin perform public.reconcile_payroll_closing('synthetic-rejected',p); raise exception 'Invalid closing accepted';
  exception when others then if sqlstate<>code then raise; end if; end;
  assert not exists(select 1 from private.payroll_closing_receipts where owner_key='synthetic-rejected');
end$$;
do $$declare p jsonb:=pg_temp.closing_payload(); x jsonb; before_count integer; begin
  for x in select value from jsonb_array_elements('[null,-1,"NaN","Infinity",100001,1.12345]') loop
    perform pg_temp.reject_closing(jsonb_set(p,'{people,1,annualHours}',x));
  end loop;
  perform pg_temp.reject_closing(p #- '{people,1,personalHours}');
  perform pg_temp.reject_closing(jsonb_set(p,'{people,1,company}','"mam"'));
  perform pg_temp.reject_closing(jsonb_set(p,'{people,1,expectedFingerprint}','"stale"'));
  perform pg_temp.reject_closing(jsonb_set(p,'{people,1,reservations}','[]'));
  perform pg_temp.reject_closing(jsonb_set(p,'{people,1,reservations,0,pendingHours}','0'));
  perform pg_temp.reject_closing(jsonb_set(p,'{people,1,reservations,0,accountedHours}','120'));
  perform pg_temp.reject_closing(jsonb_set(p,'{people,1,reservations,0,requestId}','"96000000-0000-4000-8000-000000000012"'));
  update private.leave_accrual_policies set requires_review=true where person_id='96000000-0000-4000-8000-000000000003';
  perform pg_temp.reject_closing(pg_temp.closing_payload(),'55000');
  update private.leave_accrual_policies set requires_review=false where person_id='96000000-0000-4000-8000-000000000003';
  assert (select count(*) from private.annual_leave_balance_history)=2, 'All four writes roll back when later target fails';
  assert (select count(*) from private.sick_leave_balance_history)=2;
  perform pg_temp.set_test_actor('96000000-0000-4000-8000-000000000002');
  begin perform public.reconcile_payroll_closing('synthetic-no-role',p); raise exception 'Employee accepted'; exception when sqlstate '42501' then null; end;
  perform pg_temp.set_test_actor('96000000-0000-4000-8000-000000000001');
  update private.portal_account_admins set revoked_at=clock_timestamp() where auth_user_id=auth.uid();
  begin perform public.reconcile_payroll_closing('synthetic-revoked',p); raise exception 'Revoked P0 accepted'; exception when sqlstate '42501' then null; end;
  update private.portal_account_admins set revoked_at=null where auth_user_id=auth.uid();
end$$;
set local role authenticated;
select public.reconcile_payroll_closing('synthetic-authenticated',pg_temp.closing_payload());
reset role;
do $$declare sig text; role_name text; begin
  foreach sig in array array['public.reconcile_payroll_closing(text,jsonb)','public.settle_payroll_carryforward(text,jsonb)','public.preview_payroll_closing_reconciliation(uuid)'] loop
    assert has_function_privilege('authenticated',sig,'EXECUTE');
    foreach role_name in array array['anon','service_role'] loop assert not has_function_privilege(role_name,sig,'EXECUTE'); end loop;
    assert not exists(select 1 from pg_proc p, lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a where p.oid=to_regprocedure(sig) and a.grantee=0);
  end loop;
  for sig in select p.oid::regprocedure::text from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='private'
    and (p.proname like 'payroll_closing_%' or p.proname like 'payroll_carryforward_%' or p.proname like 'payroll_request_%' or p.proname='payroll_retained_hours') loop
    foreach role_name in array array['anon','authenticated','service_role'] loop assert not has_function_privilege(role_name,sig,'EXECUTE'); end loop;
    assert not exists(select 1 from pg_proc p, lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a where p.oid=to_regprocedure(sig) and a.grantee=0);
  end loop;
  begin
    update private.employee_sick_leave_balances set hours=999,as_of='2026-09-26' where person_id='96000000-0000-4000-8000-000000000002';
    raise exception 'Import-style writer bypassed carry'; exception when sqlstate '55000' then null; end;
  perform set_config('mam.payroll_closing','true',true);
  begin perform public.set_employee_annual_leave_balance('96000000-0000-4000-8000-000000000002',999,'2026-09-26',false); raise exception 'Forged GUC accepted'; exception when sqlstate '55000' then null; end;
  assert (select count(*) from private.payroll_closing_write_claims)=0;
end$$;
rollback;
