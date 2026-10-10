import { compareLooseVersions, isUnstableArtifactVersion } from "../util/mcversion.js";
import { parseMavenMetadata } from "../util/maven.js";

/**
 * Derive the Minecraft version from a NeoForge version — programmatically, no tables:
 *  - Year scheme (2026+): Y.D.H.B[-beta][+snapshot-N] → "Y.D" (H = 0) or "Y.D.H"
 *      26.1.0.40 → 26.1, 26.1.1.20-beta → 26.1.1, 26.1.0.0-alpha.3+snapshot-1 → 26.1-snapshot-1
 *  - Classic scheme: A.B.C[-beta] → "1.A" (B = 0) or "1.A.B"
 *      20.4.251 → 1.20.4, 21.0.3-beta → 1.21, 21.1.256 → 1.21.1
 * Returns null for things like April-fools builds ("0.25w14craftmine.3-beta").
 */
export function neoforgeToMinecraft(version: string): string | null {
  const year = /^(\d+)\.(\d+)\.(\d+)\.(\d+)(?:[-.][\w.]*)?(?:\+([\w.-]+))?$/.exec(version);
  if (year) {
    const [, y, d, h, , tag] = year;
    let mc = h === "0" ? `${y}.${d}` : `${y}.${d}.${h}`;
    const pre = tag ? /^(snapshot|pre|rc)-(\d+)/.exec(tag) : null;
    if (pre) mc += `-${pre[1]}-${pre[2]}`;
    return mc;
  }
  const classic = /^(\d+)\.(\d+)\.(\d+)(?:-[\w.-]+)?$/.exec(version);
  if (classic) {
    const [, a, b] = classic;
    if (Number(a) < 20) return null;
    return b === "0" ? `1.${a}` : `1.${a}.${b}`;
  }
  return null;
}

export interface NeoForgeVersions {
  mcVersion: string;
  /** Maven coordinate group:artifact to depend on. */
  artifact: "net.neoforged:neoforge" | "net.neoforged:forge";
  /** Newest non-beta build, if any. */
  latestStable?: string;
  /** Newest build of any kind. */
  latest?: string;
  /** All builds for this MC version, newest first. */
  all: string[];
}

export function neoforgeVersionsFor(xml: string, mc: string): NeoForgeVersions {
  const md = parseMavenMetadata(xml);
  const all = md.versions
    .filter((v) => neoforgeToMinecraft(v) === mc)
    .sort((a, b) => compareLooseVersions(b, a));
  return {
    mcVersion: mc,
    artifact: "net.neoforged:neoforge",
    latestStable: all.find((v) => !isUnstableArtifactVersion(v)),
    latest: all[0],
    all,
  };
}

/**
 * Legacy NeoForge (MC 1.20.1) lives at net.neoforged:forge with versions "1.20.1-47.1.x".
 * Quirk: one build was published without the MC prefix ("47.1.82"); those are treated as 1.20.1.
 */
export function neoforgeLegacyVersionsFor(xml: string, mc: string): NeoForgeVersions {
  const md = parseMavenMetadata(xml);
  const all = md.versions
    .map((v) => (v.includes("-") ? v : `1.20.1-${v}`))
    .filter((v) => v.startsWith(`${mc}-`))
    .sort((a, b) => compareLooseVersions(b.slice(mc.length + 1), a.slice(mc.length + 1)));
  const uniq = [...new Set(all)];
  return {
    mcVersion: mc,
    artifact: "net.neoforged:forge",
    latestStable: uniq.find((v) => !isUnstableArtifactVersion(v.slice(mc.length + 1))),
    latest: uniq[0],
    all: uniq,
  };
}

export function neoforgeMinecraftVersions(xml: string): string[] {
  const md = parseMavenMetadata(xml);
  return [...new Set(md.versions.map(neoforgeToMinecraft).filter((v): v is string => !!v))];
}
