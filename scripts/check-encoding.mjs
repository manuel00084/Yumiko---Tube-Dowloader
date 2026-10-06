/**
 * Detecta archivos de texto rotos: BOM (que Chromium rechaza en manifest.json)
 * o caracteres de reemplazo U+FFFD, que aparecen al editar con PowerShell
 * (Set-Content -Encoding UTF8 añade BOM y rompe los acentos).
 *
 * Uso: node scripts/check-encoding.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(new URL('.', import.meta.url)));
const dirs = ['extension', 'scripts'];
const problems = [];
const BOM = Buffer.from([0xef, 0xbb, 0xbf]);

const walk = (dir) => {
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		if (['node_modules', '.git', '.test-build', 'dist', 'lib'].includes(entry.name)) continue;
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			walk(full);
			continue;
		}
		if (!/\.(js|mjs|json|html|css|md)$/.test(entry.name)) continue;

		const bytes = fs.readFileSync(full);
		const relative = path.relative(root, full);

		if (bytes.subarray(0, 3).equals(BOM)) {
			problems.push(`${relative}: tiene BOM UTF-8`);
		}

		const text = bytes.toString('utf8');
		if (text.includes('\uFFFD')) {
			const line = text.slice(0, text.indexOf('\uFFFD')).split('\n').length;
			problems.push(`${relative}:${line}: texto roto (U+FFFD), revisa los acentos`);
		}
	}
};

for (const dir of dirs) walk(path.join(root, dir));
if (fs.existsSync(path.join(root, 'README.md'))) walk(root);

if (problems.length) {
	console.error('Encoding roto:\n');
	for (const problem of problems) console.error(`  - ${problem}`);
	process.exit(1);
}

console.log('Encoding correcto (sin BOM ni caracteres rotos).');