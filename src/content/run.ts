/**
 * Runs content generation for a project: single-loader projects directly, multiloader projects once per loader
 * subproject, moving every file that all loaders generate identically into the shared common/ tree.
 */
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Services } from "../services.js";
import { planContent, type ContentPlan, type GenerateRequest } from "./engine.js";

export interface MultiloaderInfo {
  root: string;
  modId: string;
  package: string;
  mcVersion: string;
  loaders: string[];
  common: string;
  subprojects: Record<string, string>;
}

export async function readMultiloader(dir: string): Promise<MultiloaderInfo | undefined> {
  const f = path.join(dir, ".ffn", "project.json");
  if (!existsSync(f)) return undefined;
  const j = JSON.parse(await readFile(f, "utf8")) as Record<string, unknown>;
  if (j.layout !== "multiloader") return undefined;
  return { root: path.resolve(dir), modId: String(j.modId), package: String(j.package), mcVersion: String(j.mcVersion), loaders: j.loaders as string[], common: String(j.common ?? "common"), subprojects: j.subprojects as Record<string, string> };
}

export interface OutFile {
  path: string;
  action: "create" | "modify";
  content: string | Buffer;
  /** multiloader: "common" or the loader the file belongs to */
  target?: string;
}

export interface GenerateOutcome {
  plans: ContentPlan[];
  files: OutFile[];
  /** Problems that block writing (errors, or mismatches without force). */
  blocked: string[];
  notes: string[];
}

function sameContent(a: string | Buffer, b: string | Buffer): boolean {
  return Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0;
}

function deepMerge(a: unknown, b: unknown): unknown {
  if (Array.isArray(a) && Array.isArray(b)) return [...a, ...b.filter((x) => !a.some((y) => JSON.stringify(y) === JSON.stringify(x)))];
  if (a && b && typeof a === "object" && typeof b === "object" && !Array.isArray(a) && !Array.isArray(b)) {
    const out: Record<string, unknown> = { ...(a as Record<string, unknown>) };
    for (const [k, v] of Object.entries(b as Record<string, unknown>)) out[k] = k in out ? deepMerge(out[k], v) : v;
    return out;
  }
  return b;
}

export async function planGenerate(services: Services, req: GenerateRequest): Promise<GenerateOutcome> {
  const ml = await readMultiloader(req.projectDir);
  const blockedOf = (p: ContentPlan) => [...p.errors, ...(req.force ? [] : p.mismatches.map((m) => `${p.loader}: ${m.reason ?? m.spec}`))];
  if (!ml) {
    const plan = await planContent(services, req);
    return { plans: [plan], files: plan.files, blocked: blockedOf(plan), notes: [] };
  }
  const plans: ContentPlan[] = [];
  for (const l of ml.loaders) plans.push(await planContent(services, { ...req, projectDir: path.join(ml.root, ml.subprojects[l]!) }));
  const blocked = plans.flatMap(blockedOf);
  const rel = (l: string, p: string) => path.relative(path.join(ml.root, ml.subprojects[l]!), p);
  const byRel = new Map<string, { loader: string; f: ContentPlan["files"][number] }[]>();
  plans.forEach((p, i) => {
    for (const f of p.files) {
      const r = rel(ml.loaders[i]!, f.path);
      byRel.set(r, [...(byRel.get(r) ?? []), { loader: ml.loaders[i]!, f }]);
    }
  });
  const files: OutFile[] = [];
  let shared = 0;
  for (const [r, entries] of byRel) {
    const common = entries.length === ml.loaders.length && entries.every((e) => e.f.action === "create" && sameContent(e.f.content, entries[0]!.f.content));
    if (!common) {
      for (const e of entries) files.push({ ...e.f, target: e.loader });
      continue;
    }
    shared++;
    const dest = path.join(ml.root, ml.common, r);
    let content = entries[0]!.f.content;
    let action: "create" | "modify" = "create";
    if (existsSync(dest)) {
      const old = await readFile(dest);
      if (r.endsWith(".json")) {
        content = `${JSON.stringify(deepMerge(JSON.parse(old.toString("utf8")), JSON.parse(content.toString())), null, 2)}\n`;
        action = "modify";
      } else if (sameContent(old, content)) continue;
      else if (!req.force) {
        blocked.push(`${path.relative(ml.root, dest)} already exists in common with different content (pass force=true to overwrite).`);
        continue;
      } else action = "modify";
    }
    files.push({ path: dest, action, content, target: "common" });
  }
  return { plans, files, blocked, notes: [`multiloader: ${shared} file(s) identical for ${ml.loaders.join(" + ")} placed in ${ml.common}/; ${files.filter((f) => f.target !== "common").length} loader-specific.`] };
}

/** Write the planned files. */
export async function writeGenerate(out: GenerateOutcome): Promise<void> {
  for (const f of out.files) {
    await mkdir(path.dirname(f.path), { recursive: true });
    await writeFile(f.path, f.content);
  }
}
