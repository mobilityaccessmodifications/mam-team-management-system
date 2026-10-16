import { isUatMode } from "@/lib/uat-safety";
import { verifyOperatorSession } from "@/lib/operator-session-proof";

// No SDK session load, refresh, login, reset, privileged key or writes.
// PostgREST verifies the existing signed bearer inside the MAM auth runtime.
export async function GET(request: Request) {
  if (isUatMode()) return Response.json({ error: "This operation is unavailable in UAT." }, { status: 403 });
  const proof = await verifyOperatorSession(request.headers.get("cookie"));
  return Response.json(proof, {
    headers: {
      "Cache-Control": "private, no-store, max-age=0",
      Pragma: "no-cache",
      Vary: "Cookie",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    },
  });
}
