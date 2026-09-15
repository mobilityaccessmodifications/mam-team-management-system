"""Deploy the reviewed recurring-workday payroll reminder migration.

Run only through the MAM-scoped Supabase credential helper:
  ... exec supabase -- python3 scripts/deploy-payroll-balance-weekday-reminder.py inspect
  ... exec supabase -- python3 scripts/deploy-payroll-balance-weekday-reminder.py apply <sha256>

The script verifies the exact MAM organisation/project and prints only schema
and aggregate operational state.
"""
import hashlib
import json
import os
from pathlib import Path
import sys
import urllib.request


PROJECT = "xtwlrjqbusadghavchqm"
ORGANISATION = "fwlmbmospuwoaosffvmw"
BASE_VERSION = "20260915140000"
VERSION = "20260915150000"
NAME = "weekday_recurring_payroll_balance_email_reminder"
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
  exists (
    select 1
    from pg_attribute
    where attrelid = 'private.payroll_balance_email_reminders'::regclass
      and attname = 'reminder_date'
      and attnotnull
      and not attisdropped
  ) as reminder_date_not_null,
  exists (
    select 1
    from pg_constraint
    where conrelid = 'private.payroll_balance_email_reminders'::regclass
      and conname = 'payroll_balance_email_reminders_person_day_key'
      and contype = 'u'
  ) as daily_unique,
  not exists (
    select 1
    from pg_constraint
    where conrelid = 'private.payroll_balance_email_reminders'::regclass
      and conname = 'payroll_balance_email_reminders_person_id_reminder_month_key'
  ) as monthly_unique_removed,
  exists (
    select 1
    from pg_constraint
    where conrelid = 'private.payroll_balance_email_reminders'::regclass
      and conname = 'payroll_balance_email_reminders_weekday_check'
      and contype = 'c'
      and convalidated
  ) as weekday_check,
  position(
    'not v_is_workday' in pg_get_functiondef(
      'private.claim_due_payroll_balance_email_reminders_at(integer,timestamptz)'::regprocedure
    )
  ) > 0 as claim_workday_guard,
  position(
    'v_reminder.reminder_date <> v_today' in pg_get_functiondef(
      'private.prepare_payroll_balance_email_reminder_delivery_at(uuid,uuid,timestamptz)'::regprocedure
    )
  ) > 0 as prepare_daily_guard,
  position(
    'reminder.reminder_date = v_today' in pg_get_functiondef(
      'private.fail_payroll_balance_email_reminder_delivery_at(uuid,uuid,text,timestamptz)'::regprocedure
    )
  ) > 0 as retry_daily_guard
""")[0]


project = api("")
require(
    project["id"] == PROJECT and project["organization_id"] == ORGANISATION,
    "MAM Supabase target mismatch",
)
print("Verified MAM project", PROJECT)

operation = sys.argv[1] if len(sys.argv) > 1 else ""
base = query(
    "select version from supabase_migrations.schema_migrations where version="
    + literal(BASE_VERSION)
)
existing = query(
    "select version from supabase_migrations.schema_migrations where version="
    + literal(VERSION)
)
require(bool(base), "The base payroll reminder migration is not recorded")

if operation == "inspect":
    result = {
        "baseMigrationRecorded": True,
        "weekdayMigrationRecorded": bool(existing),
    }
    if existing:
        result["schema"] = schema_status()
        result["operationalCounts"] = query("""
select
  count(*)::integer as total_reminder_rows,
  count(*) filter (
    where reminder_month = date_trunc(
      'month',
      timezone('Australia/Melbourne', now())
    )::date
  )::integer as current_month_rows,
  cardinality(
    private.payroll_balance_missing_companies(
      date_trunc('month', timezone('Australia/Melbourne', now()))::date
    )
  )::integer as missing_company_count
from private.payroll_balance_email_reminders
""")[0]
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
        print("Applied reviewed recurring-workday payroll reminder migration")
    status = schema_status()
    require(all(status.values()), "Deployed recurring-workday payroll reminder schema is incomplete")
    print("Verified deployed recurring-workday payroll reminder schema")
else:
    raise SystemExit("Use inspect or apply <reviewed-sha256>")
