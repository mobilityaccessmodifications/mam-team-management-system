import "server-only";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import vm from "node:vm";
import { spawnSync } from "node:child_process";

const ROUTE = "/api/internal/payroll/runtime-capability";
const LOCK_SHA256 = "7290162ab5564a5513816c916ee08bbd739bd4f8b49a053126c794b2d4561f6a";
const FILES = ["marker.json", "python-capability.py"];
const sha = (bytes: Buffer | string) => crypto.createHash("sha256").update(bytes).digest("hex");

function readFixedAssets() {
  const root = path.resolve(process.cwd(), "src/server/payroll/runtime-capability/assets");
  const relativeRoot = path.relative(process.cwd(), root);
  for (let count = 1; count <= relativeRoot.split(path.sep).length; count++) {
    const segment = path.resolve(/* turbopackIgnore: true */ process.cwd(), ...relativeRoot.split(path.sep).slice(0, count));
    if (fs.lstatSync(segment).isSymbolicLink()) throw Error("ASSET_DENIED");
  }
  if (fs.realpathSync(root) !== root) throw Error("ASSET_DENIED");
  const read = (name: string) => {
    const absolute = path.resolve(root, name);
    if (path.dirname(absolute) !== root || fs.lstatSync(absolute).isSymbolicLink()) throw Error("ASSET_DENIED");
    const fd = fs.openSync(absolute, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      if (!fs.fstatSync(fd).isFile() || fs.fstatSync(fd).size > 32768) throw Error("ASSET_DENIED");
      return fs.readFileSync(fd);
    } finally { fs.closeSync(fd); }
  };
  const lockBytes = read("lock.safe.json");
  if (sha(lockBytes) !== LOCK_SHA256) throw Error("ASSET_DENIED");
  const lock = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(lockBytes));
  if (lock.schema !== "mam-fixed-capability-lock/v1" || !Array.isArray(lock.files) || lock.files.length !== FILES.length) throw Error("ASSET_DENIED");
  const snapshots = new Map<string, Buffer>();
  for (let index = 0; index < FILES.length; index++) {
    const row = lock.files[index];
    if (row.path !== FILES[index] || !Number.isSafeInteger(row.bytes) || !/^[0-9a-f]{64}$/.test(row.sha256)) throw Error("ASSET_DENIED");
    const bytes = read(row.path);
    if (bytes.length !== row.bytes || sha(bytes) !== row.sha256) throw Error("ASSET_DENIED");
    snapshots.set(row.path, bytes);
  }
  return snapshots;
}

async function inspectVM() {
  const available = typeof vm.SourceTextModule === "function";
  if (!available) return { sourceTextModuleAvailable: false, linkedEvaluationPassed: false };
  try {
    const context = vm.createContext({});
    const dependency = new vm.SyntheticModule(["createHash"], function () {
      this.setExport("createHash", crypto.createHash);
    }, { context });
    const entry = new vm.SourceTextModule('import { createHash } from "node:crypto"; export const digest = createHash("sha256").update("fixed-public-capability").digest("hex");', { context });
    await entry.link(specifier => {
      if (specifier !== "node:crypto") throw Error("FIXED_VM_IMPORT_DENIED");
      return dependency;
    });
    await entry.evaluate({ timeout: 500 });
    return { sourceTextModuleAvailable: true, linkedEvaluationPassed: Reflect.get(entry.namespace, "digest") === sha("fixed-public-capability") };
  } catch { return { sourceTextModuleAvailable: true, linkedEvaluationPassed: false }; }
}

function inspectPython(source: Buffer) {
  const executable = ["/usr/bin/python3", "/var/lang/bin/python3"].find(value => {
    try { return fs.statSync(value).isFile(); } catch { return false; }
  });
  if (!executable) return { status: "NOT_FOUND", completeInterpreterAndSharedLibraryClosureProven: false };
  const launcher = `import base64\nexec(compile(base64.b64decode(${JSON.stringify(source.toString("base64"))}),"<locked-capability-probe>","exec"))\n`;
  const child = spawnSync(executable, ["-I", "-S", "-B", "-c", launcher], {
    encoding: "utf8", maxBuffer: 262144, timeout: 3000,
    cwd: process.cwd(), env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8", NODE_ENV: "production" }, shell: false,
  });
  if (child.status !== 0 || child.error) return { status: "NOT_COMPATIBLE", errorCode: child.error && "code" in child.error ? String(child.error.code) : null, exitCode: child.status, stderrSHA256: sha(child.stderr || ""), completeInterpreterAndSharedLibraryClosureProven: false };
  try {
    const report = JSON.parse(child.stdout);
    if (!Array.isArray(report.version) || report.version.length !== 3 || !report.version.every((value: unknown) => Number.isSafeInteger(value))
      || report.implementation !== "CPython" || !["arm64", "aarch64", "x86_64", "AMD64"].includes(report.machine)
      || !Number.isSafeInteger(report.moduleCount) || !/^[0-9a-f]{64}$/.test(report.moduleDigestSHA256)
      || !/^[0-9a-f]{64}$/.test(report.executableSHA256Observed)) throw Error("PYTHON_REPORT_DENIED");
    return {
      status: "OBSERVED", completeInterpreterAndSharedLibraryClosureProven: false,
      report: {
        version: report.version, implementation: report.implementation, machine: report.machine,
        requiredImportsPassed: report.requiredImportsPassed === true,
        selectedStdlibOperationsPassed: report.selectedStdlibOperationsPassed === true,
        isolated: report.isolated === true, siteDisabled: report.siteDisabled === true,
        bytecodeDisabled: report.bytecodeDisabled === true,
        foreignFileModules: Number.isSafeInteger(report.foreignFileModules) ? report.foreignFileModules : null,
        moduleCount: report.moduleCount, moduleDigestSHA256: report.moduleDigestSHA256,
        executableSHA256Observed: report.executableSHA256Observed,
      },
    };
  } catch { return { status: "REPORT_DENIED", completeInterpreterAndSharedLibraryClosureProven: false }; }
}

export async function runtimeCapabilityGET(request: Request): Promise<Response> {
  if (arguments.length !== 1 || !(request instanceof Request) || request.method !== "GET" || process.env.VERCEL_ENV !== "preview"
    || process.env.MAM_PAYROLL_RUNTIME_PROBE !== "capability-v1") {
    return Response.json({ enabled: false }, { status: 404 });
  }
  const url = new URL(request.url);
  if (url.pathname !== ROUTE || url.search || url.hash || request.body !== null
    || request.headers.has("transfer-encoding")
    || (request.headers.has("content-length") && request.headers.get("content-length") !== "0")
    || request.headers.has("cookie") || request.headers.has("authorization") || request.signal.aborted) {
    return Response.json({ enabled: false }, { status: 404 });
  }
  try {
    const assets = readFixedAssets();
    const source = assets.get("python-capability.py")!;
    const features = await inspectVM();
    if (request.signal.aborted) return Response.json({ enabled: false }, { status: 404 });
    const python = inspectPython(source);
    return Response.json({
      schema: "mam-runtime-capability/v1", enabled: true,
      platform: process.platform, architecture: process.arch, nodeVersion: process.version,
      nodeEnvironmentFlagAllowed: process.allowedNodeEnvironmentFlags.has("--experimental-vm-modules"),
      vm: features, python,
      assets: { lockSHA256: LOCK_SHA256, markerSHA256: sha(assets.get("marker.json")!), pythonSourceSHA256: sha(source), sameLockedBufferPythonExecution: true },
      effects: { auth: 0, claim: 0, rpc: 0, business: 0 }, cloudRuntimeAdopted: false,
    }, { headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" } });
  } catch { return Response.json({ enabled: true, status: "ASSET_DENIED" }, { status: 503 }); }
}
