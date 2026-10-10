import { lookupProfile, type Services } from "../services.js";
import { ok } from "./result.js";
import { mixinCompatibilityLevel } from "../profiles/resolve.js";


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
