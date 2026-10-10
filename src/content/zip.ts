/** Minimal read-only zip access: reads only the central directory, then single entries on demand. */
import { closeSync, openSync, readSync, statSync } from "node:fs";
import { inflateRawSync } from "node:zlib";

interface Entry {
  offset: number;
  compressedSize: number;
  method: number;
}

export class ZipDir {
  readonly entries = new Map<string, Entry>();

  constructor(readonly file: string) {
    const size = statSync(file).size;
    const fd = openSync(file, "r");
    try {
      const tailLen = Math.min(size, 65_557);
      const tail = Buffer.alloc(tailLen);
      readSync(fd, tail, 0, tailLen, size - tailLen);
      let eocd = -1;
      for (let i = tailLen - 22; i >= 0; i--) {
        if (tail.readUInt32LE(i) === 0x06054b50) {
          eocd = i;
          break;
        }
      }
      if (eocd < 0) throw new Error(`Not a zip file: ${file}`);
      let cdSize = tail.readUInt32LE(eocd + 12);
      let cdOffset = tail.readUInt32LE(eocd + 16);
      if (cdOffset === 0xffffffff || cdSize === 0xffffffff) {
        // zip64: locator sits right before the EOCD record
        const loc = eocd - 20;
        if (loc >= 0 && tail.readUInt32LE(loc) === 0x07064b50) {
          const rec = Number(tail.readBigUInt64LE(loc + 8));
          const r = Buffer.alloc(56);
          readSync(fd, r, 0, 56, rec);
          cdSize = Number(r.readBigUInt64LE(40));
          cdOffset = Number(r.readBigUInt64LE(48));
        }
      }
      const cd = Buffer.alloc(cdSize);
      readSync(fd, cd, 0, cdSize, cdOffset);
      let p = 0;
      while (p + 46 <= cd.length && cd.readUInt32LE(p) === 0x02014b50) {
        const method = cd.readUInt16LE(p + 10);
        let compressedSize = cd.readUInt32LE(p + 20);
        const nameLen = cd.readUInt16LE(p + 28);
        const extraLen = cd.readUInt16LE(p + 30);
        const commentLen = cd.readUInt16LE(p + 32);
        let offset = cd.readUInt32LE(p + 42);
        const name = cd.toString("utf8", p + 46, p + 46 + nameLen);
        if (offset === 0xffffffff || compressedSize === 0xffffffff) {
          let e = p + 46 + nameLen;
          const end = e + extraLen;
          while (e + 4 <= end) {
            const id = cd.readUInt16LE(e);
            const len = cd.readUInt16LE(e + 2);
            if (id === 1) {
              let q = e + 4;
              if (cd.readUInt32LE(p + 24) === 0xffffffff) q += 8; // uncompressed
              if (compressedSize === 0xffffffff) {
                compressedSize = Number(cd.readBigUInt64LE(q));
                q += 8;
              }
              if (offset === 0xffffffff) offset = Number(cd.readBigUInt64LE(q));
            }
            e += 4 + len;
          }
        }
        this.entries.set(name, { offset, compressedSize, method });
        p += 46 + nameLen + extraLen + commentLen;
      }
    } finally {
      closeSync(fd);
    }
  }

  read(name: string): Buffer | undefined {
    const e = this.entries.get(name);
    if (!e) return undefined;
    const fd = openSync(this.file, "r");
    try {
      const h = Buffer.alloc(30);
      readSync(fd, h, 0, 30, e.offset);
      const start = e.offset + 30 + h.readUInt16LE(26) + h.readUInt16LE(28);
      const data = Buffer.alloc(e.compressedSize);
      readSync(fd, data, 0, e.compressedSize, start);
      return e.method === 8 ? inflateRawSync(data) : data;
    } finally {
      closeSync(fd);
    }
  }
}
