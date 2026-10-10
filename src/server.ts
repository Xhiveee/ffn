import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Services } from "./services.js";
import { registerTools } from "./tools/registry.js";

export const SERVER_NAME = "ffn";
export const SERVER_VERSION = "0.9.0";

const INSTRUCTIONS = `FFN: real Minecraft/loader classes, mappings, docs and build tooling for Forge, Fabric, NeoForge (1.20.1+).
- Don't guess versions: list_versions, get_profile.
- Read code cheaply: search_mc_source → get_class outline → get_class method=. Usages: search_mc_source kind=usages; hierarchy/overrides: get_class detail=hierarchy.
- Loader-patched classes: projectDir (your project), or source=loader + loader (cached official MDK).
- Prefer loader events over mixins; take selectors from get_class/mixin_targets, then mixin_validate.
- translate_mapping across Mojmap/Yarn/Intermediary/SRG; docs_search for docs/primers (topic=mixin for Mixin/MixinExtras).
- Works on any project incl. multi-loader builds; gradle_build picks the JDK; analyze_crash explains crashes.
- UNVERIFIED = newer than tested profiles: build to confirm.`;

/** Build the MCP server. Services may be passed lazily (created on the first tool call). */
export function createServer(services: Services | (() => Services | Promise<Services>)): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION }, { instructions: INSTRUCTIONS });
  let cached: Promise<Services> | undefined;
  registerTools(server, typeof services === "function" ? () => (cached ??= Promise.resolve(services())) : () => services);
  return server;
}
