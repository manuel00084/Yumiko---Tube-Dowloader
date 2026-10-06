// Super-resolución con redes neuronales (ONNX Runtime Web).
//
// Dos modos de preprocesado:
//   'y'   -> sub-pixel CNN sobre el canal Y (modelo ligero incluido)
//   'rgb' -> RRDBNet completo de Real-ESRGAN sobre RGB

import { getModelBytes, AI_MODELS } from './model-store.js';
import { getSession, webgpuAvailable, activeBackend } from './ort-loader.js';

const MAX_OUTPUT_PIXELS = 24_000_000;

function reflectExtend(source, width, height, x0 = 0, y0 = 0) {
  // Copia una ventana de `width` x `height` a partir de (x0, y0) en
  // coordenadas de origen, reflejando en los bordes. x0/y0 pueden ser negativos
  // para que los mosaicos del borde sigan teniendo su margen de contexto.
  const out = new Float32Array(width * height * source.channels);
  for (let y = 0; y < height; y += 1) {
    const sy = reflectIndex(y + y0, source.height);
    for (let x = 0; x < width; x += 1) {
      const sx = reflectIndex(x + x0, source.width);
      const so = (sy * source.width + sx) * source.channels;
      const o = (y * width + x) * source.channels;
      for (let c = 0; c < source.channels; c += 1) out[o + c] = source.data[so + c];
    }
  }
  return out;
}

function reflectIndex(index, length) {
  if (length === 1) return 0;
  const period = 2 * length - 2;
  let i = index % period;
  if (i < 0) i += period;
  return i < length ? i : period - i;
}

function lumaFromRgb(data) {
  const count = data.length / 4;
  const y = new Float32Array(count);
  for (let i = 0; i < count; i += 1) {
    const o = i * 4;
    y[i] = (0.299 * data[o] + 0.587 * data[o + 1] + 0.114 * data[o + 2]) / 255;
  }
  return y;
}

function rgbPlanes(data) {
  const count = data.length / 4;
  const planes = new Float32Array(count * 3);
  for (let i = 0; i < count; i += 1) {
    const o = i * 4;
    planes[i * 3] = data[o] / 255;
    planes[i * 3 + 1] = data[o + 1] / 255;
    planes[i * 3 + 2] = data[o + 2] / 255;
  }
  return planes;
}

function chromaFromRgb(data) {
  const count = data.length / 4;
  const cb = new Float32Array(count);
  const cr = new Float32Array(count);
  for (let i = 0; i < count; i += 1) {
    const o = i * 4;
    const r = data[o];
    const g = data[o + 1];
    const b = data[o + 2];
    cb[i] = (-0.168736 * r - 0.331264 * g + 0.5 * b + 128) / 255;
    cr[i] = (0.5 * r - 0.418688 * g - 0.081312 * b + 128) / 255;
  }
  return { cb, cr };
}

function clamp255(value) {
  const v = value * 255;
  return v < 0 ? 0 : v > 255 ? 255 : v;
}

function tiles(total, size, overlap) {
  if (total <= size) return [{ start: 0, size: total }];
  const stride = Math.max(1, size - overlap);
  const list = [];
  let start = 0;
  while (start < total) {
    const length = Math.min(size, total - start);
    list.push({ start, size: length });
    if (start + length >= total) break;
    start += stride;
  }
  return list;
}

function featherWeights(length, overlap, isFirst, isLast) {
  const weights = new Float32Array(length);
  for (let i = 0; i < length; i += 1) {
    let w = 1;
    if (!isFirst) w = Math.min(w, (i + 1) / overlap);
    if (!isLast) w = Math.min(w, (length - i) / overlap);
    weights[i] = Math.max(1e-4, w);
  }
  return weights;
}

async function runOnce(ort, session, tensor) {
  const feeds = { [session.inputNames[0]]: tensor };
  const output = await session.run(feeds);
  return output[session.outputNames[0]];
}

// --- modo Y: núcleo que solo trabaja la luminancia -------------------------
async function upscaleLuma({ ort, session, model, imageData, onProgress, onStatus }) {
  const margin = 8;
  const core = model.tile - margin * 2;
  const scale = model.scale;
  const width = imageData.width;
  const height = imageData.height;
  const outW = width * scale;
  const outH = height * scale;
  if (outW * outH > MAX_OUTPUT_PIXELS) {
    throw new Error(
      `La salida sería de ${outW}x${outH} px, demasiado grande para la GPU. Baja el factor o usa Lanczos.`,
    );
  }

  // El paso entre mosaicos es el núcleo entero: el margen de contexto hace que
  // las ventanas de entrada se solapen, y así solo se copia la parte central.
  const rows = tiles(height, core, 0);
  const cols = tiles(width, core, 0);
  const total = rows.length * cols.length;
  const source = { data: lumaFromRgb(imageData.data), width, height, channels: 1 };
  const out = new Uint8ClampedArray(outW * outH * 4);
  const outTile = model.tile * scale;
  let done = 0;

  for (const row of rows) {
    for (const col of cols) {
      const patch = reflectExtend(source, model.tile, model.tile, col.start - margin, row.start - margin);
      const tensor = new ort.Tensor('float32', patch, [1, 1, model.tile, model.tile]);
      const result = await runOnce(ort, session, tensor);
      const values = result.data;

      // La salida del modelo viene ya escalada: se copia el núcleo entero
      // píxel a píxel, avanzando de uno en uno.
      const px = margin * scale;
      const copyH = Math.min(core * scale, outH - row.start * scale);
      const copyW = Math.min(core * scale, outW - col.start * scale);
      for (let y = 0; y < copyH; y += 1) {
        const srcRow = (px + y) * outTile;
        const dstRow = (row.start * scale + y) * outW + col.start * scale;
        for (let x = 0; x < copyW; x += 1) {
          out[(dstRow + x) * 4] = clamp255(values[srcRow + px + x]);
        }
      }
      done += 1;
      onProgress?.({ phase: 'ia', ratio: done / total });
    }
  }

  const upscaled = new ImageData(out, outW, outH);
  const { cb, cr } = chromaFromRgb(imageData.data);
  mergeChroma(upscaled.data, outW, outH, [cb, cr], width, height);
  if (total > 1) onStatus?.(`IA: ${total} mosaicos de ${model.tile}x${model.tile} px con solapamiento.`);
  return upscaled;
}

// Bicúbico con las claves de Keys.
function bicubic(t) {
  const x = Math.abs(t);
  if (x < 1) return (1.5 * x - 2.5) * x * x + 1;
  if (x < 2) return ((-0.5 * x + 2.5) * x - 4) * x + 2;
  return 0;
}

// Tabla de pesos por índice de destino, normalizada para conservar la media.
function buildTaps(srcLen, dstLen) {
  const ratio = srcLen / dstLen;
  const table = new Array(dstLen);
  for (let i = 0; i < dstLen; i += 1) {
    const center = (i + 0.5) * ratio - 0.5;
    const first = Math.max(0, Math.floor(center - 2));
    const last = Math.min(srcLen - 1, Math.ceil(center + 2));
    const count = last - first + 1;
    const idx = new Int32Array(count);
    const w = new Float32Array(count);
    let sum = 0;
    for (let k = 0; k < count; k += 1) {
      idx[k] = first + k;
      w[k] = bicubic(center - (first + k));
      sum += w[k];
    }
    if (sum !== 0) for (let k = 0; k < count; k += 1) w[k] /= sum;
    table[i] = { idx, w };
  }
  return table;
}

// Reescala Cb/Cr a la salida y recompone YCbCr sobre la luminancia ya mejorada.
// Separable en dos pasadas y con buffers de una sola fila, para no reservar
// memoria proporcional al tamaño final.
function mergeChroma(target, outW, outH, chroma, width, height) {
  const tapsX = buildTaps(width, outW);
  const tapsY = buildTaps(height, outH);
  const vert = chroma.map(() => new Float32Array(width));
  const rowCb = new Float32Array(outW);
  const rowCr = new Float32Array(outW);
  const half = 128 / 255;

  for (let y = 0; y < outH; y += 1) {
    const taps = tapsY[y];
    const count = taps.idx.length;
    for (let p = 0; p < chroma.length; p += 1) {
      const src = chroma[p];
      const dst = vert[p];
      for (let x = 0; x < width; x += 1) {
        let value = 0;
        for (let k = 0; k < count; k += 1) value += src[taps.idx[k] * width + x] * taps.w[k];
        dst[x] = value;
      }
    }
    for (let X = 0; X < outW; X += 1) {
      const t = tapsX[X];
      const n = t.idx.length;
      let a = 0;
      let b = 0;
      for (let k = 0; k < n; k += 1) {
        const weight = t.w[k];
        a += vert[0][t.idx[k]] * weight;
        b += vert[1][t.idx[k]] * weight;
      }
      rowCb[X] = a;
      rowCr[X] = b;
    }
    const base = y * outW * 4;
    for (let X = 0; X < outW; X += 1) {
      // El canal R guarda la luminancia mejorada en bytes 0..255.
      const luma = target[base + X * 4] / 255;
      const cb = rowCb[X] - half;
      const cr = rowCr[X] - half;
      const o = base + X * 4;
      target[o] = clamp255(luma + 1.402 * cr);
      target[o + 1] = clamp255(luma - 0.344136 * cb - 0.714136 * cr);
      target[o + 2] = clamp255(luma + 1.772 * cb);
      target[o + 3] = 255;
    }
  }
}

// --- modo RGB: RRDBNet con mosaicos y mezcla de solapamiento --------------
async function upscaleRgb({ ort, session, model, imageData, onProgress, onStatus }) {
  const width = imageData.width;
  const height = imageData.height;
  const scale = model.scale;
  const outW = width * scale;
  const outH = height * scale;
  if (outW * outH > MAX_OUTPUT_PIXELS) {
    throw new Error(
      `La salida sería de ${outW}x${outH} px, demasiado grande para la GPU. Baja el factor o usa Lanczos.`,
    );
  }

  const overlap = 16;
  const tile = Math.max(32, model.tile);
  const cols = tiles(width, tile, overlap);
  const rows = tiles(height, tile, overlap);
  const total = rows.length * cols.length;

  const sum = new Float32Array(outW * outH * 3);
  const weight = new Float32Array(outW * outH);
  const planes = rgbPlanes(imageData.data);
  const source = { data: planes, width, height, channels: 3 };

  let done = 0;
  for (let r = 0; r < rows.length; r += 1) {
    const row = rows[r];
    for (let c = 0; c < cols.length; c += 1) {
      const col = cols[c];
      const patch = reflectExtend(source, tile, tile, col.start, row.start);
      const tensor = new ort.Tensor('float32', patch, [1, 3, tile, tile]);
      const result = await runOnce(ort, session, tensor);
      const values = result.data;

      const wx = featherWeights(col.size, overlap, c === 0, c === cols.length - 1);
      const wy = featherWeights(row.size, overlap, r === 0, r === rows.length - 1);

      for (let y = 0; y < row.size; y += 1) {
        for (let x = 0; x < col.size; x += 1) {
          const w = wx[x] * wy[y];
          const oi = (row.start + y) * outW + (col.start + x);
          const ti = ((y * scale) * tile + x * scale) * 3;
          sum[oi * 3] += values[ti] * w;
          sum[oi * 3 + 1] += values[ti + 1] * w;
          sum[oi * 3 + 2] += values[ti + 2] * w;
          weight[oi] += w;
        }
      }
      done += 1;
      onProgress?.({ phase: 'ia', ratio: done / total });
    }
  }

  const out = new Uint8ClampedArray(outW * outH * 4);
  for (let i = 0; i < outW * outH; i += 1) {
    const w = weight[i] || 1;
    out[i * 4] = clamp255(sum[i * 3] / w);
    out[i * 4 + 1] = clamp255(sum[i * 3 + 1] / w);
    out[i * 4 + 2] = clamp255(sum[i * 3 + 2] / w);
    out[i * 4 + 3] = 255;
  }
  if (total > 1) onStatus?.(`IA: ${total} mosaicos fusionados con solapamiento de ${overlap} px.`);
  return new ImageData(out, outW, outH);
}

export async function aiUpscale({
  modelKey,
  imageData,
  onProgress,
  onStatus,
  preferWebGpu = true,
}) {
  const model = AI_MODELS[modelKey];
  if (!model) throw new Error(`modelo desconocido: ${modelKey}`);

  onStatus?.(`Preparando ${model.label}…`);
  const bytes = await getModelBytes(modelKey, (info) => onProgress?.({ phase: 'modelo', ...info }));
  const { session, ort } = await getSession(modelKey, bytes, { onStatus, preferWebGpu });
  const backend = activeBackend(modelKey);
  onStatus?.(
    `Motor: ${backend === 'webgpu' ? 'WebGPU (GPU)' : 'WebAssembly (CPU)'}${
      webgpuAvailable() ? '' : ' — tu navegador no expone WebGPU'
    }`,
  );

  const context = { ort, session, model, imageData, onProgress, onStatus };
  return model.mode === 'y' ? upscaleLuma(context) : upscaleRgb(context);
}

export function aiModelInfo(modelKey) {
  return AI_MODELS[modelKey] || null;
}

export { MAX_OUTPUT_PIXELS };

// Exportados solo para las pruebas unitarias.
export const __tiles = tiles;
export const __reflectExtend = reflectExtend;
export const __buildTaps = buildTaps;
export const __bicubic = bicubic;
export const __upscaleLuma = upscaleLuma;
export const __mergeChroma = mergeChroma;