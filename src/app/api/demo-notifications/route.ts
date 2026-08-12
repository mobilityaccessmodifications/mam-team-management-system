import { NextResponse } from "next/server";

import {
  buildCheckInNotification,
  buildLeaveNotification,
  deliverDemoNotification,
  DemoNotificationError,
  type DemoNotificationEvent,
} from "@/lib/email/demo-notifications";

export const runtime = "nodejs";
export const maxDuration = 20;

const PRODUCTION_ORIGIN = "https://mam-team-management-system-ten.vercel.app";
const REQUEST_WINDOW_MS = 5 * 60 * 1000;
const MAX_REQUESTS_PER_WINDOW = 12;
const requestWindows = new Map<string, number[]>();

type NotificationRequest = {
  event?: unknown;
  requestId?: unknown;
  notificationKey?: unknown;
};

function jsonError(message: string, status: number) {
  return NextResponse.json({ ok: false, error: message }, { status });
}

function isAllowedOrigin(request: Request) {
  if (process.env.VERCEL_ENV !== "production") return false;
  return request.headers.get("origin") === PRODUCTION_ORIGIN;
}

function isRateLimited(request: Request) {
  const now = Date.now();
  const forwardedFor = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  const key = forwardedFor || "unknown";
  const active = (requestWindows.get(key) ?? []).filter((timestamp) => now - timestamp < REQUEST_WINDOW_MS);
  active.push(now);
  requestWindows.set(key, active);

  if (requestWindows.size > 500) {
    for (const [entryKey, timestamps] of requestWindows) {
      if (!timestamps.some((timestamp) => now - timestamp < REQUEST_WINDOW_MS)) requestWindows.delete(entryKey);
    }
  }
  return active.length > MAX_REQUESTS_PER_WINDOW;
}

function isLeaveEvent(value: unknown): value is Exclude<DemoNotificationEvent, "checkin-reminder"> {
  return value === "review-requested" || value === "approved" || value === "declined";
}

export async function POST(request: Request) {
  if (!isAllowedOrigin(request)) return jsonError("Email delivery is available only from the production demo.", 403);
  if (isRateLimited(request)) return jsonError("Too many email attempts. Try again later.", 429);
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    return jsonError("Send a JSON request.", 415);
  }
  const declaredLength = Number(request.headers.get("content-length") ?? 0);
  if (declaredLength > 1_024) return jsonError("The request is too large.", 413);

  let payload: NotificationRequest;
  try {
    const raw = await request.text();
    if (raw.length > 1_024) return jsonError("The request is too large.", 413);
    payload = JSON.parse(raw) as NotificationRequest;
  } catch {
    return jsonError("The request body is invalid.", 400);
  }

  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return jsonError("The request body is invalid.", 400);
  }
  const keys = Object.keys(payload).sort();
  const validLeaveShape = isLeaveEvent(payload.event)
    && keys.length === 2
    && keys[0] === "event"
    && keys[1] === "requestId";
  const validCheckInShape = payload.event === "checkin-reminder"
    && keys.length === 2
    && keys[0] === "event"
    && keys[1] === "notificationKey";
  if (!validLeaveShape && !validCheckInShape) {
    return jsonError("The request contains unsupported fields.", 400);
  }

  try {
    let envelope;
    if (isLeaveEvent(payload.event)) {
      if (typeof payload.requestId !== "string" || !/^MAM-[0-9]{1,10}$/.test(payload.requestId)) {
        throw new DemoNotificationError("Choose a valid synthetic leave request.", 400);
      }
      envelope = await buildLeaveNotification(payload.requestId, payload.event);
    } else if (payload.event === "checkin-reminder" && typeof payload.notificationKey === "string") {
      envelope = buildCheckInNotification(payload.notificationKey);
    } else {
      throw new DemoNotificationError("Choose a valid notification event.", 400);
    }

    const delivery = await deliverDemoNotification(envelope);
    return NextResponse.json({ ok: true, ...delivery });
  } catch (error) {
    if (error instanceof DemoNotificationError) return jsonError(error.message, error.status);
    return jsonError("The notification could not be delivered.", 500);
  }
}
