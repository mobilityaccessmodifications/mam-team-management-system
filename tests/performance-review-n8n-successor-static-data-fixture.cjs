async function main() {
const { default: assert } = await import('node:assert/strict');
const crypto = await import('node:crypto');
const fs = await import('node:fs');
const path = await import('node:path');
const vm = await import('node:vm');
const zlib = await import('node:zlib');

const bundle = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(__dirname, 'performance-review-n8n-successor-origin.fixture.gz'))));
const sources = {};
for (const key of ['schedule-source', 'schedule-generic', 'workflow-static-source']) {
  const info = bundle.installed[key];
  const raw = Buffer.from(info.source);
  const sha256 = crypto.createHash('sha256').update(raw).digest('hex');
  assert.equal(sha256, info.sha256);
  sources[key] = sha256;
}
const refuse = () => { throw new Error('FORBIDDEN_ORACLE_PORT'); };
const connectionTypes = Object.freeze({ Main: 'main' });
class SyntheticNodeOperationError extends Error {}
const workflowPort = Object.freeze({ NodeConnectionTypes: connectionTypes, NodeOperationError: SyntheticNodeOperationError });
const clockPort = refuse;
const modules = Object.freeze({ crypto, 'moment-timezone': clockPort, 'n8n-workflow': workflowPort, cron: Object.freeze({ sendAt: refuse }) });
function compile(source, filename, dependencies) {
  const loaded = { exports: {} };
  const context = vm.createContext({ module: loaded, exports: loaded.exports, require: (name) => {
    assert.ok(Object.hasOwn(dependencies, name), 'unexpected oracle import');
    return dependencies[name];
  } });
  new vm.Script(source, { filename }).runInContext(context, { timeout: 1000 });
  return loaded.exports;
}
const generic = compile(bundle.installed['schedule-generic'].source, 'captured-schedule-generic.js', modules);
const schedule = compile(bundle.installed['schedule-source'].source, 'captured-schedule-source.js', { ...modules, './GenericFunctions': generic });
const workflow = bundle.installed['workflow-static-source'].source;
const constructorStart = workflow.indexOf('this.staticData = ObservableObject.create(');
const constructorEnd = workflow.indexOf('this.timezone =', constructorStart);
const methodStart = workflow.indexOf('getStaticData(type, node) {');
const methodEnd = workflow.indexOf('setTestStaticData(', methodStart);
assert.ok(constructorStart > 0 && constructorEnd > constructorStart && methodStart > 0 && methodEnd > methodStart);
const constructor = workflow.slice(constructorStart, constructorEnd);
const getter = workflow.slice(methodStart, methodEnd);
const projection = `class StaticGetter { constructor(parameters) { ${constructor} } ${getter} }; StaticGetter`;
const context = vm.createContext({ ObservableObject: Object.freeze({ create: (value) => value }), errors_1: Object.freeze({ UnexpectedError: Error }) });
const StaticGetter = new vm.Script(projection, { filename: 'captured-workflow-static-getter.js' }).runInContext(context, { timeout: 1000 });
const instance = new StaticGetter({ staticData: null });
const node = { id: 'performance-every-five-minutes', name: 'Every Five Minutes', typeVersion: 1.2 };
let registered = 0;
let emitted = 0;
const controller = {
  getNode: () => node,
  getNodeParameter: (name) => { assert.equal(name, 'rule'); return { interval: [{ field: 'minutes', minutesInterval: 5 }] }; },
  getTimezone: () => 'Australia/Melbourne',
  getWorkflowStaticData: (kind) => instance.getStaticData(kind, node),
  getWorkflow: () => ({ id: 'syntheticOwnedW1' }),
  getMode: () => 'trigger',
  emit: () => { emitted += 1; refuse(); },
  helpers: { registerCron: (cron, callback) => { assert.equal(typeof callback, 'function'); assert.match(cron.expression, /^\d+ \*\/5 \* \* \* \*$/); registered += 1; }, returnJsonArray: refuse },
};
return Promise.resolve(schedule.ScheduleTrigger.prototype.trigger.call(controller)).then(() => {
  const staticData = JSON.parse(JSON.stringify(instance.staticData));
  assert.equal(registered, 1);
  assert.equal(emitted, 0);
  assert.deepEqual(staticData, { 'node:Every Five Minutes': { recurrenceRules: [null], recurrenceRuleSignatures: [null] } });
  process.stdout.write(JSON.stringify({ staticData, registered, emitted, sources, projectionSha256: crypto.createHash('sha256').update(projection).digest('hex'), scope: 'captured-trigger-and-getter-only-inert-registration-not-native-provider-acceptance' }) + '\n');
});
}
main().catch((error) => { process.stderr.write(error.name + '\n'); process.exitCode = 1; });
