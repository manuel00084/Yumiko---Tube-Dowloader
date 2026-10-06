import { build, context } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const root = path.dirname(fileURLToPath(new URL('.', import.meta.url)));
const watch = process.argv.includes('--watch');

/** @type {import('esbuild').BuildOptions} */
const options = {
	// Un bundle por módulo: el de vídeo no lleva el codificador de MP3 y el de
	// audio no lleva el de unir vídeo. Se inyectan solo cuando hacen falta.
	entryPoints: [
		path.join(root, 'extension/src/processor.video.js'),
		path.join(root, 'extension/src/processor.audio.js'),
	],
	outdir: path.join(root, 'extension/lib'),
	bundle: true,
	format: 'esm',
	platform: 'browser',
	target: ['chrome116'],
	charset: 'utf8',
	legalComments: 'none',
	logLevel: 'info',
	treeShaking: true,
	define: { 'process.env.NODE_ENV': '"production"' },
};

// Chromium no acepta manifest.json con BOM, los acentos se rompen con PowerShell
// y los módulos tienen que seguir siendo independientes: se comprueba DESPUÉS de
// compilar, cuando ya existen los bundles.
/* c8 ignore next */
const verify = () => {
	const check = spawnSync(process.execPath, [path.join(root, 'scripts/check-extension.mjs'), '--modulos'], {
		stdio: 'inherit',
	});
	const encoding = spawnSync(process.execPath, [path.join(root, 'scripts/check-encoding.mjs')], {
		stdio: 'inherit',
	});
	if (check.status !== 0 || encoding.status !== 0) {
		process.exit(check.status || encoding.status || 1);
	}
};

if (watch) {
	const ctx = await context(options);
	await ctx.watch();
	verify();
	console.log('esbuild: vigilando cambios...');
} else {
	await build(options);
	verify();
}
