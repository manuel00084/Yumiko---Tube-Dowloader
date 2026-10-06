// ZIP sin compresión (store). Las imágenes ya vienen comprimidas, así que
// deflate solo añadiría CPU sin ganar nada.

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(date) {
  const time =
    ((date.getHours() & 0x1f) << 11) | ((date.getMinutes() & 0x3f) << 5) | ((date.getSeconds() / 2) & 0x1f);
  const day = (((date.getFullYear() - 1980) & 0x7f) << 9) | (((date.getMonth() + 1) & 0x0f) << 5) | (date.getDate() & 0x1f);
  return { time, day };
}

class ByteWriter {
  constructor(size) {
    this.buffer = new Uint8Array(size);
    this.view = new DataView(this.buffer.buffer);
    this.offset = 0;
  }

  u16(value) {
    this.view.setUint16(this.offset, value, true);
    this.offset += 2;
  }

  u32(value) {
    this.view.setUint32(this.offset, value >>> 0, true);
    this.offset += 4;
  }

  bytes(data) {
    this.buffer.set(data, this.offset);
    this.offset += data.length;
  }
}

export async function createZip(entries, { date = new Date() } = {}) {
  const encoder = new TextEncoder();
  const prepared = [];
  for (const entry of entries) {
    const data = new Uint8Array(await entry.blob.arrayBuffer());
    prepared.push({
      name: encoder.encode(entry.name),
      data,
      crc: crc32(data),
    });
  }

  const localSize = prepared.reduce((sum, item) => sum + 30 + item.name.length + item.data.length, 0);
  const centralSize = prepared.reduce((sum, item) => sum + 46 + item.name.length, 0);
  const writer = new ByteWriter(localSize + centralSize + 22);
  const stamp = dosDateTime(date);

  for (const item of prepared) {
    item.offset = writer.offset;
    writer.u32(0x04034b50);
    writer.u16(20);
    writer.u16(0x0800);
    writer.u16(0);
    writer.u16(stamp.time);
    writer.u16(stamp.day);
    writer.u32(item.crc);
    writer.u32(item.data.length);
    writer.u32(item.data.length);
    writer.u16(item.name.length);
    writer.u16(0);
    writer.bytes(item.name);
    writer.bytes(item.data);
  }

  const centralStart = writer.offset;
  for (const item of prepared) {
    writer.u32(0x02014b50);
    writer.u16(20);
    writer.u16(20);
    writer.u16(0x0800);
    writer.u16(0);
    writer.u16(stamp.time);
    writer.u16(stamp.day);
    writer.u32(item.crc);
    writer.u32(item.data.length);
    writer.u32(item.data.length);
    writer.u16(item.name.length);
    writer.u16(0);
    writer.u16(0);
    writer.u16(0);
    writer.u16(0);
    writer.u32(0);
    writer.u32(item.offset);
    writer.bytes(item.name);
  }

  writer.u32(0x06054b50);
  writer.u16(0);
  writer.u16(0);
  writer.u16(prepared.length);
  writer.u16(prepared.length);
  writer.u32(writer.offset - centralStart);
  writer.u32(centralStart);
  writer.u16(0);

  return new Blob([writer.buffer], { type: 'application/zip' });
}

export function sanitizeFilename(name, fallback = 'miniatura') {
  const cleaned = String(name || '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '');
  const safe = cleaned || fallback;
  return safe.length > 120 ? safe.slice(0, 120) : safe;
}