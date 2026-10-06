// Lectura de metadatos de la página de YouTube desde el HTML del visor.

const ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  '#39': "'",
  nbsp: ' ',
  '#160': ' ',
};

export function decodeEntities(text) {
  return String(text || '').replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, code) => {
    const key = code.toLowerCase();
    if (ENTITIES[key] !== undefined) return ENTITIES[key];
    if (key.startsWith('#x')) {
      const value = Number.parseInt(key.slice(2), 16);
      return Number.isFinite(value) ? String.fromCodePoint(value) : match;
    }
    if (key.startsWith('#')) {
      const value = Number.parseInt(key.slice(1), 10);
      return Number.isFinite(value) ? String.fromCodePoint(value) : match;
    }
    return match;
  });
}

export function parseMeta(html) {
  const ogTitle = html.match(/<meta\s+property="og:title"\s+content="([^"]*)"/)?.[1] || '';
  const title = html.match(/<title>([^<]*)<\/title>/)?.[1] || '';
  return { title: cleanTitle(ogTitle || title) };
}

export function cleanTitle(text) {
  if (!text) return '';
  return decodeEntities(text)
    .replace(/\s*-\s*YouTube\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}