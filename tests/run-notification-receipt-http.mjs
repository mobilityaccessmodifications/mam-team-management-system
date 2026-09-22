// Real Next.js proxy/route + Supabase HTTP client; all RPC data/keys are synthetic.
// PostgreSQL exclusivity is independently exercised by the SQL/concurrency suite.
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
const close = server => new Promise(resolve => server.close(resolve));
const secret = 'synthetic-notification-integration-secret-0001';
const apiKey = 'sb_secret_synthetic-local-unused';
const key = 'leave:10000000-0000-4000-8000-000000000001:leave-submitted:' + 'a'.repeat(24);
const token = '20000000-0000-4000-8000-000000000001';
const provider = { accepted: true, messageId: 'synthetic-provider', requestId: null, statusCode: 202 };
let calls = 0;
let state = null;
let fixtureError;
const rpcServer = http.createServer(async (req, res) => {
  try {
    assert.equal(req.headers.apikey, apiKey);
    assert.equal(req.headers.authorization, undefined, 'secret API key must not become a JWT');
    let raw = '';
    for await (const chunk of req) { raw += chunk; assert.ok(raw.length < 16384); }
    const args = JSON.parse(raw || '{}');
    calls++;
    let data;
    if (req.url === '/rest/v1/rpc/notification_delivery_store_status') data = { version: 1, ready: true };
    else if (req.url === '/rest/v1/rpc/reserve_notification_delivery') {
      assert.equal(args.p_event_key, key);
      if (!state) {
        state = 'processing'; data = { outcome: 'send', eventKey: key, deliveryToken: token };
      } else if (state === 'processing') data = { outcome: 'rejected', ok: false, sent: false, alreadySent: false,
        eventKey: key, rejectionCode: 'delivery-in-flight', reconciliationRequired: false };
      else data = { ...state, outcome: 'duplicate', sent: false, alreadySent: true };
    } else if (req.url === '/rest/v1/rpc/confirm_notification_delivery') {
      assert.equal(args.p_delivery_token, token); assert.deepEqual(args.p_provider_receipt, provider);
      state = { ok: true, sent: true, alreadySent: false, eventKey: key,
        actualRecipient: args.p_recipient, actualCcRecipients: args.p_cc, providerReceipt: provider };
      data = state;
    } else throw Error('Unexpected fixture RPC');
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data));
  } catch (error) {
    fixtureError = error; res.writeHead(500); res.end('{}');
  }
});
const rpcPort = await listen(rpcServer);
const portProbe = http.createServer();
const appPort = await listen(portProbe);
await close(portProbe);
const app = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'dev', '--hostname', '127.0.0.1', '--port', String(appPort)], {
  cwd: process.cwd(),
  env: { PATH: process.env.PATH, NODE_ENV: 'development', NEXT_TELEMETRY_DISABLED: '1',
    NEXT_PUBLIC_SUPABASE_URL: `http://127.0.0.1:${rpcPort}`, NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'synthetic-publishable-unused',
    SUPABASE_SECRET_KEY: apiKey, MAM_N8N_LEAVE_WEBHOOK_SECRET: secret },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let output = '';
for (const stream of [app.stdout, app.stderr]) stream.on('data', chunk => { output = (output + chunk).slice(-6000); });
const url = `http://127.0.0.1:${appPort}/api/internal/integrations/notifications/receipts`;
const invoke = (body, headers = {}) => fetch(url, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10_000),
  headers: { 'Content-Type': 'application/json', 'X-MAM-Notification-Secret': secret, ...headers }, body: JSON.stringify(body) });
try {
  let ready = false;
  for (let attempt = 0; attempt < 80; attempt++) {
    if (app.exitCode !== null) throw Error('Local Next server exited: ' + output);
    try {
      const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(1500) });
      if (response.status === 401) { ready = true; break; }
    } catch { /* Await only this task's synthetic server. */ }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  assert.ok(ready, 'Local Next receipt route did not become ready: ' + output);
  assert.equal(calls, 0, 'Unauthenticated route must not create a privileged client request');
  const get = await fetch(url, { headers: { 'X-MAM-Notification-Secret': secret } });
  assert.equal(get.status, 200); assert.deepEqual(await get.json(), { version: 1, ready: true });
  assert.equal(calls, 1);
  const body = { action: 'reserve', eventKey: key, recipient: 'Manager@Example.test', cc: '', legacyEventKey: null };
  for (const headers of [{ Cookie: 'synthetic=browser' }, { Origin: 'https://example.test' }]) {
    assert.equal((await invoke(body, headers)).status, 400);
  }
  assert.equal(calls, 1);
  const granted = await invoke(body);
  assert.match(granted.headers.get('cache-control'), /no-store/);
  assert.deepEqual(await granted.json(), { outcome: 'send', eventKey: key, deliveryToken: token });
  const repeated = await (await invoke(body)).json();
  assert.equal(repeated.rejectionCode, 'delivery-in-flight'); assert.equal(repeated.deliveryToken, undefined);
  const confirm = await invoke({ action: 'confirm', eventKey: key, recipient: 'manager@example.test', cc: '', deliveryToken: token, providerReceipt: provider });
  assert.equal(confirm.status, 200); assert.equal((await confirm.json()).sent, true);
  const replay = await (await invoke(body)).json();
  assert.equal(replay.alreadySent, true); assert.equal(replay.actualRecipient, 'manager@example.test');
  assert.deepEqual(replay.providerReceipt, provider);
  if (fixtureError) throw fixtureError;
  console.log('PASS real Next.js proxy/HTTP route, secret-key Supabase client, reserve/confirm/replay with synthetic RPCs; no email sender exists');
} finally {
  if (app.exitCode === null) {
    const stopped = once(app, 'exit'); app.kill('SIGTERM');
    const kill = setTimeout(() => app.kill('SIGKILL'), 5000);
    await stopped; clearTimeout(kill);
  }
  await close(rpcServer);
}
