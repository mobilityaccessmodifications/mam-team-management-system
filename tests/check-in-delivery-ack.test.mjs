import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const ackModule = { exports: {} };
new Function('require', 'module', 'exports', ts.transpileModule(readFileSync('src/lib/check-in-delivery-ack.ts', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText)(require, ackModule, ackModule.exports);
const { readCheckInDeliveryAck } = ackModule.exports;
const deliveryId = 'checkin:00000000-0000-4000-8000-000000000001:6-month:initial:live';

test('both reminder workers accept only a bounded, matching, unambiguous delivery receipt', async () => {
  const valid = { ok: true, sent: false, alreadySent: true, deliveryId };
  assert.deepEqual(await readCheckInDeliveryAck(Response.json(valid), deliveryId), valid);
  for (const body of [
    { ...valid, deliveryId: deliveryId + ':other' },
    { ...valid, sent: true },
    { ...valid, alreadySent: false },
    { ...valid, ok: false },
  ]) assert.equal(await readCheckInDeliveryAck(Response.json(body), deliveryId), null);
  assert.equal(await readCheckInDeliveryAck(new Response('x'.repeat(8193)), deliveryId), null);
  assert.equal(await readCheckInDeliveryAck(new Response('{invalid'), deliveryId), null);
  const oversizedStream = new ReadableStream({ start(controller) {
    controller.enqueue(new Uint8Array(5000));
    controller.enqueue(new Uint8Array(5000));
    controller.close();
  } });
  assert.equal(await readCheckInDeliveryAck(new Response(oversizedStream), deliveryId), null);
});
