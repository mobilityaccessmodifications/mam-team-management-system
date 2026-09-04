begin;

-- The analytics API is intentionally a narrow, service-role-only projection.
-- It exposes operational facts required for reporting while keeping HR contact
-- data, leave notes/evidence and subscription credentials inside their private
-- boundaries. The application Route Handler is the only public entry point.
do $$
begin
  if to_regclass('public.internal_org_people') is null
    or to_regclass('public.leave_requests') is null
    or to_regclass('public.leave_request_events') is null
    or to_regclass('private.employee_check_in_reminders') is null
    or to_regclass('private.employee_check_in_reminder_events') is null
    or to_regclass('private.it_assets') is null
    or to_regclass('private.it_asset_custody_history') is null
    or to_regclass('private.subscription_register') is null
    or to_regclass('private.subscription_memberships') is null
    or to_regclass('private.subscription_audit_events') is null then
    raise exception 'Analytics API prerequisites are missing.' using errcode = '55000';
  end if;
end;
$$;

create or replace function public.analytics_dashboard_dataset(
  p_dataset text,
  p_from_date date default null,
  p_to_date date default null,
  p_limit integer default 500,
  p_offset integer default 0
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_dataset text := lower(btrim(coalesce(p_dataset, 'overview')));
  v_from_date date := p_from_date;
  v_to_date date := p_to_date;
  v_limit integer := least(greatest(coalesce(p_limit, 500), 1), 1000);
  v_offset integer := least(greatest(coalesce(p_offset, 0), 0), 1000000);
  v_total bigint := 0;
  v_rows jsonb := '[]'::jsonb;
begin
  if v_dataset not in (
    'overview',
    'employees',
    'leave_requests',
    'leave_events',
    'check_ins',
    'check_in_events',
    'asset_custody',
    'subscriptions',
    'subscription_events'
  ) then
    raise exception 'Choose a valid analytics dataset.' using errcode = '22023';
  end if;

  if v_from_date is not null and v_to_date is not null and v_to_date < v_from_date then
    raise exception 'The analytics end date must be on or after the start date.' using errcode = '22023';
  end if;

  if v_dataset = 'overview' then
    select jsonb_build_object(
      'headcount', jsonb_build_object(
        'active', count(*) filter (where person.node_kind = 'person' and person.is_active),
        'archived', count(*) filter (where person.node_kind = 'person' and not person.is_active),
        'mam_active', count(*) filter (where person.node_kind = 'person' and person.is_active and person.company_key = 'mam'),
        'equipsy_active', count(*) filter (where person.node_kind = 'person' and person.is_active and person.company_key = 'equipsy')
      ),
      'leave', (
        select jsonb_build_object(
          'requests', count(*),
          'submitted', count(*) filter (where request.status = 'submitted'),
          'approved', count(*) filter (where request.status = 'approved'),
          'declined', count(*) filter (where request.status = 'rejected'),
          'cancelled', count(*) filter (where request.status = 'cancelled'),
          'business_days', coalesce(sum(request.business_days), 0),
          'hours', coalesce(sum(request.hours), 0)
        )
        from public.leave_requests request
        where (v_from_date is null or request.end_date >= v_from_date)
          and (v_to_date is null or request.start_date <= v_to_date)
      ),
      'check_ins', (
        select jsonb_build_object(
          'total', count(*),
          'scheduled', count(*) filter (where reminder.delivery_status = 'scheduled'),
          'needs_review', count(*) filter (where reminder.delivery_status = 'needs_review'),
          'completed', count(*) filter (where reminder.delivery_status = 'completed'),
          'delivered', count(*) filter (where reminder.delivery_status = 'delivered')
        )
        from private.employee_check_in_reminders reminder
        where (v_from_date is null or reminder.due_date >= v_from_date)
          and (v_to_date is null or reminder.due_date <= v_to_date)
      ),
      'assets', (
        select jsonb_build_object(
          'total', count(*),
          'assigned', count(*) filter (where asset.asset_status = 'assigned'),
          'available', count(*) filter (where asset.asset_status = 'available'),
          'repair', count(*) filter (where asset.asset_status = 'repair'),
          'retired', count(*) filter (where asset.asset_status = 'retired')
        )
        from private.it_assets asset
      ),
      'subscriptions', (
        select jsonb_build_object(
          'total', count(*),
          'active', count(*) filter (where subscription.subscription_status = 'active'),
          'paused', count(*) filter (where subscription.subscription_status = 'paused'),
          'cancelled', count(*) filter (where subscription.subscription_status = 'cancelled'),
          'monthly_cost_aud', coalesce(sum(
            case subscription.billing_cycle
              when 'monthly' then subscription.amount_cents
              when 'quarterly' then subscription.amount_cents / 3.0
              when 'annual' then subscription.amount_cents / 12.0
              else 0
            end
          ) filter (where subscription.pricing_model = 'paid' and subscription.subscription_status in ('active', 'paused')), 0) / 100.0
        )
        from private.subscription_register subscription
      )
    ) into v_rows
    from public.internal_org_people person;

    return jsonb_build_object(
      'data', v_rows,
      'pagination', jsonb_build_object('total', 1, 'limit', 1, 'offset', 0)
    );
  end if;

  if v_dataset = 'employees' then
    select count(*) into v_total
    from public.internal_org_people person
    where person.node_kind = 'person'
      and (v_from_date is null or person.created_at::date >= v_from_date)
      and (v_to_date is null or person.created_at::date <= v_to_date);

    select coalesce(jsonb_agg(row.payload order by row.created_at, row.person_id), '[]'::jsonb) into v_rows
    from (
      select
        person.created_at,
        person.id as person_id,
        jsonb_build_object(
          'employee_id', person.id,
          'company', person.company_key,
          'position_title', person.position_title,
          'employment_status', case when person.is_active then 'active' else 'archived' end,
          'started_on', person.started_date,
          'record_created_at', person.created_at,
          'record_updated_at', person.updated_at
        ) as payload
      from public.internal_org_people person
      where person.node_kind = 'person'
        and (v_from_date is null or person.created_at::date >= v_from_date)
        and (v_to_date is null or person.created_at::date <= v_to_date)
      order by person.created_at, person.id
      limit v_limit offset v_offset
    ) row;
  elsif v_dataset = 'leave_requests' then
    select count(*) into v_total
    from public.leave_requests request
    where (v_from_date is null or request.end_date >= v_from_date)
      and (v_to_date is null or request.start_date <= v_to_date);

    select coalesce(jsonb_agg(row.payload order by row.start_date, row.request_id), '[]'::jsonb) into v_rows
    from (
      select
        request.start_date,
        request.id as request_id,
        jsonb_build_object(
          'request_id', request.id,
          'employee_id', person.id,
          'company', coalesce(person.company_key, 'unknown'),
          'start_date', request.start_date,
          'end_date', request.end_date,
          'business_days', request.business_days,
          'hours', request.hours,
          'status', request.status,
          'submitted_at', request.submitted_at,
          'decided_at', request.decided_at,
          'created_at', request.created_at,
          'updated_at', request.updated_at
        ) as payload
      from public.leave_requests request
      left join lateral (
        select employee.id, employee.company_key
        from public.internal_org_people employee
        where employee.auth_user_id = request.user_id
          and employee.node_kind = 'person'
        order by employee.is_active desc, employee.updated_at desc, employee.id
        limit 1
      ) person on true
      where (v_from_date is null or request.end_date >= v_from_date)
        and (v_to_date is null or request.start_date <= v_to_date)
      order by request.start_date, request.id
      limit v_limit offset v_offset
    ) row;
  elsif v_dataset = 'leave_events' then
    select count(*) into v_total
    from public.leave_request_events event
    where (v_from_date is null or event.created_at::date >= v_from_date)
      and (v_to_date is null or event.created_at::date <= v_to_date);

    select coalesce(jsonb_agg(row.payload order by row.created_at, row.event_id), '[]'::jsonb) into v_rows
    from (
      select
        event.created_at,
        event.id as event_id,
        jsonb_build_object(
          'event_id', event.id,
          'request_id', event.leave_request_id,
          'event_type', event.event_type,
          'occurred_at', event.created_at
        ) as payload
      from public.leave_request_events event
      where (v_from_date is null or event.created_at::date >= v_from_date)
        and (v_to_date is null or event.created_at::date <= v_to_date)
      order by event.created_at, event.id
      limit v_limit offset v_offset
    ) row;
  elsif v_dataset = 'check_ins' then
    select count(*) into v_total
    from private.employee_check_in_reminders reminder
    where (v_from_date is null or reminder.due_date >= v_from_date)
      and (v_to_date is null or reminder.due_date <= v_to_date);

    select coalesce(jsonb_agg(row.payload order by row.due_date, row.reminder_id), '[]'::jsonb) into v_rows
    from (
      select
        reminder.due_date,
        reminder.id as reminder_id,
        jsonb_build_object(
          'reminder_id', reminder.id,
          'employee_id', reminder.person_id,
          'milestone', reminder.milestone,
          'sequence', reminder.reminder_sequence,
          'due_date', reminder.due_date,
          'notify_date', reminder.notify_date,
          'status', reminder.delivery_status,
          'needs_review_reason', reminder.needs_review_reason,
          'attempt_count', reminder.attempt_count,
          'delivered_at', reminder.delivered_at,
          'completed_at', reminder.completed_at,
          'created_at', reminder.created_at,
          'updated_at', reminder.updated_at
        ) as payload
      from private.employee_check_in_reminders reminder
      where (v_from_date is null or reminder.due_date >= v_from_date)
        and (v_to_date is null or reminder.due_date <= v_to_date)
      order by reminder.due_date, reminder.id
      limit v_limit offset v_offset
    ) row;
  elsif v_dataset = 'check_in_events' then
    select count(*) into v_total
    from private.employee_check_in_reminder_events event
    where (v_from_date is null or event.created_at::date >= v_from_date)
      and (v_to_date is null or event.created_at::date <= v_to_date);

    select coalesce(jsonb_agg(row.payload order by row.created_at, row.event_id), '[]'::jsonb) into v_rows
    from (
      select
        event.created_at,
        event.id as event_id,
        jsonb_build_object(
          'event_id', event.id,
          'reminder_id', event.reminder_id,
          'event_type', event.event_type,
          'error_code', event.error_code,
          'occurred_at', event.created_at
        ) as payload
      from private.employee_check_in_reminder_events event
      where (v_from_date is null or event.created_at::date >= v_from_date)
        and (v_to_date is null or event.created_at::date <= v_to_date)
      order by event.created_at, event.id
      limit v_limit offset v_offset
    ) row;
  elsif v_dataset = 'asset_custody' then
    select count(*) into v_total
    from private.it_asset_custody_history custody
    where (v_from_date is null or coalesce(custody.returned_on, 'infinity'::date) >= v_from_date)
      and (v_to_date is null or custody.assigned_on <= v_to_date);

    select coalesce(jsonb_agg(row.payload order by row.assigned_on, row.custody_id), '[]'::jsonb) into v_rows
    from (
      select
        custody.assigned_on,
        custody.id as custody_id,
        jsonb_build_object(
          'custody_id', custody.id,
          'asset_id', asset.id,
          'asset_code', asset.asset_code,
          'asset_type', asset.asset_type,
          'asset_status', asset.asset_status,
          'employee_id', custody.person_id,
          'assigned_on', custody.assigned_on,
          'returned_on', custody.returned_on,
          'recorded_at', custody.created_at,
          'updated_at', custody.updated_at
        ) as payload
      from private.it_asset_custody_history custody
      join private.it_assets asset on asset.id = custody.asset_id
      where (v_from_date is null or coalesce(custody.returned_on, 'infinity'::date) >= v_from_date)
        and (v_to_date is null or custody.assigned_on <= v_to_date)
      order by custody.assigned_on, custody.id
      limit v_limit offset v_offset
    ) row;
  elsif v_dataset = 'subscriptions' then
    select count(*) into v_total
    from private.subscription_register subscription
    where (v_from_date is null or subscription.created_at::date >= v_from_date)
      and (v_to_date is null or subscription.created_at::date <= v_to_date);

    select coalesce(jsonb_agg(row.payload order by row.created_at, row.subscription_id), '[]'::jsonb) into v_rows
    from (
      select
        subscription.created_at,
        subscription.id as subscription_id,
        jsonb_build_object(
          'subscription_id', subscription.id,
          'subscription_code', subscription.subscription_code,
          'service_name', subscription.service_name,
          'plan_name', subscription.plan_name,
          'status', subscription.subscription_status,
          'pricing_model', subscription.pricing_model,
          'billing_cycle', subscription.billing_cycle,
          'amount_cents', subscription.amount_cents,
          'currency', subscription.currency_code,
          'renewal_date', subscription.renewal_date,
          'next_review_on', subscription.next_review_on,
          'responsible_employee_id', subscription.responsible_person_id,
          'member_count', count(membership.person_id),
          'created_at', subscription.created_at,
          'updated_at', subscription.updated_at
        ) as payload
      from private.subscription_register subscription
      left join private.subscription_memberships membership
        on membership.subscription_id = subscription.id
      where (v_from_date is null or subscription.created_at::date >= v_from_date)
        and (v_to_date is null or subscription.created_at::date <= v_to_date)
      group by subscription.id
      order by subscription.created_at, subscription.id
      limit v_limit offset v_offset
    ) row;
  elsif v_dataset = 'subscription_events' then
    select count(*) into v_total
    from private.subscription_audit_events event
    where (v_from_date is null or event.created_at::date >= v_from_date)
      and (v_to_date is null or event.created_at::date <= v_to_date);

    select coalesce(jsonb_agg(row.payload order by row.created_at, row.event_id), '[]'::jsonb) into v_rows
    from (
      select
        event.created_at,
        event.id as event_id,
        jsonb_build_object(
          'event_id', event.id,
          'subscription_id', event.subscription_id,
          'event_type', event.event_type,
          'changed_fields', event.changed_fields,
          'occurred_at', event.created_at
        ) as payload
      from private.subscription_audit_events event
      where (v_from_date is null or event.created_at::date >= v_from_date)
        and (v_to_date is null or event.created_at::date <= v_to_date)
      order by event.created_at, event.id
      limit v_limit offset v_offset
    ) row;
  end if;

  return jsonb_build_object(
    'data', v_rows,
    'pagination', jsonb_build_object('total', v_total, 'limit', v_limit, 'offset', v_offset)
  );
end;
$$;

comment on function public.analytics_dashboard_dataset(text, date, date, integer, integer) is
  'Service-role-only analytics projection for the MAM dashboard API. Returns operational history without personal contact data, leave notes/evidence or subscription credentials.';

revoke all on function public.analytics_dashboard_dataset(text, date, date, integer, integer)
  from public, anon, authenticated;
grant execute on function public.analytics_dashboard_dataset(text, date, date, integer, integer)
  to service_role;

commit;
