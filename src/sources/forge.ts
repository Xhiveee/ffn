import { z } from "zod";
import { compareLooseVersions } from "../util/mcversion.js";
import { parseMavenMetadata } from "../util/maven.js";

const PromotionsSchema = z.object({ promos: z.record(z.string(), z.string()) });

export interface ForgeVersions {
  mcVersion: string;
  /** Forge version without the MC prefix, e.g. 47.4.10. */
  recommended?: string;
  latest?: string;
  /** All Forge builds for this MC version, newest first. */
  all: string[];
}

export function parseForgePromotions(json: string): Record<string, string> {
  return PromotionsSchema.parse(JSON.parse(json)).promos;
}

/** Forge maven versions look like "1.20.1-47.4.10" (some ancient ones carry a third "-mc" part). */
export function forgeVersionsFor(xml: string, promos: Record<string, string>, mc: string): ForgeVersions {
  const md = parseMavenMetadata(xml);
  const prefix = `${mc}-`;
  const all = md.versions
    .filter((v) => v.startsWith(prefix))
    .map((v) => v.slice(prefix.length).split("-")[0]!)
    .sort((a, b) => compareLooseVersions(b, a));
  return {
    mcVersion: mc,
    recommended: promos[`${mc}-recommended`],
    latest: promos[`${mc}-latest`] ?? all[0],
    all,
  };
}

/** MC versions that have at least one Forge build. */
export function forgeMinecraftVersions(xml: string): string[] {
  const md = parseMavenMetadata(xml);
  return [...new Set(md.versions.map((v) => v.split("-")[0]!))];
}
