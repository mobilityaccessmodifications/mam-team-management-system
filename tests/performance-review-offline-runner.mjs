import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { resolve, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';
import postcss from 'postcss';
import tailwindcss from '@tailwindcss/postcss';
import postcssConfig from '../postcss.config.mjs';
import ts from 'typescript';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const SCRATCH = '/Users/nixon/.hermes/profiles/mam/cache/scratch';
const source = 'src/components/performance-review-workspace.tsx';
const actionModule = '@/app/performance-reviews/actions';
const boundary = 'tests/browser/performance-review-boundary.mjs';
const virtualFile = join(ROOT, 'tests/performance-review-virtual-actions.d.ts');
const contracts = [
  ['loadPerformanceReviews', '', 'PerformanceLoadResult'],
  ['startPerformanceReview', 'input: PerformanceStartInput', 'PerformanceStartResult'],
  ['mutatePerformanceReview', 'input: PerformanceMutationInput', 'PerformanceMutationResult'],
  ['reconcilePerformanceReviewOperation', 'input: PerformanceReconcileInput', 'PerformanceReconcileResult'],
  ['getPerformanceReviewDocument', 'reviewId: string', 'PerformanceDocumentResult'],
];
function typecheck() {
  const config = ts.readConfigFile(join(ROOT, 'tsconfig.json'), ts.sys.readFile);
  assert.equal(config.error, undefined);
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, ROOT);
  assert.deepEqual(parsed.errors, []);
  const names = [...new Set(contracts.flatMap(([, input, output]) => [output, ...(input.includes('Performance') ? [input.split(': ')[1]] : [])]))];
  const typesPath = join(ROOT, 'src/lib/performance-review-types').replaceAll('\\', '/');
  const declared = `declare module '${actionModule}' { ${names.map(name => `type ${name} = import('${typesPath}').${name};`).join('\n')} ${contracts.map(([name, input, output]) => `export function ${name}(${input}): Promise<${output}>;`).join('\n')} }\ndeclare module '*.module.css' { const classes: Record<string,string>; export default classes; }`;
  const options = { ...parsed.options, incremental: false, noEmit: true };
  const host = ts.createCompilerHost(options), original = host.getSourceFile.bind(host);
  host.getSourceFile = (file, language, onError, createNew) => file === virtualFile ? ts.createSourceFile(file, declared, language) : original(file, language, onError, createNew);
  const program = ts.createProgram([join(ROOT, source), virtualFile], options, host);
  return ts.getPreEmitDiagnostics(program).map(item => ts.flattenDiagnosticMessageText(item.messageText, '\n'));
}
export async function buildPerformanceFixture() {
  assert.equal(resolve(process.cwd()), ROOT, 'Run from the owned frontend worktree.');
  assert.equal(process.env.TMPDIR, SCRATCH, 'Use the approved active-profile scratch path.');
  const typeErrors = typecheck();
  assert.deepEqual(typeErrors, [], 'Frozen action-signature component typecheck');
  const raw = await readFile(join(ROOT, source), 'utf8');
  const ast = ts.createSourceFile(source, raw, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const imports = ast.statements.filter(node => ts.isImportDeclaration(node) && node.moduleSpecifier.text === actionModule);
  const actionExports = imports.flatMap(node => node.importClause.namedBindings.elements.map(item => item.propertyName?.text ?? item.name.text));
  assert.deepEqual([...actionExports].sort(), contracts.map(([name]) => name).sort());
  const declaredBoundary = await readFile(join(ROOT, boundary), 'utf8');
  for (const name of actionExports) assert.ok(declaredBoundary.includes(`export const ${name} =`), 'Missing explicit offline Action '+name);
  const directory = await mkdtemp(join(SCRATCH, 'performance-review-fixture-'));
  try {
    const output = await build({ absWorkingDir: ROOT, entryPoints: ['tests/browser/performance-review-fixture.jsx'], bundle: true, platform: 'browser', format: 'esm', target: 'es2022', jsx: 'automatic', outfile: join(directory, 'performance-review.js'), metafile: true, logLevel: 'silent', alias: { [actionModule]: resolve(ROOT, boundary), '@/lib/supabase/client': resolve(ROOT, boundary) }, plugins: [{ name: 'native-hub-global-styles', setup(builder) {
      builder.onLoad({ filter: /[/\\]src[/\\]app[/\\]globals\.css$/ }, async ({ path: file }) => {
        const result = await postcss([tailwindcss({ ...postcssConfig.plugins['@tailwindcss/postcss'], base: ROOT })]).process(await readFile(file, 'utf8'), { from: file, map: false });
        return { contents: result.css, loader: 'css', resolveDir: resolve(file, '..') };
      });
    } }] });
    const html = '<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Performance component fixture</title><link rel="stylesheet" href="/performance-review.css"><body><div id="root"></div><script type="module" src="/performance-review.js"></script></body></html>\n';
    await writeFile(join(directory, 'index.html'), html, { flag: 'wx' });
    const inputs = Object.keys(output.metafile.inputs);
    assert.ok(inputs.includes(source));
    assert.ok(!inputs.some(path => path.startsWith('src/lib/supabase/') || path.startsWith('src/app/performance-reviews/')));
    const outputs = [...Object.keys(output.metafile.outputs).map(path => resolve(ROOT, path)), join(directory, 'index.html')];
    const hashes = Object.fromEntries(await Promise.all([...inputs.map(path => resolve(ROOT, path)), ...outputs].map(async path => [relative(ROOT, path), createHash('sha256').update(await readFile(path)).digest('hex')])));
    return { directory, typeErrors, actionExports, inputs, outputs, hashes, browserStarted: false, auth: 'synthetic boundary only' };
  } catch (error) { await rm(directory, { recursive: true }); throw error; }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await buildPerformanceFixture();
  console.log(JSON.stringify(result, null, 2));
  if (!process.argv.includes('--keep')) await rm(result.directory, { recursive: true });
}
