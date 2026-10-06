import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

const root = path.dirname(fileURLToPath(new URL('.', import.meta.url)));
const source = path.join(root, 'extension');
const outFile = path.join(root, 'dist', 'yumiko-tube-downloader.zip');

const manifest = JSON.parse(fs.readFileSync(path.join(source, 'manifest.json'), 'utf8'));
const bundles = ['lib/processor.video.js', 'lib/processor.audio.js'];
const missing = bundles.filter((file) => !fs.existsSync(path.join(source, file)));
if (missing.length) {
	console.error(`Falta ${missing.join(', ')}. Ejecuta antes: npm run build`);
	process.exit(1);
}

const { zipSync } = await import('fflate').catch(() => ({ zipSync: null }));
if (!zipSync) {
	console.error('Se necesita fflate para empaquetar: npm i -D fflate');
	process.exit(1);
}

const files = {};
const walk = (dir, prefix = '') => {
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
		if (entry.isDirectory()) walk(path.join(dir, entry.name), relative);
		else if (entry.name !== '.DS_Store') files[relative] = new Uint8Array(fs.readFileSync(path.join(dir, entry.name)));
	}
};
walk(source);

const zipped = zipSync(files, { level: 9 });
fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, zipped);

console.log(`Empaquetado ${Object.keys(files).length} archivos (${manifest.name} ${manifest.version})`);
console.log(`-> ${path.relative(root, outFile)}`);