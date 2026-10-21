import "server-only";

export const PERFORMANCE_MAIL_ORIGIN = "https://n8n.srv1866578.hstgr.cloud";
export const PERFORMANCE_MAIL_PATH = "/webhook/mam-people-hub-performance-review-mail-v1";
export const PERFORMANCE_MAIL_READY_PATH = PERFORMANCE_MAIL_PATH + "-ready";
export const PERFORMANCE_MAIL_SENDER = "careers@mobilityaccess.com.au";
export const PERFORMANCE_MAIL_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

export function performanceReviewMailEnabled() {
  return process.env.PERFORMANCE_REVIEW_EMAIL_MODE === "live"
    && process.env.MAM_SANDBOX_E2E?.trim().toLowerCase() !== "true";
}

export function performanceReviewMailTarget() {
  const origin = process.env.MAM_N8N_PERFORMANCE_WEBHOOK_ORIGIN;
  const url = process.env.MAM_N8N_PERFORMANCE_WEBHOOK_URL;
  const secret = process.env.MAM_N8N_PERFORMANCE_WEBHOOK_SECRET;
  if (origin !== PERFORMANCE_MAIL_ORIGIN || url !== PERFORMANCE_MAIL_ORIGIN + PERFORMANCE_MAIL_PATH
    || !secret || !/^[A-Za-z0-9_-]{32,256}$/.test(secret)) throw new Error("invalid_configuration");
  return { url, secret };
}

export function performanceMailRpcSucceeded(result: { error: unknown; status?: unknown }) {
  return result.error === null && (result.status === undefined || (typeof result.status === "number" && Number.isInteger(result.status) && result.status >= 200 && result.status < 300));
}

export function performanceMailBudget(expiresAt = Date.now() + 25_000) {
  return {
    remaining: () => expiresAt - Date.now(),
    async run<T>(operation: (signal: AbortSignal) => PromiseLike<T>, cap = 5_000): Promise<T> {
      const duration = Math.min(cap, expiresAt - Date.now());
      if (duration <= 0) throw new Error("deadline");
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error("deadline")); }, duration); }),
          Promise.resolve().then(() => operation(controller.signal)),
        ]);
      } finally { clearTimeout(timer); }
    },
  };
}

export async function readPerformanceMailJson(message: Request | Response, limit: number, signal: AbortSignal): Promise<unknown> {
  const declared = message.headers.get("content-length");
  if (declared !== null && (!/^(0|[1-9][0-9]*)$/.test(declared) || Number(declared) > limit)) throw new Error("body_limit");
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(message.headers.get("content-type") ?? "")) throw new Error("invalid_body");
  const reader = message.body?.getReader();
  if (!reader) throw new Error("invalid_body");
  const cancel = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
      if (signal.aborted) throw new Error("deadline");
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) throw new Error("body_limit");
      chunks.push(value);
    }
    if (signal.aborted || (declared !== null && Number(declared) !== total)) throw new Error("invalid_body");
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
  } finally {
    signal.removeEventListener("abort", cancel);
    cancel();
  }
}
