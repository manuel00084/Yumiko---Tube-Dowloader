// Descarga y caché de los modelos de super-resolución en el navegador.
// El modelo ligero va incluido en la extensión; el grande se cachea la primera vez.

export const AI_MODELS = {
  light: {
    key: 'light',
    label: 'IA ligera (sub-pixel CNN x3)',
    detail: 'Incluida · 240 KB · instantánea · canal Y',
    file: 'models/super-resolution-10.onnx',
    url: 'https://huggingface.co/onnxmodelzoo/super-resolution-10/resolve/main/super-resolution-10.onnx',
    approxBytes: 245000,
    scale: 3,
    tile: 224,
    mode: 'y',
    bundled: true,
  },
  x4: {
    key: 'x4',
    label: 'Real-ESRGAN x4',
    detail: 'Se descarga 1 vez (67 MB) · máxima calidad',
    file: 'models/real_esrgan_x4.onnx',
    url: 'https://huggingface.co/SceneWorks/real-esrgan-onnx/resolve/main/real_esrgan_x4.onnx',
    approxBytes: 67051616,
    scale: 4,
    tile: 192,
    mode: 'rgb',
    bundled: false,
  },
};

const CACHE_NAME = 'yumiko-thumbs-models';

function cache() {
  return caches.open(CACHE_NAME);
}

export async function isModelCached(key) {
  if (!caches) return false;
  const hit = await (await cache()).match(AI_MODELS[key].url);
  return Boolean(hit);
}

export async function clearModelCache() {
  if (!caches) return;
  await caches.delete(CACHE_NAME);
}

export async function getModelBytes(key, onProgress) {
  const model = AI_MODELS[key];
  if (!model) throw new Error(`modelo desconocido: ${key}`);

  if (model.bundled) {
    onProgress?.({ phase: 'incluido', loaded: 0, total: model.approxBytes });
    const response = await fetch(chrome.runtime.getURL(model.file));
    if (!response.ok) {
      throw new Error(
        `Falta ${model.file}. Ejecuta "node tools/fetch-model.mjs light" para descargarlo.`,
      );
    }
    const buffer = await response.arrayBuffer();
    onProgress?.({ phase: 'incluido', loaded: buffer.byteLength, total: buffer.byteLength });
    return buffer;
  }

  const store = await cache();
  const cached = await store.match(model.url);
  if (cached) {
    const buffer = await cached.arrayBuffer();
    onProgress?.({ phase: 'cache', loaded: buffer.byteLength, total: buffer.byteLength });
    return buffer;
  }

  onProgress?.({ phase: 'descargando', loaded: 0, total: model.approxBytes });
  const response = await fetch(model.url, { mode: 'cors' });
  if (!response.ok || !response.body) throw new Error(`No se pudo descargar el modelo (${response.status})`);

  const reader = response.body.getReader();
  const chunks = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.byteLength;
    onProgress?.({ phase: 'descargando', loaded, total: Number(response.headers.get('content-length')) || model.approxBytes });
  }

  const buffer = new Uint8Array(loaded);
  let offset = 0;
  for (const chunk of chunks) {
    buffer.set(chunk, offset);
    offset += chunk.length;
  }
  await store.put(model.url, new Response(buffer, { headers: { 'content-type': 'application/octet-stream' } }));
  return buffer.buffer;
}