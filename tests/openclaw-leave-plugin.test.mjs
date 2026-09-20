import assert from "node:assert/strict";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const root = new URL("../integrations/openclaw-leave/", import.meta.url);
const source = readFileSync(new URL("index.js", root), "utf8");
const bridgePath = "/api/internal/integrations/openclaw/leave";
const key = "synthetic-test-key-".padEnd(48, "x");
const challenge = "30000000-0000-4000-8000-000000000001";
const summary = "Please review your leave request:\nName: Synthetic Employee\nDates: 2030-10-14\nType: Unpaid leave\nNote (optional): None\n\nTo submit, reply to this message with Confirm within 10 minutes.\nNot submitted yet. Manager approval is still required.";
const deliveryText = `\`\`\`\n${summary}\n\`\`\``;
const env = {
  MAM_OPENCLAW_LEAVE_ENABLED: "true",
  MAM_OPENCLAW_LEAVE_BRIDGE_URL: `https://mam.example.invalid${bridgePath}`,
  MAM_OPENCLAW_LEAVE_BRIDGE_SECRET: key,
  MAM_OPENCLAW_LEAVE_ACCOUNT: "default",
};
const identity = {
  messageChannel: "whatsapp", requesterSenderId: "+61400000001",
  sessionKey: "synthetic-session", agentAccountId: "default",
  deliveryContext: { channel: "whatsapp", accountId: "default", to: "+61400000001" },
  delivery: { send: async () => {} },
};
const hookContext = { channelId: "whatsapp", accountId: "default", sessionKey: identity.sessionKey };

// Deliberate offline shims, NOT an OpenClaw SDK/build or WhatsApp E2E test.
// No module resolution, host process environment, credentials or real fetch.
function loadPlugin(overrides = {}, failShown = 0, stores = new Map(), prepareReply) {
  const imports = [
    'import { createHash, createHmac, randomUUID } from "node:crypto";',
    'import { Type } from "typebox";',
    'import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";',
    'import { createPluginRuntimeStore } from "openclaw/plugin-sdk/runtime-store";',
  ];
  let code = source;
  for (const statement of imports) {
    assert.ok(code.includes(statement), "Update offline shim for changed imports");
    code = code.replace(statement, "");
  }
  assert.doesNotMatch(code, /^import /m);
  assert.ok(code.includes("export default plugin;"));
  code = code.replace("export default plugin;", "globalThis.resultPlugin = plugin;");
  const Type = {
    Object: (properties, options) => ({ type: "object", properties, ...options }),
    String: (options) => ({ type: "string", ...options }),
    Null: () => ({ type: "null" }),
    Union: (anyOf, options) => ({ anyOf, ...options }),
    Optional: (value) => value,
  };
  const calls = [];
  const context = vm.createContext({
    Type, createHash, createHmac, randomUUID, URL, AbortSignal,
    process: { env: { ...env, ...overrides } },
    defineToolPlugin: (spec) => ({ register(api) { api.capture(spec); } }),
    createPluginRuntimeStore: ({ key }) => ({
      tryGetRuntime: () => stores.get(key), setRuntime: (value) => stores.set(key, value), clearRuntime: () => stores.delete(key),
    }),
    fetch: async (url, options) => {
      assert.equal(url.origin, "https://mam.example.invalid");
      assert.equal(url.pathname, bridgePath);
      assert.equal(options.redirect, "error");
      assert.equal(options.headers["x-mam-signature"], createHmac("sha256", key)
        .update(`POST\n${bridgePath}\n${options.headers["x-mam-timestamp"]}\n${options.body}`).digest("hex"));
      const packet = JSON.parse(options.body);
      calls.push(packet);
      if (packet.operation === "shown" && failShown-- > 0) throw new Error("Synthetic response lost");
      assert.ok(["prepare", "shown", "confirm"].includes(packet.operation), "No standalone profile operation");
      const preparation = packet.operation === "prepare" && typeof prepareReply === "function" ? await prepareReply(packet) : prepareReply;
      const data = packet.operation === "prepare" ? preparation ?? {
        code: "prepared", consentVersion: 2, draftId: "10000000-0000-4000-8000-000000000001",
        digest: createHash("sha256").update(summary).digest("hex"), summary,
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
      } : packet.operation === "shown" ? { code: "shown" }
        : { code: "submitted", requestId: "20000000-0000-4000-8000-000000000001", status: "Pending" };
      return { ok: true, json: async () => data };
    },
  });
  new vm.Script(code, { filename: "offline-mam-leave-plugin.js" }).runInContext(context, { timeout: 1_000 });
  let spec;
  let service;
  let adapter;
  const hooks = new Map();
  const config = { synthetic: true };
  context.resultPlugin.register({ capture(value) { spec = value; }, on(name, handler) { hooks.set(name, handler); },
    registerService(value) { service = value; },
    runtime: { channel: { text: { resolveTextChunkLimit: () => 4000 }, outbound: { loadAdapter: async (channel) => {
      assert.equal(channel, "whatsapp"); return adapter;
    } } } },
  });
  return { tools: spec.tools((tool) => tool), hooks, calls, config,
    async start(value = { sendText: async () => ({ messageId: "synthetic-outbound-1" }) }) {
      adapter = { sanitizeText: ({ text }) => text, ...value }; await service.start({ config, logger: {} });
    }, stop() { service.stop(); },
  };
}

function toolByName(plugin, name) {
  const value = plugin.tools.find((tool) => tool.name === name);
  assert.ok(value, `Missing tool ${name}`);
  return value;
}

const params = { leaveType: "Annual leave", startDate: "2030-10-14", endDate: "2030-10-14" };
const confirmEvent = {
  channel: "whatsapp", senderId: identity.requesterSenderId, isGroup: false,
  content: "Confirm", messageId: "synthetic-confirm-1", replyToId: "synthetic-outbound-1", replyToIsQuote: true,
};

test("native plugin package exposes only leave preparation, with no profile tool or temporary harness", () => {
  const files = readdirSync(root);
  for (const required of [".gitignore", "README.md", "index.js", "openclaw.plugin.json", "package.json"]) assert.ok(files.includes(required));
  assert.ok(!files.some((name) => /harness|^\.env/.test(name)));
  const manifest = JSON.parse(readFileSync(new URL("openclaw.plugin.json", root), "utf8"));
  const pkg = JSON.parse(readFileSync(new URL("package.json", root), "utf8"));
  assert.deepEqual([...manifest.contracts.tools], ["mam_leave_prepare"]);
  assert.equal(manifest.toolMetadata.mam_leave_prepare.optional, true);
  assert.equal(manifest.toolMetadata.mam_self_profile, undefined);
  assert.equal(pkg.private, true);
  assert.equal(pkg.dependencies.typebox, "1.3.18");
  const plugin = loadPlugin();
  assert.equal(plugin.tools.length, 1);
  const prepare = toolByName(plugin, "mam_leave_prepare");
  assert.deepEqual([...plugin.hooks.keys()].sort(), ["before_dispatch", "message_sent"]);
  assert.equal(prepare.parameters.additionalProperties, false);
  assert.deepEqual(Object.keys(prepare.parameters.properties).sort(),
    ["leaveType", "startDate", "endDate", "startTime", "endTime", "employeeNote"].sort());
  assert.match(prepare.description, /trusted sender phone number is the sole employee identity/i);
  assert.match(prepare.description, /never ask for or accept.*addressee.*approver/i);
  assert.match(prepare.description, /casual\/ABN.*Unpaid leave/i);
  assert.match(prepare.parameters.properties.employeeNote.description, /optional note/i);
  assert.doesNotMatch(prepare.parameters.properties.employeeNote.description, /\breason\b/i);
  assert.doesNotMatch(source, /name: "mam_self_profile"|bridge\(identity, "profile"/);
});

test("disabled, untrusted, group, wrong-account and malformed-endpoint contexts fail closed", () => {
  for (const context of [
    {}, { ...identity, requesterSenderId: undefined }, { ...identity, sessionKey: "" },
    { ...identity, messageChannel: "web" }, { ...identity, agentAccountId: "other" },
    { ...identity, deliveryContext: { ...identity.deliveryContext, to: "123@g.us" } },
    { ...identity, deliveryContext: { ...identity.deliveryContext, to: "+61400000002" } },
  ]) for (const tool of loadPlugin().tools) assert.equal(tool.factory({ toolContext: context }), null);
  for (const context of [{ ...identity, delivery: undefined }, { ...identity, delivery: {} }]) {
    const plugin = loadPlugin();
    assert.notEqual(toolByName(plugin, "mam_leave_prepare").factory({ toolContext: context }), null);
  }
  for (const override of [
    { MAM_OPENCLAW_LEAVE_ENABLED: undefined }, { MAM_OPENCLAW_LEAVE_BRIDGE_SECRET: "" },
    { MAM_OPENCLAW_LEAVE_BRIDGE_URL: `http://mam.example.invalid${bridgePath}` },
    { MAM_OPENCLAW_LEAVE_BRIDGE_URL: `https://mam.example.invalid${bridgePath}?extra=1` },
  ]) for (const tool of loadPlugin(override).tools) assert.equal(tool.factory({ toolContext: identity }), null);
});

test("runtime factories return complete OpenClaw tools with their declared schemas", () => {
  const plugin = loadPlugin();
  for (const declared of plugin.tools) {
    const runtime = declared.factory({ toolContext: identity });
    assert.ok(runtime, `Expected ${declared.name} in a trusted WhatsApp context`);
    assert.equal(runtime.name, declared.name);
    assert.equal(runtime.label, declared.label);
    assert.equal(runtime.description, declared.description);
    assert.equal(runtime.parameters, declared.parameters);
    assert.equal(runtime.parameters.type, "object");
    assert.equal(typeof runtime.execute, "function");
  }
});

test("no standalone personal-profile capability is exposed to any chat", async () => {
  const plugin = loadPlugin();
  await plugin.start();
  assert.equal(plugin.tools.find(tool => tool.name === "mam_self_profile"), undefined);
  assert.equal(plugin.calls.length, 0);
});

test("missing fields and available types are in model-visible content, not just UI details", async () => {
  const reply = { code: "needs_input", missing: ["leaveType"], availableLeaveTypes: ["Unpaid leave"],
    instruction: "Ask whether the employee wants Unpaid leave instead." };
  const plugin = loadPlugin({}, 0, new Map(), reply);
  await plugin.start({ sendText: async () => { throw new Error("Incomplete request must not send a summary"); } });
  const result = await toolByName(plugin, "mam_leave_prepare").factory({ toolContext: identity }).execute("missing", {});
  assert.deepEqual(JSON.parse(result.content[0].text), reply);
  assert.equal(plugin.calls.length, 1);
  assert.equal(plugin.calls[0].operation, "prepare");
});

test("out-of-order prepare completion cannot replace or invalidate the current quoted draft", async () => {
  const pending = [], deliveries = [];
  const plugin = loadPlugin({}, 0, new Map(), () => new Promise(resolve => pending.push(resolve)));
  await plugin.start({ sendText: async message => { deliveries.push(message.text); return { messageId: confirmEvent.replyToId }; } });
  const tool = toolByName(plugin, "mam_leave_prepare").factory({ toolContext: { ...identity, delivery: undefined } });
  const first = tool.execute("first", params);
  const second = tool.execute("second", params);
  const reply = (suffix) => ({ code: "prepared", consentVersion: 2,
    draftId: "10000000-0000-4000-8000-00000000000" + suffix,
    summary: summary + suffix, digest: createHash("sha256").update(summary + suffix).digest("hex"),
    expiresAt: new Date(Date.now() + 600000).toISOString() });
  pending[1](reply("2"));
  assert.equal((await second).details.code, "prepared");
  pending[0](reply("1"));
  assert.equal((await first).details.code, "unavailable");
  assert.equal(deliveries.length, 1);
  assert.ok(deliveries[0].includes(summary + "2"));
  assert.match((await plugin.hooks.get("before_dispatch")(confirmEvent, hookContext)).text, /pending manager approval/);
  assert.equal(plugin.calls.at(-1).payload.draftId, reply("2").draftId);
});

test("prepare uses the Gateway service adapter when host-bound delivery is absent", async () => {
  const plugin = loadPlugin();
  const deliveries = [];
  await plugin.start({ sendText: async (delivery) => {
        deliveries.push(delivery);
        return { channel: "whatsapp", messageId: "synthetic-adapter-receipt" };
  } });
  const toolContext = { ...identity, delivery: undefined };
  const tool = toolByName(plugin, "mam_leave_prepare").factory({ toolContext });
  const signal = new AbortController().signal;
  const prepared = await tool.execute("adapter-fallback", params, signal);
  assert.equal(prepared.details.code, "prepared");
  assert.match(prepared.details.delivery, /verified delivery receipt/i);
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0].cfg, plugin.config);
  assert.equal(deliveries[0].to, identity.requesterSenderId);
  assert.equal(deliveries[0].accountId, identity.agentAccountId);
  assert.equal(deliveries[0].text, deliveryText);
  assert.equal(deliveries[0].signal, signal);
  assert.deepEqual(plugin.calls.map((call) => call.operation), ["prepare", "shown"]);
  assert.equal(plugin.calls[1].payload.outboundMessageId, "synthetic-adapter-receipt");
});

test("trusted self identity signs prepare, records delivery and requires exact quoted confirmation", async () => {
  const plugin = loadPlugin();
  await plugin.start();
  const deliveries = [];
  const tool = toolByName(plugin, "mam_leave_prepare").factory({ toolContext: { ...identity, delivery: { send: async (message) => { deliveries.push(message); } } } });
  const prepared = await tool.execute("test-call", { ...params, sender: "+61400000002", employeeId: "model-supplied", confirmed: true });
  assert.equal(prepared.details.code, "prepared");
  assert.match(prepared.details.delivery, /awaiting the provider receipt/);
  assert.equal(deliveries[0].text, deliveryText);
  assert.equal(plugin.calls[0].sender, identity.requesterSenderId);
  assert.equal(plugin.calls[0].session, `s-${createHash("sha256").update(identity.sessionKey).digest("hex")}`);
  assert.deepEqual(Object.keys(plugin.calls[0].payload).sort(), Object.keys({ ...params, startTime: null, endTime: null, employeeNote: "" }).sort());
  const hook = plugin.hooks.get("before_dispatch");
  await hook(confirmEvent, hookContext); // No successful outbound receipt yet.
  assert.equal(plugin.calls.length, 1);
  await plugin.hooks.get("message_sent")({ success: true, to: identity.requesterSenderId, content: deliveryText, messageId: "synthetic-outbound-1" }, hookContext);
  assert.equal(plugin.calls.at(-1).operation, "shown");
  for (const [event, context] of [
    [{ ...confirmEvent, senderId: "+61400000002" }, hookContext],
    [{ ...confirmEvent, isGroup: true }, hookContext],
    [{ ...confirmEvent, replyToId: "different" }, hookContext],
    [{ ...confirmEvent, replyToIsQuote: false }, hookContext],
    [{ ...confirmEvent, content: `CONFIRM ${challenge}` }, hookContext],
    [{ ...confirmEvent, content: "yes" }, hookContext],
    [{ ...confirmEvent, messageId: undefined }, hookContext],
    [{ ...confirmEvent, replyToId: undefined }, hookContext],
    [confirmEvent, { ...hookContext, sessionKey: "other-session" }],
    [confirmEvent, { ...hookContext, accountId: "other" }],
  ]) await hook(event, context);
  assert.equal(plugin.calls.length, 2);
  const result = await hook(confirmEvent, hookContext);
  assert.match(result.text, /pending manager approval/);
  assert.deepEqual(plugin.calls.map((call) => call.operation), ["prepare", "shown", "confirm"]);
  await hook(confirmEvent, hookContext);
  assert.equal(plugin.calls.length, 3, "Consumed confirmation must not submit twice");
});

test("failed display receipts retry the same provider ID through hook or confirmation", async () => {
  for (const retryViaHook of [true, false]) {
    const plugin = loadPlugin({}, 1);
    await plugin.start();
    const tool = toolByName(plugin, "mam_leave_prepare").factory({ toolContext: { ...identity, delivery: { send: async () => {} } } });
    await tool.execute("test", params);
    const sent = { success: true, to: identity.requesterSenderId, content: deliveryText, messageId: "synthetic-outbound-1" };
    await plugin.hooks.get("message_sent")(sent, { ...hookContext, sessionKey: "other-session" });
    assert.equal(plugin.calls.length, 1);
    await plugin.hooks.get("message_sent")(sent, hookContext);
    assert.equal(plugin.calls.at(-1).operation, "shown");
    await plugin.hooks.get("message_sent")({ ...sent, messageId: "different-provider-id" }, hookContext);
    assert.equal(plugin.calls.length, 2, "Receipt cannot be rebound after a timeout");
    if (retryViaHook) await plugin.hooks.get("message_sent")(sent, hookContext);
    const result = await plugin.hooks.get("before_dispatch")(confirmEvent, hookContext);
    assert.match(result.text, /pending manager approval/);
    assert.deepEqual(plugin.calls.map((call) => call.operation), ["prepare", "shown", "shown", "confirm"]);
  }
});

test("continued receipt failure does not attempt submission or claim success", async () => {
  const plugin = loadPlugin({}, 10);
  await plugin.start();
  await toolByName(plugin, "mam_leave_prepare").factory({ toolContext: identity }).execute("test", params);
  await plugin.hooks.get("message_sent")({ success: true, to: identity.requesterSenderId, content: deliveryText, messageId: "synthetic-outbound-1" }, hookContext);
  const result = await plugin.hooks.get("before_dispatch")(confirmEvent, hookContext);
  assert.match(result.text, /not confirmed yet/);
  assert.ok(plugin.calls.every((call) => call.operation !== "confirm"));
});

test("a fresh plugin after restart cannot confirm old in-memory drafts", async () => {
  const plugin = loadPlugin();
  await plugin.start();
  const result = await plugin.hooks.get("before_dispatch")(confirmEvent, hookContext);
  assert.equal(result.handled, true);
  assert.match(result.text, /start the leave request again/);
  assert.equal(plugin.calls.length, 0);
});

test("tool-only module graphs share Gateway state but cannot initialize or replace its owner", async () => {
  const stores = new Map();
  const gateway = loadPlugin({}, 0, stores);
  const tools = loadPlugin({}, 0, stores);
  const tool = toolByName(tools, "mam_leave_prepare").factory({ toolContext: { ...identity, delivery: undefined } });
  assert.equal((await tool.execute("no-service", params)).details.code, "unavailable");
  assert.equal(tools.calls.length, 0);
  await gateway.start();
  await assert.rejects(tools.start(), /already has a Gateway owner/);
  tools.stop(); // A discovery registration cannot stop another owner.
  assert.equal((await tool.execute("active", params)).details.code, "prepared");
  const result = await gateway.hooks.get("before_dispatch")({ ...confirmEvent, replyToIsQuote: undefined, replyToBody: deliveryText }, hookContext);
  assert.match(result.text, /pending manager approval/);
  gateway.stop();
  assert.equal((await tool.execute("stopped", params)).details.code, "unavailable");
  await tools.start();
  gateway.stop(); // A stale stop cannot clear the replacement.
  assert.equal((await tool.execute("replacement", params)).details.code, "prepared");
});

test("native WhatsApp quotes with no isQuote flag still require exact receipt and body", async () => {
  const plugin = loadPlugin();
  await plugin.start();
  await toolByName(plugin, "mam_leave_prepare").factory({ toolContext: { ...identity, delivery: undefined } }).execute("test", params);
  for (const event of [
    { ...confirmEvent, replyToIsQuote: undefined },
    { ...confirmEvent, replyToIsQuote: undefined, replyToBody: "different" },
    { ...confirmEvent, replyToIsQuote: false, replyToBody: deliveryText },
    { ...confirmEvent, replyToIsQuote: undefined, replyToBody: deliveryText, replyToId: "different" },
  ]) await plugin.hooks.get("before_dispatch")(event, hookContext);
  assert.equal(plugin.calls.filter((call) => call.operation === "confirm").length, 0);
  const result = await plugin.hooks.get("before_dispatch")({ ...confirmEvent, replyToIsQuote: undefined, replyToBody: deliveryText }, hookContext);
  assert.match(result.text, /pending manager approval/);
});

test("service replacement during delivery cannot register a stale receipt or confirm", async () => {
  const plugin = loadPlugin();
  await plugin.start({ sendText: async () => { plugin.stop(); return { messageId: "synthetic-outbound-1" }; } });
  const result = await toolByName(plugin, "mam_leave_prepare").factory({ toolContext: { ...identity, delivery: undefined } }).execute("test", params);
  assert.equal(result.details.code, "unavailable");
  assert.deepEqual(plugin.calls.map((call) => call.operation), ["prepare"]);
  await plugin.start();
  assert.match((await plugin.hooks.get("before_dispatch")(confirmEvent, hookContext)).text, /no longer available/);
});

test("ordinary chat and startup do not preload a personal profile", async () => {
  const plugin = loadPlugin();
  await plugin.start();
  for (const tool of plugin.tools) tool.factory({ toolContext: identity });
  await plugin.hooks.get("before_dispatch")({ ...confirmEvent, content: "Hello" }, hookContext);
  await plugin.hooks.get("before_dispatch")({ ...confirmEvent, content: "What is the leave policy?" }, hookContext);
  assert.equal(plugin.calls.length, 0);
  assert.match(toolByName(plugin, "mam_leave_prepare").description, /never for greetings, ordinary conversation, startup or general policy/);
  assert.match(toolByName(plugin, "mam_leave_prepare").description, /empty note without an extra question/);
});

test("quoted plain Confirm preserves actual text and a stable provider event identity", async () => {
  const events = [];
  for (const content of ["Confirm", " Confirm ", "\tCONFIRM\n"]) {
    const plugin = loadPlugin();
    await plugin.start();
    await toolByName(plugin, "mam_leave_prepare").factory({ toolContext: { ...identity, delivery: undefined } }).execute("test", params);
    const result = await plugin.hooks.get("before_dispatch")({ ...confirmEvent, content }, hookContext);
    assert.match(result.text, /pending manager approval/);
    const packet = plugin.calls.at(-1);
    assert.equal(packet.version, 2);
    assert.equal(packet.payload.text, content, 'Never fabricate a legacy UUID confirmation');
    assert.equal(packet.payload.replyToMessageId, confirmEvent.replyToId);
    assert.match(packet.eventId, /^wa-[a-f0-9]{64}$/);
    events.push(packet.eventId);
  }
  assert.equal(new Set(events).size, 1, 'Same native event maps to one backend replay key');
});

test("old quoted summary cannot confirm after a replacement summary is prepared", async () => {
  const plugin = loadPlugin();
  let count = 0;
  await plugin.start({ sendText: async () => ({ messageId: `out-${++count}` }) });
  const tool = toolByName(plugin, "mam_leave_prepare").factory({ toolContext: { ...identity, delivery: undefined } });
  await tool.execute("first", params);
  await tool.execute("second", { ...params, startDate: '2030-10-15', endDate: '2030-10-15' });
  const refused = await plugin.hooks.get("before_dispatch")({ ...confirmEvent, replyToId: 'out-1' }, hookContext);
  assert.match(refused.text, /no longer available/);
  assert.equal(plugin.calls.filter(call => call.operation === 'confirm').length, 0);
  const accepted = await plugin.hooks.get("before_dispatch")({ ...confirmEvent, replyToId: 'out-2' }, hookContext);
  assert.match(accepted.text, /pending manager approval/);
});
