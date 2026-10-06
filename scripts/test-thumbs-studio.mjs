/**
 * El estudio de miniaturas viene de la extensión "Miniatura YouTube" y ahora
 * vive dentro de Yumiko. Estos tests comprueban lo específico de la
 * integración: el espacio de nombres, el cableado con el popup y que las dos
 * extensiones puedan convivir sin pisarse.
 *
 * Uso: node scripts/test-thumbs-studio.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(new URL('.', import.meta.url)));
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

let failures = 0;
const assert = (condition, message) => {
	if (condition) console.log(`  ok  ${message}`);
	else {
		failures++;
		console.log(`  FALLA ${message}`);
	}
};

const NS = 'yumiko-thumbs';

console.log('\n1) El espacio de nombres es el de Yumiko, en los tres sitios');
{
	for (const file of ['extension/thumbs/bridge.js', 'extension/thumbs/app/studio.js', 'extension/background.js']) {
		assert(read(file).includes(NS), `${file} usa "${NS}"`);
	}
	assert(!read('extension/background.js').includes('miniatura-youtube'), 'background.js no menciona la otra extensión');
}

console.log('\n2) Las dos extensiones pueden convivir');
{
	// Identificadores que la otra extensión usa en la página y en su storage.
	const CONFLICTOS = ['miniatura-youtube', 'miniaturaYoutube', 'myt-studio', 'myt-toast', 'myt-fab'];
	for (const file of [
		'extension/thumbs/bridge.js',
		'extension/thumbs/app/studio.js',
		'extension/thumbs/settings.js',
		'extension/thumbs/model-store.js',
	]) {
		const source = read(file);
		const found = CONFLICTOS.filter((token) => source.includes(token));
		assert(found.length === 0, `${file} no conserva ${found.length ? found.join(', ') : 'nada'} de la otra`);
	}
	// El puente crea y destroy el iframe con ids propios: si coincidieran con los
	// de la otra extensión, un clic en un sitio cerraría el panel del otro.
	const bridge = read('extension/thumbs/bridge.js');
	assert(bridge.includes('yumiko-thumbs-active'), 'el iframe activo tiene id propio');
	assert(bridge.includes('yumiko-thumbs-idle'), 'el iframe oculto tiene id propio');
	assert(bridge.includes('yumiko-thumbs-fab'), 'el botón flotante tiene id propio');
	assert(bridge.includes('yumiko-thumbs-toast'), 'el aviso tiene id propio');
	// El estudio solo atiende mensajes que bringan su namespace.
	assert(read('extension/thumbs/app/studio.js').includes('data.ns !== NS'), 'el estudio filtra por namespace');
}

console.log('\n3) El estudio se carga desde una ruta web accesible');
{
	const manifest = JSON.parse(read('extension/manifest.json'));
	const war = (manifest.web_accessible_resources || []).flatMap((entry) => entry.resources || []);
	assert(war.includes('thumbs/app/studio.html'), 'studio.html está en web_accessible_resources');
	assert(/https:\/\/\*\.youtube\.com\/\*/.test(JSON.stringify(manifest.web_accessible_resources)), 'solo en páginas de YouTube');

	const scripts = (manifest.content_scripts || []).flatMap((s) => s.js || []);
	assert(scripts.includes('thumbs/bridge.js'), 'bridge.js está declarado como content script');
	assert(
		(manifest.host_permissions || []).includes('https://huggingface.co/*'),
		'puede descargar el modelo x4 de Hugging Face',
	);
	assert((manifest.host_permissions || []).includes('https://i.ytimg.com/*'), 'puede leer i.ytimg.com');
}

console.log('\n4) El popup delega en el estudio y no miniaturas por su cuenta');
{
	const popup = read('extension/popup.js');
	assert(!popup.includes('probeCandidates'), 'el popup ya no sondea miniaturas');
	assert(!popup.includes('aiUpscale'), 'el popup ya no carga el motor de IA');
	assert(!popup.includes('createImageBitmap'), 'el popup ya no decodifica imágenes');
	assert(popup.includes('yumiko:openThumbs'), 'el popup pide abrir el studio');
	assert(/videoId: state\.media\?\.videoId/.test(popup), 'pasa el vídeo que ya ha detectado');

	const html = read('extension/popup.html');
	assert(html.includes('id="open-thumbs"'), 'el botón para abrirlo está en el popup');
	assert(!html.includes('id="thumb-scale"'), 'los controles antiguos de escalado han desaparecido');
	assert(!html.includes('id="thumb-folder"'), 'la carpeta la edita el estudio');
}

console.log('\n5) El estudio hereda lo que el popup ya sabe');
{
	const studio = read('extension/thumbs/app/studio.js');
	assert(studio.includes('adoptPopupContext'), 'adopta el contexto del popup');
	assert(/if \(!state\.video\.title\) loadVideoTitle/.test(studio), 'solo busca el título si no se lo han pasado');
	// El popup manda el id; si no, el estudio lo saca de la URL.
	assert(/state\.video\.id \|\| extractVideoId\(payload\.href\)/.test(studio), 'usa el id del popup o, si no, el de la URL');
}

console.log('\n6) Los ajustes viven en el estudio y se guardan solos');
{
	const studio = read('extension/thumbs/app/studio.js');
	assert(!studio.includes('chrome.runtime.openOptionsPage'), 'ya no abre una página de Ajustes aparte');
	assert(studio.includes('toggleAdvanced'), 'el botón despliega los ajustes avanzados');
	assert(read('extension/thumbs/app/studio.html').includes('id="toggleAdvanced"'), 'el botón existe en el HTML');

	const settings = read('extension/thumbs/settings.js');
	assert(settings.includes(`const KEY = 'yumikoThumbs.settings'`), 'los ajustes van a su propia clave');
	assert(settings.includes("folderPrefix: 'Yumiko/Miniaturas/'"), 'por defecto en la carpeta de Yumiko');
	assert(settings.includes('trimBars: false'), 'no recorta barras por defecto');
	assert(settings.includes("upscaler: 'lanczos'"), 'Lanczos por defecto, para no cargar la IA sin pedirlo');
}

console.log('\n7) Los modelos de IA');
{
	const models = read('extension/thumbs/model-store.js');
	assert(models.includes('super-resolution-10.onnx'), 'el modelo ligero x3 va incluido');
	assert(models.includes('real_esrgan_x4.onnx'), 'el x4 se descarga la primera vez');
	assert(models.includes('yumiko-thumbs-models'), 'la caché del x4 tiene su propio nombre');
	assert(fs.existsSync(path.join(root, 'extension/models/super-resolution-10.onnx')), 'el modelo x3 está en el paquete');
	assert(fs.existsSync(path.join(root, 'extension/vendor/ort/ort.webgpu.min.mjs')), 'el motor de onnxruntime está en el paquete');
}

console.log('\n8) Los ficheros que el estudio importa existen');
{
	const studio = read('extension/thumbs/app/studio.js');
	const imports = [...studio.matchAll(/from '(\.\.\/[^']+)'/g)].map((m) => m[1]);
	assert(imports.length > 0, `el estudio importa ${imports.length} librerías`);
	for (const specifier of imports) {
		const full = path.join(root, 'extension/thumbs/app', specifier);
		assert(fs.existsSync(full), `existe ${specifier}`);
	}
}

console.log(failures ? `\n${failures} fallo(s).` : '\nTodo correcto.');
process.exit(failures ? 1 : 0);
