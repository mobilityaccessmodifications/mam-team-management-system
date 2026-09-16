import { createHash, timingSafeEqual } from "node:crypto";

import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 30;

const DATASETS = [
  "overview",
  "employees",
  "leave_requests",
  "leave_events",
  "check_ins",
  "check_in_events",
  "asset_custody",
  "subscriptions",
  "subscription_events",
] as const;

type AnalyticsDataset = (typeof DATASETS)[number];

const JSON_HEADERS = {
  "Cache-Control": "no-store, max-age=0",
  "Content-Type": "application/json; charset=utf-8",
  "Vary": "Authorization",
};

function bearerToken(request: Request) {
  const authorization = request.headers.get("authorization");
  const candidate = authorization?.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
  return candidate.length <= 512 ? candidate : "";
}

function matchesEnvironmentAnalyticsKey(candidate: string) {
  const expected = process.env.MAM_ANALYTICS_API_KEY?.trim();

  if (!expected || expected.length < 32 || !candidate) return false;

  const expectedBytes = Buffer.from(expected);
  const candidateBytes = Buffer.from(candidate);
  return candidateBytes.length === expectedBytes.length && timingSafeEqual(candidateBytes, expectedBytes);
}

/**
 * Database-managed keys supersede the deployment environment key once one is
 * created. Before the migration has been applied, the existing environment
 * secret remains a safe compatibility path instead of causing an outage.
 */
async function matchesAnalyticsKey(request: Request) {
  const candidate = bearerToken(request);
  if (!candidate) return false;

  const candidateHash = createHash("sha256").update(candidate, "utf8").digest("hex");
  try {
    const supabase = createAdminClient();
    const { data, error } = await supabase.rpc("validate_analytics_api_key", {
      p_key_hash: candidateHash,
    });
    if (!error) {
      if (typeof data === "boolean") return data;
      // The managed-key validator deliberately returns null until the first
      // database key is created, preserving the deployment-key transition.
      if (data === null) return matchesEnvironmentAnalyticsKey(candidate);
      return false;
    }
    // PostgREST uses PGRST202 when the RPC is not present in its schema cache.
    // Only that initial, pre-migration state may use the old environment key.
    if (error?.code !== "PGRST202") return false;
  } catch {
    // A missing/invalid server configuration must fail closed.
    return false;
  }

  return matchesEnvironmentAnalyticsKey(candidate);
}

function isDate(value: string | null) {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}

function parseBoundedInteger(value: string | null, fallback: number, min: number, max: number) {
  if (value === null) return fallback;
  if (!/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= min && parsed <= max ? parsed : null;
}

function json(body: unknown, status = 200) {
  return Response.json(body, { status, headers: JSON_HEADERS });
}

function allowedDataset(value: string | null): value is AnalyticsDataset {
  return value !== null && DATASETS.includes(value as AnalyticsDataset);
}

/**
 * Server-to-server analytics API. It is deliberately not CORS-enabled: a BI
 * connector or analytics backend must hold the dedicated bearer key. This
 * route never exposes the Supabase secret key or direct database tables.
 */
export async function GET(request: Request) {
  if (!(await matchesAnalyticsKey(request))) {
    return json({ ok: false, code: "unauthorized" }, 401);
  }

  const url = new URL(request.url);
  const dataset = url.searchParams.get("dataset") ?? "overview";
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");
  const limit = parseBoundedInteger(url.searchParams.get("limit"), 500, 1, 1000);
  const offset = parseBoundedInteger(url.searchParams.get("offset"), 0, 0, 1000000);

  if (!allowedDataset(dataset)) {
    return json({ ok: false, code: "invalid_dataset", datasets: DATASETS }, 400);
  }
  if ((from !== null && !isDate(from)) || (to !== null && !isDate(to)) || (from && to && to < from)) {
    return json({ ok: false, code: "invalid_date_range" }, 400);
  }
  if (limit === null || offset === null) {
    return json({ ok: false, code: "invalid_pagination" }, 400);
  }

  try {
    const supabase = createAdminClient();
    const { data, error } = await supabase.rpc("analytics_dashboard_dataset", {
      p_dataset: dataset,
      p_from_date: from,
      p_to_date: to,
      p_limit: limit,
      p_offset: offset,
    });

    if (error || !data || typeof data !== "object" || Array.isArray(data)) {
      return json({ ok: false, code: "analytics_unavailable" }, 503);
    }

    return json({
      ok: true,
      api_version: "v1",
      generated_at: new Date().toISOString(),
      dataset,
      from,
      to,
      ...(data as Record<string, unknown>),
    });
  } catch {
    return json({ ok: false, code: "analytics_unavailable" }, 503);
  }
}
