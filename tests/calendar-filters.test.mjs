import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
const require = createRequire(import.meta.url);
const ts = require('typescript');
const loaded = { exports: {} };
new Function('exports', ts.transpileModule(readFileSync('src/lib/calendar-filters.ts','utf8'), {compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText)(loaded.exports);
const { calendarEventIsVisible: visible, calendarTeamOptions: options } = loaded.exports;
test('team selection filters leave without removing birthdays, check-ins or holidays', () => {
  assert.equal(visible('approved','MAM · Warehouse',[],['MAM · Warehouse']),false);
  assert.equal(visible('approved','Equipsy · Warehouse',[],['MAM · Warehouse']),true);
  for (const kind of ['birthday','check-in','public-holiday']) assert.equal(visible(kind,undefined,[],['MAM · Warehouse']),true);
});
test('event types and team choices combine and can hide every event', () => {
  assert.equal(visible('pending','MAM · Operations',['pending'],[]),false);
  assert.equal(visible('approved','MAM · Operations',['pending'],[]),true);
  assert.equal(visible('birthday',undefined,['birthday'],[]),false);
  assert.equal(visible('approved','MAM · Operations',['approved'],['MAM · Operations']),false);
});
test('team choices come only from authorised input, deduplicate and distinguish companies', () => {
  assert.deepEqual(options([{team:'MAM · Warehouse'},{team:'Equipsy · Warehouse'},{team:'MAM · Warehouse'}]),['Equipsy · Warehouse','MAM · Warehouse']);
  assert.deepEqual(options([]),[]);
});
test('status, leave type and team filters combine without hiding non-leave events', () => {
  assert.equal(visible('approved','MAM · Minor',[],[], 'Sick leave',['Sick leave']),false);
  assert.equal(visible('pending','MAM · Minor',[],[], 'Annual leave',['Sick leave']),true);
  assert.equal(visible('pending','MAM · Minor',['pending'],[], 'Annual leave',[]),false);
  assert.equal(visible('birthday',undefined,[],[],undefined,['Sick leave']),true);
});
