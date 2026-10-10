// Measures: process start → tools/list answered (ms), RSS after list, tools/list + instructions size (≈tokens = chars/4).
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";

const runs = Number(process.argv[2] ?? 5);
const times = [];
let last;
for (let i = 0; i < runs; i++) {
  const t0 = performance.now();
  const transport = new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL("../dist/index.js", import.meta.url))], stderr: "ignore" });
  const client = new Client({ name: "ffn-measure", version: "0" });
  await client.connect(transport);
  const list = await client.listTools();
  times.push(performance.now() - t0);
  const pid = transport.pid;
  let rssKb;
  try {
    const { readFileSync } = await import("node:fs");
    rssKb = Number(/VmRSS:\s+(\d+)/.exec(readFileSync(`/proc/${pid}/status`, "utf8"))[1]);
  } catch {}
  last = { list, instructions: client.getInstructions() ?? "", rssKb };
  await client.close();
}
const toolsJson = JSON.stringify(last.list.tools);
times.sort((a, b) => a - b);
console.log(JSON.stringify({
  tools: last.list.tools.length,
  startupMsMedian: Math.round(times[Math.floor(times.length / 2)]),
  rssMb: last.rssKb ? Math.round(last.rssKb / 1024) : undefined,
  toolsListTokens: Math.round(toolsJson.length / 4),
  instructionsTokens: Math.round(last.instructions.length / 4),
  perTool: Object.fromEntries(last.list.tools.map((t) => [t.name, Math.round(JSON.stringify(t).length / 4)])),
}, null, 1));
