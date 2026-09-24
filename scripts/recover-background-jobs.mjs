import { fileURLToPath } from 'node:url';
import path from 'node:path';

const origin = 'https://mam-team-management-system-ten.vercel.app';
const paths = [
  'leave-notifications', 'check-in-reminders', 'new-starter-day-one', 'leave-priority-reminders',
];

export async function runRecovery(secret, fetchJob = fetch, log = console) {
  if (!secret?.trim()) throw new Error('MAM recovery credential is not configured.');
  const results = await Promise.all(paths.map(async (job) => {
    try {
      const response = await fetchJob(`${origin}/api/cron/recovery?job=${job}`, {
        headers: { authorization: `Bearer ${secret}` },
        signal: AbortSignal.timeout(310_000), redirect: 'error', cache: 'no-store',
      });
      const body = await response.json();
      if (!response.ok || body?.ok !== true) {
        log.error(`${job}: recovery incomplete (HTTP ${response.status}).`);
        return false;
      }
      log.log(`${job}: checked.`);
      return true;
    } catch {
      // Never log fetch errors, URLs, response bodies or employee information.
      log.error(`${job}: dispatcher unavailable.`);
      return false;
    }
  }));
  return results.every(Boolean);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!await runRecovery(process.env.MAM_PEOPLE_HUB_CRON_SECRET)) process.exitCode = 1;
}
