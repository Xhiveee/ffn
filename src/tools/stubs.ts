import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ZodRawShape } from "zod";
import { fail } from "./result.js";

interface StubSpec {
  name: string;
  title: string;
  description: string;
  milestone: string;
  meanwhile: string;
  input: ZodRawShape;
}


export const STUBS: StubSpec[] = [];

export function notImplementedMessage(s: StubSpec): string {
  return `Tool "${s.name}" is not implemented yet in FFN 0.4 (planned for milestone ${s.milestone}). Meanwhile: ${s.meanwhile}`;
}

export function registerStubs(server: McpServer): void {
  for (const s of STUBS) {
    server.registerTool(
      s.name,
      {
        title: s.title,
        description: `[NOT IMPLEMENTED YET — ${s.milestone}] ${s.description}`,
        inputSchema: s.input,
        annotations: { readOnlyHint: true },
      },
      async () => fail(notImplementedMessage(s)),
    );
  }
}
