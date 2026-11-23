-- Team leaders see only employees eligible for their own manager review scope.
-- HR and System Admin retain the existing company-wide report.
CREATE OR REPLACE FUNCTION public.get_annual_review_report(p_cycle text DEFAULT NULL::text, p_include_inactive boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_actor record;
  v_cycle text;
  v_as_of_date date;
  v_rows jsonb;
  v_summary jsonb;
  v_years jsonb;
begin
  -- Reuse People Hub's active-account role policy; Managers are restricted to their authorised review candidates; HR retains company-wide visibility.
  select * into v_actor from private.performance_review_actor();
  if v_actor.role is null or v_actor.role not in ('admin', 'system_admin', 'manager') then
    raise exception 'Annual review report access denied.' using errcode = '42501';
  end if;

  v_cycle := coalesce(nullif(btrim(p_cycle), ''),
    to_char(current_timestamp at time zone 'Australia/Melbourne', 'YYYY'));
  if v_cycle !~ '^[0-9]{4}$' or v_cycle::integer not between 2000 and 2100 then
    raise exception 'Invalid review year.' using errcode = '22023';
  end if;
  v_as_of_date := least(
    (current_timestamp at time zone 'Australia/Melbourne')::date,
    make_date(v_cycle::integer, 12, 31)
  );

  with source_rows as (
    select
      person.id as employee_id,
      person.full_name as employee_name,
      person.company_key,
      coalesce(details.team_name, '') as department,
      coalesce(person.position_title, '') as job_title,
      person.is_active,
      person.started_date,
      review.id as review_id,
      review.review_no,
      review.due_date,
      review.self_submitted_at,
      review.manager_completed_at,
      review.finalised_at,
      manager_person.full_name as manager_name,
      trigger_event.at as triggered_at,
      trigger_event.actor_user_id as triggered_by_user_id,
      coalesce(
        nullif(btrim(actor_person.full_name), ''),
        nullif(btrim(actor_profile.full_name), ''),
        nullif(btrim(actor_profile.preferred_name), '')
      ) as triggered_by_name
    from public.internal_org_people person
    left join private.employee_directory_details details on details.person_id = person.id
    left join private.performance_reviews review
      on review.employee_person_id = person.id and review.cycle = v_cycle
    left join public.internal_org_people manager_person on manager_person.id = review.assigned_manager_person_id
    left join lateral (
      select event.at, event.actor_user_id
      from private.performance_review_events event
      where event.review_id = review.id and event.kind = 'start'
      order by event.at, event.id
      limit 1
    ) trigger_event on true
    left join public.profiles actor_profile on actor_profile.id = trigger_event.actor_user_id
    left join public.internal_org_people actor_person
      on actor_person.auth_user_id = trigger_event.actor_user_id
     and actor_person.node_kind = 'person'
    where person.node_kind = 'person'
      and (coalesce(p_include_inactive, false) or person.is_active)
      and (v_actor.role in ('admin','system_admin')
        or (v_actor.role = 'manager'
          and private.performance_review_candidate(person.id, v_actor.person_id)))
  ), report_rows as (
    select s.*,
      case
        when s.review_id is null and s.started_date is not null
          and s.started_date > (v_as_of_date - interval '1 year')::date then 'Not Eligible'
        when s.review_id is null then 'Not Triggered'
        when s.finalised_at is not null then 'Finalised'
        when s.self_submitted_at is not null and s.manager_completed_at is not null
          then 'Awaiting Finalisation'
        when s.self_submitted_at is not null then 'Awaiting Manager'
        when s.manager_completed_at is not null then 'Awaiting Employee'
        else 'Awaiting Both'
      end as status,
      case
        when s.started_date is null then null
        else s.started_date <= (v_as_of_date - interval '1 year')::date
      end as eligible
    from source_rows s
  )
  select
    coalesce(jsonb_agg(
      jsonb_build_object(
        'employeeId', employee_id,
        'employeeName', employee_name,
        'company', case company_key when 'mam' then 'MAM'
                                    when 'equipsy' then 'Equipsy'
                                    else company_key end,
        'department', department,
        'jobTitle', job_title,
        'employeeActive', is_active,
        'employmentStartDate', started_date,
        'eligible', eligible,
        'reviewYear', v_cycle,
        'reviewId', review_id,
        'reviewNo', review_no,
        'managerName', manager_name,
        'reviewTriggered', review_id is not null,
        'triggeredBy', triggered_by_name,
        'triggeredByUserId', triggered_by_user_id,
        'triggeredAt', triggered_at,
        'triggeredDate', (triggered_at at time zone 'Australia/Melbourne')::date,
        'employeeCompleted', self_submitted_at is not null,
        'employeeCompletedAt', self_submitted_at,
        'employeeCompletionDate', (self_submitted_at at time zone 'Australia/Melbourne')::date,
        'managerCompleted', manager_completed_at is not null,
        'managerCompletedAt', manager_completed_at,
        'managerCompletionDate', (manager_completed_at at time zone 'Australia/Melbourne')::date,
        'finalisedAt', finalised_at,
        'dueDate', due_date,
        'status', status
      )
      order by company_key, department, employee_name, employee_id
    ), '[]'::jsonb),
    jsonb_build_object(
      'totalEmployees', count(*),
      'triggered', count(*) filter (where review_id is not null),
      'notTriggered', count(*) filter (where status = 'Not Triggered'),
      'notEligible', count(*) filter (where status = 'Not Eligible'),
      'employeeCompleted', count(*) filter (where self_submitted_at is not null),
      'managerCompleted', count(*) filter (where manager_completed_at is not null),
      'awaitingBoth', count(*) filter (where status = 'Awaiting Both'),
      'awaitingEmployee', count(*) filter (where status = 'Awaiting Employee'),
      'awaitingManager', count(*) filter (where status = 'Awaiting Manager'),
      'awaitingFinalisation', count(*) filter (where status = 'Awaiting Finalisation'),
      'finalised', count(*) filter (where status = 'Finalised')
    )
  into v_rows, v_summary
  from report_rows;

  select coalesce(jsonb_agg(year order by year), '[]'::jsonb) into v_years
  from (
    select distinct cycle as year from private.performance_reviews
    union select to_char(current_timestamp at time zone 'Australia/Melbourne', 'YYYY')
  ) cycles;

  return jsonb_build_object(
    'reviewYear', v_cycle,
    'asOfDate', v_as_of_date,
    'includesInactive', coalesce(p_include_inactive, false),
    'generatedAt', current_timestamp,
    'availableYears', v_years,
    'summary', v_summary,
    'rows', v_rows
  );
end;
$function$;
