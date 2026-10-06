/**
 * MÓDULO DE VÍDEO.
 *
 * Solo sabe unir el stream de vídeo con el de audio de YouTube en un único
 * archivo (MP4 o WebM) copiando los paquetes, sin recodificar. No importa nada
 * del audio suelto ni del MP3: así este módulo no puede romperse por culpa del
 * otro y se carga solo cuando se descarga un vídeo.
 */
import { Conversion, Mp4OutputFormat, WebMOutputFormat } from 'mediabunny';
import {
	CopyError,
	addAbortListener,
	createOutput,
	describeError,
	inputOf,
	isCancelled,
	CancelledError,
	throwIfAborted,
} from './media-common.js';

const createFormat = (container) =>
	container === 'webm' ? new WebMOutputFormat() : new Mp4OutputFormat({ fastStart: 'in-memory' });

/**
 * Une el vídeo y el audio separados de YouTube en un solo archivo. Primero
 * intenta copiar los paquetes tal cual (sin pérdida ni CPU); si los códecs no
 * son compatibles con el contenedor, recodifica.
 */
export const muxVideo = async ({ videoUrl, audioUrl, container, title, onProgress, signal }) => {
	throwIfAborted(signal);
	let lastCopyError = null;

	for (const mode of ['forced', 'preferred']) {
		const format = createFormat(container);
		const destination = await createOutput(format);
		const { output } = destination;
		let videoInput = null;
		let audioInput = null;

		try {
			if (title) output.setMetadataTags({ title });
			videoInput = inputOf(videoUrl);
			audioInput = inputOf(audioUrl);

			const videoConversion = await Conversion.init({
				input: videoInput,
				output,
				tracks: 'primary',
				copy: { mode },
				composable: true,
				showWarnings: false,
				video: {},
				audio: { discard: true },
			});
			const audioConversion = await Conversion.init({
				input: audioInput,
				output,
				tracks: 'primary',
				copy: { mode },
				composable: true,
				showWarnings: false,
				video: { discard: true },
				audio: {},
			});

			// Solo interesan las pistas descartadas sin querer: cada conversión
			// descarta a propósito el tipo de pista que no le toca.
			const unexpected = [
				...videoConversion.discardedTracks,
				...audioConversion.discardedTracks,
			].filter((discarded) => !discarded.trackOptions?.discard);
			if (unexpected.length > 0 || !videoConversion.isValid || !audioConversion.isValid) {
				throw new CopyError(`Pista no válida para ${container}: ${unexpected[0]?.reason ?? 'conversión inválida'}`);
			}

			await output.start();

			const progress = { video: 0, audio: 0 };
			const report = () => onProgress?.(Math.min(progress.video, progress.audio));
			videoConversion.onProgress = (value) => {
				progress.video = value;
				report();
			};
			audioConversion.onProgress = (value) => {
				progress.audio = value;
				report();
			};

			const conversions = [videoConversion, audioConversion];
			const unhook = addAbortListener(signal, () => conversions.forEach((conversion) => conversion.cancel()));

			try {
				await Promise.all(conversions.map((conversion) => conversion.execute()));
			} finally {
				unhook();
			}

			await output.finalize();
			const result = await destination.result();
			return { ...result, cleanup: destination.cleanup };
		} catch (error) {
			await output.cancel().catch(() => {});
			await destination.cleanup();
			if (isCancelled(error)) throw new CancelledError();
			if (error instanceof CopyError && mode === 'forced') {
				lastCopyError = error;
				continue;
			}
			throw describeError(error);
		} finally {
			videoInput?.dispose();
			audioInput?.dispose();
		}
	}

	throw new Error(lastCopyError?.message || 'No se ha podido combinar el vídeo con el audio.');
};
