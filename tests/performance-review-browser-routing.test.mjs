import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, realpath } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { EventEmitter } from 'node:events';
import * as filePromises from 'node:fs/promises';
import ts from 'typescript';

const root = fileURLToPath(new URL('..', import.meta.url));
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
async function execute(file, ports, environment = {}, args = [], entry = true) {
  const filename = path.join(root, file);
  const source = (await readFile(filename, 'utf8')).replaceAll('import.meta.url', JSON.stringify(pathToFileURL(filename).href));
  const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  const processPort = Object.assign(new EventEmitter(), { argv: ['node', entry ? filename : 'inert-import', ...args], execPath: 'node', env: environment, cwd: () => root.replace(/\/$/, ''), exitCode: undefined });
  ports.onProcess?.(processPort);
  const exports = {};
  await new AsyncFunction('require', 'exports', 'process', output)(name => {
    if (!Object.hasOwn(ports, name)) throw new Error('Unexpected inert runner import ' + name);
    return ports[name];
  }, exports, processPort);
  return { exports, process: processPort };
}
function standardPorts(exits = [0, 0, 0]) {
  const spawned = [], cleanup = [], builds = [];
  const server = { listen(_port, host, callback) { assert.equal(host, '127.0.0.1'); callback(); }, address: () => ({ port: 12345 }), close(callback) { cleanup.push('server'); callback(); } };
  const actionResult = { ok: true };
  const actions = new Proxy({}, { get: () => async () => actionResult });
  const harness = () => ({ actions });
  return { spawned, cleanup, builds, ports: {
    esbuild: { build: async options => { builds.push(options); } },
    postcss: () => {}, '@tailwindcss/postcss': () => {}, '../postcss.config.mjs': {},
    '../tests/helpers/directory-action-harness.mjs': { draft: {}, personId: 'synthetic', loadActions: harness },
    'node:http': { createServer: () => server },
    'node:fs': { mkdtempSync: () => '/inert/primary', readFileSync, realpathSync: value => value, rmSync: () => cleanup.push('scratch') },
    'node:os': { tmpdir: () => '/inert' }, 'node:path': path,
    'node:child_process': { spawn(command, args, options) {
      spawned.push({ command, args, options });
      const child = new EventEmitter();
      queueMicrotask(() => child.emit('exit', exits[spawned.length - 1] ?? 0));
      return child;
    } },
    '../tests/browser/unified-role-build.mjs': { buildUnifiedRoleFixture: async () => {} },
    './apply-dayflow-dst-patch.mjs': { applyDayflowDstPatch: () => {} },
    '../tests/helpers/onboarding-review-action-harness.mjs': { reviewActionHarness: harness, deliveryId: 'synthetic', updatedAt: 'synthetic', rowFixture: {} },
    '../tests/helpers/archive-preflight-harness.mjs': { archivePreflightInput: {}, archivePreflightFixture: () => ({ action: async () => ({ ok: false }), state: { preflightReads: 1, mutations: [] } }) },
  } };
}

test('standard browser caller runs primary, contact, then dedicated performance after success', async () => {
  const state = standardPorts();
  const result = await execute('scripts/test-browser.mjs', state.ports, {}, [root.replace(/\/$/, '')]);
  assert.equal(result.process.exitCode, 0);
  assert.deepEqual(state.spawned.map(item => item.args[0]), ['node_modules/@playwright/test/cli.js', 'tests/browser/contact-lifetime-runner.mjs', 'tests/browser/performance-review-runner.mjs']);
  assert.equal(state.spawned[2].options.env.MAM_BROWSER_SOURCE_ROOT, root.replace(/\/$/, ''));
  assert.deepEqual(state.cleanup, ['server', 'scratch']);
});

test('performance fixture accepts TMPDIR absent and uses canonical portable temporary root', async () => {
  const sentinel = new Error('inert mkdtemp boundary reached');
  const observed = [];
  const result = await execute('tests/performance-review-offline-runner.mjs', {
    'node:assert/strict': assert,
    'node:fs/promises': { ...filePromises, realpath: async value => { observed.push(value); return '/canonical-portable-temp'; }, mkdtemp: async value => { observed.push(value); throw sentinel; } },
    'node:os': { tmpdir: () => '/portable-temp-alias' },
    'node:path': path, 'node:url': { fileURLToPath },
    'node:crypto': await import('node:crypto'),
    esbuild: { build: () => { throw new Error('Must not compile at inert temporary-directory boundary'); } },
    postcss: () => {}, '@tailwindcss/postcss': () => {}, '../postcss.config.mjs': {}, typescript: ts,
  }, {}, [], false);
  await assert.rejects(result.exports.buildPerformanceFixture(), error => error === sentinel);
  assert.deepEqual(observed, ['/portable-temp-alias', '/canonical-portable-temp/performance-review-fixture-']);
  assert.equal(await realpath(root), root.replace(/\/$/, ''));
});

for (const [name, exits, expected] of [
  ['primary', [7], 1], ['contact', [0, 8], 2], ['performance', [0, 0, 9], 3],
]) test(`standard browser caller propagates ${name} failure and cleans up`, async () => {
  const state = standardPorts(exits);
  const result = await execute('scripts/test-browser.mjs', state.ports, {}, [root.replace(/\/$/, '')]);
  assert.equal(result.process.exitCode, exits.at(-1));
  assert.equal(state.spawned.length, expected);
  assert.deepEqual(state.cleanup, ['server', 'scratch']);
});

test('title-only unmatched allowance reaches contact only and never weakens performance', async () => {
  const state = standardPorts();
  await execute('scripts/test-browser.mjs', state.ports, {}, [root.replace(/\/$/, ''), '--allow-unmatched-contact', '--grep', 'native Word download']);
  assert.deepEqual(state.spawned[0].args.slice(-2), ['--grep', 'native Word download']);
  assert.deepEqual(state.spawned[1].args.slice(-3), ['--grep', 'native Word download', '--pass-with-no-tests']);
  assert.deepEqual(state.spawned[2].args, ['tests/browser/performance-review-runner.mjs', '--grep', 'native Word download']);
  assert.equal(state.spawned[0].options.env.MAM_PERFORMANCE_ORIGIN, undefined);
  assert.equal(state.spawned[1].options.env.MAM_PERFORMANCE_ORIGIN, undefined);
});

for (const args of [
  ['--pass-with-no-tests'], ['--allow-unmatched-contact'],
  ['--allow-unmatched-contact', '--grep', 'native Word download', 'performance-review.spec.mjs'],
]) test(`standard browser rejects zero-test escape or non-title allowance: ${args.join(' ')}`, async () => {
  const state = standardPorts();
  await assert.rejects(execute('scripts/test-browser.mjs', state.ports, {}, [root.replace(/\/$/, ''), ...args]));
  assert.equal(state.spawned.length, 0);
});

function performancePorts({ exitCode = 0, interrupt = false, spawnError = false } = {}) {
  const spawned = [], cleanup = [], signals = [];
  let processPort;
  const server = Object.assign(new EventEmitter(), {
    listen(_port, host, callback) { assert.equal(host, '127.0.0.1'); callback(); },
    address: () => ({ port: 23456 }), close(callback) { cleanup.push('server'); callback(); },
  });
  return { spawned, cleanup, signals, ports: {
    onProcess: value => { processPort = value; },
    '../performance-review-offline-runner.mjs': { buildPerformanceFixture: async () => ({ directory: '/inert/performance' }) },
    'node:assert/strict': assert, 'node:url': { fileURLToPath }, 'node:path': path,
    'node:fs': { readFileSync, lstatSync: () => ({ isFile: () => true }), realpathSync: value => value.replace(/\/$/, ''), rmSync: value => { assert.equal(value, '/inert/performance'); cleanup.push('scratch'); } },
    'node:http': { createServer: () => server },
    'node:child_process': { spawn(command, args, options) {
      spawned.push({ command, args, options });
      const child = new EventEmitter();
      child.kill = signal => { signals.push(signal); queueMicrotask(() => child.emit('exit', null, signal)); return true; };
      queueMicrotask(() => {
        if (spawnError) child.emit('error', new Error('inert spawn failure'));
        else if (interrupt) processPort.emit('SIGTERM');
        else child.emit('exit', exitCode);
      });
      return child;
    } },
  } };
}

test('dedicated performance runner fixes spec selection, supplies loopback origin, and removes outputs', async () => {
  const state = performancePorts();
  const result = await execute('tests/browser/performance-review-runner.mjs', state.ports);
  assert.equal(result.process.exitCode, 0);
  assert.equal(state.spawned.length, 1);
  const { args, options } = state.spawned[0];
  assert.deepEqual(args, ['node_modules/@playwright/test/cli.js', 'test', '--config=tests/browser/playwright.config.mjs', 'performance-review.spec.mjs']);
  assert.equal(options.env.MAM_BROWSER_ORIGIN, 'http://127.0.0.1:23456');
  assert.equal(options.env.MAM_PERFORMANCE_ORIGIN, options.env.MAM_BROWSER_ORIGIN);
  assert.equal(options.env.MAM_BROWSER_RESULTS, '/inert/performance/results');
  assert.equal(options.env.MAM_CONTACT_ORIGIN, undefined);
  assert.ok(options.timeout > 0);
  assert.deepEqual(state.cleanup, ['server', 'scratch']);
});

test('dedicated performance runner preserves title filter and rejects zero matching tests', async () => {
  const state = performancePorts({ exitCode: 1 });
  const result = await execute('tests/browser/performance-review-runner.mjs', state.ports, {}, ['--grep', 'unmatched synthetic title']);
  assert.equal(result.process.exitCode, 1);
  assert.deepEqual(state.spawned[0].args.slice(-2), ['--grep', 'unmatched synthetic title']);
  assert.ok(!state.spawned[0].args.includes('--pass-with-no-tests'));
  assert.deepEqual(state.cleanup, ['server', 'scratch']);
});

for (const args of [['--pass-with-no-tests'], ['--pass-with-no-tests=true'], ['--config=foreign.mjs'], ['other.spec.mjs']]) {
  test(`dedicated performance runner rejects scope or zero-test bypass: ${args.join(' ')}`, async () => {
    const state = performancePorts();
    await assert.rejects(execute('tests/browser/performance-review-runner.mjs', state.ports, {}, args));
    assert.equal(state.spawned.length, 0);
  });
}

test('dedicated performance runner stops its child on termination and cleans up', async () => {
  const state = performancePorts({ interrupt: true });
  const result = await execute('tests/browser/performance-review-runner.mjs', state.ports);
  assert.equal(result.process.exitCode, 1);
  assert.deepEqual(state.signals, ['SIGTERM']);
  assert.deepEqual(state.cleanup, ['server', 'scratch']);
  assert.equal(result.process.listenerCount('SIGTERM'), 0);
  assert.equal(result.process.listenerCount('SIGINT'), 0);
});

test('dedicated performance runner cleans up after child spawn error', async () => {
  const state = performancePorts({ spawnError: true });
  await assert.rejects(execute('tests/browser/performance-review-runner.mjs', state.ports), /inert spawn failure/);
  assert.deepEqual(state.cleanup, ['server', 'scratch']);
});

function selectorPorts() {
  const state = performancePorts();
  const entered = [];
  const build = state.ports['../performance-review-offline-runner.mjs'].buildPerformanceFixture;
  const server = state.ports['node:http'].createServer;
  state.ports['../performance-review-offline-runner.mjs'].buildPerformanceFixture = async () => { entered.push('builder'); return build(); };
  state.ports['node:http'].createServer = (...args) => { entered.push('server'); return server(...args); };
  return { ...state, entered };
}

const extraFileSelectorArgs = [
  ['foreign-sentinel'], ['foreign.*'], ['.*'],
  ['tests/browser/foreign-sentinel'], ['./tests/browser/foreign-sentinel.spec.mjs'],
  ['/synthetic/foreign-sentinel.spec.mjs'], ['foreign-sentinel.spec.mjs'], ['performance-review.spec.mjs'],
  ['--', 'foreign-sentinel'], ['--'], ['--list', 'foreign-sentinel'],
  ['--grep', 'known title', 'foreign-sentinel'], ['--grep=known title', 'foreign.*'],
  ['--workers', '1', 'foreign-sentinel'], ['--reporter', 'list', 'foreign-sentinel'],
];

test('dedicated performance runner rejects every additional file selector before side effects', async () => {
  for (const args of extraFileSelectorArgs) {
    const state = selectorPorts();
    await assert.rejects(execute('tests/browser/performance-review-runner.mjs', state.ports, {}, args));
    assert.deepEqual(state.entered, [], args.join(' '));
    assert.equal(state.spawned.length, 0);
  }
});

const invalidBrowserOptionArgs = [
  ['--config', 'foreign.mjs'], ['--config=foreign.mjs'], ['-c', 'foreign.mjs'], ['-cforeign.mjs'],
  ['--pass-with-no-tests'], ['--pass-with-no-tests=true'], ['--pass-with-no-tests=false'],
  ['--unknown'], ['--unknown=value'], ['--list=true'], ['--list', 'true'],
  ['--grep'], ['--grep='], ['--grep', '--list'], ['--grep', '['],
  ['--grep-invert'], ['--grep-invert='], ['--grep-invert', '--list'],
  ['--workers'], ['--workers='], ['--workers', '--list'], ['--workers', 'foreign-sentinel'],
  ['--workers', '0'], ['--workers=-1'], ['--workers=1.5'], ['--workers=101%'],
  ['--retries'], ['--retries='], ['--retries', 'foreign-sentinel'], ['--retries=-1'],
  ['--reporter'], ['--reporter='], ['--reporter', 'foreign-sentinel'], ['--reporter=list,foreign'],
  ['--reporter=./foreign.mjs'], ['--timeout'], ['--timeout=NaN'], ['--timeout=-1'],
];

test('dedicated performance runner rejects unknown options and invalid values before side effects', async () => {
  for (const args of invalidBrowserOptionArgs) {
    const state = selectorPorts();
    await assert.rejects(execute('tests/browser/performance-review-runner.mjs', state.ports, {}, args));
    assert.deepEqual(state.entered, [], args.join(' '));
    assert.equal(state.spawned.length, 0);
  }
});

const validBrowserOptionArgs = [
  ['--list'], ['--grep', 'foreign-sentinel.spec.mjs'], ['--grep=(?=native).*Word'],
  ['--grep-invert', 'foreign.*'], ['-g', 'native Word download', '-G', 'unmatched'],
  ['--workers', '1', '--retries', '0', '--reporter', 'list'],
  ['--workers=50%', '--retries=2', '--reporter=json', '--timeout=20000'],
  ['-j', '2', '--reporter=line,json'],
];

test('dedicated performance runner keeps validated option values out of positional selection', async () => {
  for (const args of validBrowserOptionArgs) {
    const state = selectorPorts();
    const result = await execute('tests/browser/performance-review-runner.mjs', state.ports, {}, args);
    assert.equal(result.process.exitCode, 0);
    assert.deepEqual(state.spawned[0].args, ['node_modules/@playwright/test/cli.js', 'test', '--config=tests/browser/playwright.config.mjs', 'performance-review.spec.mjs', ...args]);
    assert.deepEqual(state.entered, ['builder', 'server']);
    assert.deepEqual(state.cleanup, ['server', 'scratch']);
  }
});
