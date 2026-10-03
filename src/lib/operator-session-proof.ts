import "server-only";

import { requireSupabaseConfig } from "@/lib/supabase/config";

const PROJECT_URL = "https://xtwlrjqbusadghavchqm.supabase.co";
const COOKIE_NAME = "sb-xtwlrjqbusadghavchqm-auth-token";

function hasOriginalIntegerClaims(token: string): boolean {
  const encoded = token.split(".")[1];
  const bytes = Buffer.from(encoded, "base64url");
  if (bytes.toString("base64url") !== encoded) return false;
  const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const claims: unknown = JSON.parse(source);
  if (!claims || typeof claims !== "object" || Array.isArray(claims)) return false;
  // JSON/gateway parsing can turn 1e2 or 100.0 into an integer-valued number.
  // Keep the original contract's integer token type, inside the auth runtime.
  const found = new Set<string>();
  let depth = 0;
  for (let index = 0; index < source.length; index++) {
    const character = source[index];
    if (character === "{" || character === "[") depth++;
    else if (character === "}" || character === "]") depth--;
    else if (character === '"') {
      const start = index;
      while (++index < source.length && source[index] !== '"') {
        if (source[index] === "\\") index++;
      }
      let next = index + 1;
      while (/\s/.test(source[next] ?? "")) next++;
      if (depth !== 1 || source[next] !== ":") continue;
      const key: unknown = JSON.parse(source.slice(start, index + 1));
      if (key !== "iat" && key !== "exp") continue;
      if (found.has(key)) return false;
      const begin = next + 1;
      let end = begin;
      while (end < source.length && source[end] !== "," && source[end] !== "}") end++;
      if (!/^-?(0|[1-9][0-9]*)$/.test(source.slice(begin, end).trim())) return false;
      found.add(key);
    }
  }
  return found.size === 2;
}

// This module deliberately does not construct a Supabase Auth client: loading
// an SDK session can refresh credentials and write cookies even for a read.
function existingAccessToken(cookieHeader: string | null): string | null {
  if (!cookieHeader || cookieHeader.length > 65_536) return null;
  const cookies = new Map<string, string>();
  for (const part of cookieHeader.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    const name = part.slice(0, separator).trim();
    if (name !== COOKIE_NAME && !name.startsWith(`${COOKIE_NAME}.`)) continue;
    if (cookies.has(name)) return null;
    cookies.set(name, decodeURIComponent(part.slice(separator + 1).trim()));
  }
  let stored = cookies.get(COOKIE_NAME);
  if (stored !== undefined) {
    if (cookies.size !== 1) return null;
  } else {
    if (!cookies.size || cookies.size > 32) return null;
    const chunks: string[] = [];
    for (let index = 0; index < cookies.size; index++) {
      const value = cookies.get(`${COOKIE_NAME}.${index}`);
      if (!value) return null;
      chunks.push(value);
    }
    stored = chunks.join("");
  }
  if (stored.startsWith("base64-")) {
    const encoded = stored.slice(7);
    if (!/^[A-Za-z0-9_-]+$/.test(encoded)) return null;
    const bytes = Buffer.from(encoded, "base64url");
    if (bytes.toString("base64url") !== encoded) return null;
    stored = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  }
  const session: unknown = JSON.parse(stored);
  if (!session || typeof session !== "object" || Array.isArray(session)) return null;
  const token = (session as Record<string, unknown>).access_token;
  return typeof token === "string" && token.length <= 16_384
    && /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)
    ? token : null;
}

export async function verifyOperatorSession(
  cookieHeader: string | null,
  fetcher: typeof fetch = fetch,
): Promise<boolean> {
  try {
    const { supabaseUrl, supabasePublishableKey } = requireSupabaseConfig();
    if (supabaseUrl !== PROJECT_URL) return false;
    const token = existingAccessToken(cookieHeader);
    if (!token || !hasOriginalIntegerClaims(token)) return false;
    // PostgREST validates the natural bearer signature and expiry. GET runs
    // the STABLE predicate in a read-only transaction; no claims are injected.
    const response = await fetcher(`${PROJECT_URL}/rest/v1/rpc/verify_current_payroll_operator_session`, {
      method: "GET",
      headers: { apikey: supabasePublishableKey, Authorization: `Bearer ${token}` },
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(5_000),
    });
    return response.ok && await response.json() === true;
  } catch {
    // Never log provider responses, credentials, cookie data or decoded claims.
    return false;
  }
}
