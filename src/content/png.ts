/** Placeholder textures: a 16x16 RGBA PNG with a border and a simple pattern, colour from a hex string. */
import { deflateSync } from "node:zlib";

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

export function placeholderPng(hex = "#8a6d3b", size = 16): Buffer {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  const rgb = m ? [0, 2, 4].map((i) => parseInt(m[1]!.slice(i, i + 2), 16)) : [138, 109, 59];
  const shade = (f: number) => rgb.map((v) => Math.max(0, Math.min(255, Math.round(v * f))));
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const border = x === 0 || y === 0 || x === size - 1 || y === size - 1;
      const c = border ? shade(0.6) : (x + y) % 4 === 0 ? shade(1.15) : rgb;
      const o = y * (size * 4 + 1) + 1 + x * 4;
      raw[o] = c[0]!;
      raw[o + 1] = c[1]!;
      raw[o + 2] = c[2]!;
      raw[o + 3] = 255;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
