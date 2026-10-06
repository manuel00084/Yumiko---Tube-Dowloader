/**
 * Comprueba si las URLs de los formatos devueltos por innertube se pueden leer
 * con fetch desde una extensión (CORS), que es lo que necesitan el mux y el MP3.
 *
 * Uso: node scripts/probe-cors.mjs [videoId]
 */
import { CLIENTS, fetchWatchPage } from './youtube-clients.mjs';

const UA = CLIENTS.WEB.userAgent;
const videoId = process.argv[2] || 'dQw4w9WgXcQ';
const page = await fetchWatchPage(videoId);

const callPlayer = async (client) => {
	const response = await fetch(`https://www.youtube.com/youtubei/v1/player?key=${page.apiKey}&prettyPrint=false`, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			'User-Agent': UA,
			'X-YouTube-Client-Name': client.clientName,
			'X-YouTube-Client-Version': client.version,
		},
		body: JSON.stringify({
			videoId,
			context: { client: { clientName: client.clientName, clientVersion: client.version, hl: 'es', gl: 'ES' } },
		}),
	});
	return response.json();
};

const testFetch = async (format, label) => {
	const url = format.url;
	const host = new URL(url).host;
	try {
		const response = await fetch(url, {
			headers: {
				Range: 'bytes=0-2047',
				Origin: 'https://www.youtube.com',
				Referer: 'https://www.youtube.com/',
			},
		});
		const buffer = new Uint8Array(await response.arrayBuffer());
		console.log(
			`${label.padEnd(26)} HTTP ${response.status}  CORS:${response.headers.get('access-control-allow-origin') || 'NO'}  ` +
				`tamaño:${(Number(response.headers.get('content-length')) / 1024).toFixed(0)}KB  leídos:${buffer.length}B  ` +
				`host:${host.slice(0, 28)}`,
		);
		return buffer.length > 0;
	} catch (error) {
		console.log(`${label.padEnd(26)} ERROR: ${error.message}  host:${host.slice(0, 28)}`);
		return false;
	}
};

for (const name of ['IOS', 'ANDROID_VR']) {
	const json = await callPlayer(CLIENTS[name]);
	const formats = [...(json.streamingData?.adaptiveFormats || []), ...(json.streamingData?.formats || [])];
	const video = formats.filter((f) => f.mimeType.startsWith('video')).sort((a, b) => (b.height || 0) - (a.height || 0))[0];
	const audio = formats.filter((f) => f.mimeType.startsWith('audio')).sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))[0];
	const muxed = formats.find((f) => f.mimeType.startsWith('video') && f.audioQuality);

	console.log(`\n${name}: ${formats.length} formatos`);
	if (video) await testFetch(video, `vídeo ${video.qualityLabel || video.itag}`);
	if (audio) await testFetch(audio, `audio ${audio.itag}`);
	if (muxed) await testFetch(muxed, `progresivo ${muxed.qualityLabel || muxed.itag}`);
}