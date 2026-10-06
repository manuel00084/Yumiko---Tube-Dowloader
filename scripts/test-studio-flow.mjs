/**
 * Ejecuta el studio.js real contra el studio.html real, en jsdom, y comprueba
 * el flujo completo: el popup manda el vídeo, el estudio lo adopta y la rejilla
 * se llena con las miniaturas que existen de verdad.
 *
 * Este test nació de un fallo real: al adoptar el id que envía el popup, la
 * comparación que decidía si había que buscar miniaturas daba siempre "igual",
 * así que la rejilla se quedaba vacía sin explicación.
 *
 * Uso: node scripts/test-studio-flow.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import { build } from 'esbuild';
import { pathToFileURL, fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(new URL('.', import.meta.url)));
const appDir = path.join(root, 'extension/thumbs/app');
const outFile = path.join(root, '.test-build', 'studio.under-test.mjs');

let failures = 0;
const assert = (condition, message) => {
	if (condition) console.log(`  ok  ${message}`);
	else {
		failures++;
		console.log(`  FALLA ${message}`);
	}
};

// El studio se sirve como módulo del iframe, así que se empaqueta igual que en
// el navegador para poder importarlo con sus imports resueltos.
await build({
	entryPoints: [path.join(appDir, 'studio.js')],
	outfile: outFile,
	bundle: true,
	format: 'esm',
	platform: 'neutral',
	target: 'chrome116',
	logLevel: 'error',
});

// Solo existen dos de las 25 rutas que sondea YouTube para este vídeo.
const EXISTEN = { maxresdefault: [1280, 720], hqdefault: [480, 360] };

const startStudio = async ({ videoId = 'dQw4w9WgXcQ', videoTitle = 'Video de prueba', href } = {}) => {
	const html = fs.readFileSync(path.join(appDir, 'studio.html'), 'utf8');
	const dom = new JSDOM(html, { url: 'https://www.youtube.com/watch?v=' + videoId, pretendToBeVisual: true });
	const { window } = dom;

	// Lo que hace el popup:plica el contexto y espera a que la rejilla se llene.
	const post = (payload) =>
		window.dispatchEvent(
			new window.MessageEvent('message', {
				data: { ns: 'yumiko-thumbs', type: 'context', payload },
			}),
		);

	const settings = { ...DEFAULTS_FOR_TEST };

	window.chrome = {
		runtime: {
			id: 'prueba',
			getURL: (p) => `chrome-extension://prueba/${p}`,
			getManifest: () => ({ version: 'prueba' }),
		},
		storage: {
			local: {
				get: async () => ({}),
				set: async (patch) => Object.assign(settings, patch[yumikoKey] || {}),
			},
			onChanged: { addListener: () => {}, removeListener: () => {} },
		},
		downloads: { download: (_options, done) => done?.(1) },
	};
	globalThis.chrome = window.chrome;

	// Red: i.ytimg.com responde 404 para lo que no existe.
	globalThis.fetch = async (input) => {
		const name = String(input).split('/').pop().replace('.jpg', '');
		if (!EXISTEN[name]) return { ok: false, status: 404 };
		const blob = new window.Blob([new Uint8Array(64)]);
		blob.__name = name;
		return { ok: true, status: 200, blob: async () => blob };
	};
	globalThis.createImageBitmap = async (blob) => {
		const [width, height] = EXISTEN[blob?.__name] || [0, 0];
		return { width, height, close: () => {} };
	};
	globalThis.Blob = window.Blob;

	// El módulo usa window/document como globales, igual que en el iframe.
	global.window = window;
	global.document = window.document;
	global.HTMLElement = window.HTMLElement;
	global.Image = window.Image;
	global.Node = window.Node;
	global.ImageData = window.ImageData;
	global.getSelection = window.getSelection.bind(window);
	global.DOMException = window.DOMException ?? DOMException;
	Object.defineProperty(globalThis, 'navigator', { value: window.navigator, configurable: true, writable: true });

	await import(`${pathToFileURL(outFile).href}?t=${Date.now()}${Math.random()}`);
	// El estudio avisa de que está listo; el puente responde vaciando la cola.
	window.dispatchEvent(
		new window.MessageEvent('message', { data: { ns: 'yumiko-thumbs', type: 'ready' } }),
	);
	return { window, post, dom };
};

const DEFAULTS_FOR_TEST = {
	format: 'png',
	quality: 1,
	upscaler: 'lanczos',
	scale: 2,
	targetWidth: 1920,
	aiModel: 'light',
	lanczosStrength: 3,
	gammaCorrect: true,
	sharpen: 0.35,
	trimBars: false,
	crop169: false,
	folderPrefix: 'Yumiko/Miniaturas/',
	filenameTemplate: '{title}_{w}x{h}_{source}',
	zipBatch: true,
	showFloatingButton: true,
	probePageImages: false,
	maxPageImages: 200,
};
const yumikoKey = 'yumikoThumbs.settings';

const settle = (ms = 120) => new Promise((resolve) => setTimeout(resolve, ms));

console.log('\n1) El popup manda el vídeo y el estudio busca sus miniaturas');
{
	const { window, post } = await startStudio();
	assert(
		window.document.getElementById('panel').style.display === '',
		'al abrirse, el panel se muestra',
	);

	post({ href: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', videoId: 'dQw4w9WgXcQ', videoTitle: 'Video de prueba', candidates: [] });
	await settle(300);

	const cards = window.document.querySelectorAll('#grid .card');
	assert(cards.length === 2, `la rejilla se llena con las ${cards.length} miniaturas que existen (de 25 rutas)`);
	assert(
		!window.document.getElementById('summary').textContent.includes('Buscando'),
		'deja de decir que está buscando',
	);
	assert(window.document.getElementById('pageSub').textContent !== '', `muestra el vídeo (${window.document.getElementById('pageSub').textContent})`);
	// Si el subtítulo se queda en "Buscando…" parece que nunca termina.
	const sub = window.document.getElementById('pageSub').textContent;
	assert(!/Buscando/.test(sub), `el subtítulo ya no dice "Buscando" (${sub})`);
	assert(/2 miniaturas/.test(sub), `y dice cuántas ha encontrado (${sub})`);
}

console.log('\n2) Las tarjetas muestran la resolución y el grupo');
{
	const { window, post } = await startStudio();
	post({ href: '', videoId: 'dQw4w9WgXcQ', videoTitle: 'Video de prueba', candidates: [] });
	await settle(300);

	const first = window.document.querySelector('#grid .card');
	assert(first.querySelector('.meta b').textContent === '1280×720', `la resolución va en la tarjeta (${first.querySelector('.meta b').textContent})`);
	assert(first.querySelector('.name').textContent.length > 0, `con su nombre (${first.querySelector('.name').textContent})`);
	assert(first.querySelector('img').src.includes('i.ytimg.com'), 'con la imagen cargada desde i.ytimg.com');
	assert(first.querySelector('.tag').textContent.length > 0, `y su etiqueta (${first.querySelector('.tag').textContent})`);
}

console.log('\n3) El título del popup se usa para nombrar, sin volver a buscarlo');
{
	const { window, post } = await startStudio();
	post({ href: '', videoId: 'dQw4w9WgXcQ', videoTitle: 'Mi vídeo favorito', candidates: [] });
	await settle(300);
	// Sin red hacia youtube.com: si intentara buscar el título, no lo obtendría.
	assert(
		/Video de prueba|Mi vídeo favorito/.test(window.document.getElementById('log').textContent) ||
			window.document.querySelectorAll('#grid .card').length === 2,
		'funciona aunque la página de watch no esté accesible',
	);
	const log = window.document.getElementById('log').textContent;
	assert(/dQw4w9WgXcQ: 2 miniaturas/.test(log), `lo dice en el registro (${log.split('\n')[0]})`);
}

console.log('\n4) Sin id en el contexto, lo saca de la URL');
{
	const { window, post } = await startStudio();
	post({ href: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=30', candidates: [] });
	await settle(300);
	assert(window.document.querySelectorAll('#grid .card').length === 2, 'busca igualmente las miniaturas');
}

console.log('\n5) Un vídeo sin miniaturas avisa en vez de quedarse en blanco');
{
	const { window, post } = await startStudio();
	globalThis.fetch = async () => ({ ok: false, status: 404 });
	post({ href: '', videoId: 'dQw4w9WgXcQ', videoTitle: 'T', candidates: [] });
	await settle(300);
	const grid = window.document.getElementById('grid').textContent;
	assert(/no hay nada que mostrar|No hay nada/i.test(grid), `lo dice (\`${grid.trim().slice(0, 60)}\`)`);
	assert(!/Buscando todas/.test(grid), 'no se queda colgado buscando');
	const sub = window.document.getElementById('pageSub').textContent;
	assert(/no expone miniaturas/i.test(sub), `y el subtítulo lo explica (${sub})`);
}

console.log('\n6) El pie ofrece descargar y sabe cuántas hay');
{
	const { window, post } = await startStudio();
	globalThis.fetch = async (input) => {
		const name = String(input).split('/').pop().replace('.jpg', '');
		if (!EXISTEN[name]) return { ok: false, status: 404 };
		const blob = new window.Blob([new Uint8Array(64)]);
		blob.__name = name;
		return { ok: true, status: 200, blob: async () => blob };
	};
	post({ href: '', videoId: 'dQw4w9WgXcQ', videoTitle: 'T', candidates: [] });
	await settle(300);

	assert(window.document.getElementById('countVideo').textContent === '2', `cuenta las miniaturas (${window.document.getElementById('countVideo').textContent})`);
	assert(window.document.getElementById('downloadAll').textContent.includes('2'), `el botón las cuenta (${window.document.getElementById('downloadAll').textContent})`);
	assert(window.document.getElementById('downloadSelected').disabled === true, 'no deja descargar sin selección');

	window.document.getElementById('selectBest').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
	assert(window.document.querySelectorAll('#grid .card.selected').length === 1, '"Seleccionar la mejor" marca una');
	assert(window.document.getElementById('downloadSelected').disabled === false, 'y ya se puede descargar');

	window.document.getElementById('selectNone').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
	assert(window.document.querySelectorAll('#grid .card.selected').length === 0, '"Quitar selección" las quita');
}

console.log(failures ? `\n${failures} fallo(s).` : '\nTodo correcto.');
process.exit(failures ? 1 : 0);
