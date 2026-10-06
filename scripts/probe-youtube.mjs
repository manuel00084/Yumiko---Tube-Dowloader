/**
 * Diagnóstico: ¿qué formatos expone hoy YouTube sin PO token?
 * Simula exactamente lo que hace extension/src/inject.js.
 *
 * Uso: node scripts/probe-youtube.mjs [videoId]
 */
import { probe } from './youtube-clients.mjs';

const videoId = process.argv[2] || 'dQw4w9WgXcQ';
const result = await probe(videoId);

console.log(`\nVídeo: ${videoId}`);
console.log(`Título: ${result.title || '(desconocido)'}`);
console.log(`ytInitialPlayerResponse en la página: ${result.pageFormats.length} formatos utilizables`);
if (result.pageFormats.length) {
	console.log(result.pageFormats.map((f) => `   itag ${f.itag} ${f.qualityLabel || f.mimeType}`).join('\n'));
}

console.log('\nAPI interna por cliente:');
for (const client of result.clients) {
	const label = `${client.name.padEnd(30)} ${String(client.formats).padStart(3)} formatos`;
	console.log(`   ${label}  ${client.error ? '-> ' + client.error : (client.sample || '')}`);
}