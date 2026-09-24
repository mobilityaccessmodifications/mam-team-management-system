import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// A Realtime reload refreshes the record list while an editor keeps its draft.
// Saves must send the versions the draft was built from, never the reloaded
// record's versions, or the server's concurrency check silently passes.
test("HR directory saves against the versions its draft was opened from", () => {
  const source = readFileSync("src/components/employee-directory.tsx", "utf8");
  assert.match(source, /mode: "edit"; personId: string; personVersion: number; detailVersion: number; draft: EmployeeDirectoryDraft/);
  assert.match(source, /personVersion: editorToSave\.personVersion,\s*detailVersion: editorToSave\.detailVersion,\s*\};\s*const result = await updateEmployeeDirectoryRecord\(input\);/);
});

test("team directory saves against the versions its draft was opened from", () => {
  const source = readFileSync("src/components/manager-employee-directory.tsx", "utf8");
  assert.match(source, /setDraft\(toDraft\(record\)\);\s*setDraftVersions\(draftVersionsFor\(record\)\);/);
  assert.match(source, /personVersion: draftVersions\.personVersion,\s*detailVersion: draftVersions\.detailVersion,/);
  assert.doesNotMatch(source, /personVersion: selectedRecord\.personVersion/);
});

test("org chart edits send the version their dialog opened with", () => {
  const tree = readFileSync("src/components/organisation-tree.tsx", "utf8");
  const leave = readFileSync("src/components/leave-demo.tsx", "utf8");
  assert.match(tree, /reportsTo: profile\.reportsTo,\s*kind: "person",\s*expectedVersion: profile\.version,/);
  assert.match(tree, /reportsTo: draft\.reportsTo \|\| null,\s*kind: "person",\s*expectedVersion: draft\.expectedVersion,/);
  assert.match(leave, /p_expected_version: person\.expectedVersion \?\? current\.version,/);
});
