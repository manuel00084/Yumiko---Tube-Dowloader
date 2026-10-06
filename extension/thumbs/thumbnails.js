// Catálogo de miniaturas que YouTube expone en i.ytimg.com para cada vídeo.
// Ninguna de estas rutas está garantizada: todas se sondean en tiempo real y se
// muestran solo las que existen realmente, con su resolución exacta.

export const GROUPS = [
  {
    id: 'oar',
    title: 'Originales (OAR)',
    hint: 'Recorte nativo de YouTube. Cuando existe suele ser la de mayor resolución.',
    items: ['oar2', 'oar1', 'oar3'],
  },
  {
    id: 'maxres',
    title: 'Máxima resolución',
    items: ['maxresdefault', 'hq720', 'maxres1', 'maxres2', 'maxres3'],
  },
  {
    id: 'sd',
    title: 'Alta definición (SD)',
    items: ['sddefault', 'sd1', 'sd2', 'sd3'],
  },
  {
    id: 'hq',
    title: 'Calidad media (HQ)',
    items: ['hqdefault', 'hq1', 'hq2', 'hq3'],
  },
  {
    id: 'mq',
    title: 'Baja (MQ)',
    items: ['mqdefault', 'mq1', 'mq2', 'mq3'],
  },
  {
    id: 'low',
    title: 'Muy baja',
    items: ['default', '0', '1', '2', '3'],
  },
];

export const LABELS = {
  oar1: 'OAR 1',
  oar2: 'OAR 2',
  oar3: 'OAR 3',
  maxresdefault: 'maxresdefault',
  hq720: 'hq720',
  maxres1: 'frame maxres 1',
  maxres2: 'frame maxres 2',
  maxres3: 'frame maxres 3',
  sddefault: 'sddefault',
  sd1: 'frame sd 1',
  sd2: 'frame sd 2',
  sd3: 'frame sd 3',
  hqdefault: 'hqdefault',
  hq1: 'frame hq 1',
  hq2: 'frame hq 2',
  hq3: 'frame hq 3',
  mqdefault: 'mqdefault',
  mq1: 'frame mq 1',
  mq2: 'frame mq 2',
  mq3: 'frame mq 3',
  default: 'default',
  0: 'recorte 0',
  1: 'recorte 1',
  2: 'recorte 2',
  3: 'recorte 3',
};

export const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;

export function extractVideoId(url) {
  if (!url) return null;
  const fromPath = String(url).match(/\/(?:embed|shorts|live|v)\/([A-Za-z0-9_-]{11})/);
  if (fromPath) return fromPath[1];
  const fromQuery = String(url).match(/[?&]v=([A-Za-z0-9_-]{11})/);
  if (fromQuery) return fromQuery[1];
  return null;
}

export function thumbnailUrl(videoId, name, host = 'https://i.ytimg.com/vi') {
  return `${host}/${videoId}/${name}.jpg`;
}

export function buildCandidateList(videoId) {
  const out = [];
  for (const group of GROUPS) {
    for (const name of group.items) {
      out.push({
        key: `${group.id}:${name}`,
        groupId: group.id,
        groupTitle: group.title,
        hint: group.hint || '',
        name,
        label: LABELS[name] || name,
        url: thumbnailUrl(videoId, name),
      });
    }
  }
  return out;
}

// Descarga en paralelo controlado y descarta las rutas que no existen (404).
// i.ytimg.com responde con Access-Control-Allow-Origin: *, así que se puede
// leer en un canvas sin tocar la imagen de la web.
export async function probeCandidates(candidates, { limit = 6, signal, retries = 1 } = {}) {
  const results = [];
  let cursor = 0;

  const worker = async () => {
    for (;;) {
      const index = cursor++;
      if (index >= candidates.length) return;
      if (signal?.aborted) return;
      const candidate = candidates[index];
      try {
        const probe = await probeImage(candidate.url, { signal, retries });
        if (!probe) continue;
        if (probe.width < 40 || probe.height < 40) continue;
        results.push({ ...candidate, ...probe, pixels: probe.width * probe.height });
      } catch (error) {
        // 404 y errores de red se ignoran: la tarjeta simplemente no aparece.
        if (error?.name === 'AbortError') return;
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(limit, candidates.length) }, worker));
  results.sort((a, b) => (b.pixels || 0) - (a.pixels || 0));
  return results;
}

export async function fetchImage(url, { signal } = {}) {
  const response = await fetch(url, { signal, cache: 'force-cache' });
  if (!response.ok) return null;
  const blob = await response.blob();
  if (!blob.size) return null;
  const bitmap = await createImageBitmap(blob);
  return {
    blob,
    width: bitmap.width,
    height: bitmap.height,
    type: blob.type || 'image/jpeg',
    release: () => bitmap.close?.(),
    bitmap,
  };
}

// Solo lee el tamaño: el bitmap se cierra enseguida y el blob se conserva para
// no volver a golpear la red cuando se procese la imagen.
// Devuelve null si la ruta no existe; reintenta los errores transitorios.
export async function probeImage(url, { signal, retries = 1 } = {}) {
  let lastError = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    if (attempt > 0) await sleep(400 * attempt, signal);
    let response;
    try {
      response = await fetch(url, { signal, cache: 'force-cache' });
    } catch (error) {
      if (error?.name === 'AbortError') throw error;
      lastError = error;
      continue;
    }
    // 404 y 410 significan que esa variante no existe para este vídeo.
    if (response.status === 404 || response.status === 410) return null;
    if (!response.ok) {
      lastError = new Error(`HTTP ${response.status}`);
      continue;
    }
    const blob = await response.blob();
    if (!blob.size) return null;
    const bitmap = await createImageBitmap(blob);
    const size = { width: bitmap.width, height: bitmap.height, bytes: blob.size };
    bitmap.close?.();
    return { ...size, blob, type: blob.type || 'image/jpeg' };
  }
  throw lastError || new Error('no se pudo leer la miniatura');
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(Object.assign(new Error('cancelado'), { name: 'AbortError' }));
      },
      { once: true },
    );
  });
}