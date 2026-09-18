import { createHash, createHmac, randomUUID } from "node:crypto";
import { Type } from "typebox";
import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";

const BRIDGE_PATH = "/api/internal/integrations/openclaw/leave";
const E164 = /^\+[1-9][0-9]{7,14}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SAFE_ID = /^[A-Za-z0-9:_-]{1,128}$/u;
const SECRET = /^[A-Za-z0-9_-]{43,128}$/u;
const EMPLOYMENT_TYPES = new Set(["abn", "casual", "full_time", "part_time"]);
const MAX_PENDING = 4;
const pending = new Map();

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function senderE164(value) {
  if (typeof value !== "string") return null;
  const raw = value.trim();
  if (E164.test(raw)) return raw;
  const jid = /^(?<digits>[1-9][0-9]{7,14})@s\.whatsapp\.net$/u.exec(raw);
  return jid ? `+${jid.groups.digits}` : null;
}

function accountId(context) {
  return context.agentAccountId ?? context.deliveryContext?.accountId ?? "default";
}

function conversation(context) {
  const channel = context.messageChannel ?? context.deliveryContext?.channel;
  const sender = senderE164(context.requesterSenderId);
  const to = senderE164(context.deliveryContext?.to);
  const sessionKey = typeof context.sessionKey === "string" ? context.sessionKey.trim() : "";
  const account = accountId(context);
  // `to` is required to prove this is a host-routed direct WhatsApp turn. A
  // group JID, missing route, missing sender, or missing session is never
  // converted into an employee identity.
  if (channel !== "whatsapp" || !sender || !to || sender !== to || !sessionKey || !SAFE_ID.test(`s-${sha256(sessionKey)}`)) return null;
  if (typeof account !== "string" || !SAFE_ID.test(account)) return null;
  return { account, sender, session: `s-${sha256(sessionKey)}`, key: `${account}\u0000${sender}\u0000${sha256(sessionKey)}` };
}

function hookConversation(event, context) {
  const channel = context.channelId ?? event.channel;
  const sender = senderE164(context.senderId ?? event.senderId ?? event.from);
  const sessionKey = context.sessionKey ?? event.sessionKey;
  const account = context.accountId ?? "default";
  const isGroup = event.isGroup;
  if (channel !== "whatsapp" || isGroup !== false || !sender || typeof sessionKey !== "string" || !sessionKey.trim() || !SAFE_ID.test(`s-${sha256(sessionKey.trim())}`)) return null;
  if (typeof account !== "string" || !SAFE_ID.test(account)) return null;
  return { account, sender, session: `s-${sha256(sessionKey.trim())}`, key: `${account}\u0000${sender}\u0000${sha256(sessionKey.trim())}` };
}

function configured() {
  const url = process.env.MAM_OPENCLAW_LEAVE_BRIDGE_URL?.trim() ?? "";
  const key = process.env.MAM_OPENCLAW_LEAVE_BRIDGE_SECRET?.trim() ?? "";
  const account = process.env.MAM_OPENCLAW_LEAVE_ACCOUNT?.trim() || "default";
  if (process.env.MAM_OPENCLAW_LEAVE_ENABLED !== "true" || !SECRET.test(key) || !SAFE_ID.test(account)) return null;
  let endpoint;
  try {
    endpoint = new URL(url);
  } catch {
    return null;
  }
  if (endpoint.protocol !== "https:" || endpoint.pathname !== BRIDGE_PATH || endpoint.search || endpoint.hash) return null;
  return { endpoint, key, account };
}

function payloadFromParams(params) {
  const value = params && typeof params === "object" && !Array.isArray(params) ? params : {};
  return {
    leaveType: value.leaveType,
    startDate: value.startDate,
    endDate: value.endDate,
    startTime: value.startTime ?? null,
    endTime: value.endTime ?? null,
    employeeNote: value.employeeNote ?? "",
  };
}

function parseChallenge(summary) {
  if (typeof summary !== "string") return null;
  const match = /^Reply to this exact message with CONFIRM ([0-9a-f-]{36}) within 10 minutes to submit\.$/mu.exec(summary);
  return match && UUID.test(match[1]) ? match[1] : null;
}

function remember(identity, result) {
  if (result?.code !== "prepared" || typeof result.draftId !== "string" || typeof result.digest !== "string" || typeof result.summary !== "string") return null;
  const challenge = parseChallenge(result.summary);
  const expiresAt = Date.parse(result.expiresAt ?? "");
  if (!UUID.test(result.draftId) || !/^[a-f0-9]{64}$/u.test(result.digest) || !challenge || !Number.isFinite(expiresAt) || expiresAt <= Date.now()) return null;
  const item = { ...identity, draftId: result.draftId, digest: result.digest, summary: result.summary, challenge, expiresAt, outboundMessageId: null, shown: false, createdAt: Date.now() };
  const list = (pending.get(identity.key) ?? []).filter((entry) => entry.expiresAt > Date.now());
  list.push(item);
  while (list.length > MAX_PENDING) list.shift();
  pending.set(identity.key, list);
  return item;
}

function forget(item) {
  const list = pending.get(item.key) ?? [];
  const next = list.filter((entry) => entry !== item);
  if (next.length) pending.set(item.key, next);
  else pending.delete(item.key);
}

function prune() {
  const now = Date.now();
  for (const [key, list] of pending) {
    const next = list.filter((item) => item.expiresAt > now);
    if (next.length) pending.set(key, next);
    else pending.delete(key);
  }
}

async function bridge(identity, operation, payload) {
  const cfg = configured();
  if (!cfg || identity.account !== cfg.account) return { code: "unavailable" };
  const packet = {
    version: 1,
    account: identity.account,
    channel: "whatsapp",
    sender: identity.sender,
    session: identity.session,
    eventId: `ev-${randomUUID()}`,
    operation,
    payload,
  };
  const body = JSON.stringify(packet);
  const timestamp = String(Date.now());
  const signature = createHmac("sha256", cfg.key).update(`POST\n${BRIDGE_PATH}\n${timestamp}\n${body}`).digest("hex");
  try {
    const response = await fetch(cfg.endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-mam-timestamp": timestamp,
        "x-mam-signature": signature,
      },
      body,
      redirect: "error",
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
    });
    const data = await response.json().catch(() => null);
    if (!response.ok || !data || typeof data !== "object" || Array.isArray(data) || typeof data.code !== "string") return { code: "unavailable" };
    return data;
  } catch {
    return { code: "unavailable" };
  }
}

function visiblePrepareResult(result, shown) {
  if (result.code === "needs_input") return result;
  if (result.code !== "prepared") return { code: "unavailable" };
  return {
    code: "prepared",
    summary: result.summary,
    delivery: shown ? "The exact summary has a verified delivery receipt. Do not send another copy."
      : "Delivery requested; awaiting the provider receipt. Do not claim delivery or submission. Do not send another copy. If no summary arrives, start a new request.",
    instruction: "Do not claim that leave has been submitted. Submission happens only after the employee replies to that exact WhatsApp message with the requested CONFIRM code.",
  };
}

function visibleSelfProfile(result) {
  const profile = result?.code === "profile" && result.profile && typeof result.profile === "object" && !Array.isArray(result.profile)
    ? result.profile : null;
  const name = typeof profile?.name === "string" ? profile.name.trim() : "";
  const employmentType = profile?.employmentType;
  if (!name || name.length > 200 || /[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u.test(name)) return null;
  if (employmentType !== null && !EMPLOYMENT_TYPES.has(employmentType)) return null;
  return { name, employmentType };
}

async function recordShown(item) {
  if (item.shown) return true;
  if (!item.outboundMessageId) return false;
  if (item.shownPromise) return item.shownPromise;
  // Pin the first provider ID, but retain a retry path for that SAME receipt.
  // Concurrent hook/confirmation retries share one in-flight registration.
  item.shownPromise = bridge(item, "shown", {
    draftId: item.draftId, digest: item.digest, outboundMessageId: item.outboundMessageId,
  }).then((result) => { item.shown = result.code === "shown"; return item.shown; });
  try { return await item.shownPromise; } finally { item.shownPromise = null; }
}

function confirmationText(result) {
  if (result.code === "submitted" && result.status === "Pending") return "Your leave request has been submitted and is now pending manager approval.";
  if (result.code === "expired") return "That leave confirmation has expired. Please start the leave request again.";
  if (result.code === "conflict") return "That confirmation could not be matched to the exact leave summary. Please start the leave request again.";
  return "I could not submit that leave request. Please start the leave request again.";
}

const prepareParameters = Type.Object({
  leaveType: Type.String({ description: "One of Annual leave, Sick leave, Carer's leave, or Unpaid leave. If mam_self_profile reports casual or abn, use Unpaid leave without asking paid versus unpaid." }),
  startDate: Type.String({ description: "First leave date in YYYY-MM-DD format." }),
  endDate: Type.String({ description: "Last leave date in YYYY-MM-DD format." }),
  startTime: Type.Optional(Type.Union([Type.String(), Type.Null()], { description: "Optional start time in HH:MM, 15-minute intervals." })),
  endTime: Type.Optional(Type.Union([Type.String(), Type.Null()], { description: "Optional end time in HH:MM, 15-minute intervals." })),
  employeeNote: Type.Optional(Type.String({ description: "Optional note, copied exactly from the employee's message." })),
}, { additionalProperties: false });
const selfProfileParameters = Type.Object({}, { additionalProperties: false });
const prepareDescription = "Prepare a leave request only for the authenticated WhatsApp sender. Call mam_self_profile first in the same conversation. The trusted sender phone number is the sole employee identity and leave subject. Never ask for or accept a name, phone number, employee ID, user ID, leave subject, addressee, manager, approver, status, confirmation flag, or another person's identity. If the self profile reports casual or abn, use Unpaid leave and do not ask whether the leave is paid or unpaid. Collect only leave type when still needed, start and end dates, optional partial-day times, and an optional note. Reviewer routing is resolved by the server. It sends an exact summary and waits for a real WhatsApp reply with CONFIRM.";
const selfProfileDescription = "Read only the authenticated WhatsApp sender's own name and employment type. Call this before an employee-specific answer, before collecting any leave request, and when the sender asks who they are. This tool has no identity arguments: never ask for or accept a phone number, name, employee ID, user ID, or another person's identity. A casual or abn sender can request Unpaid leave only; do not ask paid versus unpaid. Never expose internal IDs or the sender phone number.";

const plugin = defineToolPlugin({
  id: "mam-openclaw-leave",
  name: "MAM Leave",
  description: "Secure self-profile lookup and self-service MAM leave requests for approved WhatsApp employees.",
  tools: (tool) => [tool({
    name: "mam_leave_prepare",
    label: "Prepare MAM leave request",
    description: prepareDescription,
    parameters: prepareParameters,
    optional: true,
    factory({ toolContext }) {
      const identity = conversation(toolContext);
      const cfg = configured();
      if (!identity || !cfg || identity.account !== cfg.account || typeof toolContext.delivery?.send !== "function") return null;
      return {
        name: "mam_leave_prepare",
        label: "Prepare MAM leave request",
        description: prepareDescription,
        parameters: prepareParameters,
        executionMode: "sequential",
        async execute(_id, params) {
          prune();
          if (typeof toolContext.delivery?.send !== "function") return { content: [{ type: "text", text: "Trusted delivery is unavailable." }], details: { code: "unavailable" } };
          const result = await bridge(identity, "prepare", payloadFromParams(params));
          if (result.code !== "prepared") return { content: [{ type: "text", text: result.code === "needs_input" ? "Collect the missing leave details before calling this tool again." : "Leave service is temporarily unavailable." }], details: result };
          const item = remember(identity, result);
          if (!item) return { content: [{ type: "text", text: "Leave service is temporarily unavailable." }], details: { code: "unavailable" } };
          try {
            await toolContext.delivery.send({ text: item.summary });
          } catch {
            forget(item);
            return { content: [{ type: "text", text: "I could not deliver the confirmation summary. Please try the leave request again." }], details: { code: "unavailable" } };
          }
          const output = visiblePrepareResult(result, item.shown);
          return { content: [{ type: "text", text: JSON.stringify(output) }], details: output };
        },
      };
    },
  }), tool({
    name: "mam_self_profile",
    label: "Read my MAM employee profile",
    description: selfProfileDescription,
    parameters: selfProfileParameters,
    optional: true,
    factory({ toolContext }) {
      const identity = conversation(toolContext);
      const cfg = configured();
      if (!identity || !cfg || identity.account !== cfg.account) return null;
      return {
        name: "mam_self_profile",
        label: "Read my MAM employee profile",
        description: selfProfileDescription,
        parameters: selfProfileParameters,
        executionMode: "sequential",
        async execute(_id, params) {
          if (params !== undefined && params !== null && (typeof params !== "object" || Array.isArray(params) || Object.keys(params).length !== 0)) {
            return { content: [{ type: "text", text: "Self profile is unavailable." }], details: { code: "unavailable" } };
          }
          const output = visibleSelfProfile(await bridge(identity, "profile", {}));
          if (!output) return { content: [{ type: "text", text: "Self profile is unavailable." }], details: { code: "unavailable" } };
          return { content: [{ type: "text", text: JSON.stringify(output) }], details: output };
        },
      };
    },
  })],
});

const baseRegister = plugin.register;
plugin.register = (api) => {
  baseRegister(api);

    api.on("message_sent", async (event, context) => {
      prune();
      if (!event.success || typeof event.messageId !== "string" || !event.messageId || context.channelId !== "whatsapp") return;
      const sender = senderE164(event.to);
      if (!sender || event.to.includes("@g.us")) return;
      const account = context.accountId ?? "default";
      const session = typeof context.sessionKey === "string" ? `s-${sha256(context.sessionKey.trim())}` : null;
      if (!session) return;
      for (const item of pending.values()) {
        const candidate = item.find((entry) => entry.account === account && entry.sender === sender && entry.session === session
          && entry.summary === event.content && (!entry.outboundMessageId || entry.outboundMessageId === event.messageId));
        if (!candidate) continue;
        candidate.outboundMessageId = event.messageId;
        await recordShown(candidate);
        return;
      }
    });

    api.on("before_dispatch", async (event, context) => {
      prune();
      const content = typeof event.content === "string" ? event.content : "";
      if (!/^CONFIRM [0-9a-f-]{36}$/iu.test(content)) return;
      const identity = hookConversation(event, context);
      if (!identity) return { handled: true, text: "Please send that confirmation in the approved MAM WhatsApp direct chat." };
      const list = pending.get(identity.key) ?? [];
      const item = list.find((entry) => entry.challenge && content === `CONFIRM ${entry.challenge}`);
      if (!item) return { handled: true, text: "That leave confirmation is no longer available. Please start the leave request again." };
      const replyTo = event.replyToIdFull ?? event.replyToId ?? context.replyToIdFull ?? context.replyToId;
      if (!item.outboundMessageId || replyTo !== item.outboundMessageId || (event.replyToIsQuote !== true && context.replyToIsQuote !== true)) {
        return { handled: true, text: "Please use WhatsApp Reply on the exact leave summary message, then send the CONFIRM code exactly as shown." };
      }
      if (!await recordShown(item)) {
        return { handled: true, text: "The summary delivery receipt is not confirmed yet. Please reply to the same summary with the same CONFIRM code again shortly. Nothing new has been submitted by this attempt." };
      }
      const result = await bridge(identity, "confirm", {
        draftId: item.draftId,
        digest: item.digest,
        replyToMessageId: replyTo,
        text: content,
      });
      if (result.code === "submitted") forget(item);
      return { handled: true, text: confirmationText(result) };
    });
};

export default plugin;
