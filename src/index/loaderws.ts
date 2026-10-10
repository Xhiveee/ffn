/**
 * Throwaway loader workspaces: the official MDK for (loader, mcVersion), unpacked into the cache, so the
 * Forge/NeoForge-patched Minecraft jar can be indexed without a user project (`source: "loader"`).
 * The MDK's own Gradle setup produces the patched jar; FFN only asks it for the compile classpath.
 */
import AdmZip from "adm-zip";
import { chmodSync, existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Services } from "../services.js";
import { downloadFile } from "../util/download.js";

export interface LoaderWorkspace {
  dir: string;
  loader: "forge" | "neoforge";
  mcVersion: string;
  /** Where the MDK came from (URL). */
  origin: string;
}

/** Candidate official MDK archives, best first. */
export function mdkUrls(loader: "forge" | "neoforge", mc: string, forgeVersion?: string): string[] {
  if (loader === "forge") {
    const urls = forgeVersion ? [`https://maven.minecraftforge.net/net/minecraftforge/forge/${mc}-${forgeVersion}/forge-${mc}-${forgeVersion}-mdk.zip`] : [];
    if (mc === "1.20.1") urls.push("https://github.com/NeoForgeMDKs/MDK-Forge-1.20.1-ModDevGradle/archive/refs/heads/main.zip");
    return urls;
  }
  return ["ModDevGradle", "NeoGradle"].map((p) => `https://github.com/NeoForgeMDKs/MDK-${mc}-${p}/archive/refs/heads/main.zip`);
}

/** Extract a zip, dropping a single top-level directory (GitHub archives) if present. */
export function extractMdk(zipFile: string, dest: string): void {
  const zip = new AdmZip(zipFile);
  const entries = zip.getEntries().filter((e) => !e.isDirectory);
  const tops = new Set(entries.map((e) => e.entryName.split("/")[0]));
  const strip = tops.size === 1 && entries.every((e) => e.entryName.includes("/")) ? `${[...tops][0]}/` : "";
  for (const e of entries) {
    const rel = e.entryName.slice(strip.length);
    if (!rel || rel.split("/").includes("..")) continue;
    zip.extractEntryTo(e, path.join(dest, path.dirname(rel)), false, true);
  }
  for (const w of ["gradlew"]) if (existsSync(path.join(dest, w))) chmodSync(path.join(dest, w), 0o755);
}

export async function loaderWorkspace(services: Services, loader: "forge" | "neoforge", mc: string, onProgress?: (m: string) => void): Promise<LoaderWorkspace> {
  const root = path.join(services.config.cacheDir, "loader-ws");
  const dir = path.join(root, `${loader}-${mc}`);
  const marker = path.join(dir, ".ffn-workspace.json");
  if (existsSync(marker)) return { ...(JSON.parse(await readFile(marker, "utf8")) as LoaderWorkspace), dir };
  let forgeVersion: string | undefined;
  if (loader === "forge") {
    const v = await services.versions.forge(mc);
    forgeVersion = v.recommended ?? v.latest;
    if (!forgeVersion) throw new Error(`No Forge build for Minecraft ${mc}.`);
  } else {
    const v = await services.versions.neoforge(mc);
    if (!v.all.length) throw new Error(`No NeoForge build for Minecraft ${mc}.`);
  }
  const errors: string[] = [];
  for (const url of mdkUrls(loader, mc, forgeVersion)) {
    const name = url.includes("github.com") ? `${url.split("/")[4]}.zip` : path.basename(url);
    try {
      onProgress?.(`Downloading the official ${loader} MDK (${url})…`);
      const zipPath = await downloadFile(url, path.join(root, "zips", name), { userAgent: services.config.userAgent, offline: services.config.offline });
      await rm(dir, { recursive: true, force: true });
      await mkdir(dir, { recursive: true });
      extractMdk(zipPath, dir);
      const ws: LoaderWorkspace = { dir, loader, mcVersion: mc, origin: url };
      await writeFile(marker, JSON.stringify(ws, null, 1));
      return ws;
    } catch (e) {
      errors.push(`${url}: ${(e as Error).message}`);
    }
  }
  throw new Error(`No official ${loader} MDK found for ${mc} (${errors.join("; ")}). Use projectDir with your own project instead.`);
}
