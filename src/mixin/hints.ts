import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import { z } from "zod";
import type { FfnConfig } from "../config.js";

const HintSchema = z.object({
  id: z.string(),
  targets: z.array(z.string()).min(1),
  methods: z.array(z.string()).optional(),
  use: z.string(),
  fabric: z.string().optional(),
  forge: z.string().optional(),
  neoforge: z.string().optional(),
});
export type MixinHint = z.infer<typeof HintSchema>;
const FileSchema = z.object({ hints: z.array(HintSchema) });

async function loadDir(dir: string): Promise<MixinHint[]> {
  if (!existsSync(dir)) return [];
  const out: MixinHint[] = [];
  for (const f of (await readdir(dir)).filter((f) => /\.ya?ml$/.test(f)).sort()) {
    const parsed = FileSchema.safeParse(YAML.parse(await readFile(path.join(dir, f), "utf8")));
    if (!parsed.success) throw new Error(`Invalid hints file ${path.join(dir, f)}: ${parsed.error.issues.map((i) => i.path.join(".") + " " + i.message).join("; ")}`);
    out.push(...parsed.data.hints);
  }
  return out;
}

export async function loadHints(config: FfnConfig): Promise<MixinHint[]> {
  return [...(await loadDir(path.join(config.builtinProfilesDir, "hints"))), ...(await loadDir(path.join(config.userProfilesDir, "hints")))];
}

export const MIXIN_POLICY =
  "Prefer a loader event/API or a data-driven mechanism (tags, datapacks, loot modifiers) when one covers the use case: they survive Minecraft updates and compose with other mods. If a mixin is needed, prefer composable injectors (@Inject, MixinExtras @WrapOperation/@ModifyExpressionValue/@ModifyReturnValue) over @Redirect and @Overwrite, keep handlers small, and target stable methods.";

/** Hints whose target class (and method, when given) match. */
export function matchHints(hints: MixinHint[], targetClass: string, method: string | undefined, loader?: string) {
  const dotted = targetClass.replace(/\//g, ".").replace(/\$/g, ".");
  return hints
    .filter((h) => h.targets.some((t) => dotted === t || dotted.endsWith(`.${t}`)))
    .filter((h) => !method || !h.methods || h.methods.some((m) => new RegExp(m).test(method)))
    .map((h) => ({ id: h.id, use: h.use, ...(loader ? { [loader]: (h as Record<string, unknown>)[loader] } : { fabric: h.fabric, forge: h.forge, neoforge: h.neoforge }) }));
}
