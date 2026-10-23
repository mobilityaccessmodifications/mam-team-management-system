import { GET as employeeLifecycle } from "../employee-lifecycle/route";
import { timingSafeEqual } from "node:crypto";
import { GET as leaveNotifications } from "../leave-notifications/route";
import { GET as checkInReminders } from "../check-in-reminders/route";
import { GET as newStarterDayOne } from "../new-starter-day-one/route";
import { GET as onboardingCredentials } from "../onboarding-credentials/route";
import { GET as scheduledOffboarding } from "../scheduled-offboarding/route";
import { GET as priorityReminders } from "../leave-priority-reminders/route";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

// The independent scheduler has a separate credential, scoped only to these
// delivery workers. It cannot call arbitrary internal routes or cleanup jobs.
const jobs: Record<string, (request: Request) => Promise<Response>> = {
  "employee-lifecycle": employeeLifecycle,
  "leave-notifications": leaveNotifications,
  "check-in-reminders": checkInReminders,
  "new-starter-day-one": newStarterDayOne,
  "onboarding-credentials": onboardingCredentials,
  "scheduled-offboarding": scheduledOffboarding,
  "leave-priority-reminders": priorityReminders,
};
export async function GET(request: Request) {
  const reply = (code: string, status: number) => Response.json({ ok: false, code }, {
    status, headers: { "Cache-Control": "no-store" },
  });
  const secret = process.env.MAM_BACKGROUND_RECOVERY_SECRET?.trim();
  const expected = Buffer.from(`Bearer ${secret ?? ""}`);
  const supplied = Buffer.from(request.headers.get("authorization") ?? "");
  if (!secret || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
    return reply("unauthorized", 401);
  }
  const job = new URL(request.url).searchParams.get("job") ?? "";
  if (!Object.hasOwn(jobs, job)) return reply("unknown_job", 400);
  const cronSecret = process.env.CRON_SECRET?.trim();
  if (!cronSecret) return reply("not_configured", 503);
  try {
    return await jobs[job](new Request(request.url, {
      headers: { authorization: `Bearer ${cronSecret}` },
    }));
  } catch {
    return reply("recovery_incomplete", 503);
  }
}
