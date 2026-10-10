// Usage: node scripts/call-tool.mjs <tool> '<json args>'  — calls a tool in-process over an in-memory MCP transport.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../dist/server.js";
import { createServices } from "../dist/services.js";

const [tool, json = "{}"] = process.argv.slice(2);
const server = createServer(createServices());
const [a, b] = InMemoryTransport.createLinkedPair();
await server.connect(a);
const client = new Client({ name: "cli", version: "0" });
await client.connect(b);
const res = await client.callTool({ name: tool, arguments: JSON.parse(json) }, undefined, { timeout: 7_200_000 });
for (const c of res.content) if (c.type === "text") console.log(c.text);
console.log(res.isError ? "\n[isError]" : "\n[ok]");
process.exit(0);
