/**
 * Prueba del popup con un DOM real (jsdom): comprueba el flujo completo de la
 * interfaz, sobre todo el de "Solo audio", que es donde mÃ¡s han fallado las
 * cosas. Se simula chrome.tabs / chrome.runtime / chrome.storage.
 *
 * Uso: node scripts/test-popup.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(new URL('.', import.meta.url)));
const popupPath = path.join(root, 'extension/popup.html');
const mediaFile = path.join(root, 'scripts/fixtures/media.json');

const assert = (condition, message) => {
	if (!condition) throw new Error(`FALLO: ${message}`);
	console.log(`  ok  ${message}`);
};

const media = JSON.parse(fs.readFileSync(mediaFile, 'utf8'));

const sent = [];
const portMessages = [];
let storedSettings = {};
let mediaResult = media;

const startPopup = async ({ url = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', stored = {} } = {}) => {
	const html = fs.readFileSync(popupPath, 'utf8');
	const dom = new JSDOM(html, { url: 'https://extension.local/popup.html', pretendToBeVisual: true });
	const { window } = dom;

	global.window = window;
	global.document = window.document;
	// navigator es solo lectura en Node: se define con defineProperty.
	Object.defineProperty(globalThis, 'navigator', { value: window.navigator, configurable: true, writable: true });
	global.HTMLElement = window.HTMLElement;
	global.getSelection = window.getSelection.bind(window);
	global.Node = window.Node;
	global.Event = window.Event;
	global.MouseEvent = window.MouseEvent;

	storedSettings = stored;
	sent.length = 0;
	portMessages.length = 0;

	window.chrome = {
		runtime: {
			getManifest: () => ({ version: 'prueba' }),
			connect: () => ({
				name: 'yumiko',
				onMessage: { addListener: (fn) => (window.__onPortMessage = fn) },
				postMessage: (message) => portMessages.push(message),
				disconnect: () => {},
			}),
			sendMessage: async (message) => {
				sent.push(message);
				if (message.type === 'yumiko:getMedia') return mediaResult;
				if (message.type === 'yumiko:download') return { ok: true, filename: 'guardado.mp4' };
				return undefined;
			},
		},
		storage: {
			sync: {
				get: async (defaults) => ({ ...defaults, ...storedSettings }),
				set: async (patch) => Object.assign(storedSettings, patch),
			},
		},
		tabs: { query: async () => [{ id: 1, url }] },
		downloads: { showDefaultFolder: () => {} },
	};

	// El mÃ³dulo lee los globales de Node, asÃ­ que chrome tambiÃ©n va ahÃ­.
	global.chrome = window.chrome;

	// Cada import reevalÃºa el mÃ³dulo, que es justo lo que queremos.
	const bust = `?t=${Date.now()}${Math.random()}`;
	await import(`../extension/popup.js${bust}`);

	// init() es asÃ­ncrono: se le da un turno al bucle de eventos.
	await new Promise((resolve) => setTimeout(resolve, 60));
	return window;
};

const click = (window, element) => {
	element.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
};

const lastDownload = () => sent.filter((message) => message.type === 'yumiko:download').at(-1)?.request;

console.log('\n1) Carga con un vÃ­deo normal');
const win = await startPopup();
assert(win.document.getElementById('download').disabled === false, 'el botÃ³n Descargar queda activo');
assert(win.document.querySelectorAll('#video-list .choice').length >= 5, `lista resoluciones (${win.document.querySelectorAll('#video-list .choice').length})`);
assert(win.document.querySelectorAll('#audio-list .choice').length >= 2, `lista de audio (${win.document.querySelectorAll('#audio-list .choice').length})`);
assert(win.document.getElementById('diagnostics').hidden === false, 'el diagnÃ³stico estÃ¡ disponible');

console.log('\n2) PestaÃ±a "Solo audio"');
const audioTab = win.document.querySelector('.tab[data-mode="audio"]');
assert(
	/Yumiko\s*\/\s*Videos/.test(win.document.getElementById('destination-text').textContent),
	`muestra la carpeta de vÃ­deo (${win.document.getElementById('destination-text').textContent})`,
);
click(win, audioTab);
assert(win.document.getElementById('audio-pane').hidden === false, 'muestra el panel de audio');
assert(win.document.getElementById('video-pane').hidden === true, 'oculta el panel de vÃ­deo');
assert(audioTab.classList.contains('is-active'), 'marca la pestaÃ±a activa');
assert(win.document.getElementById('bitrate-row').hidden === false, 'muestra la calidad del MP3');
assert(
	/Yumiko\s*\/\s*Audio/.test(win.document.getElementById('destination-text').textContent),
	`cambia la carpeta mostrada al audio (${win.document.getElementById('destination-text').textContent})`,
);

console.log('\n3) Descargar MP3');
const mp3Row = win.document.querySelector('#audio-list .choice[data-value="mp3"]');
assert(Boolean(mp3Row), 'existe la opciÃ³n MP3');
click(win, mp3Row);
assert(mp3Row.querySelector('input').checked === true, 'la opciÃ³n MP3 queda marcada');
click(win, win.document.getElementById('download'));
await new Promise((resolve) => setTimeout(resolve, 30));

const mp3Request = lastDownload();
assert(Boolean(mp3Request), 'envÃ­a la peticiÃ³n de descarga');
assert(mp3Request.kind === 'mp3', `tipo de trabajo (${mp3Request.kind})`);
assert(mp3Request.extension === 'mp3', `extensiÃ³n (${mp3Request.extension})`);
assert(mp3Request.bitrate === 192, `bitrate (${mp3Request.bitrate})`);
assert(Array.isArray(mp3Request.audioUrls) && mp3Request.audioUrls.length >= 3, `envÃ­a ${mp3Request.audioUrls?.length} pistas de audio`);
assert(/^https:\/\//.test(mp3Request.audioUrls[0]), 'las URLs son directas');
assert(mp3Request.fallback?.url, 'incluye plan B con el audio original');
assert(mp3Request.folder === 'Yumiko/Audio', `carpeta de audio (${mp3Request.folder})`);
// El archivo del MP3 se llama solo con el título del vídeo.
assert(mp3Request.title === media.title, `lleva el título del vídeo (${mp3Request.title})`);
assert(!mp3Request.suffix, `sin sufijo en el nombre ("${mp3Request.suffix}")`);
assert(win.document.getElementById('progress-box').hidden === false, 'muestra el progreso');

console.log('\n4) M4A y Opus originales');
const m4aRow = win.document.querySelector('#audio-list .choice[data-value="m4a"]');
click(win, m4aRow);
click(win, win.document.getElementById('download'));
await new Promise((resolve) => setTimeout(resolve, 30));
const m4a = lastDownload();
assert(m4a.kind === 'direct', 'el M4A se descarga directamente');
assert(m4a.extension === 'm4a', `extensiÃ³n (${m4a.extension})`);
const aacTrack = media.formats.find((format) => format.itag === 140);
assert(m4a.url === aacTrack.url, 'usa la pista AAC original (itag 140)');

const opusRow = win.document.querySelector('#audio-list .choice[data-value="opus"]');
if (opusRow) {
	click(win, opusRow);
	click(win, win.document.getElementById('download'));
	await new Promise((resolve) => setTimeout(resolve, 30));
	const opus = lastDownload();
	const opusTrack = media.formats.find((format) => format.itag === 251);
	assert(opus.url === opusTrack.url, 'usa la pista Opus original (itag 251)');
	assert(opus.kind === 'direct' && opus.extension === 'webm', 'el Opus se descarga como WebM directo');
}

console.log('\n5) Volver a VÃ­deo: calidad y uniÃ³n con audio');
click(win, win.document.querySelector('.tab[data-mode="video"]'));
const videoRows = win.document.querySelectorAll('#video-list .choice');
click(win, videoRows[0]);
click(win, win.document.getElementById('download'));
await new Promise((resolve) => setTimeout(resolve, 30));
const videoRequest = lastDownload();
assert(['mux', 'direct'].includes(videoRequest.kind), `descarga de vÃ­deo (${videoRequest.kind})`);
assert(videoRequest.folder === 'Yumiko/Videos', `carpeta de vÃ­deo (${videoRequest.folder})`);
if (videoRequest.kind === 'mux') {
	assert(videoRequest.container === 'mp4' || videoRequest.container === 'webm', `contenedor (${videoRequest.container})`);
	assert(Boolean(videoRequest.videoUrl && videoRequest.audioUrl), 'envÃ­a ambos streams');
}

console.log('\n6) Carpetas personalizadas y "preguntar dÃ³nde guardar"');
const win2 = await startPopup({ stored: { videoFolder: 'Series/HD', audioFolder: 'Musica', askWhereToSave: true, mp3Bitrate: 320 } });
assert(win2.document.getElementById('video-folder').value === 'Series/HD', 'recoge la carpeta de vÃ­deo guardada');
assert(win2.document.getElementById('audio-folder').value === 'Musica', 'recoge la carpeta de audio guardada');
assert(win2.document.getElementById('mp3-bitrate').value === '320', 'recoge el bitrate guardado');
click(win2, win2.document.querySelector('.tab[data-mode="audio"]'));
click(win2, win2.document.querySelector('#audio-list .choice[data-value="mp3"]'));
click(win2, win2.document.getElementById('download'));
await new Promise((resolve) => setTimeout(resolve, 30));
const custom = lastDownload();
assert(custom.folder === 'Musica', `usa la carpeta de audio (${custom.folder})`);
assert(custom.saveAs === true, 'pide dÃ³nde guardar');
assert(custom.bitrate === 320, `usa el bitrate guardado (${custom.bitrate})`);

console.log('\n7) Cuando no hay pista de audio suelta se usa el vídeo');
// Los streams de solo audio serejectan con 403: el origen del MP3 pasa a ser el
// archivo progresivo (vídeo + audio), del que se extrae solo el sonido.
const soloVideo = media.formats.filter((format) => format.kind !== 'audio');
const conProgresivo = soloVideo.some((format) => format.kind === 'muxed');
mediaResult = { ...media, formats: soloVideo };
const win3 = await startPopup();
click(win3, win3.document.querySelector('.tab[data-mode="audio"]'));
if (conProgresivo) {
	const mp3Fila = win3.document.querySelector('#audio-list .choice[data-value="mp3"]');
	assert(Boolean(mp3Fila), 'ofrece MP3 aunque no haya audio suelto');
	assert(
		mp3Fila.textContent.includes('Extraído del vídeo'),
		`explica que el sonido sale del vídeo (${mp3Fila.textContent.trim()})`,
	);
	click(win3, mp3Fila);
	click(win3, win3.document.getElementById('download'));
	await new Promise((resolve) => setTimeout(resolve, 30));
	const desdeVideo = sent.filter((message) => message.type === 'yumiko:download').at(-1)?.request;
	const progresivo = media.formats.find((format) => format.kind === 'muxed');
	assert(desdeVideo.audioUrls.includes(progresivo.url), 'envía el vídeo completo como origen del MP3');
	assert(desdeVideo.kind === 'mp3', `sigue siendo una conversión a MP3 (${desdeVideo.kind})`);
	assert(Boolean(desdeVideo.fallback?.url), 'el plan B apunta al origen real');
} else {
	assert(
		win3.document.getElementById('audio-list').textContent.includes('no tiene pista de audio'),
		'avisa de que no hay audio',
	);
	click(win3, win3.document.getElementById('download'));
	await new Promise((resolve) => setTimeout(resolve, 30));
	assert(win3.document.getElementById('status').className.includes('error'), 'muestra un error claro');
}
mediaResult = media;

console.log('\n8) PÃ¡gina que no es de YouTube');
const win4 = await startPopup({ url: 'https://example.com/' });
assert(win4.document.getElementById('notice').hidden === false, 'avisa de que no es YouTube');
assert(win4.document.getElementById('download').disabled === true, 'no habilita la descarga');

console.log('\n9) El extractor devuelve error');
mediaResult = { ok: false, error: 'No se han podido obtener los formatos.', diag: { sabr: true } };
const win5 = await startPopup();
assert(win5.document.getElementById('notice').textContent.includes('formatos'), 'enseÃ±a el error');
assert(win5.document.getElementById('diagnostics-text').textContent.includes('sabr: true'), 'el diagnÃ³stico incluye los datos');

console.log('\n10) El diagnÃ³stico recoge la Ãºltima descarga');
mediaResult = media;
const win6 = await startPopup();
click(win6, win6.document.querySelector('.tab[data-mode="audio"]'));
click(win6, win6.document.querySelector('#audio-list .choice[data-value="mp3"]'));
// La respuesta falla, como si el navegador no pudiera procesar el MP3.
window.chrome.runtime.sendMessage = async (message) => {
	if (message.type === 'yumiko:getMedia') return media;
	if (message.type === 'yumiko:download') return { ok: false, error: 'No se ha podido convertir a MP3 (prueba de estado)' };
	return undefined;
};
click(win6, win6.document.getElementById('download'));
await new Promise((resolve) => setTimeout(resolve, 40));
assert(win6.document.getElementById('status').textContent.includes('MP3'), 'muestra el error en rojo');
win6.document.getElementById('diagnostics').hidden = false;
win6.document.getElementById('diagnostics').dispatchEvent(new window.Event('toggle'));
const diagText = win6.document.getElementById('diagnostics-text').textContent;
assert(diagText.includes('tipo: mp3'), `el diagnÃ³stico dice el tipo de trabajo (${diagText.split('\n').pop()})`);
assert(diagText.includes('carpeta: Yumiko/Audio'), 'el diagnÃ³stico dice la carpeta');
assert(diagText.includes('estado: fallido'), 'el diagnÃ³stico dice el estado');

console.log('\n11) El plan B: si el MP3 falla, se guarda el audio original');
{
	mediaResult = media;
	const winB = await startPopup();
	click(winB, winB.document.querySelector('.tab[data-mode="audio"]'));
	click(winB, winB.document.querySelector('#audio-list .choice[data-value="mp3"]'));
	// Lo que devuelve el service worker cuando el procesado falló pero se guardó el original.
	winB.chrome.runtime.sendMessage = async (message) => {
		if (message.type === 'yumiko:getMedia') return media;
		if (message.type === 'yumiko:download') {
			return {
				ok: true,
				fallback: true,
				filename: 'Yumiko/Audio/T [audio original].m4a',
				note: 'No se ha podido convertir a MP3',
			};
		}
		return undefined;
	};
	click(winB, winB.document.getElementById('download'));
	await new Promise((resolve) => setTimeout(resolve, 40));
	const status = winB.document.getElementById('status');
	assert(status.textContent.includes('audio original'), `avisa de que se guardó el original (${status.textContent})`);
	assert(status.textContent.includes('MP3'), 'explica que no se pudo convertir a MP3');
	assert(winB.document.getElementById('download').disabled === false, 'vuelve a habilitar el botón Descargar');
	assert(winB.document.getElementById('progress-box').hidden === true, 'oculta la barra de progreso');
}

console.log('\n12) La pestaña de miniaturas abre el estudio');
{
	mediaResult = media;
	const winT = await startPopup();
	const thumbsTab = winT.document.querySelector('.tab[data-mode="thumbs"]');
	click(winT, thumbsTab);
	assert(winT.document.getElementById('thumbs-pane').hidden === false, 'muestra el panel de miniaturas');
	assert(winT.document.getElementById('video-pane').hidden === true, 'oculta el panel de vídeo');
	assert(winT.document.getElementById('download').hidden === true, 'oculta el botón Descargar');
	assert(thumbsTab.classList.contains('is-active'), 'marca la pestaña activa');
	assert(Boolean(winT.document.getElementById('open-thumbs')), 'ofrece el botón para abrir el estudio');
	assert(!winT.document.getElementById('thumb-scale'), 'ya no están los controles antiguos de escalado');
	assert(!winT.document.getElementById('thumb-folder'), 'la carpeta de miniaturas la edita el estudio');

	// El botón pide al service worker que abra el estudio, con el vídeo ya detectado.
	let openPayload = null;
	winT.chrome.runtime.sendMessage = async (message) => {
		if (message.type === 'yumiko:getMedia') return media;
		if (message.type === 'yumiko:openThumbs') {
			openPayload = message.payload;
			return { ok: true };
		}
		return undefined;
	};
	click(winT, winT.document.getElementById('open-thumbs'));
	await new Promise((resolve) => setTimeout(resolve, 30));
	assert(openPayload !== null, 'pide abrir el estudio al service worker');
	assert(openPayload?.videoId === media.videoId, `pasa el id del vídeo (${openPayload?.videoId})`);
	assert(openPayload?.videoTitle === media.title, 'pasa el título para no volver a buscarlo');
}

console.log('\n13) Si el estudio no se puede abrir, lo dice');
{
	const winU = await startPopup();
	click(winU, winU.document.querySelector('.tab[data-mode="thumbs"]'));
	winU.chrome.runtime.sendMessage = async (message) => {
		if (message.type === 'yumiko:getMedia') return media;
		if (message.type === 'yumiko:openThumbs') return { ok: false, reason: 'Recarga la página de YouTube y vuelve a intentarlo.' };
		return undefined;
	};
	click(winU, winU.document.getElementById('open-thumbs'));
	await new Promise((resolve) => setTimeout(resolve, 30));
	const notice = winU.document.getElementById('notice');
	assert(notice.hidden === false && /recarga/i.test(notice.textContent), `avisa del problema (${notice.textContent})`);
	assert(winU.document.getElementById('open-thumbs').disabled === false, 'deja reintentar');
}

console.log('\nTodo correcto.');