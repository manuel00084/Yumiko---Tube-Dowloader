/**
 * Processor de AUDIO para la página. Solo se inyecta cuando se va a convertir a
 * MP3 o a extraer el audio, y no lleva nada de unir vídeo.
 */
import { toMp3, extractAudio } from './audio.js';
import { installRuntime } from './page-runtime.js';

installRuntime('audio', {
	mp3: (payload) => toMp3(payload),
	extract: (payload) => extractAudio(payload),
});
