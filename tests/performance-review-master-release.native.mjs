import assert from 'node:assert/strict';
import {before, after, test} from 'node:test';
import {readFileSync, writeFileSync, mkdtempSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
import {ownedCluster, env, evidence, q, rows} from './performance-review-production-harness.mjs';

let c, expression, ordinal = 0;
const template = 'mam_test_pr_master_release_template';
const output = mkdtempSync(path.join(evidence, 'master-envelope-'));
function bridge(...args) {
  const r = spawnSync('python3', ['-B', 'tests/performance-review-master-release-builder.py', ...args], {env, encoding: 'utf8', timeout: 30000, maxBuffer: 16 * 1024 * 1024});
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
}
const observe = db => rows(c.sql(db, expression))[0];
function prepare() {
  const db = 'mam_test_pr_master_release_' + String(++ordinal);
  c.sql('postgres', `create database ${db} template ${template};`);
  const before = observe(db);
  const file = path.join(output, ordinal + '.before.json');
  writeFileSync(file, JSON.stringify(before));
  const sql = bridge('build', file);
  writeFileSync(path.join(output, ordinal + '.generated.sql'), sql);
  return {db, before, file, sql};
}
before(() => {
  c = ownedCluster(17);
  c.setup(template);
  const predecessor = readFileSync('supabase/migrations/20261016150000_performance_reviews_and_mail.sql', 'utf8');
  c.sql(template, `create schema supabase_migrations; create table supabase_migrations.schema_migrations(version text primary key,name text,statements text[]);
    insert into supabase_migrations.schema_migrations values('20260101000000','synthetic_null',null),('20260101000001','synthetic_empty','{}'),('20260101000002','synthetic_bounds','[0:2]={"synthetic-a",NULL,"synthetic-b"}'),('20261016150000','performance_reviews_and_mail',ARRAY[${q(predecessor)}]);
    create schema synthetic_external;create table synthetic_external.protected(id integer);alter table synthetic_external.protected enable row level security;
    create function synthetic_external.late_grant() returns trigger language plpgsql as $$ begin if current_setting('synthetic.master_late',true)='yes' then grant select on synthetic_external.protected to authenticated;end if;return new;end $$;
    create constraint trigger master_late after insert on supabase_migrations.schema_migrations deferrable initially deferred for each row execute function synthetic_external.late_grant();`);
  const completion = readFileSync('supabase/migrations/20261017103000_performance_review_completion_guards.sql', 'utf8');
  c.sql(template, completion);
  c.sql(template, `insert into supabase_migrations.schema_migrations values('20261017103000','performance_review_completion_guards',ARRAY[${q(completion)}]);revoke select on synthetic_external.protected from authenticated;`);
  expression = bridge('expression');
});
after(() => c?.stop());

test('Master continuation commits exact source and independently preserves complete native history and security', () => {
  const s = prepare();
  const r = c.run(s.db, s.sql);
  assert.equal(r.status, 0, r.stderr);
  const hashes = [...r.stdout.matchAll(/^([0-9a-f]{64})$/gm)];
  assert.equal(hashes.length, 1);
  const after = observe(s.db);
  const file = path.join(output, 'positive.after.json');
  writeFileSync(file, JSON.stringify(after));
  assert.equal(after.targetExact, true);
  assert.deepEqual(after.ledger.slice(0, -1), s.before.ledger);
  assert.equal(after.securityHash, s.before.securityHash);
  assert.equal(after.dataHash, s.before.dataHash);
  assert.equal(JSON.parse(bridge('validate', s.file, file, hashes[0][1])).readbackVerified, true);
  assert.equal(c.sql(s.db, 'select not enabled and not writer_admitted and binding is null and capture_after is null and not held from private.performance_review_master_targets;').trim(), 't');
});

test('Master continuation rolls back a genuinely deferred final-ledger security effect', () => {
  const s = prepare();
  const marker = '\ninsert into supabase_migrations.schema_migrations(version,name,statements) values(';
  assert.equal(s.sql.split(marker).length, 2);
  const injected = s.sql.replace(marker, () => "\nset local synthetic.master_late='yes';set constraints supabase_migrations.master_late deferred;" + marker);
  const r = c.run(s.db, injected);
  assert.equal(r.status, 3, r.stderr);
  assert.match(r.stderr, /55000/);
  assert.deepEqual(observe(s.db), s.before);
  assert.equal(c.sql(s.db, "select to_regclass('private.performance_review_master_targets') is null;").trim(), 't');
});
