import { parseMavenMetadata } from "../util/maven.js";
import { HttpError, type Fetcher, type FetchResult } from "../util/http.js";
import { compareMcVersions, isReleaseVersion, parseMcVersion } from "../util/mcversion.js";
import { ENDPOINTS } from "./endpoints.js";
import { fabricApiVersionsFor, parseFabricGameVersions, parseLatestFabricLoader, parseLatestYarn } from "./fabric.js";
import { forgeMinecraftVersions, forgeVersionsFor, parseForgePromotions, type ForgeVersions } from "./forge.js";
import {
  type MojangManifest,
  type MojangVersionDetails,
  parseMojangManifest,
  parseMojangVersionDetails,
} from "./mojang.js";
import {
  neoforgeLegacyVersionsFor,
  neoforgeMinecraftVersions,
  neoforgeVersionsFor,
  type NeoForgeVersions,
} from "./neoforge.js";
import { latestFromMetadata } from "./plugins.js";

/** Collects non-fatal problems (stale cache, missing artifacts) for the tool response. */
export class Notes {
  readonly warnings: string[] = [];
  readonly sources = new Set<string>();
  warn(msg: string): void {
    if (!this.warnings.includes(msg)) this.warnings.push(msg);
  }
}

export interface FabricVersions {
  mcVersion: string;
  gameSupported: boolean;
  loader?: string;
  fabricApi?: string;
  yarn?: string;
}

const IMMUTABLE = Number.POSITIVE_INFINITY;

/**
 * Live version data from official sources. Every method fetches through the caching
 * Fetcher; nothing about specific versions is hardcoded.
 */
export class VersionService {
  constructor(private readonly fetcher: Fetcher) {}

  private async get(url: string, notes?: Notes, ttlMs?: number): Promise<string> {
    const r: FetchResult = await this.fetcher.getText(url, ttlMs !== undefined ? { ttlMs } : {});
    notes?.sources.add(url);
    if (r.warning) notes?.warn(r.warning);
    return r.body;
  }

  /** Like get(), but 404 → undefined. */
  private async getOptional(url: string, notes?: Notes, ttlMs?: number): Promise<string | undefined> {
    try {
      return await this.get(url, notes, ttlMs);
    } catch (e) {
      if (e instanceof HttpError && e.status === 404) return undefined;
      throw e;
    }
  }

  async mojangManifest(notes?: Notes): Promise<MojangManifest> {
    return parseMojangManifest(await this.get(ENDPOINTS.mojangManifest, notes));
  }

  /** Per-version JSON (URL contains its sha1, so it's cached forever). */
  async mojangVersion(mc: string, notes?: Notes): Promise<MojangVersionDetails | undefined> {
    const manifest = await this.mojangManifest(notes);
    const entry = manifest.versions.find((v) => v.id === mc);
    if (!entry) return undefined;
    return parseMojangVersionDetails(await this.get(entry.url, notes, IMMUTABLE));
  }

  async latestRelease(notes?: Notes): Promise<string> {
    return (await this.mojangManifest(notes)).latest.release;
  }

  /**
   * Map any Mojang version id to the release whose profile should apply.
   * "26.4-snapshot-3" → "26.4"; weekly snapshots ("25w14a") → newest release before it.
   */
  async profileVersionFor(mc: string, notes?: Notes): Promise<{ release: string; note?: string }> {
    if (isReleaseVersion(mc)) return { release: mc };
    const parsed = parseMcVersion(mc);
    if (parsed) {
      const rel = parsed.release.join(".");
      return { release: rel, note: `${mc} is a pre-release of ${rel}; using the ${rel} profile.` };
    }
    const manifest = await this.mojangManifest(notes);
    const entry = manifest.versions.find((v) => v.id === mc);
    if (!entry) throw new Error(`Unknown Minecraft version "${mc}" (not in Mojang's version manifest).`);
    const release = manifest.versions
      .filter((v) => v.type === "release" && v.releaseTime <= entry.releaseTime)
      .sort((a, b) => b.releaseTime.localeCompare(a.releaseTime))[0];
    if (!release) throw new Error(`Cannot place snapshot ${mc} relative to any release.`);
    return {
      release: release.id,
      note: `${mc} is a snapshot; using the profile of the latest release before it (${release.id}).`,
    };
  }

  async fabric(mc: string, notes?: Notes): Promise<FabricVersions> {
    const [games, loaderJson, apiXml, yarnJson] = await Promise.all([
      this.get(ENDPOINTS.fabricGame, notes),
      this.get(ENDPOINTS.fabricLoader, notes),
      this.get(ENDPOINTS.fabricApiMetadata, notes),
      this.getOptional(ENDPOINTS.fabricYarn(mc), notes),
    ]);
    return {
      mcVersion: mc,
      gameSupported: parseFabricGameVersions(games).some((g) => g.version === mc),
      loader: parseLatestFabricLoader(loaderJson),
      fabricApi: fabricApiVersionsFor(apiXml, mc)[0],
      yarn: yarnJson ? parseLatestYarn(yarnJson) : undefined,
    };
  }

  async forge(mc: string, notes?: Notes): Promise<ForgeVersions> {
    const [xml, promos] = await Promise.all([
      this.get(ENDPOINTS.forgeMetadata, notes),
      this.get(ENDPOINTS.forgePromotions, notes),
    ]);
    return forgeVersionsFor(xml, parseForgePromotions(promos), mc);
  }

  async neoforge(mc: string, notes?: Notes): Promise<NeoForgeVersions> {
    const modern = neoforgeVersionsFor(await this.get(ENDPOINTS.neoforgeMetadata, notes), mc);
    if (modern.all.length > 0) return modern;
    // Only 1.20.1 has builds under the legacy coordinate, but checking costs one cached request.
    if (parseMcVersion(mc) && compareMcVersions(mc, "1.20.2") < 0) {
      const legacy = neoforgeLegacyVersionsFor(await this.get(ENDPOINTS.neoforgeLegacyMetadata, notes), mc);
      if (legacy.all.length > 0) return legacy;
    }
    return modern;
  }

  /** Which MC versions each loader has builds for (one cached index request per loader). */
  async loaderAvailability(notes?: Notes): Promise<Record<"fabric" | "forge" | "neoforge", Set<string>>> {
    const [fab, forge, neo, legacy] = await Promise.all([
      this.get(ENDPOINTS.fabricGame, notes),
      this.get(ENDPOINTS.forgeMetadata, notes),
      this.get(ENDPOINTS.neoforgeMetadata, notes),
      this.get(ENDPOINTS.neoforgeLegacyMetadata, notes),
    ]);
    const neoSet = new Set(neoforgeMinecraftVersions(neo));
    for (const v of neoforgeLegacyVersionsFor(legacy, "1.20.1").all.length ? ["1.20.1"] : []) neoSet.add(v);
    return {
      fabric: new Set(parseFabricGameVersions(fab).map((g) => g.version)),
      forge: new Set(forgeMinecraftVersions(forge)),
      neoforge: neoSet,
    };
  }

  async parchment(mc: string, notes?: Notes): Promise<string | undefined> {
    const xml = await this.getOptional(ENDPOINTS.parchmentMetadata(mc), notes);
    return xml ? latestFromMetadata(xml, { allowUnstable: false }) : undefined;
  }

  /** Raw text of any endpoint through the cache (404 → undefined). */
  async text(url: string, notes?: Notes, ttlMs?: number): Promise<string | undefined> {
    return this.getOptional(url, notes, ttlMs);
  }

  /** Newest MCPConfig build for an MC version (SRG names; relevant while Forge used SRG at runtime). */
  async mcpConfig(mc: string, notes?: Notes): Promise<string | undefined> {
    const xml = await this.getOptional(ENDPOINTS.mcpConfigMetadata, notes);
    if (!xml) return undefined;
    const md = parseMavenMetadata(xml);
    const cands = md.versions.filter((v) => v === mc || (v.startsWith(`${mc}-`) && /^\d{8}\.\d{6}$/.test(v.slice(mc.length + 1))));
    return cands.sort().at(-1);
  }

  async latestPluginVersion(
    metadataUrl: string,
    opts: { prefix?: string; allowUnstable?: boolean },
    notes?: Notes,
  ): Promise<string | undefined> {
    return latestFromMetadata(await this.get(metadataUrl, notes), opts);
  }
}
