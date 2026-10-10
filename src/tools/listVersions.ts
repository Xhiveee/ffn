import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { lookupProfile, type Services } from "../services.js";
import { Notes } from "../sources/index.js";
import { LOADERS, type Loader } from "../profiles/schema.js";
import { compareMcVersions } from "../util/mcversion.js";
import { guard, ok } from "./result.js";

export const listVersionsInput = {
  mcVersion: z
    .string()
    .optional()
    .describe("If set, return details for this Minecraft version: loader versions, Java, Gradle plugin per loader."),
  includeSnapshots: z.boolean().optional().describe("Include snapshots / pre-releases in the list (default false)."),
  includeUnsupported: z.boolean().optional().describe("Include versions older than FFN's minimum (1.20.1). Default false."),
  limit: z.number().int().min(1).max(500).optional().describe("Max versions to list (default 60)."),
};

async function loaderAvailability(services: Services, notes: Notes) {
  const sets = await services.versions.loaderAvailability(notes);
  return (mc: string): Loader[] => LOADERS.filter((l) => sets[l].has(mc));
}

export async function listVersions(services: Services, args: { mcVersion?: string; includeSnapshots?: boolean; includeUnsupported?: boolean; limit?: number }) {
  const notes = new Notes();
  const v = services.versions;
  const manifest = await v.mojangManifest(notes);

  if (!args.mcVersion) {
    const profiles = await services.profiles();
    const minVersion = Object.values(profiles).map((p) => p!.minVersion).sort(compareMcVersions)[0] ?? "1.20.1";
    const minEntry = manifest.versions.find((x) => x.id === minVersion);
    const avail = await loaderAvailability(services, notes).catch((e) => {
      notes.warn(`Loader availability unavailable: ${(e as Error).message}`);
      return null;
    });
    const list = manifest.versions
      .filter((x) => (args.includeSnapshots ? x.type === "release" || x.type === "snapshot" : x.type === "release"))
      .filter((x) => args.includeUnsupported || !minEntry || x.releaseTime >= minEntry.releaseTime)
      .slice(0, args.limit ?? 60)
      .map((x) => ({ id: x.id, type: x.type, releaseTime: x.releaseTime, ...(avail ? { loaders: avail(x.id) } : {}) }));
    const data = {
      latest: manifest.latest,
      minimumSupported: minVersion,
      count: list.length,
      versions: list,
      warnings: notes.warnings,
      sources: [...notes.sources],
    };
    return ok(
      `Latest release: ${manifest.latest.release}, latest snapshot: ${manifest.latest.snapshot}. ${list.length} versions listed (newest first). Call list_versions with mcVersion for loader details.`,
      data,
    );
  }

  const mc = args.mcVersion.trim();
  const entry = manifest.versions.find((x) => x.id === mc);
  if (!entry) throw new Error(`Unknown Minecraft version "${mc}" (not in Mojang's manifest). Latest release is ${manifest.latest.release}.`);
  const details = await v.mojangVersion(mc, notes);

  const settle = async <T>(p: Promise<T>): Promise<T | { error: string }> => {
    try {
      return await p;
    } catch (e) {
      return { error: (e as Error).message };
    }
  };

  const [fabric, forge, neoforge, parchment] = await Promise.all([
    settle(v.fabric(mc, notes)),
    settle(v.forge(mc, notes)),
    settle(v.neoforge(mc, notes)),
    settle(v.parchment(mc, notes)),
  ]);

  const loaders: Record<string, unknown> = {};
  for (const loader of LOADERS) {
    let toolchain: unknown;
    try {
      const { profile } = await lookupProfile(services, loader, mc, new Notes());
      let pluginVersion = profile.plugin.version;
      if (pluginVersion === "latest" && profile.plugin.metadataUrl) {
        pluginVersion =
          (await v.latestPluginVersion(profile.plugin.metadataUrl, { prefix: profile.plugin.versionPrefix, allowUnstable: profile.plugin.allowUnstable }, notes)) ??
          "unknown";
      }
      toolchain = {
        java: profile.java,
        buildSystem: profile.buildSystem,
        gradlePlugin: `${profile.plugin.id} ${pluginVersion}`,
        gradle: profile.gradle.version,
        metadataFile: profile.metadata.file,
        mappings: profile.mappings.supported,
        verified: profile.verified,
        extrapolated: profile.extrapolated,
        warnings: profile.warnings,
      };
    } catch (e) {
      toolchain = { error: (e as Error).message };
    }
    const versionsInfo = loader === "fabric" ? fabric : loader === "forge" ? forge : neoforge;
    loaders[loader] = { versions: compact(loader, versionsInfo), toolchain };
  }

  const data = {
    mcVersion: mc,
    type: entry.type,
    releaseTime: entry.releaseTime,
    java: details?.javaMajor,
    obfuscated: details?.obfuscated,
    parchment: typeof parchment === "string" ? parchment : null,
    loaders,
    warnings: notes.warnings,
    sources: [...notes.sources],
  };
  const avail = LOADERS.filter((l) => {
    const x = loaders[l] as { versions: { available?: boolean } };
    return x.versions.available;
  });
  return ok(
    `Minecraft ${mc} (${entry.type}, Java ${details?.javaMajor ?? "?"}${details && !details.obfuscated ? ", unobfuscated" : ""}). Loaders with builds: ${avail.join(", ") || "none yet"}.`,
    data,
  );
}

function compact(loader: Loader, info: unknown): Record<string, unknown> {
  if (info && typeof info === "object" && "error" in info) return { available: false, error: (info as { error: string }).error };
  const i = info as Record<string, unknown>;
  if (loader === "fabric") {
    return { available: !!i.gameSupported, loader: i.loader, fabricApi: i.fabricApi ?? null, yarn: i.yarn ?? null };
  }
  const all = (i.all as string[]) ?? [];
  if (loader === "forge") {
    return { available: all.length > 0, recommended: i.recommended ?? null, latest: i.latest ?? null, builds: all.length };
  }
  return { available: all.length > 0, artifact: i.artifact, latestStable: i.latestStable ?? null, latest: i.latest ?? null, builds: all.length };
}

export function registerListVersions(server: McpServer, services: Services): void {
  server.registerTool(
    "list_versions",
    {
      title: "List Minecraft / loader versions",
      description:
        "Live Minecraft versions from Mojang plus Forge, Fabric and NeoForge availability. With mcVersion: compatible loader versions (Fabric Loader/API/Yarn, Forge recommended/latest, NeoForge stable/beta), required Java and the recommended Gradle plugin per loader. Data comes from official sources at call time (cached), never from a hardcoded list.",
      inputSchema: listVersionsInput,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    (args) => guard(() => listVersions(services, args)),
  );
}
