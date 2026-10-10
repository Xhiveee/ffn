/**
 * Tool registry: schemas + descriptions are registered eagerly (cheap), implementations are imported on
 * the first call of each tool, so startup only loads the MCP SDK and zod.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { Services } from "../services.js";
import * as S from "./schemas.js";
import { guard } from "./result.js";

type Impl = (services: Services, args: never) => Promise<CallToolResult>;
interface ToolDef {
  name: string;
  title: string;
  description: string;
  input: Record<string, unknown>;
  readOnly?: boolean;
  openWorld?: boolean;
  load: () => Promise<Impl>;
}

export const TOOLS: ToolDef[] = [
  {
    name: "list_versions",
    title: "List versions",
    description: "Live Minecraft versions with Forge/Fabric/NeoForge availability; with mcVersion: loader versions, Java, Gradle plugin per loader.",
    input: S.listVersionsInput,
    load: async () => (await import("./listVersions.js")).listVersions as Impl,
  },
  {
    name: "get_profile",
    title: "Version profile",
    description: "Build facts for (mcVersion, loader): Java, Gradle plugin, metadata file, mappings, Mixin rules (registration, refmap, compat level, MixinExtras), pack format. Untested versions are flagged.",
    input: S.getProfileInput,
    load: async () => (await import("./getProfile.js")).getProfile as Impl,
  },
  {
    name: "gradle_build",
    title: "Gradle build",
    description: "Run Gradle tasks with an auto-picked JDK; returns parsed errors (file:line), Mixin AP warnings, dependency and JVM problems. Log kept on disk.",
    input: S.gradleBuildInput,
    readOnly: false,
    load: async () => (await import("./gradle.js")).gradleBuild as Impl,
  },
  {
    name: "search_mc_source",
    title: "Search Minecraft code",
    description: "Search Minecraft classes/methods/fields (exact version and names), grep source text, find usages (callers, field access, class references) or callees from bytecode, browse packages. Paged one-line results.",
    input: S.searchInput,
    load: async () => (await import("./source.js")).searchMcSource as Impl,
  },
  {
    name: "get_class",
    title: "Get Minecraft class",
    description: "A Minecraft class: outline (default; name(desc) = mixin selector), one method's source (method=), hierarchy/overrides (detail=hierarchy) or paged full source. Outline first, then method.",
    input: S.getClassInput,
    load: async () => (await import("./source.js")).getClass as Impl,
  },
  {
    name: "translate_mapping",
    title: "Translate names",
    description: "Translate class/method/field names between obf, Mojang, Intermediary, Yarn and SRG for a Minecraft version.",
    input: S.translateInput,
    load: async () => (await import("./source.js")).translateMapping as Impl,
  },
  {
    name: "mixin_targets",
    title: "Mixin targets",
    description: "Methods of a class as ready selectors plus injection points inside them (INVOKE/FIELD/NEW/CONSTANT from bytecode); suggests loader events that cover the need.",
    input: S.mixinTargetsInput,
    load: async () => (await import("./mixin.js")).mixinTargets as Impl,
  },
  {
    name: "mixin_validate",
    title: "Validate mixins",
    description: "Static mixin check against the real classes: configs and registration, targets, selectors, @At targets, handler signatures, @Local/@ModifyVariable (LVT), accessors/shadows, client-only targets.",
    input: S.mixinValidateInput,
    load: async () => (await import("./mixin.js")).mixinValidate as Impl,
  },
  {
    name: "analyze_crash",
    title: "Analyze crash",
    description: "Explain a crash report, log or Gradle output: root cause, culprit mod, Mixin failures, missing dependencies, wrong Java; with fixes.",
    input: S.analyzeCrashInput,
    openWorld: false,
    load: async () => (await import("./crash.js")).analyzeCrash as Impl,
  },
  {
    name: "docs_search",
    title: "Search docs",
    description: "Search Fabric/Forge/NeoForge docs for the right Minecraft version, NeoForged porting primers, Fabric announcements and Mixin docs (topic=mixin). Snippets, code and checked URLs.",
    input: S.docsSearchInput,
    load: async () => (await import("./docs.js")).docsSearch as Impl,
  },
  {
    name: "check_profiles",
    title: "Check profiles",
    description: "Compare FFN's version profiles with upstream MDKs/example mods, Gradle and new Minecraft releases; reports drift and suggests user-profile YAML. Read-only.",
    input: S.checkProfilesInput,
    load: async () => (await import("./checkProfiles.js")).checkProfiles as Impl,
  },
];

export function registerTools(server: McpServer, getServices: () => Services | Promise<Services>): void {
  for (const t of TOOLS) {
    server.registerTool(
      t.name,
      { title: t.title, description: t.description, inputSchema: t.input as never, annotations: { readOnlyHint: t.readOnly ?? true, openWorldHint: t.openWorld ?? true } },
      (async (args: never) => guard(async () => (await t.load())(await getServices(), args))) as never,
    );
  }
}
