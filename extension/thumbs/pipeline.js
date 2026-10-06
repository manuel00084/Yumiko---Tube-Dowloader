// Tubería completa: Bytes -> limpieza -> escalado -> realce -> codificación.

import {
  resizeImageData,
  unsharpMask,
  trimLetterbox,
  cropToAspect,
  imageDataFromBitmap,
} from './lanczos.js';
import { encode } from './encode.js';
import { aiUpscale, aiModelInfo } from './ai-upscaler.js';

export function targetSize(width, height, factor) {
  return {
    width: Math.max(1, Math.round(width * factor)),
    height: Math.max(1, Math.round(height * factor)),
  };
}

// Qué va a hacer exactamente la tubería con estos ajustes.
export function plan(settings) {
  const useAi = settings.upscaler === 'ai';
  const model = aiModelInfo(settings.aiModel);
  const native = useAi ? model?.scale ?? 1 : 1;
  const factor = settings.scale > 0 ? settings.scale : native;
  return { useAi, model, native, factor, net: factor / native };
}

function lanczosOptions(settings) {
  return { a: settings.lanczosStrength ?? 3, gamma: settings.gammaCorrect !== false };
}

export async function processImage({ blob, settings, onStatus = () => {}, onProgress = () => {} }) {
  const bitmap = await createImageBitmap(blob);
  let image = imageDataFromBitmap(bitmap);
  bitmap.close?.();

  const source = { width: image.width, height: image.height };

  if (settings.trimBars) image = trimLetterbox(image);
  if (settings.crop169) image = cropToAspect(image, 16 / 9);

  const { useAi, model, factor, net } = plan(settings);

  if (useAi && factor !== 1) {
    onStatus(`Escalando con ${model.label}…`);
    image = await aiUpscale({
      modelKey: settings.aiModel,
      imageData: image,
      onProgress,
      onStatus,
    });
    if (net !== 1) {
      const size = targetSize(image.width, image.height, net);
      onStatus(`Ajuste final a ${size.width}x${size.height}…`);
      image = resizeImageData(image, size.width, size.height, lanczosOptions(settings));
    }
  } else if (!useAi && factor !== 1) {
    const size = targetSize(image.width, image.height, factor);
    onStatus(`Lanczos x${factor}: ${size.width}x${size.height}…`);
    image = resizeImageData(image, size.width, size.height, lanczosOptions(settings));
  }

  if (settings.targetWidth && image.width > settings.targetWidth) {
    const height = Math.max(1, Math.round((image.height * settings.targetWidth) / image.width));
    onStatus(`Limitando el ancho a ${settings.targetWidth} px…`);
    image = resizeImageData(image, settings.targetWidth, height, lanczosOptions(settings));
  }

  if (settings.sharpen > 0) image = unsharpMask(image, settings.sharpen);

  const { blob: encoded, extension } = await encode(image, {
    format: settings.format,
    quality: settings.quality,
  });

  return {
    blob: encoded,
    extension,
    width: image.width,
    height: image.height,
    sourceWidth: source.width,
    sourceHeight: source.height,
  };
}