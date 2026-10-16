import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtempSync,readFileSync,readdirSync,rmSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

test('pure production helper runs with portable temporary Git and missing private Mac directories',()=>{
 const directory=mkdtempSync(path.join(os.tmpdir(),'pr-unit-'));
 try{
  const code=`import os,runpy,sys,tempfile\noriginal=tempfile.mkdtemp\ndef owned(*args,**kwargs):\n directory=str(kwargs.get('dir',''))\n assert not directory or os.path.commonpath([os.path.realpath(directory),os.path.realpath(tempfile.gettempdir())]) == os.path.realpath(tempfile.gettempdir()), 'missing-private-Mac-directory sentinel'\n return original(*args,**kwargs)\ntempfile.mkdtemp=owned\nsys.argv=['tests/performance-review-production-helper-cli.py','inspect']\nrunpy.run_path(sys.argv[0],run_name='__main__')`;
  const result=spawnSync('python3',['-B','-c',code],{env:{PATH:'/usr/bin:/bin',TMPDIR:directory,LANG:'C',LC_ALL:'C'},encoding:'utf8',timeout:30000});
  assert.equal(result.status,0,result.stderr);
  const receipt=JSON.parse(result.stdout);
  assert.equal(receipt.classification,'MODEL_CLI_INERT_MANAGEMENT_REAL_GIT');
  assert.equal(receipt.counts.mutationDispatches,0);
 }finally{rmSync(directory,{recursive:true,force:true});}
});

test('standard unit discovery excludes native PostgreSQL fixture suites',()=>{
 const native=readdirSync('tests').filter(name=>name.endsWith('.test.mjs')&&name.startsWith('performance-review-production-')&&/^import .*ownedCluster.* from/m.test(readFileSync(path.join('tests',name),'utf8')));
 assert.deepEqual(native,[]);
});

test('native production gate is supplied explicitly in PG17 CI without removing PG16 replay',()=>{
 const workflow=readFileSync('.github/workflows/ci.yml','utf8');
 const manifest=JSON.parse(readFileSync('package.json','utf8'));
 assert.equal(manifest.scripts['test:sql:performance'],'node scripts/test-performance-review-production.mjs');
 assert.match(workflow,/postgres: \['16', '17'\]/);
 assert.match(workflow,/if:.*matrix\.postgres == '17'/);
 assert.match(workflow,/npm run test:sql:performance/);
});
