/**
 * Prueba del extractor contra YouTube real: ejecuta extension/src/inject.js en
 * un contexto simulado pero con fetch de verdad. Es la única forma de
 * comprobar la parte que no se puede probar sin navegador.
 *
 * Uso: node scripts/test-live.mjs [videoId]
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(new URL('.', import.meta.url)));
const source = fs.readFileSync(path.join(root, 'extension/src/inject.js'), 'utf8');
const videoId = process.argv[2] || 'dQw4w9WgXcQ';

const assert = (condition, message) => {
	if (!condition) throw new Error(`FALLO: ${message}`);
	console.log(`  ok  ${message}`);
};

const UA =
	'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36';

const fetchWatchPage = async (id) => {
	const response = await fetch(`https://www.youtube.com/watch?v=${id}&hl=es`, {
		headers: { 'User-Agent': UA, 'Accept-Language': 'es-ES,es;q=0.9' },
	});
	const html = await response.text();
	const apiKey = /"INNERTUBE_API_KEY":"([^"]+)"/.exec(html)?.[1];
	const context = JSON.parse(/"INNERTUBE_CONTEXT":(\{.+?\}),"INNERTUBE_CONTEXT_CLIENT_NAME"/.exec(html)?.[1] || '{}');
	const visitorData = /"VISITOR_DATA":"([^"]+)"/.exec(html)?.[1];
	return { apiKey, context, visitorData };
};

const page = await fetchWatchPage(videoId);
console.log(`Vídeo: ${videoId}`);
console.log(`Página: apiKey=${Boolean(page.apiKey)} visitorData=${Boolean(page.visitorData)}`);

// El reproductor web no expone formatos: se parte de esa situación real.
const context = vm.createContext({
	URL,
	JSON,
	Object,
	Number,
	Boolean,
	String,
	Array,
	Math,
	Promise,
	Error,
	console,
	fetch: (input, init) => fetch(new URL(String(input), 'https://www.youtube.com'), init),
	location: { href: `https://www.youtube.com/watch?v=${videoId}` },
	document: { title: 'YouTube' },
	ytcfg: {
		data_: {
			INNERTUBE_API_KEY: page.apiKey,
			INNERTUBE_CLIENT_VERSION: '2.20250101.00.00',
			INNERTUBE_CONTEXT: page.context,
			VISITOR_DATA: page.visitorData,
		},
	},
	ytInitialPlayerResponse: { playabilityStatus: { status: 'OK' }, videoDetails: {}, streamingData: {} },
});

vm.runInContext(source, context);

console.log('\nExtrayendo formatos con el código real de la extensión:');
const started = Date.now();
const result = await context.__yumikoGetMedia();
const elapsed = Date.now() - started;

if (!result.ok) {
	// Desde una red sin acceso a la CDN no se puede validar nada: no es un fallo
	// de la extensión, así que se informa y se sale sin error.
	if (result.diag?.urlsValidas === 0 && /no ha devuelto los streams|no ha expuesto/.test(result.error || '')) {
		console.log(`\nOMITIDO: esta red no llega a la CDN de YouTube, así que no se pueden`);
		console.log('comprobar las URLs. Prueba con: npm run test:live 9bZkp7q19f0');
		process.exit(0);
	}
	console.error(`  ERROR: ${result.error}`);
	process.exit(1);
}

console.log(`  (${elapsed} ms, cliente ${result.client})`);
assert(result.ok === true, 'detecta el vídeo');
assert(result.title.length > 0, `título: "${result.title}"`);
assert(Number.isFinite(result.duration) && result.duration > 0, `duración: ${result.duration}s`);
assert(result.formats.length > 5, `formatos disponibles: ${result.formats.length}`);
assert(
	result.diag.urlsValidas > 0 && result.diag.urlsValidas === result.formats.length,
	`solo ofrece URLs comprobadas (${result.diag.urlsValidas} de ${result.diag.urlsComprobadas})`,
);

const video = result.formats.filter((f) => f.kind === 'video' || f.kind === 'muxed');
const audio = result.formats.filter((f) => f.kind === 'audio');
assert(video.length > 0, `vídeos: ${video.length} (hasta ${Math.max(...video.map((f) => f.height || 0))}p)`);
assert(audio.length > 0, `audios: ${audio.length}`);

const qualities = [...new Set(video.map((f) => f.qualityLabel))].slice(0, 8);
console.log(`  calidades: ${qualities.join(', ')}`);
console.log(`  audio: ${audio.map((f) => `${f.itag} ${f.container}`).join(', ')}`);

const noSignature = result.formats.every((f) => f.url.startsWith('https://') && f.url.includes('googlevideo'));
assert(noSignature, 'todas las URLs son directas y ya firmadas (sin decipher)');
assert(
	result.formats.some((f) => f.kind === 'muxed'),
	'hay al menos un formato con vídeo y audio juntos',
);

console.log('\nTodo correcto.');