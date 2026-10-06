/**
 * Runtime que se instala en la pestaña para procesar medios.
 *
 * Es común a los dos módulos (vídeo y audio) pero cada uno lo usa con su propio
 * mapa de trabajos, de modo que el bundle de vídeo no lleva el codificador de MP3
 * y el de audio no lleva el de vídeo. Si uno de los dos falla al cargar, el otro
 * sigue funcionando.
 */
export const installRuntime = (kind, jobs) => {
	const blobs = new Map();
	const controllers = new Map();

	const toBase64 = (buffer) => {
		const bytes = new Uint8Array(buffer);
		let binary = '';
		const step = 0x8000;
		for (let i = 0; i < bytes.length; i += step) {
			binary += String.fromCharCode.apply(null, bytes.subarray(i, i + step));
		}
		return btoa(binary);
	};

	globalThis.__yumikoKind = kind;
	globalThis.__yumikoProgress = { id: '', phase: '', progress: 0 };
	globalThis.__yumikoReady = true;

	// El resultado y los errores vuelven envueltos a propósito. Si el processor
	// revienta, executeScript puede devolver un resultado vacío y el service
	// worker se quedaría sin saber por qué; así el error llega entero.
	globalThis.__yumikoProcess = async (payload) => {
		const describe = (error) => ({
			name: error?.name || 'Error',
			message: error?.message || String(error),
		});

		try {
			const run = jobs[payload.job];
			if (!run) throw new Error(`Trabajo desconocido para el módulo ${kind}: ${payload.job}`);

			const report = (phase) => (value) => {
				globalThis.__yumikoProgress = {
					id: payload.id,
					phase,
					progress: Math.max(0, Math.min(1, value || 0)),
				};
			};

			const controller = new AbortController();
			controllers.set(payload.id, controller);
			globalThis.__yumikoProgress = {
				id: payload.id,
				phase: 'Descargando del servidor de YouTube…',
				progress: 0,
			};

			try {
				const result = await run({ ...payload, signal: controller.signal, onProgress: report(payload.phase) });
				// El blob se queda en la página: la extensión lo guardará con esta URL.
				const blob = result.blob;
				const url = URL.createObjectURL(blob);
				blobs.set(url, blob);
				globalThis.__yumikoProgress = { id: payload.id, phase: 'Listo para guardar', progress: 1 };
				return { ok: true, value: { url, size: blob.size, mimeType: blob.type } };
			} finally {
				controllers.delete(payload.id);
			}
		} catch (error) {
			console.warn('[Yumiko] el processor de la página ha fallado:', error);
			return { ok: false, error: describe(error) };
		}
	};

	/** Lee un trozo del blob en base64 (respaldo si no se puede guardar la URL). */
	globalThis.__yumikoReadChunk = async (url, offset, length) => {
		const blob = blobs.get(url);
		if (!blob) throw new Error('El archivo ya no está en memoria.');
		if (offset >= blob.size) return { done: true, data: '', bytes: 0 };
		const buffer = await blob.slice(offset, offset + length).arrayBuffer();
		return {
			done: offset + length >= blob.size,
			data: toBase64(buffer),
			offset,
			// Ojo: data es base64 (crece un 33 %), para avanzar hay que usar bytes.
			bytes: buffer.byteLength,
		};
	};

	/** Libera el blob de la página. */
	globalThis.__yumikoRelease = (url) => {
		if (!blobs.has(url)) return false;
		blobs.delete(url);
		URL.revokeObjectURL(url);
		return true;
	};

	/** Cancela un trabajo en marcha. */
	globalThis.__yumikoCancel = (id) => {
		const controller = controllers.get(id);
		if (!controller) return false;
		controller.abort();
		return true;
	};
};