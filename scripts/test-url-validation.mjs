/**
 * El sondeo de URLs no puede hacer que la extensiÃ³n parezca rota ni lenta:
 *   - si la comprobaciÃ³n falla por CORS o red, no se descarta ningÃºn formato;
 *   - si la CDN rechaza de verdad (403/404), ese formato sÃ­ desaparece;
 *   - si una peticiÃ³n se cuelga, no bloquea el popup mÃ¡s de PROBE_TIMEOUT_MS;
 *   - se comprueban TODAS las resoluciones, no solo las primeras, para no
 *     perder formatos por el simple hecho de no llegado a comprobarlos.
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(new URL('.', import.meta.url)));
const source = fs.readFileSync(path.join(root, 'extension/src/inject.js'), 'utf8');

let failures = 0;
const assert = (condition, message) => {
	if (condition) console.log(`  ok  ${message}`);
	else {
		failures++;
		console.log(`  FALLA ${message}`);
	}
};

const videoFormat = (i, height) => ({
	itag: 100 + i,
	url: `https://rr1---sn-x.googlevideo.com/videoplayback?itag=${100 + i}`,
	mimeType: 'video/mp4; codecs="avc1.640028"',
	width: Math.round((height * 16) / 9),
	height,
	fps: 30,
	bitrate: 5_000_000 - i * 1000,
	contentLength: '1000000',
	qualityLabel: `${height}p`,
});

const audioFormats = [
	{
		itag: 140,
		url: 'https://rr1---sn-x.googlevideo.com/videoplayback?itag=140',
		mimeType: 'audio/mp4; codecs="mp4a.40.2"',
		audioQuality: 'AACL',
		bitrate: 128000,
		contentLength: '500000',
	},
	{
		itag: 251,
		url: 'https://rr1---sn-x.googlevideo.com/videoplayback?itag=251',
		mimeType: 'audio/webm; codecs="opus"',
		audioQuality: 'OPUS',
		bitrate: 160000,
		contentLength: '600000',
	},
];

const HEIGHTS = [2160, 1440, 1080, 720, 480, 360, 240, 144];

const playerWith = (formats) => ({
	playabilityStatus: { status: 'OK' },
	videoDetails: { videoId: 'dQw4w9WgXcQ', title: 'T', lengthSeconds: '212', author: 'A' },
	streamingData: { adaptiveFormats: formats, formats: [] },
});

const run = async (fetchImpl) => {
	const formatsRequested = [];
	const context = vm.createContext({
		URL, JSON, Object, Number, Boolean, String, Array, Math, Promise, Error, console,
		AbortSignal,
		DOMException,
		fetch: (input, init) => {
			formatsRequested.push(String(input));
			return fetchImpl(input, init);
		},
		location: { href: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' },
		document: { title: 'YouTube' },
		ytcfg: {
			data_: {
				INNERTUBE_API_KEY: 'k',
				INNERTUBE_CLIENT_VERSION: '2.20250101.00.00',
				INNERTUBE_CONTEXT: { client: { clientVersion: '2.20250101.00.00' } },
			},
		},
		ytInitialPlayerResponse: { playabilityStatus: { status: 'OK' }, videoDetails: {}, streamingData: {} },
	});
	vm.runInContext(source, context, { filename: 'inject.js' });
	const result = await context.__yumikoGetMedia();
	if (!result.ok) console.log(`       (motivo: ${result.error})`);
	return result;
};

const heights = (result) =>
	(result.formats || [])
		.filter((f) => f.kind === 'video' || f.kind === 'muxed')
		.map((f) => f.height)
		.sort((a, b) => b - a);

console.log('\n1) Todo vÃ¡lido: se ofrecen TODAS las resoluciones');
{
	const formats = [...HEIGHTS.map((h, i) => videoFormat(i, h)), ...audioFormats];
	const result = await run(async (input) => {
		if (String(input).includes('/youtubei/')) {
			return { ok: true, status: 200, json: async () => playerWith(formats) };
		}
		return { status: 206, arrayBuffer: async () => new ArrayBuffer(2) };
	});
	assert(result.ok === true, 'detecta el vÃ­deo');
	assert(
		JSON.stringify(heights(result)) === JSON.stringify([...HEIGHTS].sort((a, b) => b - a)),
		`lista las ${HEIGHTS.length} resoluciones (${heights(result).join('/')})`,
	);
	assert(result.diag.urlsComprobadas === formats.length, `comprueba las ${formats.length} URLs, no solo 10`);
}

console.log('\n2) AV1/VP9 rechazados con 403: solo se van esos');
{
	const av1 = HEIGHTS.map((h, i) => ({ ...videoFormat(i, h), mimeType: 'video/mp4; codecs="av01.0.12M.08"' }));
	const h264 = HEIGHTS.map((h, i) => ({ ...videoFormat(50 + i, h), mimeType: 'video/mp4; codecs="avc1.640028"' }));
	const formats = [...av1, ...h264, ...audioFormats];
	const result = await run(async (input) => {
		if (String(input).includes('/youtubei/')) {
			return { ok: true, status: 200, json: async () => playerWith(formats) };
		}
		// Los AV1 llevan itag 100-107; los H.264, 150-157; el audio, 140 y 251.
		const itag = Number(/itag=(\d+)/.exec(String(input))?.[1]);
		const isAv1 = itag >= 100 && itag <= 107;
		return { status: isAv1 ? 403 : 206, arrayBuffer: async () => new ArrayBuffer(2) };
	});
	assert(result.ok === true, 'detecta el vÃ­deo');
	assert(result.diag.urlsRechazadas === HEIGHTS.length, `descarta los ${HEIGHTS.length} rechazados`);
	assert(
		JSON.stringify(heights(result)) === JSON.stringify([...HEIGHTS].sort((a, b) => b - a)),
		`las H.264 se conservan a todas las resoluciones (${heights(result).join('/')})`,
	);
}

console.log('\n3) CORS bloquea el sondeo: no se pierde ningÃºn formato');
{
	const formats = [...HEIGHTS.map((h, i) => videoFormat(i, h)), ...audioFormats];
	const result = await run(async (input) => {
		if (String(input).includes('/youtubei/')) {
			return { ok: true, status: 200, json: async () => playerWith(formats) };
		}
		throw new TypeError('Failed to fetch');
	});
	assert(result.ok === true, 'sigue detectando el vÃ­deo');
	assert(heights(result).length === HEIGHTS.length, `ofrece las ${HEIGHTS.length} resoluciones`);
	assert(result.diag.urlsSinComprobar === formats.length, 'informa de que no pudo comprobar ninguna');
}

console.log('\n4) Una peticiÃ³n colgada no bloquea el popup');
{
	const formats = [...HEIGHTS.map((h, i) => videoFormat(i, h)), ...audioFormats];
	const started = Date.now();
	const result = await run(async (input) => {
		if (String(input).includes('/youtubei/')) {
			return { ok: true, status: 200, json: async () => playerWith(formats) };
		}
		// Se cuelga hasta que el AbortSignal que pasa el propio sondeo lo corte.
		return new Promise((_resolve, reject) => {
			init?.signal?.addEventListener('abort', () => reject(new DOMException('abortada', 'AbortError')), {
				once: true,
			});
		});
	});
	const elapsed = Date.now() - started;
	assert(result.ok === true, 'detecta el vÃ­deo pese a las peticiones colgadas');
	assert(elapsed < 15_000, `termina en ${(elapsed / 1000).toFixed(1)}s (con tiempo lÃ­mite por peticiÃ³n)`);
}

console.log('\n5) Si la CDN lo rechaza todo, avisa en lugar de fallar en silencio');
{
	const formats = [...HEIGHTS.map((h, i) => videoFormat(i, h)), ...audioFormats];
	const result = await run(async (input) => {
		if (String(input).includes('/youtubei/')) {
			return { ok: true, status: 200, json: async () => playerWith(formats) };
		}
		return { status: 403, arrayBuffer: async () => new ArrayBuffer(2) };
	});
	assert(result.ok === false, 'informa de que no hay formatos utilizables');
	assert(/formatos/i.test(result.error || ''), `con un mensaje claro (${result.error})`);
}

console.log(failures ? `\n${failures} fallo(s).` : '\nTodo correcto.');
process.exit(failures ? 1 : 0);
