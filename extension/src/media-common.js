/**
 * Base común del procesado de medios. Lo usan los dos módulos independientes
 * (vídeo y audio): fuentes, destino del archivo, errores y cancelación.
 * Aquí no hay nada de vídeo ni de audio, para que cada módulo pueda fallar sin
 * arrastrar al otro.
 */
import { Input, Output, UrlSource, StreamTarget, BufferTarget, Mp4InputFormat, WebMInputFormat } from 'mediabunny';

export const BASE_INPUT_FORMATS = [
	new Mp4InputFormat(),
	new WebMInputFormat(),
];

const TEMP_PREFIX = 'yumiko-';

export class CancelledError extends Error {
	constructor() {
		super('Descarga cancelada.');
		this.name = 'AbortError';
	}
}

export class CopyError extends Error {}

export const isCancelled = (error) =>
	error?.name === 'AbortError' || error instanceof CancelledError || error?.name === 'ConversionCanceledError';

export const throwIfAborted = (signal) => {
	if (signal?.aborted) throw new CancelledError();
};

export const addAbortListener = (signal, onAbort) => {
	if (!signal) return () => {};
	const handler = () => onAbort();
	signal.addEventListener('abort', handler, { once: true });
	return () => signal.removeEventListener('abort', handler);
};

/** Convierte errores de red opacos en mensajes que el usuario entienda. */
export const describeError = (error) => {
	if (isCancelled(error)) return new CancelledError();
	const message = String(error?.message || error);
	if (/failed to fetch|networkerror|load failed|network request failed|timed? ?out|timeout/i.test(message)) {
		return new Error(
			'No se ha podido leer el stream (la CDN de YouTube no responde o tu red la bloquea). Prueba con "Original (sin tocar)".',
		);
	}
	if (/\b403\b|forbidden/i.test(message)) {
		return new Error('YouTube rechazó la petición del stream (403). Recarga la página y prueba de nuevo.');
	}
	if (/\b404\b|not found/i.test(message)) {
		return new Error('El stream ya no está disponible (404). Las URLs caducan, así que recarga la página.');
	}
	if (error instanceof Error) return error;
	return new Error(message);
};

/**
 * La CDN de YouTube responde 403 a los rangos abiertos ("bytes=0-"): medido
 * contra ella, un stream de 4 MB da 206 con "bytes=0-1048575" y 403 en cuanto
 * se pide un poco más. Mediabunny siempre pide el rango abierto, así que se le
 * intercepta el fetch y se le cierra la ventana a 1 MB.
 *
 * No se pierde nada: la respuesta sigue siendo un 206 con Content-Range, así
 * que mediabunny deduce el tamaño real del archivo y, si la ventana se queda
 * corta, pide la siguiente por su cuenta.
 */
const RANGE_WINDOW = 1024 * 1024;
const OPEN_RANGE = /^bytes=(\d+)-$/;

const closeRangeWindow = (input, init) => {
	const headers = new Headers(init?.headers);
	const match = OPEN_RANGE.exec(headers.get('Range') || '');
	// Solo se tocan los rangos abiertos que mediabunny genera al leer.
	if (!match) return fetch(input, init);
	const start = Number(match[1]);
	headers.set('Range', `bytes=${start}-${start + RANGE_WINDOW - 1}`);
	return fetch(input, { ...init, headers });
};

export const createSource = (url) =>
	new UrlSource(url, {
		// Reintentos cortos: no esperamos 16 s si YouTube corta la conexión.
		getRetryDelay: (attempt) => (attempt >= 2 ? null : Math.min(2 ** attempt, 4)),
		fetchFn: closeRangeWindow,
	});

export const inputOf = (url, formats = BASE_INPUT_FORMATS) =>
	new Input({ formats, source: createSource(url) });

/**
 * Escribe el archivo en OPFS para no cargarlo entero en memoria (importante en
 * vídeos de 1080p o más). Si OPFS no está disponible, cae a un destino en RAM.
 */
export const createOutput = async (format) => {
	if (navigator.storage?.getDirectory) {
		try {
			const root = await navigator.storage.getDirectory();
			const handle = await root.getFileHandle(`${TEMP_PREFIX}${crypto.randomUUID()}.bin`, { create: true });
			const stream = await handle.createWritable();
			const writable = new WritableStream({
				write: (chunk) => stream.write({ type: 'write', position: chunk.position, data: chunk.data }),
			});
			return {
				output: new Output({ format, target: new StreamTarget(writable, { chunked: true }) }),
				async result() {
					await stream.close();
					const file = await handle.getFile();
					// El tipo MIME no es opcional: sin él el blob vale para Chrome
					// como texto sin formato y le pone extensión .txt al guardarlo.
					const blob = new Blob([file], { type: format.mimeType });
					return { url: URL.createObjectURL(blob), size: blob.size, blob };
				},
				async cleanup() {
					try {
						await handle.removeEntry();
					} catch {
						/* ya no está */
					}
				},
			};
		} catch {
			/* sin OPFS: seguimos en memoria */
		}
	}

	const output = new Output({ format, target: new BufferTarget() });
	return {
		output,
		async result() {
			const buffer = output.target.buffer;
			if (!buffer) throw new Error('No se ha podido generar el archivo.');
			const blob = new Blob([buffer], { type: format.mimeType });
			return { url: URL.createObjectURL(blob), size: blob.size, blob };
		},
		async cleanup() {},
	};
};

/** Borra los temporales de descargas anteriores que se quedaron a medias. */
export const purgeTempFiles = async (force = false) => {
	try {
		if (!navigator.storage?.getDirectory) return;
		const root = await navigator.storage.getDirectory();
		const cutoff = force ? Number.POSITIVE_INFINITY : Date.now() - 60 * 60 * 1000;
		for await (const [name, handle] of root.entries()) {
			if (!name.startsWith(TEMP_PREFIX)) continue;
			const file = await handle.getFile();
			if (file.lastModified < cutoff) await root.removeEntry(name);
		}
	} catch {
		/* sin permisos o sin OPFS */
	}
};