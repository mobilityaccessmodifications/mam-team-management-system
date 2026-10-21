import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import os from 'node:os';
import {realpathSync} from 'node:fs';

const env={PATH:process.env.PATH,TMPDIR:realpathSync(os.tmpdir()),LANG:'C',LC_ALL:'C',MAM_PERFORMANCE_TEST_EVIDENCE:process.env.MAM_PERFORMANCE_TEST_EVIDENCE};
for(const binary of ['initdb','pg_ctl','postgres','psql','pg_dump','createdb','python3','git']){
 const result=spawnSync(binary,['--version'],{env,encoding:'utf8'});
 assert.equal(result.status,0,`${binary} must be supplied on PATH: ${result.error?.message??result.stderr}`);
 if(binary==='psql') assert.match(result.stdout,/\(PostgreSQL\) 17\./,'Performance release-helper native gate requires PostgreSQL 17');
}
const result=spawnSync(process.execPath,['--test','tests/performance-review-production-sql.native.mjs','tests/performance-review-production-envelope.native.mjs','tests/performance-review-completion.native.mjs','tests/performance-review-completion-envelope.native.mjs','tests/performance-review-completion-races.native.mjs','tests/performance-review-completion-release.native.mjs','tests/performance-review-notifications.native.mjs','tests/performance-review-preview.native.mjs','tests/performance-review-delegation.native.mjs','tests/performance-review-admin.native.mjs','tests/performance-review-careers-cc.native.mjs','tests/performance-review-meeting.native.mjs','tests/performance-review-invitation-status.native.mjs','tests/performance-review-invitation-routing.native.mjs','tests/performance-review-self-submitted-manager.native.mjs','tests/performance-review-manager-mail.native.mjs','tests/performance-review-goals-final.native.mjs'],{env,stdio:'inherit'});
assert.equal(result.status,0,'Native performance feature/release gate failed');
