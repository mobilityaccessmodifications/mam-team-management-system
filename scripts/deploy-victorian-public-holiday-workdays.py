"""Deploy the reviewed Victorian public-holiday workday migration.

Run only through the MAM-scoped Supabase credential helper:
  ... exec supabase -- python3 scripts/deploy-victorian-public-holiday-workdays.py inspect
  ... exec supabase -- python3 scripts/deploy-victorian-public-holiday-workdays.py apply <sha256>

The script verifies the exact MAM organisation/project and reports only schema
and aggregate scheduling state. It never prints employee, leave or recipient
records.
"""
import hashlib
import json
import os
from pathlib import Path
import sys
import urllib.request


PROJECT = "xtwlrjqbusadghavchqm"
ORGANISATION = "fwlmbmospuwoaosffvmw"
BASE_VERSION = "20260917090100"
VERSION = "20260917110640"
NAME = "victorian_public_holiday_workdays"
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
  to_regclass('private.victorian_public_holidays') is not null
    as holiday_table,
  (
    select count(*) = 54
    from private.victorian_public_holidays
  ) as published_dates_loaded,
  (
    select relation.relrowsecurity
    from pg_class relation
    where relation.oid = 'private.victorian_public_holidays'::regclass
  ) as holiday_table_rls,
  not has_table_privilege(
    'authenticated', 'private.victorian_public_holidays', 'SELECT'
  ) as holiday_table_private,
  to_regprocedure('private.is_victorian_business_day(date)') is not null
    as business_day_helper,
  not has_function_privilege(
    'authenticated',
    'private.is_victorian_business_day(date)',
    'EXECUTE'
  ) as helper_not_browser_executable,
  private.next_victorian_business_day(date '2026-09-25') = date '2026-09-28'
    as next_day_skips_afl_holiday,
  private.victorian_business_day_on_or_before(date '2026-12-28') = date '2026-12-24'
    as previous_day_skips_christmas_sequence,
  position(
    'next_victorian_business_day'
    in pg_get_functiondef(
      'private.employee_check_in_next_business_day(date)'::regprocedure
    )
  ) > 0 as check_in_uses_holiday_source,
  position(
    'next_victorian_business_day'
    in pg_get_functiondef(
      'private.payroll_balance_monthly_reminder_projection()'::regprocedure
    )
  ) > 0 as calendar_reminder_uses_holiday_source,
  position(
    'is_victorian_business_day'
    in pg_get_functiondef(
      'public.claim_due_payroll_balance_email_reminders(integer)'::regprocedure
    )
  ) > 0 as payroll_email_guard,
  position(
    'is_victorian_business_day'
    in pg_get_functiondef(
      'public.claim_leave_priority_reminders(integer)'::regprocedure
    )
  ) > 0 as leave_email_guard,
  position(
    'victorian_business_day_on_or_before'
    in pg_get_functiondef('private.birthday_reminder_date(date)'::regprocedure)
  ) > 0 as birthday_email_guard,
  position(
    'next_victorian_business_day'
    in pg_get_functiondef('private.set_leave_submission_details()'::regprocedure)
  ) > 0 as sick_evidence_workday_guard,
  has_function_privilege(
    'service_role',
    'public.claim_due_payroll_balance_email_reminders(integer)',
    'EXECUTE'
  ) as payroll_service_access,
  has_function_privilege(
    'service_role',
    'public.claim_leave_priority_reminders(integer)',
    'EXECUTE'
  ) as leave_service_access
""")[0]


def operational_counts():
    return query("""
select
  (
    select count(*)::integer
    from private.subscription_register subscription
    where subscription.pricing_model = 'paid'
      and subscription.subscription_status in ('active', 'paused')
      and subscription.next_review_on is not null
      and not private.is_victorian_business_day(subscription.next_review_on)
  ) as live_subscription_reviews_on_nonworkdays,
  (
    select count(*)::integer
    from private.employee_check_in_reminders reminder
    where reminder.delivery_status in ('scheduled', 'needs_review')
      and (
        not private.is_victorian_business_day(reminder.due_date)
        or not private.is_victorian_business_day(reminder.notify_date)
      )
  ) as open_check_in_rows_on_nonworkdays
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
require(bool(base), "The leave-duration balance migration is not recorded")

if operation == "inspect":
    require(len(sys.argv) == 2, "Use inspect")
    result = {
        "baseMigrationRecorded": True,
        "holidayWorkdayMigrationRecorded": bool(existing),
    }
    if existing:
        result["schema"] = schema_status()
        result["operationalCounts"] = operational_counts()
    print(json.dumps(result, indent=2))
elif operation == "apply":
    require(len(sys.argv) == 3, "Use apply <reviewed-sha256>")
    sql = MIGRATION.read_text()
    require(
        hashlib.sha256(sql.encode()).hexdigest() == sys.argv[2],
        "Reviewed migration differs",
    )
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
        ).replace(
            "\ncommit;",
            "\n" + history + "\nnotify pgrst,'reload schema';\ncommit;",
        )
        query(release_sql)
        print("Applied reviewed Victorian public-holiday workday migration")
    status = schema_status()
    require(
        all(status.values()),
        "Deployed Victorian public-holiday workday schema is incomplete",
    )
    counts = operational_counts()
    require(
        counts["live_subscription_reviews_on_nonworkdays"] == 0
        and counts["open_check_in_rows_on_nonworkdays"] == 0,
        "Open work remains scheduled on a weekend or published public holiday",
    )
    print("Verified deployed Victorian public-holiday workday schema")
    print(json.dumps(counts, indent=2))
else:
    raise SystemExit("Use inspect or apply <reviewed-sha256>")
