begin;

select pg_advisory_xact_lock(hashtextextended('mam:self-service-leave-notice:20260921170000',0));

create function private.enforce_self_service_leave_notice()
returns trigger language plpgsql security definer set search_path = '' as $$
declare employment text;
begin
  -- Historical imports are not new self-service applications. An authenticated
  -- manager/admin acting for a different owner keeps the existing authorised
  -- submission flow. Service-origin portal submissions (e.g. self-service
  -- integrations) receive the same notice policy as the employee portal.
  if new.record_origin <> 'portal'
    or new.request_type_label not in ('Annual leave','Unpaid leave')
    or ((select auth.uid()) is not null and (select auth.uid()) <> new.user_id) then
    return new;
  end if;

  select detail.employment_type into employment
  from public.internal_org_people person
  left join private.employee_directory_details detail on detail.person_id=person.id
  where person.auth_user_id=new.user_id and person.is_active and person.node_kind='person';

  if employment is distinct from 'abn'
    and new.start_date < (now() at time zone 'Australia/Melbourne')::date + 14 then
    raise exception 'Annual and unpaid leave require at least 14 days’ notice. For leave sooner than this, please speak to your manager, who can log the leave for you.'
      using errcode='22023';
  end if;
  return new;
end;
$$;
revoke all on function private.enforce_self_service_leave_notice() from public,anon,authenticated,service_role;
create trigger leave_requests_enforce_notice_period
before insert on public.leave_requests
for each row execute function private.enforce_self_service_leave_notice();
commit;
