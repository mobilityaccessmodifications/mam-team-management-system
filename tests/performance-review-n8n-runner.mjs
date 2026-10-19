import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const cryptoOnly = name => {assert.equal(name, 'crypto'); return require('node:crypto');};
export async function executeGraph(workflow, trigger, input, http) {
  const nodes = new Map(workflow.nodes.map(n => [n.name, n]));
  const outputs = {};
  const entered = [];
  let name = trigger; let value = input;
  while (name) {
    assert.ok(entered.length < 32, 'finite acyclic graph');
    const n = nodes.get(name); assert.ok(n, `connection target ${name}`); entered.push(name);
    const lookup = key => ({first: () => ({json: outputs[key]})});
    let branch = 0;
    if (n.type === 'n8n-nodes-base.code') {
      const fn = new Function('$json', '$input', '$', 'require', n.parameters.jsCode);
      value = fn(value, {all: () => [{json: value}], first: () => ({json: value})}, lookup, cryptoOnly)[0].json;
    } else if (n.type === 'n8n-nodes-base.if') {
      const c = n.parameters.conditions;
      assert.equal(c.options.typeValidation, 'strict'); assert.equal(c.combinator, 'and');
      assert.equal(c.conditions.length, 1);
      const condition = c.conditions[0]; assert.deepEqual(condition.operator, {type: 'boolean', operation: 'true', singleValue: true});
      const expression = condition.leftValue.match(/^=\{\{\s*(.*?)\s*\}\}$/s); assert.ok(expression);
      const selected = new Function('$json', '$', `return (${expression[1]});`)(value, lookup);
      branch = selected === true ? 0 : 1;
    } else if (n.type === 'n8n-nodes-base.httpRequest') {
      let body;
      if (n.parameters.sendBody) {
        const expression = n.parameters.jsonBody.match(/^=\{\{\s*(.*?)\s*\}\}$/s); assert.ok(expression);
        body = new Function('$json', '$', `return (${expression[1]});`)(value, lookup);
        if (typeof body === 'string') body = JSON.parse(body);
      }
      try {value = await http(n, body);} catch {assert.equal(n.onError, 'continueRegularOutput'); value = {error: 'SYNTHETIC_TRANSPORT'};}
    } else assert.ok(['n8n-nodes-base.webhook', 'n8n-nodes-base.scheduleTrigger'].includes(n.type), n.type);
    outputs[name] = value;
    const edges = workflow.connections[name]?.main?.[branch] ?? [];
    assert.ok(edges.length <= 1, 'one dispatch path');
    name = edges[0]?.node;
  }
  return {value, entered, outputs};
}
