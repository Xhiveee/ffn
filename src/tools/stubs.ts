import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z, type ZodRawShape } from "zod";
import { LoaderSchema, MappingsSchema } from "../profiles/schema.js";
import { fail } from "./result.js";

interface StubSpec {
  name: string;
  title: string;
  description: string;
  milestone: string;
  meanwhile: string;
  input: ZodRawShape;
}

const mc = z.string().describe("Minecraft version");
const projectDir = z.string().describe("Path to a mod project (e.g. one created by create_project)");
const anyMappings = z.enum(["mojmap", "parchment", "yarn", "intermediary", "srg", "obf"]);

export const STUBS: StubSpec[] = [
  {
    name: "generate",
    title: "Generate content",
    description: "Generate version-correct boilerplate in a project: blocks, items, entities, block entities, recipes, datapack files, event listeners, commands, configs, creative tabs, network payloads.",
    milestone: "M3 (content generators)",
    meanwhile: "Follow the loader docs for the project's Minecraft version (see get_profile → references).",
    input: {
      projectDir,
      kind: z.enum(["block", "item", "entity", "block_entity", "recipe", "datapack", "event_listener", "command", "config", "creative_tab", "network_payload"]),
      name: z.string(),
      options: z.record(z.string(), z.unknown()).optional(),
    },
  },
  {
    name: "mixin_port",
    title: "Port mixins",
    description: "When porting between versions, find mixins whose target disappeared or changed and propose new targets.",
    milestone: "M4 (porting)",
    meanwhile: "Port manually using the target version's sources.",
    input: { projectDir, fromMcVersion: mc, toMcVersion: mc },
  },
  {
    name: "port_mod",
    title: "Port mod",
    description: "Plan/perform a port of a project to another Minecraft version or loader: update build files via profiles, list API breaks.",
    milestone: "M4 (porting)",
    meanwhile: "Create a fresh project for the target version with create_project and move code over.",
    input: { projectDir, toMcVersion: mc, toLoader: LoaderSchema.optional() },
  },
  {
    name: "docs_search",
    title: "Search docs",
    description: "Search the official Forge, Fabric and NeoForge documentation (version-aware).",
    milestone: "M3 (docs)",
    meanwhile: "Use https://docs.neoforged.net, https://docs.fabricmc.net, https://docs.minecraftforge.net.",
    input: { query: z.string(), loader: LoaderSchema.optional(), mcVersion: mc.optional(), limit: z.number().int().min(1).max(50).optional() },
  },
];

export function notImplementedMessage(s: StubSpec): string {
  return `Tool "${s.name}" is not implemented yet in FFN 0.1 (planned for milestone ${s.milestone}). Meanwhile: ${s.meanwhile}`;
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
