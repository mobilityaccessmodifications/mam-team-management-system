import { createHash } from "node:crypto";

import { createClient } from "@supabase/supabase-js";

import { requireSupabaseConfig, sharedDemoEnabled } from "@/lib/supabase/config";

export type DemoNotificationEvent =
  | "review-requested"
  | "approved"
  | "declined"
  | "checkin-reminder";

type IntendedRecipient = "Team Leader" | "Employee" | "HR" | "Accounts";

type DemoNotificationMessage = {
  intendedRecipient: IntendedRecipient;
  intendedRecipientName: string;
  subject: string;
  lines: string[];
  actionUrl?: string;
  actionLabel?: string;
};

type DemoLeaveRequestRow = {
  id: string;
  employee_profile_id: string;
  manager_profile_id: string;
  leave_type: string;
  start_date: string;
  end_date: string;
  start_time: string | null;
  end_time: string | null;
  days: number | string;
  hours: number | string | null;
  approval_required: boolean;
  status: "Pending" | "Approved" | "Declined";
  submitted_at: string;
  employee_note: string;
  manager_note: string | null;
  decided_at: string | null;
  is_synthetic: boolean;
};

type DemoProfileRow = {
  id: string;
  full_name: string;
  access_role: "hr" | "manager" | "employee";
  team: string;
  is_synthetic: boolean;
};

type N8nDeliveryResponse = {
  ok?: boolean;
  sent?: boolean;
  alreadySent?: boolean;
  messageCount?: number;
  actualRecipient?: string;
};

export type DemoNotificationDelivery = {
  status: "sent" | "already-sent";
  messageCount: number;
  actualRecipient: "ai@mobilityaccess.com.au";
};

export class DemoNotificationError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "DemoNotificationError";
  }
}

const PRODUCTION_ORIGIN = "https://mam-team-management-system-ten.vercel.app";
const FIXED_REVIEW_INBOX = "ai@mobilityaccess.com.au" as const;
const VERIFIED_N8N_HOST = "n8n.srv1866578.hstgr.cloud";
const ALLOWED_CHECK_IN_REMINDERS = new Map<string, DemoNotificationMessage>([
  [
    "checkin:person-noah:2-week:Initial:2026-08-13:2026-08-10",
    {
      intendedRecipient: "Team Leader",
      intendedRecipientName: "Taylor Morgan",
      subject: "Check-in reminder — Noah Williams · 2-week",
      lines: [
        "Employee: Noah Williams",
        "Role: Project coordinator · Major Modifications",
        "Check-in due: 13 Aug 2026",
        "Reminder schedule: initial reminder on 10 Aug 2026",
        "Action: Schedule the check-in and use the MAM check-in / probation template.",
      ],
      actionUrl: `${PRODUCTION_ORIGIN}/?view=people`,
      actionLabel: "Open People workspace",
    },
  ],
]);

function cleanText(value: unknown, maxLength = 500) {
  return String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function formatDate(value: string) {
  const date = new Date(`${value}T12:00:00Z`);
  if (Number.isNaN(date.getTime())) throw new DemoNotificationError("The leave dates are invalid.", 422);
  return new Intl.DateTimeFormat("en-AU", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(date);
}

function formatDateRange(startDate: string, endDate: string) {
  if (startDate === endDate) return formatDate(startDate);
  return `${formatDate(startDate)}–${formatDate(endDate)}`;
}

function formatClock(value: string) {
  const [hourValue, minuteValue] = value.split(":");
  const hour = Number(hourValue);
  const minute = Number(minuteValue);
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) {
    throw new DemoNotificationError("The leave times are invalid.", 422);
  }
  const suffix = hour >= 12 ? "pm" : "am";
  return `${hour % 12 || 12}:${String(minute).padStart(2, "0")} ${suffix}`;
}

function formatTimeRange(request: DemoLeaveRequestRow) {
  if (!request.start_time || !request.end_time) return "Full working days";
  if (request.start_date === request.end_date) {
    return `${formatClock(request.start_time)}–${formatClock(request.end_time)}`;
  }
  return `First day from ${formatClock(request.start_time)} · last day until ${formatClock(request.end_time)}`;
}

function formatDuration(request: DemoLeaveRequestRow) {
  if (request.hours !== null) {
    const hours = Number(request.hours);
    return `${hours} ${hours === 1 ? "hour" : "hours"}`;
  }
  const days = Number(request.days);
  return `${days} ${days === 1 ? "day" : "days"}`;
}

function eventKey(requestId: string, event: DemoNotificationEvent, transition: string) {
  const digest = createHash("sha256").update(transition).digest("hex").slice(0, 24);
  return `mam-demo:${requestId}:${event}:${digest}`;
}

function leaveDetails(
  request: DemoLeaveRequestRow,
  employeeName: string,
  includeReason: boolean,
  includeManagerNote: boolean,
) {
  const lines = [
    `Employee: ${employeeName}`,
    `Leave type: ${cleanText(request.leave_type, 80)}`,
    `Dates: ${formatDateRange(request.start_date, request.end_date)}`,
    `Times: ${formatTimeRange(request)}`,
    `Duration: ${formatDuration(request)}`,
  ];

  if (includeReason) lines.push(`Reason: ${cleanText(request.employee_note) || "No note added."}`);
  if (includeManagerNote && request.manager_note) {
    lines.push(`Manager note: ${cleanText(request.manager_note)}`);
  }
  return lines;
}

async function loadSyntheticLeaveRequest(requestId: string) {
  if (!sharedDemoEnabled) {
    throw new DemoNotificationError("Real email is available only in the shared synthetic demo.", 503);
  }

  const { supabaseUrl, supabasePublishableKey } = requireSupabaseConfig();
  const supabase = createClient(supabaseUrl, supabasePublishableKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: request, error: requestError } = await supabase
    .from("demo_leave_requests")
    .select("id, employee_profile_id, manager_profile_id, leave_type, start_date, end_date, start_time, end_time, days, hours, approval_required, status, submitted_at, employee_note, manager_note, decided_at, is_synthetic")
    .eq("id", requestId)
    .eq("is_synthetic", true)
    .maybeSingle<DemoLeaveRequestRow>();

  if (requestError) throw new DemoNotificationError("The synthetic leave request could not be checked.", 502);
  if (!request?.is_synthetic) throw new DemoNotificationError("Synthetic leave request not found.", 404);

  const { data: profiles, error: profileError } = await supabase
    .from("demo_profiles")
    .select("id, full_name, access_role, team, is_synthetic")
    .in("id", [request.employee_profile_id, request.manager_profile_id])
    .eq("is_synthetic", true)
    .returns<DemoProfileRow[]>();

  if (profileError) throw new DemoNotificationError("The synthetic profile assignment could not be checked.", 502);
  const employee = profiles?.find((profile) => profile.id === request.employee_profile_id);
  const manager = profiles?.find((profile) => profile.id === request.manager_profile_id);
  if (!employee?.is_synthetic || !manager?.is_synthetic) {
    throw new DemoNotificationError("The synthetic profile assignment is incomplete.", 422);
  }

  return { request, employee, manager };
}

export async function buildLeaveNotification(
  requestId: string,
  event: Exclude<DemoNotificationEvent, "checkin-reminder">,
) {
  const { request, employee, manager } = await loadSyntheticLeaveRequest(requestId);

  if (!request.approval_required) {
    throw new DemoNotificationError("Direct manager leave does not create an approval email.", 422);
  }
  if (event === "review-requested" && (request.status !== "Pending" || request.decided_at)) {
    throw new DemoNotificationError("This request is not awaiting review.", 409);
  }
  if (event === "approved" && (request.status !== "Approved" || !request.decided_at)) {
    throw new DemoNotificationError("This request does not have a matching approval.", 409);
  }
  if (event === "declined" && (request.status !== "Declined" || !request.decided_at)) {
    throw new DemoNotificationError("This request does not have a matching decline.", 409);
  }

  const employeeName = cleanText(employee.full_name, 80);
  const managerName = cleanText(manager.full_name, 80);
  const reviewUrl = `${PRODUCTION_ORIGIN}/?view=leave&section=approvals&request=${encodeURIComponent(request.id)}`;
  let messages: DemoNotificationMessage[];

  if (event === "review-requested") {
    messages = [{
      intendedRecipient: "Team Leader",
      intendedRecipientName: managerName,
      subject: `Leave request awaiting review — ${employeeName}`,
      lines: leaveDetails(request, employeeName, true, false),
      actionUrl: reviewUrl,
      actionLabel: "Review leave request",
    }];
  } else if (event === "declined") {
    messages = [{
      intendedRecipient: "Employee",
      intendedRecipientName: employeeName,
      subject: `Leave request declined — ${cleanText(request.leave_type, 80)}`,
      lines: leaveDetails(request, employeeName, true, true),
    }];
  } else {
    messages = [
      {
        intendedRecipient: "Employee",
        intendedRecipientName: employeeName,
        subject: `Leave request approved — ${cleanText(request.leave_type, 80)}`,
        lines: leaveDetails(request, employeeName, true, true),
      },
      {
        intendedRecipient: "HR",
        intendedRecipientName: "Priya Singh",
        subject: `Leave approved — ${employeeName}`,
        lines: leaveDetails(request, employeeName, true, true),
      },
      {
        intendedRecipient: "Accounts",
        intendedRecipientName: "Accounts team",
        subject: `Leave approved — ${employeeName}`,
        lines: [
          ...leaveDetails(request, employeeName, false, false),
          "Status: Approved",
          "The reason, manager note and supporting files remain private.",
        ],
      },
    ];
  }

  return {
    version: 1,
    event,
    eventKey: eventKey(
      request.id,
      event,
      event === "review-requested" ? request.submitted_at : request.decided_at ?? request.submitted_at,
    ),
    requestId: request.id,
    messages,
  };
}

export function buildCheckInNotification(notificationKey: string) {
  const message = ALLOWED_CHECK_IN_REMINDERS.get(notificationKey);
  if (!message) throw new DemoNotificationError("Synthetic check-in reminder not found.", 404);
  return {
    version: 1,
    event: "checkin-reminder" as const,
    eventKey: eventKey("OPS-CHECK-IN", "checkin-reminder", notificationKey),
    requestId: "OPS-CHECK-IN",
    messages: [message],
  };
}

export async function deliverDemoNotification(
  envelope: Awaited<ReturnType<typeof buildLeaveNotification>> | ReturnType<typeof buildCheckInNotification>,
): Promise<DemoNotificationDelivery> {
  if (process.env.MAM_DEMO_EMAIL_ENABLED !== "true") {
    throw new DemoNotificationError("Demo email delivery is disabled.", 503);
  }
  const webhookUrl = process.env.MAM_N8N_LEAVE_WEBHOOK_URL;
  const webhookSecret = process.env.MAM_N8N_LEAVE_WEBHOOK_SECRET;
  if (!webhookUrl || !webhookSecret) {
    throw new DemoNotificationError("Demo email delivery is not configured.", 503);
  }

  let url: URL;
  try {
    url = new URL(webhookUrl);
  } catch {
    throw new DemoNotificationError("Demo email delivery is not configured safely.", 503);
  }
  if (
    url.protocol !== "https:"
    || url.hostname !== VERIFIED_N8N_HOST
    || !url.pathname.startsWith("/webhook/mam-team-management-notifications-")
  ) {
    throw new DemoNotificationError("Demo email delivery is not configured safely.", 503);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-MAM-Notification-Secret": webhookSecret,
      },
      body: JSON.stringify(envelope),
      cache: "no-store",
      signal: controller.signal,
    });
    const text = await response.text();
    let result: N8nDeliveryResponse = {};
    if (text && text.length <= 4_096) {
      try {
        result = JSON.parse(text) as N8nDeliveryResponse;
      } catch {
        result = {};
      }
    }
    const expectedMessageCount = envelope.messages.length;
    const deliveryConfirmed = result.sent === true || result.alreadySent === true;
    if (
      !response.ok
      || !result.ok
      || !deliveryConfirmed
      || result.actualRecipient !== FIXED_REVIEW_INBOX
      || result.messageCount !== expectedMessageCount
    ) {
      throw new DemoNotificationError("The notification was saved, but email delivery failed.", 502);
    }
    return {
      status: result.alreadySent ? "already-sent" : "sent",
      messageCount: expectedMessageCount,
      actualRecipient: FIXED_REVIEW_INBOX,
    };
  } catch (error) {
    if (error instanceof DemoNotificationError) throw error;
    throw new DemoNotificationError("The notification was saved, but email delivery failed.", 502);
  } finally {
    clearTimeout(timeout);
  }
}
