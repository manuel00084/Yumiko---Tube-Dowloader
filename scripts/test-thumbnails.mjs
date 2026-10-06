/**
 * Pruebas del bloque de miniaturas: catálogo de rutas de i.ytimg.com, sondeo de
 * las que existen de verdad, y las operaciones de imagen (Lanczos, realce y
 * recorte de barras) sobre un ImageData simulado.
 *
 * Uso: node scripts/test-thumbnails.mjs
 */
import { buildCandidateList, probeCandidates, probeImage, thumbnailUrl } from '../extension/thumbs/thumbnails.js';
import { resizeImageData, unsharpMask, trimLetterbox, cropToAspect } from '../extension/thumbs/lanczos.js';
import {
	__tiles as tiles,
	__reflectExtend as reflectExtend,
	__buildTaps as buildTaps,
	__bicubic as bicubic,
	__mergeChroma as mergeChroma,
	MAX_OUTPUT_PIXELS,
} from '../extension/thumbs/ai-upscaler.js';

// Node no tiene ImageData (viene con el canvas); shim mínimo.
if (typeof globalThis.ImageData !== 'function') {
	globalThis.ImageData = class ImageData {
		constructor(data, width, height) {
			if (typeof data === 'number') {
				this.width = data;
				this.height = width;
				this.data = new Uint8ClampedArray(width * height * 4);
				return;
			}
			this.data = data;
			this.width = width;
			this.height = height;
		}
	};
}

const assert = (condition, message) => {
	if (!condition) throw new Error(`FALLO: ${message}`);
	console.log(`  ok  ${message}`);
};

const VIDEO_ID = 'dQw4w9WgXcQ';

console.log('\n1) Catálogo de rutas de miniatura');
const candidates = buildCandidateList(VIDEO_ID);
assert(candidates.length === 25, `propone ${candidates.length} rutas`);
assert(
	candidates.every((item) => item.url.startsWith('https://i.ytimg.com/vi/dQw4w9WgXcQ/')),
	'todas apuntan a i.ytimg.com con el id del vídeo',
);
assert(new Set(candidates.map((item) => item.url)).size === candidates.length, 'no hay rutas repetidas');
assert(thumbnailUrl(VIDEO_ID, 'maxresdefault') === `https://i.ytimg.com/vi/${VIDEO_ID}/maxresdefault.jpg`, 'construye la URL');
const groups = [...new Set(candidates.map((item) => item.groupTitle))];
assert(groups[0].includes('OAR'), `la primera grupo es el original (${groups[0]})`);
assert(candidates[0].name.startsWith('oar'), 'las OAR van primero');

console.log('\n2) Sondeo: solo pasan las que existen');
// Solo dos variantes existen para este vídeo simulado; el resto responde 404.
const sizes = { maxresdefault: [1280, 720], hqdefault: [480, 360] };

globalThis.fetch = async (url) => {
	const name = String(url).split('/').pop().replace('.jpg', '');
	if (!sizes[name]) return { ok: false, status: 404 };
	const blob = new Blob([new Uint8Array(32)]);
	blob.__name = name;
	return { ok: true, status: 200, blob: async () => blob };
};
globalThis.createImageBitmap = async (blob) => {
	const [width, height] = sizes[blob?.__name] || [0, 0];
	return { width, height, close: () => {} };
};

const found = await probeCandidates(candidates, { limit: 4 });
assert(found.length === 2, `encuentra ${found.length} miniaturas reales de las ${candidates.length} rutas`);
assert(found.every((item) => item.width >= 40), 'descarta las demasiado pequeñas');
assert(
	found.every((item) => sizes[item.name]),
	'solo incluye rutas que no dieron 404',
);
assert(
	found[0].pixels > found[1].pixels,
	'las ordena de mayor a menor resolución',
);
assert(found[0].name === 'maxresdefault', `primero la mayor (${found[0].name})`);
assert(found[0].groupId === 'maxres', `con su grupo (${found[0].groupTitle})`);

console.log('\n3) 404 significa "no existe", no un error');
const missing = await probeImage('https://i.ytimg.com/vi/x/nada.jpg');
assert(missing === null, 'devuelve null en vez de lanzar');
const failed = await probeImage('https://i.ytimg.com/vi/x/error.jpg', { retries: 0 });
assert(failed === null, 'también cuando la respuesta no es válida');

console.log('\n4) Operaciones de imagen');
const makeImage = (w, h, paint) => {
	const data = new Uint8ClampedArray(w * h * 4);
	for (let y = 0; y < h; y++) {
		for (let x = 0; x < w; x++) {
			const o = (y * w + x) * 4;
			const [r, g, b] = paint(x, y);
			data[o] = r;
			data[o + 1] = g;
			data[o + 2] = b;
			data[o + 3] = 255;
		}
	}
	return new globalThis.ImageData(data, w, h);
};

const source = makeImage(16, 9, (x, y) => [(x * 16) % 256, (y * 28) % 256, 128]);
const doubled = resizeImageData(source, 32, 18);
assert(doubled.width === 32 && doubled.height === 18, 'Lanczos dobla las dimensiones');
assert(doubled.data.length === 32 * 18 * 4, 'el buffer crece con la imagen');
assert(
	doubled.data.every((value) => value >= 0 && value <= 255),
	'todos los valores siguen siendo bytes válidos',
);
const same = resizeImageData(source, 16, 9);
assert(same.width === 16 && same.height === 9, 'mantiene el tamaño si se pide el mismo');

const sharp = unsharpMask(source, 0.8);
assert(sharp.data.length === source.data.length, 'el realce no cambia el tamaño');
assert(
	sharp.data.some((v, i) => v !== source.data[i]),
	'el realce modifica píxeles',
);
const untouched = unsharpMask(source, 0);
assert(
	untouched.data.every((v, i) => v === source.data[i]),
	'sin realce devuelve la imagen igual',
);

const withBars = makeImage(20, 20, (x, y) => (x < 3 || x > 16 || y < 3 || y > 16 ? [0, 0, 0] : [200, 120, 60]));
const trimmed = trimLetterbox(withBars);
assert(trimmed.width === 14 && trimmed.height === 14, `recorta las barras (${trimmed.width}x${trimmed.height})`);

// 16x9 recortado a 1:1 se queda con el alto: 9x9.
const cropped = cropToAspect(source, 1);
assert(cropped.width === 9 && cropped.height === 9, `recorta a 1:1 (${cropped.width}x${cropped.height})`);
assert(cropped.data.length === 9 * 9 * 4, 'el recorte reduce el buffer');

console.log('\n5) Mosaicos del modelo de IA');

assert(tiles(100, 224, 0).length === 1, 'una sola pieza si cabe');
assert(JSON.stringify(tiles(500, 224, 0)).includes('"start":224'), 'reparte en varios mosaicos sin solape');
const overlapped = tiles(500, 64, 16);
assert(overlapped.length > 1, 'con solape hace más mosaicos');
assert(
	overlapped.every((tile) => tile.start + tile.size <= 500),
	'ningún mosaico se sale de la imagen',
);
const reflected = reflectExtend({ data: [1, 2, 3, 4], width: 2, height: 2, channels: 1 }, 3, 3, -1, -1);
assert(reflected.length === 9, 'refleja en los bordes para el margen de contexto');
assert(reflected[4] === 1, 'el centro conserva el valor original');
assert(bicubic(0) === 1, 'la bicúbica vale 1 en el origen');
assert(bicubic(3) === 0, 'la bicúbica se anula fuera del soporte');
const taps = buildTaps(8, 16);
assert(taps.length === 16, 'una fila de pesos por cada píxel de destino');
assert(
	Math.abs(taps[0].w.reduce((a, b) => a + b, 0) - 1) < 1e-6,
	'los pesos están normalizados (conserva el brillo)',
);

console.log('\nTodo correcto.');