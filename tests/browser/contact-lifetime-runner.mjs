import { build } from 'esbuild';
import ts from 'typescript';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { loadModule } from '../helpers/contact-lifetime-harness.mjs';
const root = process.cwd(), sourceRoot = process.env.MAM_BROWSER_SOURCE_ROOT ?? root;
const boundary = path.join(root, 'tests/browser/contact-lifetime-boundary.mjs');
const people = ['A', 'B'].map((letter, i) => ({ id: `11000000-0000-4000-8000-00000000000${i + 2}`, name: `Synthetic ${letter}` }));
const contacts = {};
for (const person of people) {
  const client = { auth: { getUser: async () => ({ data: { user: { id: person.id } }, error: null }) }, async rpc(name) {
    if (name === 'can_change_employee_view') return { data: true, error: null };
    if (name === 'get_selected_employee_profile_access_role_for_preview') return { data: 'employee', error: null };
    if (name === 'get_selected_employee_profile_for_hr') return { data: [{ person_id: person.id, full_name: person.name, position_title: 'Tester', company_key: 'mam', team_name: 'Synthetic team', phone: '111', work_email: 'synthetic@example.test', detail_version: 1, has_detail: true }], error: null };
    throw new Error('Unexpected real action fixture RPC '+name);
  } };
  const actions = loadModule(path.join(sourceRoot, 'src/app/profile/actions.ts'), { 'next/cache': { revalidatePath() {} }, '@/lib/employee-directory': { requireEmployeeDirectoryManager: async () => ({ supabase: client }) }, '@/lib/supabase/server': { createClient: async () => client } });
  contacts[person.id] = await actions.getSelectedEmployeeProfile(person.id);
}
const scratch = mkdtempSync(path.join(tmpdir(), 'mam-contact-browser-'));
const server = createServer((request, response) => {
  const file = /^\/contact-lifetime-fixture\.(js|css)$/.test(request.url ?? '') ? request.url.slice(1) : null;
  response.setHeader('Content-Security-Policy', "default-src 'self'; connect-src 'none'; img-src 'self' data:; style-src 'self' 'unsafe-inline'");
  response.setHeader('Content-Type', file?.endsWith('.js') ? 'text/javascript' : file ? 'text/css' : 'text/html');
  response.end(file ? readFileSync(path.join(scratch, file)) : '<!doctype html><html lang="en"><meta charset="utf-8"><link rel="stylesheet" href="/contact-lifetime-fixture.css"><body><div id="root"></div><script src="/contact-lifetime-fixture.js"></script></body></html>');
});
try {
  await build({ entryPoints: ['tests/browser/contact-lifetime-fixture.jsx'], bundle: true, outdir: scratch, platform: 'browser', jsx: 'automatic', alias: { '@/lib/supabase/client': boundary, '@': path.join(sourceRoot, 'src'), react: path.join(root, 'node_modules/react'), 'react-dom': path.join(root, 'node_modules/react-dom') }, define: { 'process.env.NODE_ENV': '"production"', 'process.env': '{}', 'process.env.NEXT_PUBLIC_SUPABASE_URL': '"http://127.0.0.1:1"', 'process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY': '"synthetic-unused-key"', CONTACT_FIXTURE_RESULTS: JSON.stringify(contacts) }, plugins: [{ name: 'real-action-exports', setup(builder) {
    builder.onResolve({ filter: /^@\/app\/.*actions$/ }, ({ path: id }) => ({ path: id, namespace: 'synthetic-action' }));
    builder.onLoad({ filter: /.*/, namespace: 'synthetic-action' }, ({ path: id }) => {
      const file = path.join(sourceRoot, 'src', id.slice(2) + '.ts');
      const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
      const names = source.statements.filter(s => s.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword) && ts.isFunctionDeclaration(s) && s.name).map(s => s.name.text);
      if (!names.length) throw new Error('No real action exports '+id);
      return { contents: `import {invokeServerAction} from ${JSON.stringify(boundary)};\n` + names.map(n => `export const ${n}=(...args)=>invokeServerAction(${JSON.stringify(id)},${JSON.stringify(n)},args);`).join('\n'), loader: 'js', resolveDir: root };
    });
  } }] });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const child = spawn(process.execPath, ['node_modules/@playwright/test/cli.js', 'test', '--config=tests/browser/playwright.config.mjs', 'contact-lifetime.spec.mjs', ...process.argv.slice(2)], { stdio: 'inherit', env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, PLAYWRIGHT_BROWSERS_PATH: path.join(root, 'node_modules/.cache/ms-playwright'), MAM_BROWSER_ORIGIN: origin, MAM_CONTACT_ORIGIN: origin, MAM_BROWSER_RESULTS: path.join(scratch, 'results') } });
  process.exitCode = await new Promise((resolve, reject) => { child.on('exit', resolve); child.on('error', reject); });
} finally {
  await new Promise(resolve => server.close(resolve)); rmSync(scratch, { recursive: true, force: true });
}
