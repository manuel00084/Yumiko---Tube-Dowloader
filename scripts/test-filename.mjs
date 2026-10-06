/**
 * Prueba de las utilidades compartidas: nombres de archivo (la extensión debe
 * acabar siempre en una extensión válida) y orden de las pistas de audio.
 *
 * Uso: node scripts/test-filename.mjs
 */
import {
	audioExtensionForCodec,
	buildFilename,
	sanitizeFilename,
	sanitizeFolder,
	sortAudioForConversion,
	pickContainer,
	extensionForCodec,
	DEFAULT_SETTINGS,
} from '../extension/shared.js';

const assert = (condition, message) => {
	if (!condition) throw new Error(`FALLO: ${message}`);
	console.log(`  ok  ${message}`);
};

console.log('\n1) Siempre con extensión');
for (const [kind, extension, expected] of [
	['mux', 'mp4', 'mp4'],
	['mp3', 'mp3', 'mp3'],
	['direct', undefined, 'mp4'],
	['mux', undefined, 'mp4'],
	['mux', '.MP4?', 'mp4'],
	['mux', 'no válido!', 'mp4'],
	['extract', 'm4a', 'm4a'],
]) {
	const name = buildFilename({ title: 'Vídeo', author: 'Canal', suffix: '1080p', kind, extension, folder: 'Yumiko' });
	assert(name.endsWith(`.${expected}`), `${kind}/${extension ?? 'sin extension'} -> ${name}`);
}

console.log('\n2) Título, después códec y por último la extensión');
const video = buildFilename({ title: 'Mi vídeo', suffix: '1080p', codec: 'H.264', kind: 'mux', extension: 'mp4', folder: 'Yumiko' });
assert(video === 'Yumiko/Mi vídeo - 1080p H.264.mp4', `nombre del vídeo: ${video}`);
const conCanal = buildFilename({ title: 'Mi vídeo', author: 'MiCanal', suffix: '1080p', codec: 'H.264', kind: 'mux', extension: 'mp4' });
assert(conCanal === 'Mi vídeo - MiCanal - 1080p H.264.mp4', `con canal: ${conCanal}`);
const sinAudio = buildFilename({ title: 'Mi vídeo', suffix: '1080p', codec: 'H.264', note: 'sin audio', kind: 'direct' });
assert(sinAudio === 'Mi vídeo - 1080p H.264 sin audio.mp4', `vídeo solo: ${sinAudio}`);
// El MP3 se llama solo con el título: el bitrate ya no va en el nombre.
const mp3 = buildFilename({ title: 'Mi canción', suffix: '', kind: 'mp3', extension: 'mp3' });
assert(mp3 === 'Mi canción.mp3', `mp3 solo con el título: ${mp3}`);
const mp3Largo = buildFilename({ title: 'X'.repeat(400), suffix: '', kind: 'mp3', extension: 'mp3' });
assert(mp3Largo.endsWith('.mp3') && mp3Largo.length <= 180, `el título se recorta pero conserva la extensión (${mp3Largo.length})`);
const solo = buildFilename({ title: 'Mi vídeo', kind: 'mux', extension: 'mp4' });
assert(solo === 'Mi vídeo.mp4', `sin etiquetas: ${solo}`);

console.log('\n3) Nombres sucios');
const cases = [
	[{ title: 'A/B:C*D?E"F<G>H|I', suffix: '360p', kind: 'mux' }, /[\/:*?"<>|]/, 'quita los caracteres prohibidos'],
	[{ title: 'Final con punto. ', suffix: '360p', kind: 'mux' }, /[. ]$/, 'no deja puntos ni espacios al final'],
	[{ title: 'Truco‮exe.mp4', suffix: '360p', kind: 'mux' }, /‮/, 'quita el carácter de dirección oculta'],
	[{ title: 'Con\nsalto\tde\ttabulación', suffix: '360p', kind: 'mux' }, /[\n\t]/, 'aplana saltos de línea y tabuladores'],
];
for (const [input, forbidden, description] of cases) {
	const full = buildFilename({ folder: 'Yumiko', ...input });
	// Solo el nombre: la barra de la carpeta es legítima.
	const name = full.slice(full.indexOf('/') + 1);
	assert(!forbidden.test(name), `${description}: ${JSON.stringify(name)}`);
}

const sinTitulo = buildFilename({ title: '', suffix: '360p', kind: 'mux', folder: 'Yumiko' });
assert(/^video\b/.test(sinTitulo.split('/')[1]), `pone un nombre por defecto: ${sinTitulo}`);

console.log('\n4) Límite de longitud');
const largo = 'X'.repeat(400);
const name = buildFilename({ title: largo, author: 'Canal larguísimo', suffix: '1080p60', codec: 'H.264', kind: 'mux', extension: 'mp4', folder: 'Yumiko' });
const base = name.split('/').pop();
assert(base.length <= 180, `el nombre final no pasa de 180 caracteres (${base.length})`);
assert(base.endsWith('.mp4'), 'sigue terminando en .mp4');

console.log('\n5) Carpeta');
assert(sanitizeFolder('/Descargas/Yumiko/') === 'Descargas/Yumiko', 'limpia barras y extremos');
assert(sanitizeFolder('Yumiko\\Videos') === 'Yumiko/Videos', 'convierte barras invertidas en normales');
assert(sanitizeFolder('a//b\\c') === 'a/b/c', 'no repite separadores');
assert(sanitizeFolder('..\\..\\etc') === 'etc', 'no sube de nivel con ..');
assert(sanitizeFolder('   ') === '', 'una carpeta en blanco se queda vacía');
assert(sanitizeFolder('a'.repeat(200)).length <= 80, 'limita la longitud');
assert(buildFilename({ title: 'x', kind: 'mux', folder: 'Yumiko/Videos' }).startsWith('Yumiko/Videos/'), 'usa la carpeta');
assert(!buildFilename({ title: 'x', kind: 'mux', folder: '' }).includes('/'), 'sin carpeta no añade ruta');
assert(
	DEFAULT_SETTINGS.videoFolder !== DEFAULT_SETTINGS.audioFolder,
	`vídeo y audio tienen carpeta propia (${DEFAULT_SETTINGS.videoFolder} / ${DEFAULT_SETTINGS.audioFolder})`,
);

assert(sanitizeFilename('a'.repeat(300), 50).length === 50, 'sanitizeFilename respeta el máximo');

console.log('\n6) Orden de las pistas para convertir a MP3');
// Formatos reales que devuelve el cliente ANDROID de YouTube.
const pistas = [
	{ itag: 251, kind: 'audio', codecs: ['opus'], audioBitrate: 136544 },
	{ itag: 140, kind: 'audio', codecs: ['mp4a.40.2'], audioBitrate: 130677 },
	{ itag: 139, kind: 'audio', codecs: ['mp4a.40.5'], audioBitrate: 50152 },
	{ itag: 599, kind: 'audio', codecs: ['mp4a.40.5'], audioBitrate: 32250 },
];
const orden = sortAudioForConversion(pistas).map((p) => p.itag);
assert(orden[0] === 140, `empieza por el AAC-LC, el más compatible (${orden.join(', ')})`);
assert(orden.at(-1) === 599 || orden.at(-1) === 139, 'deja el HE-AAC para el final');
assert(orden.indexOf(140) < orden.indexOf(251), 'el AAC-LC precede al Opus');

console.log('\n7) Contenedor y extensión según los códecs');
assert(pickContainer(['avc1.640028'], ['mp4a.40.2']) === 'mp4', 'H.264 + AAC -> MP4');
assert(pickContainer(['vp9'], ['opus']) === 'webm', 'VP9 + Opus -> WebM');
assert(pickContainer(['av01'], ['opus']) === 'webm', 'AV1 + Opus -> WebM');
assert(pickContainer(['vp9'], ['mp4a.40.2']) === 'mp4', 'VP9 + AAC -> MP4');
assert(extensionForCodec(['opus']) === 'webm', 'Opus -> .webm');
assert(extensionForCodec(['mp4a.40.2']) === 'mp4', 'AAC -> .mp4');
assert(audioExtensionForCodec(['mp4a.40.2']) === 'm4a', 'un audio AAC suelto -> .m4a, no .mp4');
assert(audioExtensionForCodec(['opus']) === 'webm', 'un audio Opus suelto -> .webm');

console.log('\nTodo correcto.');