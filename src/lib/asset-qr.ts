export const ASSET_QR_ORIGIN = "https://mam-team-management-system-ten.vercel.app";
const ASSET_CODE = /^MAM-IT-\d{6,}$/;

export function isAssetCode(value: string): boolean {
  return value.length <= 64 && ASSET_CODE.test(value);
}

function allowedOrigin(url: URL): boolean {
  return url.origin === ASSET_QR_ORIGIN
    || ((url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]")
      && (url.protocol === "http:" || url.protocol === "https:"));
}

export function assetQrPath(assetCode: string): string {
  if (!isAssetCode(assetCode)) throw new Error("Invalid asset number.");
  return `/assets/${assetCode}`;
}

/** Labels carry an opaque asset number, never hardware or employee details. */
export function assetQrUrl(assetCode: string, origin = ASSET_QR_ORIGIN): string {
  const url = new URL(origin);
  if (!allowedOrigin(url) || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("Invalid asset label origin.");
  }
  return `${url.origin}${assetQrPath(assetCode)}`;
}

/** Only returns an asset number. Callers navigate to a newly built local path. */
export function parseAssetQrCode(value: string): string | null {
  const input = value.trim();
  if (isAssetCode(input)) return input;
  if (input.length > 512 || !/^https?:\/\//.test(input)) return null;
  try {
    const url = new URL(input);
    if (!allowedOrigin(url) || url.username || url.password || url.search || url.hash) return null;
    const code = url.pathname.slice("/assets/".length);
    return url.pathname.startsWith("/assets/") && isAssetCode(code) ? code : null;
  } catch {
    return null;
  }
}

/** Login can return only to these exact internal routes, never an arbitrary URL. */
export function assetLoginReturnPath(value: unknown): string | null {
  if (value === "/assets/scan") return value;
  if (typeof value !== "string" || !value.startsWith("/assets/")) return null;
  const code = value.slice("/assets/".length);
  return isAssetCode(code) ? assetQrPath(code) : null;
}
