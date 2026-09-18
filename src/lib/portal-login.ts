const LEGACY_LOGIN_PATTERN = /^[a-z0-9][a-z0-9._-]{2,63}$/;
const EMAIL_PATTERN = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

export function normalisePortalLogin(value: string) {
  return value.trim().toLowerCase();
}

export function isPortalLoginEmail(value: string) {
  const localPart = value.split("@")[0];
  return value.length <= 254
    && localPart.length <= 64
    && !localPart.startsWith(".")
    && !localPart.endsWith(".")
    && !localPart.includes("..")
    && EMAIL_PATTERN.test(value);
}

export function isValidPortalLogin(value: string) {
  // Existing administrator usernames and an employee awaiting an email remain
  // usable. The server-only registry decides which identities actually exist.
  return isPortalLoginEmail(value) || LEGACY_LOGIN_PATTERN.test(value);
}
