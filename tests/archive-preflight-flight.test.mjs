import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { Readable } from 'node:stream';
import test from 'node:test';
import { archivePreflightFixture, archivePreflightInput } from './helpers/archive-preflight-harness.mjs';

const require = createRequire(import.meta.url);

for (const readError of [false, true]) {
  test(`archive preflight ${readError ? 'read failure' : 'protected reporting links'} survives production Flight without a mutation`, async () => {
    const script = `
      import assert from 'node:assert/strict';
      import { createRequire } from 'node:module';
      import { archivePreflightFixture, archivePreflightInput } from './tests/helpers/archive-preflight-harness.mjs';
      const require = createRequire(import.meta.url);
      const fixture = archivePreflightFixture({ readError: ${readError} });
      const result = fixture.action(archivePreflightInput).then(result => {
        assert.equal(fixture.state.preflightReads, 1);
        assert.deepEqual(fixture.state.mutations, []);
        return result;
      });
      require('next/dist/compiled/react-server-dom-webpack/server.node')
        .renderToPipeableStream({ result }, {}, { onError: () => 'synthetic-digest' }).pipe(process.stdout);
    `;
    const encoded = spawnSync(process.execPath, ['--conditions=react-server', '--input-type=module', '-e', script], {
      encoding: 'utf8', timeout: 15_000,
      env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, NODE_ENV: 'production' },
    });
    assert.equal(encoded.status, 0, encoded.stderr);
    const { createFromNodeStream } = require('next/dist/compiled/react-server-dom-webpack/cjs/react-server-dom-webpack-client.node.production.js');
    const response = await createFromNodeStream(Readable.from([encoded.stdout]), { moduleMap: {}, serverModuleMap: {}, moduleLoading: null });
    const fixture = archivePreflightFixture({ readError });
    assert.deepEqual(await response.result, await fixture.action(archivePreflightInput));
    assert.deepEqual(fixture.state.mutations, []);
    assert.doesNotMatch(encoded.stdout, /private synthetic|synthetic-digest|:E\{/);
  });
}
