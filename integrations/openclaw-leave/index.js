import { createHash, createHmac, randomUUID } from "node:crypto";
import { Type } from "typebox";
import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import { createPluginRuntimeStore } from "openclaw/plugin-sdk/runtime-store";
import { getSessionEntry, resolveSendPolicy } from "openclaw/plugin-sdk/session-store-runtime";

const BRIDGE_PATH = "/api/internal/integrations/openclaw/leave";
const E164 = /^\+[1-9][0-9]{7,14}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SAFE_ID = /^[A-Za-z0-9:_-]{1,128}$/u;
const SECRET = /^[A-Za-z0-9_-]{43,128}$/u;
const MAX_PENDING = 1;
// Tool-only registries and the Gateway can load separate module graphs. Only
// the Gateway service owns this process-local state; discovery cannot create it.
const gatewayStore = createPluginRuntimeStore({ key: "plugin-runtime:mam-openclaw-leave:gateway-v1", errorMessage: "MAM leave gateway is unavailable" });

function activeGateway() {
  const owner = gatewayStore.tryGetRuntime();
  return owner?.active ? owner : null;
}

function isCurrent(owner) {
  return owner?.active === true && activeGateway() === owner;
}

function diagnostic(owner, stage, code) {
  // Fixed labels only: never log exceptions, phone numbers, summaries or notes.
  owner?.logger?.warn?.(`MAM leave: stage=${stage} code=${code}`);
}

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
  return { account, sender, sessionKey, session: `s-${sha256(sessionKey)}`, key: `${account}\u0000${sender}\u0000${sha256(sessionKey)}` };
}

function hookConversation(event, context) {
  const channel = context.channelId ?? event.channel;
  const sender = senderE164(context.senderId ?? event.senderId ?? event.from);
  const sessionKey = context.sessionKey ?? event.sessionKey;
  const account = context.accountId ?? "default";
  const isGroup = event.isGroup;
  if (channel !== "whatsapp" || isGroup !== false || !sender || typeof sessionKey !== "string" || !sessionKey.trim() || !SAFE_ID.test(`s-${sha256(sessionKey.trim())}`)) return null;
  if (typeof account !== "string" || !SAFE_ID.test(account)) return null;
  return { account, sender, sessionKey: sessionKey.trim(), session: `s-${sha256(sessionKey.trim())}`, key: `${account}\u0000${sender}\u0000${sha256(sessionKey.trim())}` };
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

function remember(owner, identity, result) {
  if (!isCurrent(owner)) return null;
  const pending = owner.pending;
  if (result?.code !== "prepared" || typeof result.draftId !== "string" || typeof result.digest !== "string" || typeof result.summary !== "string") return null;
  const expiresAt = Date.parse(result.expiresAt ?? "");
  if (result.consentVersion !== 3 || typeof result.draftToken !== "string" || result.draftToken.length > 14000 || !result.draftToken
    || !UUID.test(result.draftId) || !/^[a-f0-9]{64}$/u.test(result.digest) || !Number.isFinite(expiresAt) || expiresAt <= Date.now()) return null;
  if (sha256(result.summary) !== result.digest) return null;
  // A literal block keeps employee notes from becoming WhatsApp markdown. The
  // server-signed summary inside it is unchanged. Quote checks bind this display.
  const deliveryText = `\`\`\`\n${result.summary}\n\`\`\``;
  const item = { ...identity, owner, draftId: result.draftId, draftToken: result.draftToken, digest: result.digest, summary: result.summary, deliveryText, expiresAt, outboundMessageId: null, shown: false, createdAt: Date.now() };
  const list = (pending.get(identity.key) ?? []).filter((entry) => entry.expiresAt > Date.now());
  list.push(item);
  while (list.length > MAX_PENDING) list.shift();
  pending.set(identity.key, list);
  return item;
}

function forget(item) {
  const pending = item.owner.pending;
  const list = pending.get(item.key) ?? [];
  const next = list.filter((entry) => entry !== item);
  if (next.length) pending.set(item.key, next);
  else pending.delete(item.key);
}

function prune(owner) {
  const pending = owner.pending;
  const now = Date.now();
  for (const [key, list] of pending) {
    const next = list.filter((item) => item.expiresAt > now || ((item.result || item.confirmationPacket) && item.createdAt + 3600_000 > now));
    if (next.length) pending.set(key, next);
    else pending.delete(key);
  }
  for (const [key, event] of owner.confirmations) if (event.expiresAt <= now) owner.confirmations.delete(key);
  for (const [key, turn] of owner.turns) if (turn.createdAt + 3600_000 <= now && !pending.has(key) && !owner.preparing.has(key)) owner.turns.delete(key);
}

async function bridge(identity, operation, payload, inboundMessageId) {
  const cfg = configured();
  if (!cfg || identity.account !== cfg.account) return { code: "unavailable" };
  const packet = {
    version: 3,
    account: identity.account,
    channel: "whatsapp",
    sender: identity.sender,
    session: identity.session,
    // Bind confirmations to the real provider event, not a fresh transport retry.
    eventId: inboundMessageId ? `wa-${sha256(JSON.stringify([identity.account, identity.sender, identity.session, inboundMessageId]))}` : `ev-${randomUUID()}`,
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
      // Backend snapshot + commit can take 8s + 15s. A shorter client timeout
      // can lose a successful commit response and unnecessarily invite retries.
      signal: AbortSignal.timeout(30_000),
    });
    const data = await response.json().catch(() => null);
    if (!response.ok) {
      diagnostic(activeGateway(), operation, `http_${response.status}`);
      return { code: response.status === 409 && ["expired", "conflict"].includes(data?.code) ? data.code : "unavailable" };
    }
    if (!data || typeof data !== "object" || Array.isArray(data) || typeof data.code !== "string") return { code: "unavailable" };
    return data;
  } catch {
    diagnostic(activeGateway(), operation, "transport_failed");
    return { code: "unavailable" };
  }
}

async function sendSummary(owner, toolContext, item, signal) {
  if (!isCurrent(owner)) throw new Error("gateway_unavailable");
  owner.validatePreparedSummary(item);
  signal?.throwIfAborted();
  if (typeof toolContext.delivery?.send === "function") {
    await toolContext.delivery.send({ text: item.deliveryText });
    if (!isCurrent(owner)) throw new Error("gateway_replaced");
    signal?.throwIfAborted();
    return null;
  }
  const result = await owner.sendPreparedSummary(item, signal);
  if (!isCurrent(owner)) throw new Error("gateway_replaced");
  signal?.throwIfAborted();
  const messageId = typeof result?.messageId === "string" ? result.messageId.trim() : "";
  if (!SAFE_ID.test(messageId)) throw new Error("receipt_missing");
  return messageId;
}

async function deliverSummary(owner, toolContext, item, signal) {
  // An earlier send already in flight must finish before a replacement sends;
  // otherwise an old summary could become the last visible message.
  const previous = owner.deliveries.get(item.key) ?? Promise.resolve();
  const delivery = previous.catch(() => {}).then(() => sendSummary(owner, toolContext, item, signal));
  owner.deliveries.set(item.key, delivery);
  try { return await delivery; }
  finally { if (owner.deliveries.get(item.key) === delivery) owner.deliveries.delete(item.key); }
}

function visiblePrepareResult(result, shown) {
  if (result.code === "needs_input") return result;
  if (result.code !== "prepared") return { code: "unavailable" };
  return {
    code: "prepared",
    summary: result.summary,
    delivery: shown ? "The exact summary has a verified delivery receipt. Do not send another copy."
      : "Delivery requested; awaiting the provider receipt. Do not claim delivery or submission. Do not send another copy. If no summary arrives, start a new request.",
    instruction: "Do not claim that leave has been submitted. In one short follow-up, tell the employee: Send Confirm within 10 minutes to submit your latest summary for manager approval, or tell me what to change. No WhatsApp Reply gesture is needed. Do not send another summary or ask for a note if none was provided.",
  };
}

async function recordShown(item) {
  if (!isCurrent(item.owner) || !item.owner.pending.get(item.key)?.includes(item)) return false;
  if (item.shown) return true;
  if (!item.outboundMessageId) return false;
  // Until human consent, both the draft and actual provider receipt are memory
  // only. No People database draft/receipt or "shown" request is created.
  item.shownAt = Date.now();
  item.shown = true;
  return true;
}

function confirmationText(result) {
  if (result.code === "submitted" && result.status === "Pending") return "Your leave request has been submitted and is now pending manager approval.";
  if (result.code === "expired") return "That leave confirmation has expired. Please start the leave request again.";
  if (result.code === "conflict") return "That confirmation could not be matched to the exact leave summary. Please start the leave request again.";
  return "I could not verify submission yet. Please send Confirm again shortly to check the same request; do not start a duplicate request.";
}

const prepareParameters = Type.Object({
  leaveType: Type.Optional(Type.String({ description: "One of Annual leave, Sick leave, Carer's leave, or Unpaid leave, only if the employee supplied it. Otherwise omit it: the server resolves permitted types and defaults casual/ABN to Unpaid leave." })),
  startDate: Type.Optional(Type.String({ description: "First leave date in YYYY-MM-DD format, if known." })),
  endDate: Type.Optional(Type.String({ description: "Last leave date in YYYY-MM-DD format, if known; same as startDate for a clearly requested single day." })),
  startTime: Type.Optional(Type.Union([Type.String(), Type.Null()], { description: "Optional start time in HH:MM, 15-minute intervals." })),
  endTime: Type.Optional(Type.Union([Type.String(), Type.Null()], { description: "Optional end time in HH:MM, 15-minute intervals." })),
  employeeNote: Type.Optional(Type.String({ description: "Optional note, copied exactly from the employee's message." })),
}, { additionalProperties: false });
const prepareDescription = "Prepare leave only after the authenticated WhatsApp sender explicitly asks to apply for leave, never for greetings, ordinary conversation, startup or general policy questions. Call with the details already supplied; do not ask paid versus unpaid first. The server resolves eligibility internally, defaults casual/ABN to Unpaid leave if no type was supplied, and returns any missing fields and available types. Ask only for those missing fields; never silently replace an explicitly requested type that is unavailable. The trusted sender phone number is the sole employee identity and leave subject. Never ask for or accept a name, phone number, employee ID, user ID, employment type, leave subject, addressee, manager, approver, status, confirmation flag, or another person's identity. No separate profile lookup is needed or available. A note is optional: if none was supplied, use an empty note without an extra question. Ask about partial-day times only when requested. Reviewer routing is server-side. On edits, prepare the complete updated details again; this replaces the previous unsubmitted draft. It sends the exact summary; only the employee's subsequent standalone Confirm message can submit the latest request. Never call this tool in response to Confirm.";

const plugin = defineToolPlugin({
  id: "mam-openclaw-leave",
  name: "MAM Leave",
  description: "Self-service MAM leave requests with server-resolved identity for approved WhatsApp employees.",
  tools: (tool) => [tool({
    name: "mam_leave_prepare",
    label: "Prepare MAM leave request",
    description: prepareDescription,
    parameters: prepareParameters,
    optional: true,
    factory({ toolContext }) {
      const identity = conversation(toolContext);
      const cfg = configured();
      if (!identity || !cfg || identity.account !== cfg.account) return null;
      const factoryOwner = activeGateway();
      const factoryTurn = factoryOwner?.turns.get(identity.key);
      return {
        name: "mam_leave_prepare",
        label: "Prepare MAM leave request",
        description: prepareDescription,
        parameters: prepareParameters,
        executionMode: "sequential",
        async execute(_id, params, signal) {
          const owner = activeGateway();
          if (!owner) return { content: [{ type: "text", text: "Leave service is temporarily unavailable." }], details: { code: "unavailable" } };
          prune(owner);
          if (owner !== factoryOwner || owner.turns.get(identity.key) !== factoryTurn) return { content: [{ type: "text", text: "That request changed. Please prepare the current leave details again." }], details: { code: "unavailable" } };
          const previous = owner.pending.get(identity.key)?.[0];
          if (previous?.confirming || (previous?.confirmationPacket && !previous.result)) return { content: [{ type: "text", text: "The previous submission has not been verified yet. Ask the employee to send Confirm again to check it before starting another request." }], details: { code: "unavailable" } };
          // Invalidate the prior local summary as soon as a new preparation
          // starts, even if validation or delivery then fails. Concurrent or
          // delayed prepare completions must not restore an older summary.
          owner.pending.delete(identity.key);
          const revision = {};
          owner.preparing.set(identity.key, revision);
          const result = await bridge(identity, "prepare", payloadFromParams(params));
          if (!isCurrent(owner) || owner.preparing.get(identity.key) !== revision) return { content: [{ type: "text", text: "That request changed. Please prepare the current leave details again." }], details: { code: "unavailable" } };
          owner.preparing.delete(identity.key);
          // Only content is guaranteed to reach the model; details is UI metadata.
          if (result.code !== "prepared") return { content: [{ type: "text", text: result.code === "needs_input" ? JSON.stringify(result) : "Leave service is temporarily unavailable." }], details: result };
          const item = remember(owner, identity, result);
          if (!item) return { content: [{ type: "text", text: "Leave service is temporarily unavailable." }], details: { code: "unavailable" } };
          try {
            const messageId = await deliverSummary(owner, toolContext, item, signal);
            if (messageId) {
              item.outboundMessageId = messageId;
              await recordShown(item);
            }
          } catch (error) {
            const deliveryCode = ["gateway_unavailable", "gateway_replaced", "receipt_missing", "summary_too_long", "summary_not_literal"].includes(error?.message) ? error.message : "adapter_failed";
            diagnostic(owner, "delivery", deliveryCode);
            forget(item);
            if (error?.message === "summary_too_long" || error?.message === "summary_not_literal") {
              return { content: [{ type: "text", text: "Please shorten the optional note or remove special formatting, then prepare the request again. Nothing has been submitted." }], details: { code: "needs_input", missing: ["employeeNote"] } };
            }
            return { content: [{ type: "text", text: "I could not deliver the confirmation summary. Please try the leave request again." }], details: { code: "unavailable" } };
          }
          if (!isCurrent(owner) || !owner.pending.get(identity.key)?.includes(item)) return { content: [{ type: "text", text: "That request changed. Please prepare the current leave details again." }], details: { code: "unavailable" } };
          const output = visiblePrepareResult(result, item.shown);
          return { content: [{ type: "text", text: JSON.stringify(output) }], details: output };
        },
      };
    },
  })],
});

const baseRegister = plugin.register;
plugin.register = (api) => {
  baseRegister(api);
  let gatewayOwner;
  api.registerService({
    id: "mam-leave-delivery",
    reload: { configPrefixes: ["channels.whatsapp", "messages"] },
    async start(context) {
      if (activeGateway()) throw new Error("MAM leave already has a Gateway owner");
      // This public channel adapter must be resolved in the Gateway registry,
      // not the optional-tool discovery registry (which has no channel entries).
      const adapter = await api.runtime.channel.outbound.loadAdapter("whatsapp");
      if (typeof adapter?.sendText !== "function") throw new Error("MAM WhatsApp delivery adapter is unavailable");
      const owner = { active: true, pending: new Map(), preparing: new Map(), deliveries: new Map(), turns: new Map(), confirmations: new Map(), logger: context.logger };
      owner.canSend = (identity) => {
        if (!isCurrent(owner) || configured()?.account !== identity.account) return false;
        const agentId = /^agent:([A-Za-z0-9_-]+):/u.exec(identity.sessionKey)?.[1];
        if (!agentId) return false;
        try {
          const entry = getSessionEntry({ agentId, sessionKey: identity.sessionKey, readConsistency: "latest" });
          return !!entry && resolveSendPolicy({ cfg: context.config, entry, sessionKey: identity.sessionKey, channel: "whatsapp", chatType: "direct" }) === "allow";
        } catch { return false; }
      };
      owner.sendConfirmation = async (identity, text) => {
        // Explicit, fixed-text response to this authenticated inbound DM. Codex's
        // message_tool-only mode suppresses automatic hook text, not permitted
        // explicit replies. Re-check the real session/config deny policy; do not
        // override visibleReplies or return text that could also auto-deliver.
        if (!owner.canSend(identity)) return;
        try {
          await adapter.sendText({ cfg: context.config, to: identity.sender, text, accountId: identity.account,
            formatting: { chunkMode: "length" } });
        } catch { diagnostic(owner, "confirmation_delivery", "adapter_failed"); }
      };
      owner.validatePreparedSummary = (item) => {
        const cfg = configured();
        if (!isCurrent(owner) || item.owner !== owner || cfg?.account !== item.account
          || !owner.pending.get(item.key)?.includes(item) || sha256(item.summary) !== item.digest || !owner.canSend(item)) throw new Error("draft_unavailable");
        const text = item.deliveryText;
        const limit = Math.min(4000, api.runtime.channel.text.resolveTextChunkLimit(context.config, "whatsapp", item.account, { fallbackLimit: 4000 }));
        if (text.length > limit) throw new Error("summary_too_long");
        if (adapter.sanitizeText?.({ text }) !== text) throw new Error("summary_not_literal");
        return text;
      };
      owner.sendPreparedSummary = async (item, signal) => {
        const text = owner.validatePreparedSummary(item);
        signal?.throwIfAborted();
        // Neither the model nor a caller may select a recipient, account, body,
        // media or alternate config. These all belong to this verified draft.
        return await adapter.sendText({ cfg: context.config, to: item.sender,
          text, accountId: item.account, signal,
          formatting: { chunkMode: "length" } });
      };
      gatewayOwner = owner;
      gatewayStore.setRuntime(owner);
      context.logger?.info?.("MAM leave: gateway delivery ready");
    },
    stop() {
      if (!gatewayOwner) return;
      gatewayOwner.active = false;
      gatewayOwner.pending.clear();
      gatewayOwner.preparing.clear();
      gatewayOwner.deliveries.clear();
      gatewayOwner.turns.clear();
      gatewayOwner.confirmations.clear();
      if (gatewayStore.tryGetRuntime() === gatewayOwner) gatewayStore.clearRuntime();
      gatewayOwner = undefined;
    },
  });

    api.on("message_sent", async (event, context) => {
      const owner = activeGateway();
      if (!isCurrent(owner)) return;
      prune(owner);
      if (!event.success || typeof event.messageId !== "string" || !event.messageId || context.channelId !== "whatsapp") return;
      const sender = senderE164(event.to);
      if (!sender || event.to.includes("@g.us")) return;
      const account = context.accountId ?? "default";
      const session = typeof context.sessionKey === "string" ? `s-${sha256(context.sessionKey.trim())}` : null;
      if (!session) return;
      for (const item of owner.pending.values()) {
        const candidate = item.find((entry) => entry.account === account && entry.sender === sender && entry.session === session
          && entry.deliveryText === event.content && (!entry.outboundMessageId || entry.outboundMessageId === event.messageId));
        if (!candidate) continue;
        candidate.outboundMessageId = event.messageId;
        await recordShown(candidate);
        return;
      }
    });

    api.on("before_dispatch", async (event, context) => {
      const owner = activeGateway();
      if (!isCurrent(owner)) return;
      prune(owner);
      const content = typeof event.content === "string" ? event.content : "";
      const identity = hookConversation(event, context);
      const isConfirm = /^[ \t\r\n]*confirm[ \t\r\n]*$/iu.test(content);
      if (!identity || configured()?.account !== identity.account) return isConfirm ? { handled: true } : undefined;
      const inboundMessageId = event.messageId ?? context.messageId;
      if (!isConfirm) {
        if (owner.turns.get(identity.key)?.messageId === inboundMessageId && inboundMessageId) return;
        const previous = owner.pending.get(identity.key)?.[0];
        // Confirmation is the linearization point: an edit received afterwards
        // cannot undo an already authorized/in-flight submission. Unknown
        // outcomes must be reconciled before a new draft can be prepared.
        if (previous?.confirming) await previous.confirming;
        if (previous?.confirmationPacket && !previous.result) {
          await owner.sendConfirmation(identity, confirmationText({ code: "unavailable" }));
          return { handled: true };
        }
        owner.turns.set(identity.key, { messageId: inboundMessageId, createdAt: Date.now() });
        owner.pending.delete(identity.key);
        owner.preparing.delete(identity.key);
        return;
      }
      if (!owner.canSend(identity)) return { handled: true };
      if (typeof inboundMessageId !== "string" || !SAFE_ID.test(inboundMessageId)) {
        await owner.sendConfirmation(identity, "I could not verify that message. Please send Confirm again.");
        return { handled: true };
      }
      const eventKey = `${identity.key}\u0000${inboundMessageId}`;
      const prior = owner.confirmations.get(eventKey);
      if (prior) { await prior.promise; return { handled: true }; }
      // Freeze the selected draft when the real message arrives, before any
      // await. Duplicate delivery of this event can never select a later draft.
      const item = owner.pending.get(identity.key)?.[0];
      const replyTo = event.replyToIdFull ?? event.replyToId ?? context.replyToIdFull ?? context.replyToId ?? null;
      const timestamp = typeof event.timestamp === "number" && Number.isFinite(event.timestamp)
        ? (event.timestamp < 1e12 ? event.timestamp * 1000 : event.timestamp) : null;
      const record = { expiresAt: Date.now() + 3600_000, promise: null };
      owner.confirmations.set(eventKey, record);
      record.promise = (async () => {
        let text;
        if (!item || owner.preparing.has(identity.key)) text = "There is no current leave summary to confirm. Please tell me your leave dates again.";
        else if (replyTo && replyTo !== item.outboundMessageId) text = "That is an older leave summary. Please review the latest summary and send Confirm without quoting the older message.";
        else if (!item.shown || !item.outboundMessageId || timestamp === null || timestamp < Math.floor(item.shownAt / 1000) * 1000) text = "Please wait for your latest leave summary, then send a new Confirm message. Nothing has been submitted by this message.";
        else if (!item.result && !item.confirmationPacket && item.expiresAt <= Date.now()) text = confirmationText({ code: "expired" });
        else {
          if (!item.result) {
            // Keep the SAME event and exact payload after a timeout, even if the
            // employee retries in a new message. Never manufacture a quote.
            item.confirmationPacket ??= { eventId: inboundMessageId, payload: { draftToken: item.draftToken,
              shownMessageId: item.outboundMessageId, replyToMessageId: replyTo, text: content } };
            if (!item.confirming) item.confirming = bridge(identity, "confirm", item.confirmationPacket.payload, item.confirmationPacket.eventId)
              .then(result => { if (result.code === "submitted" && result.status === "Pending") item.result = result; return result; });
            const result = await item.confirming;
            item.confirming = null;
            if (["expired", "conflict"].includes(result.code)) { item.confirmationPacket = null; forget(item); }
            text = confirmationText(result);
          } else text = confirmationText(item.result);
        }
        await owner.sendConfirmation(identity, text);
      })();
      await record.promise;
      return { handled: true };
    });
};

export default plugin;
