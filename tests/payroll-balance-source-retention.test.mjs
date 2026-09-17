import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const ts = require("typescript");

function load(file, imports = {}) {
  const code = ts.transpileModule(readFileSync(file, "utf8"), {
    compilerOptions: {
      esModuleInterop: true,
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  const moduleUnderTest = { exports: {} };
  new Function("require", "module", "exports", code)((id) => {
    if (id in imports) return imports[id];
    throw new Error(`Unexpected import: ${id}`);
  }, moduleUnderTest, moduleUnderTest.exports);
  return moduleUnderTest.exports;
}

test("raw payroll files are archived privately before parsing and retained for at least 30 days", () => {
  const migration = readFileSync("supabase/migrations/20260918100000_payroll_balance_source_file_retention.sql", "utf8");
  assert.match(migration, /'payroll-balance-archives',[\s\S]*?false,[\s\S]*?500000/);
  assert.match(migration, /retain_until timestamptz not null default \(now\(\) \+ interval '30 days'\)/);
  assert.match(migration, /check \(retain_until >= created_at \+ interval '30 days'\)/);
  assert.match(migration, /where archive\.deleted_at is null\s+and archive\.retain_until <= clock_timestamp\(\)/);
  assert.match(migration, /alter table private\.payroll_balance_source_archives enable row level security/);
  assert.doesNotMatch(migration, /create policy[\s\S]*payroll-balance-archives/i);
  assert.doesNotMatch(migration, /grant execute[\s\S]*to authenticated/);

  const action = readFileSync("src/app/payroll-balances/actions.ts", "utf8");
  assert.ok(action.indexOf("archivePayrollBalanceFiles(actorUserId, preparedFiles)")
    < action.indexOf("parsePreparedPayrollBalanceFiles(preparedFiles)"));
  assert.match(action, /markPayrollBalanceSourceArchivesFailed\(actorUserId, archiveIds\)/);
  assert.match(action, /linkPayrollBalanceSourceArchives\(actorUserId, archiveIds, batch\.batchId\)/);
});

test("payroll source archiver creates plans, uploads only to the private bucket and completes each record", async () => {
  const firstId = "10000000-0000-4000-8000-000000000001";
  const secondId = "10000000-0000-4000-8000-000000000002";
  const actorId = "10000000-0000-4000-8000-000000000003";
  const plans = [firstId, secondId].map((archiveId, index) => ({
    archiveId,
    storagePath: `${archiveId}/20000000-0000-4000-8000-00000000000${index + 1}.${index ? "xlsx" : "csv"}`,
  }));
  const calls = [];
  const admin = {
    async rpc(name, args) {
      calls.push(["rpc", name, args]);
      if (name === "prepare_payroll_balance_source_archive") return { data: plans.shift(), error: null };
      if (name === "complete_payroll_balance_source_archive") return { data: null, error: null };
      throw new Error(`Unexpected RPC: ${name}`);
    },
    storage: { from(bucket) {
      assert.equal(bucket, "payroll-balance-archives");
      return { async upload(path, bytes, options) {
        calls.push(["upload", path, bytes.toString("utf8"), options]);
        return { data: { path }, error: null };
      } };
    } },
  };
  const { archivePayrollBalanceFiles } = load("src/lib/payroll-balance-source-archive.ts", {
    "server-only": {},
    "@/lib/supabase/admin": { createAdminClient: () => admin },
  });
  const files = [
    { name: "mam.csv", mimeType: "text/csv", sizeBytes: 3, sha256: "a".repeat(64), buffer: Buffer.from("mam") },
    { name: "equipsy.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", sizeBytes: 7, sha256: "b".repeat(64), buffer: Buffer.from("equipsy") },
  ];

  assert.deepEqual(await archivePayrollBalanceFiles(actorId, files), [firstId, secondId]);
  assert.deepEqual(calls.map((call) => call[0] === "rpc" ? call[1] : call[0]), [
    "prepare_payroll_balance_source_archive",
    "upload",
    "complete_payroll_balance_source_archive",
    "prepare_payroll_balance_source_archive",
    "upload",
    "complete_payroll_balance_source_archive",
  ]);
  assert.deepEqual(calls[1][3], { cacheControl: "0", contentType: "text/csv", upsert: false });
});

test("daily private-file maintenance deletes only database-expired payroll archives", async () => {
  const firstId = "10000000-0000-4000-8000-000000000001";
  const secondId = "10000000-0000-4000-8000-000000000002";
  const archives = [firstId, secondId].map((archive_id, index) => ({
    archive_id,
    storage_path: `${archive_id}/20000000-0000-4000-8000-00000000000${index + 1}.csv`,
    was_uploaded: true,
  }));
  let archiveRead = 0;
  const calls = [];
  const admin = {
    async rpc(name, args) {
      calls.push([name, args]);
      if (name === "list_stale_leave_attachment_orphans") return { data: [], error: null };
      if (name === "list_expired_payroll_balance_source_archives") {
        archiveRead += 1;
        return { data: archiveRead === 1 ? archives : [], error: null };
      }
      if (name === "complete_payroll_balance_source_archive_deletion") return { data: 2, error: null };
      if (name === "prune_expired_leave_attachment_upload_intents") return { data: 1, error: null };
      if (name === "prune_expired_leave_attachment_upload_attempts") return { data: 2, error: null };
      throw new Error(`Unexpected RPC: ${name}`);
    },
    storage: { from(bucket) {
      assert.equal(bucket, "payroll-balance-archives");
      return { async remove(paths) {
        assert.deepEqual(paths, archives.map((archive) => archive.storage_path));
        return { data: [{ name: paths[0] }, { name: paths[1] }], error: null };
      } };
    } },
  };
  const { runLeaveAttachmentMaintenance } = load("src/lib/leave-attachment-maintenance.ts", {
    "server-only": {},
    "@/lib/supabase/admin": { createAdminClient: () => admin },
  });

  const result = await runLeaveAttachmentMaintenance();
  assert.equal(result.removedPayrollSourceFiles, 2);
  assert.equal(result.prunedPayrollArchiveRecords, 2);
  assert.deepEqual(calls.find(([name]) => name === "complete_payroll_balance_source_archive_deletion")[1], {
    p_archive_ids: [firstId, secondId],
  });
});

test("Balance UI hides access management during employee preview and removes explanatory copy", () => {
  const importer = readFileSync("src/components/payroll-balance-importer.tsx", "utf8");
  const leave = readFileSync("src/components/leave-demo.tsx", "utf8");
  assert.match(importer, /workspace\.canManageAccess && !hideManagementControls/);
  assert.match(leave, /hideManagementControls=\{isPreviewingEmployeeAccess\}/);
  for (const removed of [
    "Upload CSV or Excel exports. Every row is previewed before any balance changes.",
    "The reminder renews on the first of every month",
    "Names are normalised for punctuation and spacing",
  ]) assert.doesNotMatch(importer, new RegExp(removed.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});
