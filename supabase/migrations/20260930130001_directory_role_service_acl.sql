begin;

revoke all on function public.list_employee_directory_roles() from service_role;
revoke all on function public.update_employee_directory_role(uuid,text,text) from service_role;

commit;
