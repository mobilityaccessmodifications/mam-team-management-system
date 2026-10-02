begin;
\ir payroll-closing-setup.sql
update public.leave_requests set employment_type_snapshot=null where id='96000000-0000-4000-8000-000000000012';
select public.reconcile_payroll_closing('synthetic-closing-one',pg_temp.closing_payload());
update private.employee_directory_details set employment_type='part_time' where person_id='96000000-0000-4000-8000-000000000002';
do $$begin
  assert private.approved_leave_hours_after('96000000-0000-4000-8000-000000000002',array['Annual leave'],'2026-09-24') is null, 'Changed legacy duration basis must be unknown, never recomputed silently';
  assert private.project_annual_leave_balance('96000000-0000-4000-8000-000000000002','2026-09-25')->>'status'='unavailable';
end$$;
rollback;
