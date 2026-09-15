"""Deploy and configure the reviewed monthly payroll email reminder.

Run only through the MAM-scoped Supabase credential helper:
  ... exec supabase -- python3 scripts/deploy-payroll-balance-email-reminder.py inspect
  ... exec supabase -- python3 scripts/deploy-payroll-balance-email-reminder.py apply <sha256>
  ... exec supabase -- python3 scripts/deploy-payroll-balance-email-reminder.py configure-recipient <normalised-name>

The script verifies the exact MAM organisation/project and never prints an
employee identifier or email address.
"""
import hashlib
import json
import os
from pathlib import Path
import re
import sys
import urllib.request


PROJECT = "xtwlrjqbusadghavchqm"
ORGANISATION = "fwlmbmospuwoaosffvmw"
VERSION = "20260915140000"
NAME = "payroll_balance_email_reminder"
ROOT = Path(__file__).resolve().parents[1]
MIGRATION = ROOT / "supabase" / "migrations" / f"{VERSION}_{NAME}.sql"


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


def schema_status():
    return query("""
select
  to_regclass('private.payroll_balance_email_recipients') is not null as recipients_table,
  to_regclass('private.payroll_balance_email_reminders') is not null as reminders_table,
  to_regprocedure('public.claim_due_payroll_balance_email_reminders(integer)') is not null as claim_function,
  to_regprocedure('public.prepare_payroll_balance_email_reminder_delivery(uuid,uuid)') is not null as prepare_function,
  to_regprocedure('public.complete_payroll_balance_email_reminder_delivery(uuid,uuid,text)') is not null as complete_function,
  to_regprocedure('public.fail_payroll_balance_email_reminder_delivery(uuid,uuid,text)') is not null as fail_function
""")[0]


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
    status = schema_status()
    result = {"migrationRecorded": bool(existing), "schema": status}
    if status["recipients_table"]:
        configured = query("""
select
  count(*) filter (where recipient.enabled)::integer as enabled_recipients,
  count(*) filter (
    where recipient.enabled
      and person.node_kind = 'person'
      and person.company_key = 'mam'
      and person.is_active
      and profile.account_status = 'active'
      and profile.login_name is not null
      and grant_row.person_id is not null
      and lower(btrim(detail.work_email)) ~ '^[^[:space:]@,;]+@[^[:space:]@,;]+\\.[^[:space:]@,;]+$'
  )::integer as currently_deliverable
from private.payroll_balance_email_recipients recipient
join public.internal_org_people person on person.id = recipient.person_id
left join public.profiles profile on profile.id = person.auth_user_id
left join private.payroll_balance_import_grants grant_row on grant_row.person_id = person.id
left join private.employee_directory_details detail on detail.person_id = person.id
""")[0]
        result["recipientConfiguration"] = configured
    print(json.dumps(result, indent=2))
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
        print("Applied reviewed payroll email reminder migration")
    status = schema_status()
    require(all(status.values()), "Deployed payroll email reminder schema is incomplete")
    print("Verified deployed payroll email reminder schema")
elif operation == "configure-recipient":
    require(bool(existing), "Apply the reviewed migration before configuring the recipient")
    require(len(sys.argv) == 3, "Use configure-recipient <normalised-name>")
    expected_name = sys.argv[2]
    require(
        bool(re.fullmatch(r"[a-z0-9]{3,160}", expected_name)),
        "Expected a lowercase alphanumeric normalised name",
    )
    # The named recipient is resolved only at deployment time. The stored row
    # contains the stable person ID; the current HR email is re-resolved before
    # every send and is never printed or persisted in the outbox.
    query("""
do $$
declare
  v_person_id uuid;
  v_matches integer;
begin
  select count(*)::integer, (array_agg(person.id order by person.id))[1]
  into v_matches, v_person_id
  from public.internal_org_people person
  join private.employee_directory_details detail on detail.person_id = person.id
  join public.profiles profile on profile.id = person.auth_user_id
  join private.payroll_balance_import_grants grant_row on grant_row.person_id = person.id
  where (
      private.normalise_payroll_employee_name(person.full_name) = EXPECTED_NAME
      or private.normalise_payroll_employee_name(
        coalesce(detail.first_name, '') || ' ' || coalesce(detail.last_name, '')
      ) = EXPECTED_NAME
    )
    and person.node_kind = 'person'
    and person.company_key = 'mam'
    and person.is_active
    and profile.account_status = 'active'
    and profile.login_name is not null
    and lower(btrim(detail.work_email)) ~ '^[^[:space:]@,;]+@[^[:space:]@,;]+\\.[^[:space:]@,;]+$';

  if v_matches <> 1 or v_person_id is null then
    raise exception 'Expected one active, linked, granted MAM recipient with a valid work email.';
  end if;
  if exists (
    select 1
    from private.payroll_balance_email_recipients recipient
    where recipient.enabled
      and recipient.person_id <> v_person_id
  ) then
    raise exception 'A different monthly payroll email recipient is already enabled.';
  end if;

  insert into private.payroll_balance_email_recipients (person_id, enabled)
  values (v_person_id, true)
  on conflict (person_id) do update
    set enabled = true,
        updated_at = clock_timestamp();
end;
$$;
""".replace("EXPECTED_NAME", literal(expected_name)))
    configured = query("""
select
  count(*) filter (where enabled)::integer as enabled_recipients
from private.payroll_balance_email_recipients
""")[0]
    require(configured["enabled_recipients"] == 1, "Unexpected enabled recipient count")
    print("Configured and verified one named monthly payroll email recipient; no address disclosed")
else:
    raise SystemExit("Use inspect, apply <reviewed-sha256>, or configure-recipient <normalised-name>")
