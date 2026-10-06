import fs from 'node:fs';
import { unzipSync } from 'fflate';

const b = fs.readFileSync('dist/yumiko-tube-downloader.crx');
const files = unzipSync(b.subarray(12 + b.readUInt32LE(8)));
const manifest = JSON.parse(Buffer.from(files['manifest.json']).toString('utf8'));
const inject = Buffer.from(files['src/inject.js']).toString('utf8');

console.log('CRX válido:', b.subarray(0, 4).toString('ascii') === 'Cr24');
console.log('manifest dentro:', manifest.name, 'v' + manifest.version);
console.log('archivos:', Object.keys(files).length);
console.log('inject.js usa cliente ANDROID:', inject.includes("name: 'ANDROID'"));
console.log('inject.js tiene cadena de clientes:', inject.includes('INNERTUBE_CLIENTS'));

// Módulos independientes: cada processor en su bundle, sin arrastrar el otro.
const video = files['lib/processor.video.js'] ? Buffer.from(files['lib/processor.video.js']).toString('utf8') : '';
const audio = files['lib/processor.audio.js'] ? Buffer.from(files['lib/processor.audio.js']).toString('utf8') : '';
console.log('processor de vídeo:', Boolean(video), '| lleva MP3:', video.includes('Mp3Encoder'));
console.log('processor de audio:', Boolean(audio), '| lleva unión de vídeo:', audio.includes('muxVideo'));
console.log(
	'tamaños:',
	['lib/processor.video.js', 'lib/processor.audio.js']
		.map((f) => `${f.split('/').pop().replace('processor.', '')}=${Math.round((files[f]?.length || 0) / 1024)}KB`)
		.join(' '),
);
const popup = Buffer.from(files['popup.js']).toString('utf8');
console.log('el popup no arrastra el motor de miniaturas:', !popup.includes('aiUpscale') && !popup.includes('probeCandidates'));
console.log(
	'estudio de miniaturas:',
	['thumbs/bridge.js', 'thumbs/app/studio.html', 'thumbs/app/studio.js', 'thumbs/pipeline.js'].every((f) => files[f]),
);
console.log('modelo de IA:', Boolean(files['models/super-resolution-10.onnx']));
console.log(
	'motor onnxruntime:',
	Object.keys(files).filter((f) => f.startsWith('vendor/ort/')).length,
	'ficheros',
);

// Las dos extensiones comparten navegador: el studio no puede usar los
// identificadores de la otra o una se pisa a la otra.
const NS = 'yumiko-thumbs';
const bridge = Buffer.from(files['thumbs/bridge.js']).toString('utf8');
const studioJs = Buffer.from(files['thumbs/app/studio.js']).toString('utf8');
const serviceWorker = Buffer.from(files['background.js']).toString('utf8');
console.log('namespace correcto en los tres:', bridge.includes(NS) && studioJs.includes(NS) && serviceWorker.includes(NS));
const conflicts = ['miniatura-youtube', 'miniaturaYoutube', 'myt-studio']
	.filter((token) => bridge.includes(token) || studioJs.includes(token));
console.log('sin restos de la otra extensión:', conflicts.length === 0 ? 'sí' : `NO (${conflicts.join(', ')})`);