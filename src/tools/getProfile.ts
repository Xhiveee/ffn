import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { LoaderSchema } from "../profiles/schema.js";
import { lookupProfile, type Services } from "../services.js";
import { guard, ok } from "./result.js";
import { mixinCompatibilityLevel } from "../profiles/resolve.js";

export const getProfileInput = {
  mcVersion: z.string().describe("Minecraft version, e.g. 1.20.1, 1.21.1, 26.3 (snapshots map to their release)."),
  loader: LoaderSchema.describe("forge | fabric | neoforge"),
  verbose: z.boolean().optional().describe("Include matched rules, profile source files, sample-mixin data, reference links and raw facts (default false)."),
};

export async function getProfile(services: Services, args: { mcVersion: string; loader: "forge" | "fabric" | "neoforge"; verbose?: boolean }) {
  const { profile, release, facts, notes } = await lookupProfile(services, args.loader, args.mcVersion.trim());
  let packMeta: Record<string, unknown> = { ...profile.packMeta };
  if (profile.packMeta.kind !== "none" && profile.packMeta.format === undefined) {
    const { packFormat } = await import("../sources/packformat.js");
    const pf = await packFormat(services, release).catch(() => undefined);
    if (pf) packMeta = { kind: profile.packMeta.kind, format: Number(pf.resource.split(".")[0]), ...(pf.resource.includes(".") ? { resource: pf.resource } : {}), data: pf.data, from: "version.json" };
  }
  const full = {
    ...profile,
    packMeta,
    mixin: { ...profile.mixin, effectiveCompatibilityLevel: mixinCompatibilityLevel(profile) },
    profileRelease: release,
    facts,
    warnings: notes.warnings,
    profileSources: (await services.profiles())[args.loader]?.sources ?? [],
  };
  const { matchedRules, profileSources, facts: _f, references, warnings: _w, notes: pnotes, ...rest } = full as typeof full & { references?: unknown; notes?: string[] };
  const plugin = { ...rest.plugin } as Record<string, unknown>;
  delete plugin.metadataUrl;
  const data = args.verbose ? full : { ...rest, plugin, ...(pnotes?.length ? { notes: pnotes } : {}), warnings: notes.warnings };
  void matchedRules; void profileSources; void references;
  const status = profile.extrapolated ? "EXTRAPOLATED (unverified)" : profile.verified ? "verified" : "within tested range";
  return ok(
    `${args.loader} profile for Minecraft ${args.mcVersion}: ${status}; based on rule since ${profile.basedOn}. Java ${profile.java}, ${profile.buildSystem} (${profile.plugin.id}), ${profile.metadata.file}, mixins via ${profile.mixin.registration}.` +
      (notes.warnings.length ? `\nWarnings:\n- ${notes.warnings.join("\n- ")}` : ""),
    data,
  );
}

export function registerGetProfile(server: McpServer, services: Services): void {
  server.registerTool(
    "get_profile",
    {
      title: "Resolve version profile",
      description:
        "Resolved FFN version profile for (mcVersion, loader): Java version, Gradle + plugin, metadata file (mods.toml / neoforge.mods.toml / fabric.mod.json), supported mappings, Mixin registration/refmap/MixinExtras rules. Versions newer than the profile's tested range fall back to the closest lower rules and are flagged as unverified.",
      inputSchema: getProfileInput,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    (args) => guard(() => getProfile(services, args)),
  );
}
