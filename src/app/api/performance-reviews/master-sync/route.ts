import "server-only";
import { timingSafeEqual } from "node:crypto";
import { parseMasterRequest, runMasterPhase } from "@/lib/performance-review-master-sync";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 30;
const ORIGIN = "https://mam-team-management-system-ten.vercel.app";
const PATH = "/api/performance-reviews/master-sync";
const LIMIT = 2 * 1024 * 1024;

function reply(body: object, status = 200) {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

async function readBody(request: Request) {
  if (!request.body) throw Error("invalid_request");
  const reader = request.body.getReader();
  const parts: Uint8Array[] = [];
  let length = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const bytes = await Promise.race([
      (async () => {
        while (true) {
          const part = await reader.read();
          if (part.done) break;
          length += part.value.byteLength;
          if (length > LIMIT) throw Error("invalid_request");
          parts.push(part.value);
        }
        return Buffer.concat(parts);
      })(),
      new Promise<never>((_, reject) => { timer = setTimeout(() => { void reader.cancel().catch(() => {}); reject(Error("invalid_request")); }, 5_000); }),
    ]);
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } finally {
    clearTimeout(timer);
    void reader.cancel().catch(() => {});
  }
}

export async function POST(request: Request) {
  const expected = process.env.MAM_N8N_PERFORMANCE_MASTER_SYNC_SECRET;
  const supplied = request.headers.get("X-MAM-Performance-Master-Secret");
  if (!expected || !/^[A-Za-z0-9_-]{43,128}$/.test(expected) || !supplied || supplied.length > 128
    || Buffer.byteLength(supplied) !== Buffer.byteLength(expected) || !timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))) return reply({ ok: false, code: "unauthorized" }, 401);
  let body;
  try {
    const url = new URL(request.url);
    if (request.method !== "POST" || process.env.NEXT_PUBLIC_APP_URL !== ORIGIN || url.origin !== ORIGIN || url.pathname !== PATH || url.search || url.hash
      || request.headers.has("origin") && request.headers.get("origin") !== ORIGIN
      || request.headers.get("sec-fetch-site") === "cross-site" || request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json") throw Error("invalid_request");
    body = parseMasterRequest(await readBody(request));
  } catch { return reply({ ok: false, code: "invalid_request" }, 400); }
  try { return reply(await runMasterPhase(body)); }
  catch { return reply({ ok: false, code: "unavailable" }, 503); }
}
