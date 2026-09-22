begin;

-- CLI-generated stem; moved forward past the reviewed 20260922230000 migration.
-- No sends, legacy imports, or cutover activation are performed by this migration.
create function private.notification_event_key_valid(p_key text)
returns boolean language sql immutable set search_path = '' as $$
  select coalesce(length(p_key) <= 160 and p_key ~ (
    '^(leave:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:' ||
    '(leave-submitted|leave-approved|leave-declined|leave-cancelled|leave-conditionally-approved|leave-reminder|team-birthday):[0-9a-f]{24}' ||
    '|payroll-balance:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:[0-9]{4}-(0[1-9]|1[0-2])' ||
    '|payroll-comparison:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$'), false)
$$;

-- Never silently filter a malformed address. Normalize only valid whole sets.
create function private.notification_recipient_set(p_value text, p_required boolean)
returns text language plpgsql immutable set search_path = '' as $$
declare
  addresses text[];
  address text;
begin
  if p_value is null or octet_length(p_value) > 8192
    or p_value ~ '[[:cntrl:]]' then
    raise exception 'Invalid notification recipient set' using errcode = '22023';
  end if;
  if p_value = '' then
    if p_required then
      raise exception 'Notification To recipient required' using errcode = '22023';
    end if;
    return '';
  end if;
  addresses := string_to_array(p_value, ',');
  if cardinality(addresses) > 32 then
    raise exception 'Too many notification recipients' using errcode = '22023';
  end if;
  foreach address in array addresses loop
    address := lower(btrim(address));
    if length(address) > 254 or address !~ '^[^[:space:]@,;]+@[^[:space:]@,;]+\.[^[:space:]@,;]+$' then
      raise exception 'Invalid notification recipient' using errcode = '22023';
    end if;
  end loop;
  return (select string_agg(a, ',' order by a collate "C")
    from (select distinct lower(btrim(x)) collate "C" as a from unnest(addresses) x) normalized);
end;
$$;

create function private.notification_provider_receipt_valid(p_value jsonb)
returns boolean language plpgsql immutable set search_path = '' as $$
declare k text; v jsonb; code numeric;
begin
  if p_value is null or jsonb_typeof(p_value) <> 'object'
    or octet_length(p_value::text) > 10000 then return false; end if;
  if (select array_agg(key order by key) from jsonb_object_keys(p_value) key)
    is distinct from array['accepted','messageId','requestId','statusCode']::text[]
    or p_value->'accepted' is distinct from 'true'::jsonb then return false; end if;
  foreach k in array array['messageId','requestId'] loop
    v := p_value->k;
    if v <> 'null'::jsonb and (jsonb_typeof(v) <> 'string'
      or length(p_value->>k) not between 1 and 1024
      or (p_value->>k) ~ '[[:cntrl:]]') then return false; end if;
  end loop;
  v := p_value->'statusCode';
  if v = 'null'::jsonb then return true; end if;
  if jsonb_typeof(v) <> 'number' then return false; end if;
  code := (v::text)::numeric;
  return code between 200 and 299 and code = trunc(code);
end;
$$;

create table private.notification_delivery_control (
  singleton boolean primary key default true check (singleton),
  ready boolean not null default false,
  changed_at timestamptz not null default clock_timestamp(),
  legacy_import_sha256 text check (legacy_import_sha256 ~ '^[0-9a-f]{64}$'),
  legacy_import_count bigint check (legacy_import_count >= 0),
  legacy_imported_at timestamptz,
  constraint notification_delivery_import_proof_complete check (
    num_nonnulls(legacy_import_sha256,legacy_import_count,legacy_imported_at) in (0,3)),
  constraint notification_delivery_ready_requires_import_proof check (
    not ready or num_nonnulls(legacy_import_sha256,legacy_import_count,legacy_imported_at) = 3)
);
insert into private.notification_delivery_control (singleton) values (true);

create table private.notification_delivery_receipts (
  event_key text primary key check (private.notification_event_key_valid(event_key)),
  state text not null check (state in ('processing','sent','sent_tombstone','legacy_sent','legacy_unknown')),
  delivery_token uuid unique,
  recipient text,
  cc text,
  provider_receipt jsonb,
  created_at timestamptz not null default clock_timestamp(),
  sent_at timestamptz,
  minimized_at timestamptz,
  check (recipient is null or recipient = private.notification_recipient_set(recipient, true)),
  check (cc is null or cc = private.notification_recipient_set(cc, false)),
  check (provider_receipt is null or private.notification_provider_receipt_valid(provider_receipt)),
  constraint notification_delivery_state_shape check (
    (state = 'processing' and delivery_token is not null and recipient is not null and cc is not null
      and provider_receipt is null and sent_at is null and minimized_at is null)
    or (state = 'sent' and delivery_token is not null and recipient is not null and cc is not null
      and provider_receipt is not null and sent_at is not null and minimized_at is null)
    or (state = 'sent_tombstone' and delivery_token is null and recipient is null and cc is null
      and provider_receipt is null and sent_at is not null and minimized_at is not null)
    or (state in ('legacy_sent','legacy_unknown') and delivery_token is null and recipient is null and cc is null
      and provider_receipt is null and sent_at is null and minimized_at is null)
  )
);
-- Exactly the predicate/order used by the bounded retention operation below.
create index notification_delivery_retention_idx
  on private.notification_delivery_receipts (sent_at, event_key) where state = 'sent';
alter table private.notification_delivery_control enable row level security;
alter table private.notification_delivery_receipts enable row level security;
revoke all on private.notification_delivery_control, private.notification_delivery_receipts
  from public, anon, authenticated, service_role;

-- One short transaction mutex, shared by reserve/confirm/import/retention/gate.
-- No transaction ever spans the external provider send. The PK is a second
-- line of defence; lock timeout is a failed request, never permission to resend.
create function private.lock_notification_delivery_store()
returns void language plpgsql volatile set search_path = '' as $$
begin
  perform pg_advisory_xact_lock(hashtextextended('mam_notification_delivery_store_v1', 0));
end;
$$;

create function private.notification_delivery_rejection(
  p_event_key text, p_code text, p_reconcile boolean,
  p_receipt private.notification_delivery_receipts default null
) returns jsonb language plpgsql immutable set search_path = '' as $$
declare result jsonb;
begin
  result := jsonb_build_object('outcome','rejected','ok',false,'sent',false,'alreadySent',false,
    'eventKey',p_event_key,'rejectionCode',p_code,'reconciliationRequired',p_reconcile);
  if p_receipt.event_key is not null then
    result := result || jsonb_build_object('receiptEventKey',p_receipt.event_key);
  end if;
  -- Bound processing addresses are NOT proof of delivery; never return them as actuals.
  if p_receipt.state = 'sent' then
    result := result || jsonb_build_object('actualRecipient',p_receipt.recipient,
      'actualCcRecipients',p_receipt.cc,'providerReceipt',p_receipt.provider_receipt);
  end if;
  return result;
end;
$$;

-- Operator-only maintenance, also amortized by reserve. Do not delete keys or
-- processing reservations. An old token cannot resurrect minimized evidence.
create function private.minimize_notification_delivery_receipts(
  p_protected_event_keys text[] default '{}'::text[], p_limit integer default 1000
) returns integer language plpgsql volatile set search_path = '' set lock_timeout = '3s' as $$
declare changed integer; cutoff timestamptz := clock_timestamp() - interval '90 days';
begin
  if p_limit is null or p_limit not between 1 and 10000
    or p_protected_event_keys is null or cardinality(p_protected_event_keys) > 100
    or array_position(p_protected_event_keys, null) is not null then
    raise exception 'Invalid notification retention arguments' using errcode = '22023';
  end if;
  perform private.lock_notification_delivery_store();
  with expired as (
    select event_key from private.notification_delivery_receipts
    where state = 'sent' and sent_at < cutoff
      and not (event_key = any(p_protected_event_keys))
    order by sent_at, event_key limit p_limit for update
  )
  update private.notification_delivery_receipts r set state = 'sent_tombstone',
    delivery_token = null, recipient = null, cc = null, provider_receipt = null,
    minimized_at = clock_timestamp()
  from expired e where r.event_key = e.event_key;
  get diagnostics changed = row_count;
  return changed;
end;
$$;

create function private.reserve_notification_delivery(
  p_event_key text, p_recipient text, p_cc text, p_legacy_event_key text default null
) returns jsonb language plpgsql volatile security definer set search_path = '' set lock_timeout = '3s' as $$
declare
  enabled boolean;
  target_to text;
  target_cc text;
  receipt private.notification_delivery_receipts%rowtype;
  token uuid;
begin
  perform private.lock_notification_delivery_store();
  select ready into enabled from private.notification_delivery_control where singleton for update;
  if enabled is distinct from true then
    return private.notification_delivery_rejection(p_event_key,'receipt-store-not-ready',false);
  end if;
  if not private.notification_event_key_valid(p_event_key)
    or (p_legacy_event_key is not null and (
      not private.notification_event_key_valid(p_legacy_event_key)
      or split_part(p_event_key,':',1) <> 'leave' or split_part(p_event_key,':',3) <> 'leave-submitted'
      or split_part(p_legacy_event_key,':',1) <> 'leave' or split_part(p_legacy_event_key,':',3) <> 'leave-submitted'
      or split_part(p_event_key,':',2) <> split_part(p_legacy_event_key,':',2)
      or p_event_key = p_legacy_event_key)) then
    raise exception 'Invalid notification event key' using errcode = '22023';
  end if;
  target_to := private.notification_recipient_set(p_recipient, true);
  target_cc := private.notification_recipient_set(p_cc, false);
  perform private.minimize_notification_delivery_receipts(array_remove(array[p_event_key,p_legacy_event_key],null));
  select * into receipt from private.notification_delivery_receipts where event_key = p_event_key;
  if found then
    if receipt.state in ('legacy_sent','sent_tombstone') then
      return private.notification_delivery_rejection(p_event_key,'receipt-evidence-unavailable',true,receipt);
    elsif receipt.state = 'legacy_unknown' then
      return private.notification_delivery_rejection(p_event_key,'receipt-delivery-unknown',true,receipt);
    elsif receipt.recipient <> target_to or receipt.cc <> target_cc then
      return private.notification_delivery_rejection(p_event_key,'receipt-recipient-mismatch',true,receipt);
    elsif receipt.state = 'processing' then
      if receipt.created_at > clock_timestamp() - interval '20 minutes' then
        return private.notification_delivery_rejection(p_event_key,'delivery-in-flight',false,receipt);
      end if;
      return private.notification_delivery_rejection(p_event_key,'receipt-delivery-unknown',true,receipt);
    end if;
    return jsonb_build_object('outcome','duplicate','ok',true,'sent',false,'alreadySent',true,
      'eventKey',p_event_key,'actualRecipient',receipt.recipient,'actualCcRecipients',receipt.cc,
      'providerReceipt',receipt.provider_receipt);
  end if;
  -- Own receipt has precedence. ANY shared legacy key blocks both split copies.
  if p_legacy_event_key is not null then
    select * into receipt from private.notification_delivery_receipts where event_key = p_legacy_event_key;
    if found then
      return private.notification_delivery_rejection(p_event_key,'legacy-receipt-reconciliation',true,receipt);
    end if;
  end if;
  token := gen_random_uuid();
  insert into private.notification_delivery_receipts(event_key,state,delivery_token,recipient,cc)
    values(p_event_key,'processing',token,target_to,target_cc);
  return jsonb_build_object('outcome','send','eventKey',p_event_key,'deliveryToken',token);
end;
$$;

create function private.confirm_notification_delivery(
  p_event_key text, p_delivery_token uuid, p_recipient text, p_cc text, p_provider_receipt jsonb
) returns jsonb language plpgsql volatile security definer set search_path = '' set lock_timeout = '3s' as $$
declare
  enabled boolean;
  target_to text;
  target_cc text;
  receipt private.notification_delivery_receipts%rowtype;
begin
  perform private.lock_notification_delivery_store();
  select ready into enabled from private.notification_delivery_control where singleton for update;
  if enabled is distinct from true then
    return private.notification_delivery_rejection(p_event_key,'receipt-store-not-ready',false);
  end if;
  if not private.notification_event_key_valid(p_event_key) or p_delivery_token is null
    or not private.notification_provider_receipt_valid(p_provider_receipt) then
    raise exception 'Invalid notification confirmation' using errcode = '22023';
  end if;
  target_to := private.notification_recipient_set(p_recipient, true);
  target_cc := private.notification_recipient_set(p_cc, false);
  select * into receipt from private.notification_delivery_receipts where event_key = p_event_key for update;
  if not found then
    return private.notification_delivery_rejection(p_event_key,'receipt-reservation-missing',true);
  end if;
  if receipt.state in ('legacy_sent','sent_tombstone') then
    return private.notification_delivery_rejection(p_event_key,'receipt-evidence-unavailable',true,receipt);
  elsif receipt.state = 'legacy_unknown' then
    return private.notification_delivery_rejection(p_event_key,'receipt-delivery-unknown',true,receipt);
  elsif receipt.delivery_token is distinct from p_delivery_token then
    return private.notification_delivery_rejection(p_event_key,'receipt-token-mismatch',true,receipt);
  elsif receipt.recipient <> target_to or receipt.cc <> target_cc then
    return private.notification_delivery_rejection(p_event_key,'receipt-recipient-mismatch',true,receipt);
  elsif receipt.state = 'sent' and receipt.provider_receipt is distinct from p_provider_receipt then
    return private.notification_delivery_rejection(p_event_key,'receipt-confirmation-mismatch',true,receipt);
  end if;
  if receipt.state = 'processing' then
    update private.notification_delivery_receipts set state = 'sent', sent_at = clock_timestamp(),
      provider_receipt = p_provider_receipt where event_key = p_event_key returning * into receipt;
  end if;
  -- Exact repeat is idempotent, including its response; never returns a send grant.
  return jsonb_build_object('ok',true,'sent',true,'alreadySent',false,'eventKey',p_event_key,
    'actualRecipient',receipt.recipient,'actualCcRecipients',receipt.cc,'providerReceipt',receipt.provider_receipt);
end;
$$;

create function private.notification_delivery_store_status()
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('version',1,'ready',coalesce(
    (select ready from private.notification_delivery_control where singleton),false))
$$;

-- Management-API/operator only. Pass minimized [{eventKey,state,at}] entries with
-- state legacy_sent or legacy_unknown and the original numeric epoch milliseconds.
-- At is bounded to 1970..9999, safely inside PostgreSQL's timestamp range; never
-- replace an invalid/missing source time with import time. Invalid entries abort
-- the batch. Reimports must match state AND time; modern rows never get replaced.
-- Pause/drain the exact receiver first, import all snapshot batches, verify the
-- exact key set/count against the frozen source, deploy the matching contracts,
-- then separately authorize activation. The import NEVER opens the gate.
create function private.import_notification_delivery_legacy(p_entries jsonb)
returns jsonb language plpgsql volatile set search_path = '' set lock_timeout = '3s' as $$
declare
  entry jsonb; previous_state text; previous_created_at timestamptz;
  source_at numeric; source_created_at timestamptz;
  enabled boolean; inserted integer := 0; existing integer := 0;
begin
  if p_entries is null or jsonb_typeof(p_entries) <> 'array' then
    raise exception 'Invalid legacy receipt batch' using errcode = '22023';
  end if;
  if jsonb_array_length(p_entries) > 10000 or octet_length(p_entries::text) > 3000000 then
    raise exception 'Legacy receipt batch too large' using errcode = '22023';
  end if;
  perform private.lock_notification_delivery_store();
  select ready into enabled from private.notification_delivery_control where singleton for update;
  if enabled is distinct from false then
    raise exception 'Legacy import requires disabled receipt store' using errcode = '55000';
  end if;
  for entry in select value from jsonb_array_elements(p_entries) loop
    if jsonb_typeof(entry) <> 'object' then
      raise exception 'Invalid legacy receipt entry' using errcode = '22023';
    end if;
    if (select array_agg(key order by key) from jsonb_object_keys(entry) key)
      is distinct from array['at','eventKey','state']::text[]
      or jsonb_typeof(entry->'eventKey') <> 'string' or jsonb_typeof(entry->'state') <> 'string'
      or jsonb_typeof(entry->'at') is distinct from 'number'
      or not private.notification_event_key_valid(entry->>'eventKey')
      or (entry->>'state') not in ('legacy_sent','legacy_unknown') then
      raise exception 'Invalid legacy receipt entry' using errcode = '22023';
    end if;
    source_at := (entry->>'at')::numeric;
    -- JSON numbers cannot encode NaN/Infinity; string representations were
    -- rejected above. The bound also prevents huge numeric-to-timestamp casts.
    if source_at < 0 or source_at > 253402300799999 then
      raise exception 'Invalid legacy receipt timestamp' using errcode = '22023';
    end if;
    source_created_at := to_timestamp((source_at / 1000)::double precision);
    select state, created_at into previous_state, previous_created_at
      from private.notification_delivery_receipts where event_key = entry->>'eventKey';
    if found then
      if previous_state is distinct from entry->>'state' or previous_created_at is distinct from source_created_at then
        raise exception 'Legacy receipt collision requires reconciliation' using errcode = '40001';
      end if;
      existing := existing + 1;
    else
      insert into private.notification_delivery_receipts(event_key,state,created_at)
        values(entry->>'eventKey',entry->>'state',source_created_at);
      inserted := inserted + 1;
    end if;
  end loop;
  -- The operator must verify and stamp the frozen key/state/time snapshot hash,
  -- exact imported key count and import time in this SAME import transaction.
  -- An empty snapshot is legitimate (count zero with its actual snapshot hash).
  -- New keys invalidate any earlier proof; exact no-op reimports preserve it.
  if inserted > 0 then
    update private.notification_delivery_control set legacy_import_sha256 = null,
      legacy_import_count = null, legacy_imported_at = null, changed_at = clock_timestamp()
      where singleton;
  end if;
  return jsonb_build_object('inserted',inserted,'existing',existing);
end;
$$;

create function private.set_notification_delivery_ready(p_ready boolean)
returns jsonb language plpgsql volatile set search_path = '' set lock_timeout = '3s' as $$
begin
  if p_ready is null then raise exception 'Ready boolean required' using errcode = '22023'; end if;
  perform private.lock_notification_delivery_store();
  update private.notification_delivery_control set ready = p_ready, changed_at = clock_timestamp() where singleton;
  if not found then raise exception 'Notification control missing' using errcode = '55000'; end if;
  return private.notification_delivery_store_status();
end;
$$;

create function public.reserve_notification_delivery(
  p_event_key text, p_recipient text, p_cc text, p_legacy_event_key text default null
) returns jsonb language sql volatile security invoker set search_path = '' as $$
  select private.reserve_notification_delivery(p_event_key,p_recipient,p_cc,p_legacy_event_key)
$$;
create function public.confirm_notification_delivery(
  p_event_key text, p_delivery_token uuid, p_recipient text, p_cc text, p_provider_receipt jsonb
) returns jsonb language sql volatile security invoker set search_path = '' as $$
  select private.confirm_notification_delivery(p_event_key,p_delivery_token,p_recipient,p_cc,p_provider_receipt)
$$;
create function public.notification_delivery_store_status()
returns jsonb language sql stable security invoker set search_path = '' as $$
  select private.notification_delivery_store_status()
$$;

-- Explicitly override existing/default PUBLIC/role EXECUTE grants. Private
-- helpers, import, gate and retention are owner-only, not integration capabilities.
revoke all on function private.notification_event_key_valid(text),
  private.notification_recipient_set(text,boolean), private.notification_provider_receipt_valid(jsonb),
  private.lock_notification_delivery_store(),
  private.notification_delivery_rejection(text,text,boolean,private.notification_delivery_receipts),
  private.minimize_notification_delivery_receipts(text[],integer),
  private.import_notification_delivery_legacy(jsonb), private.set_notification_delivery_ready(boolean)
  from public, anon, authenticated, service_role;
revoke all on function private.reserve_notification_delivery(text,text,text,text),
  private.confirm_notification_delivery(text,uuid,text,text,jsonb), private.notification_delivery_store_status(),
  public.reserve_notification_delivery(text,text,text,text),
  public.confirm_notification_delivery(text,uuid,text,text,jsonb), public.notification_delivery_store_status()
  from public, anon, authenticated, service_role;
grant usage on schema private to service_role;
grant execute on function private.reserve_notification_delivery(text,text,text,text),
  private.confirm_notification_delivery(text,uuid,text,text,jsonb), private.notification_delivery_store_status(),
  public.reserve_notification_delivery(text,text,text,text),
  public.confirm_notification_delivery(text,uuid,text,text,jsonb), public.notification_delivery_store_status()
  to service_role;

comment on table private.notification_delivery_receipts is
  'Permanent no-resend keys. Processing never expires into permission to send. 90-day evidence minimization retains tombstones.';
comment on table private.notification_delivery_control is
  'Disabled until authorized operator verifies frozen legacy import and matching API/receiver contract. No client can activate.';

commit;
