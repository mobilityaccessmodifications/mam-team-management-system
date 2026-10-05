import type { NextConfig } from "next";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { assertSandboxEnvironment } from "./src/lib/sandbox-safety";

const projectRoot = dirname(fileURLToPath(import.meta.url));

assertSandboxEnvironment();

const nextConfig: NextConfig = {
  outputFileTracingIncludes: {
    "/api/internal/payroll/runtime-capability": ["./src/server/payroll/runtime-capability/assets/*"],
  },
  async headers() {
    return [{
      source: "/:path*",
      headers: [
        { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
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
