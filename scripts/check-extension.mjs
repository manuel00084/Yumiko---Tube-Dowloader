/**
 * Valida la extensión antes de empaquetarla. Chromium rechaza el manifiesto si
 * lleva BOM (UTF-8 con BOM) o si no es JSON válido, y el síntoma es el
 * confuso "Falta el archivo manifest.json".
 *
 * Uso: node scripts/check-extension.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(new URL('.', import.meta.url)));
const source = path.join(root, 'extension');
const problems = [];

const BOM = Buffer.from([0xef, 0xbb, 0xbf]);

const walk = (dir, prefix = '') => {
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) walk(full, relative);
		else checkFile(relative, full);
	}
};

const checkFile = (name, full) => {
	const bytes = fs.readFileSync(full);

	// Un BOM rompe la carga en Chromium/Chrome/Vivaldi.
	if (bytes.subarray(0, 3).equals(BOM)) {
		problems.push(`${name}: tiene BOM UTF-8 (Chromium no puede leer el archivo)`);
	}

	if (name.endsWith('.json')) {
		try {
			JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, ''));
		} catch (error) {
			problems.push(`${name}: JSON no válido (${error.message})`);
		}
	}

	if (name.endsWith('.js')) {
		try {
			new Function(bytes.toString('utf8').replace(/^\s*(export|import)\b.*$/gm, ''));
		} catch {
			// No es concluyente con módulos; solo informativo.
		}
	}
};

const readJson = (relative) =>
	JSON.parse(fs.readFileSync(path.join(source, relative), 'utf8').replace(/^\uFEFF/, ''));

checkFile('manifest.json', path.join(source, 'manifest.json'));

const manifest = readJson('manifest.json');

// En MV3 web_accessible_resources es una lista de objetos { resources, matches };
// en MV2 era un objeto de arrays. Se admiten las dos formas.
const webAccessible = (manifest.web_accessible_resources || []).flatMap((entry) =>
	Array.isArray(entry) ? entry : entry.resources || [],
);

const referenced = [
	manifest.background?.service_worker,
	manifest.action?.default_popup,
	manifest.options_page,
	...Object.values(manifest.icons || {}),
	...Object.values(manifest.action?.default_icon || {}),
	...webAccessible,
	...(manifest.content_scripts || []).flatMap((script) => script.js || []),
	...(manifest.content_scripts || []).flatMap((script) => script.css || []),
].filter(Boolean);

for (const relative of referenced) {
	const full = path.join(source, relative);
	if (!fs.existsSync(full)) problems.push(`manifest.json apunta a "${relative}" y no existe`);
}

const bundles = [
	{ file: 'lib/processor.video.js', forbidden: 'Mp3Encoder', why: 'el codificador de MP3' },
	{ file: 'lib/processor.audio.js', forbidden: 'muxVideo', why: 'la unión de vídeo' },
];

for (const { file } of bundles) {
	if (!fs.existsSync(path.join(source, file))) problems.push(`falta ${file} (ejecuta npm run build)`);
}

for (const file of [
	'background.js',
	'offscreen.js',
	'popup.html',
	'popup.css',
	'popup.js',
	'shared.js',
	'src/inject.js',
	'src/media-common.js',
	'src/video.js',
	'src/audio.js',
	'src/page-runtime.js',
	'src/processor.video.js',
	'src/processor.audio.js',
	// Estudio de miniaturas (portado de "Miniatura YouTube").
	'thumbs/bridge.js',
	'thumbs/app/studio.html',
	'thumbs/app/studio.css',
	'thumbs/app/studio.js',
	'thumbs/settings.js',
	'thumbs/thumbnails.js',
	'thumbs/lanczos.js',
	'thumbs/encode.js',
	'thumbs/ai-upscaler.js',
	'thumbs/model-store.js',
	'thumbs/ort-loader.js',
	'thumbs/page.js',
	'thumbs/pipeline.js',
	'thumbs/zip.js',
	'thumbs/filename.js',
	'models/super-resolution-10.onnx',
	'vendor/ort/ort.webgpu.min.mjs',
]) {
	if (!fs.existsSync(path.join(source, file))) problems.push(`falta ${file}`);
}

// El service worker enruta el studio con este espacio de nombres: si cambia en
// un sitio y no en el otro, el popup abre el estudio y no aparece nada.
const nsIn = (relative) => fs.readFileSync(path.join(source, relative), 'utf8');
const NAMESPACE = 'yumiko-thumbs';
for (const file of ['thumbs/bridge.js', 'thumbs/app/studio.js']) {
	if (!nsIn(file).includes(NAMESPACE)) problems.push(`${file} no usa el espacio de nombres "${NAMESPACE}"`);
}
if (!nsIn('background.js').includes(NAMESPACE)) {
	problems.push(`background.js no enruta el espacio de nombres "${NAMESPACE}"`);
}

// Las dos extensiones pueden convivir: nada puede quedar con el nombre de la otra.
for (const file of ['thumbs/bridge.js', 'thumbs/app/studio.js', 'thumbs/settings.js', 'thumbs/model-store.js']) {
	const leftovers = ['miniatura-youtube', 'miniaturaYoutube', 'src/app/studio.html', 'myt-studio']
		.filter((token) => nsIn(file).includes(token));
	if (leftovers.length) {
		problems.push(`${file} conserva identificadores de la otra extensión: ${leftovers.join(', ')}`);
	}
}

walk(source);

// Independencia de módulos: un bundle no debe arrastrar el motor del otro.
if (process.argv.includes('--modulos')) {
	for (const { file, forbidden, why } of bundles) {
		const full = path.join(source, file);
		if (!fs.existsSync(full)) continue;
		if (fs.readFileSync(full, 'utf8').includes(forbidden)) {
			problems.push(`${file} contiene ${why}: los módulos no son independientes`);
		}
	}
}

if (problems.length) {
	console.error('La extensión no está lista:\n');
	for (const problem of problems) console.error(`  - ${problem}`);
	process.exit(1);
}

console.log(`Extensión válida (${manifest.name} v${manifest.version}).`);