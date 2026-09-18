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
const summary = `Synthetic leave summary\nReply to this exact message with CONFIRM ${challenge} within 10 minutes to submit.`;
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
function loadPlugin(overrides = {}, failShown = 0) {
  const imports = [
    'import { createHash, createHmac, randomUUID } from "node:crypto";',
    'import { Type } from "typebox";',
    'import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";',
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
    fetch: async (url, options) => {
      assert.equal(url.origin, "https://mam.example.invalid");
      assert.equal(url.pathname, bridgePath);
      assert.equal(options.redirect, "error");
      assert.equal(options.headers["x-mam-signature"], createHmac("sha256", key)
        .update(`POST\n${bridgePath}\n${options.headers["x-mam-timestamp"]}\n${options.body}`).digest("hex"));
      const packet = JSON.parse(options.body);
      calls.push(packet);
      if (packet.operation === "shown" && failShown-- > 0) throw new Error("Synthetic response lost");
      const data = packet.operation === "prepare" ? {
        code: "prepared", draftId: "10000000-0000-4000-8000-000000000001",
        digest: createHash("sha256").update(summary).digest("hex"), summary,
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
      } : packet.operation === "shown" ? { code: "shown" }
        : { code: "submitted", requestId: "20000000-0000-4000-8000-000000000001", status: "Pending" };
      return { ok: true, json: async () => data };
    },
  });
  new vm.Script(code, { filename: "offline-mam-leave-plugin.js" }).runInContext(context, { timeout: 1_000 });
  let spec;
  const hooks = new Map();
  context.resultPlugin.register({ capture(value) { spec = value; }, on(name, handler) { hooks.set(name, handler); } });
  return { tools: spec.tools((tool) => tool), hooks, calls };
}

const params = { leaveType: "Annual leave", startDate: "2030-10-14", endDate: "2030-10-14" };
const confirmEvent = {
  channel: "whatsapp", senderId: identity.requesterSenderId, isGroup: false,
  content: `CONFIRM ${challenge}`, replyToId: "synthetic-outbound-1", replyToIsQuote: true,
};

test("native plugin package exposes only prepare and contains no temporary harness", () => {
  const files = readdirSync(root);
  for (const required of [".gitignore", "README.md", "index.js", "openclaw.plugin.json", "package.json"]) assert.ok(files.includes(required));
  assert.ok(!files.some((name) => /harness|^\.env/.test(name)));
  const manifest = JSON.parse(readFileSync(new URL("openclaw.plugin.json", root), "utf8"));
  const pkg = JSON.parse(readFileSync(new URL("package.json", root), "utf8"));
  assert.deepEqual(manifest.contracts.tools, ["mam_leave_prepare"]);
  assert.equal(pkg.private, true);
  assert.equal(pkg.dependencies.typebox, "1.3.18");
  const plugin = loadPlugin();
  assert.equal(plugin.tools.length, 1);
  assert.equal(plugin.tools[0].name, "mam_leave_prepare");
  assert.deepEqual([...plugin.hooks.keys()].sort(), ["before_dispatch", "message_sent"]);
  assert.equal(plugin.tools[0].parameters.additionalProperties, false);
  assert.deepEqual(Object.keys(plugin.tools[0].parameters.properties).sort(),
    ["leaveType", "startDate", "endDate", "startTime", "endTime", "employeeNote"].sort());
});

test("disabled, untrusted, group, wrong-account and malformed-endpoint contexts fail closed", () => {
  const tool = loadPlugin().tools[0];
  for (const context of [
    {}, { ...identity, requesterSenderId: undefined }, { ...identity, sessionKey: "" },
    { ...identity, delivery: undefined }, { ...identity, delivery: {} },
    { ...identity, messageChannel: "web" }, { ...identity, agentAccountId: "other" },
    { ...identity, deliveryContext: { ...identity.deliveryContext, to: "123@g.us" } },
    { ...identity, deliveryContext: { ...identity.deliveryContext, to: "+61400000002" } },
  ]) assert.equal(tool.factory({ toolContext: context }), null);
  for (const override of [
    { MAM_OPENCLAW_LEAVE_ENABLED: undefined }, { MAM_OPENCLAW_LEAVE_BRIDGE_SECRET: "" },
    { MAM_OPENCLAW_LEAVE_BRIDGE_URL: `http://mam.example.invalid${bridgePath}` },
    { MAM_OPENCLAW_LEAVE_BRIDGE_URL: `https://mam.example.invalid${bridgePath}?extra=1` },
  ]) assert.equal(loadPlugin(override).tools[0].factory({ toolContext: identity }), null);
});

test("trusted self identity signs prepare, records delivery and requires exact quoted confirmation", async () => {
  const plugin = loadPlugin();
  const deliveries = [];
  const tool = plugin.tools[0].factory({ toolContext: { ...identity, delivery: { send: async (message) => { deliveries.push(message); } } } });
  const prepared = await tool.execute("test-call", { ...params, sender: "+61400000002", employeeId: "model-supplied", confirmed: true });
  assert.equal(prepared.details.code, "prepared");
  assert.match(prepared.details.delivery, /awaiting the provider receipt/);
  assert.equal(deliveries[0].text, summary);
  assert.equal(plugin.calls[0].sender, identity.requesterSenderId);
  assert.equal(plugin.calls[0].session, `s-${createHash("sha256").update(identity.sessionKey).digest("hex")}`);
  assert.deepEqual(Object.keys(plugin.calls[0].payload).sort(), Object.keys({ ...params, startTime: null, endTime: null, employeeNote: "" }).sort());
  const hook = plugin.hooks.get("before_dispatch");
  await hook(confirmEvent, hookContext); // No successful outbound receipt yet.
  assert.equal(plugin.calls.length, 1);
  await plugin.hooks.get("message_sent")({ success: true, to: identity.requesterSenderId, content: summary, messageId: "synthetic-outbound-1" }, hookContext);
  assert.equal(plugin.calls.at(-1).operation, "shown");
  for (const [event, context] of [
    [{ ...confirmEvent, senderId: "+61400000002" }, hookContext],
    [{ ...confirmEvent, isGroup: true }, hookContext],
    [{ ...confirmEvent, replyToId: "different" }, hookContext],
    [{ ...confirmEvent, replyToIsQuote: false }, hookContext],
    [{ ...confirmEvent, content: ` ${confirmEvent.content} ` }, hookContext],
    [{ ...confirmEvent, content: `\n${confirmEvent.content}\n` }, hookContext],
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
    const tool = plugin.tools[0].factory({ toolContext: { ...identity, delivery: { send: async () => {} } } });
    await tool.execute("test", params);
    const sent = { success: true, to: identity.requesterSenderId, content: summary, messageId: "synthetic-outbound-1" };
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
  await plugin.tools[0].factory({ toolContext: identity }).execute("test", params);
  await plugin.hooks.get("message_sent")({ success: true, to: identity.requesterSenderId, content: summary, messageId: "synthetic-outbound-1" }, hookContext);
  const result = await plugin.hooks.get("before_dispatch")(confirmEvent, hookContext);
  assert.match(result.text, /not confirmed yet/);
  assert.ok(plugin.calls.every((call) => call.operation !== "confirm"));
});

test("a fresh plugin after restart cannot confirm old in-memory drafts", async () => {
  const plugin = loadPlugin();
  const result = await plugin.hooks.get("before_dispatch")(confirmEvent, hookContext);
  assert.equal(result.handled, true);
  assert.match(result.text, /start the leave request again/);
  assert.equal(plugin.calls.length, 0);
});
