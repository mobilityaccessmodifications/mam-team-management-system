import hashlib
import json
import os
from pathlib import Path
import re
import sys
import urllib.request

PROJECT = "xtwlrjqbusadghavchqm"
ORGANISATION = "fwlmbmospuwoaosffvmw"
ROOT = Path(__file__).resolve().parents[1] / "supabase" / "migrations"
MIGRATIONS = (
    ("20260930120000", "rename_mam_admin_team", "ead4f704c96088ebe6b1693090499cbcd8f15aff9594942f87dc4bca2d75d208"),
    ("20260930120100", "onboarding_credentials", "e65f5840b7ff808e02db11e5b37083c0e17b12bc340bbf3821f9a9d25d242498"),
    ("20260930130000", "directory_role_control", "bb6f16f9e16979abd1993f357e28f75ca3b457037a5ddcfa0b5e5dad47e7a521"),
    ("20260930150000", "scheduled_employee_offboarding", "d616f548e4e88213596536f8790ea76db95b1072898aac1305a2f38708f0ed87"),
)
PREDECESSOR = ("20260923170000", "employee_team_directory")
FUNCTIONS = (
    (("private.employee_calendar_peer_ids(uuid)", "private"),
     ("private.manager_calendar_team_ids(uuid)", "private"),
     ("public.list_leave_calendar_entries()", "authenticated"),
     ("public.list_leave_calendar_entries_for_preview(uuid)", "authenticated")),
    (("private.notification_event_key_valid(text)", "private_invoker"),
     ("private.sync_employee_onboarding_credentials()", "private"),
     ("private.guard_onboarding_credential_send()", "private"),
     ("public.claim_due_onboarding_credentials(integer)", "service_role"),
     ("public.begin_onboarding_credential_delivery(uuid,uuid,text,text,text)", "service_role"),
     ("public.complete_onboarding_credential_delivery(uuid,uuid)", "service_role"),
     ("public.fail_onboarding_credential_delivery(uuid,uuid,text)", "service_role")),
    (("public.list_employee_directory_roles()", "authenticated"),
     ("public.update_employee_directory_role(uuid,text,text)", "authenticated")),
    (("public.schedule_employee_offboarding(uuid,bigint,bigint,date,text)", "authenticated"),
     ("private.sync_scheduled_employee_offboarding()", "private"),
     ("public.list_scheduled_employee_offboarding()", "service_role"),
     ("public.run_scheduled_employee_offboarding(uuid,timestamptz)", "service_role"),
     ("private.prevent_late_offboarding_account_link()", "private"),
     ("public.claim_scheduled_offboarding_auth_ban(uuid,uuid)", "service_role"),
     ("public.record_scheduled_offboarding_auth_ban(uuid,uuid,uuid,boolean)", "service_role"),
     ("public.confirm_scheduled_offboarding_auth_ban(uuid)", "service_role")),
)
TABLES = ((), ("private.employee_onboarding_credentials", "private.employee_onboarding_credential_events"),
          (), ("private.scheduled_employee_offboarding",))


def require(ok, message):
    if not ok:
        raise SystemExit(message)


def literal(value):
    return "'" + value.replace("'", "''") + "'"


def api(path, body=None):
    request = urllib.request.Request(
        f"https://api.supabase.com/v1/projects/{PROJECT}{path}",
        headers={"Authorization": "Bearer " + os.environ["SUPABASE_ACCESS_TOKEN"],
                 "Content-Type": "application/json", "User-Agent": "supabase-cli/2.54.11"},
        data=None if body is None else json.dumps(body).encode(),
    )
    with urllib.request.urlopen(request, timeout=90) as response:
        return json.load(response)


def query(sql):
    return api("/database/query", {"query": sql})


def function_state(signature, role):
    rows = query(f"""select p.proowner = 'postgres'::regrole as owner_ok,
      p.prosecdef = {str(role != 'private_invoker').lower()} as definer_ok, p.proconfig = array['search_path=""']::text[] as search_path_ok,
      has_function_privilege('anon',p.oid,'EXECUTE') = false as anon_denied,
      has_function_privilege('authenticated',p.oid,'EXECUTE') = {str(role == 'authenticated').lower()} as authenticated_ok,
      has_function_privilege('service_role',p.oid,'EXECUTE') = {str(role == 'service_role').lower()} as service_ok,
      not exists (select 1 from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
        where a.privilege_type = 'EXECUTE' and
        (a.is_grantable or a.grantee not in
          (p.proowner{', ' + literal(role) + '::regrole::oid' if role in ('authenticated', 'service_role') else ''}))) as acl_ok
    from pg_proc p where p.oid = to_regprocedure({literal(signature)})""")
    return all(rows[0].values()) if len(rows) == 1 else None


def table_state(table):
    rows = query(f"""select c.relrowsecurity as rls_ok, c.relforcerowsecurity as force_rls_ok,
      not has_table_privilege('anon',c.oid,'SELECT,INSERT,UPDATE,DELETE') as anon_denied,
      not has_table_privilege('authenticated',c.oid,'SELECT,INSERT,UPDATE,DELETE') as authenticated_denied
      from pg_class c where c.oid = to_regclass({literal(table)})""")
    return all(rows[0].values()) if len(rows) == 1 else None


def schema_state(index):
    functions = {sig: function_state(sig, role) for sig, role in FUNCTIONS[index]}
    tables = {table: table_state(table) for table in TABLES[index]}
    return {"functions": functions, "tables": tables}


def calendar_boundary(applied):
    rows = query("""select
      exists(select 1 from pg_constraint where conrelid=to_regclass('private.employee_directory_details')
        and conname='employee_directory_details_canonical_team' and convalidated
        and position('Operation & Accounts' in pg_get_constraintdef(oid)) > 0) as new_team_constraint,
      exists(select 1 from pg_trigger where tgrelid=to_regclass('private.employee_directory_details')
        and tgname='employee_directory_details_sync_employee_check_in_manager_email' and tgenabled='O') as reminder_trigger_enabled,
      position('nearest peer_manager' in pg_get_functiondef('private.employee_calendar_peer_ids(uuid)'::regprocedure)) > 0
        as nearest_manager_scope""")
    require(len(rows) == 1 and rows[0]["reminder_trigger_enabled"], "Calendar predecessor trigger differs")
    require(rows[0]["new_team_constraint"] == applied and
            rows[0]["nearest_manager_scope"] == applied, "Calendar team/manager scope differs from ledger")


def source(entry):
    version, name, digest = entry
    sql = (ROOT / f"{version}_{name}.sql").read_text()
    require(hashlib.sha256(sql.encode()).hexdigest() == digest, "Pinned source hash differs: " + version)
    return sql


def ledger(version):
    return query("select version,name,statements from supabase_migrations.schema_migrations where version=" + literal(version))


def checked_record(entry, sql):
    rows = ledger(entry[0])
    require(len(rows) <= 1, "Duplicate migration ledger version: " + entry[0])
    if rows:
        require(rows[0]["name"] == entry[1] and rows[0]["statements"] == [sql],
                "Migration ledger differs from pinned source: " + entry[0])
    return bool(rows)


def release_sql(sql, entry):
    if sql.startswith("begin;\n") and sql.rstrip().endswith("commit;") and sql.count("\ncommit;") == 1:
        body = sql[len("begin;\n"):sql.rfind("\ncommit;")]
    else:
        require(not re.search(r"\b(begin|commit|rollback)\s*;", sql, re.I), "Unexpected transaction structure")
        body = sql
    history = ("insert into supabase_migrations.schema_migrations(version,name,statements) values("
               + literal(entry[0]) + "," + literal(entry[1]) + ",ARRAY[" + literal(sql) + "]);")
    return ("begin;\nset local lock_timeout='5s';\nset local statement_timeout='75s';\n"
            + body + "\n" + history + "\nnotify pgrst,'reload schema';\ncommit;\n")


def main(argv=None):
    args = sys.argv[1:] if argv is None else argv
    require(args and args[0] in ("inspect", "apply"), "Use inspect or apply <version> <reviewed-sha256>")
    require((args[0] == "inspect" and len(args) == 1) or
            (args[0] == "apply" and len(args) == 3 and re.fullmatch(r"[0-9a-f]{64}", args[2])),
            "Use inspect or apply <version> <reviewed-sha256>")
    sources = [source(entry) for entry in MIGRATIONS]
    index = None
    if args[0] == "apply":
        index = next((i for i, e in enumerate(MIGRATIONS) if e[0] == args[1]), None)
        require(index is not None and args[2] == MIGRATIONS[index][2], "Reviewed migration hash/version differs")
    project = api("")
    require(project.get("id") == PROJECT and project.get("organization_id") == ORGANISATION,
            "MAM Supabase target mismatch")
    predecessor = ledger(PREDECESSOR[0])
    require(len(predecessor) == 1 and predecessor[0]["name"] == PREDECESSOR[1],
            "Expected predecessor migration missing")
    recorded = [checked_record(entry, sql) for entry, sql in zip(MIGRATIONS, sources)]
    require(recorded == sorted(recorded, reverse=True), "Lifecycle migration ledger has a gap")
    if index is not None:
        require(all(recorded[:index]), "Apply predecessor migrations in release order")
        require(not any(recorded[index + 1:]) or recorded[index], "Later migration recorded before target")
    states = [schema_state(i) for i in range(len(MIGRATIONS))]
    calendar_boundary(recorded[0])
    for i, state in enumerate(states):
        if recorded[i]:
            require(all(state["functions"].values()) and all(state["tables"].values()),
                    "Recorded migration has unsafe deployed ACL/schema: " + MIGRATIONS[i][0])
        else:
            existing = {sig for sig, _ in FUNCTIONS[i] if i == 0 or
                        sig == "private.notification_event_key_valid(text)"}
            require(all(state["functions"][sig] is None for sig in state["functions"] if sig not in existing)
                    and all(value is None for value in state["tables"].values()), "Unrecorded migration has deployed objects: " + MIGRATIONS[i][0])
            if i == 1:
                require(state["functions"]["private.notification_event_key_valid(text)"] is True,
                        "Notification key predecessor ACL/schema differs")
    if not recorded[0]:
        require(all(states[0]["functions"].values()), "Calendar predecessor ACL/schema differs")
    print(json.dumps({"verifiedProject": PROJECT, "predecessorRecorded": True,
                      "migrations": [{"version": entry[0], "sha256": entry[2], "recorded": recorded[i],
                                      "schema": states[i]} for i, entry in enumerate(MIGRATIONS)]}, indent=2))
    if index is None or recorded[index]:
        return
    query(release_sql(sources[index], MIGRATIONS[index]))
    require(checked_record(MIGRATIONS[index], sources[index]), "Applied migration ledger read-back failed")
    state = schema_state(index)
    require(all(state["functions"].values()) and all(state["tables"].values()),
            "Post-migration ACL/schema verification failed")
    if index == 0:
        calendar_boundary(True)
    print(json.dumps({"appliedAndVerified": MIGRATIONS[index][0]}))


if __name__ == "__main__":
    main()
