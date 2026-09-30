begin;

alter table private.employee_directory_details
  drop constraint employee_directory_details_employment_type_check,
  add constraint employee_directory_details_employment_type_check
    check (employment_type is null or employment_type in ('abn', 'casual', 'full_time', 'part_time', 'overseas'));

alter table public.leave_requests
  drop constraint leave_requests_employment_type_snapshot_check,
  add constraint leave_requests_employment_type_snapshot_check
    check (employment_type_snapshot is null or employment_type_snapshot in ('abn', 'casual', 'full_time', 'part_time', 'overseas'));

create or replace function private.normalise_employee_employment_type(p_value text)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_value text := lower(nullif(btrim(p_value), ''));
begin
  if v_value is null or v_value not in ('abn', 'casual', 'full_time', 'part_time', 'overseas') then
    raise exception 'Choose ABN, Casual, Full Time, Part Time or Overseas as the employment type.'
      using errcode = '22023';
  end if;
  return v_value;
end;
$$;

create or replace function private.enforce_leave_request_employment_policy()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_person_id uuid;
  v_person_auth_user_id uuid;
  v_employment_type text;
begin
  if new.record_origin = 'historical_import' then
    select person.id, person.auth_user_id, detail.employment_type
    into v_person_id, v_person_auth_user_id, v_employment_type
    from public.internal_org_people person
    left join private.employee_directory_details detail
      on detail.person_id = person.id
    where person.id = new.employee_person_id
      and person.node_kind = 'person'
    limit 1;

    if v_person_id is null then
      raise exception 'A retained employee profile is required for historical leave.'
        using errcode = '23503';
    end if;

    if new.user_id is not null and new.user_id is distinct from v_person_auth_user_id then
      raise exception 'The historical leave login does not belong to the selected employee.'
        using errcode = '23503';
    end if;

    new.employment_type_snapshot := coalesce(new.employment_type_snapshot, v_employment_type);
    new.pay_treatment := coalesce(
      new.pay_treatment,
      case
        when new.request_type_label = 'Unpaid leave' then 'unpaid'
        when v_employment_type in ('full_time', 'part_time') then 'paid_entitlement'
        when v_employment_type in ('abn', 'casual') then 'unpaid'
        else null
      end
    );
    return new;
  end if;

  select person.id, detail.employment_type
  into v_person_id, v_employment_type
  from public.internal_org_people person
  left join private.employee_directory_details detail
    on detail.person_id = person.id
  where person.auth_user_id = new.user_id
    and person.node_kind = 'person'
    and person.is_active
  limit 1;

  if v_person_id is null then
    raise exception 'An active linked employee account is required to submit leave.'
      using errcode = '42501';
  end if;

  if v_employment_type is not null and v_employment_type not in ('full_time', 'part_time')
    and new.request_type_label <> 'Unpaid leave' then
    raise exception 'This employment type only allows Unpaid leave.'
      using errcode = '22023';
  end if;

  if v_employment_type is null
    and new.request_type_label <> 'Unpaid leave' then
    raise exception 'Ask a System Admin to set your employment type before requesting this leave.'
      using errcode = '22023';
  end if;

  new.employee_person_id := v_person_id;
  new.employment_type_snapshot := v_employment_type;
  new.pay_treatment := case
    when new.request_type_label = 'Unpaid leave' then 'unpaid'
    when v_employment_type in ('full_time', 'part_time') then 'paid_entitlement'
    else 'unpaid'
  end;

  return new;
end;
$$;

commit;
