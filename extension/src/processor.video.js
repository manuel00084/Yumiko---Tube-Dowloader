/**
 * Processor de VÍDEO para la página. Solo se inyecta cuando se va a unir vídeo
 * con audio, y no lleva nada de MP3 (el bundle pesa la mitad).
 */
import { muxVideo } from './video.js';
import { installRuntime } from './page-runtime.js';

installRuntime('video', { mux: (payload) => muxVideo(payload) });
