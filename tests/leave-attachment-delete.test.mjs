import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const actions = readFileSync("src/app/leave/actions.ts", "utf8");
const migration = readFileSync(
  "supabase/migrations/20260916090000_leave_balance_tab_attachment_owner_delete.sql",
  "utf8",
);

test("attachment deletion is re-authorised against immutable uploader ownership", () => {
  assert.match(
    migration,
    /v_attachment\.uploaded_by is distinct from v_actor_user_id/,
  );
  assert.match(
    migration,
    /grant execute on function public\.delete_my_leave_request_attachment\(uuid\)\s+to authenticated;/,
  );
  assert.match(
    migration,
    /attachment\.uploaded_by = v_actor_user_id/,
  );
  assert.doesNotMatch(
    migration,
    /grant\s+delete\s+on\s+(?:table\s+)?public\.leave_request_attachments\s+to\s+authenticated/i,
  );
});

test("the server action validates IDs and never returns the private storage path", () => {
  assert.match(
    actions,
    /function normaliseDeleteAttachmentInput[\s\S]*UUID_PATTERN\.test\(attachmentId\)/,
  );
  assert.match(
    actions,
    /supabase\.rpc\("delete_my_leave_request_attachment",\s*\{\s*p_attachment_id: checked\.attachmentId/,
  );
  assert.match(
    actions,
    /return \{ id: attachmentId \};/,
  );
  assert.doesNotMatch(
    actions,
    /return \{ id: attachmentId, storagePath/,
  );
});
