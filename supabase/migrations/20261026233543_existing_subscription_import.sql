begin;

create table private.existing_subscription_imports (
  id uuid primary key default gen_random_uuid(),
  approval_reference text not null check (char_length(btrim(approval_reference)) between 1 and 500),
  transaction_id bigint not null default txid_current(),
  operation text not null check (operation in ('INSERT', 'UPDATE')),
  expected_record jsonb not null check (jsonb_typeof(expected_record) = 'object'),
  created_at timestamptz not null default clock_timestamp(),
  consumed_at timestamptz
);

alter table private.existing_subscription_imports enable row level security;
revoke all on private.existing_subscription_imports from public, anon, authenticated, service_role;

create function private.consume_existing_subscription_import(p_record jsonb, p_operation text)
returns boolean language plpgsql volatile security definer set search_path = ''
as $$
declare matched uuid;
begin
  if p_record->>'pricing_model' is distinct from 'paid'
    or p_record->>'source_request_id' is not null
    or p_record->>'source_approved_version' is not null then
    return false;
  end if;
  select id into matched from private.existing_subscription_imports
  where transaction_id = txid_current() and operation = p_operation
    and consumed_at is null
    and expected_record = p_record - array['version','updated_at','next_review_on']
  order by created_at, id limit 1 for update;
  if matched is null then return false; end if;
  update private.existing_subscription_imports set consumed_at = clock_timestamp() where id = matched;
  return true;
end;
$$;

revoke all on function private.consume_existing_subscription_import(jsonb,text)
  from public, anon, authenticated, service_role;

do $$
declare definition text; anchor text := '  if tg_op=''INSERT'' and (new.source_request_id';
begin
  definition := pg_get_functiondef('private.sr_register_gate()'::regprocedure);
  if position(anchor in definition) = 0
    or position('consume_existing_subscription_import' in definition) > 0 then
    raise exception 'Subscription procurement gate differs from the reviewed predecessor.';
  end if;
  execute replace(definition, anchor,
    E'  if private.consume_existing_subscription_import(to_jsonb(new), tg_op) then return new; end if;\n' || anchor);
end;
$$;

commit;
