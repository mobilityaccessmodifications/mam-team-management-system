import assert from "node:assert/strict";
import test from "node:test";
import bwipjs from "@bwip-js/browser";
import jsQR from "jsqr";
import { renderToStaticMarkup } from "react-dom/server";
import { loadAssetQrModule, loadAssetTestModule } from "./asset-qr-test-loader.mjs";

const qr = loadAssetQrModule();
const code = "MAM-IT-000001";
const url = `${qr.ASSET_QR_ORIGIN}/assets/${code}`;

test("QR labels and scanner preserve the exact asset number", () => {
  assert.equal(qr.assetQrUrl(code), url);
  assert.equal(qr.parseAssetQrCode(url), code);
  assert.equal(qr.parseAssetQrCode(` ${code} `), code);
  assert.equal(qr.parseAssetQrCode(`http://localhost:3000/assets/${code}`), code);
  assert.equal(qr.assetQrUrl(code, "http://localhost:3000"), `http://localhost:3000/assets/${code}`);
});

test("foreign, credentialed, malformed and non-device QR payloads cannot navigate", () => {
  for (const value of [
    "https://attacker.example/assets/" + code,
    "https://mam-team-management-system-ten.vercel.app.attacker.example/assets/" + code,
    "https://attacker@example.test/assets/" + code,
    "https://attacker@mam-team-management-system-ten.vercel.app/assets/" + code,
    "http://mam-team-management-system-ten.vercel.app/assets/" + code,
    "javascript:alert(1)", "data:text/html,test", "//attacker.example/assets/" + code,
    url + "?next=https://attacker.example", url + "#test", url + "/edit", url.replace(code, "%4DAM-IT-000001"),
    qr.ASSET_QR_ORIGIN + "/login", "MAM-IT-123", "MAM-IT-" + "1".repeat(100),
  ]) assert.equal(qr.parseAssetQrCode(value), null, value);
  assert.throws(() => qr.assetQrUrl(code, "https://attacker.example"));
  assert.throws(() => qr.assetQrUrl("../login"));
});

test("post-login destination is strictly limited to internal asset routes", () => {
  assert.equal(qr.assetLoginReturnPath(`/assets/${code}`), `/assets/${code}`);
  assert.equal(qr.assetLoginReturnPath("/assets/scan"), "/assets/scan");
  for (const value of [url, "//attacker.example", "/assets/../login", "/assets/scan?next=evil", "/assets/scan/", `/assets/${code}?x=1`, ["/assets/scan"], null, {}]) {
    assert.equal(qr.assetLoginReturnPath(value), null);
  }
});

test("unauthenticated asset links survive the proxy without carrying injected redirects", async () => {
  const { proxy } = loadAssetTestModule("src/proxy.ts", {
    "@/lib/asset-qr": qr,
    "@supabase/ssr": { createServerClient: () => ({ auth: { getClaims: async () => ({ data: { claims: null } }) } }) },
    "next/server": { NextResponse: { next: () => ({}), redirect: (destination) => destination } },
    "@/lib/supabase/config": { isSupabaseConfigured: () => true, requireSupabaseConfig: () => ({ supabaseUrl: "https://example.test", supabasePublishableKey: "synthetic" }) },
  });
  const pathname = `/assets/${code}`;
  const destination = await proxy({ nextUrl: { pathname, clone: () => new URL(`${url}?next=https://attacker.example`) }, cookies: { getAll: () => [] } });
  assert.equal(destination.pathname, "/login");
  assert.equal(destination.searchParams.get("next"), pathname);
  assert.deepEqual([...destination.searchParams.keys()], ["next"]);
});

test("the iOS-compatible pixel decoder reads the QR label format without native BarcodeDetector", () => {
  const [symbol] = bwipjs.raw({ bcid: "qrcode", text: url, eclevel: "M" });
  const scale = 5, quiet = 4;
  const width = (symbol.pixx + quiet * 2) * scale;
  const height = (symbol.pixy + quiet * 2) * scale;
  const pixels = new Uint8ClampedArray(width * height * 4).fill(255);
  for (let y = 0; y < symbol.pixy; y++) for (let x = 0; x < symbol.pixx; x++) {
    if (!symbol.pixs[y * symbol.pixx + x]) continue;
    for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) {
      const offset = (((y + quiet) * scale + dy) * width + (x + quiet) * scale + dx) * 4;
      pixels[offset] = pixels[offset + 1] = pixels[offset + 2] = 0;
    }
  }
  assert.equal(jsQR(pixels, width, height)?.data, url);
});

test("device pages require a verified active account before checking asset capability", async () => {
  for (const scenario of ["anonymous", "disabled", "account-error", "active", "admin"]) {
    const calls = [];
    const client = {
      auth: { getUser: async () => ({ data: { user: scenario === "anonymous" ? null : { id: "synthetic" } }, error: null }) },
      rpc: async (name) => {
        calls.push(name);
        if (name === "current_portal_account") return { data: [{ account_status: scenario === "disabled" ? "disabled" : "active" }], error: scenario === "account-error" ? {} : null };
        return { data: scenario === "admin", error: null };
      },
    };
    const { requireActiveAssetAccount } = loadAssetTestModule("src/lib/asset-page-access.ts", {
      "server-only": {}, "@/lib/asset-qr": qr,
      "next/navigation": { redirect: (path) => { throw Error(`redirect:${path}`); }, notFound: () => { throw Error("not-found"); } },
      "@/lib/supabase/config": { isSupabaseConfigured: () => true },
      "@/lib/supabase/server": { createClient: async () => client },
    });
    if (scenario === "anonymous") {
      await assert.rejects(requireActiveAssetAccount(`/assets/${code}`), /redirect:\/login\?next=%2Fassets%2FMAM-IT-000001/);
      assert.deepEqual(calls, []);
    } else if (["disabled", "account-error"].includes(scenario)) {
      await assert.rejects(requireActiveAssetAccount(`/assets/${code}`), /not-found/);
      assert.deepEqual(calls, ["current_portal_account"]);
    } else assert.deepEqual(await requireActiveAssetAccount(`/assets/${code}`), { canManageAssets: scenario === "admin" });
  }
});

test("device detail uses employee-own data unless asset administration is authorised", async () => {
  const selected = { assetCode: code, assetType: "laptop", manufacturer: "Synthetic", model: "Test", serialNumber: "SERIAL-TEST", status: "assigned" };
  for (const canManageAssets of [false, true]) {
    const calls = [];
    const { default: page } = loadAssetTestModule("src/app/assets/[assetCode]/page.tsx", {
      "@/lib/asset-qr": qr,
      "next/navigation": { notFound: () => { throw Error("not-found"); } },
      "next/link": { default: "a", __esModule: true },
      "@/lib/asset-page-access": { requireActiveAssetAccount: async () => ({ canManageAssets }) },
      "@/app/assets/actions": { listItAssets: async () => { calls.push("admin"); return [{ ...selected, assignedTo: { fullName: "Synthetic Custodian" } }, { ...selected, assetCode: "MAM-IT-000002", serialNumber: "OTHER-PRIVATE-SERIAL" }]; } },
      "@/app/assets/employee-actions": { listMyItAssets: async () => { calls.push("own"); return [selected]; } },
      "@/components/scan-asset-button": { ScanAssetButton: () => null },
      "../asset-page.module.css": {},
    });
    const html = renderToStaticMarkup(await page({ params: Promise.resolve({ assetCode: code }) }));
    assert.deepEqual(calls, [canManageAssets ? "admin" : "own"]);
    assert(html.includes("SERIAL-TEST"));
    assert(!html.includes("OTHER-PRIVATE-SERIAL"));
    assert.equal(html.includes("Synthetic Custodian"), canManageAssets);
    await assert.rejects(page({ params: Promise.resolve({ assetCode: "MAM-IT-999999" }) }), /not-found/);
  }
});
