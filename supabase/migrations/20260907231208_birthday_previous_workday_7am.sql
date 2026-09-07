begin;

-- Weekdays are Monday-Friday, matching the existing business-day policy.
create function private.birthday_reminder_date(p_birthday date)
returns date language sql immutable strict set search_path='' as $$
  select p_birthday - case extract(isodow from p_birthday)::integer
    when 1 then 3 when 7 then 2 else 1 end;
$$;
revoke all on function private.birthday_reminder_date(date) from public,anon,authenticated;

create or replace function public.claim_leave_priority_reminders(p_limit integer default 100)
returns table(delivery_id uuid,claim_token uuid,event text,source_id uuid,employee_name text,
  manager_email text,company text,leave_type text,start_date date,end_date date,status text)
language plpgsql security definer set search_path='' as $$
declare
  local_now timestamp := now() at time zone 'Australia/Melbourne';
  today date := local_now::date;
  local_hour integer := extract(hour from local_now);
begin
  if extract(isodow from today)>5 or local_hour<7 or local_hour>=17 then return; end if;
  -- The 07:00 run is birthdays only. Leave reminders still start at 08:00.
  insert into private.leave_priority_reminder_deliveries(kind,source_id,notify_date)
  select 'leave-reminder',r.id,today from public.leave_requests r
  where local_hour>=8 and r.status='submitted' and r.record_origin='portal' and r.approval_required
    and exists(select 1 from public.internal_org_people p where p.id=r.employee_person_id and p.is_active)
    and (select count(*) from generate_series((r.submitted_at at time zone 'Australia/Melbourne')::date+1,today,interval '1 day') d
      where extract(isodow from d) between 1 and 5)>=2
  on conflict do nothing;
  insert into private.leave_priority_reminder_deliveries(kind,source_id,notify_date)
  select 'team-birthday',p.id,today
  from public.internal_org_people p join private.employee_directory_details d on d.person_id=p.id
  where p.is_active and p.node_kind='person' and d.date_of_birth is not null
    and exists(select 1 from generate_series(today+1,today+3,interval '1 day') occurrence
      where private.birthday_reminder_date(occurrence::date)=today
        and extract(month from occurrence)=extract(month from d.date_of_birth)
        and extract(day from occurrence)=extract(day from d.date_of_birth))
  on conflict do nothing;
  return query
  with candidates as (
    select q.id from private.leave_priority_reminder_deliveries q
    where q.notify_date=today and q.sent_at is null and (q.claimed_until is null or q.claimed_until<now())
      and (q.kind='team-birthday' or local_hour>=8)
      -- Old-schedule rows must not consume delivery leases or batch capacity.
      and (q.kind<>'team-birthday' or exists (
        select 1 from public.internal_org_people person
        join private.employee_directory_details detail on detail.person_id=person.id
        cross join generate_series(today+1,today+3,interval '1 day') occurrence
        where person.id=q.source_id and person.is_active
          and private.birthday_reminder_date(occurrence::date)=today
          and extract(month from occurrence)=extract(month from detail.date_of_birth)
          and extract(day from occurrence)=extract(day from detail.date_of_birth)
      ))
    order by q.id for update skip locked limit greatest(1,least(coalesce(p_limit,100),100))
  ), claimed as (
    update private.leave_priority_reminder_deliveries q set claim_token=gen_random_uuid(),claimed_until=now()+interval '25 minutes'
    from candidates c where c.id=q.id returning q.*
  )
  select q.id,q.claim_token,q.kind,q.source_id,p.full_name,
    case when q.kind='leave-reminder' then lm.manager_email else md.work_email end,
    p.company_key,coalesce(r.request_type_label,'Birthday'),
    case when q.kind='leave-reminder' then r.start_date else birthday.occurrence end,
    case when q.kind='leave-reminder' then r.end_date else birthday.occurrence end,
    case when a.request_id is not null then 'Approved – pending leave balance' else 'Pending' end
  from claimed q
  left join public.leave_requests r on q.kind='leave-reminder' and r.id=q.source_id
  join public.internal_org_people p on p.id=case when q.kind='team-birthday' then q.source_id else r.employee_person_id end and p.is_active
  left join private.leave_balance_approvals a on a.request_id=r.id
  left join lateral public.resolve_leave_notification_manager(r.id) lm on q.kind='leave-reminder'
  left join lateral private.resolve_internal_org_employee_manager(p.id) bm on q.kind='team-birthday'
  left join private.employee_directory_details md on md.person_id=bm.manager_id
  left join private.employee_directory_details pd on pd.person_id=p.id
  left join lateral (
    select occurrence::date from generate_series(today+1,today+3,interval '1 day') occurrence
    where private.birthday_reminder_date(occurrence::date)=today
      and extract(month from occurrence)=extract(month from pd.date_of_birth)
      and extract(day from occurrence)=extract(day from pd.date_of_birth) limit 1
  ) birthday on q.kind='team-birthday'
  where (q.kind='team-birthday' and birthday.occurrence is not null) or r.status='submitted';
end;
$$;
revoke all on function public.claim_leave_priority_reminders(integer) from public,anon,authenticated;
grant execute on function public.claim_leave_priority_reminders(integer) to service_role;

commit;
