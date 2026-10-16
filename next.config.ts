import type { NextConfig } from "next";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { assertSandboxEnvironment } from "./src/lib/sandbox-safety";
import { assertUatEnvironment, isUatMode, UAT_API_ORIGIN } from "./src/lib/uat-safety";

const projectRoot = dirname(fileURLToPath(import.meta.url));

assertSandboxEnvironment();
assertUatEnvironment(process.env, { buildOnly: true });

const uat = isUatMode();
const contentSecurityPolicy = uat ? [
  "default-src 'self'", "script-src 'self' 'unsafe-inline'", "style-src 'self' 'unsafe-inline'",
  `img-src 'self' data: blob: ${UAT_API_ORIGIN}`, "font-src 'self' data:",
  `connect-src 'self' ${UAT_API_ORIGIN} ${UAT_API_ORIGIN.replace('https:', 'wss:')}`,
  "worker-src 'self' blob:", "form-action 'self'", "frame-ancestors 'none'",
  "object-src 'none'", "base-uri 'self'",
].join("; ") : "frame-ancestors 'none'";

const nextConfig: NextConfig = {
  ...(uat ? { output: "standalone" } : {}),
  async headers() {
    return [{
      source: "/:path*",
      headers: [
        { key: "Content-Security-Policy", value: contentSecurityPolicy },
        { key: "X-Frame-Options", value: "DENY" },
        { key: "X-Content-Type-Options", value: "nosniff" },
      ],
    }];
  },
  turbopack: {
    root: projectRoot,
  },
};

export default nextConfig;
