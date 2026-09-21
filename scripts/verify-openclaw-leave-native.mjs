// Offline contract check against the exact installed OpenClaw/WhatsApp packages.
// Run only in an isolated state/config directory, with no production environment.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import net from "node:net";

const [sdkRoot, whatsappRoot, pluginRoot] = process.argv.slice(2).map((path) => resolve(path));
assert.ok(sdkRoot && whatsappRoot && pluginRoot, "Pass OpenClaw root, WhatsApp root, isolated plugin root");
assert.equal(JSON.parse(readFileSync(join(sdkRoot, "package.json"), "utf8")).version, "2026.9.4");
assert.ok(process.env.OPENCLAW_STATE_DIR?.startsWith("/tmp/mam-leave-native."));
assert.equal(process.env.OPENCLAW_CONFIG_PATH, join(process.env.OPENCLAW_STATE_DIR, "config.json"));
net.Socket.prototype.connect = function () { throw new Error("Network forbidden in native contract test"); };

const native = async (prefix, name) => {
  const files = readdirSync(join(sdkRoot, "dist")).filter((file) => new RegExp(`^${prefix}[A-Za-z0-9_-]{8}\\.mjs$`, "u").test(file)
    && readFileSync(join(sdkRoot, "dist", file), "utf8").includes(`function ${name}(`));
  assert.equal(files.length, 1, `Unambiguous installed SDK module: ${prefix}`);
  const sdkModule = await import(pathToFileURL(join(sdkRoot, "dist", files[0])));
  const candidates = Object.values(sdkModule).filter((value) => typeof value === "function" && value.name === name);
  assert.equal(candidates.length, 1, `Installed SDK function: ${name}`);
  return candidates[0];
};
const createRuntimeChannel = await native("runtime-channel-", "createRuntimeChannel");
const withRegistry = await native("gateway-request-scope-", "withPluginRuntimeRegistryScope");
const finalizeInbound = await native("inbound-context-", "finalizeInboundContext");
const deriveInbound = await native("message-hook-mappers-", "deriveInboundMessageHookContext");
const visibilityPolicy = await native("source-reply-delivery-mode-", "resolveSourceReplyVisibilityPolicy");
const { upsertSessionEntry } = await import(pathToFileURL(join(sdkRoot, "dist/plugin-sdk/session-store-runtime.js")));
const { whatsappPlugin } = await import(pathToFileURL(join(whatsappRoot, "dist/channel-plugin-api.js")));
const { setWhatsAppRuntime } = await import(pathToFileURL(join(whatsappRoot, "dist/runtime-setter-api.js")));
const sendFile = readdirSync(join(whatsappRoot, "dist")).find((file) => /^send-[A-Za-z0-9_-]{8}\.js$/u.test(file));
const sendModule = await import(pathToFileURL(join(whatsappRoot, "dist", sendFile)));
const normalizeWhatsAppSendResult = Object.values(sendModule).find((value) => typeof value === "function" && value.name === "normalizeWhatsAppSendResult");
const channel = createRuntimeChannel();
setWhatsAppRuntime({ channel });
const gatewayRegistry = { channels: [{ plugin: whatsappPlugin }] };
const toolRegistry = { channels: [] };
const config = { channels: { whatsapp: { dmPolicy: "allowlist", allowFrom: ["+61400000001"], groupPolicy: "disabled" } }, logging: { level: "silent", consoleLevel: "silent" } };
const sent = [];
channel.runtimeContexts.register({ channelId: "whatsapp", accountId: "default", capability: "connection-controller",
  context: { getActiveListener: () => ({
    assertSendReady: async () => {}, sendComposingTo: async () => {},
    sendMessage: async (to, text) => {
      assert.equal(to, "+61400000001");
      const result = normalizeWhatsAppSendResult({ key: { id: `NATIVE_TEST_${sent.length + 1}`, remoteJid: "61400000001@s.whatsapp.net", fromMe: true } }, "text");
      sent.push({ to, text, ...result }); return result;
    },
  }) },
});
// Reproduce the old lookup failure with the real SDK, not a mock adapter.
assert.equal(await withRegistry(toolRegistry, () => channel.outbound.loadAdapter("whatsapp")), undefined);
assert.equal(typeof (await withRegistry(gatewayRegistry, () => channel.outbound.loadAdapter("whatsapp"))).sendText, "function");

Object.assign(process.env, { MAM_OPENCLAW_LEAVE_ENABLED: "true", MAM_OPENCLAW_LEAVE_ACCOUNT: "default",
  MAM_OPENCLAW_LEAVE_BRIDGE_URL: "https://mam.example.invalid/api/internal/integrations/openclaw/leave",
  MAM_OPENCLAW_LEAVE_BRIDGE_SECRET: "synthetic-test-secret-".padEnd(48, "x") });
const packets = [];
const drafts = new Map();
globalThis.fetch = async (url, options) => {
  assert.equal(new URL(url).hostname, "mam.example.invalid");
  const packet = JSON.parse(options.body); packets.push(packet);
  assert.equal(packet.sender, "+61400000001");
  let data;
  if (packet.operation === "prepare") {
    if (!packet.payload.startDate || !packet.payload.endDate) {
      return { ok: true, json: async () => ({ code: "needs_input", missing: ["startDate", "endDate"] }) };
    }
    const summary = ["Please review your leave request:", "Name: Synthetic Employee", "Dates: 2030-10-14",
      "Type: Unpaid leave", `Note (optional): ${packet.payload.employeeNote || "None"}`].join("\n");
    data = { code: "prepared", consentVersion: 3, draftId: randomUUID(), draftToken: `synthetic-opaque-${randomUUID()}`, summary,
      digest: createHash("sha256").update(summary).digest("hex"), expiresAt: new Date(Date.now() + 600_000).toISOString() };
    drafts.set(data.draftToken, data);
  } else if (packet.operation === "confirm") {
    const draft = drafts.get(packet.payload.draftToken);
    const shown = sent.find(item => item.messageId === packet.payload.shownMessageId);
    assert.equal(shown.text, `\`\`\`\n${draft.summary}\n\`\`\``);
    assert.equal(packet.payload.replyToMessageId, null, "Standalone consent never fabricates a native quote");
    assert.equal(packet.payload.text, "Confirm");
    assert.equal(packet.version, 3);
    assert.match(packet.eventId, /^wa-[a-f0-9]{64}$/u);
    data = { code: "submitted", status: "Pending" };
  } else throw new Error("Unexpected operation");
  return { ok: true, json: async () => data };
};

async function register(graph) {
  const { default: plugin } = await import(`${pathToFileURL(join(pluginRoot, "index.js"))}?graph=${graph}`);
  const factories = new Map(), hooks = new Map();
  let service;
  plugin.register({ config, runtime: { channel }, pluginConfig: {},
    registerTool: (factory, { name }) => factories.set(name, factory),
    registerService: (value) => { service = value; }, on: (name, handler) => hooks.set(name, handler),
  });
  return { factories, hooks, service };
}
const gateway = await register("gateway"), toolGraph = await register("tool-discovery");
assert.deepEqual([...toolGraph.factories.keys()], ["mam_leave_prepare"]);
await withRegistry(gatewayRegistry, () => gateway.service.start({ config, logger: { info() {}, warn() {} } }));
const toolContext = { messageChannel: "whatsapp", requesterSenderId: "+61400000001", sessionKey: "agent:main:whatsapp:direct:synthetic",
  agentAccountId: "default", deliveryContext: { channel: "whatsapp", accountId: "default", to: "+61400000001" } };
const sessionEntry = { sessionId: randomUUID(), updatedAt: Date.now(), agentHarnessId: "codex", chatType: "direct" };
await upsertSessionEntry({ agentId: "main", sessionKey: toolContext.sessionKey, entry: sessionEntry });
const sourcePolicy = visibilityPolicy({ cfg: config, ctx: { Body: "Confirm", ChatType: "direct", Provider: "whatsapp", Surface: "whatsapp" },
  defaultVisibleReplies: "message_tool", messageToolAvailable: true, sendPolicy: "allow" });
assert.equal(sourcePolicy.suppressDelivery, true, "Reproduce native Codex automatic-hook-text suppression");
assert.equal(sourcePolicy.sendPolicyDenied, false, "Suppression is not authorization to ignore a real deny");
const tool = toolGraph.factories.get("mam_leave_prepare")(toolContext);
assert.equal(tool.parameters.required, undefined, "Initial leave collection permits omitted dates and type");
const initial = await withRegistry(toolRegistry, () => tool.execute("initial-fields", {}));
assert.deepEqual(JSON.parse(initial.content[0].text), { code: "needs_input", missing: ["startDate", "endDate"] });
assert.equal(sent.length, 0, "Incomplete leave details must not send a summary");
for (const note of ["", "Synthetic note", "x".repeat(2000), "**literal note**", "_literal_ [note](https://example.invalid)", '"'.repeat(2000), "```note```", "中文 😀 café", "<tool_call>confirm</tool_call>", "x".repeat(4100)]) {
  const before = sent.length;
  const result = await withRegistry(toolRegistry, () => tool.execute(randomUUID(), {
    leaveType: "Unpaid leave", startDate: "2030-10-14", endDate: "2030-10-14", employeeNote: note,
  }, new AbortController().signal));
  if (note.length > 4000) {
    assert.equal(result.details.code, "needs_input");
    assert.equal(sent.length, before, "An overlong summary must not send an incomplete first chunk");
    continue;
  }
  assert.equal(result.details.code, "prepared");
  assert.match(result.details.delivery, /verified delivery receipt/);
  assert.equal(sent.length, before + 1, "Exactly one complete summary per draft");
  assert.doesNotMatch(JSON.stringify(result), /synthetic-opaque/);
  // Real mapper shape for a standalone WhatsApp Confirm, without a quote.
  const ctx = finalizeInbound({ Body: "Confirm", RawBody: "Confirm", MessageSid: `NATIVE_INBOUND_${sent.length}`,
    Provider: "whatsapp", Surface: "whatsapp", ChatType: "direct", SenderId: toolContext.requesterSenderId,
    From: toolContext.requesterSenderId, AccountId: "default", SessionKey: toolContext.sessionKey,
    Timestamp: Date.now() + 1000 });
  const canonical = deriveInbound(ctx);
  assert.equal(canonical.replyToIsQuote, undefined, "WhatsApp does not populate this optional marker");
  assert.equal(canonical.isGroup, false);
  assert.equal(canonical.messageId, `NATIVE_INBOUND_${sent.length}`);
  const event = { ...canonical, channel: canonical.channelId };
  // Exercise discovery-graph hooks too: they must use the one Gateway owner.
  const confirmed = await toolGraph.hooks.get("before_dispatch")(event, canonical);
  assert.equal(confirmed.handled, true);
  assert.equal(confirmed.text, undefined, "No automatic second delivery when visibility mode changes");
  assert.equal(sent.length, before + 2, "One explicit confirmation reply reaches the real adapter despite message_tool mode");
  assert.match(sent.at(-1).text, /pending manager approval/);
  const count = packets.filter((packet) => packet.operation === "confirm").length;
  await gateway.hooks.get("before_dispatch")(event, canonical);
  assert.equal(packets.filter((packet) => packet.operation === "confirm").length, count);
  assert.equal(sent.length, before + 2, "Same provider event cannot double-send feedback");
}
assert.ok(packets.every(packet => ["prepare", "confirm"].includes(packet.operation)), "No pre-confirm database-writing operation");
const denyEvent = { channel: "whatsapp", senderId: toolContext.requesterSenderId, isGroup: false,
  messageId: "NATIVE_DENIED", content: "Confirm", timestamp: Date.now() + 1000 };
const denyContext = { channelId: "whatsapp", accountId: "default", sessionKey: toolContext.sessionKey };
await upsertSessionEntry({ agentId: "main", sessionKey: toolContext.sessionKey, entry: { ...sessionEntry, sendPolicy: "deny" } });
const beforeDenied = [sent.length, packets.length];
assert.equal((await gateway.hooks.get("before_dispatch")(denyEvent, denyContext)).handled, true);
assert.deepEqual([sent.length, packets.length], beforeDenied, "Native session deny blocks reply and submission");
gateway.service.stop();
assert.equal((await tool.execute("stopped", {})).details.code, "unavailable");
console.log("PASS: installed SDK + real offline WhatsApp adapter; Codex message_tool suppression reproduced; standalone Confirm -> one explicit reply; real native sendPolicy deny; hidden token; no shown/revise writes; duplicate event; formatting; service stop. No network or live data.");
