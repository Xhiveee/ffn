import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Services } from "./services.js";
import { registerCreateProject } from "./tools/createProject.js";
import { registerGetProfile } from "./tools/getProfile.js";
import { registerListVersions } from "./tools/listVersions.js";
import { registerStubs } from "./tools/stubs.js";

export const SERVER_NAME = "ffn";
export const SERVER_VERSION = "0.1.0";

const INSTRUCTIONS = `FFN (ForgeFabricNeoForge) helps you build Minecraft mods for Forge, Fabric and NeoForge (Minecraft 1.20.1 → latest).
- Never guess versions: call list_versions (live data) and get_profile before writing build files.
- create_project generates a buildable project; then run ./gradlew build.
- Prefer loader events/APIs over mixins; when a mixin is needed, check targets for the exact version.
- Warnings marked UNVERIFIED mean the version is newer than FFN's tested profiles: build and verify.`;

/** Build the MCP server with all tools registered. Add new tools here. */
export function createServer(services: Services): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION }, { instructions: INSTRUCTIONS });
  registerListVersions(server, services);
  registerGetProfile(server, services);
  registerCreateProject(server, services);
  registerStubs(server);
  return server;
}
