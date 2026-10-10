// Usage: node scripts/measure-tokens.mjs '<json array of [tool, args, label]>'
// Prints approximate token counts (chars/4) of each tool result: text content, plus structuredContent if present.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../dist/server.js";
import { createServices } from "../dist/services.js";

const cases = JSON.parse(process.argv[2] ?? "[]");
const server = createServer(createServices());
const [a, b] = InMemoryTransport.createLinkedPair();
await server.connect(a);
const client = new Client({ name: "measure", version: "0" });
await client.connect(b);
for (const [tool, args, label] of cases) {
  const res = await client.callTool({ name: tool, arguments: args }, undefined, { timeout: 7_200_000 });
  const text = res.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
  const sc = res.structuredContent ? JSON.stringify(res.structuredContent).length : 0;
  const t = Math.round(text.length / 4), s = Math.round(sc / 4);
  console.log(`${label ?? tool}\ttext≈${t} tok\tstructured≈${s} tok\ttotal≈${t + s} tok${res.isError ? "\t[isError]" : ""}`);
}
process.exit(0);
