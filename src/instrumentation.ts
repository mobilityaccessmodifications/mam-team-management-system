export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const { assertSandboxEnvironment, installSandboxFetchGuard } = await import("./lib/sandbox-safety");
  assertSandboxEnvironment();
  installSandboxFetchGuard();
  const { installUatFetchGuard } = await import("./lib/uat-safety");
  installUatFetchGuard();
}
