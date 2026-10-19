import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { buildUnifiedRoleFixture } from './unified-role-build.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const args = process.argv.slice(2);
for (let index = 0; index < args.length; index++) {
  if (args[index] === '--list') continue;
  if (!['--grep', '-g', '--grep-invert', '-G', '--workers', '-j', '--retries', '--timeout', '--reporter'].includes(args[index]) || !args[++index] || args[index].startsWith('-')) throw new Error('Only supported unified-role browser run options are accepted');
}
const scratch = mkdtempSync(path.join(tmpdir(), 'mam-unified-role-browser-'));
const server = createServer((request, response) => {
  response.setHeader('Content-Security-Policy', "default-src 'self'; connect-src 'none'; img-src 'self' data:; style-src 'self' 'unsafe-inline'");
  if (request.method !== 'GET') { response.writeHead(405); response.end(); return; }
  const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
  if (pathname === '/favicon.ico') { response.writeHead(204); response.end(); return; }
  const name = { '/unified-role-fixture.js': 'unified-role-fixture.js', '/unified-role-fixture.css': 'unified-role-fixture.css' }[pathname];
  if (!name && pathname !== '/') { response.writeHead(404); response.end(); return; }
  response.setHeader('Content-Type', name?.endsWith('.js') ? 'text/javascript' : name ? 'text/css' : 'text/html');
  response.end(name ? readFileSync(path.join(scratch, name)) : '<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Synthetic role browser tests</title><link rel="stylesheet" href="/unified-role-fixture.css"><body><div id="root"></div><script src="/unified-role-fixture.js"></script></body></html>');
});
let child;
try {
  await buildUnifiedRoleFixture(root, scratch);
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  child = spawn(process.execPath, ['node_modules/@playwright/test/cli.js', 'test', '--config=tests/browser/playwright.config.mjs', 'unified-role.*\\.spec\\.mjs$', ...args], {
    cwd: root, stdio: 'inherit', timeout: 180_000, killSignal: 'SIGTERM',
    env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, CI: process.env.CI ?? '',
      PLAYWRIGHT_BROWSERS_PATH: path.join(root, 'node_modules/.cache/ms-playwright'), MAM_BROWSER_SOURCE_ROOT: root,
      MAM_BROWSER_ORIGIN: `http://127.0.0.1:${server.address().port}`, MAM_BROWSER_RESULTS: path.join(scratch, 'results') },
  });
  process.exitCode = await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', resolve); }) ?? 1;
} finally {
  if (server.listening) await new Promise(resolve => server.close(resolve));
  rmSync(scratch, { recursive: true, force: true });
}
