import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const sourcePaths = [
  'src/lib/performance-review-mail.ts',
  'src/lib/performance-review-notifications.ts',
  'src/lib/performance-review-mail-policy.ts',
  'src/app/api/performance-reviews/mail/route.ts',
  'src/lib/performance-review-meeting.ts',
  'src/app/api/performance-reviews/meeting/route.ts',
  'src/lib/performance-review-rules.ts',
  'src/lib/performance-review-types.ts',
  'src/lib/performance-review-document.ts',
  'src/lib/performance-review-word.mjs',
  'src/lib/performance-review-questions.mjs',
  'src/lib/sandbox-safety.ts',
];
export const ids = {
  review: '10000000-0000-4000-8000-000000000001',
  delivery: '20000000-0000-4000-8000-000000000001',
  claim: '30000000-0000-4000-8000-000000000001',
};
export const origin = 'https://n8n.srv1866578.hstgr.cloud';
export const hook = origin + '/webhook/mam-people-hub-performance-review-mail-v1';
export const readyHook = origin + '/webhook/mam-people-hub-performance-review-mail-v1-ready';
export const app = 'https://mam-team-management-system-ten.vercel.app';
export const sharedSecret = 'synthetic-performance-only-0123456789abcdef0123456789abcdef';
export const cronSecret = 'synthetic-cron-only-0123456789abcdef0123456789abcdef';
export function fixture() {
  return {
    delivery_id: ids.delivery, review_id: ids.review, claim_token: ids.claim,
    payload: {
      recipient: 'manager@mobilityaccess.com.au', ccRecipients: ['reviewer-one@mobilityaccess.com.au', 'reviewer-two@mobilityaccess.com.au'], reviewId: ids.review, reviewCode: 'PR-2026-1', finalisedAt: '2026-10-15T05:00:00Z',
      managerNote: 'Synthetic private note <script>& unique-not-in-word',
      document: {
        audience: 'manager', code: 'PR-2026-1', cycle: '2026',
        employee: { id: '40000000-0000-4000-8000-000000000001', name: 'Synthetic Employee', jobTitle: 'Synthetic Installer', company: 'MAM', team: 'Minor' },
        manager: { id: '50000000-0000-4000-8000-000000000001', name: 'Synthetic Manager' },
        selfAnswers: Array.from({ length: 12 }, (_, i) => 'Synthetic self answer ' + i),
        managerAnswers: Array.from({ length: 12 }, (_, i) => 'Synthetic manager answer ' + i),
        ratings: Array.from({ length: 12 }, (_, i) => [0, 1, 2, 6, 7, 8, 9].includes(i) ? '2 Meets expectations' : ''),
        summary: 'Synthetic summary', overallRating: '2 Meets expectations',
        goals: [{ priority: 'Synthetic agreed priority', measureOfSuccess: 'Synthetic measurable outcome', supportAndResponsiblePerson: 'Synthetic reviewer support', dueDate: '2026-12-31', progressCheck: 'Monthly synthetic check' }],
        meeting: { date: '2026-10-15', time: '10:00', duration: 30, mode: 'in_person', location: 'Synthetic room', notes: 'Synthetic meeting notes' },
      },
    },
  };
}
export function environment(patch = {}) {
  return { PERFORMANCE_REVIEW_EMAIL_MODE: 'live', MAM_N8N_PERFORMANCE_WEBHOOK_ORIGIN: origin,
    MAM_N8N_PERFORMANCE_WEBHOOK_URL: hook, MAM_N8N_PERFORMANCE_WEBHOOK_SECRET: sharedSecret,
    CRON_SECRET: cronSecret, NEXT_PUBLIC_APP_URL: app, ...patch };
}
export function loadMailHarness({ env = environment(), rpc, fetch: transport, timers, clock = Date, sourcePatch = {} } = {}) {
  const sources = new Map(sourcePaths.filter(p => existsSync(path.join(root, p))).map(p => [p, readFileSync(path.join(root, p), 'utf8')]));
  for (const [p, source] of Object.entries(sourcePatch)) {
    if (!sourcePaths.includes(p)) throw Error('Unowned fixture source ' + p);
    sources.set(p, source);
  }
  const cache = new Map(), calls = [], requests = [], logs = [], rpcRetries = [];
  let clients = 0;
  function load(file) {
    if (cache.has(file)) return cache.get(file).exports;
    if (!sources.has(file)) {
      if (file === 'src/lib/performance-review-mail.ts' || file === 'src/app/api/performance-reviews/mail/route.ts') return {};
      throw Error('Closed source loader denied ' + file);
    }
    const mod = { exports: {} }; cache.set(file, mod);
    const compiled = ts.transpileModule(sources.get(file), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
    new Function('require', 'module', 'exports', 'process', 'fetch', 'console', 'setTimeout', 'clearTimeout', 'Date', compiled)(id => {
      if (id === 'server-only') return {};
      if (id === '@/lib/supabase/admin') return { createAdminClient() {
        clients++;
        return { rpc(name, args) {
          calls.push({ name, args });
          const operation = Promise.resolve().then(() => {
            if (!rpc) throw Error('Unspecified database port');
            return rpc(name, args);
          });
          operation.abortSignal = () => operation;
          operation.retry = enabled => { rpcRetries.push(enabled); return operation; };
          return operation;
        } };
      } };
      if (id.startsWith('@/') || id.startsWith('.')) {
        let target = id.startsWith('@/') ? 'src/' + id.slice(2) : path.posix.normalize(path.posix.join(path.posix.dirname(file), id));
        if (!path.posix.extname(target)) target += '.ts';
        return load(target);
      }
      if (!['node:crypto', 'temporal-polyfill'].includes(id)) throw Error('Closed package loader denied ' + id);
      return require(id);
    }, mod, mod.exports, { env }, async (url, init) => {
      requests.push({ url: String(url), init });
      if (!transport) throw Error('Unspecified inert transport');
      return transport(url, init);
    }, Object.fromEntries(['error', 'warn', 'log', 'info', 'debug'].map(key => [key, (...args) => logs.push({ key, args })])), timers?.setTimeout ?? setTimeout, clearTimeout, clock);
    return mod.exports;
  }
  return { mail: load('src/lib/performance-review-mail.ts'), route: () => load('src/app/api/performance-reviews/mail/route.ts'), load, calls, requests, logs, rpcRetries, env, get clients() { return clients; }, sources };
}
export function request(method = 'GET', body, { query = '', secret = sharedSecret, bearer = cronSecret, headers = {} } = {}) {
  return new Request(app + '/api/performance-reviews/mail' + query, { method,
    headers: { ...(method === 'GET' ? { authorization: 'Bearer ' + bearer } : { 'X-MAM-Performance-Secret': secret, 'Content-Type': 'application/json' }), ...headers },
    ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
  });
}
export function receipt(wire, patch = {}) {
  return { ok: true, status: 'provider_accepted', deliveryId: wire.deliveryId, eventKey: wire.eventKey,
    actualRecipients: [wire.recipient, ...wire.ccRecipients], attachmentSha256: wire.attachment.sha256, ...patch };
}
export function ack(wire, patch = {}) { return Response.json(receipt(wire, patch)); }
