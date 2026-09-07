import { createHash, timingSafeEqual } from "node:crypto";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

/** MAM runs at 07:00 (birthdays) and 08:00 (leave); SQL enforces each window. */
export async function GET(request: Request) {
  const expected = Buffer.from(`Bearer ${process.env.CRON_SECRET?.trim() ?? ""}`);
  const provided = Buffer.from(request.headers.get("authorization") ?? "");
  const response = (body: object, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
  if (!process.env.CRON_SECRET?.trim() || expected.length !== provided.length || !timingSafeEqual(expected, provided)) return response({ ok: false }, 401);
  const hour = Number(new Intl.DateTimeFormat("en-AU", { timeZone: "Australia/Melbourne", hour: "numeric", hourCycle: "h23" }).format(new Date()));
  if (hour < 7 || hour >= 17) return response({ ok: true, code: "outside_delivery_window" });
  const secret = process.env.MAM_N8N_LEAVE_WEBHOOK_SECRET?.trim();
  let url: URL;
  try {
    url = new URL(process.env.MAM_N8N_LEAVE_WEBHOOK_URL ?? "");
    const origin = new URL(process.env.MAM_N8N_LEAVE_WEBHOOK_ORIGIN ?? "");
    if (!secret || url.protocol !== "https:" || url.origin !== origin.origin || origin.pathname !== "/"
      || origin.username || origin.password || origin.search || origin.hash || url.username || url.password || url.search || url.hash || url.pathname === "/") throw new Error();
  } catch { return response({ ok: false, code: "not_configured" }, 503); }
  const admin = createAdminClient();
  const { data, error } = await admin.rpc("claim_leave_priority_reminders", { p_limit: 100 });
  if (error || !Array.isArray(data)) return response({ ok: false, code: "claim_failed" }, 500);
  let sent = 0;
  let failed = 0;
  // Bounded groups avoid overloading the provider while keeping the daily run short.
  for (let offset = 0; offset < data.length; offset += 10) {
    await Promise.all(data.slice(offset, offset + 10).map(async (r) => {
      if (!r.manager_email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(r.manager_email)) { failed++; return; }
      const eventKey = `leave:${r.source_id}:${r.event}:${createHash("sha256").update(r.delivery_id).digest("hex").slice(0,24)}`;
      try {
        const result = await fetch(url, { method: "POST", redirect: "error", signal: AbortSignal.timeout(15_000),
          headers: { "Content-Type": "application/json", "X-MAM-Notification-Secret": secret! },
          body: JSON.stringify({ version: 1, event: r.event, eventKey, requestId: r.source_id,
            employeeName: r.employee_name, employeeEmail: null, employeeEmails: [], company: r.company,
            leaveType: r.leave_type, startDate: r.start_date, endDate: r.end_date, startTime: null, endTime: null,
            days: null, hours: null, status: r.status, employeeNote: null, managerNote: null,
            managerEmail: r.manager_email, ccEmails: ["hr@mobilityaccess.com.au"], wasApproved: false }),
        });
        const receipt = await result.json();
        if (!result.ok || receipt.ok !== true || !(receipt.sent || receipt.alreadySent) || receipt.eventKey !== eventKey
          || String(receipt.actualRecipient).toLowerCase() !== r.manager_email.toLowerCase()) { failed++; return; }
        const finished = await admin.rpc("complete_leave_priority_reminder", { p_delivery_id: r.delivery_id, p_claim_token: r.claim_token });
        if (finished.error || finished.data !== true) failed++; else sent++;
      } catch { failed++; }
    }));
  }
  return response({ ok: failed === 0, claimed: data.length, sent, failed }, failed ? 502 : 200);
}
