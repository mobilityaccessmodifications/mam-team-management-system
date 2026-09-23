type Environment = Record<string, string | undefined>;

const SANDBOX_FLAG = "MAM_SANDBOX_E2E";
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
const REQUIRED_VARIABLES = [
  "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
  "SUPABASE_SECRET_KEY",
] as const;
const FORBIDDEN_OUTBOUND_VARIABLES = [
  "SUPABASE_ACCESS_TOKEN",
  "CRON_SECRET",
  "MAM_N8N_LEAVE_WEBHOOK_ORIGIN",
  "MAM_N8N_LEAVE_WEBHOOK_URL",
  "MAM_N8N_LEAVE_WEBHOOK_SECRET",
  "N8N_CHECKIN_REMINDER_WEBHOOK_ORIGIN",
  "N8N_CHECKIN_REMINDER_WEBHOOK_URL",
  "N8N_CHECKIN_REMINDER_WEBHOOK_SECRET",
  "CHECK_IN_EMAIL_MODE",
  "N8N_NEW_STARTER_WEBHOOK_ORIGIN",
  "N8N_NEW_STARTER_WEBHOOK_URL",
  "CHECK_IN_RESOURCE_ORIGIN",
  "CHECK_IN_MANAGER_GUIDE_URL",
  "CHECK_IN_FORM_URL",
  "CHECK_IN_PROBATION_TEMPLATES_URL",
  "CHECK_IN_LEGACY_FORMS_FOLDER_URL",
  "MAM_ANALYTICS_API_KEY",
  "N8N_BASE_URL",
  "N8N_API_KEY",
] as const;

function sandboxEnabled(environment: Environment) {
  return environment[SANDBOX_FLAG]?.trim().toLowerCase() === "true";
}

function loopbackUrl(value: string | undefined, variableName: string, originOnly: boolean) {
  let url: URL;
  try {
    url = new URL(value ?? "");
  } catch {
    throw new Error(`${SANDBOX_FLAG} requires ${variableName} to be a loopback URL.`);
  }

  if (
    !["http:", "https:"].includes(url.protocol)
    || !LOOPBACK_HOSTS.has(url.hostname.toLowerCase())
    || url.username
    || url.password
    || (originOnly && (url.pathname !== "/" || url.search || url.hash))
  ) {
    throw new Error(`${SANDBOX_FLAG} requires ${variableName} to be a loopback URL.`);
  }

  return url;
}

export function assertSandboxEnvironment(environment: Environment = process.env) {
  if (!sandboxEnabled(environment)) return;

  loopbackUrl(environment.NEXT_PUBLIC_SUPABASE_URL, "NEXT_PUBLIC_SUPABASE_URL", true);
  loopbackUrl(environment.NEXT_PUBLIC_APP_URL, "NEXT_PUBLIC_APP_URL", true);

  for (const variableName of REQUIRED_VARIABLES) {
    if (!environment[variableName]?.trim()) {
      throw new Error(`${SANDBOX_FLAG} requires ${variableName}.`);
    }
  }

  const configuredOutbound = FORBIDDEN_OUTBOUND_VARIABLES.filter(
    (variableName) => Boolean(environment[variableName]?.trim()),
  );
  if (configuredOutbound.length) {
    throw new Error(
      `${SANDBOX_FLAG} forbids outbound integration variables: ${configuredOutbound.join(", ")}.`,
    );
  }
}

function fetchUrl(input: Parameters<typeof fetch>[0]) {
  if (typeof input === "string" || input instanceof URL) return new URL(input);
  return new URL(input.url);
}

export function createSandboxFetch(
  fetchImplementation: typeof fetch,
  environment: Environment = process.env,
): typeof fetch {
  if (!sandboxEnabled(environment)) return fetchImplementation;

  return async (input, init) => {
    let url: URL;
    try {
      url = fetchUrl(input);
    } catch {
      throw new Error("MAM sandbox blocked an invalid outbound request.");
    }

    try {
      loopbackUrl(url.href, "request URL", false);
    } catch {
      throw new Error(`MAM sandbox blocked outbound request to ${url.origin}.`);
    }

    return fetchImplementation(input, init);
  };
}

const FETCH_GUARD_KEY = Symbol.for("mam.sandbox.fetch-guard-installed");

export function installSandboxFetchGuard(environment: Environment = process.env) {
  if (!sandboxEnabled(environment)) return;

  assertSandboxEnvironment(environment);
  const guardedGlobal = globalThis as typeof globalThis & { [FETCH_GUARD_KEY]?: boolean };
  if (guardedGlobal[FETCH_GUARD_KEY]) return;

  globalThis.fetch = createSandboxFetch(globalThis.fetch.bind(globalThis), environment);
  guardedGlobal[FETCH_GUARD_KEY] = true;
}
