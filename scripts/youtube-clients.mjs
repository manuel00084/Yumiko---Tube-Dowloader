/**
 * Clientes de innertube y qué formatos devuelven. Compartido por los tests y
 * por scripts/probe-youtube.mjs.
 */

const UA_DESKTOP =
	'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36';

export const CLIENTS = {
	WEB: { clientName: 'WEB', version: '2.20250101.00.00', userAgent: UA_DESKTOP, key: null },
	MWEB: { clientName: 'MWEB', version: '2.20250101.00.00', userAgent: UA_DESKTOP, key: null },
	ANDROID: {
		clientName: 'ANDROID',
		version: '20.10.38',
		userAgent: 'com.google.android.youtube/20.10.38 (Linux; U; Android 14; en_US) gzip',
		androidSdkVersion: 34,
		key: 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8',
	},
	VISIONOS: {
		clientName: 'VISIONOS',
		version: '1.62.0',
		userAgent: UA_DESKTOP,
		androidSdkVersion: null,
		key: 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8',
	},
	IOS: {
		clientName: 'IOS',
		version: '20.10.4',
		userAgent: 'com.google.ios.youtube/20.10.4 (iPhone16,2; U; CPU iOS 18_3 like Mac OS X;)',
		androidSdkVersion: null,
		key: null,
	},
	ANDROID_VR: {
		clientName: 'ANDROID_VR',
		version: '1.60.19',
		userAgent: 'com.google.android.apps.youtube.vr.oculus/1.60.19 (Linux; U; Android 12L; eureka-user Build/SQ3A.220605.009.A1) gzip',
		androidSdkVersion: 32,
		key: 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8',
	},
	TVHTML5_SIMPLY_EMBEDDED_PLAYER: {
		clientName: 'TVHTML5_SIMPLY_EMBEDDED_PLAYER',
		version: '2.0',
		userAgent: UA_DESKTOP,
		key: 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8',
	},
	WEB_EMBEDDED_PLAYER: {
		clientName: 'WEB_EMBEDDED_PLAYER',
		version: '1.20250101.00.00',
		userAgent: UA_DESKTOP,
		key: null,
	},
};

const usableFormats = (playerResponse) => {
	const streaming = playerResponse?.streamingData;
	if (!streaming) return [];
	const list = [...(streaming.adaptiveFormats || []), ...(streaming.formats || [])];
	return list.filter((format) => typeof format.url === 'string' && !format.signatureCipher);
};

export const fetchWatchPage = async (videoId) => {
	const response = await fetch(`https://www.youtube.com/watch?v=${videoId}&hl=es`, {
		headers: {
			'User-Agent': UA_DESKTOP,
			'Accept-Language': 'es-ES,es;q=0.9',
		},
	});
	const html = await response.text();
	const match = /ytInitialPlayerResponse\s*=\s*(\{.+?\});/.exec(html) || /"playerResponse":"(\{.*?\})"/.exec(html);
	let playerResponse = null;
	if (match) {
		try {
			playerResponse = JSON.parse(match[1]);
		} catch {
			playerResponse = null;
		}
	}
	return { html, playerResponse, apiKey: /"INNERTUBE_API_KEY":"([^"]+)"/.exec(html)?.[1] };
};

const callPlayer = async (apiKey, videoId, client, extra = {}) => {
	const key = apiKey || client.key;
	const response = await fetch(`https://www.youtube.com/youtubei/v1/player?key=${key}&prettyPrint=false`, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			'User-Agent': client.userAgent,
			'Accept-Language': 'es-ES,es;q=0.9',
			'X-YouTube-Client-Name': client.clientName,
			'X-YouTube-Client-Version': client.version,
		},
		body: JSON.stringify({
			videoId,
			context: {
				client: {
					clientName: client.clientName,
					clientVersion: client.version,
					hl: 'es',
					gl: 'ES',
					...(client.androidSdkVersion ? { androidSdkVersion: client.androidSdkVersion } : {}),
					...extra,
				},
			},
			contentCheckOk: true,
			racyCheckOk: true,
		}),
	});
	if (!response.ok) return { error: `HTTP ${response.status}` };
	const json = await response.json();
	const formats = usableFormats(json);
	return {
		formats,
		status: json.playabilityStatus?.status,
		reason: json.playabilityStatus?.reason,
		sabr: Boolean(json.streamingData?.serverAbrStreamingUrl) || json.streamingData?.formats === undefined,
	};
};

export const probe = async (videoId) => {
	const page = await fetchWatchPage(videoId);
	const clients = [];

	for (const [name, client] of Object.entries(CLIENTS)) {
		try {
			const extra =
				name === 'WEB' || name === 'MWEB' || name === 'WEB_EMBEDDED_PLAYER'
					? { playbackContext: { contentPlaybackContext: { html5Preference: 'HTML5_PREF_WANTS' } } }
					: {};
			const result = await callPlayer(page.apiKey, videoId, client, extra);
			clients.push({
				name,
				formats: result.formats?.length ?? 0,
				status: result.status,
				error: result.error || (result.formats ? '' : `${result.status}: ${result.reason}`),
				sabr: result.sabr,
				sample: result.formats?.slice(0, 4).map((f) => `${f.itag}/${f.qualityLabel || f.mimeType.slice(0, 18)}`).join(' '),
			});
		} catch (error) {
			clients.push({ name, formats: 0, error: error.message });
		}
	}

	// Lo que de verdad importa: desde el navegador no se puede cambiar el
	// User-Agent de un fetch, así que hay que comprobar si estos clientes
	// siguen sirviendo aunque la petición salga con el UA de escritorio.
	const desktopUa = {
		ANDROID: { ...CLIENTS.ANDROID, userAgent: UA_DESKTOP },
		IOS: { ...CLIENTS.IOS, userAgent: UA_DESKTOP },
		ANDROID_VR: { ...CLIENTS.ANDROID_VR, userAgent: UA_DESKTOP },
	};

	for (const [name, client] of Object.entries(desktopUa)) {
		try {
			const result = await callPlayer(page.apiKey, videoId, client);
			clients.push({
				name: `${name} (UA escritorio)`,
				formats: result.formats?.length ?? 0,
				status: result.status,
				error: result.error || (result.formats ? '' : `${result.status}: ${result.reason}`),
				sabr: result.sabr,
				sample: result.formats?.slice(0, 4).map((f) => `${f.itag}/${f.qualityLabel || ''}`).join(' '),
			});
		} catch (error) {
			clients.push({ name: `${name} (UA escritorio)`, formats: 0, error: error.message });
		}
	}

	return {
		title: page.playerResponse?.videoDetails?.title,
		pageFormats: usableFormats(page.playerResponse),
		apiKey: Boolean(page.apiKey),
		clients,
	};
};