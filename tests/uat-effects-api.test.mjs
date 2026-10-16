import assert from 'node:assert/strict';
import test from 'node:test';
import { apiMethods, apiRequest, exportedMethods, fixture, ok, UNAVAILABLE } from './uat-effects-fixtures.mjs';

const methods = apiMethods();
test('actual API enumeration includes every route and HTTP method', () => {
  assert.equal(new Set(methods.map(value => value.path)).size, 17);
  assert.equal(methods.length, 18);
  assert.equal(methods.filter(value => value.path.includes('/cron/')).length, 11);
});

for (const { path, method } of methods) {
  test(`UAT actual API ${method} ${path} rejects before any effect`, async () => {
    const f = fixture();
    try {
      const handler = await f.load(path);
      assert.deepEqual(Object.keys(handler).filter(key => ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].includes(key)).sort(), exportedMethods(path));
      let result;
      let thrown;
      try { result = await handler[method](apiRequest(path, method)); } catch (error) { thrown = error; }
      f.observe(`${method} ${path}`, { status: result?.status, threw: Boolean(thrown) });
      f.assertZero(path);
      assert.equal(thrown, undefined);
      assert.equal(result.status, 403);
      assert.deepEqual(await result.json(), { error: UNAVAILABLE });
      await f.flush();
      f.assertZero(path + ' after flush');
    } finally { f.cleanup(); }
  });
}

test('ordinary accrual API retains authorized successful checkpoint', async () => {
  const calls = [];
  const f = fixture({ uat: false, admin: { rpc: async name => { calls.push(name); return ok(7); } } });
  try {
    const path = 'src/app/api/cron/leave-accrual/route.ts';
    const { GET } = await f.load(path);
    const response = await GET(apiRequest(path, 'GET'));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, recorded: 7 });
    assert.deepEqual(calls, ['refresh_employee_leave_accrual']);
    assert.deepEqual(f.calls, ['admin']);
  } finally { f.cleanup(); }
});

test('ordinary accrual API retains unauthorized denial', async () => {
  const f = fixture({ uat: false });
  try {
    const { GET } = await f.load('src/app/api/cron/leave-accrual/route.ts');
    const response = await GET(new Request('https://app.example.invalid/api/cron/leave-accrual'));
    assert.equal(response.status, 401);
    f.assertZero('ordinary unauthorized');
  } finally { f.cleanup(); }
});
