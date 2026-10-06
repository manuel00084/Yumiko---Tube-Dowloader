/**
 * Experimento decisivo: ¿el 403 viene de la cabecera Origin que envía la
 * extensión al pedir el stream a la CDN?
 *
 * Uso: node scripts/probe-origin.mjs [videoId]
 */
const UA =
	'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36';

const videoId = process.argv[2] || '6VTFf6nMcHk';

const page = await fetch(`https://www.youtube.com/watch?v=${videoId}&hl=es`, {
	headers: { 'User-Agent': UA },
});
const html = await page.text();
const apiKey = /"INNERTUBE_API_KEY":"([^"]+)"/.exec(html)?.[1];
const visitor = /"VISITOR_DATA":"([^"]+)"/.exec(html)?.[1];

const player = await (await fetch(`https://www.youtube.com/youtubei/v1/player?key=${apiKey}`, {
	method: 'POST',
	headers: {
		'Content-Type': 'application/json',
		'User-Agent': UA,
		'X-YouTube-Client-Name': 'ANDROID',
		'X-YouTube-Client-Version': '20.10.38',
	},
	body: JSON.stringify({
		videoId,
		context: {
			client: {
				clientName: 'ANDROID',
				clientVersion: '20.10.38',
				androidSdkVersion: 34,
				hl: 'es',
				gl: 'ES',
				...(visitor ? { visitorData: visitor } : {}),
			},
		},
	}),
})).json();

const formats = [...(player.streamingData?.adaptiveFormats || []), ...(player.streamingData?.formats || [])];
const targets = [
	formats.filter((f) => f.mimeType.startsWith('audio')).sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))[0],
	formats.filter((f) => f.mimeType.startsWith('video')).sort((a, b) => (b.height || 0) - (a.height || 0))[0],
	formats.find((f) => f.qualityLabel === '360p'),
].filter(Boolean);

const test = async (format, label, headers) => {
	const host = new URL(format.url).host;
	try {
		const response = await fetch(format.url, { headers: { Range: 'bytes=0-1023', ...headers } });
		console.log(
			`  ${label.padEnd(38)} HTTP ${String(response.status).padEnd(4)} ` +
				`CORS:${(response.headers.get('access-control-allow-origin') || '-').padEnd(28)} ${host.slice(0, 26)}`,
		);
		return response.status;
	} catch (error) {
		console.log(`  ${label.padEnd(38)} ERROR ${error.message.slice(0, 40).padEnd(40)} ${host.slice(0, 26)}`);
		return null;
	}
};

console.log(`Vídeo ${videoId}\n`);
for (const format of targets) {
	console.log(`itag ${format.itag} (${(format.mimeType || '').slice(0, 30)})`);
	await test(format, 'sin Origin (como chrome.downloads)', {});
	await test(format, 'Origin: chrome-extension://abc123', { Origin: 'chrome-extension://abc123' });
	await test(format, 'Origin: https://www.youtube.com', { Origin: 'https://www.youtube.com' });
	await test(format, 'Origin: null', { Origin: 'null' });
	console.log('');
}