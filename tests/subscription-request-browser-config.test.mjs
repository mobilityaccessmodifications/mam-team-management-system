import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';

test('Requests browser output stays task-owned when CI does not define TMPDIR',()=>{
  const output=mkdtempSync(path.join(tmpdir(),'mam-sr-config-'));
  try {
    const env={...process.env,MAM_SR_ORIGIN:'http://127.0.0.1:18080',MAM_SR_OUTPUT_DIR:output};
    delete env.TMPDIR;
    const url=pathToFileURL(path.resolve('tests/subscription-requests-playwright.config.mjs')).href;
    const child=spawnSync(process.execPath,['--input-type=module','-e',`const {default:config}=await import(${JSON.stringify(url)});console.log(JSON.stringify(config.outputDir));`],{env,encoding:'utf8',timeout:10000});
    assert.equal(child.status,0,child.stderr);
    assert.equal(JSON.parse(child.stdout),output,'CI must not write reports beneath the root-owned checkout');
  } finally {rmSync(output,{recursive:true,force:true});}
});
