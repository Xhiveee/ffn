import { IndexService } from "./index/service.js";
import { loadConfig, type FfnConfig } from "./config.js";
import { loadProfiles, type ProfileSet } from "./profiles/loader.js";
import { resolveProfile, type VersionFacts } from "./profiles/resolve.js";
import type { Loader, ResolvedProfile } from "./profiles/schema.js";
import { Notes, VersionService } from "./sources/index.js";
import { CachingFetcher, type Fetcher } from "./util/http.js";

/** Everything the tools need, constructed once per server (injectable for tests). */
export interface Services {
  config: FfnConfig;
  versions: VersionService;
  /** Profiles are reloaded on every call so edits to user profiles apply without a restart. */
  profiles(): Promise<ProfileSet>;
  /** Minecraft source/bytecode indexes (built lazily, cached on disk). */
  indexes: IndexService;
}

export function createServices(opts: { config?: FfnConfig; fetcher?: Fetcher } = {}): Services {
  const config = opts.config ?? loadConfig();
  const fetcher =
    opts.fetcher ??
    new CachingFetcher({
      cacheDir: config.cacheDir,
      defaultTtlMs: config.cacheTtlMs,
      offline: config.offline,
      userAgent: config.userAgent,
    });
  const services: Services = {
    config,
    versions: new VersionService(fetcher),
    profiles: () => loadProfiles(config.builtinProfilesDir, config.userProfilesDir),
    indexes: undefined as unknown as IndexService,
  };
  services.indexes = new IndexService(services);
  return services;
}

export interface ProfileLookup {
  profile: ResolvedProfile;
  /** Release whose rules were applied (differs from input for snapshots). */
  release: string;
  facts: VersionFacts;
  notes: Notes;
}

/** Resolve a profile using live Mojang facts (Java version, obfuscation) for the MC version. */
export async function lookupProfile(
  services: Services,
  loader: Loader,
  mcVersion: string,
  notes: Notes = new Notes(),
): Promise<ProfileLookup> {
  const profiles = await services.profiles();
  const lp = profiles[loader];
  if (!lp) throw new Error(`No profile for loader "${loader}".`);
  const { release, note } = await services.versions.profileVersionFor(mcVersion, notes);
  if (note) notes.warn(note);
  let facts: VersionFacts = {};
  try {
    const details = await services.versions.mojangVersion(mcVersion, notes);
    if (!details) {
      facts = { known: false };
      notes.warn(`Minecraft ${mcVersion} is not in Mojang's version manifest; Java version and obfuscation could not be verified.`);
    } else {
      facts = { javaMajor: details.javaMajor, obfuscated: details.obfuscated, known: true };
    }
  } catch (e) {
    notes.warn(`Could not read Mojang metadata for ${mcVersion}: ${(e as Error).message}`);
  }
  const profile = resolveProfile(lp, release, facts);
  if (release !== mcVersion) profile.mcVersion = mcVersion;
  for (const w of profile.warnings) notes.warn(w);
  return { profile, release, facts, notes };
}
