// Run via MAM's codex-project-credential exec supabase route. Prints only schema
// state; never reads employee values. Apply requires the reviewed file SHA-256.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const projectId = 'xtwlrjqbusadghavchqm';
const organizationId = 'fwlmbmospuwoaosffvmw';
const version = '20260917045203';
const name = 'openclaw_phone_allowlist';
const operation = process.argv[2];
function requireCondition(condition, message) { if (!condition) throw new Error(message); }
requireCondition(['inspect', 'apply'].includes(operation), 'Use inspect or apply <reviewed-sha256>');
requireCondition(process.env.CODEX_COMPANY_PROFILE === 'mam', 'MAM credential helper required');
requireCondition(!!process.env.SUPABASE_ACCESS_TOKEN, 'Scoped management credential required');
async function api(path, body) {
  const response = await fetch(`https://api.supabase.com/v1/projects/${projectId}${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { Authorization: `Bearer ${process.env.SUPABASE_ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(90000),
  });
  requireCondition(response.ok, `Management API status ${response.status}`);
  return response.json();
}
const query = (sql) => api('/database/query', { query: sql });
const literal = (value) => "'" + value.replaceAll("'", "''") + "'";
const project = await api('');
requireCondition(project.id === projectId && project.organization_id === organizationId, 'MAM target mismatch');
const sql = readFileSync(new URL(`../supabase/migrations/${version}_${name}.sql`, import.meta.url), 'utf8');
const sha256 = createHash('sha256').update(sql).digest('hex');
const rows = await query(`select version, statements from supabase_migrations.schema_migrations where version=${literal(version)}`);
if (rows.length) {
  requireCondition(rows.length === 1 && rows[0].statements?.length === 1 && rows[0].statements[0] === sql, 'Recorded migration differs; do not overwrite');
}
if (operation === 'apply') {
  requireCondition(process.argv[3] === sha256, 'Reviewed migration hash mismatch');
  if (!rows.length) {
    requireCondition(sql.startsWith('begin;') && sql.split('\ncommit;').length === 2, 'Unexpected transaction structure');
    const history = `insert into supabase_migrations.schema_migrations(version,name,statements) values(${literal(version)},${literal(name)},ARRAY[${literal(sql)}]);`;
    await query(sql.replace('begin;', "begin;\nset local lock_timeout='5s';\nset local statement_timeout='60s';")
      .replace('\ncommit;', `\n${history}\nnotify pgrst,'reload schema';\ncommit;`));
  }
}
const state = await query(`select
  to_regprocedure('public.openclaw_whatsapp_allowlist_snapshot()') is not null as public_function,
  to_regprocedure('private.openclaw_whatsapp_allowlist_snapshot()') is not null as private_function,
  exists(select 1 from supabase_migrations.schema_migrations where version=${literal(version)}) as recorded`);
if (state[0].public_function && state[0].private_function) {
  const permissions = await query(`select
    has_function_privilege('service_role','public.openclaw_whatsapp_allowlist_snapshot()','execute') as service_allowed,
    not has_function_privilege('anon','public.openclaw_whatsapp_allowlist_snapshot()','execute') as anon_denied,
    not has_function_privilege('authenticated','public.openclaw_whatsapp_allowlist_snapshot()','execute') as employee_denied,
    not has_function_privilege('anon','private.openclaw_whatsapp_allowlist_snapshot()','execute') as private_anon_denied,
    not has_function_privilege('authenticated','private.openclaw_whatsapp_allowlist_snapshot()','execute') as private_employee_denied`);
  requireCondition(Object.values(permissions[0]).every(Boolean), 'Function privileges unsafe');
  state[0].permissionsVerified = true;
}
if (operation === 'apply') requireCondition(Object.values(state[0]).every(Boolean), 'Incomplete deployment');
console.log(JSON.stringify({ projectId, operation, sha256, ...state[0] }));
