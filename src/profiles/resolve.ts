import { compareMcVersions } from "../util/mcversion.js";
import type { LoadedProfile } from "./loader.js";
import {
  type Loader,
  type PartialProfileFields,
  type ProfileFields,
  ProfileFieldsSchema,
  type ProfileRule,
  type ResolvedProfile,
} from "./schema.js";

/** Facts derived at runtime from official metadata (Mojang per-version JSON). */
export interface VersionFacts {
  /** Java major version Mojang ships for this MC version (javaVersion.majorVersion). */
  javaMajor?: number;
  /** Mojang publishes client_mappings → the game jar is obfuscated. */
  obfuscated?: boolean;
  /** false when Mojang's manifest does not list this version (e.g. a typo or a hypothetical 1.99.0). */
  known?: boolean;
}

export class ProfileResolutionError extends Error {}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Objects merge recursively; arrays and scalars replace. `addNotes` appends to notes. */
function mergeInto(target: Record<string, unknown>, patch: PartialProfileFields): void {
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    if (k === "addNotes") {
      target.notes = [...((target.notes as string[] | undefined) ?? []), ...(v as string[])];
      continue;
    }
    if (isPlainObject(v) && isPlainObject(target[k])) {
      const inner = { ...(target[k] as Record<string, unknown>) };
      mergeInto(inner, v as PartialProfileFields);
      target[k] = inner;
    } else {
      target[k] = structuredClone(v);
    }
  }
}

function ruleMatches(rule: ProfileRule, mc: string, facts: VersionFacts): boolean {
  if (rule.since && compareMcVersions(mc, rule.since) < 0) return false;
  if (rule.until && compareMcVersions(mc, rule.until) > 0) return false;
  if (rule.when?.obfuscated !== undefined) {
    // Unknown fact → only rules without the condition apply.
    if (facts.obfuscated === undefined || facts.obfuscated !== rule.when.obfuscated) return false;
  }
  return true;
}

function ruleLabel(r: ProfileRule): string {
  const range = r.since ? (r.until ? `${r.since}..${r.until}` : `${r.since}+`) : "*";
  const cond = r.when?.obfuscated !== undefined ? ` [obfuscated=${r.when.obfuscated}]` : "";
  return `${range}${cond}${r.description ? ` — ${r.description}` : ""}`;
}

/**
 * Resolve the effective profile for (loader, MC release).
 *
 * All rules whose range/conditions match are applied in file order (built-in, then user
 * files), later ones overriding earlier ones. Rules are "from X and up" by default, so
 * a version newer than anything known still resolves — to the closest lower rules —
 * and is flagged `extrapolated` with a warning.
 */
export function resolveProfile(
  profile: LoadedProfile,
  mcVersion: string,
  facts: VersionFacts = {},
): ResolvedProfile {
  const loader: Loader = profile.loader;
  if (compareMcVersions(mcVersion, profile.minVersion) < 0) {
    throw new ProfileResolutionError(
      `${loader}: Minecraft ${mcVersion} is older than the oldest supported version ${profile.minVersion}.`,
    );
  }
  const warnings: string[] = [];
  const merged: Record<string, unknown> = {};
  const matched: ProfileRule[] = [];
  for (const rule of profile.rules) {
    if (!ruleMatches(rule, mcVersion, facts)) continue;
    mergeInto(merged, rule.set);
    matched.push(rule);
  }
  if (matched.length === 0) {
    throw new ProfileResolutionError(`${loader}: no profile rule matches Minecraft ${mcVersion}.`);
  }
  const parsed = ProfileFieldsSchema.safeParse(merged);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new ProfileResolutionError(`${loader} profile for ${mcVersion} is incomplete after merging rules: ${issues}`);
  }
  const fields: ProfileFields = parsed.data;

  const basedOn = matched
    .map((r) => r.since)
    .filter((s): s is string => !!s)
    .sort(compareMcVersions)
    .at(-1) ?? profile.minVersion;

  const verified = matched.some((r) => r.verified?.includes(mcVersion));
  const newer = compareMcVersions(mcVersion, profile.testedUpTo) > 0;
  const unknown = facts.known === false;
  const extrapolated = newer || unknown;
  if (unknown && !newer) {
    warnings.push(
      `UNVERIFIED: Minecraft ${mcVersion} is not a known release, so no profile rule was verified for it. ` +
        `Settings were taken from the closest lower rule (since ${basedOn}).`,
    );
  }
  if (newer) {
    warnings.push(
      `UNVERIFIED: Minecraft ${mcVersion} is newer than the newest version the ${loader} profile was verified against (${profile.testedUpTo}). ` +
        `Settings were extrapolated from the closest lower rule (since ${basedOn}). Build the project and, if anything differs, ` +
        `add a rule for ${mcVersion} in your user profiles directory.`,
    );
  }

  let java: number;
  if (fields.java === "auto") {
    if (facts.javaMajor) {
      java = facts.javaMajor;
    } else {
      java = 21;
      warnings.push("Java version could not be read from Mojang metadata; assuming Java 21.");
    }
  } else {
    java = fields.java;
    if (facts.javaMajor && facts.javaMajor !== java) {
      warnings.push(`Profile pins Java ${java} but Mojang ships Java ${facts.javaMajor} for ${mcVersion}.`);
    }
  }
  if (facts.obfuscated === undefined) {
    warnings.push("Could not determine whether this Minecraft version is obfuscated; obfuscation-dependent rules were skipped.");
  }

  return {
    ...fields,
    loader,
    mcVersion,
    java,
    obfuscated: facts.obfuscated ?? true,
    basedOn,
    matchedRules: matched.map(ruleLabel),
    verified,
    extrapolated,
    warnings,
  };
}

export function mixinCompatibilityLevel(p: Pick<ResolvedProfile, "mixin" | "java">): string {
  return p.mixin.compatibilityLevel === "auto" ? `JAVA_${p.java}` : p.mixin.compatibilityLevel;
}
