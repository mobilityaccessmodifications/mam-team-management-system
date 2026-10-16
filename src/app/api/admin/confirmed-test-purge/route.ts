import { isUatMode } from "@/lib/uat-safety";
import { confirmedTestIdentityPurge } from "@/app/confirmed-test-purge/actions";
import type { ConfirmedTestPurgeInput } from "@/lib/confirmed-test-identity-purge";

export async function POST(request: Request) {
  if (isUatMode()) return Response.json({ error: "This operation is unavailable in UAT." }, { status: 403 });
  if (request.headers.get("origin") !== new URL(request.url).origin) return Response.json({ error: "Same-origin operator request required." }, { status: 403 });
  if (request.headers.get("content-type")?.split(";")[0] !== "application/json") return Response.json({ error: "JSON required." }, { status: 415 });
  const length = request.headers.get("content-length");
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > 8192)) {
    void request.body?.cancel().catch(() => null);
    return Response.json({ error: "Request too large." }, { status: 413 });
  }
  const reader = request.body?.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  if (reader) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("deadline")), 5000); });
    try {
      for (;;) {
        const { done, value } = await Promise.race([reader.read(), timeout]);
        if (done) break;
        bytes += value.byteLength;
        if (bytes > 8192) {
          void reader.cancel().catch(() => null);
          return Response.json({ error: "Request too large." }, { status: 413 });
        }
        chunks.push(value);
      }
    } catch (error) {
      void reader.cancel().catch(() => null);
      return Response.json({ error: "Invalid request body." }, { status: error instanceof Error && error.message === "deadline" ? 408 : 400 });
    } finally { clearTimeout(timer); reader.releaseLock(); }
  }
  const buffer = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) { buffer.set(chunk, offset); offset += chunk.byteLength; }
  const body = new TextDecoder().decode(buffer);
  let input: ConfirmedTestPurgeInput;
  try { input = JSON.parse(body); } catch { return Response.json({ error: "Invalid JSON." }, { status: 400 }); }
  try {
    const result = await confirmedTestIdentityPurge(input);
    return Response.json(result, { status: result?.phase === "reconciliation_required" ? 409 : 200, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const message = error instanceof Error && /^(purge_blocked:|Manifest changed;|Exact identity confirmation mismatch|Stale identity version|Active System Admin required|Invalid exact purge|Explicit test-only|Exact linked Auth account|Purge outcome requires reconciliation)/.test(error.message)
      ? error.message : "Purge was not confirmed. Refresh the exact preview or reconcile the receipt.";
    return Response.json({ error: message }, { status: 409, headers: { "Cache-Control": "no-store" } });
  }
}
