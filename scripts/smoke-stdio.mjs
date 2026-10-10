// Spawns dist/index.js over stdio like a real MCP client and calls a few tools.
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL("../dist/index.js", import.meta.url))] });
const client = new Client({ name: "ffn-smoke", version: "0.0.0" });
await client.connect(transport);
const { tools } = await client.listTools();
console.log(`tools (${tools.length}):`, tools.map((t) => t.name).join(", "));
const r = await client.callTool({ name: "list_versions", arguments: { mcVersion: process.argv[2] ?? "1.21.1" } });
console.log(r.content[0].text.split("\n")[0]);
const p = await client.callTool({ name: "get_profile", arguments: { mcVersion: "26.4-snapshot-3", loader: "fabric" } });
console.log(p.content[0].text.split("\n").slice(0, 4).join("\n"));
await client.close();
