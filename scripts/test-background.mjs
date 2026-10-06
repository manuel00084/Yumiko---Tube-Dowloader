/**
 * Prueba del service worker (extension/background.js) con un chrome simulado:
 * el nombre del archivo, el guardado del blob de la página y, sobre todo, el
 * plan B: si el procesado falla, se guarda el audio original en lugar de perder
 * la descarga entera.
 *
 * Uso: node scripts/test-background.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(new URL('.', import.meta.url)));

// Carga el service worker con un chrome simulado para probar el flujo de verdad:
// getMedia, descarga con plan B, cancelación y errores.
const sent = [];
const downloads = [];
const tabMessages = [];
// Peticiones de streams nuevas que ha hecho el service worker al reintentar.
const refreshes = [];
// Trabajos que ha llegado a ejecutar en la página, en orden.
const jobsSent = [];
let currentTab = { id: 42, url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' };
let failContentScript = false;
let failDownload = false;
// La página simulada recuerda qué módulo se le ha inyectado, como la real.
let injectedKind = null;

const makeWorker = async () => {
	const listeners = { message: [], connect: [] };
	const port = {
		postMessage: (m) => sent.push(m),
		onDisconnect: { addListener() {} },
	};

	const chrome = {
		runtime: {
			id: 'prueba',
			getManifest: () => ({ version: 'prueba' }),
			getURL: (p) => `chrome-extension://prueba/${p}`,
			onMessage: { addListener: (fn) => listeners.message.push(fn) },
			onConnect: { addListener: (fn) => listeners.connect.push(fn) },
			sendMessage: async (message) => {
				if (message.type === 'yumiko:ping') return undefined;
				throw new Error('offscreen no disponible en el test');
			},
		},
		offscreen: { hasDocument: async () => false, createDocument: async () => {}, closeDocument: async () => {} },
		downloads: {
			download: async (options) => {
				downloads.push(options);
				if (failDownload) throw new Error('no se puede guardar la URL de la pagina');
				return downloads.length;
			},
			search: async () => [{ id: downloads.length, state: 'complete', filename: 'guardado.bin', totalBytes: 1234 }],
			onChanged: { addListener() {}, removeListener() {} },
			cancel: async () => {},
		},
		tabs: {
			query: async () => [currentTab],
			sendMessage: async (tabId, message) => {
				tabMessages.push({ tabId, message });
				if (failContentScript) throw new Error('no hay receptor');
				return { ok: true };
			},
		},
		scripting: {
			executeScript: async ({ func, args, files }) => {
				if (typeof func !== 'function') {
					injectedKind = files?.[0]?.includes('video') ? 'video' : 'audio';
					return [{ result: undefined }];
				}
				// pageCall: se simula el processor de la página.
				if (func.toString().includes('__yumikoProcess')) {
					jobsSent.push(args?.[0]);
					// Un 403 de la CDN solo en el primer intento: sirve para ver el reintento.
					if (globalThis.__fail403Once > 0) {
						globalThis.__fail403Once--;
						return [
							{ result: { ok: false, error: { name: 'Error', message: 'YouTube rechazó la petición del stream (403).' } } },
						];
					}
					if (globalThis.__failProcess) {
						return [{ result: { ok: false, error: { name: 'Error', message: 'No se ha podido convertir a MP3 (simulado)' } } }];
					}
					// simula una inyección perdida: la página no devuelve nada.
					if (globalThis.__loseInjection > 0) {
						globalThis.__loseInjection--;
						return [{ result: undefined }];
					}
					return [
						{ result: { ok: true, value: { url: 'blob:https://youtube.com/x', size: 999, mimeType: 'video/mp4' } } },
					];
				}
				if (func.toString().includes('__yumikoGetMedia')) {
					refreshes.push(args?.[0]);
					return [
						{
							result: {
								ok: true,
								formats: [
									{ itag: 137, kind: 'video', url: 'https://x/video-nuevo.mp4' },
									{ itag: 140, kind: 'audio', url: 'https://x/audio-nuevo.m4a' },
									{ itag: 251, kind: 'audio', url: 'https://x/audio-nuevo.webm' },
								],
							},
						},
					];
				}
				if (func.toString().includes('__yumikoRelease')) return [{ result: true }];
				if (func.toString().includes('__yumikoProgress')) return [{ result: null }];
				if (func.toString().includes('__yumikoReady')) return [{ result: { ready: true, kind: injectedKind } }];
				if (func.toString().includes('__yumikoCancel')) return [{ result: false }];
				return [{ result: {} }];
			},
		},
	};

	const context = vm.createContext({
		chrome,
		crypto,
		console,
		URL,
		Blob,
		setTimeout,
		clearTimeout,
		setInterval,
		clearInterval,
		structuredClone,
	});

	// shared.js es un módulo ES: se evalua en el mismo contexto y sus exports
	// se exposurean como constantes, que es lo que hace el import de background.js.
	const sharedSource = fs.readFileSync(path.join(root, 'extension/shared.js'), 'utf8').replace(/^export\s+/gm, '');
	vm.runInContext(sharedSource, context, { filename: 'shared.js' });

	const source = fs.readFileSync(path.join(root, 'extension/background.js'), 'utf8')
		.replace(/^import\s.*$/gm, '')
		.replace(/^export\s+/gm, '');
	vm.runInContext(source, context, { filename: 'background.js' });

	const call = (message) =>
		new Promise((resolve) => {
			for (const listener of listeners.message) {
				const result = listener(message, {}, resolve);
				if (result === true) return;
			}
			resolve(undefined);
		});

	return { call, port };
};

let fails = 0;
const assert = (cond, msg) => {
	if (cond) console.log(`  ok  ${msg}`);
	else {
		fails++;
		console.log(`  FALLA ${msg}`);
	}
};

console.log('\n1) Descarga procesada normal');
{
	sent.length = 0;
	downloads.length = 0;
	failDownload = false;
	const { call, port } = await makeWorker();
	for (const l of []) void l;
	const response = await call({ type: 'yumiko:download', request: { kind: 'mp3', tabId: 7, title: 'T', author: 'A', extension: 'mp3', suffix: 'MP3 192k', folder: 'Yumiko/Audio', audioUrls: ['https://x/1.m4a'] } });
	assert(response?.ok === true, `guarda el archivo (${response?.filename})`);
	assert(downloads[0]?.url === 'blob:https://youtube.com/x', 'usa la URL de la página');
	assert(downloads[0]?.filename?.endsWith('.mp3'), `nombre con extensión (${downloads[0]?.filename})`);
}

console.log('\n2) Si el procesado falla, se guarda el plan B (audio original)');
{
	sent.length = 0;
	downloads.length = 0;
	failDownload = false;
	globalThis.__failProcess = true;
	const { call } = await makeWorker();
	const response = await call({
		type: 'yumiko:download',
		request: {
			kind: 'mp3', tabId: 7, title: 'T', author: 'A', extension: 'mp3', suffix: 'MP3 192k',
			folder: 'Yumiko/Audio', audioUrls: ['https://x/1.m4a'],
			fallback: { url: 'https://x/orig.m4a', extension: 'm4a', suffix: 'audio original' },
		},
	});
	globalThis.__failProcess = false;
	assert(response?.ok === true, `responde con éxito (${response?.filename})`);
	assert(response?.fallback === true, 'marca que se guardó el original');
	assert(/convertir a MP3/.test(response?.note || ''), `explica por qué (${response?.note})`);
	assert(downloads.at(-1)?.url === 'https://x/orig.m4a', 'descarga el audio original directamente');
	assert(downloads.at(-1)?.filename?.endsWith('.m4a'), `con su extensión (${downloads.at(-1)?.filename})`);
}

console.log('\n3) Sin plan B, el error se propaga');
{
	downloads.length = 0;
	globalThis.__failProcess = true;
	const { call } = await makeWorker();
	const response = await call({ type: 'yumiko:download', request: { kind: 'mp3', tabId: 7, title: 'T', audioUrls: ['https://x/1.m4a'] } });
	globalThis.__failProcess = false;
	assert(response?.ok === false, `devuelve error (${response?.error})`);
}

console.log('\n4) El respaldo por bytes cuando la página no se puede guardar');
{
	downloads.length = 0;
	failDownload = true;
	const { call } = await makeWorker();
	const response = await call({ type: 'yumiko:download', request: { kind: 'direct', tabId: 7, title: 'T', url: 'https://x/a.mp4', extension: 'mp4' } });
	failDownload = false;
	// El respaldo necesita el offscreen, que este test no tiene: debe fallar claro.
	assert(response?.ok === false, `avisa con un mensaje claro (${response?.error})`);
}

console.log('\n5) El nombre del vídeo: título, códec y extensión');
{
	downloads.length = 0;
	failDownload = false;
	const { call } = await makeWorker();
	await call({
		type: 'yumiko:download',
		request: {
			kind: 'mux', tabId: 7, title: 'Mi vídeo', suffix: '1080p', codec: 'H.264',
			extension: 'mp4', container: 'mp4', videoUrl: 'https://x/v', audioUrl: 'https://x/a',
			folder: 'Yumiko/Videos',
		},
	});
	const guardado = downloads[0]?.filename || '';
	assert(guardado === 'Yumiko/Videos/Mi vídeo - 1080p H.264.mp4', `nombre del vídeo (${guardado})`);
}

console.log('\n6) Un nombre sin extensión nunca llega a Chrome');
{
	downloads.length = 0;
	failDownload = false;
	const { call } = await makeWorker();
	// Sin extensión Chrome la deduce del tipo MIME del blob y acaba en .txt.
	await call({ type: 'yumiko:download', request: { kind: 'direct', title: 'T', url: 'https://x/a.mp4', filename: 'Yumiko/Videos/T' } });
	const guardado = downloads[0]?.filename || '';
	assert(/\.[a-z0-9]{1,5}$/i.test(guardado), `siempre con extensión (${guardado})`);
	assert(guardado.endsWith('.mp4'), `y con la del vídeo (${guardado})`);
}

console.log('\n7) Abrir el estudio de miniaturas');{
	tabMessages.length = 0;
	failContentScript = false;
	currentTab = { id: 42, url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' };
	const { call } = await makeWorker();
	const reply = await call({ type: 'yumiko:openThumbs', payload: { videoId: 'dQw4w9WgXcQ', videoTitle: 'T' } });
	assert(reply?.ok === true, 'abre el estudio en la pestaña activa');
	assert(tabMessages.length === 1, `un solo intento (${tabMessages.length} mensajes)`);
	assert(tabMessages[0].message.ns === 'yumiko-thumbs', `con el espacio de nombres correcto (${tabMessages[0].message.ns})`);
	assert(tabMessages[0].message.type === 'open', 'pide abrirlo');
	assert(tabMessages[0].message.payload.videoId === 'dQw4w9WgXcQ', 'pasa el vídeo detectado');
}

console.log('\n8) Si la página pierde la inyección, se reintenta');
{
	downloads.length = 0;
	failDownload = false;
	globalThis.__loseInjection = 1;
	const { call } = await makeWorker();
	const response = await call({
		type: 'yumiko:download',
		request: {
			kind: 'mux', tabId: 7, title: 'Mi vídeo', suffix: '1080p', codec: 'H.264',
			extension: 'mp4', container: 'mp4', videoUrl: 'https://x/v', audioUrl: 'https://x/a',
			folder: 'Yumiko/Videos',
		},
	});
	globalThis.__loseInjection = 0;
	assert(response?.ok === true, `reintenta y guarda (${response?.error || response?.filename})`);
	assert(downloads.length === 1, `no descarga dos veces (${downloads.length})`);
}

console.log('\n9) Si la CDN responde 403, pide streams nuevos y reintenta');
{
	downloads.length = 0;
	refreshes.length = 0;
	jobsSent.length = 0;
	failDownload = false;
	globalThis.__fail403Once = 1;
	const { call } = await makeWorker();
	const response = await call({
		type: 'yumiko:download',
		request: {
			kind: 'mp3', tabId: 7, title: 'Mi canción', suffix: 'MP3 192k', extension: 'mp3', bitrate: 192,
			audioUrls: ['https://x/viejo.m4a'], audioItags: [140, 251], folder: 'Yumiko/Audio',
		},
	});
	globalThis.__fail403Once = 0;
	assert(response?.ok === true, `acaba guardando (${response?.error || response?.filename})`);
	assert(refreshes.length === 1, `pide los streams una vez (${refreshes.length})`);
	assert(refreshes[0]?.fresh === true, `pidiendo URLs nuevas (${JSON.stringify(refreshes[0])})`);
	assert(jobsSent[0]?.audioUrls?.[0] === 'https://x/viejo.m4a', 'el primer intento usa la URL vieja');
	assert(
		jobsSent[1]?.audioUrls?.join() === 'https://x/audio-nuevo.m4a,https://x/audio-nuevo.webm',
		`el reintento usa las nuevas y en el mismo orden (${jobsSent[1]?.audioUrls?.join()})`,
	);
	assert(downloads.length === 1, `guarda una sola vez (${downloads.length})`);
}

console.log('\n10) Si la pestaña no es de YouTube, no lo intenta');{
	tabMessages.length = 0;
	currentTab = { id: 42, url: 'https://example.com/' };
	const { call } = await makeWorker();
	const reply = await call({ type: 'yumiko:openThumbs', payload: {} });
	assert(reply?.ok === false, 'informa de que no se puede');
	assert(/YouTube/.test(reply?.reason || ''), `lo dice claro (${reply?.reason})`);
	assert(tabMessages.length === 0, 'no manda ningún mensaje a la página');
}

console.log('\n11) Si el content script no está listo, reintenta y avisa');
{
	tabMessages.length = 0;
	failContentScript = true;
	currentTab = { id: 42, url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' };
	const { call } = await makeWorker();
	const reply = await call({ type: 'yumiko:openThumbs', payload: {} });
	failContentScript = false;
	assert(reply?.ok === false, 'informa del fallo');
	assert(/recarga/i.test(reply?.reason || ''), `pide recargar la página (${reply?.reason})`);
	assert(tabMessages.length === 6, `lo intenta varias veces (${tabMessages.length} intentos)`);
}

console.log(fails ? `\n${fails} fallo(s).` : '\nTodo correcto.');
process.exit(fails ? 1 : 0);
