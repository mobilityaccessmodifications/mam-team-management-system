begin;

-- Deliberately empty: directory contact numbers are not ownership evidence.
-- Only the guarded management RPC may change this authorization source.
create table private.openclaw_phone_identities (
  person_id uuid primary key references public.internal_org_people(id),
  user_id uuid not null references public.profiles(id),
  phone_e164 text unique check (phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  revision uuid not null unique default gen_random_uuid(),
  verified_at timestamptz,
  changed_at timestamptz not null default clock_timestamp(),
  check ((phone_e164 is null) = (verified_at is null))
);
create table private.openclaw_phone_identity_events (
  id uuid primary key default gen_random_uuid(),
  person_id uuid not null references public.internal_org_people(id),
  actor_user_id uuid not null references public.profiles(id),
  user_id uuid not null references public.profiles(id),
  previous_revision uuid,
  revision uuid not null unique,
  previous_phone_e164 text,
  phone_e164 text,
  evidence_ref text not null check (evidence_ref ~ '^[A-Za-z0-9][A-Za-z0-9:._/-]{2,199}$'),
  created_at timestamptz not null default clock_timestamp()
);
alter table private.openclaw_phone_identities enable row level security;
alter table private.openclaw_phone_identity_events enable row level security;
revoke all on private.openclaw_phone_identities, private.openclaw_phone_identity_events
  from public, anon, authenticated, service_role;

-- Controlled profiles.app_role predicate, never caller-supplied user_metadata.
create function private.require_openclaw_identity_admin()
returns void language plpgsql stable security definer set search_path = '' as $$
begin
  if (select auth.uid()) is null
    or coalesce(((select auth.jwt())->>'is_anonymous')::boolean, true)
    or not private.is_system_portal_account_admin() then
    raise exception 'System Admin required' using errcode='42501';
  end if;
end;
$$;
revoke all on function private.require_openclaw_identity_admin() from public, anon, authenticated, service_role;

-- An authorized operator can obtain the CAS revision, including after archive
-- or company removal so that revocation is always operationally possible.
create function public.get_openclaw_phone_identity(p_person_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_openclaw_identity_admin();
  return (select jsonb_build_object('personId', i.person_id, 'userId', i.user_id,
    'phone', i.phone_e164, 'revision', i.revision, 'verifiedAt', i.verified_at,
    'changedAt', i.changed_at)
    from private.openclaw_phone_identities i where i.person_id=p_person_id);
end;
$$;
revoke all on function public.get_openclaw_phone_identity(uuid) from public, anon, authenticated, service_role;
grant execute on function public.get_openclaw_phone_identity(uuid) to authenticated;

-- Null expected revision means first enrollment only. Null phone revokes.
-- Evidence is a reference to an independently completed ownership check (or
-- revocation decision), not free-text HR data, an OTP, or a contact-field edit.
create function public.set_openclaw_phone_identity(
  p_person_id uuid, p_expected_revision uuid, p_phone_e164 text, p_evidence_ref text
) returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  previous private.openclaw_phone_identities%rowtype;
  target_user uuid;
  next_revision uuid := gen_random_uuid();
begin
  perform private.require_openclaw_identity_admin();
  if p_person_id is null
    or (p_phone_e164 is not null and p_phone_e164 !~ '^\+[1-9][0-9]{7,14}$')
    or p_evidence_ref is null or p_evidence_ref !~ '^[A-Za-z0-9][A-Za-z0-9:._/-]{2,199}$' then
    raise exception 'Canonical E164 and an evidence reference are required' using errcode='22023';
  end if;
  perform set_config('lock_timeout','3s',true);
  -- Same order as confirmation. The shared bridge mutex protects registry
  -- mutations through receipt replay; table locks freeze profile/hierarchy scope.
  perform pg_advisory_xact_lock(hashtextextended('internal_org_people_hierarchy',0));
  perform pg_advisory_xact_lock(hashtextextended('leave_approval_grants',0));
  perform pg_advisory_xact_lock(hashtextextended('openclaw_leave_bridge',0));
  lock table public.profiles, public.internal_org_people in share mode;
  perform private.require_openclaw_identity_admin();
  select * into previous from private.openclaw_phone_identities where person_id=p_person_id for update;
  if previous.revision is distinct from p_expected_revision then
    raise exception 'Phone identity changed; reload before retrying' using errcode='40001';
  end if;
  if p_phone_e164 is null then
    if previous.phone_e164 is null then
      raise exception 'No enrolled identity to revoke' using errcode='22023';
    end if;
    target_user := previous.user_id;
  else
    select p.auth_user_id into target_user from public.internal_org_people p
      where p.id=p_person_id and p.company_key='mam' and p.is_active and p.node_kind='person'
        and p.auth_user_id is not null and private.is_active_portal_account(p.auth_user_id);
    if target_user is null then
      raise exception 'Active linked MAM employee required' using errcode='42501';
    end if;
  end if;
  insert into private.openclaw_phone_identities(person_id,user_id,phone_e164,revision,verified_at)
    values(p_person_id,target_user,p_phone_e164,next_revision,
      case when p_phone_e164 is not null then clock_timestamp() end)
    on conflict (person_id) do update set user_id=excluded.user_id,phone_e164=excluded.phone_e164,
      revision=excluded.revision,verified_at=excluded.verified_at,changed_at=clock_timestamp();
  insert into private.openclaw_phone_identity_events(
    person_id,actor_user_id,user_id,previous_revision,revision,previous_phone_e164,phone_e164,evidence_ref
  ) values(p_person_id,(select auth.uid()),target_user,previous.revision,next_revision,
    previous.phone_e164,p_phone_e164,p_evidence_ref);
  return public.get_openclaw_phone_identity(p_person_id);
end;
$$;
revoke all on function public.set_openclaw_phone_identity(uuid,uuid,text,text) from public, anon, authenticated, service_role;
grant execute on function public.set_openclaw_phone_identity(uuid,uuid,text,text) to authenticated;

-- All identity consumers share one statement-consistent authority. Binding the
-- enrolled portal user prevents a later person/account relink inheriting trust.
create or replace function private.openclaw_leave_people()
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'personId',p.id,'userId',p.auth_user_id,'company',p.company_key,
    'active',p.is_active,'nodeKind',p.node_kind,'accountActive',true,
    'phone',i.phone_e164,'country',null,'phoneIdentityVersion',i.revision,
    'employmentType',d.employment_type,'fullName',p.full_name
  ) order by p.id), '[]'::jsonb)
  from private.openclaw_phone_identities i
  join public.internal_org_people p on p.id=i.person_id and p.auth_user_id=i.user_id
  left join private.employee_directory_details d on d.person_id=p.id
  where i.phone_e164 is not null and p.company_key='mam' and p.is_active
    and p.node_kind='person' and private.is_active_portal_account(p.auth_user_id);
$$;
revoke all on function private.openclaw_leave_people() from public, anon, authenticated, service_role;

create or replace function private.openclaw_self_profile_people()
returns jsonb language sql stable security definer set search_path = '' as $$
  select private.openclaw_leave_people();
$$;
revoke all on function private.openclaw_self_profile_people() from public, anon, authenticated, service_role;

-- Preserve both legacy RPC envelopes, including authoritative empty snapshots.
create or replace function private.openclaw_whatsapp_allowlist_snapshot()
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('schemaVersion',1,'complete',true,'rowCount',count(*),
    'phones',coalesce(jsonb_agg(p->>'phone' order by p->>'phone'),'[]'::jsonb))
  from jsonb_array_elements(private.openclaw_leave_people()) p;
$$;
create or replace function private.openclaw_whatsapp_allowlist_snapshot_v2()
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('schemaVersion',2,'complete',true,'rowCount',count(*),
    'contacts',coalesce(jsonb_agg(jsonb_build_object('phone',p->>'phone','country',null)
      order by p->>'phone'),'[]'::jsonb))
  from jsonb_array_elements(private.openclaw_leave_people()) p;
$$;
revoke all on function private.openclaw_whatsapp_allowlist_snapshot(), private.openclaw_whatsapp_allowlist_snapshot_v2()
  from public, anon, authenticated, service_role;
grant execute on function private.openclaw_whatsapp_allowlist_snapshot(), private.openclaw_whatsapp_allowlist_snapshot_v2() to service_role;

-- The HTTP route already rejects v1/v2. Retire the DB write path as well:
-- historical drafts have no independently verified identity binding.
create or replace function private.openclaw_leave_commit(
  p_key text,p_body_fingerprint text,p_source_fingerprint text,p_draft_fingerprint text,
  p_packet jsonb,p_person_id uuid,p_draft jsonb,p_result jsonb,p_submit boolean
) returns jsonb language plpgsql volatile security definer set search_path = '' as $$
begin
  raise exception 'Legacy bridge retired; prepare a new v3 request' using errcode='42501';
end;
$$;
revoke all on function private.openclaw_leave_commit(text,text,text,text,jsonb,uuid,jsonb,jsonb,boolean)
  from public, anon, authenticated, service_role;

-- Amend only the identity guard in the installed v3 body. Preserve the reviewed
-- leave implementation and any forward leave-policy changes by other migrations.
-- Fail migration on drift instead of silently installing an unguarded body.
do $migration$
declare original text; patched text; anchor text := '  actor:=(employee->>''userId'')::uuid;';
begin
  original := pg_get_functiondef('public.openclaw_leave_v3_submit(text,text,text,jsonb,uuid,jsonb,text)'::regprocedure);
  if array_length(string_to_array(original,anchor),1)<>2
    or position('pg_advisory_xact_lock(hashtextextended(''openclaw_leave_bridge'',0))' in original)=0
    or position('Identity snapshot changed' in original)=0 then
    raise exception 'OpenClaw v3 identity guard requires review';
  end if;
  patched := replace(original,anchor,$guard$
  -- Enforce the phone/person binding in SQL too, before ANY receipt or nonce
  -- return. The sealed enrollment version prevents revoke/re-enroll ABA replay.
  if employee->>'phone' is distinct from p_packet->>'sender'
    or employee->>'phoneIdentityVersion' is null
    or p_draft->>'phoneIdentityVersion' is distinct from employee->>'phoneIdentityVersion' then
    raise exception 'Verified phone identity changed' using errcode='40001';
  end if;
  actor:=(employee->>'userId')::uuid;$guard$);
  execute patched;
end;
$migration$;
revoke all on function public.openclaw_leave_v3_submit(text,text,text,jsonb,uuid,jsonb,text) from public, anon, authenticated, service_role;
grant execute on function public.openclaw_leave_v3_submit(text,text,text,jsonb,uuid,jsonb,text) to service_role;

commit;
