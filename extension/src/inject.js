/**
 * Se inyecta en el mundo principal (MAIN) de la pestaña de YouTube.
 * Expone `globalThis.__yumikoGetMedia()`, que devuelve información del vídeo
 * y las URLs de todos los formatos.
 *
 * Este archivo no se empaqueta: se inyecta tal cual, por eso no usa módulos.
 */
(() => {
	if (globalThis.__yumikoGetMedia) return;

	const cfgData = () => {
		try {
			const ytcfg = globalThis.ytcfg;
			if (!ytcfg) return {};
			if (ytcfg.data_) return ytcfg.data_;
			if (typeof ytcfg.get === 'function') {
				const out = {};
				for (const key of ['INNERTUBE_API_KEY', 'INNERTUBE_CLIENT_VERSION', 'INNERTUBE_CONTEXT', 'VISITOR_DATA', 'HL', 'GL']) {
					const value = ytcfg.get(key);
					if (value !== undefined) out[key] = value;
				}
				return out;
			}
			return {};
		} catch {
			return {};
		}
	};

	const asNumber = (value) => {
		const parsed = Number.parseInt(value, 10);
		return Number.isFinite(parsed) ? parsed : undefined;
	};

	const VIDEO_CODEC_PREFIXES = ['avc1', 'avc3', 'hvc1', 'hev1', 'vp9', 'vp09', 'vp8', 'vp08', 'av01', 'dvh1', 'dvhe'];
	const AUDIO_CODEC_PREFIXES = ['mp4a', 'opus', 'vorbis', 'flac', 'ac-3', 'ec-3', 'alac'];

	const normalizeFormat = (format) => {
		const mimeType = format.mimeType || '';
		const [rawType, ...rawParams] = mimeType.split(';');
		const type = rawType.trim();
		const params = Object.fromEntries(
			rawParams.map((param) => {
				const [key, ...rest] = param.split('=');
				return [key.trim(), rest.join('=').trim()];
			}),
		);

		// En los formatos progresivos los códecs solo vienen dentro del mimeType.
		const codecs = String(format.codecs || params.codecs || '')
			.split(',')
			.map((codec) => codec.trim().replace(/^"|"$/g, ''))
			.filter(Boolean);

		// Los formatos progresivos declaran el tipo "video" pero llevan también un
		// códec de audio, así que hay que mirar los códecs para saberlo.
		const hasVideo =
			type.startsWith('video') || codecs.some((codec) => VIDEO_CODEC_PREFIXES.some((prefix) => codec.startsWith(prefix)));
		const hasAudio =
			type.startsWith('audio') || codecs.some((codec) => AUDIO_CODEC_PREFIXES.some((prefix) => codec.startsWith(prefix)));
		const kind = hasVideo && hasAudio ? 'muxed' : hasVideo ? 'video' : hasAudio ? 'audio' : 'other';

		return {
			itag: format.itag,
			url: typeof format.url === 'string' ? format.url : null,
			kind,
			mimeType,
			container: codecs[0],
			codecs,
			qualityLabel: format.qualityLabel || undefined,
			audioQuality: format.audioQuality || undefined,
			width: asNumber(format.width),
			height: asNumber(format.height),
			fps: format.fps ? Math.round(Number.parseFloat(format.fps)) || undefined : undefined,
			bitrate: asNumber(format.bitrate || format.averageBitrate),
			audioBitrate: asNumber(format.audioBitrate || format.averageBitrate),
			contentLength: asNumber(format.contentLength),
			// Formatos solo disponibles con el reproductor empaquetado (SABR /
			// ofuscado): no se pueden descargar sin descifrar firmas.
			usable: typeof format.url === 'string' && !format.signatureCipher,
		};
	};

	const extractFormats = (playerResponse) => {
		const streamingData = playerResponse?.streamingData;
		if (!streamingData) return [];
		const seen = new Set();
		const formats = [];
		for (const format of [
			...(streamingData.adaptiveFormats || []),
			...(streamingData.formats || []),
		]) {
			if (!format || format.itag == null || seen.has(format.itag)) continue;
			seen.add(format.itag);
			const normalized = normalizeFormat(format);
			if (normalized.kind === 'other' || !normalized.url) continue;
			// Un formato de vídeo sin resolución ni etiqueta de calidad es ruido
			// (por ejemplo, el stream de audio de una radio mal clasificado).
			if (
				(normalized.kind === 'video' || normalized.kind === 'muxed') &&
				!normalized.height &&
				!normalized.qualityLabel
			) {
				continue;
			}
			formats.push(normalized);
		}
		return formats;
	};

	const usableFormats = (playerResponse) => extractFormats(playerResponse).filter((format) => format.usable);

	/** Hay al menos un formato de vídeo (o progresivo), no solo audio. */
	const hasVideoFormats = (playerResponse) =>
		usableFormats(playerResponse).some((format) => format.kind === 'video' || format.kind === 'muxed');

	/**
	 * ¿La respuesta de la página sirve? En una radio o en modo SABR puede traer
	 * un único formato inservible, así que no basta con "tiene vídeo": se pide
	 * un mínimo deResoluciones distintas.
	 */
	const MIN_PAGE_FORMATS = 3;
	const pageIsUsable = (playerResponse) => {
		const formats = usableFormats(playerResponse);
		const videos = formats.filter((format) => format.kind === 'video' || format.kind === 'muxed');
		if (!videos.length) return false;
		const resolutions = new Set(videos.map((format) => format.height || format.qualityLabel));
		return resolutions.size >= MIN_PAGE_FORMATS;
	};

	/** Los directos solo existen en la respuesta de la página. */
	const pageIsLive = (playerResponse) =>
		Boolean(
			playerResponse?.videoDetails?.isLiveContent ||
				playerResponse?.videoDetails?.isLive ||
				playerResponse?.playabilityStatus?.liveStreamability,
		);

	const querySelector = (selector, attribute) => {
		try {
			const node = document.querySelector(selector);
			if (!node) return null;
			return attribute ? node.getAttribute(attribute) : node.textContent;
		} catch {
			return null;
		}
	};

	/**
	 * Localiza el id del vídeo. En una página de radio YouTube puede reescribir
	 * la URL, así que se mira también la configuración del reproductor y las
	 * etiquetas <meta> de la página.
	 */
	const findVideoId = () => {
		const fromUrl = new URL(location.href).searchParams.get('v');
		if (fromUrl) return { id: fromUrl, source: 'URL' };

		const fromPlayer = globalThis.ytplayer?.config?.args?.video_id;
		if (fromPlayer) return { id: fromPlayer, source: 'reproductor' };

		const fromMeta = querySelector('meta[itemprop="videoId"]', 'content') || querySelector('meta[itemprop="identifier"]', 'content');
		if (fromMeta) return { id: fromMeta, source: 'meta' };

		const canonical = querySelector('link[rel="canonical"]', 'href');
		const fromCanonical = canonical ? /[?&]v=([\w-]{6,})/.exec(canonical)?.[1] : null;
		if (fromCanonical) return { id: fromCanonical, source: 'canonical' };

		return { id: null, source: 'ninguna' };
	};

	const readPlayerResponse = () => {
		const candidate = globalThis.ytInitialPlayerResponse || globalThis.ytplayer?.config?.args?.player_response || null;
		if (!candidate) return null;
		if (typeof candidate === 'string') {
			try {
				return JSON.parse(candidate);
			} catch {
				return null;
			}
		}
		return candidate;
	};

	/**
	 * Clientes de innertube que hoy devuelven las URLs ya firmadas, sin decipher
	 * ni PO token. El reproductor web (WEB) ya no expone ningún formato, así que
	 * se prueban en orden hasta que uno responde.
	 */
	const INNERTUBE_CLIENTS = [
		{ name: 'ANDROID', version: '20.10.38', androidSdkVersion: 34 },
		{ name: 'IOS', version: '20.10.4' },
		{ name: 'ANDROID_VR', version: '1.60.19', androidSdkVersion: 32 },
		{ name: 'WEB', version: null },
	];

	const FALLBACK_API_KEY = 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8';

	/**
	 * YouTube entrega URLs que luego rechaza con 403 (piden un PO token que no
	 * podemos generar). Como estamos en el dominio de youtube.com, se pueden
	 * comprobar antes de ofrecérselas al usuario: 2 bytes bastan.
	 *
	 * Distingue tres casos, porque no es lo mismo "YouTube lo rechaza" (lo
	 * sabemos seguro) que "no hemos podido comprobarlo" (CORS, red, vídeo
	 * raro). Solo el primero sirve para descartar un formato.
	 *
	 * El tiempo límite es imprescindible: una petición a la CDN que se cuelga
	 * bloquearía el popup indefinidamente, y eso es lo que hace que la extensión
	 * parezca lenta.
	 */
	const PROBE_TIMEOUT_MS = 4000;

	/**
	 * Las URLs de YouTube no son infinitas: traen un contador de uso y, tras
	 * unas pocas peticiones, la CDN empieza a responder 403. Por eso no se le
	 * pide los streams cada vez que se abre el popup (cada apertura sondeaba
	 * todas las URLs y las dejaba sin margen), sino que se reutiliza la última
	 * extracción un rato. Con `fresh: true` se fuerza una nueva, que es lo que
	 * hace el reintento cuando una descarga se come un 403.
	 */
	const EXTRACTION_TTL_MS = 30 * 60 * 1000;
	let extraction = null;

	const probeUrl = async (url) => {
		try {
			const response = await fetch(url, {
				headers: { Range: 'bytes=0-1' },
				credentials: 'omit',
				cache: 'no-store',
				signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
			});
			// Hay que consumir el cuerpo para no dejar la conexión abierta.
			await response.arrayBuffer().catch(() => {});
			if (response.status === 200 || response.status === 206) return 'ok';
			// 403/404 son respuestas de verdad de la CDN: el formato no sirve.
			if (response.status === 401 || response.status === 403 || response.status === 404) return 'rejected';
			return 'unknown';
		} catch {
			// fetch falló o se agotó el tiempo: no sabemos si la URL es buena.
			return 'unknown';
		}
	};

	// Se comprueban todas las resoluciones, no solo las 10 primeras: si no, las
	// que quedan sin sondear no se pueden confirmar ni descartar. El sondeo va
	// limitado en simultaneidad para no saturar la conexión.
	const PROBE_CONCURRENCY = 6;

	/**
	 * Comprueba las URLs y descarta solo las que la CDN ha rechazado de forma
	 * explícita. Si el sondeo no ha podido verificar nada (ni una sola URL, por
	 * CORS o por red), no se descarta nada: es preferible ofrecer un formato que
	 * quizá falle al descargar a no ofrecer ninguno.
	 */
	const validateStreamingData = async (streamingData) => {
		const adaptive = streamingData.adaptiveFormats || [];
		const progressive = streamingData.formats || [];

		const withUrl = (format) => typeof format.url === 'string';
		// Las pistas de audio se comprueban todas: son pocas y el popup las recorre
		// en orden al convertir a MP3, así que interesa saber cuáles sirven de verdad.
		const audio = adaptive.filter((format) => withUrl(format) && (format.mimeType || '').startsWith('audio'));
		const video = adaptive
			.filter((format) => withUrl(format) && (format.mimeType || '').startsWith('video'))
			.sort((a, b) => (b.height || 0) - (a.height || 0) || (b.bitrate || 0) - (a.bitrate || 0));

		const toCheck = [...audio, ...video, ...progressive.filter(withUrl)];

		const verdicts = new Map();
		let cursor = 0;
		const worker = async () => {
			for (;;) {
				const index = cursor++;
				if (index >= toCheck.length) return;
				const format = toCheck[index];
				verdicts.set(format.itag, await probeUrl(format.url));
			}
		};
		await Promise.all(Array.from({ length: Math.min(PROBE_CONCURRENCY, toCheck.length) }, worker));

		const rejected = new Set(
			[...verdicts].filter(([, verdict]) => verdict === 'rejected').map(([itag]) => itag),
		);
		const ok = [...verdicts].filter(([, verdict]) => verdict === 'ok').length;
		const unknown = [...verdicts].filter(([, verdict]) => verdict === 'unknown').length;

		// Si no se ha verificado ni una sola URL, el sondeo no ha aportado nada
		// y se ignora. Pero si hay rechazos explícitos, esos sí cuentan.
		const descartados = ok > 0 || rejected.size > 0 ? rejected : new Set();
		const keep = (list) => list.filter((format) => !descartados.has(format.itag));

		return {
			streamingData: {
				...streamingData,
				adaptiveFormats: keep(adaptive),
				formats: keep(progressive),
			},
			checked: toCheck.length,
			valid: ok,
			rejected: rejected.size,
			unknown,
			descartados: descartados.size,
		};
	};

	const fetchFromInnerTube = async (videoId, cfg) => {
		const baseClient = cfg.INNERTUBE_CONTEXT?.client || {};
		const visitorData = cfg.VISITOR_DATA || baseClient.visitorData;
		const apiKey = cfg.INNERTUBE_API_KEY || FALLBACK_API_KEY;
		const attempts = [];
		let lastValidation = null;

		for (const client of INNERTUBE_CLIENTS) {
			const clientVersion = client.version || baseClient.clientVersion || '2.20250101.00.00';
			const contextClient = {
				clientName: client.name,
				clientVersion,
				hl: baseClient.hl || cfg.HL || 'es',
				gl: baseClient.gl || cfg.GL || 'ES',
				// Sin visitorData, YouTube responde LOGIN_REQUIRED en muchos vídeos.
				...(visitorData ? { visitorData } : {}),
				...(client.androidSdkVersion ? { androidSdkVersion: client.androidSdkVersion } : {}),
				...(client.name === 'WEB'
					? { playbackContext: { contentPlaybackContext: { html5Preference: 'HTML5_PREF_WANTS' } } }
					: {}),
			};

			const headers = {
				'Content-Type': 'application/json',
				'X-YouTube-Client-Name': client.name,
				'X-YouTube-Client-Version': clientVersion,
			};
			if (visitorData) headers['X-Goog-Visitor-Id'] = visitorData;

			try {
				const response = await fetch(`/youtubei/v1/player?key=${apiKey}&prettyPrint=false`, {
					method: 'POST',
					credentials: 'include',
					headers,
					body: JSON.stringify({
						videoId,
						// El client va después para que no lo pise el contexto original.
						context: { ...cfg.INNERTUBE_CONTEXT, client: contextClient },
						contentCheckOk: true,
						racyCheckOk: true,
					}),
				});

				if (!response.ok) {
					attempts.push(`${client.name}: HTTP ${response.status}`);
					continue;
				}

				const playerResponse = await response.json();
				if (usableFormats(playerResponse).length > 0) {
					// Antes de devolver nada, se descarta solo lo que la CDN ha
					// rechazado de forma explícita (403/404).
					const { streamingData, checked, valid, rejected, unknown } =
						await validateStreamingData(playerResponse.streamingData);
					const checkedResponse = { ...playerResponse, streamingData };
					attempts.push(
						`${client.name}: ${checked} comprobadas, ${valid} válidas, ${rejected} rechazadas` +
							(unknown ? `, ${unknown} sin comprobar` : ''),
					);
					lastValidation = { checked, valid, rejected, unknown, client: client.name };

					if (usableFormats(checkedResponse).length > 0) {
						return { playerResponse: checkedResponse, client: client.name, attempts, checked, valid, rejected, unknown };
					}
					// YouTube los rechazó todos: no hay nada que ofrecer con este cliente.
					attempts.push(`${client.name}: todos los formatos rechazados por la CDN`);
					continue;
				}
				attempts.push(`${client.name}: ${playerResponse?.playabilityStatus?.status || 'sin formatos'}`);
			} catch (error) {
				attempts.push(`${client.name}: ${error.message}`);
			}
		}

		const failure = new Error(
			`YouTube no ha devuelto los streams con ningún cliente conocido (${attempts.join('; ')}).`,
		);
		failure.validation = lastValidation;
		throw failure;
	};

	const buildResult = (playerResponse, videoId, client) => {
		const details = playerResponse?.videoDetails || {};
		const status = playerResponse?.playabilityStatus?.status || 'UNKNOWN';
		const formats = usableFormats(playerResponse);

		if (!formats.length) {
			const sabr = Boolean(playerResponse?.streamingData?.serverAbrStreamingUrl);
			const reason =
				status === 'LOGIN_REQUIRED'
					? 'YouTube pide iniciar sesión para este vídeo. Inicia sesión en youtube.com y vuelve a intentarlo.'
					: status === 'UNPLAYABLE'
						? 'Este vídeo no se puede reproducir en este navegador.'
						: sabr
							? 'YouTube solo ofrece este vídeo en modo SABR, que no permite descargar las URLs. Prueba con otro vídeo o con otra calidad.'
							: 'YouTube no ha expuesto los streams del vídeo. Prueba a recargar la página.';
			return { ok: false, error: `No se han podido obtener los formatos. ${reason}`, status, sabr };
		}

		return {
			ok: true,
			client: client || 'página',
			videoId: videoId || details.videoId,
			title: details.title || document.title.replace(/ - YouTube$/, ''),
			author: details.author || '',
			duration: asNumber(details.lengthSeconds),
			isLive: Boolean(details.isLiveContent || details.isLive || playerResponse?.playabilityStatus?.liveStreamability),
			thumbnail: details.thumbnail?.thumbnails?.slice(-1)[0]?.url || '',
			viewCount: details.viewCount,
			expiresIn: playerResponse?.streamingData?.expiresInSeconds,
			formats,
		};
	};

	globalThis.__yumikoGetMedia = async ({ fresh = false } = {}) => {
		const cached = readPlayerResponse();
		const { id: videoId, source: idSource } = findVideoId();

		if (
			!fresh &&
			extraction &&
			extraction.videoId === videoId &&
			Date.now() - extraction.at < EXTRACTION_TTL_MS
		) {
			return { ...extraction.result, diag: { ...extraction.result.diag, urlsReutilizadas: true } };
		}

		// Lo que se devuelve y lo que se recuerda solo si ha ido bien: un fallo
		// no debe quedarse cacheado ni un solo segundo.
		const remember = (result) => {
			if (result?.ok) extraction = { videoId, at: Date.now(), result };
			return result;
		};

		const diag = {
			url: location.href,
			videoId,
			videoIdSource: idSource,
			pagina: document.title,
			playerResponse: Boolean(cached),
			estadoPagina: cached?.playabilityStatus?.status || 'sin respuesta',
			formatosPagina: cached ? extractFormats(cached).length : 0,
			formatosUtilizables: cached ? usableFormats(cached).length : 0,
			videoEnPagina: cached ? hasVideoFormats(cached) : false,
			sabr: Boolean(cached?.streamingData?.serverAbrStreamingUrl),
			innertube: {},
		};

		try {
			// 1) La API interna es la fuente fiable: siempre se consulta primero
			//    (unos 200 ms) porque la respuesta de la página puede venir
			//    recortada, en modo SABR o ser la de una radio. La excepción es
			//    un directo en curso, que solo existe en la página.
			if (videoId && !(cached && pageIsLive(cached) && hasVideoFormats(cached))) {
				try {
					const { playerResponse, client, attempts, checked, valid, rejected, unknown } =
						await fetchFromInnerTube(videoId, cfgData());
					diag.innertube = { client, comprobadas: checked, validas: valid, rechazadas: rejected, intentos: attempts };
					diag.urlsComprobadas = checked;
					diag.urlsValidas = valid;
					diag.urlsRechazadas = rejected;
					diag.urlsSinComprobar = unknown;
				if (usableFormats(playerResponse).length > 0) {
					const result = buildResult(playerResponse, videoId, client);
					result.diag = { ...diag, origen: 'innertube' };
					return remember(result);
				}
				} catch (error) {
					diag.innertube = { error: error.message };
					if (error.validation) {
						diag.urlsComprobadas = error.validation.checked;
						diag.urlsValidas = error.validation.valid;
						diag.urlsRechazadas = error.validation.rejected;
						diag.urlsSinComprobar = error.validation.unknown;
						diag.ultimoCliente = error.validation.client;
					}
				}
			} else if (cached && pageIsLive(cached)) {
				diag.innertube = { omitido: 'directo en curso' };
			}

			// 2) La respuesta de la página, si resulta utilizable.
			if (hasVideoFormats(cached)) {
				const result = buildResult(cached, videoId);
				result.diag = { ...diag, origen: 'página' };
				return remember(result);
			}

			// 3) Sin nada: se informa con el motivo más claro que tengamos.
			if (cached) {
				const result = buildResult(cached, videoId);
				if (!result.ok && diag.innertube.error) result.error += ` [${diag.innertube.error}]`;
				result.diag = diag;
				return result;
			}

			return {
				ok: false,
				error:
					diag.innertube.error ||
					'Abre un vídeo de YouTube (no una página de búsqueda ni una lista de reproducción) para poder descargarlo.',
				diag,
			};
		} catch (error) {
			return { ok: false, error: `No se pudo leer el vídeo: ${error.message}`, diag };
		}
	};
})();