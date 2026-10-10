import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import path from "node:path";
import { z } from "zod";
import { planProject, writeProject } from "../generator/index.js";
import { LoaderSchema, MappingsSchema } from "../profiles/schema.js";
import type { Services } from "../services.js";
import { guard, ok } from "./result.js";

export const createProjectInput = {
  targetDir: z.string().describe("Directory to create the project in (absolute path recommended). Must be empty unless overwrite=true."),
  loader: LoaderSchema.describe("forge | fabric | neoforge"),
  mcVersion: z.string().describe("Minecraft version, e.g. 1.20.1 or the latest release from list_versions."),
  modId: z.string().describe("Mod id: ^[a-z][a-z0-9_]{1,63}$"),
  modName: z.string().min(1).describe("Human-readable mod name."),
  package: z.string().describe("Base Java package, e.g. com.example.mymod"),
  author: z.string().min(1),
  version: z.string().default("1.0.0").describe("Mod version, e.g. 1.0.0"),
  mappings: MappingsSchema.optional().describe("mojmap (default) | parchment | yarn (Fabric, obfuscated versions only)"),
  description: z.string().optional(),
  license: z.string().optional().describe('Default "All Rights Reserved".'),
  mainClass: z.string().optional().describe("Main class simple name (derived from modName if omitted)."),
  overwrite: z.boolean().optional().describe("Allow writing into a non-empty directory."),
  dryRun: z.boolean().optional().describe("Only return the file list and resolved versions; write nothing."),
};

type Args = z.infer<z.ZodObject<typeof createProjectInput>>;

export async function createProject(services: Services, args: Args) {
  const plan = await planProject(services, {
    modId: args.modId,
    modName: args.modName,
    package: args.package,
    author: args.author,
    version: args.version ?? "1.0.0",
    mcVersion: args.mcVersion.trim(),
    loader: args.loader,
    mappings: args.mappings,
    description: args.description,
    license: args.license,
    mainClass: args.mainClass,
  });
  const target = path.resolve(args.targetDir);
  const files = args.dryRun ? [...plan.files.keys()].sort() : await writeProject(plan, target, { overwrite: args.overwrite });
  const { profile, versions, params } = plan.context;
  const data = {
    targetDir: target,
    written: !args.dryRun,
    loader: params.loader,
    mcVersion: params.mcVersion,
    mappings: params.mappings,
    mainClass: `${params.package}.${params.mainClass}`,
    versions,
    toolchain: { java: profile.java, gradleJvm: Math.max(profile.java, profile.gradle.minJvm ?? 17), gradle: profile.gradle.version, buildSystem: profile.buildSystem, plugin: profile.plugin.id },
    mixin: {
      config: `${params.modId}.mixins.json`,
      registration: profile.mixin.registration,
      refmap: profile.mixin.refmap,
      mixinExtras: profile.mixin.mixinExtras,
    },
    profile: { basedOn: profile.basedOn, verified: profile.verified, extrapolated: profile.extrapolated },
    files,
    warnings: plan.warnings,
    nextSteps: [`cd ${target}`, "./gradlew build", "./gradlew runClient"],
  };
  return ok(
    `${args.dryRun ? "Planned" : "Created"} ${params.loader} ${params.mcVersion} project "${params.modName}" (${files.length} files) in ${target}. ` +
      `Targets Java ${profile.java}; run Gradle with JDK ${Math.max(profile.java, profile.gradle.minJvm ?? 17)}+ (./gradlew build).` +
      (plan.warnings.length ? `\nWarnings:\n- ${plan.warnings.join("\n- ")}` : ""),
    data,
  );
}

export function registerCreateProject(server: McpServer, services: Services): void {
  server.registerTool(
    "create_project",
    {
      title: "Create mod project",
      description:
        "Generate a ready-to-build mod project for Forge, Fabric or NeoForge on any supported Minecraft version: Gradle wrapper, build script, gradle.properties, settings, loader metadata, main class, an example Mixin with <modid>.mixins.json wired the way that loader/version expects, plus assets/data folders. Loader, API and plugin versions are resolved live.",
      inputSchema: createProjectInput,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => guard(() => createProject(services, args as Args)),
  );
}
