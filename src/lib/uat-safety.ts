type UatEnvironment = Record<string, string | undefined>;

export const UAT_INSTANCE = "mam-people-hub-uat-v1";
export const UAT_APP_ORIGIN = "https://people-hub-uat.srv1866578.hstgr.cloud";
export const UAT_API_ORIGIN = "https://supabase-uat.srv1866578.hstgr.cloud";
export const UAT_INTERNAL_API_ORIGIN = "http://uat-gateway:8080";

function reject(): never {
  throw new Error("UAT configuration is not isolated.");
}

function requested(value: string | undefined) {
  return value !== undefined && value !== "" && value !== "false";
}

export function isUatMode(environment: UatEnvironment = process.env) {
  return requested(environment.MAM_UAT_ENABLED)
    || requested(environment.NEXT_PUBLIC_MAM_UAT_ENABLED)
    || Boolean(environment.MAM_UAT_TARGET)
    || environment.NEXT_PUBLIC_SUPABASE_URL === UAT_API_ORIGIN
    || environment.NEXT_PUBLIC_APP_URL === UAT_APP_ORIGIN;
}

function jwtPart(value: string): unknown {
  const input = value.replace(/-/g, "+").replace(/_/g, "/");
  return JSON.parse(atob(input.padEnd(4 * Math.ceil(input.length / 4), "=")));
}

function assertKeyMetadata(value: string | undefined, role: "anon" | "service_role") {
  if (!value || value.length > 4096) reject();
  try {
    const parts = value.split(".");
    if (parts.length !== 3 || parts.some((part) => !/^[A-Za-z0-9_-]+$/.test(part))) reject();
    const header = jwtPart(parts[0]) as Record<string, unknown>;
    const payload = jwtPart(parts[1]) as Record<string, unknown>;
    if (!header || !payload || header.alg !== "HS256" || payload.iss !== UAT_INSTANCE
      || payload.role !== role || !Number.isSafeInteger(payload.exp)
      || (payload.exp as number) <= Date.now() / 1000) reject();
  } catch {
    reject();
  }
}

export function assertUatPublicEnvironment(environment: UatEnvironment = process.env) {
  if (!isUatMode(environment)) return;
  if (environment.NEXT_PUBLIC_MAM_UAT_ENABLED !== "true"
    || environment.NEXT_PUBLIC_APP_URL !== UAT_APP_ORIGIN
    || environment.NEXT_PUBLIC_SUPABASE_URL !== UAT_API_ORIGIN) reject();
  assertKeyMetadata(environment.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, "anon");
}

export function assertUatEnvironment(
  environment: UatEnvironment = process.env,
  { buildOnly = false }: { buildOnly?: boolean } = {},
) {
  if (!isUatMode(environment)) return;
  assertUatPublicEnvironment(environment);
  const forbiddenNames = new Set([
    "SUPABASE_ACCESS_TOKEN", "CRON_SECRET", "MAM_BACKGROUND_RECOVERY_SECRET",
    "MAM_SUBSCRIPTION_REQUEST_CRON_SECRET", "CHECK_IN_EMAIL_MODE",
    "NEW_STARTER_DAY_ONE_EMAIL_MODE", "MAM_DEMO_EMAIL_ENABLED",
    "MAM_SUBSCRIPTION_REVIEW_MAIL_START_ON", "MAM_ANALYTICS_API_KEY",
    "CHECK_IN_RESOURCE_ORIGIN", "CHECK_IN_MANAGER_GUIDE_URL", "CHECK_IN_FORM_URL",
    "CHECK_IN_PROBATION_TEMPLATES_URL", "CHECK_IN_LEGACY_FORMS_FOLDER_URL",
  ]);
  const forbiddenPrefixes = ["N8N_", "MAM_N8N_", "MAM_OPENCLAW_", "PASSWORD_RECOVERY_", "ONBOARDING_CREDENTIAL_"];
  if (Object.keys(environment).some((name) => Boolean(environment[name]?.trim())
    && (forbiddenNames.has(name) || forbiddenPrefixes.some((prefix) => name.startsWith(prefix))))) reject();
  if (environment.MAM_UAT_ENABLED !== "true"
    || environment.MAM_APP_ENV !== "preview"
    || environment.MAM_UAT_TARGET !== UAT_INSTANCE
    || environment.MAM_UAT_INTERNAL_SUPABASE_URL !== UAT_INTERNAL_API_ORIGIN
    || (environment.VERCEL_ENV !== undefined && environment.VERCEL_ENV !== "preview")) reject();
  if (!buildOnly || environment.SUPABASE_SECRET_KEY) {
    assertKeyMetadata(environment.SUPABASE_SECRET_KEY, "service_role");
  }
}

function rejectRequest(): never {
  throw new Error("UAT blocked an outbound request.");
}

function allowedApiPath(url: URL, method: string) {
  if (/^\/rest\/v1\/(?:rpc\/)?[a-z][a-z0-9_]*$/.test(url.pathname)) {
    return ["GET", "HEAD", "POST"].includes(method);
  }
  if (url.pathname === "/auth/v1/token" && method === "POST") {
    const grants = url.searchParams.getAll("grant_type");
    return grants.length === 1 && ["password", "refresh_token"].includes(grants[0])
      && [...url.searchParams.keys()].every((key) => key === "grant_type");
  }
  if (url.pathname === "/auth/v1/logout" && method === "POST") {
    return [...url.searchParams.keys()].every((key) => key === "scope")
      && url.searchParams.getAll("scope").length <= 1
      && [null, "local", "global", "others"].includes(url.searchParams.get("scope"));
  }
  return method === "GET" && !url.search
    && ["/auth/v1/user", "/auth/v1/settings", "/auth/v1/.well-known/jwks.json"].includes(url.pathname);
}

export function createUatFetch(
  fetchImplementation: typeof fetch,
  environment: UatEnvironment = process.env,
): typeof fetch {
  if (!isUatMode(environment)) return fetchImplementation;
  assertUatEnvironment(environment, { buildOnly: environment.MAM_UAT_BUILD_ONLY === "true" });
  return async (input, init) => {
    let url: URL;
    try {
      url = new URL(input instanceof Request ? input.url : String(input));
    } catch {
      rejectRequest();
    }
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    if (![UAT_API_ORIGIN, UAT_INTERNAL_API_ORIGIN].includes(url.origin)
      || url.username || url.password || url.hash || !allowedApiPath(url, method)) rejectRequest();
    const destination = UAT_INTERNAL_API_ORIGIN + url.pathname + url.search;
    let forwarded: Parameters<typeof fetch>[0];
    try {
      forwarded = input instanceof Request ? new Request(destination, input) : destination;
    } catch {
      rejectRequest();
    }
    const response = await fetchImplementation(forwarded, { ...init, redirect: "error" });
    if (response.redirected || (response.status >= 300 && response.status < 400)) rejectRequest();
    return response;
  };
}

const UAT_FETCH_GUARD_KEY = Symbol.for("mam.uat.fetch-guard-installed");

export function installUatFetchGuard(environment: UatEnvironment = process.env) {
  if (!isUatMode(environment)) return;
  if (environment.MAM_UAT_BUILD_ONLY === "true") reject();
  assertUatEnvironment(environment);
  const guardedGlobal = globalThis as typeof globalThis & { [UAT_FETCH_GUARD_KEY]?: boolean };
  if (guardedGlobal[UAT_FETCH_GUARD_KEY]) return;
  globalThis.fetch = createUatFetch(globalThis.fetch.bind(globalThis), environment);
  guardedGlobal[UAT_FETCH_GUARD_KEY] = true;
}
