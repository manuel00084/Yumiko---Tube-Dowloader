/**
 * MÓDULO DE AUDIO.
 *
 * Solo sabe extraer el audio de un vídeo: convertirlo a MP3 con lamejs (que va
 * incluido en la extensión) o remuxarlo sin tocar. No importa nada de unir
 * vídeo, así que este módulo no puede romperse por culpa del otro y se carga
 * solo cuando se descarga audio suelto.
 */
import {
	AudioBufferSink,
	Conversion,
	EncodedAudioPacketSource,
	EncodedPacket,
	Mp3InputFormat,
	Mp3OutputFormat,
	Mp4OutputFormat,
	WebMOutputFormat,
	AdtsInputFormat,
	OggInputFormat,
	WaveInputFormat,
} from 'mediabunny';
import { Mp3Encoder } from '@breezystack/lamejs';
import {
	addAbortListener,
	BASE_INPUT_FORMATS,
	createOutput,
	describeError,
	inputOf,
	isCancelled,
	CancelledError,
	throwIfAborted,
} from './media-common.js';

// Contenedores de solo audio que puede servir YouTube (además de MP4/WebM).
const AUDIO_INPUT_FORMATS = [
	new Mp3InputFormat(),
	new AdtsInputFormat(),
	new OggInputFormat(),
	new WaveInputFormat(),
];

const MP3_FRAME_SAMPLES = 1152;
const MP3_SAMPLE_RATES = [8000, 11025, 12000, 16000, 22050, 24000, 32000, 44100, 48000];

const audioInputOf = (url) => inputOf(url, [...BASE_INPUT_FORMATS, ...AUDIO_INPUT_FORMATS]);
const nearestSampleRate = (rate) =>
	MP3_SAMPLE_RATES.includes(rate)
		? rate
		: MP3_SAMPLE_RATES.reduce((best, candidate) =>
				Math.abs(candidate - rate) < Math.abs(best - rate) ? candidate : best,
			);

/** Aplica downmix a estéreo/mono, remuestrea y devuelve los canales en Float32. */
const prepareBuffer = (buffer, ratio) => {
	const inputChannels = Math.min(buffer.numberOfChannels, 2);
	const outLength = Math.max(1, Math.floor(buffer.length / ratio));

	if (inputChannels === 1) {
		return [resampleChannel(buffer.getChannelData(0), ratio, outLength)];
	}

	return [
		resampleChannel(buffer.getChannelData(0), ratio, outLength),
		resampleChannel(buffer.getChannelData(1), ratio, outLength),
	];
};

const resampleChannel = (source, ratio, outLength) => {
	if (ratio === 1) return source.length === outLength ? source : source.slice(0, outLength);
	const target = new Float32Array(outLength);
	for (let i = 0; i < outLength; i++) {
		const position = i * ratio;
		const index = Math.floor(position);
		const a = source[index] ?? 0;
		const b = source[index + 1] ?? a;
		target[i] = a + (b - a) * (position - index);
	}
	return target;
};

const toPcm16 = (value) => Math.round((value < -1 ? -1 : value > 1 ? 1 : value) * 32767);

/** lamejs devuelve Int8Array en algunas versiones; mediabunny quiere Uint8Array. */
const asBytes = (data) =>
	data instanceof Uint8Array && data.constructor === Uint8Array
		? data
		: new Uint8Array(data.buffer ?? data, data.byteOffset ?? 0, data.byteLength);

/** Cola de muestras PCM que entrega bloques del tamaño que exige lamejs. */
class PcmQueue {
	#chunks = [];
	#frames = 0;
	#channels;

	constructor(channels) {
		this.#channels = channels;
	}

	get frames() {
		return this.#frames;
	}

	push(channels) {
		if (channels[0].length === 0) return;
		this.#chunks.push(channels);
		this.#frames += channels[0].length;
	}

	take(count) {
		const left = new Int16Array(count);
		const right = new Int16Array(count);
		let written = 0;

		while (written < count) {
			const chunk = this.#chunks[0];
			const available = chunk[0].length;
			const takeCount = Math.min(count - written, available);
			const leftChannel = chunk[0];
			const rightChannel = chunk[1];

			for (let i = 0; i < takeCount; i++) {
				left[written + i] = toPcm16(leftChannel[i]);
				right[written + i] = this.#channels > 1 ? toPcm16(rightChannel[i]) : left[written + i];
			}

			written += takeCount;
			this.#frames -= takeCount;

			if (takeCount === available) this.#chunks.shift();
			else {
				this.#chunks[0] = [leftChannel.subarray(takeCount), rightChannel?.subarray(takeCount)];
			}
		}

		return { left, right };
	}
}

/**
 * Decodifica el audio de YouTube y lo codifica a MP3 con lamejs, que va
 * empaquetado dentro de la propia extensión.
 */
const encodeToMp3 = async ({ audioUrl, bitrate, title, artist, onProgress, signal }) => {
	throwIfAborted(signal);
	const input = audioInputOf(audioUrl);
	const format = new Mp3OutputFormat({ xingHeader: true });
	const destination = await createOutput(format);

	try {
		const track = await input.getPrimaryAudioTrack();
		if (!track) throw new Error('El formato elegido no contiene ninguna pista de audio.');
		if (!(await track.canDecode())) {
			throw new Error(`Este navegador no sabe decodificar el audio de ese formato (${(await track.getCodecParameterString?.()) || 'códec desconocido'}).`);
		}
		// El origen puede ser el vídeo completo (el único stream que la CDN de
		// YouTube no rechaza con 403). No hay que descartarlo: el sink solo pide
		// la pista de audio, así que la imagen nunca se decodifica.

		const sourceRate = (await track.getSampleRate()) || 44100;
		const sampleRate = nearestSampleRate(sourceRate);
		const channels = Math.min((await track.getNumberOfChannels()) || 2, 2);
		const { output } = destination;

		if (title) output.setMetadataTags({ title, ...(artist ? { artist } : {}) });
		const audioSource = new EncodedAudioPacketSource('mp3');
		output.addAudioTrack(audioSource);
		await output.start();

		const encoder = new Mp3Encoder(channels, sampleRate, bitrate);
		const queue = new PcmQueue(channels);
		const ratio = sourceRate / sampleRate;
		const frameDuration = MP3_FRAME_SAMPLES / sampleRate;
		let timestamp = 0;
		let packetIndex = 0;

		const emit = async (raw) => {
			if (!raw || raw.byteLength === 0) return;
			const bytes = asBytes(raw);
			const packet = new EncodedPacket(bytes, 'key', timestamp, frameDuration, packetIndex);
			timestamp += frameDuration;
			packetIndex++;
			await audioSource.add(
				packet,
				packetIndex === 1
					? { decoderConfig: { codec: 'mp3', numberOfChannels: channels, sampleRate } }
					: undefined,
			);
		};

		const duration =
			(await track.getDurationFromMetadata().catch(() => null)) ?? (await track.computeDuration().catch(() => 0)) ?? 0;
		const sink = new AudioBufferSink(track);

		for await (const { buffer, timestamp: position } of sink.buffers()) {
			throwIfAborted(signal);
			queue.push(prepareBuffer(buffer, ratio));
			while (queue.frames >= MP3_FRAME_SAMPLES) {
				const { left, right } = queue.take(MP3_FRAME_SAMPLES);
				await emit(channels > 1 ? encoder.encodeBuffer(left, right) : encoder.encodeBuffer(left));
			}
			if (duration > 0) onProgress?.(Math.min(position / duration, 0.99));
		}

		await emit(encoder.flush());
		await output.finalize();
	} catch (error) {
		await destination.cleanup();
		throw describeError(error);
	} finally {
		input.dispose();
	}

	const result = await destination.result();
	return { ...result, cleanup: destination.cleanup };
};

/**
 * Convierte a MP3 probando las pistas de audio disponibles hasta que una
 * funcione: unas tienen un códec que el navegador no decodifica y otras
 * caducan antes que las demás.
 */
export const toMp3 = async ({ audioUrls, audioUrl, bitrate = 192, title, artist, onProgress, signal }) => {
	const candidates = [...new Set(audioUrls || (audioUrl ? [audioUrl] : []))];
	if (!candidates.length) throw new Error('No hay ninguna pista de audio que convertir.');

	const slice = 1 / candidates.length;
	let lastError = null;

	for (let index = 0; index < candidates.length; index++) {
		throwIfAborted(signal);
		const base = index * slice;
		try {
			return await encodeToMp3({
				audioUrl: candidates[index],
				bitrate,
				title,
				artist,
				signal,
				onProgress: (value) => onProgress?.(Math.min(base + value * slice, 1)),
			});
		} catch (error) {
			if (isCancelled(error)) throw new CancelledError();
			lastError = error;
			console.warn(`[Yumiko] pista de audio ${index + 1}/${candidates.length} no válida:`, error.message);
		}
	}

	throw describeError(lastError);
};

/** Remuxa el audio sin tocarlo (por ejemplo Opus dentro de WebM). */
export const extractAudio = async ({ audioUrl, container, title, artist, onProgress, signal }) => {
	throwIfAborted(signal);
	const input = audioInputOf(audioUrl);
	const format = container === 'webm' ? new WebMOutputFormat() : new Mp4OutputFormat({ fastStart: 'in-memory' });
	const destination = await createOutput(format);

	try {
		const { output } = destination;
		if (title) output.setMetadataTags({ title, ...(artist ? { artist } : {}) });

		// composable: es obligatorio porque se han puesto etiquetas y porque el
		// start() lo hace la propia extensión. En ese modo, output.start() va
		// DESPUÉS de init (init es la que añade la pista).
		const conversion = await Conversion.init({
			input,
			output,
			tracks: 'primary',
			copy: { mode: 'forced' },
			composable: true,
			showWarnings: false,
			video: { discard: true },
			audio: {},
		});
		// Solo interesan las pistas descartadas sin querer: el vídeo se descarta a propósito.
		const unexpected = conversion.discardedTracks.filter((discarded) => !discarded.trackOptions?.discard);
		if (unexpected.length > 0 || !conversion.isValid) {
			throw new Error(`No se puede convertir el audio: ${unexpected[0]?.reason ?? 'conversión inválida'}`);
		}

		await output.start();
		conversion.onProgress = (value) => onProgress?.(value);
		const unhook = addAbortListener(signal, () => conversion.cancel());
		try {
			await conversion.execute();
		} finally {
			unhook();
		}
		await output.finalize();
	} catch (error) {
		await destination.cleanup();
		throw describeError(error);
	} finally {
		input.dispose();
	}

	const result = await destination.result();
	return { ...result, cleanup: destination.cleanup };
};
