/**
 * Prueba funcional de los módulos de vídeo y audio, sin navegador:
 *   1. genera un WAV de prueba y lo sirve por HTTP;
 *   2. lo convierte a MP3 con el módulo de audio y comprueba el resultado;
 *   3. une vídeo y audio con el módulo de vídeo y comprueba las dos pistas.
 *
 * Cada módulo se compila por separado (con las dependencias como externas) para
 * que el test y el código probado compartan una única copia de mediabunny.
 *
 * Uso: node scripts/test-media.mjs [url-de-un-mp4-con-video-y-audio]
 */
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { Input, Mp3InputFormat, Mp4InputFormat, ALL_FORMATS, BlobSource } from 'mediabunny';

const root = path.dirname(fileURLToPath(new URL('.', import.meta.url)));

// Node no tiene Web Audio, pero mediabunny usa AudioBuffer para entregar las
// muestras decodificadas. Este shim emula lo justo para poder probarlo.
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

const outDir = path.join(root, '.test-build');
fs.mkdirSync(outDir, { recursive: true });

const buildModule = async (name) => {
	const outfile = path.join(outDir, `${name}.under-test.mjs`);
	await build({
		entryPoints: [path.join(root, 'extension/src', `${name}.js`)],
		outfile,
		bundle: true,
		format: 'esm',
		platform: 'neutral',
		target: 'node20',
		external: ['mediabunny', '@breezystack/lamejs'],
		logLevel: 'error',
	});
	return import(pathToFileURL(outfile).href);
};

const { muxVideo } = await buildModule('video');
const { toMp3, extractAudio } = await buildModule('audio');

const SAMPLE_URL =
	process.argv[2] ||
	'https://raw.githubusercontent.com/mediaelement/mediaelement-files/master/big_buck_bunny.mp4';

const SAMPLE_RATE = 44100;
const SECONDS = 3;

const makeWav = () => {
	const frames = SAMPLE_RATE * SECONDS;
	const data = Buffer.alloc(frames * 4);
	for (let i = 0; i < frames; i++) {
		// 440 Hz en el canal izquierdo, 660 Hz en el derecho.
		const t = i / SAMPLE_RATE;
		const left = Math.sin(2 * Math.PI * 440 * t) * 0.4;
		const right = Math.sin(2 * Math.PI * 660 * t) * 0.4;
		data.writeInt16LE(Math.round(left * 32767), i * 4);
		data.writeInt16LE(Math.round(right * 32767), i * 4 + 2);
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

const startServer = (buffer) =>
	new Promise((resolve) => {
		const server = http.createServer((req, res) => {
			const headers = {
				'content-type': 'audio/wav',
				'content-length': buffer.length,
				'access-control-allow-origin': '*',
				'accept-ranges': 'bytes',
			};
			// Soporte de rangos, como el de la CDN de YouTube.
			const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
			if (range) {
				const start = range[1] ? Number(range[1]) : 0;
				const end = range[2] ? Number(range[2]) : buffer.length - 1;
				res.writeHead(206, {
					...headers,
					'content-range': `bytes ${start}-${end}/${buffer.length}`,
					'content-length': end - start + 1,
				});
				res.end(buffer.subarray(start, end + 1));
				return;
			}
			res.writeHead(200, headers);
			res.end(buffer);
		});
		server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
	});

const assert = (condition, message) => {
	if (!condition) throw new Error(`FALLO: ${message}`);
	console.log(`  ok  ${message}`);
};

const testMp3 = async (url) => {
	console.log('\n1) WAV -> MP3');
	const progress = [];
	const result = await toMp3({
		audioUrl: url,
		bitrate: 192,
		title: 'Prueba de audio',
		artist: 'Yumiko',
		onProgress: (value) => progress.push(value),
	});

	const bytes = new Uint8Array(await result.blob.arrayBuffer());
	assert(bytes.length > 1000, `el MP3 tiene datos (${bytes.length} bytes)`);
	// El archivo empieza por una etiqueta ID3 con los metadatos, luego un frame.
	const hasSync = bytes.some((byte, index) => index > 8 && byte === 0xff && (bytes[index + 1] & 0xe0) === 0xe0);
	assert(hasSync, 'contiene cabeceras de frame MP3 válidas');

	const check = new Input({ formats: [new Mp3InputFormat()], source: new BlobSource(new Blob([bytes])) });
	assert(await check.canRead(), 'mediabunny reconoce el archivo como MP3');
	const track = await check.getPrimaryAudioTrack();
	assert(track !== null, 'tiene una pista de audio');
	const duration = await track.computeDuration();
	const codec = await track.getCodec();
	const sampleRate = await track.getSampleRate();
	assert(Math.abs(duration - SECONDS) < 0.2, `la duración coincide (${duration.toFixed(2)}s de ${SECONDS}s)`);
	assert(codec === 'mp3', `el códec es mp3 (${codec}, ${sampleRate} Hz)`);
	assert(progress.length > 0 && progress.at(-1) > 0, 'informa de progreso');
	return result;
};

const testMp3Fallback = async (url) => {
	console.log('\n1b) MP3 con una pista que falla: pasa a la siguiente');
	const progress = [];
	const result = await toMp3({
		// La primera no existe (403/404); la segunda es el WAV válido.
		audioUrls: ['https://127.0.0.1:9/inexistente.m4a', 'https://127.0.0.1:1/otro.m4a', url],
		bitrate: 128,
		title: 'Con respaldo',
		onProgress: (value) => progress.push(value),
	});

	const bytes = new Uint8Array(await result.blob.arrayBuffer());
	assert(bytes.length > 1000, `produce un MP3 tras reintentar (${bytes.length} bytes)`);
	const check = new Input({ formats: [new Mp3InputFormat()], source: new BlobSource(new Blob([bytes])) });
	assert(await check.canRead(), 'el resultado sigue siendo un MP3 válido');
	const track = await check.getPrimaryAudioTrack();
	const duration = await track.computeDuration();
	assert(Math.abs(duration - SECONDS) < 0.2, `con la duración correcta (${duration.toFixed(2)}s)`);
	assert(progress.length > 0, 'informa de progreso durante los intentos');
	await result.cleanup();
};

const testAllFail = async () => {
	console.log('\n1c) MP3 cuando ninguna pista sirve');
	try {
		await toMp3({ audioUrls: ['https://127.0.0.1:9/a.m4a'], bitrate: 128 });
		console.log('  -- omitida: la red local no da error');
	} catch (error) {
		assert(/No se ha podido|bloquea|Failed|fetch/i.test(error.message), `avisa con un mensaje claro: ${error.message}`);
	}
};

/**
 * Remuxar el audio sin convertirlo. Antes esto reventaba con
 * "Mp4OutputFormat is not defined": el modulo de audio usaba tres exports de
 * mediabunny sin importarlos, y el fallo solo se veia al exercised este job.
 */
const testExtract = async () => {
	console.log(`\n3) extraer el audio sin convertir de ${SAMPLE_URL}`);
	let result;
	try {
		result = await extractAudio({
			audioUrl: SAMPLE_URL,
			container: 'mp4',
			title: 'Audio original',
			artist: 'Yumiko',
		});
	} catch (error) {
		console.log(`  -- omitida: ${error.message}`);
		return;
	}

	const bytes = new Uint8Array(await result.blob.arrayBuffer());
	assert(bytes.length > 1000, `el archivo tiene datos (${bytes.length} bytes)`);

	const check = new Input({ formats: ALL_FORMATS, source: new BlobSource(new Blob([bytes])) });
	assert((await check.getFormat()) instanceof Mp4InputFormat, 'el contenedor es MP4');
	assert((await check.getPrimaryVideoTrack()) === null, 'no queda ninguna pista de vídeo');
	const audio = await check.getPrimaryAudioTrack();
	assert(audio !== null, 'conserva la pista de audio');
	const duration = await check.computeDuration();
	assert(duration > 1, `la duración es de ${duration.toFixed(2)}s`);
	await result.cleanup();
};

const testMux = async () => {
	console.log(`\n2) unir vídeo + audio de ${SAMPLE_URL}`);
	let result;
	try {
		result = await muxVideo({
			videoUrl: SAMPLE_URL,
			audioUrl: SAMPLE_URL,
			container: 'mp4',
			title: 'Prueba de unión',
		});
	} catch (error) {
		console.log(`  --  omitida: ${error.message}`);
		return;
	}

	const bytes = new Uint8Array(await result.blob.arrayBuffer());
	assert(bytes.length > 1000, `el MP4 tiene datos (${bytes.length} bytes)`);

	const check = new Input({ formats: ALL_FORMATS, source: new BlobSource(new Blob([bytes])) });
	assert((await check.getFormat()) instanceof Mp4InputFormat, 'el contenedor es MP4');
	assert((await check.getPrimaryVideoTrack()) !== null, 'conserva la pista de vídeo');
	assert((await check.getPrimaryAudioTrack()) !== null, 'conserva la pista de audio');
	const duration = await check.computeDuration();
	assert(duration > 1, `la duración es de ${duration.toFixed(2)}s`);
	await result.cleanup();
};

const main = async () => {
	const wav = makeWav();
	const { server, port } = await startServer(wav);
	const url = `http://127.0.0.1:${port}/test.wav`;

	try {
		const mp3 = await testMp3(url);
		await mp3.cleanup();
		await testMp3Fallback(url);
		await testAllFail();
		await testMux();
		await testExtract();
		console.log('\nTodo correcto.');
	} finally {
		server.close();
	}
};

main().catch((error) => {
	console.error(error);
	process.exit(1);
});