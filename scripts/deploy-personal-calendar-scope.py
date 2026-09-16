"""Deploy and configure the reviewed personal Calendar scope release.

Run only through the MAM-scoped Supabase credential helper:
  ... exec supabase -- python3 scripts/deploy-personal-calendar-scope.py inspect
  ... exec supabase -- python3 scripts/deploy-personal-calendar-scope.py apply <sha256>
  ... exec supabase -- python3 scripts/deploy-personal-calendar-scope.py configure

The script verifies the exact MAM organisation/project. Configuration requires
out-of-band reviewed SHA-256 fingerprints that bind each owner-confirmed
canonical person ID, Auth link, company, HR name and work address. It never
selects a delegate by display name alone and never prints names, IDs, addresses,
leave records or balance values.
"""
import hashlib
import json
import os
from pathlib import Path
import sys
import urllib.request


PROJECT = "xtwlrjqbusadghavchqm"
ORGANISATION = "fwlmbmospuwoaosffvmw"
VERSION = "20260916130000"
NAME = "personal_calendar_scope"
ROOT = Path(__file__).resolve().parents[1]
MIGRATION = ROOT / "supabase" / "migrations" / f"{VERSION}_{NAME}.sql"
# Opaque, owner-confirmed release metadata. These values bind the canonical
# person/Auth links, MAM company and current normalised HR identity fields; no
# staff identifier, name or address is committed or printed. Any identity drift
# fails closed and requires a separately reviewed release update.
GERARD_IDENTITY_SHA256 = "70fb92737044b81a838775e651dd79c6499dee89f23b52dbe7312c643a770118"
JACKIE_IDENTITY_SHA256 = "26e0b560c2bd91428c34f9ae66a7748f87fb9b43b02e0df2cc75fb9391fc083b"


def api(path, body=None):
    request = urllib.request.Request(
        "https://api.supabase.com/v1/projects/" + PROJECT + path,
        headers={
            "Authorization": "Bearer " + os.environ["SUPABASE_ACCESS_TOKEN"],
            "Content-Type": "application/json",
            "User-Agent": "supabase-cli/2.54.11",
        },
        data=None if body is None else json.dumps(body).encode(),
    )
    with urllib.request.urlopen(request, timeout=90) as response:
        return json.load(response)


def query(sql):
    return api("/database/query", {"query": sql})


def literal(value):
    return "'" + str(value).replace("'", "''") + "'"


def require(condition, message):
    if not condition:
        raise SystemExit(message)


def checked_identity_fingerprint(value):
    fingerprint = str(value).strip().lower()
    require(
        len(fingerprint) == 64
        and all(character in "0123456789abcdef" for character in fingerprint),
        "Identity fingerprints must be lowercase SHA-256 hex values",
    )
    return fingerprint


def identity_fingerprint_sql():
    return """encode(extensions.digest(convert_to(concat_ws('|',
      person.id::text,
      person.auth_user_id::text,
      person.company_key,
      lower(btrim(detail.first_name)),
      coalesce(lower(btrim(detail.last_name)), ''),
      coalesce(lower(btrim(detail.work_email)), '')
    ), 'UTF8'), 'sha256'), 'hex')"""


def schema_status():
    return query("""
select
  to_regclass('private.approved_leave_calendar_grants') is not null as grants_table,
  to_regprocedure('private.can_view_all_approved_leave_calendar_for(uuid)') is not null as target_capability,
  coalesce(
    pg_get_function_result(to_regprocedure('public.list_leave_calendar_entries()'))
      like 'TABLE(id uuid, person_id uuid,%',
    false
  ) as live_person_identity,
  to_regprocedure('public.list_leave_calendar_entries_for_preview(uuid)') is not null as leave_preview,
  coalesce(
    pg_get_function_result(to_regprocedure('public.list_leave_calendar_entries_for_preview(uuid)'))
      like 'TABLE(id uuid, person_id uuid,%',
    false
  ) as preview_person_identity,
  to_regprocedure('public.can_import_payroll_balances_for_preview(uuid)') is not null as payroll_preview
""")[0]


def configuration_status():
    gerard_fingerprint = checked_identity_fingerprint(GERARD_IDENTITY_SHA256)
    jackie_fingerprint = checked_identity_fingerprint(JACKIE_IDENTITY_SHA256)
    fingerprint_expression = identity_fingerprint_sql()
    result = query(f"""
with active_identity as (
  select person.id as person_id,
    person.company_key,
    {fingerprint_expression} as fingerprint
  from public.internal_org_people person
  join private.employee_directory_details detail on detail.person_id = person.id
  join public.profiles profile on profile.id = person.auth_user_id
  where person.node_kind = 'person'
    and person.is_active
    and person.auth_user_id is not null
    and profile.account_status = 'active'
    and profile.login_name is not null
    and private.is_active_portal_account(profile.id)
), gerard as (
  select identity.person_id
  from active_identity identity
  join private.payroll_balance_email_recipients recipient
    on recipient.person_id = identity.person_id
  where recipient.enabled
    and identity.company_key = 'mam'
    and identity.fingerprint = {literal(gerard_fingerprint)}
), jackie as (
  select identity.person_id
  from active_identity identity
  where identity.company_key = 'mam'
    and identity.fingerprint = {literal(jackie_fingerprint)}
)
select
  (select count(*)::integer
   from private.payroll_balance_email_recipients recipient
   where recipient.enabled) as enabled_payroll_recipients,
  (select count(*)::integer from gerard) as gerard_candidates,
  (select count(*)::integer from jackie) as jackie_candidates,
  (select count(*)::integer
   from private.payroll_balance_email_recipients recipient
   left join active_identity identity on identity.person_id = recipient.person_id
   where recipient.enabled
     and identity.fingerprint is distinct from {literal(gerard_fingerprint)}
  ) as unexpected_enabled_payroll_recipients,
  (select count(*)::integer
   from gerard
   join private.payroll_balance_import_grants access_grant
     on access_grant.person_id = gerard.person_id) as gerard_import_grants
""")[0]
    if schema_status()["grants_table"]:
        grant_status = query(f"""
with active_identity as (
  select person.id as person_id,
    {fingerprint_expression} as fingerprint
  from public.internal_org_people person
  join private.employee_directory_details detail on detail.person_id = person.id
  join public.profiles profile on profile.id = person.auth_user_id
  where person.node_kind = 'person'
    and person.is_active
    and person.auth_user_id is not null
    and profile.account_status = 'active'
    and profile.login_name is not null
    and private.is_active_portal_account(profile.id)
)
select
  count(*) filter (
    where identity.fingerprint in (
      {literal(gerard_fingerprint)}, {literal(jackie_fingerprint)}
    )
  )::integer as intended_calendar_grants,
  count(*) filter (
    where identity.fingerprint is null
      or identity.fingerprint not in (
        {literal(gerard_fingerprint)}, {literal(jackie_fingerprint)}
      )
  )::integer as unexpected_calendar_grants
from private.approved_leave_calendar_grants access_grant
left join active_identity identity on identity.person_id = access_grant.person_id
""")[0]
        result.update(grant_status)
    else:
        result["intended_calendar_grants"] = 0
        result["unexpected_calendar_grants"] = 0
    return result


project = api("")
require(
    project["id"] == PROJECT and project["organization_id"] == ORGANISATION,
    "MAM Supabase target mismatch",
)
print("Verified MAM project", PROJECT)

operation = sys.argv[1] if len(sys.argv) > 1 else ""
existing = query(
    "select version from supabase_migrations.schema_migrations where version="
    + literal(VERSION)
)

if operation == "inspect":
    require(len(sys.argv) == 2, "Use inspect")
    print(json.dumps({
        "migrationRecorded": bool(existing),
        "schema": schema_status(),
        "configuration": configuration_status(),
    }, indent=2))
elif operation == "apply":
    require(len(sys.argv) == 3, "Use apply <reviewed-sha256>")
    sql = MIGRATION.read_text()
    require(hashlib.sha256(sql.encode()).hexdigest() == sys.argv[2], "Reviewed migration differs")
    if existing:
        print("Migration already recorded; checking deployed schema")
    else:
        require(sql.count("\ncommit;") == 1, "Unexpected migration transaction structure")
        history = (
            "insert into supabase_migrations.schema_migrations(version,name,statements) values("
            + literal(VERSION)
            + ","
            + literal(NAME)
            + ",ARRAY["
            + literal(sql)
            + "]);"
        )
        release_sql = sql.replace(
            "begin;",
            "begin;\nset local lock_timeout='5s';\nset local statement_timeout='75s';",
            1,
        ).replace("\ncommit;", "\n" + history + "\nnotify pgrst,'reload schema';\ncommit;")
        query(release_sql)
        print("Applied reviewed personal Calendar scope migration")
    require(all(schema_status().values()), "Deployed personal Calendar schema is incomplete")
    print("Verified deployed personal Calendar schema")
elif operation == "configure":
    require(len(sys.argv) == 2, "Use configure")
    gerard_fingerprint = checked_identity_fingerprint(GERARD_IDENTITY_SHA256)
    jackie_fingerprint = checked_identity_fingerprint(JACKIE_IDENTITY_SHA256)
    require(
        gerard_fingerprint != jackie_fingerprint,
        "Approved Calendar viewers must have distinct identity fingerprints",
    )
    require(bool(existing), "Apply the reviewed migration before configuring access")
    status = configuration_status()
    require(status["enabled_payroll_recipients"] == 1, "Expected one enabled payroll recipient")
    require(status["gerard_candidates"] == 1, "Gerard identity fingerprint did not match the active MAM payroll recipient")
    require(status["jackie_candidates"] == 1, "Jackie identity fingerprint did not match one active MAM employee")
    require(status["unexpected_enabled_payroll_recipients"] == 0, "An unexpected payroll recipient is enabled")
    require(status["unexpected_calendar_grants"] == 0, "Unexpected approved Calendar grants require review")
    fingerprint_expression = identity_fingerprint_sql()
    query(f"""
do $$
declare
  v_gerard_person_id uuid;
  v_jackie_person_id uuid;
begin
  select recipient.person_id
  into strict v_gerard_person_id
  from private.payroll_balance_email_recipients recipient
  join public.internal_org_people person on person.id = recipient.person_id
  join private.employee_directory_details detail on detail.person_id = person.id
  join public.profiles profile on profile.id = person.auth_user_id
  where recipient.enabled
    and person.company_key = 'mam'
    and person.node_kind = 'person'
    and person.is_active
    and person.auth_user_id is not null
    and profile.account_status = 'active'
    and profile.login_name is not null
    and private.is_active_portal_account(profile.id)
    and {fingerprint_expression} = {literal(gerard_fingerprint)};

  select person.id
  into strict v_jackie_person_id
  from public.internal_org_people person
  join private.employee_directory_details detail on detail.person_id = person.id
  join public.profiles profile on profile.id = person.auth_user_id
  where person.company_key = 'mam'
    and person.node_kind = 'person'
    and person.is_active
    and person.auth_user_id is not null
    and profile.account_status = 'active'
    and profile.login_name is not null
    and private.is_active_portal_account(profile.id)
    and {fingerprint_expression} = {literal(jackie_fingerprint)};

  if v_gerard_person_id = v_jackie_person_id then
    raise exception 'Approved Calendar viewers must resolve to two employees.';
  end if;

  insert into private.payroll_balance_import_grant_events (
    person_id, actor_user_id, event_type
  )
  select v_gerard_person_id, null, 'granted'
  where not exists (
    select 1 from private.payroll_balance_import_grants access_grant
    where access_grant.person_id = v_gerard_person_id
  );

  insert into private.payroll_balance_import_grants (person_id, granted_by)
  values (v_gerard_person_id, null)
  on conflict (person_id) do nothing;

  insert into private.approved_leave_calendar_grants (person_id, granted_by)
  values (v_gerard_person_id, null), (v_jackie_person_id, null)
  on conflict (person_id) do nothing;
end;
$$;
""")
    configured = configuration_status()
    require(configured["gerard_import_grants"] == 1, "Gerard payroll import grant was not verified")
    require(configured["intended_calendar_grants"] == 2, "Approved Calendar grants were not verified")
    require(configured["unexpected_calendar_grants"] == 0, "Unexpected Calendar grants were detected")
    print("Configured and verified Gerard payroll import plus Gerard/Jackie approved Calendar access")
else:
    raise SystemExit(
        "Use inspect, apply <reviewed-sha256>, or configure"
    )
