begin;
set local search_path='';
set local lock_timeout='5s';
set local statement_timeout='30s';
-- Do not alter the snapshot or recipients of an in-flight lifecycle email.
do $guard$
begin
  if exists(select 1 from private.employee_lifecycle_mail_outbox where state='claimed') then
    raise exception 'Lifecycle delivery in progress: publish only after workers drain.' using errcode='55000';
  end if;
end $guard$;
create or replace function private.employee_lifecycle_mail_payload(p_delivery private.employee_lifecycle_mail_outbox)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare subject public.internal_org_people%rowtype; detail private.employee_directory_details%rowtype;
  manager private.employee_lifecycle_mail_recipients%rowtype; target text; snapshot jsonb;
begin
  select * into subject from public.internal_org_people where id=p_delivery.person_id and node_kind='person';
  select * into detail from private.employee_directory_details where person_id=p_delivery.person_id;
  if subject.id is null or detail.person_id is null or nullif(btrim(subject.full_name),'') is null
    or subject.company_key not in ('mam','equipsy') or subject.company_key is null
    or (p_delivery.event='onboarding' and (not subject.is_active or subject.started_date is null or not isfinite(subject.started_date)))
    or (p_delivery.event='offboarding' and (detail.scheduled_employment_end_date is distinct from p_delivery.end_date
      or (subject.is_active and not exists(select 1 from private.scheduled_employee_offboarding s where s.person_id=subject.id and s.end_date=p_delivery.end_date)))) then return null; end if;
  if (select count(*) from private.employee_lifecycle_mail_recipients)<>9
    or (select count(*) from private.employee_lifecycle_mail_recipients where team_name is null)<>5
    or exists(select 1 from private.employee_lifecycle_mail_recipients c where c.team_name is null and not private.employee_lifecycle_mail_recipient_valid(c)) then return null; end if;
  with recursive ancestors as (
    select p.id,p.parent_id,1 depth,array[subject.id,p.id] path from public.internal_org_people p where p.id=subject.parent_id and p.id<>subject.id
    union all select p.id,p.parent_id,a.depth+1,a.path||p.id from ancestors a join public.internal_org_people p on p.id=a.parent_id
    where not p.id=any(a.path) and a.depth<100)
  select c.* into manager from ancestors a join private.employee_lifecycle_mail_recipients c on c.person_id=a.id
    where c.team_name is not null and c.company_key=subject.company_key and c.person_id<>subject.id order by a.depth,c.slot limit 1;
  if manager.slot is null and detail.team_name in ('Minor','Major','Warehouse','Equipsy') then
    select c.* into manager from private.employee_lifecycle_mail_recipients c
    where c.company_key=subject.company_key and c.team_name=detail.team_name and c.person_id<>subject.id;
  end if;
  if manager.slot is not null and not private.employee_lifecycle_mail_recipient_valid(manager) then return null; end if;
  select string_agg(address,',' order by address collate "C") into target from (
    select c.approved_email address from private.employee_lifecycle_mail_recipients c where c.team_name is null
    union select manager.approved_email where manager.slot is not null
    union select 'penny@mobilityaccess.com.au'
    union select 'steven@mobilityaccess.com.au') addresses;
  snapshot:=jsonb_build_object('name',subject.full_name,'company',case subject.company_key when 'mam' then 'MAM' else 'Equipsy' end,
    'role',coalesce(subject.position_title,''),'department',coalesce(detail.team_name,''),'location',coalesce(detail.location,''),
    'employmentType',coalesce(detail.employment_type,''),'startDate',to_char(subject.started_date,'YYYY-MM-DD'),
    'personalEmail',coalesce(detail.personal_email,''),'timesheetEntries',coalesce(detail.timesheet_entries,''),
    'workingWeekdays',coalesce(to_jsonb(detail.working_weekdays),'[]'::jsonb),
    'workingDayTimes',coalesce(detail.working_day_times,'[]'::jsonb),
    'teamLeader',coalesce((select p.full_name from public.internal_org_people p where p.id=manager.person_id),''),
    'laptopCode',coalesce(detail.laptop_id,''),
    'prestartDeadline',(select to_char(max(workday.day::date),'YYYY-MM-DD') from generate_series(subject.started_date - interval '21 days',subject.started_date - interval '1 day',interval '1 day') as workday(day) where extract(isodow from workday.day) between 1 and 5 and not exists(select 1 from private.victorian_public_holidays h where h.holiday_date=workday.day::date)),
    'endDate',case when p_delivery.event='offboarding' then to_char(p_delivery.end_date,'YYYY-MM-DD') else null end);
  return jsonb_build_object('event',p_delivery.event,'eventKey','employee-lifecycle:'||p_delivery.delivery_id::text||':'||p_delivery.event,
    'personId',subject.id,'recipient',target,'employee',snapshot);
end $$;


commit;
