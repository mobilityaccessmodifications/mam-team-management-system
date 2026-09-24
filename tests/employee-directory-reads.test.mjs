import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const source = ts.transpileModule(readFileSync('src/lib/employee-directory.ts', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const directory = { exports: {} };
new Function('require', 'module', 'exports', source)((id) => ({
  'server-only': {},
  '@/lib/supabase/server': { createClient: async () => { throw new Error('tests pass their own client'); } },
})[id] ?? require(id), directory, directory.exports);

const personId = '10000000-0000-4000-8000-000000000001';
const row = {
  person_id: personId, person_version: 3, detail_version: 4, company_key: 'mam', is_active: true,
  first_name: 'Taylor', last_name: 'Synthetic', full_name: 'Taylor Synthetic', position_title: 'Coordinator',
  team_name: 'MAM admin', manager_id: null, manager_name: null, work_email: null, personal_email: null, phone: null,
  country: null, address: null, date_of_birth: null, started_date: '2026-09-01', scheduled_employment_end_date: null,
  working_weekdays: null, working_day_times: [], archive_reason: null, employment_type: 'full_time',
  has_paid_leave_entitlement: true, laptop_supplied: null, laptop_id: null, mouse_id: null, keyboard_id: null, asset_tags: [],
};

// Each RPC stays pending until the test releases it, to prove the record and
// classification reads are issued together rather than one after the other.
function deferredClient() {
  const pending = new Map();
  const client = { rpc: (name) => new Promise((resolve) => pending.set(name, resolve)) };
  return { client, pending };
}

test('directory list and single-record reads fetch contract types concurrently', async () => {
  for (const [load, recordRpc, data] of [
    [(client) => directory.exports.listEmployeeDirectoryRecordsWithClient(client), 'list_employee_directory_records_with_work_schedule_times', [row]],
    [(client) => directory.exports.findEmployeeDirectoryRecord(client, personId), 'get_employee_directory_record_with_work_schedule_times', [row]],
  ]) {
    const { client, pending } = deferredClient();
    const result = load(client);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual([...pending.keys()].sort(), [recordRpc, 'list_employee_check_in_contract_classifications'].sort());
    pending.get('list_employee_check_in_contract_classifications')({ data: [{ person_id: personId, contract_type: 'permanent' }], error: null });
    pending.get(recordRpc)({ data, error: null });
    const records = await result;
    const record = Array.isArray(records) ? records[0] : records;
    assert.equal(record.personId, personId);
    assert.equal(record.contractType, 'permanent');
    assert.equal(record.detailVersion, 4);
  }
});
