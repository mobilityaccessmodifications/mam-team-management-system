import { build } from 'esbuild';
import postcss from 'postcss';
import tailwindcss from '@tailwindcss/postcss';
import postcssConfig from '../../postcss.config.mjs';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { actionFixture, capabilities, loadModule } from '../helpers/unified-role-harness.mjs';
import { syntheticRolePeople, syntheticPerformanceManager } from './unified-role-data.mjs';

export async function buildUnifiedRoleFixture(sourceRoot, scratch) {
  const results = { roles: {}, contacts: {}, contactMutations: {} };
  const actionsFile = path.join(sourceRoot, 'src/app/roles/actions.ts');
  for (const person of [...syntheticRolePeople, syntheticPerformanceManager]) {
    results.roles[person.id] = {};
    for (const role of ['employee', 'manager', 'account', 'admin']) {
      results.roles[person.id][role] = await actionFixture({ target: capabilities(role, person.id) }).load(actionsFile).getPortalRoleCapabilities(person.id);
    }
    const fixture = actionFixture();
    const rpc = fixture.client.rpc.bind(fixture.client);
    fixture.client.rpc = async (name, args) => (name === 'get_selected_employee_profile_for_hr' || name === 'update_selected_employee_profile_for_hr')
      ? { data: [{ person_id: person.id, full_name: person.name, position_title: person.title, company_key: person.company, detail_version: name.startsWith('update') ? 2 : 1, phone: name.startsWith('update') ? args.p_phone : '111', team_name: 'Operation & Accounts', work_email: `${person.role}@example.test`, has_detail: true }], error: null }
      : rpc(name, args);
    const profileActions = fixture.load(path.join(sourceRoot, 'src/app/profile/actions.ts'));
    results.contacts[person.id] = await profileActions.getSelectedEmployeeProfile(person.id);
    results.contactMutations[person.id] = await profileActions.updateSelectedEmployeeProfile({ personId: person.id, detailVersion: 1, personalEmail: '', phone: 'A pending', dateOfBirth: '' });
  }
  results.actor = await actionFixture().load(actionsFile).getPortalRoleCapabilities();
  results.denied = await actionFixture({ error: { code: '42501', message: 'private synthetic permission detail' } }).load(actionsFile).getPortalRoleCapabilities(syntheticRolePeople[0].id);
  results.malformed = await actionFixture({ target: { ...capabilities('admin'), can_manage_roles: undefined } }).load(actionsFile).getPortalRoleCapabilities(syntheticRolePeople[0].id);
  try {
    await actionFixture({ contactError: { code: 'XX000', message: 'private synthetic contact detail' } }).load(path.join(sourceRoot, 'src/app/profile/actions.ts')).getSelectedEmployeeProfile(syntheticRolePeople[0].id);
    throw new Error('Expected the synthetic selected-contact action to fail');
  } catch (error) {
    results.contactError = error.message;
  }
  const reviewRow = { subscription_id: '33000000-0000-4000-8000-000000000010', service_name: 'Synthetic due review', next_review_on: '2500-01-01', subscription_status: 'active', version: 5 };
  const reviewActions = (error = null) => loadModule(path.join(sourceRoot, 'src/app/subscriptions/review-task-actions.ts'), {
    '@/lib/supabase/server': { createClient: async () => ({ auth: { getUser: async () => ({ data: { user: { id: syntheticRolePeople[3].id } }, error: null }) }, rpc: async () => ({ data: reviewRow, error }) }) },
    'next/cache': { revalidatePath() {} },
    '@/lib/subscription-review-tasks': loadModule(path.join(sourceRoot, 'src/lib/subscription-review-tasks.ts')),
  });
  results.reviewCompleted = await reviewActions().completeMySubscriptionReviewTask({ subscriptionId: reviewRow.subscription_id, version: 4 });
  results.reviewStale = await reviewActions({ code: '40001', message: 'synthetic private detail' }).completeMySubscriptionReviewTask({ subscriptionId: reviewRow.subscription_id, version: 4 });
  results.passwordCompleted = await loadModule(path.join(sourceRoot, 'src/app/subscriptions/password-task-actions.ts'), {
    '@/lib/supabase/server': { createClient: async () => ({ auth: { getUser: async () => ({ data: { user: { id: syntheticRolePeople[3].id } }, error: null }) }, rpc: async () => ({ data: {task_id:'34000000-0000-4000-8000-000000000001',version:2,completed:true}, error:null }) }) },
    'next/cache': { revalidatePath() {} },
    '@/lib/subscription-password-tasks': loadModule(path.join(sourceRoot, 'src/lib/subscription-password-tasks.ts')),
  }).completeMySubscriptionPasswordTask({taskId:'34000000-0000-4000-8000-000000000001',version:1,passwordChanged:true});
  if (!results.passwordCompleted.ok || results.passwordCompleted.warning) throw new Error('Actual password completion action rejected the safe browser fixture');
  await build({
    entryPoints: [path.join(sourceRoot, 'tests/browser/unified-role-fixture.jsx')], bundle: true, outdir: scratch,
    platform: 'browser', jsx: 'automatic', sourcemap: false, minify: false,
    alias: { '@/lib/supabase/client': path.join(sourceRoot, 'tests/browser/unified-role-boundary.mjs'), '@': path.join(sourceRoot, 'src'), react: path.join(sourceRoot, 'node_modules/react'), 'react-dom': path.join(sourceRoot, 'node_modules/react-dom') },
    define: {
      'process.env.NODE_ENV': '"production"',
      'process.env': '{}',
      'process.env.NEXT_PUBLIC_SUPABASE_URL': '"http://127.0.0.1:1"',
      'process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY': '"synthetic-unused-key"',
      UNIFIED_ROLE_FIXTURE_RESULTS: JSON.stringify(results),
    },
    plugins: [{ name: 'router-boundary', setup(builder) {
      builder.onResolve({ filter: /^next\/navigation$/ }, () => ({ path: 'next/navigation', namespace: 'router-boundary' }));
      builder.onLoad({ filter: /.*/, namespace: 'router-boundary' }, () => ({ contents: `export const useRouter = () => ({push(url) {window.fixtureNavigation=url;}});`, loader: 'js' }));
    } }, { name: 'production-global-styles', setup(builder) {
      builder.onLoad({ filter: /[/\\]src[/\\]app[/\\]globals\.css$/ }, async ({ path: filename }) => {
        const result = await postcss([tailwindcss({ ...postcssConfig.plugins['@tailwindcss/postcss'], base: sourceRoot })])
          .process(readFileSync(filename, 'utf8'), { from: filename, map: false });
        return { contents: result.css, loader: 'css', resolveDir: path.dirname(filename) };
      });
    } }, { name: 'unified-role-action-boundaries', setup(builder) {
      builder.onResolve({ filter: /^@\/app\/.*actions$/ }, ({ path: id }) => ({ path: id, namespace: 'unified-role-action' }));
      builder.onLoad({ filter: /.*/, namespace: 'unified-role-action' }, ({ path: id }) => {
        const filename = path.join(sourceRoot, 'src', `${id.slice(2)}.ts`);
        const file = ts.createSourceFile(filename, readFileSync(filename, 'utf8'), ts.ScriptTarget.Latest, true);
        const names = [];
        for (const statement of file.statements) {
          if (!statement.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword)) continue;
          if (ts.isFunctionDeclaration(statement) && statement.name) names.push(statement.name.text);
          if (ts.isVariableStatement(statement)) for (const declaration of statement.declarationList.declarations) {
            if (ts.isIdentifier(declaration.name)) names.push(declaration.name.text);
          }
        }
        if (!names.length) throw new Error(`No actual action exports in ${id}`);
        return {
          contents: `import { invokeServerAction } from ${JSON.stringify(path.join(sourceRoot, 'tests/browser/unified-role-boundary.mjs'))};\n` + names.map(name => `export const ${name} = (...args) => invokeServerAction(${JSON.stringify(id)}, ${JSON.stringify(name)}, args);`).join('\n'),
          loader: 'js', resolveDir: sourceRoot,
        };
      });
    } }],
  });
}
