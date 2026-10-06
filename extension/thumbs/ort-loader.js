// Carga perezosa de onnxruntime-web. Sólo se trae cuando el usuario elige el
// modo IA, así que el resto de la extensión no carga 27 MB de WebAssembly.

let ortPromise = null;
let sessionCache = new Map();

export async function getOrt() {
  if (!ortPromise) {
    ortPromise = (async () => {
      const ort = await import(chrome.runtime.getURL('vendor/ort/ort.webgpu.min.mjs'));
      ort.env.wasm.wasmPaths = chrome.runtime.getURL('vendor/ort/');
      ort.env.wasm.numThreads = 1;
      ort.env.wasm.proxy = false;
      ort.env.logLevel = 'error';
      return ort;
    })();
  }
  return ortPromise;
}

export async function webgpuAvailable() {
  return typeof navigator !== 'undefined' && Boolean(navigator.gpu);
}

export async function getSession(modelKey, modelBytes, { onStatus, preferWebGpu = true } = {}) {
  const cached = sessionCache.get(modelKey);
  if (cached) return cached;

  const ort = await getOrt();
  const providers = [];
  if (preferWebGpu && navigator.gpu) {
    try {
      providers.push('webgpu');
    } catch {
      /* sigue con wasm */
    }
  }
  providers.push('wasm');

  const options = {
    executionProviders: providers,
    graphOptimizationLevel: 'all',
    enableCpuMemArena: false,
    wasm: { numThreads: 1 },
  };

  const session = await ort.InferenceSession.create(modelBytes, options);
  sessionCache.set(modelKey, { session, ort, providers: session.handler?.executionProviders || providers });

  if (!sessionCache.get(modelKey).providers.includes('webgpu')) {
    onStatus?.('Aviso: WebGPU no disponible, se usa WebAssembly (más lento).');
  }
  return sessionCache.get(modelKey);
}

export async function disposeSessions() {
  for (const { session } of sessionCache.values()) {
    try {
      await session.release?.();
    } catch {
      /* ignorar */
    }
  }
  sessionCache = new Map();
}

export function activeBackend(modelKey) {
  const entry = sessionCache.get(modelKey);
  if (!entry) return null;
  return entry.providers.find((p) => p === 'webgpu') || 'wasm';
}