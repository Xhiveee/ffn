/**
 * Tool input schemas and descriptions (zod only). Kept apart from the implementations so the server can
 * answer tools/list without loading them; every description is written to be short — it is sent to the
 * model with every request.
 */
import { z } from "zod";
import { LoaderSchema } from "../profiles/schema.js";

export const INDEX_NAMESPACES = ["mojmap", "parchment", "yarn", "intermediary", "obf"] as const;
const NAMES = ["mojmap", "parchment", "yarn", "intermediary", "srg", "obf"] as const;
const offset = z.number().int().min(0).max(1e6).optional().describe("Paging offset.");

export const indexSpecShape = {
  mcVersion: z.string().optional().describe("Minecraft version (optional with projectDir)."),
  mappings: z.enum(INDEX_NAMESPACES).optional().describe("Default mojmap (parchment = mojmap names). 26.1+ has Mojang names only."),
  loader: LoaderSchema.optional(),
  projectDir: z.string().optional().describe("Use the jar this project compiles against (loader patches, project names)."),
  source: z.enum(["auto", "vanilla", "project", "loader"]).optional().describe("auto: project jar if projectDir, else vanilla. loader: Forge/NeoForge-patched jar via a cached official MDK (needs loader; first run takes minutes)."),
};

export const listVersionsInput = {
  mcVersion: z.string().optional().describe("Details for this version: loader versions, Java, Gradle plugin."),
  includeSnapshots: z.boolean().optional(),
  includeUnsupported: z.boolean().optional().describe("Include versions below 1.20.1."),
  limit: z.number().int().min(1).max(500).optional().describe("Default 60."),
};

export const getProfileInput = {
  mcVersion: z.string().describe("e.g. 1.20.1, 1.21.1, 26.3"),
  loader: LoaderSchema,
  verbose: z.boolean().optional().describe("Add matched rules, sources, references."),
};

export const gradleBuildInput = {
  projectDir: z.string().describe("Mod project (root or subproject)."),
  tasks: z.array(z.string()).optional().describe('Default ["build"].'),
  args: z.array(z.string()).optional().describe("Extra Gradle args, e.g. --offline."),
  javaHome: z.string().optional().describe("Force a JDK (default: auto-picked)."),
  timeoutSec: z.number().int().positive().max(7200).optional().describe("Default 1200."),
  daemon: z.boolean().optional().describe("Default true."),
};

export const searchInput = {
  ...indexSpecShape,
  query: z.string().min(1).describe("Name fragment or /regex/. text: regex over source lines. usages: Class, Class#method[(desc)] or Class#field. callees: Class#method[(desc)]. packages: package or \".\"."),
  kind: z.enum(["any", "class", "method", "field", "text", "usages", "callees", "packages"]).optional().describe("any (default): names. text: grep sources (decompiled lazily if no sources jar). usages: callers/readers from bytecode. callees: what a method calls/reads. packages: subpackages + classes."),
  limit: z.number().int().min(1).max(200).optional().describe("Default 30 (packages 100)."),
  offset,
};

export const getClassInput = {
  ...indexSpecShape,
  className: z.string().describe("FQN, internal or simple name; inner classes with . or $."),
  method: z.string().optional().describe('Only this method\'s source: name ("tick", "<init>") or name(desc). Overloads max 5.'),
  detail: z.enum(["outline", "hierarchy", "full"]).optional().describe("outline (default): signatures. hierarchy: supers, interfaces, subtypes (+ overrides with method). full: paged source."),
  members: z.array(z.enum(["fields", "methods", "inner"])).optional(),
  memberFilter: z.string().optional().describe("Outline: name contains."),
  inherited: z.boolean().optional().describe("Outline: add supertype members."),
  descriptors: z.boolean().optional().describe("Outline: name(desc) selectors (default) or false = short Java signatures."),
  offset,
  limit: z.number().int().min(1).max(2000).optional().describe("Outline members (200) / full lines (300)."),
};

export const translateInput = {
  mcVersion: z.string(),
  name: z.string().describe("Class (a.b.C, class_1234, C_1234_), member (Owner#name, name(desc)) or bare member name (m_1234_, method_5678)."),
  from: z.enum(NAMES),
  to: z.enum(NAMES).optional().describe("Highlight this namespace."),
  kind: z.enum(["class", "field", "method"]).optional(),
  limit: z.number().int().min(1).max(100).optional(),
};

export const mixinTargetsInput = {
  ...indexSpecShape,
  targetClass: z.string(),
  methodFilter: z.string().optional().describe("Name contains, or exact name(desc). Without it: selector list only."),
  injectionPoints: z.boolean().optional().describe("List INVOKE/FIELD/NEW/CONSTANT targets (default when ≤ 3 methods)."),
  maxPoints: z.number().int().min(1).max(500).optional().describe("Per kind per method (25)."),
  includeSynthetic: z.boolean().optional().describe("Include lambda$… bodies."),
  offset,
  limit: z.number().int().min(1).max(500).optional().describe("Methods per page (100, or 3 with points)."),
};

export const mixinValidateInput = {
  projectDir: z.string().describe("Project root (multi-project: all subprojects) or one subproject."),
  mixinClass: z.string().optional().describe("Only this mixin."),
  source: z.enum(["auto", "vanilla", "project"]).optional().describe("auto (default): the project's compile jar, else vanilla."),
  includeInfo: z.boolean().optional(),
};

export const analyzeCrashInput = {
  log: z.string().optional().describe("Pasted crash report / log / Gradle output."),
  path: z.string().optional().describe("Crash report or log file."),
  projectDir: z.string().optional().describe("Newest crash report (else latest.log) in its run dir."),
  runDir: z.string().optional().describe('Relative to projectDir (default "run").'),
  limit: z.number().int().min(1).max(200).optional().describe("Default 20, errors first."),
  offset,
};

export const docsSearchInput = {
  query: z.string().min(2),
  loader: LoaderSchema.optional().describe("Default: from projectDir, else all."),
  mcVersion: z.string().optional().describe("Default: from projectDir, else latest."),
  projectDir: z.string().optional(),
  kinds: z.array(z.enum(["docs", "primer", "changelog"])).optional().describe("docs, primer (NeoForged porting primers), changelog (Fabric announcements). Default all."),
  topic: z.string().optional().describe("e.g. mixin (Mixin, MixinExtras, Fabric mixin pages)."),
  sources: z.array(z.string()).optional().describe("Source ids from profiles/docs/sources.yaml."),
  limit: z.number().int().min(1).max(25).optional().describe("Default 5."),
  includeCode: z.boolean().optional().describe("Default true."),
  verifyUrls: z.boolean().optional().describe("Default true."),
};

export const checkProfilesInput = {
  loaders: z.array(LoaderSchema).optional(),
  verbose: z.boolean().optional().describe("Also list up-to-date items."),
};

type Shape = Record<string, z.ZodType>;
export type Args<S extends Shape> = z.infer<z.ZodObject<S>>;
