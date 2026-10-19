import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { lstatSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { buildPerformanceFixture } from '../performance-review-offline-runner.mjs';

const browserArgs = process.argv.slice(2);
const nonnegativeInteger = value => /^(?:0|[1-9]\d*)$/.test(value) && Number.isSafeInteger(Number(value));
const titlePattern = value => { try { new RegExp(value); return value.length > 0; } catch { return false; } };
const workerCount = value => (nonnegativeInteger(value) && Number(value) > 0) || /^(?:[1-9]\d?|100)%$/.test(value);
const reporters = new Set(['list', 'line', 'dot', 'json', 'junit', 'null', 'blob', 'html', 'github']);
const valueOptions = new Map([
  ['--grep', titlePattern], ['-g', titlePattern], ['--grep-invert', titlePattern], ['-G', titlePattern],
  ['--workers', workerCount], ['-j', workerCount], ['--retries', nonnegativeInteger], ['--timeout', nonnegativeInteger],
  ['--reporter', value => value.split(',').every(reporter => reporters.has(reporter))],
]);
for (let index = 0; index < browserArgs.length; index++) {
  const argument = browserArgs[index], separator = argument.indexOf('=');
  const option = separator === -1 ? argument : argument.slice(0, separator);
  if (option === '--list' && separator === -1) continue;
  const validate = valueOptions.get(option);
  if (!validate) throw new Error('The performance browser group only accepts title filters and supported run options');
  const value = separator === -1 ? browserArgs[++index] : argument.slice(separator + 1);
  if (value === undefined || value.startsWith('-') || !validate(value)) throw new Error('Invalid performance browser option value: ' + option);
}

const root = realpathSync(fileURLToPath(new URL('../..', import.meta.url)));
if (process.env.MAM_BROWSER_SOURCE_ROOT) assert.equal(realpathSync(process.env.MAM_BROWSER_SOURCE_ROOT), root);
const fixture = await buildPerformanceFixture();
const server = createServer((request, response) => {
  response.setHeader('Content-Security-Policy', "default-src 'self'; connect-src 'none'; img-src 'self' data:; style-src 'self' 'unsafe-inline'");
  const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
  if (request.method !== 'GET') { response.writeHead(405); response.end(); return; }
  if (pathname === '/favicon.ico') { response.writeHead(204); response.end(); return; }
  const name = { '/': 'index.html', '/performance-review.js': 'performance-review.js', '/performance-review.css': 'performance-review.css' }[pathname];
  if (!name) { response.writeHead(404); response.end(); return; }
  const file = path.join(fixture.directory, name);
  if (!lstatSync(file).isFile()) { response.writeHead(404); response.end(); return; }
  response.setHeader('Content-Type', name.endsWith('.js') ? 'text/javascript' : name.endsWith('.css') ? 'text/css' : 'text/html');
  response.end(readFileSync(file));
});
let child, interrupted = false;
const stop = () => { interrupted = true; child?.kill('SIGTERM'); };
process.once('SIGTERM', stop);
process.once('SIGINT', stop);
try {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  if (interrupted) throw new Error('Performance browser run interrupted');
  const origin = `http://127.0.0.1:${server.address().port}`;
  child = spawn(process.execPath, ['node_modules/@playwright/test/cli.js', 'test', '--config=tests/browser/playwright.config.mjs', 'performance-review.spec.mjs', ...browserArgs], {
    env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR,
      CI: process.env.CI ?? '', PLAYWRIGHT_BROWSERS_PATH: path.join(root, 'node_modules/.cache/ms-playwright'),
      MAM_BROWSER_SOURCE_ROOT: root, MAM_BROWSER_ORIGIN: origin, MAM_PERFORMANCE_ORIGIN: origin,
      MAM_BROWSER_RESULTS: path.join(fixture.directory, 'results') },
    stdio: 'inherit', timeout: 180_000, killSignal: 'SIGTERM',
  });
  const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', resolve); });
  process.exitCode = interrupted ? 1 : code ?? 1;
} finally {
  process.removeListener('SIGTERM', stop);
  process.removeListener('SIGINT', stop);
  await new Promise(resolve => server.close(resolve));
  rmSync(fixture.directory, { recursive: true, force: true });
}
