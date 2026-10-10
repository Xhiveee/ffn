import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import path from "node:path";
import { z } from "zod";
import { GenerateError } from "../content/engine.js";
import { planGenerate, writeGenerate } from "../content/run.js";
import type { Services } from "../services.js";
import { fail, guard, ok } from "./result.js";

export const CONTENT_KINDS = ["block", "item", "block_entity", "entity", "recipe", "loot_table", "tag", "creative_tab", "event_handler", "networking", "config", "datagen"] as const;

export const generateInput = {
  projectDir: z.string().describe("Mod project directory (created by create_project or any Gradle mod project)"),
  kind: z.string().describe(`What to generate: ${CONTENT_KINDS.join(", ")} (user catalogs may add more)`),
  name: z.string().optional().describe("Registry path / file name in snake_case, e.g. ruby_block (not needed for config/datagen)"),
  displayName: z.string().optional().describe("English name for en_us.json (default: from name)"),
  params: z
    .record(z.string(), z.unknown())
    .optional()
    .describe(
      [
        "Kind-specific options:",
        "block: strength, lightLevel, color (#rrggbb texture), tab (creative tab name), noDrop",
        "item: stackSize, color, tab",
        "block_entity: color, tab",
        "entity: width, height, category (CREATURE, MONSTER, …), health, speed",
        "recipe: type (shaped|shapeless|smelting|blasting|smoking|campfire_cooking), result, count, pattern [rows], key {char: item|#tag}, ingredients [..], ingredient, experience, cookingTime",
        "loot_table: lootType (block|entity), drop",
        "tag: registry (block|item|entity_type|fluid), tag (id, may be minecraft:...), values [ids or #tags], replace",
        "creative_tab: icon, items [ids]",
        "event_handler: event (server_tick, server_started, player_join, block_break, register_commands)",
        "networking: direction (to_server|to_client|both), fields [{name, type: int|long|float|double|bool|string|blockpos}] (max 6)",
        "config: configType (common|client|server), entries [{name, type: int|long|double|bool|string, default, comment, min, max}]",
      ].join("\n"),
    ),
  dryRun: z.boolean().optional().describe("Only show the planned files and checks"),
  force: z.boolean().optional().describe("Write even if symbol checks fail / overwrite existing files"),
};

export function registerGenerateTools(server: McpServer, services: Services): void {
  server.registerTool(
    "generate",
    {
      title: "Generate content",
      description:
        "Generate version-correct content in a mod project for its loader and Minecraft version: blocks (with block items, blockstates, models, textures, loot, lang), items, block entities, entities (attributes + renderer registration), recipes, loot tables, tags, creative tabs, event handlers, networking payloads, config and data generation setup. Templates come from declarative catalogs (profiles/content/*.yaml); the API variant is chosen by probing the project's real compile classpath, and every referenced class/method is verified before writing (mismatches are reported and block the write unless force=true).",
      inputSchema: generateInput,
    },
    (a) =>
      guard(async () => {
        const req = { projectDir: a.projectDir, kind: a.kind, name: a.name, displayName: a.displayName, params: a.params, force: a.force };
        let out;
        try {
          out = await planGenerate(services, req);
        } catch (e) {
          if (e instanceof GenerateError) return fail(e.message);
          throw e;
        }
        const plan = out.plans[0]!;
        const files = out.files.map((f) => ({
          path: path.relative(a.projectDir, f.path),
          action: f.action,
          ...(a.dryRun && typeof f.content === "string" ? { content: f.content } : {}),
        }));
        const uniq = (xs: string[]) => [...new Set(xs)];
        const mismatches = uniq(out.plans.flatMap((p) => p.mismatches.map((m) => `${out.plans.length > 1 ? `${p.loader}: ` : ""}${m.reason ?? m.spec}`)));
        const errors = uniq(out.plans.flatMap((p) => p.errors));
        const warnings = uniq(out.plans.flatMap((p) => p.warnings));
        const notes = uniq([...out.notes, ...out.plans.flatMap((p) => p.notes)]);
        const data = {
          kind: plan.kind,
          loader: out.plans.map((p) => p.loader).join(" + "),
          mcVersion: plan.mcVersion,
          ...(plan.catalogLoader !== plan.loader ? { templates: plan.catalogLoader } : {}),
          files,
          verified: out.plans.map((p) => `${p.loader}: ${p.checks.filter((c) => c.ok).length}/${p.checks.length}`).join(", ") + " referenced classes/members found on the project classpath",
          ...(mismatches.length ? { mismatches } : {}),
          ...(errors.length ? { errors } : {}),
          ...(warnings.length ? { warnings } : {}),
          ...(notes.length ? { notes } : {}),
          probes: Object.fromEntries(Object.entries(plan.probes).filter(([, v]) => v)),
        };
        if (errors.length) return fail(`Not written: ${errors.length} problem(s).\n\n\`\`\`json\n${JSON.stringify(data, null, 2)}\n\`\`\``);
        if (out.blocked.length && !a.force)
          return fail(`Not written: ${out.blocked.length} problem(s) (referenced symbols missing in the target or file conflicts). Fix the catalog/profile or pass force=true.\n\n\`\`\`json\n${JSON.stringify({ ...data, blocked: out.blocked }, null, 2)}\n\`\`\``);
        if (a.dryRun) return ok(`Dry run: ${files.length} file(s) would change.`, data);
        await writeGenerate(out);
        return ok(`Generated ${plan.kind}${a.name ? ` "${a.name}"` : ""} for ${data.loader} ${plan.mcVersion}: ${files.length} file(s) written. Build with gradle_build to compile-check.`, data);
      }),
  );
}
