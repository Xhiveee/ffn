/**
 * Pack format of a Minecraft version, read from `version.json` inside Mojang's client jar
 * (`pack_version`), not from a hand-kept table. Uses a cached client jar when FFN already has one,
 * otherwise fetches only the zip directory + that one entry with HTTP range requests. Cached per version.
 */
import AdmZip from "adm-zip";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { inflateRawSync } from "node:zlib";
import type { Services } from "../services.js";

export interface PackFormat {
  /** Resource-pack format (what mod jars' pack.mcmeta use on Forge). "97.1" style from 26.x (major.minor). */
  resource: string;
  data: string;
}

/** Normalise `pack_version` (int, {resource,data} or {resource_major,…}) from version.json. */
export function parsePackVersion(versionJson: string): PackFormat | undefined {
  const pv = (JSON.parse(versionJson) as { pack_version?: unknown }).pack_version;
  if (typeof pv === "number") return { resource: String(pv), data: String(pv) };
  if (!pv || typeof pv !== "object") return undefined;
  const o = pv as Record<string, number | undefined>;
  const v = (k: string) => (o[k] !== undefined ? String(o[k]) : o[`${k}_major`] !== undefined ? `${o[`${k}_major`]}${o[`${k}_minor`] ? `.${o[`${k}_minor`]}` : ""}` : undefined);
  const resource = v("resource");
  const data = v("data");
  return resource && data ? { resource, data } : undefined;
}

async function range(url: string, ua: string, spec: string): Promise<Buffer> {
  const res = await fetch(url, { headers: { Range: `bytes=${spec}`, "User-Agent": ua } });
  if (res.status !== 206) throw new Error(`no range support (HTTP ${res.status})`);
  return Buffer.from(await res.arrayBuffer());
}

/** Read one entry of a remote zip using range requests (no ZIP64; Mojang jars are small enough). */
export async function remoteZipEntry(url: string, ua: string, name: string): Promise<Buffer | undefined> {
  const tail = await range(url, ua, "-65536");
  const eocd = tail.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0) throw new Error("zip end record not found");
  const cdSize = tail.readUInt32LE(eocd + 12);
  const cdOff = tail.readUInt32LE(eocd + 16);
  const cd = await range(url, ua, `${cdOff}-${cdOff + cdSize - 1}`);
  for (let p = 0; p + 46 <= cd.length && cd.readUInt32LE(p) === 0x02014b50; ) {
    const method = cd.readUInt16LE(p + 10);
    const csize = cd.readUInt32LE(p + 20);
    const nlen = cd.readUInt16LE(p + 28);
    const xlen = cd.readUInt16LE(p + 30);
    const clen = cd.readUInt16LE(p + 32);
    const local = cd.readUInt32LE(p + 42);
    if (cd.toString("utf8", p + 46, p + 46 + nlen) === name) {
      const buf = await range(url, ua, `${local}-${local + 30 + nlen + 1024 + csize}`);
      const start = 30 + buf.readUInt16LE(26) + buf.readUInt16LE(28);
      const data = buf.subarray(start, start + csize);
      return method === 0 ? data : inflateRawSync(data);
    }
    p += 46 + nlen + xlen + clen;
  }
  return undefined;
}

export async function packFormat(services: Services, mc: string): Promise<PackFormat | undefined> {
  const cache = path.join(services.config.cacheDir, "packformat", `${mc}.json`);
  if (existsSync(cache)) return JSON.parse(await readFile(cache, "utf8")) as PackFormat;
  let json: string | undefined;
  const localJar = path.join(services.config.cacheDir, "index", mc, "client.jar");
  if (existsSync(localJar)) json = new AdmZip(localJar).getEntry("version.json")?.getData().toString("utf8");
  if (!json) {
    if (services.config.offline) return undefined;
    const d = await services.versions.mojangVersion(mc);
    const url = d?.downloads.client?.url;
    if (!url) return undefined;
    json = (await remoteZipEntry(url, services.config.userAgent, "version.json"))?.toString("utf8");
  }
  const pf = json ? parsePackVersion(json) : undefined;
  if (pf) {
    await mkdir(path.dirname(cache), { recursive: true });
    await writeFile(cache, JSON.stringify(pf));
  }
  return pf;
}
