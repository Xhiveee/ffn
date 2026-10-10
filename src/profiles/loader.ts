import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import { z } from "zod";
import { compareMcVersions } from "../util/mcversion.js";
import {
  type Loader,
  type ProfileFile,
  ProfileFileSchema,
  type ProfileRule,
  UserProfileFileSchema,
} from "./schema.js";

export interface LoadedProfile extends ProfileFile {
  /** Files that contributed, in merge order. */
  sources: string[];
}

export type ProfileSet = Partial<Record<Loader, LoadedProfile>>;

export class ProfileError extends Error {}

function formatZodError(file: string, err: z.ZodError): string {
  const issues = err.issues.map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`).join("\n");
  return `Invalid profile ${file}:\n${issues}`;
}

async function listYaml(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir);
    return entries.filter((f) => /\.ya?ml$/i.test(f)).sort().map((f) => path.join(dir, f));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
}

function tagRules(rules: ProfileRule[], file: string): ProfileRule[] {
  return rules.map((r) => ({ ...r, description: r.description ?? `rule from ${path.basename(file)}` }));
}

/**
 * Load built-in profiles, then user profiles from `userDir`.
 * User files for an existing loader append their rules (later rules win) and may raise
 * `testedUpTo`; a user file for a loader with no built-in profile must be complete.
 */
export async function loadProfiles(builtinDir: string, userDir?: string): Promise<ProfileSet> {
  const set: ProfileSet = {};
  for (const file of await listYaml(builtinDir)) {
    const raw = YAML.parse(await readFile(file, "utf8"));
    const parsed = ProfileFileSchema.safeParse(raw);
    if (!parsed.success) throw new ProfileError(formatZodError(file, parsed.error));
    const p = parsed.data;
    if (set[p.loader]) throw new ProfileError(`Duplicate built-in profile for loader ${p.loader}: ${file}`);
    set[p.loader] = { ...p, rules: tagRules(p.rules, file), sources: [file] };
  }
  if (userDir) {
    for (const file of await listYaml(userDir)) {
      const raw = YAML.parse(await readFile(file, "utf8"));
      const parsed = UserProfileFileSchema.safeParse(raw);
      if (!parsed.success) throw new ProfileError(formatZodError(file, parsed.error));
      const u = parsed.data;
      const existing = set[u.loader];
      if (!existing) {
        const full = ProfileFileSchema.safeParse(raw);
        if (!full.success) throw new ProfileError(formatZodError(file, full.error));
        set[u.loader] = { ...full.data, rules: tagRules(full.data.rules, file), sources: [file] };
        continue;
      }
      existing.rules.push(...tagRules(u.rules, file));
      existing.sources.push(file);
      if (u.testedUpTo && compareMcVersions(u.testedUpTo, existing.testedUpTo) > 0) existing.testedUpTo = u.testedUpTo;
      if (u.minVersion) existing.minVersion = u.minVersion;
    }
  }
  return set;
}
