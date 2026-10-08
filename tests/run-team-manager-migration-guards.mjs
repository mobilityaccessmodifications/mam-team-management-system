import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { command, target } from '../scripts/local-test-postgres.mjs';

const snapshot = `select jsonb_build_object(
  'catalog',private.confirmed_test_purge_schema_hash(),
  'ledger',(select to_jsonb(s) from private.confirmed_test_purge_schema s where singleton),
  'routines',(select encode(extensions.digest(coalesce(string_agg(to_jsonb(p)::text,E'\\n' order by p.oid),''),'sha256'),'hex')
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('public','private')),
  'core',encode(extensions.digest(pg_get_functiondef('public.create_employee_directory_record(text,text,text,text,text,text,text,uuid,text,date,date,date,text,boolean,text,text,text,text,text[],integer)'::regprocedure),'sha256'),'hex'),
  'tableExists',to_regclass('private.employee_team_manager_defaults')is not null,
  'resolverExists',to_regprocedure('public.get_employee_team_manager_default(text,text)')is not null)`;

function readSnapshot(socket, database) {
  return JSON.parse(command('psql', [...target(socket, database), '-At', '-c', snapshot], true));
}

export function runTeamManagerMigrationGuards(socket, predecessor, migration) {
  assert.match(predecessor, /^mam_test_[a-z0-9_]+$/);
  assert.equal(migration.split('set constraints all immediate;').length, 2);
  const scratch = mkdtempSync(path.join(process.env.TMPDIR ?? tmpdir(), 'mam-team-manager-guards-'));
  const cases = [
    ['control', ''],
    ['extra_column', 'alter table private.employee_team_manager_defaults add column unreviewed_column text;'],
    ['grant_option', 'grant execute on function public.get_employee_team_manager_default(text,text) to authenticated with grant option;'],
    ['missing_fk', 'alter table private.employee_team_manager_defaults drop constraint employee_team_manager_defaults_manager_person_id_fkey;'],
    ['unrelated_routine', 'alter function public.update_internal_org_node(uuid,text,text,text,text,uuid,date,integer,boolean,bigint) security invoker;'],
  ];
  try {
    for (const [name, fault] of cases) {
      const database = `mam_test_tmguard_${process.pid}_${name}`;
      command('createdb', ['-h', target(socket, predecessor)[2], '-p', '55439', '-U', 'postgres', `--template=${predecessor}`, database]);
      try {
        const before = readSnapshot(socket, database);
        assert.equal(before.tableExists, false);
        assert.equal(before.resolverExists, false);
        const source = fault ? migration.replace('set constraints all immediate;', `${fault}\nset constraints all immediate;`) : migration;
        const file = path.join(scratch, `${name}.sql`);
        writeFileSync(file, source, { mode: 0o600 });
        const result = spawnSync('psql', [...target(socket, database), '-v', 'VERBOSITY=verbose', '-f', file], { env: process.env, encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'] });
        assert.equal(result.error, undefined);
        const after = readSnapshot(socket, database);
        if (fault) {
          assert.notEqual(result.status, 0, `${name} must reject`);
          assert.match(result.stderr, /55000:/);
          assert.deepEqual(after, before, `${name} must roll back the complete catalog, routines and ledger`);
        } else {
          assert.equal(result.status, 0, result.stderr);
          assert.equal(after.tableExists, true);
          assert.equal(after.resolverExists, true);
          assert.equal(after.catalog, after.ledger.schema_hash);
        }
        console.log(`PASS: Team Manager migration guard ${name} sha256=${createHash('sha256').update(source).digest('hex')}`);
      } finally {
        command('dropdb', ['-h', target(socket, predecessor)[2], '-p', '55439', '-U', 'postgres', database]);
      }
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
