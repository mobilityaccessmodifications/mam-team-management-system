import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {unzipSync} from 'fflate';
import {blankBytes,download,parityCases,sourceSize} from './performance-review-completion-word-fixture.mjs';

test('SQL constants derive from the complete unchanged canonical stored ZIP and template bytes',()=>{
 const pins={'src/lib/performance-review-word.mjs':'b0486a433a1e6abdb40ad0082004d4296aa3d075f870d5ee920397257109b56a','src/lib/performance-review-questions.mjs':'9af2edc812ec465fe14a4d865e68606cee04d4fb122c5dcbf0ba9b94ebcdf561'};
 for(const [file,pin]of Object.entries(pins))assert.equal(createHash('sha256').update(readFileSync(file)).digest('hex'),pin);
 const sql=readFileSync('supabase/migrations/20261017103000_performance_review_completion_guards.sql','utf8');
 for(const company of ['MAM','Equipsy']) {
  const bytes=blankBytes(company);const parts=unzipSync(bytes);
  assert.deepEqual(Object.keys(parts),['[Content_Types].xml','_rels/.rels','word/document.xml','word/_rels/document.xml.rels','word/styles.xml']);
  const overhead=Object.keys(parts).reduce((n,name)=>n+30+46+2*Buffer.byteLength(name),22);
  assert.equal(bytes.length,Object.values(parts).reduce((n,b)=>n+b.length,overhead));
  assert.ok(sql.includes(company==='MAM'?`then ${bytes.length} else`:`else ${bytes.length} end`));
 }
 assert.match(sql,/\+39::bigint/);assert.match(sql,/\+40::bigint/);
});
test('complete source-derived byte model equals real canonical renderer for all field placements and limits',()=>{
 const cases=parityCases();assert.ok(cases.length>100);
 for(const {label,document}of cases)assert.equal(sourceSize(document),download(document).bytes.length,label);
});
