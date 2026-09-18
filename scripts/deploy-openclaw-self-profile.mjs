// Run only through MAM's codex-project-credential exec supabase route.
// Output is schema/ACL state only; employee names and phone numbers are never read.
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

const projectId = "xtwlrjqbusadghavchqm";
const organizationId = "fwlmbmospuwoaosffvmw";
const prerequisiteVersion = "20260917223558";
const version = "20260918120000";
const name = "openclaw_self_profile";
const operation = process.argv[2];

function requireCondition(condition, message) {
  if (!condition) throw new Error(message);
}

requireCondition(["inspect", "apply"].includes(operation), "Use inspect or apply <reviewed-sha256>");
requireCondition(process.env.CODEX_COMPANY_PROFILE === "mam", "MAM credential helper required");
requireCondition(!!process.env.SUPABASE_ACCESS_TOKEN, "Scoped management credential required");

async function api(path, body) {
  const response = await fetch(`https://api.supabase.com/v1/projects/${projectId}${path}`, {
    method: body ? "POST" : "GET",
    headers: {
      Authorization: `Bearer ${process.env.SUPABASE_ACCESS_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(90_000),
  });
  requireCondition(response.ok, `Management API status ${response.status}`);
  return response.json();
}

const query = (sql) => api("/database/query", { query: sql });
const literal = (value) => `'${value.replaceAll("'", "''")}'`;
const project = await api("");
requireCondition(
  project.id === projectId && project.organization_id === organizationId,
  "MAM Supabase target mismatch",
);

const migrationUrl = new URL(`../supabase/migrations/${version}_${name}.sql`, import.meta.url);
const sql = readFileSync(migrationUrl, "utf8");
const sha256 = createHash("sha256").update(sql).digest("hex");
const history = await query(
  `select version, statements from supabase_migrations.schema_migrations where version=${literal(version)}`,
);
if (history.length) {
  requireCondition(
    history.length === 1 && history[0].statements?.length === 1 && history[0].statements[0] === sql,
    "Recorded migration differs; do not overwrite",
  );
}

const prerequisite = (await query(`select
  exists(select 1 from supabase_migrations.schema_migrations where version=${literal(prerequisiteVersion)})
    as leave_bridge_recorded,
  to_regprocedure('public.openclaw_leave_snapshot(text,uuid)') is not null as leave_bridge_function`))[0];

if (operation === "apply") {
  requireCondition(process.argv[3] === sha256, "Reviewed migration hash mismatch");
  requireCondition(Object.values(prerequisite).every(Boolean), "OpenClaw leave bridge prerequisite unavailable");
  if (!history.length) {
    requireCondition(sql.startsWith("begin;") && sql.split("\ncommit;").length === 2, "Unexpected transaction structure");
    const record = "insert into supabase_migrations.schema_migrations(version,name,statements) values("
      + `${literal(version)},${literal(name)},ARRAY[${literal(sql)}]);`;
    const prerequisiteGuard = `do $mam$
begin
  if not exists(select 1 from supabase_migrations.schema_migrations where version=${literal(prerequisiteVersion)})
    or to_regprocedure('public.openclaw_leave_snapshot(text,uuid)') is null then
    raise exception 'OpenClaw leave bridge prerequisite unavailable';
  end if;
end
$mam$;`;
    const release = sql
      .replace("begin;", `begin;\nset local lock_timeout='5s';\nset local statement_timeout='60s';\n${prerequisiteGuard}`)
      .replace("\ncommit;", `\n${record}\nnotify pgrst,'reload schema';\ncommit;`);
    await query(release);
  }
}

const state = (await query(`select
  exists(select 1 from supabase_migrations.schema_migrations where version=${literal(prerequisiteVersion)})
    as leave_bridge_recorded,
  to_regprocedure('public.openclaw_leave_snapshot(text,uuid)') is not null as leave_bridge_function,
  to_regprocedure('public.openclaw_self_profile_snapshot()') is not null as public_function,
  to_regprocedure('private.openclaw_self_profile_people()') is not null as private_function,
  coalesce((select p.prorettype='jsonb'::regtype and p.provolatile='s'
    from pg_proc p where p.oid=to_regprocedure('public.openclaw_self_profile_snapshot()')),false)
    as public_contract,
  exists(select 1 from supabase_migrations.schema_migrations where version=${literal(version)}) as recorded`))[0];

if (state.public_function && state.private_function) {
  const permissions = (await query(`select
    has_function_privilege('service_role','public.openclaw_self_profile_snapshot()','execute') as service_allowed,
    not has_function_privilege('anon','public.openclaw_self_profile_snapshot()','execute') as anon_denied,
    not has_function_privilege('authenticated','public.openclaw_self_profile_snapshot()','execute') as employee_denied,
    not has_function_privilege('service_role','private.openclaw_self_profile_people()','execute') as private_service_denied,
    not has_function_privilege('anon','private.openclaw_self_profile_people()','execute') as private_anon_denied,
    not has_function_privilege('authenticated','private.openclaw_self_profile_people()','execute') as private_employee_denied`))[0];
  Object.assign(state, permissions);
}

if (operation === "apply") {
  requireCondition(Object.values(state).every(Boolean), "Incomplete self-profile deployment");
}

console.log(JSON.stringify({ projectId, organizationId, operation, sha256, ...state }));
