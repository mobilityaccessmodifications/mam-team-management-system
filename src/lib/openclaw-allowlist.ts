import "server-only";
import { createHash, timingSafeEqual } from "node:crypto";
import { getCountries, parsePhoneNumberFromString, type CountryCode } from "libphonenumber-js/max";

const secretPattern = /^[A-Za-z0-9_-]{43,128}$/;

export function allowlistAuthorization(request: Request, secret: string | undefined) {
  // Provision 32 random bytes encoded as base64url; never a human password.
  if (!secret || !secretPattern.test(secret)) return 503;
  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer ([A-Za-z0-9_-]{43,128})$/i.exec(header);
  if (!match) return 401;
  const hash = (value: string) => createHash("sha256").update(value).digest();
  return timingSafeEqual(hash(match[1]), hash(secret)) ? 200 : 401;
}

const countryLabels = new Intl.DisplayNames(["en"], { type: "region" });
const countries = new Map<string, CountryCode>();
for (const code of getCountries()) {
  countries.set(code.toLowerCase(), code);
  countries.set(countryLabels.of(code)!.toLowerCase(), code);
}
for (const [alias, code] of Object.entries({ uk: "GB", usa: "US", uae: "AE", "viet nam": "VN", "south korea": "KR" })) {
  countries.set(alias, code as CountryCode);
}

/** Numbering-plan validation, not proof of ownership or WhatsApp registration. */
export function normalizeAllowlistPhone(value: string | null, country: string | null = null): string | null {
  if (!value || value.length > 64) return null;
  // MAM's approved domestic default applies ONLY when the source country is
  // blank. An unrecognised country never falls back silently to Australia.
  const label = country?.trim().toLowerCase();
  const region = label ? countries.get(label) : "AU";
  let input = value.normalize("NFKC").trim();
  // No extraction from prose, extension, list, slash, newline or multiple '+'
  // numbers. Formatting punctuation and balanced parentheses are harmless.
  if (!/^\+?[0-9 ().-]+$/.test(input)) return null;
  let depth = 0;
  for (const char of input) {
    if (char === "(" && ++depth > 1) return null;
    if (char === ")" && --depth < 0) return null;
  }
  if (depth !== 0) return null;
  input = input.replace(/[ ().-]/g, "");
  if (region === "AU" && input.startsWith("0011")) input = "+" + input.slice(4);
  else if (input.startsWith("00")) input = "+" + input.slice(2);
  if (!input.startsWith("+") && !region) return null;
  const phone = parsePhoneNumberFromString(input, { defaultCountry: region, extract: false });
  if (!phone?.isValid() || phone.ext) return null;
  // Don't let a country-local dial string implicitly resolve to another region.
  if (!input.startsWith("+") && phone.country !== region) return null;
  return /^\+[1-9][0-9]{7,14}$/.test(phone.number) ? phone.number : null;
}

export function allowlistSnapshot(data: unknown, generatedAt: string) {
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("Invalid snapshot");
  const snapshot = data as Record<string, unknown>;
  if (snapshot.complete !== true || snapshot.schemaVersion !== 2 ||
      !Array.isArray(snapshot.contacts) || snapshot.contacts.length > 10000 ||
      snapshot.rowCount !== snapshot.contacts.length ||
      Object.keys(snapshot).sort().join(",") !== "complete,contacts,rowCount,schemaVersion") {
    throw new Error("Incomplete snapshot");
  }
  const counts = new Map<string, number>();
  for (const raw of snapshot.contacts) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw) ||
        Object.keys(raw).sort().join(",") !== "country,phone" ||
        (raw.phone !== null && typeof raw.phone !== "string") ||
        (raw.country !== null && (typeof raw.country !== "string" || raw.country.length > 100))) {
      throw new Error("Invalid snapshot row");
    }
    const phone = normalizeAllowlistPhone(raw.phone, raw.country);
    if (phone) counts.set(phone, (counts.get(phone) ?? 0) + 1);
  }
  // Defense in depth: SQL now returns only unique, independently enrolled
  // identities. Never dedupe an ambiguous response into an authorization.
  const phones = [...counts].filter(([, count]) => count === 1).map(([phone]) => phone).sort();
  const schemaVersion = 1;
  const digest = createHash("sha256").update(JSON.stringify({ schemaVersion, phones })).digest("hex");
  return { schemaVersion, generatedAt, digest, phones };
}
