import assert from 'node:assert/strict';

if (process.env.MAM_SYNTHETIC_TIMEOUT === 'true') {
  const timeout = AbortSignal.timeout;
  AbortSignal.timeout = (milliseconds) => {
    assert.equal(milliseconds, 310_000);
    return timeout(50);
  };
}

globalThis.fetch = async (url, options) => {
  assert.equal(new URL(url).origin, 'https://mam-team-management-system-ten.vercel.app');
  assert.equal(options.headers.authorization, 'Bearer synthetic-cli-only');
  const job = new URL(url).searchParams.get('job');
  process.stdout.write(`SYNTHETIC_REQUEST:${job}\n`);
  if (process.env.MAM_SYNTHETIC_TIMEOUT === 'true') {
    await new Promise((resolve, reject) => {
      const keepAlive = setInterval(() => {}, 100);
      const aborted = () => { clearInterval(keepAlive); reject(options.signal.reason); };
      if (options.signal.aborted) aborted();
      else options.signal.addEventListener('abort', aborted, { once: true });
    });
  }
  if (process.env.MAM_SYNTHETIC_HOLD === 'true') {
    await new Promise(resolve => {
      process.once('message', message => { assert.equal(message, 'release'); resolve(); });
      process.send('held');
    });
  }
  if (process.env.MAM_SYNTHETIC_FAILURE === 'true') throw new Error('SYNTHETIC_PRIVATE_DETAIL');
  return Response.json({ ok: true, privateDetail: 'SYNTHETIC_PRIVATE_DETAIL' });
};
