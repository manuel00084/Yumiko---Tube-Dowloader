// Escalado clásico de alta calidad: Lanczos3 separable con soporte widening,
// trabajo opcional en espacio lineal (gamma) y realce tipo unsharp mask.

function lanczos(x, a) {
  if (x === 0) return 1;
  const ax = Math.abs(x);
  if (ax >= a) return 0;
  const px = Math.PI * x;
  return (a * Math.sin(px) * Math.sin(px / a)) / (px * px);
}

function buildAxis(srcLen, dstLen, a) {
  const ratio = srcLen / dstLen;
  const scale = Math.max(1, ratio);
  const support = a * scale;
  const starts = new Int32Array(dstLen);
  const counts = new Int32Array(dstLen);
  const weights = [];
  for (let i = 0; i < dstLen; i += 1) {
    const center = (i + 0.5) * ratio - 0.5;
    const first = Math.max(0, Math.ceil(center - support));
    const last = Math.min(srcLen - 1, Math.floor(center + support));
    const count = last - first + 1;
    const row = new Float64Array(count);
    let sum = 0;
    for (let k = 0; k < count; k += 1) {
      const w = lanczos((center - (first + k)) / scale, a);
      row[k] = w;
      sum += w;
    }
    if (sum !== 0) {
      for (let k = 0; k < count; k += 1) row[k] /= sum;
    }
    starts[i] = first;
    counts[i] = count;
    weights.push(row);
  }
  return { starts, counts, weights };
}

const SRGB_TO_LINEAR = new Float32Array(256);
const LINEAR_TO_SRGB = new Uint8ClampedArray(4096);
(function buildTables() {
  for (let i = 0; i < 256; i += 1) {
    const c = i / 255;
    SRGB_TO_LINEAR[i] = c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }
  for (let i = 0; i < 4096; i += 1) {
    const c = i / 4095;
    const v = c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055;
    LINEAR_TO_SRGB[i] = Math.round(Math.min(1, Math.max(0, v)) * 255);
  }
})();

function toLinear(data) {
  const out = new Float32Array(data.length);
  for (let i = 0; i < data.length; i += 4) {
    out[i] = SRGB_TO_LINEAR[data[i]];
    out[i + 1] = SRGB_TO_LINEAR[data[i + 1]];
    out[i + 2] = SRGB_TO_LINEAR[data[i + 2]];
    out[i + 3] = data[i + 3] / 255;
  }
  return out;
}

function encodePlanes(planes, width, height, gamma) {
  const out = new Uint8ClampedArray(width * height * 4);
  const count = width * height;
  if (gamma) {
    for (let i = 0; i < count; i += 1) {
      const o = i * 4;
      out[o] = LINEAR_TO_SRGB[clampIndex(planes[o] * 4095)];
      out[o + 1] = LINEAR_TO_SRGB[clampIndex(planes[o + 1] * 4095)];
      out[o + 2] = LINEAR_TO_SRGB[clampIndex(planes[o + 2] * 4095)];
      out[o + 3] = Math.round(clamp01(planes[o + 3]) * 255);
    }
    return out;
  }
  for (let i = 0; i < count; i += 1) {
    const o = i * 4;
    out[o] = Math.round(clamp01(planes[o]) * 255);
    out[o + 1] = Math.round(clamp01(planes[o + 1]) * 255);
    out[o + 2] = Math.round(clamp01(planes[o + 2]) * 255);
    out[o + 3] = Math.round(clamp01(planes[o + 3]) * 255);
  }
  return out;
}

function clamp01(value) {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

function clampIndex(value) {
  const rounded = Math.round(value);
  return rounded < 0 ? 0 : rounded > 4095 ? 4095 : rounded;
}

function resamplePlanes(src, srcW, srcH, dstW, dstH, a) {
  const horiz = buildAxis(srcW, dstW, a);
  const tmp = new Float32Array(dstW * srcH * 4);
  for (let y = 0; y < srcH; y += 1) {
    const rowBase = y * srcW * 4;
    const outBase = y * dstW * 4;
    for (let x = 0; x < dstW; x += 1) {
      const first = horiz.starts[x];
      const count = horiz.counts[x];
      const weights = horiz.weights[x];
      let r = 0;
      let g = 0;
      let b = 0;
      let al = 0;
      for (let k = 0; k < count; k += 1) {
        const w = weights[k];
        const s = rowBase + (first + k) * 4;
        r += src[s] * w;
        g += src[s + 1] * w;
        b += src[s + 2] * w;
        al += src[s + 3] * w;
      }
      const o = outBase + x * 4;
      tmp[o] = r;
      tmp[o + 1] = g;
      tmp[o + 2] = b;
      tmp[o + 3] = al;
    }
  }

  const vert = buildAxis(srcH, dstH, a);
  const dst = new Float32Array(dstW * dstH * 4);
  for (let y = 0; y < dstH; y += 1) {
    const first = vert.starts[y];
    const count = vert.counts[y];
    const weights = vert.weights[y];
    const outBase = y * dstW * 4;
    for (let x = 0; x < dstW; x += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      let al = 0;
      for (let k = 0; k < count; k += 1) {
        const w = weights[k];
        const s = (first + k) * dstW * 4 + x * 4;
        r += tmp[s] * w;
        g += tmp[s + 1] * w;
        b += tmp[s + 2] * w;
        al += tmp[s + 3] * w;
      }
      const o = outBase + x * 4;
      dst[o] = r;
      dst[o + 1] = g;
      dst[o + 2] = b;
      dst[o + 3] = al;
    }
  }
  return dst;
}

export function resizeImageData(imageData, dstW, dstH, { a = 3, gamma = true } = {}) {
  const srcW = imageData.width;
  const srcH = imageData.height;
  if (srcW === dstW && srcH === dstH && a <= 0) return imageData;
  const planes = gamma ? toLinear(imageData.data) : Float32Array.from(imageData.data, (v) => v / 255);
  const scaled = resamplePlanes(planes, srcW, srcH, dstW, dstH, Math.max(0.5, a));
  return new ImageData(encodePlanes(scaled, dstW, dstH, gamma), dstW, dstH);
}

// Unsharp mask gaussiano de 3x3 (núcleo [1 2 1]/4 x [1 2 1]/4), en sRGB.
export function unsharpMask(imageData, amount = 0.4) {
  if (amount <= 0) return imageData;
  const { width, height, data } = imageData;
  const blurred = new Float32Array(data.length);
  const tmp = new Float32Array(data.length);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const xm = x > 0 ? x - 1 : 0;
      const xp = x < width - 1 ? x + 1 : width - 1;
      const o = y * width + x;
      for (let c = 0; c < 3; c += 1) {
        tmp[o * 4 + c] =
          (data[(y * width + xm) * 4 + c] + 2 * data[(y * width + x) * 4 + c] + data[(y * width + xp) * 4 + c]) / 4;
      }
      tmp[o * 4 + 3] = data[o * 4 + 3];
    }
  }
  for (let y = 0; y < height; y += 1) {
    const ym = y > 0 ? y - 1 : 0;
    const yp = y < height - 1 ? y + 1 : height - 1;
    for (let x = 0; x < width; x += 1) {
      const xm = x > 0 ? x - 1 : 0;
      const xp = x < width - 1 ? x + 1 : width - 1;
      const o = (y * width + x) * 4;
      for (let c = 0; c < 3; c += 1) {
        const blur =
          (tmp[(ym * width + xm) * 4 + c] +
            2 * tmp[(ym * width + x) * 4 + c] +
            tmp[(ym * width + xp) * 4 + c] +
            2 * tmp[(y * width + xm) * 4 + c] +
            4 * tmp[o + c] +
            2 * tmp[(y * width + xp) * 4 + c] +
            tmp[(yp * width + xm) * 4 + c] +
            2 * tmp[(yp * width + x) * 4 + c] +
            tmp[(yp * width + xp) * 4 + c]) /
          16;
        blurred[o + c] = data[o + c] + amount * (data[o + c] - blur);
      }
      blurred[o + 3] = data[o + 3];
    }
  }
  const out = new Uint8ClampedArray(data.length);
  for (let i = 0; i < blurred.length; i += 1) out[i] = blurred[i];
  return new ImageData(out, width, height);
}

// Quita las barras negras (hqdefault/sddefault vienen en 4:3 con relleno).
// Se mide el brillo máximo de cada fila y columna: así un fotograma oscuro
// en el centro no se confunde con una barra.
export function trimLetterbox(imageData, tolerance = 26) {
  const { width, height, data } = imageData;
  const rowMax = new Uint8Array(height);
  const colMax = new Uint8Array(width);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const o = (y * width + x) * 4;
      const luma = (data[o] * 77 + data[o + 1] * 150 + data[o + 2] * 29) >> 8;
      if (luma > rowMax[y]) rowMax[y] = luma;
      if (luma > colMax[x]) colMax[x] = luma;
    }
  }
  let top = 0;
  while (top < height / 2 && rowMax[top] <= tolerance) top += 1;
  let bottom = height - 1;
  while (bottom > height / 2 && rowMax[bottom] <= tolerance) bottom -= 1;
  let left = 0;
  while (left < width / 2 && colMax[left] <= tolerance) left += 1;
  let right = width - 1;
  while (right > width / 2 && colMax[right] <= tolerance) right -= 1;
  if (top >= bottom || left >= right) return imageData;
  if (top < 2 && left < 2 && bottom >= height - 2 && right >= width - 2) return imageData;
  const w = right - left + 1;
  const h = bottom - top + 1;
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y += 1) {
    const src = ((y + top) * width + left) * 4;
    out.set(data.subarray(src, src + w * 4), y * w * 4);
  }
  return new ImageData(out, w, h);
}

export function cropToAspect(imageData, aspect = 16 / 9) {
  const { width, height } = imageData;
  const current = width / height;
  if (Math.abs(current - aspect) < 0.01) return imageData;
  let w = width;
  let h = height;
  if (current > aspect) w = Math.round(height * aspect);
  else h = Math.round(width / aspect);
  const x = Math.round((width - w) / 2);
  const y = Math.round((height - h) / 2);
  const data = new Uint8ClampedArray(w * h * 4);
  for (let row = 0; row < h; row += 1) {
    const src = ((row + y) * width + x) * 4;
    data.set(imageData.data.subarray(src, src + w * 4), row * w * 4);
  }
  return new ImageData(data, w, h);
}

export function imageDataFromBitmap(bitmap) {
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true, alpha: false });
  ctx.drawImage(bitmap, 0, 0);
  return ctx.getImageData(0, 0, bitmap.width, bitmap.height);
}

export function imageDataToBitmap(imageData) {
  const canvas = new OffscreenCanvas(imageData.width, imageData.height);
  const ctx = canvas.getContext('2d', { alpha: false });
  ctx.putImageData(imageData, 0, 0);
  return canvas.transferToImageBitmap();
}