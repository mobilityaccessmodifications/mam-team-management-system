import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
const mod = {};
new Function('exports', ts.transpileModule(readFileSync('src/lib/leave-request-balance.ts', 'utf8'), {compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText)(mod);
test('banked request duration preserves full-time, part-time and explicit hours', () => {
  assert.equal(mod.requestedLeaveHours('2026-10-12','2026-10-12','','',7.6),7.6);
  assert.equal(mod.requestedLeaveHours('2026-10-12','2026-10-12','','',7.5),7.5);
  assert.equal(mod.requestedLeaveHours('2026-10-09','2026-10-12','','',7.6),15.2);
  assert.equal(mod.requestedLeaveHours('2026-10-12','2026-10-12','12:00','16:00',7.6),4);
  assert.equal(mod.requestedLeaveHours('2026-10-09','2026-10-12','12:00','16:00',7.6),16);
  assert.equal(mod.requestedLeaveHours('2026-10-12','2026-10-12','12:00','',7.6),null);
  assert.equal(mod.requestedLeaveHours('2026-10-11','2026-10-11','','',7.6),null);
});
test('signed card values are not made absolute and form shows request impact', () => {
  const code=readFileSync('src/components/leave-priority-controls.tsx','utf8');
  assert.ok(code.includes('negative ? -Math.abs(hours) : hours'));
  assert.ok(code.includes('This request uses'));
  assert.ok(code.includes('Remaining after this request'));
  assert.ok(code.includes('availableHours - requestedHours'));
});
test('database and server action share safe balance messages', () => {
  const sql=readFileSync('supabase/migrations/20260922140000_projected_annual_leave_request_limit.sql','utf8');
  for (const message of [mod.INSUFFICIENT_BALANCE_MESSAGE, mod.UNAVAILABLE_BALANCE_MESSAGE]) assert.ok(sql.includes(message));
  const actions=readFileSync('src/app/leave/actions.ts','utf8');
  assert.equal((actions.match(/if \(error\) return \{ error: userFacingSubmitError\(error\) \};/g) || []).length,2);
});
