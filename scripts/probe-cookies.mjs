/**
 * ¿La sesión con cookies cambia la respuesta de innertube?
 * En el navegador la petición va con cookies; mis pruebas iban sin ellas.
 *
 * Uso: node scripts/probe-cookies.mjs [videoId]
 */
const UA =
	'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36';

const videoId = process.argv[2] || '6VTFf6nMcHk';
const pageUrl = `https://www.youtube.com/watch?v=${videoId}&list=RD${videoId}&start_radio=1`;

const jar = {};
const first = await fetch(pageUrl, { headers: { 'User-Agent': UA, 'Accept-Language': 'es-ES,es;q=0.9' } });
for (const entry of first.headers.getSetCookie?.() || []) {
	const pair = entry.split(';')[0];
	const index = pair.indexOf('=');
	jar[pair.slice(0, index)] = pair.slice(index + 1);
}
console.log('URL de la página:', pageUrl);
console.log('cookies recibidas:', Object.keys(jar).join(', ') || '(ninguna)');

const html = await first.text();
const apiKey = /"INNERTUBE_API_KEY":"([^"]+)"/.exec(html)?.[1];
const visitor = /"VISITOR_DATA":"([^"]+)"/.exec(html)?.[1];
const cookie = Object.entries(jar)
	.map(([key, value]) => `${key}=${value}`)
	.join('; ');

const call = async (label, extraHeaders) => {
	const response = await fetch(`https://www.youtube.com/youtubei/v1/player?key=${apiKey}`, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			'User-Agent': UA,
			'X-YouTube-Client-Name': 'ANDROID',
			'X-YouTube-Client-Version': '20.10.38',
			...extraHeaders,
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
			contentCheckOk: true,
			racyCheckOk: true,
		}),
	});
	const json = await response.json();
	const formats = [
		...(json.streamingData?.adaptiveFormats || []),
		...(json.streamingData?.formats || []),
	];
	console.log(
		`${label.padEnd(32)} HTTP ${response.status}  estado: ${json.playabilityStatus?.status}  ` +
			`formatos: ${formats.length}  con url: ${formats.filter((f) => f.url).length}  ` +
			`${(json.playabilityStatus?.reason || '').slice(0, 60)}`,
	);
};

await call('sin cookies', {});
await call('con cookies de la página', { cookie });
await call('con cookies + cabecera visitor', { cookie, 'X-Goog-Visitor-Id': visitor });