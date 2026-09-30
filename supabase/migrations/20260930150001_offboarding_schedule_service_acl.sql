begin;

revoke all on function public.schedule_employee_offboarding(uuid,bigint,bigint,date,text) from service_role;

commit;
