import assert from "node:assert/strict";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const root = new URL("../integrations/openclaw-leave/", import.meta.url);
const source = readFileSync(new URL("index.js", root), "utf8");
const bridgePath = "/api/internal/integrations/openclaw/leave";
const secret = "synthetic-test-key-".padEnd(48, "x");
const identity = { messageChannel: "whatsapp", requesterSenderId: "+61400000001",
  sessionKey: "agent:main:whatsapp:direct:synthetic", agentAccountId: "default",
  deliveryContext: { channel: "whatsapp", accountId: "default", to: "+61400000001" } };
const hookContext = { channelId: "whatsapp", accountId: "default", sessionKey: identity.sessionKey };
const params = { leaveType: "Unpaid leave", startDate: "2030-10-14", endDate: "2030-10-14" };

// Offline shims only. The separate native harness verifies installed SDK,
// send-policy and WhatsApp adapter behavior without sockets or real identities.
function fixture(options = {}) {
  let clock = Date.now();
  class Clock extends Date { static now() { return clock; } }
  const stores = options.stores ?? new Map(), calls = [], sent = [], hooks = new Map();
  const cfg = options.config ?? {}, policy = { entry: {} };
  const env = { MAM_OPENCLAW_LEAVE_ENABLED: "true", MAM_OPENCLAW_LEAVE_ACCOUNT: "default",
    MAM_OPENCLAW_LEAVE_BRIDGE_URL: `https://mam.example.invalid${bridgePath}`, MAM_OPENCLAW_LEAVE_BRIDGE_SECRET: secret, ...options.env };
  let code = source;
  for (const line of source.match(/^import .*;$/gm)) code = code.replace(line, "");
  code = code.replace("export default plugin;", "globalThis.plugin = plugin;");
  const Type = { Object: (properties, extra) => ({ type: "object", properties, ...extra }),
    String: extra => ({ type: "string", ...extra }), Null: () => ({ type: "null" }),
    Union: (anyOf, extra) => ({ anyOf, ...extra }), Optional: value => value };
  const prepared = (packet, extra = {}) => {
    const summary = `Please review your leave request:\nName: Synthetic Employee\nDates: ${packet.payload.startDate}\nType: Unpaid leave\nNote (optional): ${packet.payload.employeeNote || "None"}`;
    return { code: "prepared", consentVersion: 3, draftId: randomUUID(), draftToken: `opaque-synthetic-token-${randomUUID()}`,
      summary, digest: createHash("sha256").update(summary).digest("hex"), expiresAt: new Date(clock + 600000).toISOString(), ...extra };
  };
  const ctx = vm.createContext({ Type, createHash, createHmac, randomUUID, URL, AbortSignal, Date: Clock, process: { env },
    defineToolPlugin: spec => ({ register(api) { api.capture(spec); } }),
    createPluginRuntimeStore: ({ key }) => ({ tryGetRuntime: () => stores.get(key), setRuntime: value => stores.set(key, value), clearRuntime: () => stores.delete(key) }),
    getSessionEntry: ({ agentId, sessionKey, readConsistency }) => {
      assert.equal(agentId, "main"); assert.ok(sessionKey.startsWith("agent:main:")); assert.equal(readConsistency, "latest"); return policy.entry;
    },
    resolveSendPolicy: ({ cfg, entry }) => entry.sendPolicy ?? cfg.session?.sendPolicy?.default ?? "allow",
    fetch: async (url, request) => {
      assert.equal(url.origin, "https://mam.example.invalid"); assert.equal(url.pathname, bridgePath); assert.equal(request.redirect, "error");
      assert.equal(request.headers["x-mam-signature"], createHmac("sha256", secret)
        .update(`POST\n${bridgePath}\n${request.headers["x-mam-timestamp"]}\n${request.body}`).digest("hex"));
      const packet = JSON.parse(request.body); calls.push(packet);
      assert.equal(packet.version, 3);
      assert.ok(["prepare", "confirm"].includes(packet.operation), "No pre-confirm shown, revise or profile writes");
      const data = packet.operation === "prepare"
        ? options.prepare ? await options.prepare(packet, prepared) : prepared(packet)
        : options.confirm ? await options.confirm(packet) : { code: "submitted", requestId: "20000000-0000-4000-8000-000000000001", status: "Pending" };
      return { ok: true, json: async () => data };
    },
  });
  new vm.Script(code).runInContext(ctx, { timeout: 1000 });
  let spec, service;
  ctx.plugin.register({ capture: value => { spec = value; }, on: (name, handler) => hooks.set(name, handler), registerService: value => { service = value; },
    runtime: { channel: { text: { resolveTextChunkLimit: () => 4000 }, outbound: { loadAdapter: async () => ({
      sanitizeText: ({ text }) => options.sanitize ? options.sanitize(text) : text,
      sendText: async message => { sent.push(message); return options.send ? await options.send(message) : { messageId: `OUT_${sent.length}` }; },
    }) } } } });
  const tools = spec.tools(tool => tool);
  return { calls, sent, hooks, policy, tools, prepared,
    start: () => service.start({ config: cfg, logger: {} }), stop: () => service.stop(), tick: (ms = 1000) => { clock += ms; },
    tool: (extra = {}) => tools[0].factory({ toolContext: { ...identity, ...extra } }),
    event: (extra = {}) => ({ channel: "whatsapp", senderId: identity.requesterSenderId, isGroup: false,
      content: "Confirm", messageId: randomUUID(), timestamp: clock + 1000, ...extra }),
    dispatch: (event, context = hookContext) => hooks.get("before_dispatch")(event, context),
    summary: () => sent.filter(item => item.text.startsWith("```\n")).at(-1),
    feedback: () => sent.filter(item => !item.text.startsWith("```\n")).at(-1)?.text,
  };
}

test("only preparation is model-visible; identity and confirmation cannot be selected", () => {
  const f = fixture(), manifest = JSON.parse(readFileSync(new URL("openclaw.plugin.json", root), "utf8"));
  assert.deepEqual(manifest.contracts.tools, ["mam_leave_prepare"]); assert.equal(f.tools.length, 1);
  assert.equal(f.tools[0].parameters.additionalProperties, false);
  assert.deepEqual(Object.keys(f.tools[0].parameters.properties).sort(), ["employeeNote", "endDate", "endTime", "leaveType", "startDate", "startTime"]);
  assert.match(f.tools[0].description, /trusted sender phone number is the sole employee identity/);
  assert.match(f.tools[0].description, /never for greetings, ordinary conversation, startup/);
  assert.match(f.tools[0].description, /Never call this tool in response to Confirm/);
});

test("disabled, untrusted, group and wrong-account tool contexts fail closed", () => {
  for (const extra of [{ requesterSenderId: undefined }, { sessionKey: "" }, { messageChannel: "web" }, { agentAccountId: "other" },
    { deliveryContext: { ...identity.deliveryContext, to: "123@g.us" } }, { deliveryContext: { ...identity.deliveryContext, to: "+61400000002" } }]) assert.equal(fixture().tool(extra), null);
  for (const env of [{ MAM_OPENCLAW_LEAVE_ENABLED: "false" }, { MAM_OPENCLAW_LEAVE_BRIDGE_SECRET: "" },
    { MAM_OPENCLAW_LEAVE_BRIDGE_URL: `http://mam.example.invalid${bridgePath}` }]) assert.equal(fixture({ env }).tool(), null);
});

test("prepare is read-only, token stays hidden, standalone Confirm uses true sender and no invented quote", async () => {
  const f = fixture(); await f.start();
  const result = await f.tool().execute("prepare", { ...params, sender: "+61400000002", confirmed: true, employeeId: "forged" });
  assert.deepEqual(f.calls.map(p => p.operation), ["prepare"]); assert.equal(f.calls[0].sender, identity.requesterSenderId);
  assert.equal(f.calls[0].payload.sender, undefined); assert.match(result.details.instruction, /Send Confirm within 10 minutes/);
  assert.doesNotMatch(JSON.stringify(result), /opaque-synthetic-token/); assert.doesNotMatch(f.summary().text, /To submit|Not submitted|Manager approval/);
  const event = f.event({ content: "\tconfirm \n" }), handled = await f.dispatch(event);
  assert.equal(handled.handled, true); assert.equal(handled.text, undefined, "No duplicate automatic reply");
  assert.match(f.feedback(), /submitted and is now pending manager approval/);
  assert.deepEqual(f.calls.map(p => p.operation), ["prepare", "confirm"]);
  assert.equal(f.calls[1].payload.replyToMessageId, null); assert.equal(f.calls[1].payload.shownMessageId, "OUT_1");
  assert.equal(f.calls[1].payload.text, event.content); assert.match(f.calls[1].eventId, /^wa-[a-f0-9]{64}$/);
  assert.deepEqual(Object.keys(f.calls[1].payload).sort(), ["draftToken", "replyToMessageId", "shownMessageId", "text"]);
  await f.dispatch(event); assert.equal(f.calls.length, 2); assert.equal(f.sent.length, 2);
  await f.dispatch(f.event()); assert.equal(f.calls.length, 2, "New Confirm returns the same completed request");
});

test("editing invalidates the old summary immediately before collecting new fields", async () => {
  const f = fixture(); await f.start(); const staleTool = f.tool(); await staleTool.execute("a", params);
  await f.dispatch(f.event({ content: "Actually make it Friday" })); await f.dispatch(f.event());
  assert.match(f.feedback(), /no current leave summary/); assert.equal(f.calls.length, 1);
  assert.equal((await staleTool.execute("stale", params)).details.code, "unavailable");
  await f.tool().execute("b", { ...params, startDate: "2030-10-15", endDate: "2030-10-15" });
  assert.match(f.summary().text, /2030-10-15/);
  await f.dispatch(f.event({ replyToId: "OUT_1", replyToIsQuote: true })); assert.match(f.feedback(), /older leave summary/);
  assert.equal(f.calls.filter(p => p.operation === "confirm").length, 0);
  await f.dispatch(f.event()); assert.equal(f.calls.at(-1).payload.shownMessageId, "OUT_3");
});

test("needs_input and failed delivery never restore an older draft", async () => {
  let incomplete = false;
  const f = fixture({ prepare: (packet, prepared) => incomplete ? { code: "needs_input", missing: ["startDate"] } : prepared(packet) });
  await f.start(); await f.tool().execute("a", params); incomplete = true;
  assert.deepEqual(JSON.parse((await f.tool().execute("b", {})).content[0].text), { code: "needs_input", missing: ["startDate"] });
  await f.dispatch(f.event()); assert.equal(f.calls.filter(p => p.operation === "confirm").length, 0);
  for (const options of [{ send: async () => { throw new Error("synthetic failure"); } }, { sanitize: text => text + "changed" }]) {
    const bad = fixture(options); await bad.start(); assert.notEqual((await bad.tool().execute("bad", params)).details.code, "prepared");
    await bad.dispatch(bad.event()); assert.equal(bad.calls.length, 1);
  }
});

test("out-of-order prepare completions cannot restore an older request", async () => {
  const pending = [], f = fixture({ prepare: (packet, prepared) => new Promise(resolve => pending.push(() => resolve(prepared(packet)))) });
  await f.start(); const tool = f.tool(), a = tool.execute("a", params), b = tool.execute("b", { ...params, startDate: "2030-10-15" });
  pending[1](); assert.equal((await b).details.code, "prepared"); pending[0](); assert.equal((await a).details.code, "unavailable");
  assert.equal(f.sent.length, 1); assert.match(f.summary().text, /2030-10-15/);
  await f.dispatch(f.event()); assert.equal(f.calls.at(-1).payload.shownMessageId, "OUT_1");
});

test("replacement summary is delivered after a prior in-flight send", async () => {
  const releases = [], f = fixture({ send: () => new Promise(resolve => releases.push(resolve)) }); await f.start();
  const a = f.tool().execute("a", params); await new Promise(resolve => setImmediate(resolve));
  const b = f.tool().execute("b", { ...params, startDate: "2030-10-15" }); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.sent.length, 1); releases[0]({ messageId: "A" }); assert.equal((await a).details.code, "unavailable");
  await new Promise(resolve => setImmediate(resolve)); assert.equal(f.sent.length, 2);
  releases[1]({ messageId: "B" }); assert.equal((await b).details.code, "prepared"); assert.match(f.summary().text, /2030-10-15/);
});

test("only an actual current delivery receipt enables confirmation, with no shown HTTP write", async () => {
  const f = fixture(); await f.start(); await f.tool({ delivery: { send: async () => {} } }).execute("a", params);
  await f.dispatch(f.event()); assert.match(f.feedback(), /wait for your latest leave summary/); assert.equal(f.calls.length, 1);
  const content = "```\n" + f.prepared(f.calls[0]).summary + "\n```";
  const sent = { success: true, to: identity.requesterSenderId, content, messageId: "REAL_RECEIPT" };
  await f.hooks.get("message_sent")(sent, { ...hookContext, sessionKey: "wrong" }); await f.dispatch(f.event()); assert.equal(f.calls.length, 1);
  await f.hooks.get("message_sent")(sent, hookContext); assert.equal(f.calls.length, 1);
  await f.dispatch(f.event()); assert.equal(f.calls.length, 2);
});

test("cross-person/account/session, group, stale time and missing provenance cannot confirm", async () => {
  const f = fixture(); await f.start(); await f.tool().execute("a", params);
  for (const [extra, context] of [
    [{ senderId: "+61400000002" }, hookContext], [{ isGroup: true }, hookContext], [{}, { ...hookContext, accountId: "other" }],
    [{}, { ...hookContext, sessionKey: "agent:main:whatsapp:direct:other" }],
    [{ timestamp: undefined }, hookContext], [{ timestamp: 1 }, hookContext], [{ messageId: undefined }, hookContext],
  ]) await f.dispatch(f.event(extra), context);
  assert.equal(f.calls.length, 1); await f.dispatch(f.event({ content: "yes" })); await f.dispatch(f.event()); assert.equal(f.calls.length, 1);
});

test("a current quote is optional but an old quote never falls back to latest", async () => {
  const f = fixture(); await f.start(); await f.tool().execute("a", params);
  await f.dispatch(f.event({ replyToId: "OLD_RECEIPT" })); assert.equal(f.calls.length, 1);
  await f.dispatch(f.event({ replyToId: "OUT_1" })); assert.equal(f.calls.at(-1).payload.replyToMessageId, "OUT_1");
});

test("duplicate Confirm events never select a later draft", async () => {
  const f = fixture(); await f.start(); await f.tool().execute("a", params); const event = f.event(); await f.dispatch(event);
  await f.dispatch(f.event({ content: "Now another day" })); await f.tool().execute("b", { ...params, startDate: "2030-10-15" });
  await f.dispatch(event); assert.equal(f.calls.filter(p => p.operation === "confirm").length, 1);
  await f.dispatch(f.event()); assert.equal(f.calls.filter(p => p.operation === "confirm").length, 2);
});

test("concurrent confirms share one submission; later edit waits for its outcome", async () => {
  let finish; const f = fixture({ confirm: () => new Promise(resolve => { finish = resolve; }) });
  await f.start(); await f.tool().execute("a", params);
  const a = f.dispatch(f.event()), b = f.dispatch(f.event()), edit = f.dispatch(f.event({ content: "Change to Friday" }));
  assert.equal(f.calls.filter(p => p.operation === "confirm").length, 1);
  finish({ code: "submitted", status: "Pending" }); await Promise.all([a, b, edit]);
  await f.dispatch(f.event()); assert.match(f.feedback(), /no current leave summary/);
});

test("lost response retries freeze token/event and block replacement until reconciled", async () => {
  let attempts = 0;
  const f = fixture({ confirm: async () => { if (!attempts++) throw new Error("lost response"); return { code: "submitted", status: "Pending" }; } });
  await f.start(); await f.tool().execute("a", params); await f.dispatch(f.event());
  assert.match(f.feedback(), /could not verify submission/); const packet = f.calls.at(-1);
  await f.dispatch(f.event({ content: "Change date" })); assert.match(f.feedback(), /could not verify submission/);
  assert.equal((await f.tool().execute("b", params)).details.code, "unavailable");
  await f.dispatch(f.event()); assert.deepEqual(f.calls.at(-1), packet); assert.match(f.feedback(), /pending manager approval/);
});

test("native policy deny and missing session prevent replies and submissions", async () => {
  for (const entry of [undefined, { sendPolicy: "deny" }]) {
    const f = fixture(); await f.start(); await f.tool().execute("a", params); f.policy.entry = entry;
    await f.dispatch(f.event()); assert.equal(f.calls.length, 1); assert.equal(f.sent.length, 1);
  }
  const f = fixture({ config: { session: { sendPolicy: { default: "deny" } } } }); await f.start();
  assert.equal((await f.tool().execute("a", params)).details.code, "unavailable"); assert.equal(f.sent.length, 0);
});

test("expiry/restart lose pending drafts; discovery graphs share only active owner", async () => {
  const stores = new Map(), gateway = fixture({ stores }), discovery = fixture({ stores });
  await gateway.start(); await discovery.tool().execute("a", params); await discovery.dispatch(discovery.event());
  assert.match(gateway.feedback(), /pending manager approval/); gateway.stop(); await gateway.start();
  await gateway.dispatch(gateway.event()); assert.match(gateway.feedback(), /no current leave summary/);
  await gateway.tool().execute("b", params); gateway.tick(600001); await gateway.dispatch(gateway.event()); assert.match(gateway.feedback(), /no current leave summary/);
  gateway.stop(); assert.equal((await gateway.tool().execute("stopped", params)).details.code, "unavailable");
});

test("ordinary chat and startup never fetch personal profiles or write drafts", async () => {
  const f = fixture(); await f.start(); await f.dispatch(f.event({ content: "Hello" })); await f.dispatch(f.event({ content: "What is the leave policy?" }));
  assert.equal(f.calls.length, 0); assert.equal(f.sent.length, 0);
});
