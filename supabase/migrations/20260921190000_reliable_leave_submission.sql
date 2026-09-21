-- A lost HTTP response must not create another leave request on retry.
begin;
create table private.leave_submission_receipts (
  actor_user_id uuid not null references auth.users(id) on delete cascade,
  submission_key uuid not null,
  input_hash text not null,
  result jsonb not null,
  created_at timestamptz not null default now(),
  primary key (actor_user_id, submission_key)
);
alter table private.leave_submission_receipts enable row level security;
revoke all on private.leave_submission_receipts from public, anon, authenticated;

create function public.submit_leave_request_once(
  p_submission_key uuid,
  p_person_id uuid,
  p_request_type_label text,
  p_start_date date,
  p_end_date date,
  p_start_time time without time zone default null,
  p_end_time time without time zone default null,
  p_employee_note text default null
) returns table (id uuid, status text, approval_required boolean, assigned_reviewer_label text)
language plpgsql security definer set search_path = '' as $$
declare
  v_actor uuid := auth.uid();
  v_hash text;
  v_receipt private.leave_submission_receipts%rowtype;
  v_result jsonb;
begin
  if v_actor is null or not private.is_active_portal_account()
    or coalesce((auth.jwt()->>'is_anonymous')::boolean, false) then
    raise exception 'An active portal account is required.' using errcode = '42501';
  end if;
  if p_submission_key is null then
    raise exception 'A submission key is required.' using errcode = '22023';
  end if;
  -- Hash includes the target; no private leave note is duplicated in receipts.
  v_hash := encode(extensions.digest(jsonb_build_array(p_person_id, p_request_type_label,
    p_start_date, p_end_date, p_start_time, p_end_time, p_employee_note)::text, 'sha256'), 'hex');
  perform pg_advisory_xact_lock(hashtextextended(v_actor::text || ':' || p_submission_key::text, 0));
  select * into v_receipt from private.leave_submission_receipts r
    where r.actor_user_id = v_actor and r.submission_key = p_submission_key;
  if found then
    if v_receipt.input_hash <> v_hash then
      raise exception 'This submission was already used for different details.' using errcode = '22023';
    end if;
    v_result := v_receipt.result;
  else
    -- Existing functions retain all live employee, delegation, 14-day and
    -- approval checks. Receipt and leave/outbox commit in the same transaction.
    if p_person_id is null then
      select to_jsonb(r) into v_result from public.submit_my_leave_request(
        p_request_type_label, p_start_date, p_end_date, p_start_time, p_end_time, p_employee_note) r;
    else
      select to_jsonb(r) into v_result from public.submit_selected_employee_leave_request(
        p_person_id, p_request_type_label, p_start_date, p_end_date, p_start_time, p_end_time, p_employee_note) r;
    end if;
    if v_result is null then raise exception 'Leave submission returned no result.'; end if;
    insert into private.leave_submission_receipts(actor_user_id, submission_key, input_hash, result)
      values(v_actor, p_submission_key, v_hash, v_result);
  end if;
  return query select r.id, r.status, r.approval_required, r.assigned_reviewer_label
    from jsonb_to_record(v_result) as r(id uuid, status text, approval_required boolean, assigned_reviewer_label text);
end;
$$;
revoke all on function public.submit_leave_request_once(uuid,uuid,text,date,date,time,time,text) from public, anon;
grant execute on function public.submit_leave_request_once(uuid,uuid,text,date,date,time,time,text) to authenticated;
commit;
