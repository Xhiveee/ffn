import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z, type ZodRawShape } from "zod";
import { LoaderSchema, MappingsSchema } from "../profiles/schema.js";
import { fail } from "./result.js";

interface StubSpec {
  name: string;
  title: string;
  description: string;
  milestone: string;
  meanwhile: string;
  input: ZodRawShape;
}

const mc = z.string().describe("Minecraft version");
const projectDir = z.string().describe("Path to a mod project (e.g. one created by create_project)");
const anyMappings = z.enum(["mojmap", "parchment", "yarn", "intermediary", "srg", "obf"]);

export const STUBS: StubSpec[] = [
  {
    name: "search_mc_source",
    title: "Search Minecraft source",
    description: "Search decompiled Minecraft (+ loader) sources for a version by class/method/field name or text.",
    milestone: "M2 (source indexing)",
    meanwhile: "Run ./gradlew genSources (Fabric) or open the decompiled sources from ModDevGradle/ForgeGradle in your IDE.",
    input: {
      mcVersion: mc,
      loader: LoaderSchema.optional(),
      query: z.string(),
      kind: z.enum(["class", "method", "field", "text"]).optional(),
      mappings: MappingsSchema.optional(),
      limit: z.number().int().min(1).max(200).optional(),
    },
  },
  {
    name: "get_class",
    title: "Get Minecraft class",
    description: "Return the real members/signatures (and optionally source) of a Minecraft class for an exact version and mappings.",
    milestone: "M2 (source indexing)",
    meanwhile: "Inspect the class in your IDE after the first Gradle sync.",
    input: { mcVersion: mc, loader: LoaderSchema.optional(), className: z.string(), mappings: MappingsSchema.optional(), includeSource: z.boolean().optional() },
  },
  {
    name: "translate_mapping",
    title: "Translate mapping names",
    description: "Translate class/method/field names between Mojang, Yarn, Intermediary, SRG and obfuscated names for a version.",
    milestone: "M2 (mappings)",
    meanwhile: "Use https://linkie.shedaniel.dev/mappings or https://mappings.dev.",
    input: { mcVersion: mc, name: z.string(), from: anyMappings, to: anyMappings, kind: z.enum(["class", "method", "field"]).optional() },
  },
  {
    name: "generate",
    title: "Generate content",
    description: "Generate version-correct boilerplate in a project: blocks, items, entities, block entities, recipes, datapack files, event listeners, commands, configs, creative tabs, network payloads.",
    milestone: "M3 (content generators)",
    meanwhile: "Follow the loader docs for the project's Minecraft version (see get_profile → references).",
    input: {
      projectDir,
      kind: z.enum(["block", "item", "entity", "block_entity", "recipe", "datapack", "event_listener", "command", "config", "creative_tab", "network_payload"]),
      name: z.string(),
      options: z.record(z.string(), z.unknown()).optional(),
    },
  },
  {
    name: "mixin_targets",
    title: "Mixin targets",
    description: "List real method signatures/descriptors and injection points of a target class for a version and mappings, so @Inject/@At targets are not guessed.",
    milestone: "M2 (source indexing)",
    meanwhile: "Check the target class in decompiled sources; prefer loader events when they exist.",
    input: { mcVersion: mc, loader: LoaderSchema.optional(), mappings: MappingsSchema.optional(), targetClass: z.string(), methodFilter: z.string().optional() },
  },
  {
    name: "mixin_generate",
    title: "Generate mixin",
    description: "Create a mixin (@Inject, @Redirect, @ModifyVariable, @ModifyArg, @Accessor/@Invoker, MixinExtras @WrapOperation/@ModifyExpressionValue/@ModifyReturnValue …) and register it in <modid>.mixins.json and the loader config.",
    milestone: "M3 (mixin tooling)",
    meanwhile: "Copy the example mixin from create_project and add the class to <modid>.mixins.json.",
    input: {
      projectDir,
      targetClass: z.string(),
      method: z.string(),
      injection: z.enum(["inject", "redirect", "modify_variable", "modify_arg", "modify_constant", "modify_return_value", "accessor", "invoker", "wrap_operation", "wrap_method", "modify_expression_value", "overwrite"]),
      at: z.string().optional().describe('Injection point, e.g. HEAD, RETURN, INVOKE:Lnet/minecraft/...;method()V'),
      side: z.enum(["common", "client", "server"]).optional(),
      name: z.string().optional(),
    },
  },
  {
    name: "mixin_validate",
    title: "Validate mixins",
    description: "Check that every mixin's target class, method and injection point exist in the project's Minecraft version before running the game.",
    milestone: "M3 (mixin tooling)",
    meanwhile: "Run the game; Mixin reports InvalidInjectionException at startup.",
    input: { projectDir, mixinClass: z.string().optional() },
  },
  {
    name: "mixin_port",
    title: "Port mixins",
    description: "When porting between versions, find mixins whose target disappeared or changed and propose new targets.",
    milestone: "M4 (porting)",
    meanwhile: "Port manually using the target version's sources.",
    input: { projectDir, fromMcVersion: mc, toMcVersion: mc },
  },
  {
    name: "gradle_build",
    title: "Gradle build",
    description: "Run Gradle tasks in a project with the right JDK and return parsed compiler/Gradle errors.",
    milestone: "M2 (build & run)",
    meanwhile: "Run ./gradlew build in the project directory.",
    input: { projectDir, tasks: z.array(z.string()).optional(), args: z.array(z.string()).optional(), javaHome: z.string().optional() },
  },
  {
    name: "run_client",
    title: "Run client",
    description: "Start the development client, capture logs and stop after a timeout or on crash.",
    milestone: "M2 (build & run)",
    meanwhile: "Run ./gradlew runClient.",
    input: { projectDir, timeoutSec: z.number().int().positive().optional(), args: z.array(z.string()).optional() },
  },
  {
    name: "run_server",
    title: "Run server",
    description: "Start the development dedicated server headless, capture logs, stop after startup/timeout.",
    milestone: "M2 (build & run)",
    meanwhile: "Run ./gradlew runServer.",
    input: { projectDir, timeoutSec: z.number().int().positive().optional(), acceptEula: z.boolean().optional() },
  },
  {
    name: "analyze_crash",
    title: "Analyze crash",
    description: "Parse a crash report or latest.log: culprit mod, root exception, Mixin failures (InvalidInjectionException, conflicts), missing dependencies, wrong Java.",
    milestone: "M3 (diagnostics)",
    meanwhile: "Paste the crash report; look for the first 'Caused by' and the 'Suspected Mods' section.",
    input: { log: z.string().optional(), path: z.string().optional(), projectDir: projectDir.optional() },
  },
  {
    name: "port_mod",
    title: "Port mod",
    description: "Plan/perform a port of a project to another Minecraft version or loader: update build files via profiles, list API breaks.",
    milestone: "M4 (porting)",
    meanwhile: "Create a fresh project for the target version with create_project and move code over.",
    input: { projectDir, toMcVersion: mc, toLoader: LoaderSchema.optional() },
  },
  {
    name: "docs_search",
    title: "Search docs",
    description: "Search the official Forge, Fabric and NeoForge documentation (version-aware).",
    milestone: "M3 (docs)",
    meanwhile: "Use https://docs.neoforged.net, https://docs.fabricmc.net, https://docs.minecraftforge.net.",
    input: { query: z.string(), loader: LoaderSchema.optional(), mcVersion: mc.optional(), limit: z.number().int().min(1).max(50).optional() },
  },
];

export function notImplementedMessage(s: StubSpec): string {
  return `Tool "${s.name}" is not implemented yet in FFN 0.1 (planned for milestone ${s.milestone}). Meanwhile: ${s.meanwhile}`;
}

export function registerStubs(server: McpServer): void {
  for (const s of STUBS) {
    server.registerTool(
      s.name,
      {
        title: s.title,
        description: `[NOT IMPLEMENTED YET — ${s.milestone}] ${s.description}`,
        inputSchema: s.input,
        annotations: { readOnlyHint: true },
      },
      async () => fail(notImplementedMessage(s)),
    );
  }
}
