import { z } from "zod";
import { compareLooseVersions } from "../util/mcversion.js";
import { parseMavenMetadata } from "../util/maven.js";

const GameSchema = z.array(z.object({ version: z.string(), stable: z.boolean() }));
const LoaderSchema = z.array(z.object({ version: z.string(), stable: z.boolean(), maven: z.string().optional() }));
const YarnSchema = z.array(
  z.object({ gameVersion: z.string(), version: z.string(), build: z.number(), stable: z.boolean().optional() }),
);

export function parseFabricGameVersions(json: string): { version: string; stable: boolean }[] {
  return GameSchema.parse(JSON.parse(json));
}

/** Newest stable Fabric Loader (the meta endpoint lists newest first). */
export function parseLatestFabricLoader(json: string): string | undefined {
  const loaders = LoaderSchema.parse(JSON.parse(json));
  return (loaders.find((l) => l.stable) ?? loaders[0])?.version;
}

/** Newest Yarn build for a game version, or undefined (e.g. unobfuscated 26.x has none). */
export function parseLatestYarn(json: string): string | undefined {
  const yarn = YarnSchema.parse(JSON.parse(json));
  return [...yarn].sort((a, b) => b.build - a.build)[0]?.version;
}

/**
 * Fabric API versions are `<api>+<mc>` (e.g. 0.92.12+1.20.1). The maven-metadata list is
 * NOT sorted (backports interleave), so filter by suffix and sort numerically.
 */
export function fabricApiVersionsFor(xml: string, mc: string): string[] {
  const md = parseMavenMetadata(xml);
  const suffix = `+${mc}`;
  return md.versions
    .filter((v) => v.endsWith(suffix))
    .sort((a, b) => compareLooseVersions(b.slice(0, -suffix.length), a.slice(0, -suffix.length)));
}
