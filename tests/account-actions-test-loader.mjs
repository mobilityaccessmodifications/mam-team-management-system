import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { loadPortalLoginModule } from "./portal-login-test-loader.mjs";

const require = createRequire(import.meta.url);
const ts = require("typescript");

export function loadAccountActions(admin, client, entry = "src/app/accounts/actions.ts") {
  function load(path) {
    const source = ts.transpileModule(readFileSync(path, "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    const target = { exports: {} };
    new Function("require", "module", "exports", source)((id) => {
      if (id === "server-only") return {};
      if (id === "next/cache") return { revalidatePath() {} };
      if (id === "@/lib/supabase/admin") return { createAdminClient: () => admin };
      if (id === "@/lib/supabase/server") return { createClient: async () => client };
      if (id === "@/lib/portal-login") return loadPortalLoginModule();
      if (id === "@/lib/portal-account-status") return load("src/lib/portal-account-status.ts");
      return require(id);
    }, target, target.exports);
    return target.exports;
  }
  return load(entry);
}
