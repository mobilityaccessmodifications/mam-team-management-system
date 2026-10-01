import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const predecessor = readFileSync('supabase/migrations/20261001130000_confirmed_test_identity_cleanup.sql', 'utf8');
const forward = readFileSync('supabase/migrations/20261001140000_confirmed_test_purge_delivered_leave_history.sql', 'utf8');

test('delivered-history forward preserves exact applied predecessor bytes', () => {
  assert.equal(createHash('sha256').update(predecessor).digest('hex'), '3a48916a56e113ad1845d32e437b23b9bb9ad328b981e8d915debaf847ce0be0');
  assert.match(forward, /^begin;\n/);
  assert.match(forward, /\ncommit;\s*$/);
});

test('delivered-history forward pins every replaced predecessor body and the unchanged schema hash implementation', () => {
  for (const name of ['private.confirmed_test_purge_census', 'public.prepare_confirmed_test_identity_purge', 'private.reject_retired_test_identity_reference', 'public.complete_confirmed_test_identity_purge', 'private.confirmed_test_purge_schema_hash']) {
    const escaped = name.replaceAll('.', '\\.');
    const source = predecessor.match(new RegExp(`create function ${escaped}\\(.*?\\$\\$(.*?)\\$\\$;`, 's'))?.[1];
    assert.equal(typeof source, 'string', name);
    assert.ok(forward.includes(createHash('sha256').update(source).digest('hex')), `Missing exact ${name} body pin`);
  }
  assert.match(forward, /normalized_hash is distinct from previous_hash/);
  assert.match(forward, /where singleton and schema_hash=previous_hash/);
  assert.doesNotMatch(forward, /disable trigger|session_replication_role|delete from private\.notification_delivery_receipts|alter table .* owner|grant .*fixture_storage_owner/i);
});
