/** Utilidades compartidas entre el popup y el service worker. */

const ILLEGAL_FILENAME = /[\\/:*?"<>|]/g;
// Caracteres de control y de dirección (U+202E oculta la extensión al ojo).
const INVISIBLE = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g;

export const sanitizeFilename = (value, maxLength = 120) => {
	const cleaned = String(value || '')
		.replace(INVISIBLE, '')
		.replace(ILLEGAL_FILENAME, ' ')
		.replace(/\s+/g, ' ')
		// Un punto al final hace que Windows lo interprete como separador.
		.replace(/[. ]+$/, '')
		.trim();
	if (cleaned.length <= maxLength) return cleaned;
	return cleaned.slice(0, maxLength).replace(/[. ]+$/, '').trim();
};

/** Garantiza una extensión de archivo válida; si no hay, la deduce del tipo. */
const EXTENSION_BY_KIND = { mux: 'mp4', mp3: 'mp3', extract: 'm4a', direct: 'mp4' };

const normalizeExtension = (value) => {
	const cleaned = String(value || '')
		.trim()
		.toLowerCase()
		.replace(/^\.+/, '')
		.replace(/[^a-z0-9]/g, '');
	return /^[a-z0-9]{1,5}$/.test(cleaned) ? cleaned : '';
};

/**
 * Las carpetas van dentro de la carpeta de descargas: Chrome no permite
 * escribir en rutas absolutas. Se admiten subcarpetas anidadas (A/B).
 */
export const sanitizeFolder = (value) =>
	String(value || '')
		.replace(INVISIBLE, '')
		// Primero se separa por niveles y luego se limpia cada uno: si se
		// limpiaran antes, los separadores se convertirían en espacios.
		.split(/[\\/]+/)
		.map((part) => sanitizeFilename(part, 40))
		.filter(Boolean)
		.slice(0, 4)
		.join('/')
		.slice(0, 80);

const MAX_NAME_LENGTH = 180;

/**
 * Nombre del archivo: "Título - Canal - 1080p H.264.mp4".
 *
 * El orden es el pedido al descargar: primero el título, después el códec y
 * por último la extensión. Calidad y códec forman una sola etiqueta ("1080p
 * H.264"), y la nota va detrás ("1080p H.264 sin audio").
 */
export const buildFilename = ({ title, author, suffix, codec, note, extension, kind, folder }) => {
	const ext = normalizeExtension(extension) || EXTENSION_BY_KIND[kind] || 'mp4';
	const tag = [sanitizeFilename(suffix, 32), sanitizeFilename(codec, 24), sanitizeFilename(note, 20)]
		.filter(Boolean)
		.join(' ');
	const channel = author ? sanitizeFilename(author, 60) : '';

	// Windows tiene un límite de ruta: si el nombre es enorme, se recorta el título.
	const fixed = 1 + ext.length + (tag ? tag.length + 3 : 0) + (channel ? channel.length + 3 : 0);
	const room = Math.max(20, MAX_NAME_LENGTH - fixed);
	const parts = [sanitizeFilename(title, room) || 'video', channel, tag].filter(Boolean);
	const name = `${parts.join(' - ')}.${ext}`;
	const cleanFolder = sanitizeFolder(folder);
	return cleanFolder ? `${cleanFolder}/${name}` : name;
};

export const formatBytes = (bytes) => {
	if (!Number.isFinite(bytes) || bytes <= 0) return '?';
	const units = ['B', 'KB', 'MB', 'GB'];
	let value = bytes;
	let unit = 0;
	while (value >= 1024 && unit < units.length - 1) {
		value /= 1024;
		unit++;
	}
	return `${value >= 100 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
};

export const formatDuration = (seconds) => {
	if (!Number.isFinite(seconds) || seconds <= 0) return '';
	const total = Math.round(seconds);
	const h = Math.floor(total / 3600);
	const m = Math.floor((total % 3600) / 60);
	const s = total % 60;
	const pad = (n) => String(n).padStart(2, '0');
	return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
};

const CODEC_NAMES = [
	['avc1', 'H.264'],
	['avc3', 'H.264'],
	['hvc1', 'H.265'],
	['hev1', 'H.265'],
	['vp09', 'VP9'],
	['vp9', 'VP9'],
	['vp08', 'VP8'],
	['vp8', 'VP8'],
	['av01', 'AV1'],
	['mp4a', 'AAC'],
	['opus', 'Opus'],
	['vorbis', 'Vorbis'],
	['flac', 'FLAC'],
];

export const codecLabel = (codecs = []) => {
	for (const [prefix, label] of CODEC_NAMES) {
		if (codecs.some((codec) => codec?.startsWith(prefix))) return label;
	}
	return codecs[0]?.split('.')[0]?.toUpperCase() || 'desconocido';
};

/** Elige el contenedor que admite los dos códecs sin recodificar. */
export const pickContainer = (videoCodecs = [], audioCodecs = []) => {
	const has = (list, prefix) => list.some((codec) => typeof codec === 'string' && codec.startsWith(prefix));
	const videoIsWebmFamily = has(videoCodecs, 'vp9') || has(videoCodecs, 'vp8') || has(videoCodecs, 'av01');
	const audioIsWebmFamily = has(audioCodecs, 'opus') || has(audioCodecs, 'vorbis');
	return videoIsWebmFamily && audioIsWebmFamily ? 'webm' : 'mp4';
};

export const extensionForCodec = (codecs = []) => {
	const isWebm = codecs.some((codec) =>
		['vp9', 'vp09', 'vp8', 'vp08', 'av01', 'opus', 'vorbis'].some((prefix) => codec.startsWith(prefix)),
	);
	return isWebm ? 'webm' : 'mp4';
};

/**
 * Extensión de una pista de audio suelta. El AAC va dentro de un MP4, así que
 * se guarda como .m4a y no como .mp4 (que es un vídeo sin imagen).
 */
export const audioExtensionForCodec = (codecs = []) =>
	codecs.some((codec) => codec.startsWith('mp4a') || codec.startsWith('alac')) ? 'm4a' : extensionForCodec(codecs);

/** Agrupa y ordena las resoluciones de vídeo para mostrarlas en el popup. */
export const videoChoices = (formats) => {
	const byKey = new Map();
	for (const format of formats) {
		if (format.kind !== 'video' && format.kind !== 'muxed') continue;
		const height = format.height || 0;
		const fps = format.fps || 30;
		const label = codecLabel(format.codecs);
		const key = `${format.kind}:${height}:${fps}:${label}`;
		const current = byKey.get(key);
		if (!current || (format.bitrate || 0) > (current.bitrate || 0)) byKey.set(key, format);
	}
	return [...byKey.values()].sort((a, b) => {
		if (b.height !== a.height) return b.height - a.height;
		if (b.fps !== a.fps) return b.fps - a.fps;
		return (b.bitrate || 0) - (a.bitrate || 0);
	});
};

export const audioChoices = (formats) =>
	formats
		.filter((format) => format.kind === 'audio')
		.sort((a, b) => (b.audioBitrate || b.bitrate || 0) - (a.audioBitrate || a.bitrate || 0));

/**
 * Orden en que se intentan las pistas para convertir a MP3. El AAC-LC es el
 * más compatible con el decodificador del navegador y el HE-AAC el menos, así
 * que va el último.
 */
export const sortAudioForConversion = (formats) => {
	const score = (codecs = []) => {
		if (codecs.some((codec) => codec.startsWith('mp4a.40.2'))) return 0;
		if (codecs.some((codec) => codec.startsWith('opus'))) return 1;
		if (codecs.some((codec) => codec.startsWith('mp4a.40.5'))) return 3;
		return 2;
	};
	return [...formats].sort(
		(a, b) => score(a.codecs) - score(b.codecs) || (b.audioBitrate || 0) - (a.audioBitrate || 0),
	);
};

/**
 * Formatos de los que se puede sacar una pista de audio.
 *
 * Los streams de solo audio (itag 140/251) son los que la CDN de YouTube está
 * rechazando con 403 según el tamaño del rango. El progresivo (vídeo y audio en
 * un mismo archivo) sí responde siempre, así que se puede descargar entero y
 * quedarse solo con el sonido. Se ordenan de mejor a peor fuente: primero el
 * audio suelto y, como último recurso, el vídeo.
 */
export const audioSourceFormats = (formats) => {
	const withUrl = (format) => typeof format.url === 'string';
	const audio = formats.filter((format) => format.kind === 'audio' && withUrl(format));
	// El progresivo más bajo que haya: da igual la resolución, solo se lee el audio.
	const muxed = formats
		.filter((format) => format.kind === 'muxed' && withUrl(format))
		.sort((a, b) => (a.height || 0) - (b.height || 0));
	return [...sortAudioForConversion(audio), ...muxed];
};

export const DEFAULT_SETTINGS = {
	videoFolder: 'Yumiko/Videos',
	audioFolder: 'Yumiko/Audio',
	thumbFolder: 'Yumiko/Miniaturas',
	askWhereToSave: false,
	includeAuthor: false,
	mergeAudio: true,
	audioFormat: 'mp3',
	mp3Bitrate: 192,
	rememberChoice: true,
};

export const loadSettings = async () => {
	const stored = await chrome.storage.sync.get(DEFAULT_SETTINGS);
	return { ...DEFAULT_SETTINGS, ...stored };
};

export const saveSettings = (patch) => chrome.storage.sync.set(patch);