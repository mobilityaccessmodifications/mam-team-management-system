import { fileURLToPath } from 'node:url';
import path from 'node:path';

const origin = 'https://mam-team-management-system-ten.vercel.app';
const paths = [
  'leave-notifications', 'check-in-reminders', 'new-starter-day-one', 'onboarding-credentials', 'scheduled-offboarding', 'leave-priority-reminders',
];

export async function runRecovery(secret, fetchJob = fetch, log = console, job) {
  if (job !== undefined && !paths.includes(job)) throw new Error('Select one supported recovery worker.');
  if (!secret?.trim()) throw new Error('MAM recovery credential is not configured.');
  const results = await Promise.all((job === undefined ? paths : [job]).map(async (job) => {
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
  const args = process.argv.slice(2);
  if (args.length !== 1 || !paths.includes(args[0])) {
    console.error('Select one supported recovery worker.');
    process.exitCode = 1;
  } else if (!process.env.MAM_PEOPLE_HUB_CRON_SECRET?.trim()) {
    console.error('MAM recovery credential is not configured.');
    process.exitCode = 1;
  } else if (!await runRecovery(process.env.MAM_PEOPLE_HUB_CRON_SECRET, fetch, console, args[0])) {
    process.exitCode = 1;
  }
}
