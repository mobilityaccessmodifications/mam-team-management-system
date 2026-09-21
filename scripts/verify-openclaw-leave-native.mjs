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
    const challenge = randomUUID();
    const summary = ["Please review your leave request:", "Name: Synthetic Employee", "Dates: 2030-10-14",
      "Type: Unpaid leave", `Note (optional): ${packet.payload.employeeNote || "None"}`].join("\n");
    data = { code: "prepared", consentVersion: 2, draftId: randomUUID(), summary, digest: createHash("sha256").update(summary).digest("hex"), expiresAt: new Date(Date.now() + 600_000).toISOString() };
    drafts.set(data.draftId, { ...data, challenge });
  } else if (packet.operation === "shown") {
    const draft = drafts.get(packet.payload.draftId);
    assert.equal(packet.payload.digest, draft.digest);
    assert.equal(sent.at(-1).text, `\`\`\`\n${draft.summary}\n\`\`\``, "Actual WhatsApp rendering must preserve the complete literal summary");
    assert.equal(sent.at(-1).messageId, packet.payload.outboundMessageId);
    draft.outboundMessageId = packet.payload.outboundMessageId;
    data = { code: "shown" };
  } else if (packet.operation === "confirm") {
    const draft = drafts.get(packet.payload.draftId);
    assert.equal(packet.payload.replyToMessageId, draft.outboundMessageId);
    assert.equal(packet.payload.text, "Confirm");
    assert.equal(packet.version, 2);
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
  // Same supplemental quote shape constructed by installed WhatsApp monitor.
  const ctx = finalizeInbound({ Body: "Confirm", RawBody: "Confirm", MessageSid: `NATIVE_INBOUND_${sent.length}`,
    Provider: "whatsapp", Surface: "whatsapp", ChatType: "direct", SenderId: toolContext.requesterSenderId,
    From: toolContext.requesterSenderId, AccountId: "default", SessionKey: toolContext.sessionKey,
    SupplementalContext: { quote: { id: sent.at(-1).messageId, body: sent.at(-1).text, sender: "Synthetic MAM Bot" } } });
  const canonical = deriveInbound(ctx);
  assert.equal(canonical.replyToIsQuote, undefined, "WhatsApp does not populate this optional marker");
  assert.equal(canonical.isGroup, false);
  assert.equal(canonical.messageId, `NATIVE_INBOUND_${sent.length}`);
  const event = { ...canonical, channel: canonical.channelId };
  const confirmed = await gateway.hooks.get("before_dispatch")(event, canonical);
  assert.match(confirmed.text, /pending manager approval/);
  const count = packets.filter((packet) => packet.operation === "confirm").length;
  await gateway.hooks.get("before_dispatch")(event, canonical);
  assert.equal(packets.filter((packet) => packet.operation === "confirm").length, count);
}
gateway.service.stop();
assert.equal((await tool.execute("stopped", {})).details.code, "unavailable");
console.log("PASS: actual SDK tool-only lookup failure reproduced; separate module graphs; real WhatsApp adapter with offline listener; prepare -> one exact summary -> native quote -> one submission; 2000-character note; service stop.");
