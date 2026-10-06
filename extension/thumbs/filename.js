// Nombres de archivo y rutas de descarga.

import { sanitizeFilename } from './zip.js';

// Marcadores disponibles en la plantilla: {title} {id} {source} {w} {h}
// {scale} {f} y los alias {res} (ancho) y {res2} (alto).
export function templateValues({ item, result, videoId = '' }) {
  const width = result.width;
  const height = result.height;
  const scale = (width / Math.max(1, result.sourceWidth)).toFixed(2).replace(/\.?0+$/, '');
  const values = {
    title: item?.fileTitle || item?.title || item?.name || 'miniatura',
    id: item?.videoId || videoId || '',
    source: item?.sourceName || item?.name || 'original',
    w: width,
    h: height,
    res: width,
    res2: height,
    scale,
    f: result.extension,
  };
  return values;
}

export function renderName(template, values, fallback = 'miniatura') {
  const raw = String(template || '').trim() || fallback;
  const replaced = raw.replace(/\{(\w+)\}/g, (match, key) =>
    values[key] === undefined || values[key] === '' ? match : String(values[key]),
  );
  return sanitizeFilename(replaced, fallback);
}

// Aplica la carpeta configurada. Devuelve siempre una ruta relativa con "/".
export function buildPath(name, extension, folderPrefix = '') {
  const folder = String(folderPrefix || '')
    .replace(/\\/g, '/')
    .split('/')
    .map((part) => sanitizeFilename(part, ''))
    .filter(Boolean)
    .join('/');
  const file = `${name}.${extension}`;
  return folder ? `${folder}/${file}` : file;
}

export function buildFilename(item, result, settings, videoId = '') {
  const values = templateValues({ item, result, videoId });
  const name = renderName(settings.filenameTemplate, values);
  return buildPath(name, result.extension, settings.folderPrefix);
}

export function buildZipPath(count, folderPrefix = '') {
  const name = sanitizeFilename(`miniaturas_${count}`, 'miniaturas');
  return buildPath(name, 'zip', folderPrefix);
}