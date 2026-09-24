import hashlib
import json
import os
from pathlib import Path
import sys
import urllib.error
import urllib.request


PROJECT = "xtwlrjqbusadghavchqm"
ORGANISATION = "fwlmbmospuwoaosffvmw"
VERSION = "20260924230000"
NAME = "six_month_check_in_review"
ROOT = Path(__file__).resolve().parents[1]
MIGRATION = ROOT / "supabase" / "migrations" / f"{VERSION}_{NAME}.sql"
PREDECESSORS = {
    "20260923230000": ROOT / "supabase/migrations/20260923230000_check_in_review_outcomes.sql",
    "20260924200000": ROOT / "supabase/migrations/20260924200000_five_month_no_surprises_review.sql",
}


def require(condition, message):
    if not condition:
        raise SystemExit(message)


def api(path, body=None):
    request = urllib.request.Request(
        f"https://api.supabase.com/v1/projects/{PROJECT}{path}",
        headers={
            "Authorization": "Bearer " + os.environ["SUPABASE_ACCESS_TOKEN"],
            "Content-Type": "application/json",
            "User-Agent": "supabase-cli/2.54.11",
        },
        data=None if body is None else json.dumps(body).encode(),
    )
    try:
        with urllib.request.urlopen(request, timeout=120) as response:
            return json.load(response)
    except urllib.error.HTTPError as error:
        detail = error.read().decode(errors="replace")
        raise SystemExit(f"Supabase API request failed ({error.code}): {detail}") from error


def query(sql):
    return api("/database/query", {"query": sql})


def literal(value):
    return "'" + value.replace("'", "''") + "'"


def verify_schema(expected_enabled=None):
    state = query("""
      select
        (select count(*) = 1
         from private.people_hub_release_flags release
         where release.feature = 'six_month_check_in_review') as release_gate_row,
        (select release.enabled
         from private.people_hub_release_flags release
         where release.feature = 'six_month_check_in_review') as release_enabled,
        (select count(*) = 1
         from private.employee_check_in_schedule(date '2026-03-15') schedule
         where schedule.milestone = '6_month'
           and schedule.reminder_sequence = 'initial'
           and schedule.due_date = date '2026-09-15'
           and schedule.notify_date = date '2026-09-08') as six_month_schedule,
        (select relrowsecurity and relforcerowsecurity
         from pg_class
         where oid = 'private.employee_check_in_contract_classifications'::regclass)
          as classifications_rls,
        not has_table_privilege(
          'authenticated',
          'private.employee_check_in_contract_classifications',
          'SELECT'
        ) as browser_classifications_denied,
        not has_table_privilege(
          'service_role',
          'private.employee_check_in_contract_classifications',
          'SELECT'
        ) as service_classifications_denied,
        has_function_privilege(
          'authenticated',
          'public.set_employee_check_in_contract_classification(uuid,text)',
          'EXECUTE'
        ) as system_admin_setter_available,
        not has_function_privilege(
          'anon',
          'public.set_employee_check_in_contract_classification(uuid,text)',
          'EXECUTE'
        ) as anonymous_setter_denied,
        not has_function_privilege(
          'service_role',
          'public.set_employee_check_in_contract_classification(uuid,text)',
          'EXECUTE'
        ) as service_setter_denied,
        position(
          'can_manage_employee_directory'
          in pg_get_functiondef(
            'public.set_employee_check_in_contract_classification(uuid,text)'::regprocedure
          )
        ) > 0 as setter_checks_system_admin,
        has_function_privilege(
          'authenticated',
          'public.approve_employee_check_in_employment_decision(uuid,bigint)',
          'EXECUTE'
        ) as people_culture_approval_available,
        not has_function_privilege(
          'anon',
          'public.approve_employee_check_in_employment_decision(uuid,bigint)',
          'EXECUTE'
        ) as anonymous_approval_denied,
        not has_function_privilege(
          'service_role',
          'public.approve_employee_check_in_employment_decision(uuid,bigint)',
          'EXECUTE'
        ) as service_approval_denied,
        position(
          'is_internal_org_hr'
          in pg_get_functiondef(
            'public.approve_employee_check_in_employment_decision(uuid,bigint)'::regprocedure
          )
        ) > 0 as approval_checks_people_culture,
        position(
          'probation_extension_pending_hr'
          in pg_get_functiondef(
            'public.record_employee_check_in_review(uuid,text,date,text,bigint)'::regprocedure
          )
        ) > 0 as extension_requires_people_culture,
        position(
          'non_confirmation_pending_hr'
          in pg_get_functiondef(
            'public.record_employee_check_in_review(uuid,text,date,text,bigint)'::regprocedure
          )
        ) > 0 as non_confirmation_requires_people_culture,
        position(
          'six_month_check_in_review'
          in pg_get_functiondef(
            'public.claim_due_employee_check_in_reminders(integer)'::regprocedure
          )
        ) > 0 as claim_release_gate_present,
        position(
          'six_month_check_in_review'
          in pg_get_functiondef(
            'public.prepare_employee_check_in_reminder_delivery(uuid,uuid)'::regprocedure
          )
        ) > 0 as delivery_release_gate_present,
        position(
          '''6_month'''
          in pg_get_functiondef(
            'public.prepare_employee_check_in_reminder_delivery(uuid,uuid)'::regprocedure
          )
        ) > 0 as six_month_email_allowlist_present,
        (select relrowsecurity and relforcerowsecurity
         from pg_class
         where oid = 'private.people_hub_release_flags'::regclass)
          as release_gate_rls,
        not has_table_privilege(
          'authenticated',
          'private.people_hub_release_flags',
          'SELECT'
        ) as browser_release_gate_denied,
        not has_table_privilege(
          'service_role',
          'private.people_hub_release_flags',
          'SELECT'
        ) as service_release_gate_denied
    """)[0]
    enabled = bool(state.pop("release_enabled"))
    schedule_visible = bool(state.pop("six_month_schedule"))
    require(all(state.values()), "Deployed 6-Month Check-In schema verification failed")
    require(schedule_visible == enabled, "The 6-Month schedule does not match its release gate")
    if expected_enabled is not None:
        require(enabled == expected_enabled, "The 6-Month release gate is in the wrong state")

    operational = query("""
      select
        (select count(*)
         from private.employee_check_in_contract_classifications classification
         join public.internal_org_people person on person.id = classification.person_id
         where person.node_kind = 'person'
           and person.is_active
           and person.started_date is not null) as eligible_active_people,
        (select count(*)
         from private.employee_check_in_reminders reminder
         where reminder.milestone = '6_month'
           and reminder.delivery_status = 'scheduled'
           and reminder.notify_date < (clock_timestamp() at time zone 'Australia/Melbourne')::date)
          as overdue_scheduled_reminders,
        (select count(*)
         from private.employee_check_in_reminders reminder
         where reminder.milestone = '6_month'
           and reminder.delivery_status = 'needs_review'
           and reminder.needs_review_reason = 'historic_cutover') as historical_rows_held_for_review,
        (select count(*)
         from public.internal_org_people person
         join private.employee_check_in_contract_classifications classification
           on classification.person_id = person.id
         cross join lateral private.employee_check_in_schedule(person.started_date) schedule
         where person.node_kind = 'person'
           and person.is_active
           and person.started_date is not null
           and schedule.milestone = '6_month'
           and not exists (
             select 1
             from private.employee_check_in_reminders reminder
             where reminder.person_id = person.id
               and reminder.milestone = schedule.milestone
               and reminder.reminder_sequence = schedule.reminder_sequence
               and reminder.due_date = schedule.due_date
               and reminder.delivery_status not in ('superseded', 'cancelled')
           )) as missing_eligible_rows,
        (select count(*)
         from private.employee_check_in_reminders reminder
         where reminder.milestone = '6_month'
           and reminder.delivery_status in ('scheduled', 'claimed', 'needs_review')
           and not exists (
             select 1
             from private.employee_check_in_contract_classifications classification
             join public.internal_org_people person on person.id = classification.person_id
             where person.id = reminder.person_id
               and person.node_kind = 'person'
               and person.is_active
               and classification.contract_type in ('permanent', 'fixed_term')
           )) as ineligible_open_rows
    """)[0]
    if enabled:
        require(operational["overdue_scheduled_reminders"] == 0,
                "Overdue 6-Month reminders could be sent automatically")
        require(operational["missing_eligible_rows"] == 0,
                "Some classified active employees are missing their 6-Month reminder")
        require(operational["ineligible_open_rows"] == 0,
                "An unclassified or inactive employee has an open 6-Month reminder")
    else:
        require(operational["missing_eligible_rows"] == 0,
                "The disabled 6-Month schedule unexpectedly has reminder rows")
    print(json.dumps({
        "releaseEnabled": enabled,
        "scheduleVisible": schedule_visible,
        "schema": state,
        "operational": operational,
    }))


operation = sys.argv[1] if len(sys.argv) > 1 else ""
require(
    operation in ("inspect", "apply", "activate"),
    "Use inspect, apply <reviewed-sha256> or activate <reviewed-sha256>",
)
project = api("")
require(
    project["id"] == PROJECT and project["organization_id"] == ORGANISATION,
    "MAM Supabase target mismatch",
)
print(json.dumps({"verifiedProject": PROJECT, "verifiedOrganisation": ORGANISATION}))

migration_sql = MIGRATION.read_text()
if operation in ("apply", "activate"):
    require(
        len(sys.argv) == 3
        and hashlib.sha256(migration_sql.encode()).hexdigest() == sys.argv[2],
        "Reviewed migration differs",
    )

versions = ",".join(literal(version) for version in (*PREDECESSORS.keys(), VERSION))
history = query(
    "select version, statements from supabase_migrations.schema_migrations "
    f"where version in ({versions}) order by version"
)
by_version = {row["version"]: row["statements"] for row in history}
for version, predecessor in PREDECESSORS.items():
    require(version in by_version, f"Required Check-In predecessor {version} is missing")
    require(
        by_version[version] == [predecessor.read_text()],
        f"Recorded Check-In predecessor {version} differs from source",
    )

existing = by_version.get(VERSION)
applied_now = operation == "apply" and existing is None
if existing is not None:
    require(existing == [migration_sql], "Recorded 6-Month migration differs from source")

print(json.dumps({
    "migrationRecorded": existing is not None,
    "reviewedSha256": hashlib.sha256(migration_sql.encode()).hexdigest(),
}))

if operation == "apply" and existing is None:
    require(migration_sql.count("\ncommit;") == 1, "Unexpected migration transaction structure")
    ledger = (
        "insert into supabase_migrations.schema_migrations(version,name,statements) values("
        + literal(VERSION)
        + ","
        + literal(NAME)
        + ",ARRAY["
        + literal(migration_sql)
        + "]);"
    )
    release = migration_sql.replace(
        "begin;",
        "begin;\nset local lock_timeout='5s';\nset local statement_timeout='120s';",
        1,
    ).replace(
        "\ncommit;",
        "\n" + ledger + "\nnotify pgrst,'reload schema';\ncommit;",
    )
    query(release)

if operation == "activate":
    require(existing is not None, "Apply the reviewed 6-Month migration before activation")
    query("""
      begin;
      set local lock_timeout='5s';
      set local statement_timeout='120s';
      update private.people_hub_release_flags
      set enabled = true,
          enabled_at = coalesce(enabled_at, clock_timestamp())
      where feature = 'six_month_check_in_review';
      do $$
      declare
        v_person_id uuid;
      begin
        for v_person_id in
          select person.id
          from public.internal_org_people person
          join private.employee_check_in_contract_classifications classification
            on classification.person_id = person.id
          where person.node_kind = 'person'
            and person.is_active
            and person.started_date is not null
            and classification.contract_type in ('permanent', 'fixed_term')
          order by person.id
        loop
          perform private.sync_employee_check_in_reminders(v_person_id, false, false);
        end loop;
        if exists (
          select 1
          from private.employee_check_in_reminders reminder
          where reminder.milestone = '6_month'
            and reminder.delivery_status = 'scheduled'
            and reminder.notify_date < (clock_timestamp() at time zone 'Australia/Melbourne')::date
        ) then
          raise exception 'An overdue 6-Month reminder would be dispatched automatically.'
            using errcode = '55000';
        end if;
        if exists (
          select 1
          from public.internal_org_people person
          join private.employee_check_in_contract_classifications classification
            on classification.person_id = person.id
          cross join lateral private.employee_check_in_schedule(person.started_date) schedule
          where person.node_kind = 'person'
            and person.is_active
            and person.started_date is not null
            and classification.contract_type in ('permanent', 'fixed_term')
            and schedule.milestone = '6_month'
            and not exists (
              select 1
              from private.employee_check_in_reminders reminder
              where reminder.person_id = person.id
                and reminder.milestone = schedule.milestone
                and reminder.reminder_sequence = schedule.reminder_sequence
                and reminder.due_date = schedule.due_date
                and reminder.delivery_status not in ('superseded', 'cancelled')
            )
        ) then
          raise exception 'An eligible employee is missing a 6-Month reminder.'
            using errcode = '55000';
        end if;
        if exists (
          select 1
          from private.employee_check_in_reminders reminder
          where reminder.milestone = '6_month'
            and reminder.delivery_status in ('scheduled', 'claimed', 'needs_review')
            and not exists (
              select 1
              from private.employee_check_in_contract_classifications classification
              join public.internal_org_people person on person.id = classification.person_id
              where person.id = reminder.person_id
                and person.node_kind = 'person'
                and person.is_active
                and classification.contract_type in ('permanent', 'fixed_term')
            )
        ) then
          raise exception 'An unclassified or inactive employee has an open 6-Month reminder.'
            using errcode = '55000';
        end if;
      end;
      $$;
      commit;
    """)
    verify_schema(expected_enabled=True)
elif existing is not None or operation == "apply":
    verify_schema(expected_enabled=False if applied_now else None)
