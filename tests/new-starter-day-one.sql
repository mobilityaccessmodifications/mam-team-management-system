begin;

do $$
declare
  manager_id uuid := '81000000-0000-4000-8000-000000000001';
  employee_id uuid := '81000000-0000-4000-8000-000000000002';
  missing_email_id uuid := '81000000-0000-4000-8000-000000000003';
  start_date date := timezone('Australia/Melbourne',clock_timestamp())::date + 40;
  reminder record;
  claim record;
  prepared record;
begin
  insert into public.internal_org_people(
    id,node_kind,company_key,full_name,position_title,started_date,is_active
  ) values (
    manager_id,'person','mam','Morgan Manager','Team Leader',date '2020-01-01',true
  );
  insert into private.employee_directory_details(person_id,first_name,work_email)
    values(manager_id,'Morgan','manager@example.test');

  insert into public.internal_org_people(
    id,node_kind,company_key,full_name,position_title,parent_id,started_date,is_active
  ) values (
    employee_id,'person','mam','Taylor Starter','Coordinator',manager_id,start_date,true
  );
  insert into private.employee_directory_details(person_id,first_name,work_email,personal_email)
    values(employee_id,'Taylor','work@example.test','personal@example.test');

  select * into reminder
  from private.employee_new_starter_day_one_reminders
  where person_id=employee_id and status='scheduled';
  if not found then raise exception 'Future starter was not scheduled'; end if;
  if reminder.notify_date is distinct from private.victorian_business_days_before(start_date,1) then
    raise exception 'Day 1 notice date is not one Victorian business day before commencement';
  end if;

  insert into public.internal_org_people(
    id,node_kind,company_key,full_name,position_title,parent_id,started_date,is_active
  ) values (
    missing_email_id,'person','equipsy','Casey Missing','Installer',manager_id,start_date + 1,true
  );
  insert into private.employee_directory_details(person_id,first_name)
    values(missing_email_id,'Casey');
  if not exists (
    select 1 from private.employee_new_starter_day_one_reminders
    where person_id=missing_email_id and status='needs_review' and review_reason='missing_employee_email'
  ) then raise exception 'Missing employee email was not surfaced for review'; end if;
  update private.employee_directory_details set personal_email='casey@example.test' where person_id=missing_email_id;
  if not exists (
    select 1 from private.employee_new_starter_day_one_reminders
    where person_id=missing_email_id and status='scheduled'
  ) then raise exception 'Completing an employee email did not recover the schedule'; end if;

  update private.employee_new_starter_day_one_reminders
    set notify_date=timezone('Australia/Melbourne',clock_timestamp())::date,
      next_attempt_at=clock_timestamp()-interval '1 minute'
    where id=reminder.id;
  select * into claim from public.claim_due_new_starter_day_one_reminders(1);
  if not found or claim.reminder_id is distinct from reminder.id or claim.claim_token is null then
    raise exception 'Due reminder could not be claimed';
  end if;
  select * into prepared from public.prepare_new_starter_day_one_delivery(claim.reminder_id,claim.claim_token);
  if not found or prepared.employee_work_email <> 'work@example.test'
    or prepared.employee_personal_email <> 'personal@example.test'
    or prepared.manager_email <> 'manager@example.test'
    or prepared.employee_first_name <> 'Taylor' or prepared.manager_first_name <> 'Morgan' then
    raise exception 'Claimed reminder did not resolve both employee emails and current manager';
  end if;
  if not public.complete_new_starter_day_one_delivery(claim.reminder_id,claim.claim_token) then
    raise exception 'Claimed reminder could not be completed';
  end if;
  if not exists (
    select 1 from private.employee_new_starter_day_one_reminders
    where id=reminder.id and status='delivered' and delivered_at is not null
  ) then raise exception 'Completed reminder did not retain delivery state'; end if;

  if not private.notification_event_key_valid('new-starter:' || reminder.id || ':day-one:test')
    or not private.notification_event_key_valid('new-starter:' || reminder.id || ':day-one:live')
    or private.notification_event_key_valid('new-starter:' || reminder.id || ':day-one:preview') then
    raise exception 'New starter delivery receipt key contract is invalid';
  end if;
end;
$$;

do $$
begin
  if has_table_privilege('authenticated','private.employee_new_starter_day_one_reminders','SELECT')
    or has_table_privilege('service_role','private.employee_new_starter_day_one_reminders','SELECT')
    or has_function_privilege('authenticated','public.claim_due_new_starter_day_one_reminders(integer)','EXECUTE')
    or not has_function_privilege('service_role','public.claim_due_new_starter_day_one_reminders(integer)','EXECUTE') then
    raise exception 'New starter reminder ACL boundary is invalid';
  end if;
end;
$$;

rollback;
