import type { Loader, Mappings, ResolvedProfile } from "../profiles/schema.js";

export interface ProjectParams {
  modId: string;
  modName: string;
  /** Base Java package, e.g. com.example.mymod */
  package: string;
  author: string;
  version: string;
  mcVersion: string;
  loader: Loader;
  mappings?: Mappings;
  description?: string;
  license?: string;
  /** Main class simple name; derived from modName when omitted. */
  mainClass?: string;
}

/** Concrete versions resolved live for this project. */
export interface ResolvedVersions {
  minecraft: string;
  /** Fabric Loader / Forge / NeoForge version string as used in the build. */
  loader: string;
  pluginVersion: string;
  fabricApi?: string;
  yarn?: string;
  parchment?: string;
  /** Forge major version (for mods.toml loader/dependency ranges). */
  forgeMajor?: string;
}

export interface ProjectContext {
  params: Required<Omit<ProjectParams, "mappings" | "mainClass">> & { mappings: Mappings; mainClass: string };
  profile: ResolvedProfile;
  versions: ResolvedVersions;
}

export type FileContent = string | { copyFrom: string; executable?: boolean };

export interface ProjectPlan {
  context: ProjectContext;
  files: Map<string, FileContent>;
  warnings: string[];
  sources: string[];
}
