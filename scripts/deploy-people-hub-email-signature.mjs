import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { HR_EMAIL_SIGNATURE_HTML } from './hr-email-signature.mjs';

const N8N_ROOT = '/Volumes/UG/MAM/opencode/n8n';
export const targets = JSON.parse(readFileSync(new URL('./people-hub-email-signature-targets.json', import.meta.url), 'utf8'));
const previousHR = HR_EMAIL_SIGNATURE_HTML.replace('Mobility Access Modifications</td>', 'Mobility Access Modifications<br><a href="mailto:hr@mobilityaccess.com.au" style="color:#b94c16;text-decoration:none">hr@mobilityaccess.com.au</a></td>');
const credentialBefore = 'P: 03 9350 4400<br>E: <a href="mailto:ai@mobilityaccess.com.au" style="color:#68645d">ai@mobilityaccess.com.au</a>';
const credentialAfter = 'P: 03 9350 4400';

function requireCondition(ok, message) {
  if (!ok) throw new Error(message);
}

export function digest(value) {
  return createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
}

function payload(workflow) {
  return { name: workflow.name, nodes: workflow.nodes, connections: workflow.connections, settings: workflow.settings };
}

export function changeFooter(source, kind, reverse = false) {
  const pairs = {
    html: [previousHR, HR_EMAIL_SIGNATURE_HTML],
    expression: [JSON.stringify(previousHR), JSON.stringify(HR_EMAIL_SIGNATURE_HTML)],
    credential: [credentialBefore, credentialAfter].map((value) => JSON.stringify(value).slice(1, -1)),
  };
  requireCondition(Object.hasOwn(pairs, kind), 'Unknown signature field kind');
  const [before, after] = reverse ? pairs[kind].toReversed() : pairs[kind];
  requireCondition(typeof source === 'string' && source.split(before).length === 2, 'Signature must contain one exact footer');
  return source.replace(before, after);
}

export function inspect(workflow, target) {
  requireCondition(workflow.id === target.id && workflow.name === target.name, `${target.id}: unexpected workflow`);
  requireCondition(workflow.active === true, `${target.id}: workflow is not active`);
  requireCondition(workflow.activeVersionId === workflow.versionId, `${target.id}: unpublished workflow changes`);
  const baseline = structuredClone(payload(workflow));
  const candidate = structuredClone(payload(workflow));
  const sends = workflow.nodes.filter((node) => node.type === 'n8n-nodes-base.microsoftOutlook'
    && node.parameters?.resource === 'message' && node.parameters?.operation === 'send');
  requireCondition(sends.length === target.sendCount && sends.every((node) => node.parameters?.additionalFields?.bodyContentType === 'html'), `${target.id}: send nodes changed`);
  const states = [];
  for (const field of target.fields) {
    const matches = workflow.nodes.filter((node) => node.name === field.node);
    requireCondition(matches.length === 1, `${target.id}: template node missing or duplicated: ${field.node}`);
    const source = matches[0].parameters[field.field];
    const hash = digest(source);
    requireCondition(hash === field.beforeHash || hash === field.afterHash, `${target.id}: template field changed: ${field.node}`);
    const pending = hash === field.beforeHash;
    const original = pending ? source : changeFooter(source, field.kind, true);
    const updated = pending ? changeFooter(source, field.kind) : source;
    requireCondition(digest(original) === field.beforeHash && digest(updated) === field.afterHash, `${target.id}: signature transformation changed`);
    states.push(pending ? 'pending' : 'published');
    baseline.nodes.find((node) => node.name === field.node).parameters[field.field] = original;
    candidate.nodes.find((node) => node.name === field.node).parameters[field.field] = updated;
  }
  requireCondition(states.length > 0 && states.every((state) => state === states[0]), `${target.id}: mixed signature versions`);
  requireCondition(digest(baseline) === target.baselineHash, `${target.id}: workflow has other unreviewed changes`);
  if (states[0] === 'pending') requireCondition(workflow.versionId === target.version, `${target.id}: published predecessor changed`);
  return { state: states[0], payload: candidate };
}

export async function publish(api, target, before, plan) {
  const latest = await api('GET', `workflows/${target.id}`);
  requireCondition(latest.versionId === before.versionId && latest.activeVersionId === before.activeVersionId
    && latest.active === before.active && isDeepStrictEqual(payload(latest), payload(before)), `${target.id}: workflow changed since the rollout plan`);
  if (plan.state === 'published') return { id: target.id, published: true, alreadyApplied: true };
  const updated = await api('PUT', `workflows/${target.id}`, plan.payload);
  requireCondition(updated.id === target.id && typeof updated.versionId === 'string' && updated.versionId !== before.versionId, `${target.id}: update receipt mismatch`);
  const published = await api('GET', `workflows/${target.id}`);
  requireCondition(published.active === true && published.versionId === updated.versionId && published.activeVersionId === updated.versionId
    && isDeepStrictEqual(payload(published), plan.payload) && isDeepStrictEqual(published.staticData, latest.staticData), `${target.id}: published readback mismatch`);
  inspect(published, target);
  return { id: target.id, published: true, versionId: published.versionId, sendNodes: target.sendCount, changedFields: target.fields.length };
}

function config() {
  const verified = spawnSync('python3', ['scripts/verify.py'], { cwd: N8N_ROOT, encoding: 'utf8' });
  requireCondition(verified.status === 0 && verified.stdout.includes('Verified MAM n8n API'), 'MAM n8n verification failed');
  const values = Object.fromEntries(readFileSync(`${N8N_ROOT}/.env`, 'utf8').split(/\r?\n/)
    .filter((line) => /^[A-Z][A-Z0-9_]*=/.test(line)).map((line) => {
      const separator = line.indexOf('=');
      return [line.slice(0, separator), line.slice(separator + 1).trim().replace(/^(["'])(.*)\1$/, '$2')];
    }));
  requireCondition(values.N8N_INSTANCE_LABEL === 'MAM', 'Wrong n8n instance');
  requireCondition(/^https:\/\//.test(values.N8N_BASE_URL) && values.N8N_API_KEY, 'Missing verified MAM n8n connection');
  return values;
}

async function main() {
  const apply = process.argv[2] === '--apply';
  requireCondition(process.argv.length === (apply ? 3 : 2), 'Usage: node deploy-people-hub-email-signature.mjs [--apply]');
  const values = config();
  const api = async (method, path, body) => {
    const response = await fetch(`${values.N8N_BASE_URL.replace(/\/$/, '')}/api/v1/${path}`, {
      method, redirect: 'error', headers: { 'X-N8N-API-KEY': values.N8N_API_KEY, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20000),
    });
    requireCondition(response.ok, `MAM n8n ${method} ${path} failed: HTTP ${response.status}`);
    return response.json();
  };
  const plans = [];
  for (const target of targets) {
    const before = await api('GET', `workflows/${target.id}`);
    plans.push({ target, before, ...inspect(before, target) });
  }
  if (!apply) {
    console.log(JSON.stringify({ mode: 'plan', workflows: plans.map(({ target, state }) => ({ id: target.id, state, sendNodes: target.sendCount, changedFields: target.fields.length })) }));
    return;
  }
  for (const { target, before, ...plan } of plans) console.log(JSON.stringify(await publish(api, target, before, plan)));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
