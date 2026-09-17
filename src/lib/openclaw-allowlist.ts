import "server-only";
import { createHash, timingSafeEqual } from "node:crypto";

const secretPattern = /^[A-Za-z0-9_-]{43,128}$/;

export function allowlistAuthorization(request: Request, secret: string | undefined) {
  // Provision 32 random bytes encoded as base64url; never a human password.
  if (!secret || !secretPattern.test(secret)) return 503;
  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer ([A-Za-z0-9_-]{43,128})$/i.exec(header);
  if (!match) return 401;
  const hash = (value: string) => createHash("sha256").update(value).digest();
  return timingSafeEqual(hash(match[1]), hash(secret)) ? 200 : 401;
}

/** Strict international syntax, not proof of ownership or WhatsApp registration. */
export function normalizeAllowlistPhone(value: string | null): string | null {
  if (!value || value.length > 64) return null;
  // Only explicit '+' international numbers; no local-prefix guesses, extensions,
  // parentheses (optional trunk prefixes), or multiple-number separators.
  const trimmed = value.trim();
  if (!/^\+[1-9][0-9]*(?:[ -][0-9]+)*$/.test(trimmed)) return null;
  const normalized = trimmed.replace(/[ -]/g, "");
  return /^\+[1-9][0-9]{7,14}$/.test(normalized) ? normalized : null;
}

export function allowlistSnapshot(data: unknown, generatedAt: string) {
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("Invalid snapshot");
  const snapshot = data as Record<string, unknown>;
  if (snapshot.complete !== true || snapshot.schemaVersion !== 1 ||
      !Array.isArray(snapshot.phones) || snapshot.phones.length > 10000 ||
      snapshot.rowCount !== snapshot.phones.length ||
      Object.keys(snapshot).sort().join(",") !== "complete,phones,rowCount,schemaVersion") {
    throw new Error("Incomplete snapshot");
  }
  const counts = new Map<string, number>();
  for (const raw of snapshot.phones) {
    if (raw !== null && typeof raw !== "string") throw new Error("Invalid snapshot row");
    const phone = normalizeAllowlistPhone(raw);
    if (phone) counts.set(phone, (counts.get(phone) ?? 0) + 1);
  }
  // A shared phone has ambiguous employee ownership: exclude it, don't dedupe it
  // into an authorization. Correct the source records to restore access.
  const phones = [...counts].filter(([, count]) => count === 1).map(([phone]) => phone).sort();
  const schemaVersion = 1;
  const digest = createHash("sha256").update(JSON.stringify({ schemaVersion, phones })).digest("hex");
  return { schemaVersion, generatedAt, digest, phones };
}
