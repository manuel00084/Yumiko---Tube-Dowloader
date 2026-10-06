/**
 * Empaqueta la extensión en un .crx firmado, usando el propio navegador.
 * Se genera (o reutiliza) una clave en dist/ para que el ID de la extensión
 * no cambie entre publicada y futuras actualizaciones.
 *
 * Uso: node scripts/pack-crx.mjs   (o: npm run crx)
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(new URL('.', import.meta.url)));
const source = path.join(root, 'extension');
const dist = path.join(root, 'dist');
fs.mkdirSync(dist, { recursive: true });

const bundles = ['lib/processor.video.js', 'lib/processor.audio.js'];
const missing = bundles.filter((file) => !fs.existsSync(path.join(source, file)));
if (missing.length) {
	console.error(`Falta ${missing.join(', ')}. Ejecuta antes: npm run build`);
	process.exit(1);
}

const candidates = [
	process.env.BROWSER_PATH,
	path.join(process.env.LOCALAPPDATA || '', 'Vivaldi', 'Application', 'vivaldi.exe'),
	'C:/Program Files/Google/Chrome/Application/chrome.exe',
	'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
	'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
	'/usr/bin/google-chrome',
	'/usr/bin/chromium',
	'/usr/bin/chromium-browser',
	'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean);

const browser = candidates.find((candidate) => fs.existsSync(candidate));
if (!browser) {
	console.error('No encuentro Chrome, Edge ni Vivaldi. Define BROWSER_PATH con la ruta al navegador.');
	process.exit(1);
}

const existingCrx = path.join(dist, 'yumiko-tube-downloader.crx');
const key = path.join(dist, 'yumiko-signing-key.pem');

const args = [`--pack-extension="${source}"`, '--no-first-run', '--disable-gpu'];
// Reutilizar la clave mantiene el mismo ID de extensión entre versiones.
if (fs.existsSync(key) && fs.existsSync(existingCrx)) {
	args.push(`--pack-extension-key="${key}"`);
	fs.rmSync(existingCrx, { force: true });
}

// La ruta del proyecto puede contener espacios, así que se pasa la línea de
// órdenes completa y la interpreta el shell (Node no entrecomilla los args).
const quote = (value) => `"${value}"`;
const line = [quote(browser)]
	.concat(args.map((arg) => (arg.includes('=') && /"[^"]*"$/.test(arg) ? arg : arg)))
	.join(' ');

console.log(`Empaquetando con ${browser}`);
const result = spawnSync(line, { stdio: 'inherit', shell: true });

const producedCrx = `${source}.crx`;
if (!fs.existsSync(producedCrx)) {
	console.error(result.status === 0 ? 'El navegador no generó el .crx' : `El navegador terminó con código ${result.status}`);
	process.exit(1);
}

fs.renameSync(producedCrx, existingCrx);
if (fs.existsSync(`${source}.pem`) && !fs.existsSync(key)) fs.renameSync(`${source}.pem`, key);
fs.rmSync(`${source}.pem`, { force: true });

console.log(`\n-> ${path.relative(root, existingCrx)}`);
console.log('Instálalo arrastrándolo a la ventana de Vivaldi, o con "Instalar" desde vivaldi://extensions.');