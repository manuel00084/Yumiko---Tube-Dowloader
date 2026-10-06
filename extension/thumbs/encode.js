const MIME = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp' };
const EXT = { png: 'png', jpg: 'jpg', webp: 'webp' };

export const FORMATS = [
  { id: 'png', label: 'PNG', detail: 'Sin pérdida, el mayor tamaño de archivo' },
  { id: 'jpg', label: 'JPG', detail: 'Con pérdida, quality=1.0 para el mínimo de artefactos' },
  { id: 'webp', label: 'WebP', detail: 'Con pérdida, mejor compresión que JPG' },
];

let webpSupport = null;

export async function supportsFormat(format) {
  if (format !== 'webp') return true;
  if (webpSupport !== null) return webpSupport;
  const canvas = new OffscreenCanvas(2, 2);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(new ImageData(new Uint8ClampedArray(16).fill(200), 2, 2), 0, 0);
  const blob = await canvas.convertToBlob({ type: 'image/webp', quality: 0.8 });
  webpSupport = blob.type === 'image/webp';
  return webpSupport;
}

export async function encode(imageData, { format = 'png', quality = 1 } = {}) {
  let type = MIME[format] || MIME.png;
  const canvas = new OffscreenCanvas(imageData.width, imageData.height);
  const ctx = canvas.getContext('2d', { alpha: format === 'png' });
  if (format !== 'png') {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, imageData.width, imageData.height);
  }
  ctx.putImageData(imageData, 0, 0);

  const options = type === 'image/png' ? {} : { quality: clampQuality(format, quality) };
  let blob = await canvas.convertToBlob({ type, ...options });

  if (type === 'image/webp' && blob.type !== 'image/webp') {
    type = 'image/png';
    blob = await canvas.convertToBlob({ type });
  }
  return { blob, extension: type === 'image/png' && format === 'png' ? 'png' : EXT[format] || 'png' };
}

function clampQuality(format, quality) {
  const q = Math.min(1, Math.max(0.5, Number(quality)));
  if (format === 'jpg') return Math.round(q * 100) / 100;
  return Math.round(q * 100) / 100;
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1048576).toFixed(2)} MB`;
}