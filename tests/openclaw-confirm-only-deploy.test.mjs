import test from 'node:test';
import assert from 'node:assert/strict';
import {applyQuery,sha256,sql,bodyHash,signatures,projectId,organizationId} from '../scripts/deploy-openclaw-confirm-only.mjs';
test('v3 deployment helper import has no network and hash mismatch cannot generate migration',()=>{
 assert.equal(projectId,'xtwlrjqbusadghavchqm');assert.equal(organizationId,'fwlmbmospuwoaosffvmw');
 assert.throws(()=>applyQuery('0'.repeat(64)),/hash mismatch/);
});
test('deployment transaction preserves exact function bodies and dollar/regex literals',()=>{
 const query=applyQuery(sha256);
 for(const sig of signatures)assert.equal(bodyHash(query,sig),bodyHash(sql,sig));
 assert.match(query,/to_regprocedure\('public.openclaw_leave_v3_submit/);
 assert.match(query,/insert into supabase_migrations.schema_migrations/);
 // One COMMIT executes; a second is literal text in migration-history SQL.
 assert.equal(query.split('\ncommit;').length,3);
 assert.ok(query.endsWith('\ncommit;\n'));
 assert.ok(query.includes("^[A-Za-z0-9:_-]{1,128}$"));
});
