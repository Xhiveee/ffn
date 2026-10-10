import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Services } from "./services.js";
import { registerCreateProject } from "./tools/createProject.js";
import { registerGradleTools } from "./tools/gradle.js";
import { registerSourceTools } from "./tools/source.js";
import { registerMixinTools } from "./tools/mixin.js";
import { registerCrashTools } from "./tools/crash.js";
import { registerGetProfile } from "./tools/getProfile.js";
import { registerListVersions } from "./tools/listVersions.js";
import { registerGenerateTools } from "./tools/generate.js";
import { registerDocsTools } from "./tools/docs.js";
import { registerCheckProfiles } from "./tools/checkProfiles.js";

export const SERVER_NAME = "ffn";
export const SERVER_VERSION = "0.4.0";

const INSTRUCTIONS = `FFN (ForgeFabricNeoForge) helps you build Minecraft mods for Forge, Fabric and NeoForge (Minecraft 1.20.1 → latest).
- Never guess versions: call list_versions (live data) and get_profile before writing build files.
- create_project generates a buildable project; build it with gradle_build (FFN picks the JDK and parses errors).
- Prefer loader events/APIs over mixins: mixin_targets lists event hints first. When a mixin is needed,
  look up real signatures (get_class / mixin_targets), write it with mixin_generate and check it with mixin_validate.
- Use translate_mapping instead of guessing names across Mojmap/Yarn/Intermediary/SRG.
- run_client mode=smoke proves the mod loads; analyze_crash explains crashes and names the culprit mod.
- run_server needs acceptEula=true. Only pass it after the user has personally agreed to the Minecraft EULA
  (https://aka.ms/MinecraftEULA); never accept it on their behalf.
- Warnings marked UNVERIFIED mean the version is newer than FFN's tested profiles: build and verify.`;

/** Build the MCP server with all tools registered. Add new tools here. */
export function createServer(services: Services): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION }, { instructions: INSTRUCTIONS });
  registerListVersions(server, services);
  registerGetProfile(server, services);
  registerCreateProject(server, services);
  registerGradleTools(server, services);
  registerSourceTools(server, services);
  registerMixinTools(server, services);
  registerCrashTools(server, services);
  registerGenerateTools(server, services);
  registerDocsTools(server, services);
  registerCheckProfiles(server, services);
  return server;
}
