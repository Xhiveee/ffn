#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer, SERVER_VERSION } from "./server.js";
import { loadConfig } from "./config.js";

async function main(): Promise<void> {
  const config = loadConfig();
  // tool implementations and services load on the first tool call; tools/list needs only the schemas
  const server = createServer(async () => (await import("./services.js")).createServices({ config }));
  await server.connect(new StdioServerTransport());
  // stdout carries the MCP protocol; log to stderr only.
  console.error(`FFN MCP server ${SERVER_VERSION} running on stdio (cache: ${config.cacheDir}, user profiles: ${config.userProfilesDir})`);
}

main().catch((err) => {
  console.error("FFN failed to start:", err);
  process.exit(1);
});
