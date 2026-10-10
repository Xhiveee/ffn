import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Services } from "./services.js";
import { registerGradleTools } from "./tools/gradle.js";
import { registerSourceTools } from "./tools/source.js";
import { registerMixinTools } from "./tools/mixin.js";
import { registerCrashTools } from "./tools/crash.js";
import { registerGetProfile } from "./tools/getProfile.js";
import { registerListVersions } from "./tools/listVersions.js";
import { registerDocsTools } from "./tools/docs.js";
import { registerCheckProfiles } from "./tools/checkProfiles.js";

export const SERVER_NAME = "ffn";
export const SERVER_VERSION = "0.7.0";

const INSTRUCTIONS = `FFN (ForgeFabricNeoForge) gives you the real Minecraft and loader classes, mappings, docs and build tooling for Forge, Fabric and NeoForge (Minecraft 1.20.1 → latest).
- Never guess versions: call list_versions (live data) and get_profile before writing build files.
- Save tokens: read classes outline-first. get_class (default outline: signatures only) → get_class method="<name>" for one
  method's source → detail="full" (paged) only when really needed. search_mc_source and mixin_targets are paged; pass
  methodFilter to mixin_targets to get injection points for just the method you need.
- Prefer loader events/APIs over mixins: mixin_targets prints event hints first. When a mixin is needed, take selectors
  from get_class / mixin_targets (name(descriptor) is the selector) and check your mixin with mixin_validate.
- Use translate_mapping instead of guessing names across Mojmap/Yarn/Intermediary/SRG; docs_search for loader docs and version primers.
- For Mixin questions (injectors, @At, MixinExtras like @WrapOperation, cancellable @Inject) use docs_search topic="mixin":
  Mixin wiki, MixinExtras wiki and Fabric's mixin pages (not tied to a Minecraft version).
- Works on any existing mod project (e.g. an official MDK): loader and Minecraft version are read from its build files.
  Build with gradle_build (FFN picks the JDK and parses errors).
- analyze_crash explains a crash report or log (from running the game yourself) and names the culprit mod.
- Warnings marked UNVERIFIED mean the version is newer than FFN's tested profiles: build and verify.`;

/** Build the MCP server with all tools registered. Add new tools here. */
export function createServer(services: Services): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION }, { instructions: INSTRUCTIONS });
  registerListVersions(server, services);
  registerGetProfile(server, services);
  registerGradleTools(server, services);
  registerSourceTools(server, services);
  registerMixinTools(server, services);
  registerCrashTools(server, services);
  registerDocsTools(server, services);
  registerCheckProfiles(server, services);
  return server;
}
