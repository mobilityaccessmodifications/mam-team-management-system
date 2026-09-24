import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { HR_EMAIL_SIGNATURE_HTML } from './hr-email-signature.mjs';

const targets = [
  {
    id: 'D6UG5ACZGILCpsOk',
    name: 'MAM People System - Leave Email Delivery',
    version: 'b72eee0c-35fd-484d-90c8-aebdf1bb67dc',
    sends: ['Send Leave Notification to HR'],
    field: 'emailHtml',
  },
  {
    id: 'zXBU666FFCjAhD87',
    name: 'MAM People System - Check-In Reminder Email Delivery',
    version: '728d981e-c610-4cce-bad8-6d4d20d27ba7',
    sends: [
      'Send 2-Week Email from HR',
      'Send Existing Check-In Email from HR',
      'Send 1-Month Email from HR',
      'Send 2-Month Stay Interview Email from HR',
      'Send 3-Month Midpoint Review Email from HR',
    ],
    field: 'bodyContent',
  },
  {
    id: 'LkLlS67zCHQeenIy',
    name: 'MAM Team Management - Synthetic Email Notifications (Marketing Test)',
    version: '901749c6-a910-4ae1-92b4-213d17c8b467',
    sends: ['Send to MAM HR Test Inbox'],
    field: 'emailHtml',
  },
];

function requireCondition(ok, message) {
  if (!ok) throw new Error(message);
}

function config() {
  const verified = spawnSync('python3', ['scripts/verify.py'], { encoding: 'utf8' });
  requireCondition(verified.status === 0 && verified.stdout.includes('MAM'), 'MAM n8n verification failed');
  const values = Object.fromEntries(readFileSync('.env', 'utf8').split(/\r?\n/)
    .filter((line) => /^[A-Z][A-Z0-9_]*=/.test(line))
    .map((line) => {
      const separator = line.indexOf('=');
      return [line.slice(0, separator), line.slice(separator + 1).trim().replace(/^(["'])(.*)\1$/, '$2')];
    }));
  requireCondition(values.N8N_INSTANCE_LABEL === 'MAM', 'Wrong n8n instance');
  requireCondition(/^https:\/\//.test(values.N8N_BASE_URL) && values.N8N_API_KEY, 'Missing verified MAM n8n connection');
  return values;
}

async function api(values, method, path, body) {
  const response = await fetch(`${values.N8N_BASE_URL.replace(/\/$/, '')}/api/v1/${path}`, {
    method,
    headers: {
      'X-N8N-API-KEY': values.N8N_API_KEY,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20000),
  });
  requireCondition(response.ok, `MAM n8n ${method} ${path} failed: HTTP ${response.status}`);
  return response.json();
}

function verifyAndPatch(workflow, target) {
  requireCondition(workflow.id === target.id && workflow.name === target.name, `${target.id}: unexpected workflow`);
  requireCondition(workflow.active === true && workflow.versionId === target.version
    && workflow.activeVersionId === target.version, `${target.id}: published version changed; review before applying`);
  const nodes = structuredClone(workflow.nodes);
  const expectedBody = `={{ $json.${target.field} }}`;
  const signedBody = `={{ String($json.${target.field} ?? '') + ${JSON.stringify(HR_EMAIL_SIGNATURE_HTML)} }}`;
  requireCondition(!nodes.some((node) => node.parameters?.bodyContent === signedBody), `${target.id}: signature already present`);
  for (const name of target.sends) {
    const matches = nodes.filter((node) => node.name === name);
    requireCondition(matches.length === 1, `${target.id}: send node missing or duplicated: ${name}`);
    const node = matches[0];
    requireCondition(node.type === 'n8n-nodes-base.microsoftOutlook'
      && node.parameters?.resource === 'message' && node.parameters?.operation === 'send'
      && node.parameters?.bodyContent === expectedBody
      && node.parameters?.additionalFields?.bodyContentType === 'html', `${target.id}: send node changed: ${name}`);
    node.parameters.bodyContent = signedBody;
  }
  const sendNames = nodes.filter((node) => node.type === 'n8n-nodes-base.microsoftOutlook'
    && node.parameters?.resource === 'message' && node.parameters?.operation === 'send')
    .map((node) => node.name).sort();
  requireCondition(JSON.stringify(sendNames) === JSON.stringify([...target.sends].sort()),
    `${target.id}: unreviewed Outlook send node found`);
  return { name: workflow.name, nodes, connections: workflow.connections, settings: workflow.settings };
}

async function main() {
  const apply = process.argv[2] === '--apply';
  requireCondition(process.argv.length === (apply ? 3 : 2), 'Usage: node deploy-people-hub-email-signature.mjs [--apply]');
  const values = config();
  const plans = [];
  for (const target of targets) {
    const before = await api(values, 'GET', `workflows/${target.id}`);
    plans.push({ target, before, payload: verifyAndPatch(before, target) });
  }
  if (!apply) {
    console.log(JSON.stringify({ mode: 'plan', workflows: plans.map(({ target }) => ({ id: target.id, sendNodes: target.sends.length })) }));
    return;
  }
  for (const { target, before, payload } of plans) {
    const latest = await api(values, 'GET', `workflows/${target.id}`);
    requireCondition(latest.versionId === before.versionId
      && latest.activeVersionId === before.activeVersionId
      && JSON.stringify(latest.nodes) === JSON.stringify(before.nodes)
      && JSON.stringify(latest.connections) === JSON.stringify(before.connections)
      && JSON.stringify(latest.settings) === JSON.stringify(before.settings),
    `${target.id}: workflow changed since the rollout plan`);
    await api(values, 'PUT', `workflows/${target.id}`, payload);
    const draft = await api(values, 'GET', `workflows/${target.id}`);
    requireCondition(draft.active === true && draft.versionId !== target.version
      && target.sends.every((name) => draft.nodes.find((node) => node.name === name)?.parameters?.bodyContent
        === payload.nodes.find((node) => node.name === name).parameters.bodyContent),
    `${target.id}: unexpected draft state after update`);
    await api(values, 'POST', `workflows/${target.id}/activate`);
    const published = await api(values, 'GET', `workflows/${target.id}`);
    requireCondition(published.active === true && published.activeVersionId === published.versionId,
      `${target.id}: updated version was not published`);
    for (const name of target.sends) {
      const actual = published.nodes.find((node) => node.name === name)?.parameters?.bodyContent;
      requireCondition(actual === payload.nodes.find((node) => node.name === name).parameters.bodyContent,
        `${target.id}: signed body not retained on ${name}`);
    }
    console.log(JSON.stringify({ id: target.id, published: true, sendNodes: target.sends.length }));
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
