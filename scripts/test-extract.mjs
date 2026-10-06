/**
 * Prueba de extension/src/inject.js (el extractor que corre en la pagina de
 * YouTube) sin navegador: se ejecuta en un contexto simulado con distintos
 * tipos de respuestas del reproductor.
 *
 * La extension comprueba cada URL con una peticion de 2 bytes antes de
 * ofrecerla, asi que el fetch simulado responde tambien a esas comprobaciones.
 *
 * Uso: node scripts/test-extract.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(new URL('.', import.meta.url)));
const source = fs.readFileSync(path.join(root, 'extension/src/inject.js'), 'utf8');

const assert = (condition, message) => {
	if (!condition) throw new Error(`FALLO: ${message}`);
	console.log(`  ok  ${message}`);
};

const CDN_OK = () => ({ status: 206, arrayBuffer: async () => new ArrayBuffer(2) });
const CDN_FORBIDDEN = () => ({ status: 403, arrayBuffer: async () => new ArrayBuffer(0) });

const run = async (globals) => {
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
		// El extractor pasa un AbortSignal.timeout() a cada sondeo de URL.
		AbortSignal,
		DOMException,
		location: { href: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' },
		document: { title: 'Video de prueba - YouTube', querySelector: () => null },
		fetch: async () => {
			throw new Error('no deberia llamar a la API interna');
		},
		...globals,
	});
	vm.runInContext(source, context);
	return context.__yumikoGetMedia();
};

const playerResponse = {
	videoDetails: {
		videoId: 'dQw4w9WgXcQ',
		title: 'Video de prueba',
		author: 'Canal de prueba',
		lengthSeconds: '213',
		thumbnail: { thumbnails: [{ url: 'https://i.ytimg.com/vi/x/default.jpg' }] },
	},
	streamingData: {
		expiresInSeconds: 21540,
		adaptiveFormats: [
			{
				itag: 137,
				url: 'https://rr1---sn-video.googlevideo.com/videocache/1080.mp4',
				mimeType: 'video/mp4; codecs="avc1.640028"',
				bitrate: 4000000,
				width: 1920,
				height: 1080,
				fps: 30,
				qualityLabel: '1080p',
				contentLength: '100000000',
			},
			{
				itag: 299,
				url: 'https://rr1---sn-video.googlevideo.com/videocache/1080-60.mp4',
				mimeType: 'video/mp4; codecs="avc1.64002a"',
				bitrate: 5000000,
				width: 1920,
				height: 1080,
				fps: 60,
				qualityLabel: '1080p60',
				contentLength: '120000000',
			},
			{
				itag: 248,
				url: 'https://rr1---sn-video.googlevideo.com/videocache/720.webm',
				mimeType: 'video/webm; codecs="vp9"',
				bitrate: 3000000,
				width: 1280,
				height: 720,
				fps: 30,
				qualityLabel: '720p',
				contentLength: '50000000',
			},
			{
				itag: 136,
				url: 'https://rr1---sn-video.googlevideo.com/videocache/720.mp4',
				mimeType: 'video/mp4; codecs="avc1.4d401f"',
				bitrate: 2000000,
				width: 1280,
				height: 720,
				fps: 30,
				qualityLabel: '720p',
				contentLength: '30000000',
			},
			{
				itag: 22,
				url: 'https://rr1---sn-video.googlevideo.com/videocache/720-progresivo.mp4',
				mimeType: 'video/mp4; codecs="avc1.64001F, mp4a.40.2"',
				bitrate: 1500000,
				width: 1280,
				height: 720,
				fps: 30,
				qualityLabel: '720p',
				contentLength: '25000000',
			},
			{
				itag: 140,
				url: 'https://rr1---sn-audio.googlevideo.com/audioless/aac.m4a',
				mimeType: 'audio/mp4; codecs="mp4a.40.2"',
				bitrate: 128000,
				audioQuality: 'AUDIO_QUALITY_MEDIUM',
				averageBitrate: 129000,
				contentLength: '3500000',
			},
			{
				itag: 251,
				url: 'https://rr1---sn-audio.googlevideo.com/audioless/opus.webm',
				mimeType: 'audio/webm; codecs="opus"',
				bitrate: 160000,
				audioQuality: 'AUDIO_QUALITY_MEDIUM',
				contentLength: '4200000',
			},
			{
				itag: 401,
				signatureCipher: 's=ABC&url=https%3A%2F%2Frr1---sn-video.googlevideo.com%2Fprotegido',
				mimeType: 'video/mp4; codecs="avc1.640028"',
				width: 1920,
				height: 1080,
				fps: 30,
				qualityLabel: '1080p',
			},
		],
		formats: [
			{
				itag: 18,
				url: 'https://rr1---sn-video.googlevideo.com/videocache/progresivo.mp4',
				mimeType: 'video/mp4; codecs="avc1.42001E, mp4a.40.2"',
				bitrate: 700000,
				width: 640,
				height: 360,
				qualityLabel: '360p',
				contentLength: '20000000',
			},
		],
	},
	playabilityStatus: { status: 'OK' },
};

const YT_CONFIG = {
	data_: {
		INNERTUBE_API_KEY: 'AIzaSyTEST',
		INNERTUBE_CLIENT_VERSION: '2.20250101.00.00',
		INNERTUBE_CONTEXT: { client: { clientName: 'WEB', clientVersion: '2.20250101.00.00' } },
		VISITOR_DATA: 'CgtNQkZHVVNF',
	},
};

const okFetch = async () => ({ ok: true, json: async () => playerResponse });
const isCdn = (url) => String(url).includes('googlevideo.com');

const testNormal = async () => {
	console.log('\n1) Respuesta completa del reproductor');
	const result = await run({
		ytInitialPlayerResponse: playerResponse,
		fetch: async (url) => (isCdn(url) ? CDN_OK() : okFetch(url)),
	});

	assert(result.ok === true, 'indica que se ha podido leer el video');
	assert(result.title === 'Video de prueba' && result.author === 'Canal de prueba', 'devuelve titulo y canal');
	assert(result.duration === 213, 'devuelve la duracion en segundos');
	assert(result.thumbnail.includes('i.ytimg.com'), 'devuelve la miniatura');
	assert(result.isLive === false, 'no lo marca como directo');

	const byItag = Object.fromEntries(result.formats.map((format) => [format.itag, format]));
	assert(Object.keys(byItag).length === 8, `filtra el formato con firma cifrada (${result.formats.length} formatos)`);
	assert(byItag[137].kind === 'video' && byItag[137].height === 1080, 'detecta el video 1080p');
	assert(byItag[137].container === 'avc1.640028', 'extrae el codec del contenedor');
	assert(byItag[299].fps === 60, 'detecta los 60 fps');
	assert(byItag[248].kind === 'video' && byItag[248].container === 'vp9', 'detecta el video VP9');
	assert(byItag[140].kind === 'audio' && byItag[140].audioBitrate === 129000, 'detecta el audio AAC');
	assert(byItag[251].kind === 'audio' && byItag[251].container === 'opus', 'detecta el audio Opus');
	assert(byItag[18].kind === 'muxed', 'detecta el formato progresivo con audio');
	assert(byItag[22].kind === 'muxed', 'detecta tambien el 720p progresivo');
	assert(byItag[137].contentLength === 100000000, 'mantiene el tamano del archivo');
};

const testFallback = async () => {
	console.log('\n2) Sin formatos en la pagina: consulta a la API interna');
	const requested = [];
	const result = await run({
		ytInitialPlayerResponse: { playabilityStatus: { status: 'OK' }, videoDetails: {} },
		ytcfg: YT_CONFIG,
		fetch: async (url, options) => {
			if (isCdn(url)) return CDN_OK();
			requested.push({ url, headers: options.headers, body: JSON.parse(options.body) });
			return {
				ok: true,
				json: async () => ({
					...playerResponse,
					videoDetails: { ...playerResponse.videoDetails, title: 'Del API' },
				}),
			};
		},
	});

	assert(result.ok === true && result.title === 'Del API', 'usa la respuesta de la API interna');
	assert(result.diag.origen === 'innertube', 'indica que los formatos vienen de innertube');
	assert(requested.length === 1, `prueba clientes hasta que uno funciona (${requested.length} peticion)`);
	assert(requested[0].url.includes('/youtubei/v1/player'), 'llama a youtubei/v1/player');
	assert(requested[0].body.videoId === 'dQw4w9WgXcQ', 'envia el id del video');
	assert(requested[0].body.context.client.clientName === 'ANDROID', 'identifica el cliente ANDROID');
	assert(requested[0].body.context.client.androidSdkVersion === 34, 'envia androidSdkVersion para ANDROID');
	assert(requested[0].body.context.client.visitorData === 'CgtNQkZHVVNF', 'adjunta el visitorData de la pagina');
	assert(requested[0].headers['X-Goog-Visitor-Id'] === 'CgtNQkZHVVNF', 'adjunta la cabecera X-Goog-Visitor-Id');
	assert(!requested[0].body.context.client.playbackContext, 'no manda playbackContext a los moviles');
	assert(result.diag.urlsComprobadas > 0, `comprueba las URLs antes de ofrecerlas (${result.diag.urlsComprobadas})`);
	assert(result.diag.urlsValidas > 0, `descarta las que no responden (${result.diag.urlsValidas} validas)`);
};

const testClientChain = async () => {
	console.log('\n3) Cadena de clientes: si ANDROID falla, prueba el siguiente');
	const seen = [];
	const result = await run({
		ytInitialPlayerResponse: { playabilityStatus: { status: 'OK' }, videoDetails: {} },
		ytcfg: YT_CONFIG,
		fetch: async (url, options) => {
			if (isCdn(url)) return CDN_OK();
			const body = JSON.parse(options.body);
			const name = body.context.client.clientName;
			seen.push(name);
			return {
				ok: true,
				json: async () =>
					name === 'IOS'
						? playerResponse
						: { playabilityStatus: { status: 'OK' }, videoDetails: {} },
			};
		},
	});

	assert(result.ok === true, 'acaba encontrando formatos');
	assert(result.client === 'IOS', 'usa IOS cuando ANDROID no sirve');
	assert(seen.join('>') === 'ANDROID>IOS', `va probando clientes en orden (${seen.join(' > ')})`);
};

const testUrlValidation = async () => {
	console.log('\n4) URLs que YouTube rechaza con 403');
	const result = await run({
		ytInitialPlayerResponse: { playabilityStatus: { status: 'OK' }, videoDetails: {} },
		ytcfg: YT_CONFIG,
		fetch: async (url) => (isCdn(url) ? CDN_FORBIDDEN() : okFetch(url)),
	});

	assert(result.ok === false, 'no ofrece formatos que dan 403');
	assert(result.diag.urlsValidas === 0, `lo deja constancia (${result.diag.urlsValidas} validas)`);
	assert(/ANDROID/.test(JSON.stringify(result.diag.innertube)), 'anota los clientes que ha probado');
};

const testErrors = async () => {
	console.log('\n5) Casos de error');
const empty = { playabilityStatus: { status: 'OK' }, videoDetails: {} };
// Si la página dice que no se puede reproducir, ahora se intenta igual la API
// interna: si tampoco da nada, el aviso es el de la página.
const failingInnerTube = async (url) => (isCdn(url) ? CDN_OK() : { ok: true, json: async () => empty });

const login = await run({
	ytInitialPlayerResponse: { playabilityStatus: { status: 'LOGIN_REQUIRED' }, videoDetails: {} },
	ytcfg: YT_CONFIG,
	fetch: failingInnerTube,
});
assert(login.ok === false && /iniciar sesi/i.test(login.error), `avisa de que hace falta iniciar sesion (${login.error})`);

const unplayable = await run({
	ytInitialPlayerResponse: { playabilityStatus: { status: 'UNPLAYABLE' }, videoDetails: {} },
	ytcfg: YT_CONFIG,
	fetch: failingInnerTube,
});
assert(unplayable.ok === false && /reproducir/i.test(unplayable.error), `avisa de que no se puede reproducir (${unplayable.error})`);

const sabr = await run({
	ytInitialPlayerResponse: {
		playabilityStatus: { status: 'OK' },
		videoDetails: {},
		streamingData: { adaptiveFormats: [] },
	},
	ytcfg: YT_CONFIG,
	fetch: failingInnerTube,
});
assert(sabr.ok === false && /formatos/.test(sabr.error), `explica que no hay formatos (${sabr.error})`);

	const httpError = await run({
		ytInitialPlayerResponse: { playabilityStatus: { status: 'OK' }, videoDetails: {} },
		ytcfg: YT_CONFIG,
		fetch: async (url) => (isCdn(url) ? CDN_OK() : { ok: false, status: 429 }),
	});
	assert(httpError.ok === false && /HTTP 429/.test(httpError.error), 'informa de los errores HTTP de cada cliente');
};

const testSabrPage = async () => {
	console.log('\n6) Pagina en modo SABR: no tiene URLs, hay que usar la API interna');
	const sabrFormats = [
		{ itag: 315, mimeType: 'video/webm; codecs="vp9"', width: 1920, height: 1080, fps: 60, qualityLabel: '1080p60' },
		{ itag: 140, mimeType: 'audio/mp4; codecs="mp4a.40.2"', audioQuality: 'AUDIO_QUALITY_MEDIUM' },
	];

	const result = await run({
		ytInitialPlayerResponse: {
			playabilityStatus: { status: 'OK' },
			videoDetails: { videoId: '6VTFf6nMcHk', title: 'Video SABR' },
			streamingData: {
				serverAbrStreamingUrl: 'https://rr1---sn-video.googlevideo.com/ SABR',
				adaptiveFormats: sabrFormats,
			},
		},
		ytcfg: YT_CONFIG,
		fetch: async (url) => (isCdn(url) ? CDN_OK() : okFetch(url)),
	});

	assert(result.ok === true, 'no se rinde ante una pagina sin URLs y usa la API interna');
	assert(result.diag.sabr === true, 'detecta el modo SABR en la pagina');
	assert(result.formats.length > 5, `devuelve ${result.formats.length} formatos utilizables`);
	assert(result.formats.every((format) => format.url?.startsWith('https://')), 'todos con URL directa');
};

const testRadioAndDiagnostics = async () => {
	console.log('\n7) Radio (solo audio en la pagina) y diagnostico');
	const radioOnly = {
		playabilityStatus: { status: 'OK' },
		videoDetails: { title: '' },
		streamingData: {
			adaptiveFormats: [
				{
					itag: 251,
					url: 'https://rr1---sn-audio.googlevideo.com/audioless/radio.webm',
					mimeType: 'audio/webm; codecs="opus"',
					audioQuality: 'AUDIO_QUALITY_MEDIUM',
				},
			],
		},
	};

	const result = await run({
		ytInitialPlayerResponse: radioOnly,
		ytcfg: YT_CONFIG,
		fetch: async (url) => (isCdn(url) ? CDN_OK() : okFetch(url)),
	});

	assert(result.ok === true, 'una pagina de radio no evita obtener el video');
	assert(result.diag.origen === 'innertube', 'acaba usando la API interna');
	assert(result.formats.some((format) => format.kind === 'video'), 'devuelve formatos de video');
	assert(result.diag.formatosPagina === 1, 'cuenta los formatos de la pagina');
	assert(result.diag.videoEnPagina === false, 'detecta que la pagina solo tenia audio');
	assert(result.diag.innertube.client === 'ANDROID', 'anota el cliente que funciono');

	const fromMeta = await run({
		ytInitialPlayerResponse: null,
		ytcfg: YT_CONFIG,
		// Sin ?v= en la URL (radio reescrita): se saca el id de las etiquetas meta.
		location: { href: 'https://www.youtube.com/watch?list=RDxyz' },
		document: {
			title: 'YouTube',
			querySelector: (selector) =>
				selector === 'meta[itemprop="videoId"]' ? { getAttribute: () => 'dQw4w9WgXcQ' } : null,
		},
		fetch: async (url) => (isCdn(url) ? CDN_OK() : okFetch(url)),
	});

	assert(fromMeta.ok === true, 'encuentra el video aunque la URL no tenga el id');
	assert(fromMeta.diag.videoIdSource === 'meta', `anota de donde salio el id (${fromMeta.diag?.videoIdSource})`);
};

const testOneUselessFormat = async () => {
	console.log('\n8) Radio que solo expone UN formato (diagnostico real del usuario)');
	const oneFormatPage = {
		playabilityStatus: { status: 'OK' },
		videoDetails: { videoId: '6VTFf6nMcHk', title: 'Video de radio', author: 'Canal' },
		streamingData: {
			serverAbrStreamingUrl: 'https://rr1---sn-video.googlevideo.com/ SABR',
			adaptiveFormats: [
				{
					itag: 140,
					url: 'https://rr1---sn-audio.googlevideo.com/audioless/radio.m4a',
					mimeType: 'audio/mp4; codecs="mp4a.40.2"',
					audioQuality: 'AUDIO_QUALITY_MEDIUM',
					bitrate: 128000,
				},
			],
		},
	};

	const result = await run({
		ytInitialPlayerResponse: oneFormatPage,
		ytcfg: YT_CONFIG,
		fetch: async (url) => (isCdn(url) ? CDN_OK() : okFetch(url)),
	});

	assert(result.ok === true, 'no se queda con el unico formato de la radio');
	assert(result.diag.origen === 'innertube', `consulta innertube (${result.diag?.origen})`);
	assert(result.formats.length > 5, `devuelve la lista completa (${result.formats.length} formatos)`);
	assert(
		result.formats.every((format) => format.kind !== 'video' || format.height || format.qualityLabel),
		'descarta formatos de video sin resolucion',
	);
};

const testLiveUsesPage = async () => {
	console.log('\n9) Directo en curso: se usa la pagina y no se llama a innertube');
	let called = 0;
	const result = await run({
		ytInitialPlayerResponse: {
			playabilityStatus: { status: 'OK', liveStreamability: { liveStreamabilityRenderer: {} } },
			videoDetails: { videoId: 'abc123', title: 'Directo', isLiveContent: true },
			streamingData: { adaptiveFormats: playerResponse.streamingData.adaptiveFormats },
		},
		ytcfg: YT_CONFIG,
		fetch: async (url) => {
			if (isCdn(url)) return CDN_OK();
			called++;
			return okFetch(url);
		},
	});

	assert(result.ok === true, 'detecta el directo');
	assert(result.isLive === true, 'lo marca como directo');
	assert(called === 0, `no llama a innertube para un directo (${called} llamadas)`);
	assert(result.diag.origen === 'página', `indica que viene de la pagina (${result.diag?.origen})`);
};

const testExtractionIsReused = async () => {
	console.log('\n10) Abrir el popup otra vez no vuelve a pedir los streams');
	// Las URLs de YouTube traen un contador de uso: si cada apertura del popup
	// vuelve a pedirlas y a sondearlas, la CDN acaba respondiendo 403.
	let playerCalls = 0;
	const globals = {
		ytInitialPlayerResponse: {
			playabilityStatus: { status: 'OK' },
			videoDetails: { videoId: 'dQw4w9WgXcQ', title: 'Video de prueba', author: 'Canal' },
			streamingData: { adaptiveFormats: [] },
		},
		ytcfg: YT_CONFIG,
		fetch: async (url) => {
			if (isCdn(url)) return CDN_OK();
			playerCalls++;
			return okFetch(url);
		},
	};
	const context = vm.createContext({
		URL, JSON, Object, Number, Boolean, String, Array, Math, Promise, Error, console,
		AbortSignal, DOMException,
		location: { href: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' },
		document: { title: 'Video de prueba - YouTube', querySelector: () => null },
		...globals,
	});
	vm.runInContext(source, context);

	const primera = await context.__yumikoGetMedia();
	assert(primera.ok === true, 'la primera extracción va bien');
	assert(playerCalls > 0, `la primera pide streams (${playerCalls} llamadas)`);

	const llamadasTrasLaPrimera = playerCalls;
	const segunda = await context.__yumikoGetMedia();
	assert(playerCalls === llamadasTrasLaPrimera, `no vuelve a pedirlos (${playerCalls} llamadas)`);
	assert(segunda.diag.urlsReutilizadas === true, 'avisa de que reutiliza la extracción');
	assert(segunda.formats.length === primera.formats.length, 'devuelve los mismos formatos');

	const fresca = await context.__yumikoGetMedia({ fresh: true });
	assert(playerCalls > llamadasTrasLaPrimera, `con fresh: true sí los vuelve a pedir (${playerCalls} llamadas)`);
	assert(fresca.diag.urlsReutilizadas === undefined, 'la nueva no va marcada como reutilizada');
};

await testNormal();
await testFallback();
await testClientChain();
await testUrlValidation();
await testErrors();
await testSabrPage();
await testRadioAndDiagnostics();
await testOneUselessFormat();
await testLiveUsesPage();
await testExtractionIsReused();
console.log('\nTodo correcto.');