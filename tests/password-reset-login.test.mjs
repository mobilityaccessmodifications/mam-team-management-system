import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import test from 'node:test';
import ts from 'typescript';

const require = createRequire(import.meta.url);
function load(file, dependencies = {}) {
  const loaded = {exports:{}};
  const code = ts.transpileModule(readFileSync(file,'utf8'),{
    compilerOptions:{esModuleInterop:true,jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022},
  }).outputText;
  new Function('require','module','exports',code)(id=>dependencies[id]??require(id),loaded,loaded.exports);
  return loaded.exports;
}
const recovery = load('src/lib/password-recovery.ts');
const login = load('src/lib/portal-login.ts');
const { LoginForm } = load('src/components/login-form.tsx',{
  '@/app/login/actions':{signIn:async()=>({status:'idle',message:''})},
  'next/link':{__esModule:true,default:({children,...props})=>createElement('a',props,children)},
});
function pageFixture(value) {
  let cookieReads = 0;
  const {default:Page} = load('src/app/login/page.tsx',{
    '@/components/brand-mark':{BrandMark:()=>null},
    '@/components/login-form':{LoginForm},
    '@/lib/asset-qr':{assetLoginReturnPath:()=>null},
    '@/lib/password-recovery':recovery,
    '@/lib/portal-login':login,
    'next/headers':{cookies:async()=>({get:name=>{cookieReads++;assert.equal(name,recovery.PASSWORD_RECOVERY_LOGIN_COOKIE);return value===undefined?undefined:{value};}})},
  });
  return {async html(params={}){return renderToStaticMarkup(await Page({searchParams:Promise.resolve(params)}));},get cookieReads(){return cookieReads;}};
}
test('recovery landing fills the current registered email instead of the obsolete username',async()=>{
  const f=pageFixture('current@company.example');
  const html=await f.html({password:'reset',login:'obsolete.username'});
  assert.match(html,/<input[^>]*id="username"[^>]*value="current@company.example"/);
  assert.doesNotMatch(html,/obsolete\.username/);
  assert.match(html,/Your password has been reset/);
  assert.equal(f.cookieReads,1);
});
test('ordinary login and invalid recovery hints do not prefill an identifier',async()=>{
  const ordinary=pageFixture('current@company.example');
  assert.doesNotMatch(await ordinary.html(),/value="current@company.example"/);
  assert.equal(ordinary.cookieReads,0);
  for(const value of [undefined,'invalid login','person@example.test\" autofocus','x'.repeat(255)]){
    assert.match(await pageFixture(value).html({password:'reset'}),/<input[^>]*id="username"[^>]*value=""/);
  }
});
test('existing standalone administrator usernames remain valid recovery hints',async()=>{
  assert.match(await pageFixture('system_admin').html({password:'reset'}),/<input[^>]*id="username"[^>]*value="system_admin"/);
});
