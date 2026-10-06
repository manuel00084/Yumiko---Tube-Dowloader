/**
 * Prueba del processor que se inyecta en la pagina (extension/lib/processor.audio.js):
 * convierte audio a MP3, devuelve la URL del blob y permite releer sus bytes por
 * trozos, que es el mecanismo de respaldo si el navegador no guarda la URL.
 * Comprueba además que el bundle de video va aparte y sin el codificador de MP3.
 *
 * Uso: node scripts/test-page-processor.mjs
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	BufferSource,
	BufferTarget,
	Conversion,
	Input,
	Mp4OutputFormat,
	Output,
	WaveInputFormat,
} from 'mediabunny';

const root = path.dirname(fileURLToPath(new URL('.', import.meta.url)));
const bundle = path.join(root, 'extension/lib/processor.audio.js');
const videoBundle = path.join(root, 'extension/lib/processor.video.js');

for (const [file, label] of [
	[bundle, 'processor.audio.js'],
	[videoBundle, 'processor.video.js'],
]) {
	if (!fs.existsSync(file)) {
		console.error(`Falta extension/lib/${label}. Ejecuta antes: npm run build`);
		process.exit(1);
	}
}

// Node no tiene Web Audio, que es lo que usa mediabunny para entregar las
// muestras ya decodificadas. Shim mÃ­nimo para poder ejercitar el processor.
if (typeof globalThis.AudioBuffer !== 'function') {
	globalThis.AudioBuffer = class AudioBuffer {
		constructor({ numberOfChannels, length, sampleRate }) {
			this.numberOfChannels = numberOfChannels;
			this.length = length;
			this.sampleRate = sampleRate;
			this.channels = Array.from({ length: numberOfChannels }, () => new Float32Array(length));
		}
		get duration() {
			return this.length / this.sampleRate;
		}
		getChannelData(index) {
			return this.channels[index];
		}
		copyToChannel(data, index) {
			this.channels[index].set(data.subarray(0, this.length));
		}
	};
}

const BITRATES_V1_L3 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0];
const RATES_V1 = [44100, 48000, 32000, 0];

/** Lee la cabecera del primer frame MP3 y usa el Xing para saber los frames. */
const readMp3Info = (buffer) => {
	let offset = 0;
	if (buffer.subarray(0, 3).toString('latin1') === 'ID3') {
		offset = 10 + ((buffer[6] << 21) | (buffer[7] << 14) | (buffer[8] << 7) | buffer[9]);
	}
	while (offset < buffer.length - 4) {
		if (buffer[offset] === 0xff && (buffer[offset + 1] & 0xe0) === 0xe0) break;
		offset++;
	}

	const header = buffer.readUInt32BE(offset);
	const versionBits = (header >> 19) & 0x3;
	const layerBits = (header >> 17) & 0x3;
	const bitrateIndex = (header >> 12) & 0xf;
	const rateIndex = (header >> 10) & 0x3;
	const padding = (header >> 9) & 0x1;
	const sampleRate = RATES_V1[rateIndex];
	const bitrate = BITRATES_V1_L3[bitrateIndex] * 1000;
	const channels = ((header >> 6) & 0x3) === 3 ? 1 : 2;
	const samplesPerFrame = versionBits === 3 ? 1152 : 576;
	const frameLength = Math.floor((samplesPerFrame / 8) * (bitrate / sampleRate)) + padding;

	// El primer frame lleva la cabecera Xing/Info, despuÃ©s de la cabecera y la
	// informaciÃ³n lateral (que ocupa de 17 a 32 bytes segÃºn el canal).
	let frameCount = 0;
	let tagOffset = -1;
	for (let probe = offset + 4; probe < offset + 64; probe += 4) {
		const candidate = buffer.subarray(probe, probe + 4).toString('latin1');
		if (candidate === 'Xing' || candidate === 'Info') {
			tagOffset = probe;
			break;
		}
	}
	if (tagOffset >= 0) {
		const flags = buffer.readUInt32BE(tagOffset + 4);
		if (flags & 0x1) frameCount = buffer.readUInt32BE(tagOffset + 8);
	}

	// El frame siguiente ya es audio de verdad: su cabecera dice el bitrate real
	// (el frame Xing puede no llevar el bitrate que se pidiÃ³).
	const audioStart = offset + frameLength;
	const audioHeader = buffer.readUInt32BE(audioStart);
	const audioBitrate = BITRATES_V1_L3[(audioHeader >> 12) & 0xf] * 1000;

	return {
		id3: offset,
		mpegVersion: versionBits === 3 ? 'MPEG1' : versionBits === 2 ? 'MPEG2' : 'MPEG2.5',
		layer: 4 - layerBits,
		sampleRate,
		bitrate: audioBitrate,
		channels,
		frameLength,
		frameCount,
		duration: (frameCount * samplesPerFrame) / sampleRate,
	};
};

const assert = (condition, message) => {
	if (!condition) throw new Error(`FALLO: ${message}`);
	console.log(`  ok  ${message}`);
};

const SAMPLE_RATE = 44100;
const SECONDS = 2;

const makeWav = () => {
	const frames = SAMPLE_RATE * SECONDS;
	const data = Buffer.alloc(frames * 4);
	for (let i = 0; i < frames; i++) {
		const t = i / SAMPLE_RATE;
		data.writeInt16LE(Math.round(Math.sin(2 * Math.PI * 440 * t) * 0.4 * 32767), i * 4);
		data.writeInt16LE(Math.round(Math.sin(2 * Math.PI * 660 * t) * 0.4 * 32767), i * 4 + 2);
	}
	const header = Buffer.alloc(44);
	header.write('RIFF', 0);
	header.writeUInt32LE(36 + data.length, 4);
	header.write('WAVE', 8);
	header.write('fmt ', 12);
	header.writeUInt32LE(16, 16);
	header.writeUInt16LE(1, 20);
	header.writeUInt16LE(2, 22);
	header.writeUInt32LE(SAMPLE_RATE, 24);
	header.writeUInt32LE(SAMPLE_RATE * 4, 28);
	header.writeUInt16LE(4, 32);
	header.writeUInt16LE(16, 34);
	header.write('data', 36);
	header.writeUInt32LE(data.length, 40);
	return Buffer.concat([header, data]);
};

const wav = makeWav();

// Un MP4 con imagen y sonido a la vez, como el archivo progresivo de YouTube:
// es el origen del MP3 cuando los streams de solo audio se rechazan con 403.
const makeMuxedMp4 = async () => {
	const input = new Input({
		formats: [new WaveInputFormat()],
		source: new BufferSource(wav),
	});
	const output = new Output({ format: new Mp4OutputFormat({ fastStart: 'in-memory' }), target: new BufferTarget() });
	const conversion = await Conversion.init({
		input,
		output,
		tracks: 'primary',
		copy: { mode: 'preferred' },
		composable: true,
		showWarnings: false,
		audio: {},
	});
	await output.start();
	await conversion.execute();
	await output.finalize();
	await input.dispose();
	return Buffer.from(output.target.buffer);
};

const mp4 = await makeMuxedMp4();

// Al igual que la CDN de YouTube: los rangos abiertos se rechazan con 403.
const server = http.createServer((req, res) => {
	const isMuxed = req.url.includes('muxed');
	const cuerpo = isMuxed ? mp4 : wav;
	const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
	const headers = {
		'content-type': isMuxed ? 'video/mp4' : 'audio/wav',
		'content-length': cuerpo.length,
		'accept-ranges': 'bytes',
		'access-control-allow-origin': '*',
	};
	if (range) {
		if (!range[2]) {
			res.writeHead(403, headers);
			res.end();
			return;
		}
		const start = range[1] ? Number(range[1]) : 0;
		const end = Math.min(Number(range[2]), cuerpo.length - 1);
		res.writeHead(206, {
			...headers,
			'content-range': `bytes ${start}-${end}/${cuerpo.length}`,
			'content-length': end - start + 1,
		});
		res.end(cuerpo.subarray(start, end + 1));
		return;
	}
	res.writeHead(200, headers);
	res.end(cuerpo);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const url = `${base}/audio.wav`;
const muxedUrl = `${base}/muxed.mp4`;

console.log('\n1) El processor se registra en la pagina');
await import(`../extension/lib/processor.audio.js?t=${Date.now()}`);
assert(globalThis.__yumikoReady === true, 'marca __yumikoReady');
assert(globalThis.__yumikoKind === 'audio', `identifica su módulo (${globalThis.__yumikoKind})`);
assert(typeof globalThis.__yumikoProcess === 'function', 'expone __yumikoProcess');
assert(typeof globalThis.__yumikoReadChunk === 'function', 'expone __yumikoReadChunk');
assert(typeof globalThis.__yumikoRelease === 'function', 'expone __yumikoRelease');
assert(typeof globalThis.__yumikoCancel === 'function', 'expone __yumikoCancel');

console.log('\n1b) Los dos módulos van en bundles separados');
const audioSource = fs.readFileSync(bundle, 'utf8');
const videoSource = fs.readFileSync(videoBundle, 'utf8');
assert(audioSource.includes('Mp3Encoder'), 'el de audio lleva el codificador de MP3');
assert(!videoSource.includes('Mp3Encoder'), 'el de video NO lleva el codificador de MP3');
assert(!audioSource.includes('muxVideo'), 'el de audio NO lleva la unión de vídeo');
assert(videoSource.includes('muxVideo'), 'el de video sí lleva la unión');
assert(fs.statSync(bundle).size !== fs.statSync(videoBundle).size, 'los dos bundles pesan distinto');

console.log('\n2) Convertir a MP3 dentro de la pagina');
globalThis.__yumikoProgress = { id: 'x', phase: '', progress: 0 };
// El processor devuelve el resultado y los errores envueltos, para que un
// fallo dentro de la página no se convierta en un "resultado vacío".
const run = async (payload) => {
	const reply = await globalThis.__yumikoProcess(payload);
	assert(reply && typeof reply.ok === 'boolean', 'siempre responde con ok/error');
	if (!reply.ok) throw Object.assign(new Error(reply.error?.message || 'sin mensaje'), { name: reply.error?.name });
	return reply.value;
};
const result = await run({
	id: 'job-1',
	job: 'mp3',
	audioUrls: [url],
	bitrate: 128,
	title: 'Prueba',
	artist: 'Yumiko',
	phase: 'Convirtiendo a MP3',
});

assert(result.url.startsWith('blob:'), `devuelve una URL de blob (${result.url.slice(0, 24)}â€¦)`);
assert(result.size > 1000, `informa del tamaÃ±o (${result.size} bytes)`);
assert(/audio|mpeg|mp3/.test(result.mimeType), `indica el tipo (${result.mimeType})`);
assert(globalThis.__yumikoProgress.id === 'job-1', 'el progreso lleva el id del trabajo');
assert(globalThis.__yumikoProgress.phase === 'Listo para guardar', 'acaba en "Listo para guardar"');

console.log('\n2b) Extraer el audio sin convertir dentro de la pagina');
// Este job es el que se rompia con "Mp4OutputFormat is not defined": el modulo
// de audio usaba tres exports de mediabunny sin importarlos.
const extracted = await run({
	id: 'job-extract',
	job: 'extract',
	audioUrl: url,
	container: 'mp4',
	title: 'Prueba',
	artist: 'Yumiko',
	phase: 'Extrayendo el audio',
});
assert(extracted.url.startsWith('blob:'), 'devuelve una URL de blob');
assert(extracted.size > 1000, `informa del tamaño (${extracted.size} bytes)`);
assert(/mp4|mpeg/i.test(extracted.mimeType), `indica el tipo (${extracted.mimeType})`);
globalThis.__yumikoRelease(extracted.url);

console.log('\n2c) MP3 a partir del video completo (el origen que no rechaza la CDN)');
// Cuando los streams de solo audio fallan con 403, el popup manda el archivo
// progresivo. Aqui se comprueba que sale igual de bien un MP3 y que el
// resultado no arrastra la pista de video.
const desdeVideo = await run({
	id: 'job-muxed',
	job: 'mp3',
	audioUrls: [muxedUrl],
	bitrate: 128,
	title: 'Prueba',
	phase: 'Convirtiendo a MP3',
});
assert(desdeVideo.url.startsWith('blob:'), 'convierte el video a MP3');
assert(desdeVideo.size > 1000, `informa del tamaño (${desdeVideo.size} bytes)`);
assert(/audio\/mpeg/.test(desdeVideo.mimeType), `sale como audio (${desdeVideo.mimeType})`);
const bytesMuxed = [];
for (let off = 0; off < desdeVideo.size; ) {
	const chunk = await globalThis.__yumikoReadChunk(desdeVideo.url, off, 4096);
	if (chunk.data) bytesMuxed.push(Buffer.from(chunk.data, 'base64'));
	if (chunk.done) break;
	off += chunk.bytes;
}
const infoMuxed = readMp3Info(Buffer.concat(bytesMuxed));
assert(infoMuxed.layer === 3, `es MP3 (Layer ${infoMuxed.layer})`);
assert(Math.abs(infoMuxed.duration - SECONDS) < 0.2, `con la duración del audio (${infoMuxed.duration.toFixed(2)}s)`);
globalThis.__yumikoRelease(desdeVideo.url);

console.log('\n3) Respaldo: releer el blob por trozos');
const parts = [];
let offset = 0;
for (;;) {
	const chunk = await globalThis.__yumikoReadChunk(result.url, offset, 1024);
	if (chunk.data) {
		parts.push(Buffer.from(chunk.data, 'base64'));
		assert(chunk.bytes > 0 && chunk.bytes <= 1024, `informa de los bytes leÃ­dos (${chunk.bytes} de ${chunk.data.length} en base64)`);
		offset += chunk.bytes;
	}
	if (chunk.done) break;
}
const rebuilt = Buffer.concat(parts);
assert(rebuilt.length === result.size, `se recuperan todos los bytes (${rebuilt.length}/${result.size})`);
assert(
	rebuilt.subarray(0, 3).equals(Buffer.from([0x49, 0x44, 0x33])) || rebuilt[0] === 0xff,
	'el contenido empieza por la firma de un MP3 (ID3 o frame)',
);

const info = readMp3Info(rebuilt);
assert(info.layer === 3, `es MP3 (Layer ${info.layer}, ${info.mpegVersion})`);
assert(info.sampleRate === 44100 || info.sampleRate === 48000, `frecuencia vÃ¡lida (${info.sampleRate} Hz)`);
assert(Math.abs(info.duration - SECONDS) < 0.1, `con la duraciÃ³n correcta (${info.duration.toFixed(2)}s de ${SECONDS}s)`);
assert(info.frameCount > 20, `tiene frames completos (${info.frameCount})`);
assert(
	Math.abs(info.bitrate - 128000) < 20000,
	`el bitrate elegido se respeta (~${Math.round(info.bitrate / 1000)} kbps de los 128 pedidos)`,
);

console.log('\n4) Liberar el blob');
assert(globalThis.__yumikoRelease(result.url) === true, 'libera el blob');
assert(globalThis.__yumikoRelease(result.url) === false, 'no falla si ya estaba liberado');

console.log('\n5) Trabajos desconocidos y cancelacion');
try {
	await run({ id: 'z', job: 'inventado' });
	assert(false, 'debería lanzar error');
} catch (error) {
	assert(/Trabajo desconocido/.test(error.message), `rechaza el trabajo desconocido (${error.message})`);
}
assert(globalThis.__yumikoCancel('no-existe') === false, 'cancelar sin trabajo devuelve false');

console.log('\n6) Cancelar un trabajo en marcha');
const slow = new Promise((resolve) => {
	setTimeout(() => resolve(new Response('tarde', { status: 200 })), 400);
});
const slowServer = http.createServer(async (_req, res) => {
	await slow;
	res.writeHead(200, { 'content-type': 'audio/wav', 'content-length': wav.length, 'accept-ranges': 'bytes' });
	res.end(wav);
});
await new Promise((resolve) => slowServer.listen(0, '127.0.0.1', resolve));
const slowUrl = `http://127.0.0.1:${slowServer.address().port}/lenta.wav`;
const job = run({ id: 'job-lento', job: 'mp3', audioUrls: [slowUrl], bitrate: 128 });
await new Promise((resolve) => setTimeout(resolve, 80));
assert(globalThis.__yumikoCancel('job-lento') === true, 'el trabajo en marcha se cancela');
let cancelled = false;
try {
	await job;
} catch (error) {
	cancelled = /cancelad/i.test(error.message);
}
assert(cancelled, 'el trabajo lanza el error de cancelaciÃ³n');
slowServer.close();

server.close();
console.log('\nTodo correcto.');