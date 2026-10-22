import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import { loadPortalLoginModule } from "./portal-login-test-loader.mjs";
import { loadAssetQrModule } from "./asset-qr-test-loader.mjs";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const login = loadPortalLoginModule();

test("email sign-in accepts company, personal and long addresses, with legacy admin compatibility", () => {
  for (const value of ["person@company.example", "person+home@personal.example", "x".repeat(64)+"@company.example"]) {
    assert.equal(login.isPortalLoginEmail(value), true, value);
    assert.equal(login.isValidPortalLogin(value), true, value);
  }
  for (const value of ["admin", "system_admin", "awaiting.email"]) {
    assert.equal(login.isValidPortalLogin(value), true);
    assert.equal(login.isPortalLoginEmail(value), false);
  }
  assert.equal(login.normalisePortalLogin(" Person@Company.Example "), "person@company.example");
});

test("malformed and oversized login emails are rejected", () => {
  for (const value of ["", "two@@company.example", ".first@company.example", "first..last@company.example", "first.@company.example", "first last@company.example", "person@-company.example", "x".repeat(65)+"@company.example", "person@"+"x".repeat(64)+".example"]) {
    assert.equal(login.isPortalLoginEmail(value), false, value);
  }
});

function loadSignIn({ allowed=true, resolved="opaque@accounts.example", accountStatus="active" }={}) {
  const calls = [];
  const admin = { async rpc(name,args) {
    calls.push([name,args]);
    if (name === "claim_portal_login_attempt") return { data:allowed,error:null };
    if (name === "resolve_portal_login_auth_email") return { data:resolved,error:null };
    return { data:true,error:null };
  } };
  const client = {
    auth: {
      async signInWithPassword(input) {
        calls.push(["password",input]);
        return input.email === "opaque@accounts.example"
          ? {data:{user:{id:"synthetic-user"},session:{}},error:null}
          : {data:{user:null,session:null},error:{message:"invalid"}};
      },
      async signOut() { calls.push(["signOut"]); },
    },
    async rpc() { return {data:[{account_status:accountStatus}],error:null}; },
  };
  const source = ts.transpileModule(readFileSync("src/app/login/actions.ts","utf8"), {
    compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022},
  }).outputText;
  const moduleUnderTest = {exports:{}};
  new Function("require","module","exports",source)((id) => {
    if (id==="@/lib/portal-login") return login;
    if (id==="@/lib/asset-qr") return loadAssetQrModule();
    if (id==="next/headers") return {headers:async()=>new Headers({"x-real-ip":"192.0.2.1"})};
    if (id==="next/navigation") return {redirect:(url)=>{throw new Error("redirect:"+url);}};
    if (id==="@/lib/supabase/config") return {isSupabaseConfigured:()=>true};
    if (id==="@/lib/supabase/admin") return {createAdminClient:()=>admin};
    if (id==="@/lib/supabase/server") return {createClient:async()=>client};
    return require(id);
  },moduleUnderTest,moduleUnderTest.exports);
  const submit = async (username, next = "") => {
    const form = new FormData();
    form.set("username",username);
    form.set("password","Synthetic-password-123!");
    form.set("next",next);
    return moduleUnderTest.exports.signIn({status:"idle",message:""},form);
  };
  return {submit,calls};
}

test("normalised email resolves privately before password authentication", async () => {
  const {submit,calls}=loadSignIn();
  await assert.rejects(submit(" Person@Company.Example "),/redirect:\//);
  assert.equal(calls.find(([name])=>name==="resolve_portal_login_auth_email")[1].p_login_name,"person@company.example");
  assert.equal(calls.find(([name])=>name==="password")[1].email,"opaque@accounts.example");
  assert(calls.some(([name])=>name==="clear_portal_login_rate_limit"));
});

test("administrator username retains the existing sign-in path", async () => {
  const {submit,calls}=loadSignIn();
  await assert.rejects(submit("admin"),/redirect:\//);
  assert.equal(calls.find(([name])=>name==="resolve_portal_login_auth_email")[1].p_login_name,"admin");
});

test("employee username and email use the same password and retain the shared source limit", async () => {
  const identifiers = ["staff.member", "staff.member@company.example"];
  const sources = [];
  for (const identifier of identifiers) {
    const {submit,calls}=loadSignIn();
    await assert.rejects(submit(identifier),/^Error: redirect:\/$/);
    assert.deepEqual(calls.find(([name])=>name==='password')[1],{email:'opaque@accounts.example',password:'Synthetic-password-123!'});
    sources.push(calls.find(([name])=>name==='claim_portal_login_attempt')[1].p_source_hash);
    const blocked=loadSignIn({allowed:false});
    assert.equal((await blocked.submit(identifier)).status,'error');
    assert.equal(blocked.calls.find(([name])=>name==='password')[1].email,'invalid-portal-login@invalid.example');
  }
  assert.equal(sources[0],sources[1]);
});

test("sign-in returns to the scanned device while rejecting external destinations", async () => {
  for (const next of ["/assets/MAM-IT-000001", "/assets/scan"]) {
    await assert.rejects(loadSignIn().submit("admin", next), new RegExp(`^Error: redirect:${next}$`));
  }
  for (const next of ["https://attacker.example", "//attacker.example", "/assets/scan?next=evil"]) {
    await assert.rejects(loadSignIn().submit("admin", next), /^Error: redirect:\/$/);
  }
});

test("performance notification sign-in returns only to the exact allowlisted destination", async () => {
  const path = '/?view=people&tab=performance';
  await assert.rejects(loadSignIn().submit('admin', path), error => error.message === 'redirect:' + path);
  for (const next of [path + '&next=https://attacker.example', 'https://attacker.example' + path, path + '#other']) {
    await assert.rejects(loadSignIn().submit('admin', next), error => error.message === 'redirect:/');
  }
});

test("unknown email and rate-limited account fail identically through dummy authentication", async () => {
  const unknown=loadSignIn({resolved:null});
  const limited=loadSignIn({allowed:false});
  const [a,b]=await Promise.all([unknown.submit("unknown@company.example"),limited.submit("person@company.example")]);
  assert.deepEqual(a,b);
  assert.equal(a.status,"error");
  for (const {calls} of [unknown,limited]) {
    assert.equal(calls.find(([name])=>name==="password")[1].email,"invalid-portal-login@invalid.example");
    assert(!calls.some(([name])=>name==="clear_portal_login_rate_limit"));
  }
});
