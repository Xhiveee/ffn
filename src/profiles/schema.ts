import { z } from "zod";

export const LOADERS = ["forge", "fabric", "neoforge"] as const;
export const LoaderSchema = z.enum(LOADERS);
export type Loader = z.infer<typeof LoaderSchema>;

export const MAPPINGS = ["mojmap", "parchment", "yarn"] as const;
export const MappingsSchema = z.enum(MAPPINGS);
export type Mappings = z.infer<typeof MappingsSchema>;

/**
 * Build systems FFN knows how to template. A new Minecraft version that keeps
 * using one of these needs no code change, only (at most) a profile rule.
 */
export const BUILD_SYSTEMS = [
  "fabric-loom", // Fabric Loom (plugin id decides remap vs. non-remap)
  "forgegradle6", // MinecraftForge ForgeGradle 6.x
  "forgegradle7", // MinecraftForge ForgeGradle 7.x
  "moddevgradle", // NeoForged ModDevGradle (NeoForge 20.2+)
  "moddevgradle-legacy", // ModDevGradle legacyforge plugin (Forge / NeoForge 1.20.1)
] as const;
export const BuildSystemSchema = z.enum(BUILD_SYSTEMS);
export type BuildSystem = z.infer<typeof BuildSystemSchema>;

const PluginSchema = z
  .object({
    id: z.string(),
    /** "latest" (resolved from metadataUrl), a literal version, or a Gradle range like "[7.0,8)". */
    version: z.string(),
    metadataUrl: z.string().url().optional(),
    /** Only consider versions starting with this prefix when resolving "latest" (e.g. "6.0."). */
    versionPrefix: z.string().optional(),
    allowUnstable: z.boolean().optional(),
  })
  .strict();

const MixinSchema = z
  .object({
    /** How the loader discovers `<modid>.mixins.json`. */
    registration: z.enum(["fabric.mod.json", "mods.toml", "manifest"]),
    /** Also pass `--mixin.config=<file>` to dev run configurations (needed when only the jar manifest registers it). */
    devRunArg: z.boolean(),
    /** Runtime uses different names than dev → the mixin annotation processor must produce a refmap. */
    refmap: z.boolean(),
    annotationProcessor: z.string().nullable().optional(),
    /** Apply the MixinGradle plugin (ForgeGradle + refmap). */
    mixinGradle: z.object({ id: z.string(), version: z.string() }).strict().nullable().optional(),
    /** "auto" -> JAVA_<java version>, or an explicit Mixin compatibility level such as "JAVA_17". */
    compatibilityLevel: z.string(),
    minMixinVersion: z.string().optional(),
    mixinExtras: z
      .object({
        bundled: z.boolean(),
        note: z.string().optional(),
      })
      .strict(),
  })
  .strict();

const MetadataSchema = z
  .object({
    file: z.string(),
    format: z.enum(["fabric.mod.json", "mods.toml", "neoforge.mods.toml"]),
    /** mods.toml `loaderVersion`; "forge-major" -> "[<forge major>,)", null -> omit the line. */
    loaderVersion: z.string().nullable().optional(),
    /** Forge/NeoForge dependency mod id. */
    loaderModId: z.string().optional(),
    /** Dependency syntax: Forge uses `mandatory=true`, NeoForge 20.2+ uses `type="required"`. */
    dependencyStyle: z.enum(["mandatory", "type"]).optional(),
  })
  .strict();

const PackMetaSchema = z
  .object({
    kind: z.enum(["none", "pack_format", "min_max"]),
    format: z.number().int().optional(),
  })
  .strict();

const SampleMixinSchema = z
  .object({
    targetClass: z.string(),
    method: z.string(),
    comment: z.string().optional(),
  })
  .strict();

/** All fields a rule may set. Every field is optional in a rule; the merged result must be complete. */
export const ProfileFieldsSchema = z
  .object({
    /** "auto" = read `javaVersion.majorVersion` from Mojang's per-version JSON. */
    java: z.union([z.literal("auto"), z.number().int().min(8)]),
    gradle: z
      .object({
        version: z.string(),
        /** Minimum JDK needed to *run* Gradle with this plugin (may exceed the mod's Java target). */
        minJvm: z.number().int().optional(),
      })
      .strict(),
    buildSystem: BuildSystemSchema,
    plugin: PluginSchema,
    /** Maven coordinate of the loader artifact (group:artifact), when relevant. */
    loaderArtifact: z.string(),
    metadata: MetadataSchema,
    mappings: z.object({ default: MappingsSchema, supported: z.array(MappingsSchema).min(1) }).strict(),
    mixin: MixinSchema,
    packMeta: PackMetaSchema,
    sampleMixin: z.partialRecord(MappingsSchema, SampleMixinSchema),
    references: z.array(z.string()),
    notes: z.array(z.string()),
  })
  .strict();
export type ProfileFields = z.infer<typeof ProfileFieldsSchema>;

/** Deep-partial for rule bodies (objects merge, arrays/scalars replace). */
const PartialFields = z
  .object({
    java: ProfileFieldsSchema.shape.java.optional(),
    gradle: z.object({ version: z.string(), minJvm: z.number().int() }).partial().strict().optional(),
    buildSystem: BuildSystemSchema.optional(),
    plugin: PluginSchema.partial().strict().optional(),
    loaderArtifact: z.string().optional(),
    metadata: MetadataSchema.partial().strict().optional(),
    mappings: z.object({ default: MappingsSchema, supported: z.array(MappingsSchema).min(1) }).partial().strict().optional(),
    mixin: MixinSchema.extend({ mixinExtras: MixinSchema.shape.mixinExtras.partial().strict() }).partial().strict().optional(),
    packMeta: PackMetaSchema.partial().strict().optional(),
    sampleMixin: z.partialRecord(MappingsSchema, SampleMixinSchema.partial().strict()).optional(),
    references: z.array(z.string()).optional(),
    notes: z.array(z.string()).optional(),
    /** Like `notes`, but appended instead of replacing. */
    addNotes: z.array(z.string()).optional(),
  })
  .strict();
export type PartialProfileFields = z.infer<typeof PartialFields>;

const VersionString = z.string().regex(/^\d+(\.\d+){1,3}$/, "must be a release version like 1.20.1 or 26.3");

export const RuleSchema = z
  .object({
    /** Inclusive lower bound ("from X and up"). Omit for "all versions". */
    since: VersionString.optional(),
    /** Inclusive upper bound. Omit for "and every later version". */
    until: VersionString.optional(),
    /** Conditions on facts derived at runtime from official metadata. */
    when: z
      .object({
        /** Mojang still ships obfuscated jars + ProGuard mappings (false from 26.1 on). */
        obfuscated: z.boolean().optional(),
      })
      .strict()
      .optional(),
    description: z.string().optional(),
    /** MC versions a maintainer has actually built with this rule. */
    verified: z.array(z.string()).optional(),
    set: PartialFields,
  })
  .strict();
export type ProfileRule = z.infer<typeof RuleSchema>;

export const ProfileFileSchema = z
  .object({
    loader: LoaderSchema,
    /** Oldest supported MC version. */
    minVersion: VersionString,
    /** Newest MC version this profile was verified against. Newer → "extrapolated" warning. */
    testedUpTo: VersionString,
    rules: z.array(RuleSchema).min(1),
  })
  .strict();
export type ProfileFile = z.infer<typeof ProfileFileSchema>;

/** A user file may only add rules (and optionally bump testedUpTo / minVersion). */
export const UserProfileFileSchema = ProfileFileSchema.partial({ minVersion: true, testedUpTo: true });
export type UserProfileFile = z.infer<typeof UserProfileFileSchema>;

export interface ResolvedProfile extends Omit<ProfileFields, "java"> {
  loader: Loader;
  mcVersion: string;
  java: number;
  obfuscated: boolean;
  /** `since` of the most specific matched rule — the "closest lower profile". */
  basedOn: string;
  matchedRules: string[];
  verified: boolean;
  extrapolated: boolean;
  warnings: string[];
}
