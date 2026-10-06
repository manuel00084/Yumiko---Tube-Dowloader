import {
	audioExtensionForCodec,
	audioSourceFormats,
	codecLabel,
	extensionForCodec,
	formatBytes,
	formatDuration,
	audioChoices,
	loadSettings,
	pickContainer,
	sanitizeFilename,
	sanitizeFolder,
	saveSettings,
	sortAudioForConversion,
	videoChoices,
} from './shared.js';

const el = (id) => document.getElementById(id);

const state = {
	media: null,
	settings: null,
	mode: 'video',
	videos: [],
	audios: [],
	audioOptions: [],
	bestAudio: null,
	tabId: null,
	selectedVideo: null,
	selectedAudio: null,
	jobId: null,
};

let port = null;

const isYoutubeTab = (url = '') =>
	/^https?:\/\/(www\.|m\.|music\.)?(youtube\.com|youtube-nocookie\.com)\//.test(url);

const showNotice = (message) => {
	el('notice').textContent = message;
	el('notice').hidden = false;
};

const setStatus = (message, kind = '') => {
	const node = el('status');
	node.textContent = message || '';
	node.className = `status ${kind}`.trim();
	node.hidden = !message;
};

const setBusy = (busy) => {
	el('download').disabled = busy;
	el('download').textContent = busy ? 'Descargando…' : 'Descargar';
};

const showProgress = (visible) => {
	el('progress-box').hidden = !visible;
	if (visible) {
		el('bar-fill').style.width = '0%';
		el('progress-label').textContent = 'Preparando…';
	}
};

/* ---------------------------------------------------------------- ajustes */

const applySettingsToUi = () => {
	const { settings } = state;
	el('video-folder').value = settings.videoFolder;
	el('audio-folder').value = settings.audioFolder;
	el('ask-where').checked = settings.askWhereToSave;
	el('include-author').checked = settings.includeAuthor;
	el('merge-audio').checked = settings.mergeAudio;
	el('audio-format').value = settings.audioFormat;
	el('mp3-bitrate').value = String(settings.mp3Bitrate);
};

const bindFolder = (id, key) => {
	el(id).addEventListener('change', async (event) => {
		const value = sanitizeFolder(event.target.value);
		event.target.value = value;
		state.settings = { ...state.settings, [key]: value };
		await saveSettings({ [key]: value });
	});
};

const bindSettings = () => {
	const update = async (patch) => {
		state.settings = { ...state.settings, ...patch };
		await saveSettings(patch);
	};

	bindFolder('video-folder', 'videoFolder');
	bindFolder('audio-folder', 'audioFolder');
	el('ask-where').addEventListener('change', (event) => update({ askWhereToSave: event.target.checked }));
	el('include-author').addEventListener('change', (event) => update({ includeAuthor: event.target.checked }));
	el('merge-audio').addEventListener('change', (event) => {
		update({ mergeAudio: event.target.checked });
		renderVideoList();
	});
	el('audio-format').addEventListener('change', (event) => {
		update({ audioFormat: event.target.value });
		state.selectedAudio = state.selectedAudio === event.target.value ? state.selectedAudio : event.target.value;
		renderAudioList();
	});
	el('mp3-bitrate').addEventListener('change', (event) => update({ mp3Bitrate: Number(event.target.value) }));
};

/* ------------------------------------------------------------------- UI */

const renderHeader = () => {
	const { media } = state;
	el('title').textContent = media.title;
	const parts = [media.author, formatDuration(media.duration)].filter(Boolean);
	el('subtitle').textContent = parts.join(' · ');
	if (media.thumbnail) {
		el('thumb').src = media.thumbnail;
		el('thumb').hidden = false;
	}
	if (media.isLive) {
		showNotice('Es un directo en marcha: solo se descargará lo emitido hasta ahora.');
	}
};

const choiceRow = ({ type, value, title, detail, badge, badgeNeutral, size, checked }) => {
	const label = document.createElement('label');
	label.className = `choice${checked ? ' is-selected' : ''}`;
	label.dataset.value = value;

	const input = document.createElement('input');
	input.type = 'radio';
	input.name = type;
	input.value = value;
	input.checked = checked;

	const text = document.createElement('div');
	text.className = 'label';
	const titleNode = document.createElement('div');
	titleNode.className = 'title';
	titleNode.textContent = title;
	if (badge) {
		const badgeNode = document.createElement('span');
		badgeNode.className = `badge${badgeNeutral ? ' neutral' : ''}`;
		badgeNode.textContent = badge;
		titleNode.append(badgeNode);
	}
	const detailNode = document.createElement('div');
	detailNode.className = 'detail';
	detailNode.textContent = detail;
	text.append(titleNode, detailNode);

	const sizeNode = document.createElement('span');
	sizeNode.className = 'size';
	sizeNode.textContent = size;

	label.append(input, text, sizeNode);
	label.addEventListener('change', () => {
		for (const sibling of label.parentElement.children) sibling.classList.remove('is-selected');
		label.classList.add('is-selected');
	});
	return label;
};

const estimatedVideoSize = (format) => {
	const video = format.contentLength || 0;
	if (format.kind === 'muxed') return video;
	const audio = state.bestAudio?.contentLength || 0;
	return video + audio;
};

const renderVideoList = () => {
	const list = el('video-list');
	list.textContent = '';
	const { videos, settings } = state;

	if (!videos.length) {
		list.textContent = 'Este vídeo no tiene formatos de vídeo descargables.';
		return;
	}

	videos.forEach((format, index) => {
		const quality = format.qualityLabel || `${format.height}p`;
		const fps = format.fps && format.fps > 30 ? `${format.fps}fps` : '';
		const merged = settings.mergeAudio && format.kind === 'video';
		const detail = [fps, codecLabel(format.codecs), merged ? 'se une con el audio' : '']
			.filter(Boolean)
			.join(' · ');
		const row = choiceRow({
			type: 'video',
			value: String(format.itag),
			title: quality,
			detail,
			badge: format.kind === 'muxed' ? 'audio incluido' : null,
			badgeNeutral: format.kind === 'muxed',
			size: formatBytes(estimatedVideoSize(format)),
			checked: index === 0,
		});
		row.addEventListener('click', () => {
			state.selectedVideo = format;
		});
		list.append(row);
	});

	if (!state.selectedVideo) state.selectedVideo = videos[0];
};

const mp3Size = () => {
	const duration = state.media?.duration || 0;
	return duration ? formatBytes((duration * state.settings.mp3Bitrate * 1000) / 8) : '?';
};

/**
 * Pistas que se probarán para convertir a MP3, en orden: primero las de solo
 * audio y, si no sirven, el vídeo completo del que se extrae el sonido.
 */
const mp3Candidates = () => audioSourceFormats(state.media?.formats || []);

/** Cada opción guarda de qué pista de audio debe servirse. */
const buildAudioOptions = () => {
	const { audios } = state;
	const best = audios[0];
	// Sin audio suelto se puede sacar el sonido del vídeo completo: es el único
	// stream que la CDN de YouTube no está rechazando con 403.
	const muxed = state.media?.formats?.find(
		(format) => format.kind === 'muxed' && typeof format.url === 'string',
	);
	if (!best && !muxed) return [];

	const fuentes = mp3Candidates();
	const aac = audios.find((format) => format.codecs.some((codec) => codec.startsWith('mp4a')));
	const opus = audios.find((format) => format.codecs.some((codec) => codec.startsWith('opus')));

	// El origen del MP3 es el primer candidato viable: si solo hay audio suelto
	// se usa ese, y si no, el vídeo completo del que se extrae la pista.
	const origen = fuentes[0];
	const opciones = [
		{
			value: 'mp3',
			title: 'MP3',
			detail: origen?.kind === 'muxed'
				? 'Extraído del vídeo (los streams de audio están rechazados)'
				: `Convertido desde ${codecLabel(origen?.codecs || best?.codecs || [])}`,
			size: mp3Size(),
			source: origen || best || muxed,
		},
	];

	if (aac) {
		opciones.push({
			value: 'm4a',
			title: 'M4A original',
			detail: 'Sin convertir, calidad de YouTube',
			size: formatBytes(aac.contentLength || 0),
			source: aac,
		});
	}

	if (opus) {
		opciones.push({
			value: 'opus',
			title: 'Opus original',
			detail: 'WebM, sin convertir',
			size: formatBytes(opus.contentLength || 0),
			source: opus,
		});
	}

	return opciones;
};

const renderAudioList = () => {
	const list = el('audio-list');
	list.textContent = '';
	const { settings } = state;

	const options = buildAudioOptions();
	state.audioOptions = options;

	if (!options.length) {
		list.textContent = 'Este vídeo no tiene pista de audio descargable.';
		el('bitrate-row').hidden = true;
		return;
	}

	for (const option of options) {
		const row = choiceRow({
			type: 'audio',
			value: option.value,
			title: option.title,
			detail: option.detail,
			size: option.size,
			checked: option.value === (state.selectedAudio || settings.audioFormat),
		});
		row.addEventListener('click', () => {
			state.selectedAudio = option.value;
		});
		list.append(row);
	}

	const available = options.map((option) => option.value);
	if (!available.includes(state.selectedAudio)) {
		state.selectedAudio = available.includes(settings.audioFormat) ? settings.audioFormat : available[0];
	}
	el('bitrate-row').hidden = state.selectedAudio !== 'mp3';
};

/* -------------------------------------------------------------- descarga */

const buildRequest = () => {
	const { media, settings, selectedVideo, selectedAudio } = state;
	const author = settings.includeAuthor ? media.author : '';
	const common = {
		title: media.title,
		author,
		// Cada tipo de descarga tiene su propia carpeta.
		folder: state.mode === 'audio' ? settings.audioFolder : settings.videoFolder,
		saveAs: settings.askWhereToSave,
	};

	if (state.mode === 'audio') {
		const option = (state.audioOptions || []).find((item) => item.value === selectedAudio) || state.audioOptions?.[0];
		if (!option) throw new Error('No hay ninguna pista de audio disponible.');
		// Si el origen del MP3 acaba siendo el vídeo completo, el plan B tiene que
		// ser ese mismo archivo: los streams de solo audio pueden estar rechazados.
		const origen = option.source || mp3Candidates()[0];
		if (option.value === 'mp3') {
			const candidatos = mp3Candidates();
			return {
				...common,
				kind: 'mp3',
				// Se prueban todas: si una falla o caduca, se pasa a la siguiente.
				audioUrls: candidatos.map((format) => format.url),
				// El itag permite rehacer la petición con URLs nuevas si caducan.
				audioItags: candidatos.map((format) => format.itag),
				bitrate: settings.mp3Bitrate,
				extension: 'mp3',
				// El archivo se llama solo con el título del vídeo ("Mi canción.mp3").
				suffix: '',
				// Si la conversión falla, se guarda el origen tal cual.
				fallback: {
					url: origen.url,
					extension: origen.kind === 'muxed' ? extensionForCodec(origen.codecs) : audioExtensionForCodec(origen.codecs),
					suffix: origen.kind === 'muxed' ? 'vídeo original' : 'audio original',
					codec: codecLabel(origen.codecs),
				},
			};
		}
		return {
			...common,
			kind: 'direct',
			url: origen.url,
			extension: origen.kind === 'muxed' ? extensionForCodec(origen.codecs) : option.value === 'opus' ? 'webm' : 'm4a',
			suffix: origen.kind === 'muxed' ? 'vídeo original' : 'audio original',
			codec: codecLabel(origen.codecs),
			audioItag: origen.kind === 'muxed' ? undefined : origen.itag,
			videoItag: origen.kind === 'muxed' ? origen.itag : undefined,
		};
	}

	const video = selectedVideo;
	if (!video) throw new Error('No hay ninguna calidad de vídeo seleccionada.');
	if (video.kind === 'muxed') {
		return {
			...common,
			kind: 'direct',
			url: video.url,
			extension: extensionForCodec(video.codecs),
			suffix: video.qualityLabel,
			codec: codecLabel(video.codecs),
			videoItag: video.itag,
		};
	}

	const audio = state.bestAudio;
	if (settings.mergeAudio && audio) {
		const container = pickContainer(video.codecs, audio.codecs);
		return {
			...common,
			kind: 'mux',
			videoUrl: video.url,
			audioUrl: audio.url,
			container,
			extension: container === 'webm' ? 'webm' : 'mp4',
			suffix: video.qualityLabel,
			codec: codecLabel(video.codecs),
			videoItag: video.itag,
			audioItag: audio.itag,
		};
	}

	return {
		...common,
		kind: 'direct',
		url: video.url,
		extension: extensionForCodec(video.codecs),
		suffix: video.qualityLabel,
		codec: codecLabel(video.codecs),
		note: 'sin audio',
		videoItag: video.itag,
	};
};

const handleJobEvent = (message) => {
	if (message.type === 'job-started') {
		state.jobId = message.jobId;
		showProgress(true);
		el('progress-label').textContent = 'Preparando…';
		return;
	}

	if (message.jobId && state.jobId && message.jobId !== state.jobId) return;

	if (message.type === 'job-progress') {
		const percent = Math.round((message.progress || 0) * 100);
		el('bar-fill').style.width = `${Math.max(2, percent)}%`;
		el('progress-label').textContent = `${message.phase} · ${percent}% · ${message.elapsed}s`;
		Object.assign(state.lastJob || (state.lastJob = {}), {
			state: 'en curso',
			phase: message.phase,
			progress: message.progress,
		});
		return;
	}

	if (message.type === 'job-done') {
		state.jobId = null;
		showProgress(false);
		setBusy(false);
		setStatus(`Guardado: ${message.filename}${message.sizeText ? ` (${message.sizeText})` : ''}`, 'ok');
		Object.assign(state.lastJob || (state.lastJob = {}), {
			state: 'terminado',
			filename: message.filename,
			progress: 1,
		});
		refreshDiagnostics();
		return;
	}

	if (message.type === 'job-error') {
		state.jobId = null;
		showProgress(false);
		setBusy(false);
		setStatus(message.error, 'error');
		Object.assign(state.lastJob || (state.lastJob = {}), { state: 'fallido', error: message.error });
		refreshDiagnostics();
	}
};

const startDownload = async () => {
	setStatus('');
	setBusy(true);
	showProgress(true);
	try {
		const request = buildRequest();
		request.tabId = state.tabId;
		state.lastJob = { kind: request.kind, folder: request.folder, state: 'iniciando' };
		const response = await chrome.runtime.sendMessage({ type: 'yumiko:download', request });
		if (!response?.ok) throw new Error(response?.error || 'No se ha podido iniciar la descarga.');
		if (response.fallback) {
			// El MP3 falló, pero se ha guardado el audio tal cual.
			state.jobId = null;
			showProgress(false);
			setBusy(false);
			setStatus(
				`Guardado el audio original: ${response.filename}. No se pudo convertir a MP3 (${response.note})`,
				'error',
			);
			Object.assign(state.lastJob, { state: 'convertido a original', filename: response.filename, error: response.note });
			refreshDiagnostics();
		}
		// El progreso y el final llegan por el puerto, también en las descargas directas.
	} catch (error) {
		showProgress(false);
		setBusy(false);
		setStatus(error.message || String(error), 'error');
		Object.assign(state.lastJob || (state.lastJob = {}), { state: 'fallido', error: error.message });
		refreshDiagnostics();
	}
};

/* ------------------------------------------------------------------ init */

const formatDiagnostics = (media, error, tab) => {
	const diag = media?.diag || {};
	const job = state.lastJob;
	const report = {
		extension: chrome.runtime.getManifest().version,
		navegador: navigator.userAgent,
		pestaña: tab?.url || '(no disponible)',
		error: error || null,
		...diag,
	};
	const text = Object.entries(report)
		.map(([key, value]) => `${key}: ${value === undefined ? '-' : typeof value === 'object' ? JSON.stringify(value) : value}`)
		.join('\n');

	if (!job) return text;
	const jobText = [
		'',
		'--- última descarga ---',
		`tipo: ${job.kind}`,
		`carpeta: ${job.folder}`,
		`estado: ${job.state}`,
		job.phase ? `fase: ${job.phase}` : null,
		job.progress !== undefined ? `progreso: ${Math.round((job.progress || 0) * 100)}%` : null,
		job.error ? `error: ${job.error}` : null,
		job.filename ? `archivo: ${job.filename}` : null,
	]
		.filter(Boolean)
		.join('\n');
	return text + jobText;
};

const showDiagnostics = (media, error, tab) => {
	const text = formatDiagnostics(media, error, tab);
	el('diagnostics').hidden = false;
	el('diagnostics-text').textContent = text;
	el('copy-diagnostics').onclick = async () => {
		try {
			await navigator.clipboard.writeText(text);
			setStatus('Diagnóstico copiado al portapapeles.', 'ok');
		} catch {
			// Sin permiso de portapapeles: se selecciona para copiar a mano.
			const range = document.createRange();
			range.selectNodeContents(el('diagnostics-text'));
			const selection = getSelection();
			selection.removeAllRanges();
			selection.addRange(range);
			setStatus('Selecciona el texto y cópialo con Ctrl+C.');
		}
	};
};

const refreshDiagnostics = () => {
	if (el('diagnostics').hidden) return;
	showDiagnostics(state.media, state.lastJob?.error || null, state.lastTab);
};

const render = () => {
	state.videos = videoChoices(state.media.formats);
	state.audios = audioChoices(state.media.formats);
	state.bestAudio = state.audios[0] || null;

	el('tabs').hidden = false;
	renderHeader();
	renderVideoList();
	renderAudioList();
	renderDestination();
	el('download').disabled = !state.videos.length;
};

/**
 * Muestra a dónde va a guardarse la descarga actual. Es la duda más habitual:
 * si el archivo sale en una subcarpeta concreta y no se busca, parece que no
 * se ha descargado nada.
 */
const renderDestination = () => {
	const folder = state.mode === 'audio' ? state.settings.audioFolder : state.settings.videoFolder;
	el('destination-text').textContent = folder ? `Descargas / ${folder.replace(/\//g, ' / ')}` : 'Descargas (raíz)';
	el('destination').title = el('destination-text').textContent.trim();
};

/**
 * Abre el estudio de miniaturas, que vive dentro de la propia página de YouTube
 * como iframe (thumbs/bridge.js). Se le pasa el vídeo que el popup ya ha
 * detectado para que el estudio no tenga que averiguarlo otra vez.
 */
const openThumbStudio = async () => {
	const button = el('open-thumbs');
	button.disabled = true;
	button.textContent = 'Abriendo…';
	try {
		const response = await chrome.runtime.sendMessage({
			type: 'yumiko:openThumbs',
			payload: {
				videoId: state.media?.videoId || null,
				videoTitle: state.media?.title || '',
			},
		});
		if (!response?.ok) showNotice(response?.reason || 'No se ha podido abrir el estudio de miniaturas.');
		else window.close();
	} catch (error) {
		showNotice(error?.message || 'No se ha podido abrir el estudio de miniaturas.');
	} finally {
		button.disabled = false;
		button.textContent = 'Abrir el estudio de miniaturas';
	}
};

const bindTabs = () => {
	for (const tab of document.querySelectorAll('.tab')) {
		tab.addEventListener('click', () => {
			state.mode = tab.dataset.mode;
			for (const other of document.querySelectorAll('.tab')) {
				other.classList.toggle('is-active', other === tab);
			}
			el('video-pane').hidden = state.mode !== 'video';
			el('audio-pane').hidden = state.mode !== 'audio';
			el('thumbs-pane').hidden = state.mode !== 'thumbs';
			el('merge-audio').parentElement.hidden = state.mode !== 'video';
			// En modo miniaturas no hay descarga de vídeo: la deja el estudio.
			el('download').hidden = state.mode === 'thumbs';
			renderDestination();
		});
	}
};

const init = async () => {
	try {
		state.settings = await loadSettings();
		applySettingsToUi();
		bindSettings();
		bindTabs();

		el('download').addEventListener('click', startDownload);
		el('destination').addEventListener('click', () => chrome.downloads.showDefaultFolder());
		el('cancel').addEventListener('click', () => {
			if (state.jobId) chrome.runtime.sendMessage({ type: 'yumiko:cancel', jobId: state.jobId });
			setStatus('Cancelando…');
		});
		el('open-folder').addEventListener('click', () => chrome.downloads.showDefaultFolder());
		el('open-thumbs').addEventListener('click', openThumbStudio);

		port = chrome.runtime.connect({ name: 'yumiko' });
		port.onMessage.addListener(handleJobEvent);

		const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
		state.lastTab = tab;
		state.tabId = tab?.id || null;
		if (!tab?.id || !isYoutubeTab(tab.url)) {
			showNotice('Abre un vídeo de YouTube para descargarlo.');
			el('title').textContent = 'Yumiko - Tube Downloader';
			el('subtitle').textContent = '';
			showDiagnostics(null, 'La pestaña activa no es una página de vídeo de YouTube.', tab);
			return;
		}

		const media = await chrome.runtime.sendMessage({ type: 'yumiko:getMedia', tabId: tab.id });
		showDiagnostics(media, media?.ok ? null : media?.error, tab);
		if (!media?.ok) {
			el('title').textContent = 'No se ha podido leer el vídeo';
			showNotice(media?.error || 'Espera a que el vídeo empiece a reproducirse y vuelve a abrir el popup.');
			return;
		}

		state.media = media;
		render();
	} catch (error) {
		el('title').textContent = 'Error';
		showNotice(error?.message || String(error));
		showDiagnostics(null, error?.message || String(error), null);
	}
};

init();