#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer, SERVER_VERSION } from "./server.js";
import { createServices } from "./services.js";

async function main(): Promise<void> {
  const services = createServices();
  const server = createServer(services);
  await server.connect(new StdioServerTransport());
  // stdout carries the MCP protocol; log to stderr only.
  console.error(`FFN MCP server ${SERVER_VERSION} running on stdio (cache: ${services.config.cacheDir}, user profiles: ${services.config.userProfilesDir})`);
}

main().catch((err) => {
  console.error("FFN failed to start:", err);
  process.exit(1);
});
