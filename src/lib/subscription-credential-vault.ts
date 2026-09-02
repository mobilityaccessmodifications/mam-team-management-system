import "server-only";

import { Buffer } from "node:buffer";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

import type { SubscriptionCredentialDraft } from "@/lib/subscription-credential-types";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ENCODED_VALUE_PATTERN = /^[A-Za-z0-9_-]+$/;
const ENCODED_KEY_PATTERN = /^[A-Za-z0-9+/_-]+={0,2}$/;
const MAXIMUMS = {
  loginUrl: 2_048,
  username: 512,
  password: 4_096,
  recoveryCodes: 8_192,
  notes: 4_096,
} as const;

export type EncryptedSubscriptionCredential = {
  ciphertext: string;
  iv: string;
  authTag: string;
  keyVersion: number;
};

export class SubscriptionCredentialVaultConfigurationError extends Error {
  constructor() {
    super("The subscription credential vault is not configured.");
    this.name = "SubscriptionCredentialVaultConfigurationError";
  }
}

type VaultKey = {
  version: number;
  key: Buffer;
};

function readVersion(value: string | undefined, fallback: number | undefined) {
  const candidate = value?.trim() || (fallback === undefined ? "" : String(fallback));
  const parsed = Number(candidate);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 32_767) {
    throw new SubscriptionCredentialVaultConfigurationError();
  }
  return parsed;
}

function decodeKey(value: string | undefined) {
  const encoded = value?.trim() ?? "";
  if (!encoded || !ENCODED_KEY_PATTERN.test(encoded)) {
    throw new SubscriptionCredentialVaultConfigurationError();
  }

  const decoded = Buffer.from(
    encoded,
    encoded.includes("+") || encoded.includes("/") || encoded.includes("=") ? "base64" : "base64url",
  );
  if (decoded.length !== 32) throw new SubscriptionCredentialVaultConfigurationError();
  return decoded;
}

function configuredKeys() {
  const active: VaultKey = {
    version: readVersion(process.env.SUBSCRIPTION_CREDENTIAL_VAULT_KEY_VERSION, 1),
    key: decodeKey(process.env.SUBSCRIPTION_CREDENTIAL_VAULT_KEY),
  };
  const keys = new Map<number, Buffer>([[active.version, active.key]]);
  const previousKey = process.env.SUBSCRIPTION_CREDENTIAL_VAULT_PREVIOUS_KEY?.trim();
  const previousVersion = process.env.SUBSCRIPTION_CREDENTIAL_VAULT_PREVIOUS_KEY_VERSION?.trim();

  if (previousKey || previousVersion) {
    const version = readVersion(previousVersion, undefined);
    const key = decodeKey(previousKey);
    if (version === active.version) throw new SubscriptionCredentialVaultConfigurationError();
    keys.set(version, key);
  }

  return { active, keys };
}

function credentialAad(subscriptionId: string, keyVersion: number) {
  if (!UUID_PATTERN.test(subscriptionId) || !Number.isSafeInteger(keyVersion) || keyVersion < 1) {
    throw new Error("The subscription credential request is invalid.");
  }
  return Buffer.from(`mam:subscription-credential:${subscriptionId.toLowerCase()}:${keyVersion}`, "utf8");
}

function validatedEncodedValue(value: string, expectedLength?: number) {
  if (!ENCODED_VALUE_PATTERN.test(value)) throw new Error("The stored credential is invalid.");
  const decoded = Buffer.from(value, "base64url");
  if (expectedLength !== undefined && decoded.length !== expectedLength) {
    throw new Error("The stored credential is invalid.");
  }
  return decoded;
}

function textField(value: unknown, field: keyof typeof MAXIMUMS) {
  if (typeof value !== "string" || value.length > MAXIMUMS[field]) {
    throw new Error("The stored credential is invalid.");
  }
  return value;
}

function credentialPayload(value: unknown): SubscriptionCredentialDraft {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("The stored credential is invalid.");
  }
  const record = value as Record<string, unknown>;
  return {
    loginUrl: textField(record.loginUrl, "loginUrl"),
    username: textField(record.username, "username"),
    password: textField(record.password, "password"),
    recoveryCodes: textField(record.recoveryCodes, "recoveryCodes"),
    notes: textField(record.notes, "notes"),
  };
}

/** True only when the active server-only AES key is valid. */
export function isSubscriptionCredentialVaultConfigured() {
  try {
    configuredKeys();
    return true;
  } catch {
    return false;
  }
}

export function encryptSubscriptionCredential(
  subscriptionId: string,
  draft: SubscriptionCredentialDraft,
): EncryptedSubscriptionCredential {
  const payload = credentialPayload(draft);
  const { active } = configuredKeys();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", active.key, iv, { authTagLength: 16 });
  cipher.setAAD(credentialAad(subscriptionId, active.version));
  const plaintext = Buffer.from(JSON.stringify(payload), "utf8");
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);

  return {
    ciphertext: ciphertext.toString("base64url"),
    iv: iv.toString("base64url"),
    authTag: cipher.getAuthTag().toString("base64url"),
    keyVersion: active.version,
  };
}

export function decryptSubscriptionCredential(
  subscriptionId: string,
  encrypted: EncryptedSubscriptionCredential,
): SubscriptionCredentialDraft {
  if (!Number.isSafeInteger(encrypted.keyVersion) || encrypted.keyVersion < 1) {
    throw new Error("The stored credential is invalid.");
  }
  const { keys } = configuredKeys();
  const key = keys.get(encrypted.keyVersion);
  if (!key) throw new SubscriptionCredentialVaultConfigurationError();

  const decipher = createDecipheriv(
    "aes-256-gcm",
    key,
    validatedEncodedValue(encrypted.iv, 12),
    { authTagLength: 16 },
  );
  decipher.setAAD(credentialAad(subscriptionId, encrypted.keyVersion));
  decipher.setAuthTag(validatedEncodedValue(encrypted.authTag, 16));
  const plaintext = Buffer.concat([
    decipher.update(validatedEncodedValue(encrypted.ciphertext)),
    decipher.final(),
  ]);

  let decoded: unknown;
  try {
    decoded = JSON.parse(plaintext.toString("utf8"));
  } catch {
    throw new Error("The stored credential is invalid.");
  }
  return credentialPayload(decoded);
}
