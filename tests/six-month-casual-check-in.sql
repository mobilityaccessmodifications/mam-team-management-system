\set ON_ERROR_STOP on

begin;

create function pg_temp.assert(p_condition boolean, p_message text)
returns void language plpgsql as $$
begin
  if not coalesce(p_condition, false) then raise exception 'Assertion failed: %', p_message; end if;
end;
$$;

select pg_temp.assert(
  not (select enabled from private.people_hub_release_flags where feature = 'six_month_casual_check_in')
  and not exists (
    select 1 from private.employee_check_in_schedule(date '2026-03-01')
    where milestone = '6_month_casual'
  ),
  'the separate Casual schedule stays hidden until its release gate is enabled'
);

insert into private.employee_directory_details (
  person_id, first_name, last_name, work_email, team_name, employment_type
) values
  ('75000000-0000-4000-8000-000000000001', 'Outcome', 'Manager', 'outcome.manager@example.test', 'Major', 'full_time'),
  ('75000000-0000-4000-8000-000000000002', 'Outcome', 'Employee', 'outcome.employee@example.test', 'Major', 'full_time');

update private.employee_directory_details
set employment_type = 'casual'
where person_id = '75000000-0000-4000-8000-000000000002';

select pg_temp.assert(
  not exists (
    select 1 from private.employee_check_in_reminders
    where person_id = '75000000-0000-4000-8000-000000000002'
      and milestone = '6_month_casual'
      and delivery_status not in ('superseded', 'cancelled')
  )
  and not exists (
    select 1 from private.employee_check_in_reminders
    where person_id = '75000000-0000-4000-8000-000000000002'
      and milestone = '6_month'
      and delivery_status in ('scheduled', 'claimed', 'needs_review')
  ),
  'employment-type changes sync the person away from the Permanent/Fixed-Term reminder without creating a Casual reminder before release'
);

select private.activate_six_month_casual_check_in();

select pg_temp.assert(
  (select due_date = date '2026-09-01' and notify_date = date '2026-08-25'
   from private.employee_check_in_schedule(date '2026-03-01')
   where milestone = '6_month_casual'),
  'the Casual reminder is due at six calendar months and notified five business days beforehand'
);

select pg_temp.assert(
  (select enabled from private.people_hub_release_flags where feature = 'six_month_casual_check_in'),
  'activation enables the separate Casual release gate'
);

select pg_temp.assert(
  exists (
    select 1 from private.employee_check_in_reminders
    where person_id = '75000000-0000-4000-8000-000000000002'
      and milestone = '6_month_casual'
      and due_date = date '2026-09-01'
      and notify_date = date '2026-08-25'
      and delivery_status = 'needs_review'
      and needs_review_reason = 'historic_cutover'
  ),
  'activation enrolls the Casual milestone as historic review work'
);

select pg_temp.assert(
  not exists (
    select 1 from private.employee_check_in_reminders
    where person_id = '75000000-0000-4000-8000-000000000002'
      and milestone = '6_month'
      and delivery_status in ('scheduled', 'claimed', 'needs_review')
  ),
  'the Casual employee is not also open on the Permanent/Fixed-Term six-month path'
);

select id as casual_reminder_id
from private.employee_check_in_reminders
where person_id = '75000000-0000-4000-8000-000000000002'
  and milestone = '6_month_casual' \gset

set role authenticated;
select set_config('request.jwt.claim.sub', '74000000-0000-4000-8000-000000000001', false);
select set_config('request.jwt.claims', '{"is_anonymous":false}', false);
select public.record_employee_check_in_review(
  :'casual_reminder_id'::uuid,
  'hr_review_required',
  (clock_timestamp() at time zone 'Australia/Melbourne')::date,
  'Discuss future permanent opportunities with People & Culture.',
  null
);
reset role;

create temp table casual_review_notification_claims as
select * from public.claim_due_employee_check_in_review_notifications(25);

select pg_temp.assert(
  exists (
    select 1
    from private.employee_check_in_reviews review
    join private.employee_check_in_review_notifications notification on notification.review_id = review.id
    join casual_review_notification_claims claimed on claimed.notification_id = notification.id
    where review.reminder_id = :'casual_reminder_id'::uuid
      and notification.status = 'claimed'
      and exists (
        select 1
        from public.prepare_employee_check_in_review_notification_delivery(notification.id, claimed.claim_token) prepared
        where prepared.milestone = '6_month_casual'
      )
  ),
  'the Casual review can queue a People & Culture alert through the existing delivery path'
);

select 'Six-month Casual eligibility, scheduling, delivery gate and HR review path passed' as result;

rollback;
