import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const sourceRoot = realpathSync(fileURLToPath(new URL('../', import.meta.url)));
const helperUrl = pathToFileURL(path.join(sourceRoot, 'tests/helpers/archive-preflight-harness.mjs')).href;
const sourceModules = [
  'src/app/people/actions.ts',
  'src/lib/employee-teams.ts',
  'src/lib/organisation-directory.ts',
  'src/lib/portal-account-status.ts',
  'src/lib/portal-role-access.ts',
  'src/lib/portal-role-capabilities.ts',
];
const expectedReads = sourceModules.map(relativePath => {
  const filename = path.join(sourceRoot, relativePath);
  return { path: filename, sha256: createHash('sha256').update(readFileSync(filename)).digest('hex') };
}).sort((a, b) => a.path.localeCompare(b.path));

for (const readError of [false, true]) {
  test(`archive preflight ${readError ? 'read failure' : 'direct-report blocker'} uses the selected action and nested sources from a different cwd`, t => {
    const cwd = mkdtempSync(path.join(tmpdir(), 'mam-archive-source-root-'));
    try {
      assert.notEqual(realpathSync(cwd), sourceRoot);
      for (const relativePath of sourceModules) {
        const filename = path.join(cwd, relativePath);
        mkdirSync(path.dirname(filename), { recursive: true });
        writeFileSync(filename, `throw new Error(${JSON.stringify('Unexpected cwd source: ' + relativePath)});\n`);
      }
      const script = `
        import fs from 'node:fs';
        import { createHash } from 'node:crypto';
        import { syncBuiltinESMExports } from 'node:module';
        import path from 'node:path';
        import { fileURLToPath } from 'node:url';
        const sourceRoot = ${JSON.stringify(sourceRoot)};
        const sourceReads = [];
        const readFileSync = fs.readFileSync;
        fs.readFileSync = function(file, ...args) {
          const value = readFileSync.call(this, file, ...args);
          const filename = file instanceof URL ? fileURLToPath(file) : Buffer.isBuffer(file) ? file.toString() : file;
          if (typeof filename === 'string') {
            const resolved = path.resolve(filename);
            if (resolved.includes(path.sep + 'src' + path.sep)) {
              sourceReads.push({ path: resolved, sha256: createHash('sha256').update(value).digest('hex') });
            }
          }
          return value;
        };
        syncBuiltinESMExports();
        globalThis.fetch = async () => { throw new Error('Unexpected synthetic network request'); };
        let result = null, state = null, loadError = null;
        try {
          const { archivePreflightFixture, archivePreflightInput } = await import(${JSON.stringify(helperUrl)});
          const fixture = archivePreflightFixture({ sourceRoot, readError: ${readError} });
          state = fixture.state;
          result = await fixture.action(archivePreflightInput);
        } catch (error) {
          loadError = { name: error.name, code: error.code ?? null, message: error.message };
          process.exitCode = 1;
        }
        process.stdout.write(JSON.stringify({ sourceRoot, cwd: process.cwd(), readError: ${readError}, result, state, sourceReads, loadError }) + '\\n');
      `;
      const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
        cwd, encoding: 'utf8', timeout: 15_000,
        env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR },
      });
      assert.ifError(child.error);
      const observed = JSON.parse(child.stdout);
      t.diagnostic('source-root-provenance ' + JSON.stringify(observed));
      assert.equal(child.status, 0, JSON.stringify(observed.loadError));
      assert.equal(child.stderr, '');
      assert.equal(observed.sourceRoot, sourceRoot);
      assert.equal(observed.cwd, realpathSync(cwd));
      assert.equal(observed.loadError, null);
      assert.deepEqual(observed.result, {
        ok: false,
        message: readError
          ? "The employee's reporting links could not be checked. Refresh and try again."
          : "Move or archive this employee's active direct reports first.",
      });
      assert.deepEqual(observed.state, { mutations: [], reportReads: 1 });
      const reads = [...new Map(observed.sourceReads.map(row => [row.path, row])).values()]
        .sort((a, b) => a.path.localeCompare(b.path));
      assert.deepEqual(reads, expectedReads);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
}
