// Explicitly approved production migration only. Inspect never changes data.
// Run through MAM's codex-project-credential exec supabase route.
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

const projectId = "xtwlrjqbusadghavchqm";
const organizationId = "fwlmbmospuwoaosffvmw";
const version = "20260920120000";
const name = "openclaw_quoted_confirm";
const prerequisites = ["20260917223558", "20260918120000"];
const operation = process.argv[2];
const requireCondition = (condition, message) => { if (!condition) throw new Error(message); };
const literal = value => `'${value.replaceAll("'", "''")}'`;
const hash = (algorithm, value) => createHash(algorithm).update(value).digest("hex");
const readMigration = file => readFileSync(new URL(`../supabase/migrations/${file}.sql`, import.meta.url), "utf8");
const sql = readMigration(`${version}_${name}`);
const original = readMigration("20260917223558_openclaw_leave_bridge");
const sha256 = hash("sha256", sql);
const signatures = ["private.openclaw_leave_people()", "private.openclaw_leave_commit(text,text,text,text,jsonb,uuid,jsonb,jsonb,boolean)"];
const bodyHash = (source, signature) => {
  const start = source.indexOf(`function ${signature.split("(")[0]}(`);
  requireCondition(start >= 0, "Function source missing");
  const body = source.slice(start).match(/as \$\$([\s\S]*?)\$\$;/)?.[1];
  requireCondition(typeof body === "string", "Function body missing");
  return hash("md5", body);
};
const oldHashes = signatures.map(signature => bodyHash(original, signature));
const newHashes = signatures.map(signature => bodyHash(sql, signature));

requireCondition(["inspect", "apply"].includes(operation), "Use inspect or apply <reviewed-sha256>");
requireCondition(process.env.CODEX_COMPANY_PROFILE === "mam", "MAM credential helper required");
requireCondition(!!process.env.SUPABASE_ACCESS_TOKEN, "Scoped management credential required");
async function api(path, body) {
  const response = await fetch(`https://api.supabase.com/v1/projects/${projectId}${path}`, {
    method: body ? "POST" : "GET",
    headers: { Authorization: `Bearer ${process.env.SUPABASE_ACCESS_TOKEN}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(90_000),
  });
  requireCondition(response.ok, `Management API status ${response.status}`);
  return response.json();
}
const query = query => api("/database/query", { query });
const project = await api("");
requireCondition(project.id === projectId && project.organization_id === organizationId, "MAM Supabase target mismatch");
const historyQuery = `select version,statements from supabase_migrations.schema_migrations where version=${literal(version)}`;
const historyMatches = rows => rows.length === 1 && rows[0].statements?.length === 1 && rows[0].statements[0] === sql;
const history = await query(historyQuery);
requireCondition(!history.length || historyMatches(history), "Recorded migration differs; do not overwrite");

const prerequisiteCheck = prerequisites.map(item => `exists(select 1 from supabase_migrations.schema_migrations where version=${literal(item)})`).join(" and ");
const bodyCheck = hashes => signatures.map((signature, index) => `(select md5(prosrc) from pg_proc where oid=to_regprocedure(${literal(signature)}))=${literal(hashes[index])}`).join(" and ");
// Keep the public service-only facades and private helpers just as restricted.
const permissionsCheck = `not exists(
 select 1 from unnest(array['public.openclaw_leave_snapshot(text,uuid)',
 'public.openclaw_leave_commit(text,text,text,text,jsonb,uuid,jsonb,jsonb,boolean)',
 'public.openclaw_self_profile_snapshot()',${signatures.map(literal).join(",")}]) s(signature)
 left join pg_proc p on p.oid=to_regprocedure(s.signature)
 where p.oid is null or not p.prosecdef or not coalesce(p.proconfig @> array['search_path=""'],false)
 or has_function_privilege('anon',p.oid,'execute')
 or has_function_privilege('authenticated',p.oid,'execute')
 or has_function_privilege('service_role',p.oid,'execute') is distinct from (s.signature like 'public.%')
 or exists(select 1 from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a where a.grantee=0 and a.privilege_type='EXECUTE'))`;
const inspect = async () => (await query(`select ${prerequisiteCheck} as prerequisites,
 coalesce((${bodyCheck(oldHashes)}),false) as legacy_bodies,
 coalesce((${bodyCheck(newHashes)}),false) as quoted_confirm_bodies,
 ${permissionsCheck} as service_only_permissions`))[0];
let state = await inspect();
requireCondition(state.prerequisites && state.service_only_permissions, "Missing prerequisite or permissions drift");
requireCondition(history.length ? state.quoted_confirm_bodies : state.legacy_bodies, "Function drift requires review; do not overwrite");

if (operation === "apply") {
  requireCondition(process.argv[3] === sha256, "Reviewed migration hash mismatch");
  if (!history.length) {
    requireCondition(sql.startsWith("begin;") && sql.split("\ncommit;").length === 2, "Unexpected transaction structure");
    const guard = `do $mam$ begin
 if not coalesce((${prerequisiteCheck}) and (${bodyCheck(oldHashes)}) and (${permissionsCheck}),false)
 then raise exception 'OpenClaw prerequisite, function or permission drift'; end if; end $mam$;`;
    const record = `insert into supabase_migrations.schema_migrations(version,name,statements) values(${literal(version)},${literal(name)},ARRAY[${literal(sql)}]);`;
    await query(sql.replace("begin;", `begin;\nset local lock_timeout='5s';\nset local statement_timeout='60s';\n${guard}`)
      .replace("\ncommit;", `\n${record}\nnotify pgrst,'reload schema';\ncommit;`));
  }
  state = await inspect();
  requireCondition(state.prerequisites && state.quoted_confirm_bodies && state.service_only_permissions && historyMatches(await query(historyQuery)), "Incomplete quoted-Confirm deployment");
}
console.log(JSON.stringify({ projectId, organizationId, operation, sha256, recorded: operation === "apply" || !!history.length, ...state }));
