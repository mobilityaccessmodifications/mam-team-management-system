import "server-only";

import { createHmac } from "node:crypto";
import { Webhook } from "standardwebhooks";

export const runtime = "nodejs";
export const maxDuration = 5;

const MAX_BODY_BYTES = 20 * 1024;
const MAX_RESPONSE_BYTES = 4 * 1024;
const N8N_TIMEOUT_MS = 2_300;
const MAM_EMAIL_DOMAIN = "mobilityaccess.com.au";
const VERIFIED_N8N_HOST = "n8n.srv1866578.hstgr.cloud";
const WEBHOOK_PATH = /^\/webhook\/mam-auth-email-[A-Za-z0-9_-]{8,160}\/?$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const BASE64_SECRET = /^v1,whsec_[A-Za-z0-9+/]{40,256}={0,2}$/;
const SERVER_SECRET = /^[A-Za-z0-9_-]{32,256}$/;

type UnknownRecord = Record<string, unknown>;

type AuthEmail = {
  userId: string;
  recipient: string;
  code: string;
  action: "magiclink";
  tokenHash: string;
};

function jsonResponse(body: object, status: number, retry = false) {
  return Response.json(body, {
    status,
    headers: {
      "Cache-Control": "no-store",
      ...(retry ? { "Retry-After": "2" } : {}),
    },
  });
}

function invalidRequest(status: number) {
  return jsonResponse(
    { error: { http_code: status, message: "The auth email request was rejected." } },
    status,
  );
}

function unavailable() {
  return jsonResponse(
    { error: { http_code: 503, message: "Auth email delivery is temporarily unavailable." } },
    503,
    true,
  );
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasConfirmedEmail(user: UnknownRecord) {
  for (const key of ["email_confirmed_at", "confirmed_at"] as const) {
    if (!Object.hasOwn(user, key)) continue;
    const value = user[key];
    return typeof value === "string" && value.length <= 64 && !Number.isNaN(Date.parse(value));
  }
  return true;
}

function parseAuthEmail(payload: unknown): AuthEmail | null {
  if (!isRecord(payload) || !isRecord(payload.user) || !isRecord(payload.email_data)) {
    return null;
  }

  const user = payload.user;
  const emailData = payload.email_data;
  const email = user.email;
  const userId = user.id;
  const token = emailData.token;
  const tokenHash = emailData.token_hash;
  const action = emailData.email_action_type;

  if (
    typeof userId !== "string"
    || !UUID.test(userId)
    || user.aud !== "authenticated"
    || (user.role !== "authenticated" && user.role !== "anon")
    || user.is_anonymous !== false
    || !hasConfirmedEmail(user)
    || typeof email !== "string"
    || email.length > 254
    || email !== email.trim()
    || typeof token !== "string"
    || !/^\d{6}$/.test(token)
    || typeof tokenHash !== "string"
    || !/^[A-Za-z0-9_-]{16,128}$/.test(tokenHash)
    || action !== "magiclink"
  ) {
    return null;
  }

  const at = email.lastIndexOf("@");
  if (
    at < 1
    || at !== email.indexOf("@")
    || email.slice(at + 1).toLowerCase() !== MAM_EMAIL_DOMAIN
    || !/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+$/.test(email.slice(0, at))
  ) {
    return null;
  }

  return {
    userId,
    recipient: email.toLowerCase(),
    code: token,
    action,
    tokenHash,
  };
}

async function readBody(request: Request): Promise<Buffer | null> {
  if (!request.body) return Buffer.alloc(0);

  const reader = request.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(Buffer.from(value));
  }

  return Buffer.concat(chunks, total);
}

function getSignedHeaders(request: Request) {
  const id = request.headers.get("webhook-id");
  const timestamp = request.headers.get("webhook-timestamp");
  const signature = request.headers.get("webhook-signature");
  if (
    !id
    || id.length > 256
    || !timestamp
    || timestamp.length > 32
    || !signature
    || signature.length > 4_096
  ) {
    return null;
  }
  return {
    "webhook-id": id,
    "webhook-timestamp": timestamp,
    "webhook-signature": signature,
  };
}

function getN8nConfig() {
  const rawUrl = process.env.MAM_N8N_AUTH_EMAIL_WEBHOOK_URL;
  const secret = process.env.MAM_N8N_AUTH_EMAIL_WEBHOOK_SECRET;
  if (!rawUrl || rawUrl.length > 2_048 || !secret || !SERVER_SECRET.test(secret)) return null;

  try {
    const url = new URL(rawUrl);
    if (
      url.protocol !== "https:"
      || url.hostname !== VERIFIED_N8N_HOST
      || url.port
      || url.username
      || url.password
      || url.search
      || url.hash
      || !WEBHOOK_PATH.test(url.pathname)
    ) {
      return null;
    }
    return { url, secret };
  } catch {
    return null;
  }
}

async function readN8nResponse(response: Response) {
  if (response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
    return null;
  }
  const declaredLength = response.headers.get("content-length");
  if (declaredLength) {
    const length = Number(declaredLength);
    if (!Number.isSafeInteger(length) || length < 0 || length > MAX_RESPONSE_BYTES) return null;
  }

  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > MAX_RESPONSE_BYTES) return null;

  try {
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export async function POST(request: Request) {
  const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") return invalidRequest(415);

  const declaredLength = request.headers.get("content-length");
  if (declaredLength) {
    const length = Number(declaredLength);
    if (!Number.isSafeInteger(length) || length < 0) return invalidRequest(400);
    if (length > MAX_BODY_BYTES) return invalidRequest(413);
  }

  const headers = getSignedHeaders(request);
  if (!headers) return invalidRequest(400);

  let rawBody: Buffer | null;
  try {
    rawBody = await readBody(request);
  } catch {
    return invalidRequest(400);
  }
  if (!rawBody) return invalidRequest(413);

  const configuredHookSecret = process.env.MAM_SUPABASE_AUTH_HOOK_SECRET;
  if (!configuredHookSecret || !BASE64_SECRET.test(configuredHookSecret)) return unavailable();

  let verifiedPayload: unknown;
  try {
    const verifierSecret = configuredHookSecret.slice("v1,whsec_".length);
    verifiedPayload = new Webhook(verifierSecret).verify(rawBody, headers);
  } catch {
    return invalidRequest(401);
  }

  const authEmail = parseAuthEmail(verifiedPayload);
  if (!authEmail) return invalidRequest(400);

  const n8n = getN8nConfig();
  if (!n8n) return unavailable();

  const eventId = createHmac("sha256", configuredHookSecret)
    .update(authEmail.userId)
    .update("\0")
    .update(authEmail.action)
    .update("\0")
    .update(authEmail.tokenHash)
    .digest("hex");

  try {
    const response = await fetch(n8n.url, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "X-MAM-Auth-Email-Secret": n8n.secret,
      },
      body: JSON.stringify({
        version: 1,
        eventId,
        recipient: authEmail.recipient,
        code: authEmail.code,
        action: authEmail.action,
      }),
      cache: "no-store",
      signal: AbortSignal.timeout(N8N_TIMEOUT_MS),
    });
    const result = await readN8nResponse(response);
    if (!response.ok || result?.ok !== true || result.accepted !== true) return unavailable();
  } catch {
    return unavailable();
  }

  return jsonResponse({}, 200);
}
