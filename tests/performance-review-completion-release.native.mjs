import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {ownedCluster} from './performance-review-production-harness.mjs';
const migration='supabase/migrations/20261017103000_performance_review_completion_guards.sql';

test('completion migration refuses unrelated predecessor drift instead of refreshing its fingerprint',()=>{
 const c=ownedCluster(17);
 try {
  const db='mam_test_pr_completion_release';c.setup(db);
  c.sql(db,"grant select on public.profiles to authenticated;");
  const before=c.sql(db,"select private.confirmed_test_purge_schema_hash(),(select schema_hash from private.confirmed_test_purge_schema where singleton);");
  const r=c.run(db,readFileSync(migration,'utf8'));
  assert.equal(r.status,3);assert.match(r.stderr,/55000/);
  assert.equal(c.sql(db,"select private.confirmed_test_purge_schema_hash(),(select schema_hash from private.confirmed_test_purge_schema where singleton);"),before);
  assert.equal(c.sql(db,"select to_regprocedure('private.performance_review_docx_bytes(jsonb)') is null;").trim(),'t');
 } finally {c.stop();}
});
