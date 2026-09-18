import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const ts = require('typescript');
test('route is disabled by default, rejects browser input and caps streamed body before database access', async () => {
  let calls = 0;
  const imports = {
    '@/lib/openclaw-leave-contract': { LEAVE_BRIDGE_PATH: '/api/internal/integrations/openclaw/leave', handleLeaveBridge: async () => { calls++; return { status: 401, body: { code: 'unauthorized' } }; } },
    '@/lib/openclaw-leave-store': { createLeaveBridgeStore: () => ({}) },
  };
  const mod = { exports: {} };
  new Function('require','module','exports',ts.transpileModule(fs.readFileSync('src/app/api/internal/integrations/openclaw/leave/route.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText)(id=>imports[id],mod,mod.exports);
  const names=['MAM_OPENCLAW_LEAVE_ENABLED','MAM_OPENCLAW_LEAVE_BRIDGE_SECRET','MAM_OPENCLAW_LEAVE_ACCOUNT'];
  const previous=names.map(n=>process.env[n]);
  const request=(body='{}',extra={},query='')=>new Request('https://example.test/api/internal/integrations/openclaw/leave'+query,{method:'POST',headers:{'content-type':'application/json','x-mam-timestamp':String(Date.now()),'x-mam-signature':'0'.repeat(64),...extra},body});
  try {
    delete process.env.MAM_OPENCLAW_LEAVE_ENABLED;
    assert.equal((await mod.exports.POST(request())).status,503);
    process.env.MAM_OPENCLAW_LEAVE_ENABLED='true';
    process.env.MAM_OPENCLAW_LEAVE_BRIDGE_SECRET='synthetic'; process.env.MAM_OPENCLAW_LEAVE_ACCOUNT='synthetic';
    for(const r of [request('{}',{origin:'https://example.test'}),request('{}',{cookie:'session=x'}),request('{}',{},'?employeeId=x')]) assert.equal((await mod.exports.POST(r)).status,400);
    assert.equal((await mod.exports.POST(request('x'.repeat(16385)))).status,413);
    assert.equal(calls,0);
    const response=await mod.exports.POST(request());
    assert.equal(response.status,401); assert.match(response.headers.get('cache-control'),/no-store/);
  } finally { names.forEach((n,i)=>{ if(previous[i]===undefined)delete process.env[n];else process.env[n]=previous[i]; }); }
});
