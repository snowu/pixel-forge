// Minimal PNG encoder/decoder for tests (8-bit grey/RGB/RGBA/indexed, all five filter types). Not part of the shipped tool.
import zlib from 'node:zlib';
const crcTable = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type, 'ascii'), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td)); return Buffer.concat([len, td, crc]); };

/** rgba: Uint8Array/Buffer of w*h*4 bytes. */
export function encodePng(w, h, rgba) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 4 + 1)] = 0; Buffer.from(rgba.buffer ? rgba.buffer : rgba, rgba.byteOffset || 0, w * h * 4).copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4); }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

export function decodePng(buf) {
  let off = 8, ihdr, plte = null, trns = null; const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off), type = buf.toString('ascii', off + 4, off + 8), data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') ihdr = { w: data.readUInt32BE(0), h: data.readUInt32BE(4), depth: data[8], ct: data[9], interlace: data[12] };
    else if (type === 'PLTE') plte = data; else if (type === 'tRNS') trns = data; else if (type === 'IDAT') idat.push(data);
    off += 12 + len;
  }
  if (!ihdr || ihdr.depth !== 8 || ihdr.interlace) throw new Error('unsupported PNG');
  const ch = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[ihdr.ct], bpp = ch, stride = ihdr.w * ch;
  const raw = zlib.inflateSync(Buffer.concat(idat)), out = Buffer.alloc(stride * ihdr.h);
  for (let y = 0; y < ihdr.h; y++) {
    const f = raw[y * (stride + 1)], line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)), cur = out.subarray(y * stride, (y + 1) * stride), prev = y ? out.subarray((y - 1) * stride, y * stride) : Buffer.alloc(stride);
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0, b = prev[i], c = i >= bpp ? prev[i - bpp] : 0; let v = line[i];
      if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a + b) >> 1; else if (f === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      cur[i] = v & 255;
    }
  }
  const rgba = Buffer.alloc(ihdr.w * ihdr.h * 4);
  for (let i = 0; i < ihdr.w * ihdr.h; i++) {
    let r, g, b, a = 255;
    if (ihdr.ct === 6) [r, g, b, a] = [out[i * 4], out[i * 4 + 1], out[i * 4 + 2], out[i * 4 + 3]];
    else if (ihdr.ct === 2) [r, g, b] = [out[i * 3], out[i * 3 + 1], out[i * 3 + 2]];
    else if (ihdr.ct === 0) r = g = b = out[i]; else if (ihdr.ct === 4) { r = g = b = out[i * 2]; a = out[i * 2 + 1]; }
    else { const k = out[i]; [r, g, b] = [plte[k * 3], plte[k * 3 + 1], plte[k * 3 + 2]]; a = trns && k < trns.length ? trns[k] : 255; }
    rgba.set([r, g, b, a], i * 4);
  }
  return { w: ihdr.w, h: ihdr.h, rgba };
}

/** A small test image from rows of palette letters: '.' is transparent. */
export function fromRows(rows, colors) {
  const h = rows.length, w = rows[0].length, rgba = Buffer.alloc(w * h * 4);
  rows.forEach((row, y) => [...row].forEach((ch, x) => { const c = ch === '.' ? [0, 0, 0, 0] : colors[ch]; rgba.set(c.length === 3 ? [...c, 255] : c, (y * w + x) * 4); }));
  return { w, h, rgba, png: encodePng(w, h, rgba) };
}
