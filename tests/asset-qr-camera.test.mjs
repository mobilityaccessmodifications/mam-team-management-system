import assert from "node:assert/strict";
import test from "node:test";
import { loadAssetQrModule, loadAssetTestModule } from "./asset-qr-test-loader.mjs";

function scannerHarness(t, { media, decode = () => null }) {
  const originals = new Map();
  const install = (key, value) => {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  };
  const frames = new Map();
  let nextFrame = 1;
  const document = Object.assign(new EventTarget(), {
    hidden: false,
    createElement: () => ({ getContext: () => ({ drawImage() {}, getImageData: () => ({ data: new Uint8ClampedArray(4), width: 1, height: 1 }) }) }),
  });
  install("document", document);
  install("window", Object.assign(new EventTarget(), { isSecureContext: true }));
  install("navigator", { mediaDevices: { getUserMedia: media } });
  install("HTMLMediaElement", { HAVE_CURRENT_DATA: 2 });
  install("requestAnimationFrame", (callback) => { const id = nextFrame++; frames.set(id, callback); return id; });
  install("cancelAnimationFrame", (id) => frames.delete(id));
  const slots = [], cleanups = new Map();
  let cursor = 0, pending = [];
  const hooks = {
    useState(initial) {
      const i = cursor++;
      if (!(i in slots)) slots[i] = initial;
      return [slots[i], (value) => { slots[i] = typeof value === "function" ? value(slots[i]) : value; }];
    },
    useRef(initial) { const i = cursor++; return slots[i] ??= { current: initial }; },
    useCallback(callback, dependencies) {
      const i = cursor++;
      if (!slots[i] || dependencies.some((value, index) => value !== slots[i].dependencies[index])) slots[i] = { callback, dependencies };
      return slots[i].callback;
    },
    useEffect(callback, dependencies) {
      const i = cursor++;
      if (!slots[i] || dependencies.some((value, index) => value !== slots[i][index])) {
        pending.push(() => { cleanups.get(i)?.(); cleanups.set(i, callback()); });
        slots[i] = dependencies;
      }
    },
  };
  const destinations = [];
  const router = { push: (path) => destinations.push(path) };
  const { AssetQrScanner } = loadAssetTestModule("src/components/asset-qr-scanner.tsx", {
    react: hooks, "next/navigation": { useRouter: () => router },
    "@/lib/asset-qr": loadAssetQrModule(), "@/app/assets/asset-page.module.css": {},
    jsqr: { __esModule: true, default: decode },
  });
  const video = { play: async () => {}, pause() {}, srcObject: null, readyState: 2, videoWidth: 640, videoHeight: 480 };
  function elements(node) {
    if (!node || typeof node !== "object") return [];
    return [node, ...[node.props?.children].flat(Infinity).flatMap(elements)];
  }
  function render() {
    cursor = 0;
    const tree = AssetQrScanner();
    elements(tree).find((node) => node.type === "video").props.ref.current = video;
    const effects = pending; pending = [];
    effects.forEach((effect) => effect());
    return elements(tree);
  }
  function unmount() { cleanups.forEach((cleanup) => cleanup?.()); cleanups.clear(); }
  t.after(() => {
    unmount();
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  });
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  async function start() {
    render().find((node) => node.type === "button" && node.props.type === "button").props.onClick();
    render();
    await flush();
  }
  return { render, start, unmount, flush, video, frames, destinations, document };
}

function cameraStream() {
  let stops = 0;
  const track = Object.assign(new EventTarget(), { stop: () => { stops++; } });
  return { stream: { getTracks: () => [track] }, stopped: () => stops };
}

test("late camera permission after navigation stops the acquired stream immediately", async (t) => {
  let grant;
  const camera = cameraStream();
  const app = scannerHarness(t, { media: () => new Promise((resolve) => { grant = resolve; }) });
  await app.start();
  app.unmount();
  grant(camera.stream);
  await app.flush();
  assert.equal(camera.stopped(), 1);
  assert.equal(app.video.srcObject, null);
  assert.equal(app.frames.size, 0);
});

test("valid scanning stops the camera and opens only a reconstructed local asset path", async (t) => {
  const camera = cameraStream();
  const app = scannerHarness(t, { media: async (constraints) => {
    assert.equal(constraints.audio, false);
    assert.equal(constraints.video.facingMode.ideal, "environment");
    return camera.stream;
  }, decode: () => ({ data: "https://mam-team-management-system-ten.vercel.app/assets/MAM-IT-000001" }) });
  await app.start();
  [...app.frames.values()][0](200);
  assert.deepEqual(app.destinations, ["/assets/MAM-IT-000001"]);
  assert.equal(camera.stopped(), 1);
  assert.equal(app.video.srcObject, null);
});

test("a foreign QR cannot navigate and hiding the page releases the camera", async (t) => {
  const camera = cameraStream();
  const app = scannerHarness(t, { media: async () => camera.stream, decode: () => ({ data: "https://attacker.example/assets/MAM-IT-000001" }) });
  await app.start();
  [...app.frames.values()][0](200);
  assert.deepEqual(app.destinations, []);
  assert.equal(camera.stopped(), 0);
  app.document.hidden = true;
  app.document.dispatchEvent(new Event("visibilitychange"));
  assert.equal(camera.stopped(), 1);
  assert.equal(app.video.srcObject, null);
});

test("decoder failures release camera tracks without navigating", async (t) => {
  const camera = cameraStream();
  const app = scannerHarness(t, { media: async () => camera.stream, decode: () => { throw Error("read failure"); } });
  await app.start();
  [...app.frames.values()][0](200);
  assert.equal(camera.stopped(), 1);
  assert.equal(app.video.srcObject, null);
  assert.deepEqual(app.destinations, []);
});

test("camera denial keeps manual device lookup usable", async (t) => {
  const app = scannerHarness(t, { media: async () => { throw Object.assign(new Error("denied"), { name: "NotAllowedError" }); } });
  await app.start();
  const elements = app.render();
  assert.match(elements.find((node) => node.props?.role === "status").props.children, /Allow camera access/);
  elements.find((node) => node.type === "input").props.onChange({ target: { value: "MAM-IT-000001" } });
  app.render().find((node) => node.type === "form").props.onSubmit({ preventDefault() {} });
  assert.deepEqual(app.destinations, ["/assets/MAM-IT-000001"]);
});
