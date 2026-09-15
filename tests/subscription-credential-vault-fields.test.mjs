import assert from "node:assert/strict";
import { createCipheriv } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const loaded = { exports: {} };
const source = ts.transpileModule(
  readFileSync("src/lib/subscription-credential-vault.ts", "utf8"),
  {
    compilerOptions: {
      esModuleInterop: true,
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  },
).outputText;

function testRequire(id) {
  if (id === "server-only") return {};
  return require(id);
}

new Function("require", "module", "exports", source)(testRequire, loaded, loaded.exports);
const { decryptSubscriptionCredential, encryptSubscriptionCredential } = loaded.exports;
const subscriptionId = "30000000-0000-4000-8000-000000000001";
const key = Buffer.alloc(32, 7);

function withVaultEnvironment(callback) {
  const previousKey = process.env.SUBSCRIPTION_CREDENTIAL_VAULT_KEY;
  const previousVersion = process.env.SUBSCRIPTION_CREDENTIAL_VAULT_KEY_VERSION;
  process.env.SUBSCRIPTION_CREDENTIAL_VAULT_KEY = key.toString("base64url");
  process.env.SUBSCRIPTION_CREDENTIAL_VAULT_KEY_VERSION = "1";
  try {
    return callback();
  } finally {
    if (previousKey === undefined) delete process.env.SUBSCRIPTION_CREDENTIAL_VAULT_KEY;
    else process.env.SUBSCRIPTION_CREDENTIAL_VAULT_KEY = previousKey;
    if (previousVersion === undefined) delete process.env.SUBSCRIPTION_CREDENTIAL_VAULT_KEY_VERSION;
    else process.env.SUBSCRIPTION_CREDENTIAL_VAULT_KEY_VERSION = previousVersion;
  }
}

test("encrypts and authenticates every subscription login field", () => withVaultEnvironment(() => {
  const draft = {
    loginUrl: "https://service.example.test/login",
    accountEmail: "billing@example.test",
    username: "team-account",
    password: " password with intentional spaces ",
    mfaDetails: "Authenticator held by the synthetic administrator",
    recoveryCodes: "code-one\ncode-two",
    licenceKey: "SYNTHETIC-LICENCE-KEY",
    notes: "Synthetic operational note",
  };
  const encrypted = encryptSubscriptionCredential(subscriptionId, draft);
  assert.match(encrypted.ciphertext, /^[A-Za-z0-9_-]+$/);
  assert.deepEqual(decryptSubscriptionCredential(subscriptionId, encrypted), draft);
  assert.throws(
    () => decryptSubscriptionCredential("30000000-0000-4000-8000-000000000002", encrypted),
    /stored credential is invalid/i,
  );
}));

test("keeps the largest accepted credential payload within the database ciphertext limit", () => withVaultEnvironment(() => {
  const encrypted = encryptSubscriptionCredential(subscriptionId, {
    loginUrl: "x".repeat(2_048),
    accountEmail: "e".repeat(512),
    username: "u".repeat(512),
    password: "p".repeat(4_096),
    mfaDetails: "m".repeat(2_048),
    recoveryCodes: "r".repeat(8_192),
    licenceKey: "l".repeat(2_048),
    notes: "n".repeat(4_096),
  });
  assert.ok(encrypted.ciphertext.length <= 32_768);
}));

test("decrypts legacy vault records with the new fields empty", () => withVaultEnvironment(() => {
  const legacy = {
    loginUrl: "https://legacy.example.test/",
    username: "legacy-user",
    password: "legacy-password",
    recoveryCodes: "legacy-code",
    notes: "n".repeat(4_096),
  };
  const iv = Buffer.alloc(12, 3);
  const cipher = createCipheriv("aes-256-gcm", key, iv, { authTagLength: 16 });
  cipher.setAAD(Buffer.from(`mam:subscription-credential:${subscriptionId}:1`, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(legacy), "utf8"), cipher.final()]);
  const decrypted = decryptSubscriptionCredential(subscriptionId, {
    ciphertext: ciphertext.toString("base64url"),
    iv: iv.toString("base64url"),
    authTag: cipher.getAuthTag().toString("base64url"),
    keyVersion: 1,
  });
  assert.deepEqual(decrypted, {
    ...legacy,
    accountEmail: "",
    mfaDetails: "",
    licenceKey: "",
  });
}));

test("rejects a multibyte payload before it can exceed the database ciphertext limit", () => withVaultEnvironment(() => {
  assert.throws(() => encryptSubscriptionCredential(subscriptionId, {
    loginUrl: "x".repeat(2_048),
    accountEmail: "界".repeat(512),
    username: "界".repeat(512),
    password: "界".repeat(4_096),
    mfaDetails: "界".repeat(2_048),
    recoveryCodes: "界".repeat(8_192),
    licenceKey: "界".repeat(2_048),
    notes: "界".repeat(4_096),
  }), /details are too large/i);
}));
