import assert from 'node:assert/strict';
import {readdirSync} from 'node:fs';
import test from 'node:test';

const directory=new URL('../supabase/migrations/',import.meta.url);

test('migration versions are unique across the integrated source',()=>{
  const files=readdirSync(directory).filter(file=>file.endsWith('.sql')).sort();
  const versions=files.map(file=>{
    const match=/^([0-9]{14})_[a-z0-9_]+\.sql$/.exec(file);
    assert.ok(match,'Malformed migration filename: '+file);
    return match[1];
  });
  const duplicates=versions.filter((version,index)=>versions.indexOf(version)!==index);
  assert.deepEqual(duplicates,[],'Published and unpublished migrations must not share a version');
});
