// A second scheduler, independent of n8n. It calls the same authenticated,
// database-leased dispatchers, never email webhooks or employee APIs directly.
const origin = 'https://mam-team-management-system-ten.vercel.app';
const secret = process.env.MAM_PEOPLE_HUB_CRON_SECRET?.trim();
if (!secret) throw new Error('MAM recovery credential is not configured.');
const paths = [
  'leave-notifications', 'check-in-reminders', 'leave-priority-reminders',
];
let failed = false;
for (const job of paths) {
  try {
    const response = await fetch(`${origin}/api/cron/recovery?job=${job}`, {
      headers: { authorization: `Bearer ${secret}` },
      signal: AbortSignal.timeout(310_000), redirect: 'error', cache: 'no-store',
    });
    const body = await response.json();
    if (!response.ok || body.ok !== true) {
      failed = true;
      console.error(`${job}: recovery incomplete (HTTP ${response.status}).`);
    } else {
      console.log(`${job}: checked.`);
    }
  } catch {
    failed = true;
    // Never log fetch errors, URLs, response bodies or employee information.
    console.error(`${job}: dispatcher unavailable.`);
  }
}
if (failed) process.exitCode = 1;
