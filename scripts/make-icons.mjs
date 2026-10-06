/**
 * Genera los iconos de la extensión a partir del arte maestro en PNG.
 *
 * El arte es una imagen real (assets/icon-source.png e icon-source-32.png), no
 * un dibujo procedural: se decodifica, se reduce por área y se vuelve a
 * codificar en los tamaños que pide manifest.json (16, 32, 48 y 128).
 *
 * Uso: node scripts/make-icons.mjs
 */
import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(new URL('.', import.meta.url)));
const outDir = path.join(root, 'extension/icons');
// El arte maestro vive fuera de extension/ para no acabar dentro del CRX.
const assetDir = path.join(root, 'assets');

const crcTable = (() => {
	const table = new Int32Array(256);
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		table[n] = c;
	}
	return table;
})();

const crc32 = (buf) => {
	let c = -1;
	for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
	return (c ^ -1) >>> 0;
};

const chunk = (type, data) => {
	const len = Buffer.alloc(4);
	len.writeUInt32BE(data.length);
	const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
	const crc = Buffer.alloc(4);
	crc.writeUInt32BE(crc32(body));
	return Buffer.concat([len, body, crc]);
};

const encodePng = (width, height, rgba) => {
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(width, 0);
	ihdr.writeUInt32BE(height, 4);
	ihdr[8] = 8;
	ihdr[9] = 6;
	const raw = Buffer.alloc((width * 4 + 1) * height);
	for (let y = 0; y < height; y++) {
		raw[y * (width * 4 + 1)] = 0;
		rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
	}
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk('IHDR', ihdr),
		chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
		chunk('IEND', Buffer.alloc(0)),
	]);
};

const CHANNELS = { 0: 1, 2: 3, 4: 2, 6: 4 };

/** Lee un PNG sin entrelazado de 8 bits por canal y lo devuelve como RGBA. */
const decodePng = (file) => {
	const png = fs.readFileSync(file);
	if (png.readUInt32BE(0) !== 0x89504e47) throw new Error(`${file}: no es un PNG`);
	const width = png.readUInt32BE(16);
	const height = png.readUInt32BE(20);
	if (png[24] !== 8) throw new Error(`${file}: solo se admite profundidad de 8 bits`);
	if (png[28] !== 0) throw new Error(`${file}: los PNG entrelazados no son compatibles`);

	const idat = [];
	let offset = 8;
	while (offset < png.length) {
		const length = png.readUInt32BE(offset);
		const type = png.toString('latin1', offset + 4, offset + 8);
		if (type === 'IDAT') idat.push(png.subarray(offset + 8, offset + 8 + length));
		offset += 12 + length;
	}

	const bpp = CHANNELS[png[25]];
	if (!bpp) throw new Error(`${file}: tipo de color ${png[25]} no compatible`);

	const scan = zlib.inflateSync(Buffer.concat(idat));
	const stride = width * bpp;
	const raw = Buffer.alloc(stride * height);
	for (let y = 0; y < height; y++) {
		const filter = scan[y * (stride + 1)];
		const line = scan.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
		const out = raw.subarray(y * stride, (y + 1) * stride);
		const prev = y > 0 ? raw.subarray((y - 1) * stride, y * stride) : null;
		for (let i = 0; i < stride; i++) {
			const left = i >= bpp ? out[i - bpp] : 0;
			const up = prev ? prev[i] : 0;
			const upLeft = prev && i >= bpp ? prev[i - bpp] : 0;
			let value = line[i];
			if (filter === 1) value += left;
			else if (filter === 2) value += up;
			else if (filter === 3) value += (left + up) >> 1;
			else if (filter === 4) {
				const p = left + up - upLeft;
				const pa = Math.abs(p - left);
				const pb = Math.abs(p - up);
				const pc = Math.abs(p - upLeft);
				value += pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
			}
			out[i] = value & 0xff;
		}
	}

	const rgba = Buffer.alloc(width * height * 4);
	for (let i = 0, o = 0; i < width * height; i++, o += 4) {
		const s = i * bpp;
		if (bpp === 4) {
			rgba[o] = raw[s];
			rgba[o + 1] = raw[s + 1];
			rgba[o + 2] = raw[s + 2];
			rgba[o + 3] = raw[s + 3];
		} else if (bpp === 3) {
			rgba[o] = raw[s];
			rgba[o + 1] = raw[s + 1];
			rgba[o + 2] = raw[s + 2];
			rgba[o + 3] = 255;
		} else if (bpp === 2) {
			rgba[o] = raw[s];
			rgba[o + 1] = raw[s];
			rgba[o + 2] = raw[s];
			rgba[o + 3] = raw[s + 1];
		} else {
			rgba[o] = raw[s];
			rgba[o + 1] = raw[s];
			rgba[o + 2] = raw[s];
			rgba[o + 3] = 255;
		}
	}
	return { width, height, rgba };
};

/**
 * Reducción por área: cada píxel destino promedia los de origen que cubre,
 * con alfa premultiplicado para que los bordes transparentes no sachen negro.
 */
const resize = ({ width, height, rgba }, dstW, dstH) => {
	const out = Buffer.alloc(dstW * dstH * 4);
	const xRatio = width / dstW;
	const yRatio = height / dstH;
	for (let y = 0; y < dstH; y++) {
		const y0 = y * yRatio;
		const y1 = y0 + yRatio;
		for (let x = 0; x < dstW; x++) {
			const x0 = x * xRatio;
			const x1 = x0 + xRatio;
			let r = 0;
			let g = 0;
			let b = 0;
			let a = 0;
			let weight = 0;
			const firstRow = Math.max(0, Math.floor(y0));
			const lastRow = Math.min(height - 1, Math.ceil(y1) - 1);
			for (let sy = firstRow; sy <= lastRow; sy++) {
				const wy = Math.min(sy + 1, y1) - Math.max(sy, y0);
				if (wy <= 0) continue;
				const firstCol = Math.max(0, Math.floor(x0));
				const lastCol = Math.min(width - 1, Math.ceil(x1) - 1);
				for (let sx = firstCol; sx <= lastCol; sx++) {
					const wx = Math.min(sx + 1, x1) - Math.max(sx, x0);
					if (wx <= 0) continue;
					const w = wx * wy;
					const i = (sy * width + sx) * 4;
					const alpha = rgba[i + 3] / 255;
					r += rgba[i] * alpha * w;
					g += rgba[i + 1] * alpha * w;
					b += rgba[i + 2] * alpha * w;
					a += rgba[i + 3] * w;
					weight += w;
				}
			}
			const o = (y * dstW + x) * 4;
			if (weight === 0 || a === 0) {
				out[o] = 0;
				out[o + 1] = 0;
				out[o + 2] = 0;
				out[o + 3] = 0;
				continue;
			}
			out[o] = Math.min(255, Math.round((r * 255) / a));
			out[o + 1] = Math.min(255, Math.round((g * 255) / a));
			out[o + 2] = Math.min(255, Math.round((b * 255) / a));
			out[o + 3] = Math.round(a / weight);
		}
	}
	return { width: dstW, height: dstH, rgba: out };
};

// El arte de 256x256 se ve bien al reducir, pero a 16-32 px un dibujo tan
// detallado se convierte en manchas. Por eso los tamaños pequeños salen de su
// propio arte, dibujado para leerse a ese tamaño.
const PLAN = [
	{ size: 16, master: 'icon-source-32.png' },
	{ size: 32, master: 'icon-source-32.png' },
	{ size: 48, master: 'icon-source.png' },
	{ size: 128, master: 'icon-source.png' },
];

const cache = new Map();
const load = (name) => {
	if (!cache.has(name)) {
		const file = path.join(assetDir, name);
		if (!fs.existsSync(file)) {
			console.error(`Falta el arte maestro ${path.relative(root, file)}`);
			process.exit(1);
		}
		cache.set(name, decodePng(file));
	}
	return cache.get(name);
};

for (const { size, master } of PLAN) {
	const file = path.join(outDir, `icon${size}.png`);
	const artwork = load(master);
	fs.writeFileSync(file, encodePng(size, size, resize(artwork, size, size).rgba));
	console.log('icono escrito:', path.relative(root, file));
}
