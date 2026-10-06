import { buildFilename, formatBytes } from './shared.js';

const OFFSCREEN_URL = 'offscreen.html';
const DOWNLOAD_TIMEOUT_MS = 30 * 60 * 1000;
// Debe coincidir con el NS de thumbs/bridge.js y thumbs/app/studio.js.
const THUMBS_NS = 'yumiko-thumbs';

const isYouTubeUrl = (url = '') =>
	/^https:\/\/([a-z]+\.)?youtube\.com\//.test(url) || /^https:\/\/([a-z]+\.)?youtube-nocookie\.com\//.test(url);

const ports = new Set();
const jobs = new Map();

const broadcast = (message) => {
	for (const port of ports) {
		try {
			port.postMessage(message);
		} catch {
			ports.delete(port);
		}
	}
};

const hasOffscreen = async () => {
	if (!chrome.offscreen?.hasDocument) return false;
	try {
		return await chrome.offscreen.hasDocument();
	} catch {
		return false;
	}
};

const ensureOffscreen = async () => {
	if (await hasOffscreen()) return;
	try {
		await chrome.offscreen.createDocument({
			url: OFFSCREEN_URL,
			reasons: ['BLOBS'],
			justification: 'Procesar los streams de YouTube para unirlos y convertir el audio a MP3.',
		});
	} catch (error) {
		if (!/single offscreen|already/i.test(String(error?.message))) throw error;
	}
};

const closeOffscreen = async () => {
	if (!(await hasOffscreen())) return;
	try {
		await chrome.offscreen.closeDocument();
	} catch {
		/* ya estaba cerrado */
	}
};

const waitForDownload = (downloadId) =>
	new Promise((resolve, reject) => {
		let settled = false;
		const finish = (fn, value) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			chrome.downloads.onChanged.removeListener(listener);
			fn(value);
		};

		const check = async () => {
			const [item] = await chrome.downloads.search({ id: downloadId });
			if (!item) return;
			if (item.state === 'complete') finish(resolve, item);
			else if (item.state === 'interrupted') {
				finish(reject, new Error(item.error === 'SERVER_FORBIDDEN' ? 'YouTube rechazó el stream (403).' : `Descarga interrumpida: ${item.error}`));
			}
		};

		const listener = (delta) => {
			if (delta.id !== downloadId) return;
			check().catch(() => {});
		};

		const timer = setTimeout(
			() => finish(reject, new Error('La descarga ha pasado del límite de tiempo.')),
			DOWNLOAD_TIMEOUT_MS,
		);

		chrome.downloads.onChanged.addListener(listener);
		check().catch(() => {});
	});

const hasExtension = (name) => /\.[a-z0-9]{1,5}$/i.test(String(name || ''));

const buildName = (request) => {
	const built = buildFilename({
		title: request.title,
		author: request.author,
		suffix: request.suffix,
		codec: request.codec,
		note: request.note,
		extension: request.extension,
		kind: request.kind,
		folder: request.folder,
	});
	// Un nombre sin extensión es peor que inútil: Chrome la deduce del tipo MIME
	// del blob y el vídeo acaba guardado como .txt. Si llega uno así de fuera,
	// se usa el nombre propio, que siempre lleva la suya.
	const filename = hasExtension(request.filename) ? request.filename : built;
	console.log('[Yumiko] nombre de descarga:', filename);
	return filename;
};

const isCdnRefusal = (error) => /\b40[134]\b|forbidden/i.test(String(error?.message || ''));

/**
 * Las URLs de YouTube caducan y, tras usarlas unas pocas veces, la CDN responde
 * 403. Se piden streams nuevos a la página y se rehace la misma petición con las
 * mismas pistas (por itag), de modo que un 403 no tire la descarga.
 */
const refreshUrls = async (tabId, request) => {
	let media;
	try {
		media = await pageCall(tabId, (options) => globalThis.__yumikoGetMedia(options), [{ fresh: true }]);
	} catch {
		return null;
	}
	const formats = media?.ok && Array.isArray(media.formats) ? media.formats.filter((format) => format.url) : [];
	if (!formats.length) return null;

	const byItag = new Map(formats.map((format) => [format.itag, format]));
	const pick = (itag, kind) => {
		const same = byItag.get(itag);
		if (same?.url) return same;
		return formats.find((format) => format.kind === kind);
	};

	const refreshed = { ...request };
	if (request.kind === 'mux') {
		const video = pick(request.videoItag, 'video');
		const audio = pick(request.audioItag, 'audio');
		if (!video?.url || !audio?.url) return null;
		refreshed.videoUrl = video.url;
		refreshed.audioUrl = audio.url;
	} else if (request.kind === 'mp3') {
		const wanted = request.audioItags?.length
			? request.audioItags.map((itag) => byItag.get(itag)).filter(Boolean)
			: formats.filter((format) => format.kind === 'audio');
		const urls = wanted.map((format) => format.url).filter(Boolean);
		if (!urls.length) return null;
		refreshed.audioUrls = urls;
	} else if (request.kind === 'direct') {
		const source = request.audioItag ? pick(request.audioItag, 'audio') : pick(request.videoItag, 'video');
		if (!source?.url) return null;
		refreshed.url = source.url;
	} else {
		return null;
	}
	return refreshed;
};

const startDirect = async (request) => {
	const jobId = crypto.randomUUID();
	const filename = buildName(request);
	const downloadId = await chrome.downloads.download({
		url: request.url,
		filename,
		saveAs: Boolean(request.saveAs),
		conflictAction: 'uniquify',
	});
	jobs.set(jobId, { jobId, downloadId });
	broadcast({ type: 'job-started', jobId, title: request.title });

	try {
		const item = await waitForDownload(downloadId);
		jobs.delete(jobId);
		broadcast({ type: 'job-done', jobId, filename: item?.filename || filename });
		return { jobId, filename: item?.filename || filename };
	} catch (error) {
		jobs.delete(jobId);
		broadcast({ type: 'job-error', jobId, error: error.message });
		throw error;
	}
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * El documento offscreen acaba de crearse: hay que reintentar el envío hasta
 * que su script haya registrado el listener.
 */
const sendToOffscreen = async (message, attempts = 12) => {
	let lastError;
	for (let attempt = 0; attempt < attempts; attempt++) {
		try {
			return await chrome.runtime.sendMessage(message);
		} catch (error) {
			lastError = error;
			await sleep(150);
		}
	}
	throw lastError ?? new Error('El processor no responde.');
};

/**
 * Cada tipo de descarga usa su propio módulo dentro de la página: el de vídeo
 * no lleva el codificador de MP3 y el de audio no lleva el de unir vídeo. Si uno
 * no se puede cargar, el otro sigue funcionando.
 */
const PROCESSORS = {
	mux: { kind: 'video', file: 'lib/processor.video.js' },
	mp3: { kind: 'audio', file: 'lib/processor.audio.js' },
	extract: { kind: 'audio', file: 'lib/processor.audio.js' },
};

const CHUNK_BYTES = 3 * 1024 * 1024;

/* ------------------------------------------------- procesado dentro de la página */

/**
 * La extensión no puede leer los streams de la CDN (YouTube devuelve 403 al
 * origen chrome-extension://), pero la página sí. Así que todo el trabajo pesado
 * ocurre en la pestaña y la extensión solo guarda el resultado.
 */
const injectProcessor = async (tabId, processor, { force = false } = {}) => {
	if (!force) {
		const [current] = await chrome.scripting.executeScript({
			target: { tabId },
			world: 'MAIN',
			func: () => ({ ready: globalThis.__yumikoReady === true, kind: globalThis.__yumikoKind || null }),
		});
		if (current?.result?.ready && current.result.kind === processor.kind) return;
	}

	await chrome.scripting.executeScript({ target: { tabId }, files: [processor.file], world: 'MAIN' });

	const [loaded] = await chrome.scripting.executeScript({
		target: { tabId },
		world: 'MAIN',
		func: () => ({ ready: globalThis.__yumikoReady === true, kind: globalThis.__yumikoKind || null }),
	});
	if (!loaded?.result?.ready || loaded.result.kind !== processor.kind) {
		throw new Error(`No se ha podido cargar el módulo de ${processor.kind} en la página.`);
	}
};

/** La llamada interna que nunca debe fallar en silencio (liberar blobs, progreso). */
const pageCall = async (tabId, func, args = []) => {
	const [injection] = await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', func, args });
	return injection?.result;
};

/**
 * Ejecuta el processor en la página. Si la inyección vuelve vacía (la página
 * navegó, el módulo se descargó o Chrome perdió el resultado) se recarga el
 * módulo y se reintenta una vez: sin esto la descarga se pierde sin motivo.
 */
class ProcessorUnavailableError extends Error {}

const runProcessor = async (tabId, job) => {
	const reply = await pageCall(tabId, (payload) => globalThis.__yumikoProcess(payload), [job]);
	if (!reply) throw new ProcessorUnavailableError('La página no ha podido ejecutar el processor.');
	if (reply.ok === false) {
		const error = new Error(reply.error?.message || 'No se ha podido procesar el archivo.');
		error.name = reply.error?.name || 'Error';
		throw error;
	}
	return reply.value;
};

const processInPage = async (tabId, request, jobId, onProgress) => {
	const processor = PROCESSORS[request.kind];
	if (!processor) throw new Error(`No hay módulo para el tipo de descarga "${request.kind}".`);
	await injectProcessor(tabId, processor);

	const poller = setInterval(() => {
		chrome.scripting
			.executeScript({ target: { tabId }, world: 'MAIN', func: () => globalThis.__yumikoProgress || null })
			.then(([injection]) => {
				const value = injection?.result;
				if (value && value.id === jobId) onProgress(value);
			})
			.catch(() => {});
	}, 800);

	try {
		const job = {
			id: jobId,
			job: request.kind,
			videoUrl: request.videoUrl,
			audioUrls: request.audioUrls,
			audioUrl: request.audioUrl,
			container: request.container,
			bitrate: request.bitrate,
			title: request.title,
			artist: request.author,
			phase: request.phase,
		};

		try {
			return await runProcessor(tabId, job);
		} catch (error) {
			if (!(error instanceof ProcessorUnavailableError)) throw error;
			console.warn('[Yumiko] la página no devolvió nada; se recarga el módulo y se reintenta');
			await injectProcessor(tabId, processor, { force: true });
			return await runProcessor(tabId, job);
		}
	} finally {
		clearInterval(poller);
	}
};

/**
 * Respaldo: si el navegador no guarda la URL del blob de la página, se copian
 * los bytes a la extensión y se guarda desde allí.
 */
const copyBlobToExtension = async (tabId, blobUrl, mimeType) => {
	const session = crypto.randomUUID();
	await ensureOffscreen();
	await sendToOffscreen({ type: 'yumiko:assemble-start', session, mimeType: mimeType || 'application/octet-stream' });

	let offset = 0;
	for (;;) {
		const chunk = await pageCall(
			tabId,
			(url, at, size) => globalThis.__yumikoReadChunk(url, at, size),
			[blobUrl, offset, CHUNK_BYTES],
		);
		if (chunk.data) {
			await sendToOffscreen({ type: 'yumiko:assemble-chunk', session, data: chunk.data });
			// Los datos vienen en base64: hay que avanzar por bytes, no por caracteres.
			offset += chunk.bytes ?? 0;
		}
		if (chunk.done) break;
	}

	const assembled = await sendToOffscreen({ type: 'yumiko:assemble-end', session });
	if (!assembled?.url) throw new Error('No se han podido reconstruir los bytes del archivo.');
	return assembled;
};

const saveResult = async (tabId, blobUrl, mimeType, request, job, onProgress) => {
	const filename = buildName(request);
	try {
		const downloadId = await chrome.downloads.download({
			url: blobUrl,
			filename,
			saveAs: Boolean(request.saveAs),
			conflictAction: 'uniquify',
		});
		job.downloadId = downloadId;
		const item = await waitForDownload(downloadId);
		return { filename: item?.filename || filename, size: item?.totalBytes || 0 };
	} catch (error) {
		console.warn('[Yumiko] no se pudo guardar la URL de la página:', error.message);
		onProgress?.({ phase: 'Copiando el archivo a la extensión…', progress: 0 });
		const copied = await copyBlobToExtension(tabId, blobUrl, mimeType);
		const downloadId = await chrome.downloads.download({
			url: copied.url,
			filename,
			saveAs: Boolean(request.saveAs),
			conflictAction: 'uniquify',
		});
		job.downloadId = downloadId;
		const item = await waitForDownload(downloadId);
		return { filename: item?.filename || filename, size: item?.totalBytes || copied.size };
	} finally {
		pageCall(tabId, (url) => globalThis.__yumikoRelease(url), [blobUrl]).catch(() => {});
	}
};

const runJob = async (tabId, plan, job, onProgress) => {
	const result = await processInPage(tabId, plan, job.jobId, onProgress);
	return saveResult(tabId, result.url, result.mimeType, plan, job, onProgress);
};

const startProcessed = async (request) => {
	const jobId = crypto.randomUUID();
	const tabId = request.tabId;
	if (!tabId) throw new Error('No se sabe en qué pestaña hacer el procesado.');

	const job = { jobId, request, startedAt: Date.now() };
	jobs.set(jobId, job);
	broadcast({ type: 'job-started', jobId, title: request.title });

	const onProgress = (value) =>
		broadcast({
			type: 'job-progress',
			jobId,
			progress: value.progress ?? 0,
			phase: value.phase || 'Procesando',
			elapsed: Math.round((Date.now() - job.startedAt) / 1000),
		});

	try {
		let saved = null;
		try {
			saved = await runJob(tabId, request, job, onProgress);
		} catch (failure) {
			// Un 403 casi siempre son URLs caducadas o ya gastadas: se piden
			// streams nuevos y se reintenta una vez con las mismas pistas.
			if (!isCdnRefusal(failure)) throw failure;
			onProgress({ phase: 'YouTube ha rechazado el stream; pidiendo URLs nuevas…', progress: 0 });
			const refreshed = await refreshUrls(tabId, request).catch(() => null);
			if (!refreshed) throw failure;
			saved = { ...(await runJob(tabId, refreshed, job, onProgress)), refreshed: true };
		}
		jobs.delete(jobId);
		broadcast({ type: 'job-done', jobId, filename: saved.filename, size: saved.size, sizeText: formatBytes(saved.size) });
		return saved;
	} catch (error) {
		jobs.delete(jobId);
		const message = error?.name === 'AbortError' ? 'Descarga cancelada.' : error?.message || String(error);
		broadcast({ type: 'job-error', jobId, error: message });
		// Si el procesado ha fallado pero el popup trajo un plan B (el audio
		// original), se guarda ese en lugar de perder la descarga entera.
		if (request.fallback?.url) {
			try {
				const saved = await startDirect({
					...request.fallback,
					title: request.title,
					author: request.author,
					folder: request.folder,
					saveAs: request.saveAs,
				});
				return { ...saved, fallback: true, note: message };
			} catch (fallbackError) {
				broadcast({ type: 'job-error', jobId, error: `Tampoco se ha podido guardar el audio original: ${fallbackError.message}` });
			}
		}
		throw new Error(message);
	} finally {
		await finishOffscreen();
	}
};

const finishOffscreen = async () => {
	// El documento offscreen solo vive mientras haya una transferencia de bytes.
	await closeOffscreen();
};

/**
 * El estudio de miniaturas vive en un iframe dentro de la página de YouTube (lo
 * gestiona thumbs/bridge.js). El popup solo pide que se abra, pasando el vídeo
 * que ya ha detectado para que el estudio no tenga que averiguarlo otra vez.
 */
const openThumbStudio = async (payload = {}) => {
	const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
	if (!tab?.id) return { ok: false, reason: 'No hay ninguna pestaña activa.' };
	if (!isYouTubeUrl(tab.url)) return { ok: false, reason: 'Abre una página de YouTube.' };

	for (let attempt = 0; attempt < 6; attempt++) {
		try {
			const reply = await chrome.tabs.sendMessage(tab.id, {
				ns: THUMBS_NS,
				type: 'open',
				payload,
			});
			if (reply !== undefined) return { ok: true };
		} catch {
			/* el content script todavía no está listo */
		}
		await sleep(250);
	}
	return { ok: false, reason: 'Recarga la página de YouTube y vuelve a intentarlo.' };
};

const readMediaFromTab = async (tabId) => {
	await chrome.scripting.executeScript({
		target: { tabId },
		files: ['src/inject.js'],
		world: 'MAIN',
	});
	const [injection] = await chrome.scripting.executeScript({
		target: { tabId },
		world: 'MAIN',
		func: () => globalThis.__yumikoGetMedia?.(),
	});
	if (!injection?.result) {
		return { ok: false, error: 'No se ha podido inyectar el extractor en la página.' };
	}
	return injection.result;
};

chrome.runtime.onConnect.addListener((port) => {
	if (port.name !== 'yumiko') return;
	ports.add(port);
	port.onDisconnect.addListener(() => ports.delete(port));
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
	if (message?.type === 'yumiko:getMedia') {
		readMediaFromTab(message.tabId)
			.then(sendResponse)
			.catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
		return true;
	}

	if (message?.type === 'yumiko:download') {
		const { request } = message;
		const run = request.kind === 'direct' ? startDirect(request) : startProcessed(request);
		run
			.then((result) => sendResponse({ ok: true, ...result }))
			.catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
		return true;
	}

	if (message?.type === 'yumiko:openThumbs') {
		openThumbStudio(message.payload || {})
			.then(sendResponse)
			.catch((error) => sendResponse({ ok: false, reason: error?.message || String(error) }));
		return true;
	}

	if (message?.type === 'yumiko:cancel') {
		const job = jobs.get(message.jobId);
		if (job?.downloadId) chrome.downloads.cancel(job.downloadId).catch(() => {});
		// También se avisa a la página, que es quien está descargando y procesando.
		if (job?.request?.tabId) {
			pageCall(job.request.tabId, (id) => globalThis.__yumikoCancel?.(id) === true, [message.jobId]).catch(() => {});
		}
		return false;
	}

	return false;
});