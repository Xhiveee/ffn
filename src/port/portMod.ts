/**
 * port_mod: port a project to another Minecraft version and/or loader into a NEW directory (the source is never
 * modified). Dry run by default.
 *
 *  1. plan a fresh target skeleton with create_project's planner (same mod id / package / main class), so build
 *     files, metadata and the Gradle wrapper come from the target profile;
 *  2. copy user code and resources (FFN-generated files and the old main class are left out; data pack folders are
 *     renamed per the content catalog rules; mixin config lists are merged);
 *  3. replay the content requests recorded in .ffn/content.json on the target (templates for the target API);
 *  4. run mixin_port with apply on the target copy (high-confidence renames only);
 *  5. optionally compile and map compile errors to target classes and docs/primer hits.
 */
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadCatalog, resolveSettings } from "../content/catalog.js";
import { GenerateError } from "../content/engine.js";
import { planGenerate, readContentLog, readMultiloader, writeGenerate, type RecordedRequest } from "../content/run.js";
import { planProject, writeProject } from "../generator/index.js";
import type { FileContent, ProjectParams } from "../generator/types.js";
import { parseProperties, readProjectInfo } from "../project/info.js";
import type { Loader } from "../profiles/schema.js";
import type { Services } from "../services.js";
import { docsSearch } from "../tools/docs.js";
import { runGradle } from "../tools/gradle.js";
import { portMixins, type MixinPortResult } from "./mixinPort.js";

export class PortError extends Error {}

export interface PortOptions {
  projectDir: string;
  targetDir: string;
  toMcVersion?: string;
  toLoader?: Loader;
  dryRun?: boolean;
  compile?: boolean;
  docs?: boolean;
}

interface PlannedEntry {
  rel: string;
  origin: "skeleton" | "copied" | "renamed" | "merged" | "saved";
  from?: string;
  content: FileContent | Buffer;
}

async function walk(dir: string, out: string[] = []): Promise<string[]> {
  if (!existsSync(dir)) return out;
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) await walk(p, out);
    else out.push(p);
  }
  return out;
}

const METADATA = /^(fabric\.mod\.json|META-INF\/(mods|neoforge\.mods)\.toml|pack\.mcmeta|quilt\.mod\.json)$/;

async function sourceParams(dir: string, loader: string, mc: string): Promise<Omit<ProjectParams, "loader" | "mcVersion">> {
  const f = path.join(dir, ".ffn", "project.json");
  const props = parseProperties(existsSync(path.join(dir, "gradle.properties")) ? await readFile(path.join(dir, "gradle.properties"), "utf8") : "");
  const j = existsSync(f) ? (JSON.parse(await readFile(f, "utf8")) as Record<string, string>) : {};
  const modId = j.modId ?? props.mod_id ?? props.archives_base_name;
  const pkg = j.package ?? props.mod_group_id ?? props.maven_group;
  if (!modId || !pkg) throw new PortError(`Cannot determine the mod id / package of ${dir} (${loader} ${mc}); port_mod needs .ffn/project.json or mod_id + mod_group_id/maven_group in gradle.properties.`);
  let mainClass = j.mainClass;
  if (!mainClass) {
    const java = (await walk(path.join(dir, "src", "main", "java"))).filter((p) => p.endsWith(".java"));
    for (const p of java) {
      const t = await readFile(p, "utf8");
      if (/implements\s+ModInitializer\b|@Mod\s*\(/.test(t)) {
        mainClass = path.basename(p, ".java");
        break;
      }
    }
  }
  return {
    modId,
    modName: j.modName ?? props.mod_name ?? modId,
    package: pkg,
    author: j.author ?? props.mod_authors ?? "Unknown",
    version: j.version ?? props.mod_version ?? "1.0.0",
    description: j.description ?? props.mod_description,
    license: j.license ?? props.mod_license,
    mainClass,
  };
}

export interface PortReport {
  source: { dir: string; loader: string; mcVersion: string };
  target: { dir: string; loader: string; mcVersion: string };
  dryRun: boolean;
  files: { path: string; origin: string; from?: string }[];
  dataRenames: string[];
  replay: { kind: string; name?: string; status: string; detail?: string[] }[];
  mixins?: Pick<MixinPortResult, "broken" | "applied" | "remaining" | "otherErrors" | "notes">;
  compile?: { status: string; errors: number; breakages: { symbol: string; files: string[]; candidates: string[]; docs: { title: string; url: string }[] }[]; logFile?: string };
  manual: string[];
  warnings: string[];
}

export async function portMod(services: Services, o: PortOptions): Promise<PortReport> {
  const srcDir = path.resolve(o.projectDir);
  const tgtDir = path.resolve(o.targetDir);
  if (await readMultiloader(srcDir)) throw new PortError("Porting multiloader projects is not supported yet: port each loader subproject, or create a new multiloader project and copy common/.");
  if (tgtDir === srcDir || tgtDir.startsWith(srcDir + path.sep) || srcDir.startsWith(tgtDir + path.sep)) throw new PortError("targetDir must be a new directory outside the source project (port_mod never overwrites the source).");
  const dryRun = o.dryRun !== false;
  if (existsSync(tgtDir) && (await readdir(tgtDir)).length) throw new PortError(`targetDir ${tgtDir} is not empty.`);
  const src = await readProjectInfo(srcDir);
  const toMc = o.toMcVersion ?? src.mcVersion;
  const toLoader = (o.toLoader ?? src.loader) as Loader;
  if (toMc === src.mcVersion && toLoader === src.loader) throw new PortError("Nothing to port: target version and loader equal the source.");
  const warnings: string[] = [];
  const manual: string[] = [];
  const sp = await sourceParams(srcDir, src.loader, src.mcVersion);

  const toObf = (await services.versions.mojangVersion(toMc))?.obfuscated;
  const fromObf = (await services.versions.mojangVersion(src.mcVersion))?.obfuscated;
  let mappings = src.mappings;
  if (mappings === "yarn" && (toLoader !== "fabric" || toObf === false)) {
    mappings = "mojmap";
    warnings.push("The source uses Yarn names; the target uses Mojang mappings. FFN does not remap Java source: run Loom's migrateMappings on the source first, or expect many compile errors.");
  }
  const plan = await planProject(services, { ...sp, loader: toLoader, mcVersion: toMc, mappings });
  warnings.push(...plan.warnings);
  const { params } = plan.context;
  const pkgPath = params.package.replace(/\./g, "/");
  const entries = new Map<string, PlannedEntry>();
  for (const [rel, content] of plan.files) entries.set(rel, { rel, origin: "skeleton", content });

  // FFN-generated files (replayed instead of copied)
  const log = await readContentLog(srcDir);
  const generated = new Set(log.flatMap((r) => r.created));
  const mainRel = sp.mainClass ? `src/main/java/${sp.package.replace(/\./g, "/")}/${sp.mainClass}.java` : undefined;

  // data pack folder renames from the content catalog rules
  const rules = (await loadCatalog(services.config, toLoader)).rules;
  const sSet = resolveSettings((await loadCatalog(services.config, src.loader)).rules, src.mcVersion, fromObf);
  const tSet = resolveSettings(rules, toMc, toObf);
  const renames: [string, string][] = [];
  for (const key of ["dataDirs", "tagDirs"] as const) {
    const a = (sSet[key] ?? {}) as Record<string, string>;
    const b = (tSet[key] ?? {}) as Record<string, string>;
    for (const k of Object.keys(a)) if (b[k] && a[k] !== b[k]) renames.push([a[k]!, b[k]!]);
  }
  const formatChanged = ["recipeResult", "cookingResult", "ingredientStyle", "itemModelDefinitions"].filter((k) => JSON.stringify(sSet[k]) !== JSON.stringify(tSet[k]));
  const dataRenames: string[] = [];
  const userRecipes: string[] = [];

  // user Java + resources
  const mixinCfgName = `${sp.modId}.mixins.json`;
  for (const root of ["src/main/java", "src/main/resources", "src/client/java", "src/client/resources"]) {
    for (const abs of await walk(path.join(srcDir, root))) {
      let rel = path.relative(srcDir, abs).replace(/\\/g, "/");
      if (generated.has(rel)) continue;
      if (rel === mainRel) {
        entries.set(`.ffn/port/${path.basename(rel)}.orig`, { rel: `.ffn/port/${path.basename(rel)}.orig`, origin: "saved", from: rel, content: await readFile(abs) });
        manual.push(`The main class was regenerated for ${toLoader} ${toMc}; the old one is saved as .ffn/port/${path.basename(rel)}.orig — merge any custom code by hand.`);
        continue;
      }
      if (rel.endsWith("/mixin/ExampleMixin.java") && entries.has(rel)) continue; // FFN example: the target version's is used
      const inRes = rel.slice(root.length + 1);
      if (root.endsWith("resources") && METADATA.test(inRes)) continue;
      if (root.endsWith("resources") && inRes === mixinCfgName) {
        const tgtRel = `src/main/resources/${mixinCfgName}`;
        const t = entries.get(tgtRel);
        const srcJson = JSON.parse(await readFile(abs, "utf8")) as Record<string, unknown>;
        if (t && typeof t.content === "string") {
          const tj = JSON.parse(t.content) as Record<string, unknown>;
          for (const s of ["mixins", "client", "server"]) {
            const merged = [...new Set([...((tj[s] as string[]) ?? []), ...((srcJson[s] as string[]) ?? [])])];
            if (merged.length) tj[s] = merged;
          }
          entries.set(tgtRel, { rel: tgtRel, origin: "merged", from: rel, content: `${JSON.stringify(tj, null, 2)}\n` });
        }
        continue;
      }
      if (root.endsWith("resources")) {
        const m = /^data\/([^/]+)\/(.+)$/.exec(inRes);
        if (m) {
          for (const [a, b] of renames) {
            if (m[2]!.startsWith(`${a}/`)) {
              const nrel = `${root}/data/${m[1]}/${b}/${m[2]!.slice(a.length + 1)}`;
              dataRenames.push(`${rel} → ${nrel}`);
              rel = nrel;
              break;
            }
          }
          if (/\/recipes?\//.test(rel)) userRecipes.push(rel);
        }
      }
      const prev = entries.get(rel);
      entries.set(rel, { rel, origin: rel !== path.relative(srcDir, abs) ? "renamed" : "copied", from: path.relative(srcDir, abs), content: await readFile(abs) });
      if (prev?.origin === "skeleton" && rel.endsWith(".json") && rel.includes("/lang/")) {
        // keep both: source keys win
        const merged = { ...JSON.parse(String(prev.content)), ...JSON.parse((await readFile(abs, "utf8")) || "{}") };
        entries.set(rel, { rel, origin: "merged", from: path.relative(srcDir, abs), content: `${JSON.stringify(merged, null, 2)}\n` });
      }
    }
  }
  if (userRecipes.length && formatChanged.length) manual.push(`Recipe/item JSON format changed (${formatChanged.join(", ")}) between ${src.mcVersion} and ${toMc}; these hand-written files were copied unchanged and may need updating: ${userRecipes.join(", ")}.`);
  if (toLoader !== src.loader) manual.push(`Loader change ${src.loader} → ${toLoader}: hand-written code that uses ${src.loader} APIs must be rewritten (see compile breakages and docs_search).`);
  if (existsSync(path.join(srcDir, "src/main/templates")) && toLoader === src.loader) manual.push("src/main/templates was not copied (the target skeleton provides its own metadata templates).");

  const report: PortReport = {
    source: { dir: srcDir, loader: src.loader, mcVersion: src.mcVersion },
    target: { dir: tgtDir, loader: toLoader, mcVersion: toMc },
    dryRun,
    files: [...entries.values()].sort((a, b) => a.rel.localeCompare(b.rel)).map((e) => ({ path: e.rel, origin: e.origin, ...(e.from && e.from !== e.rel ? { from: e.from } : {}) })),
    dataRenames,
    replay: log.map((r) => ({ kind: r.kind, ...(r.name ? { name: r.name } : {}), status: dryRun ? "planned" : "pending" })),
    manual,
    warnings,
  };
  if (!log.length && existsSync(path.join(srcDir, ".ffn", "project.json"))) warnings.push("No .ffn/content.json in the source: generated content (if any) is copied as plain files and is not re-templated for the target. Content generated with FFN ≥ 0.4 is recorded automatically.");

  if (dryRun) {
    try {
      const mp = await portMixins(services, { projectDir: srcDir, toVersion: toMc, toLoader, apply: false });
      report.mixins = { broken: mp.broken, applied: [], otherErrors: mp.otherErrors, notes: mp.notes };
    } catch (e) {
      warnings.push(`Mixin analysis failed: ${(e as Error).message}`);
    }
    return report;
  }

  // ---- write
  const files = new Map<string, FileContent>();
  const bufs = new Map<string, Buffer>();
  for (const e of entries.values()) {
    if (Buffer.isBuffer(e.content)) bufs.set(e.rel, e.content);
    else files.set(e.rel, e.content);
  }
  await writeProject({ ...plan, files }, tgtDir);
  for (const [rel, b] of bufs) {
    await mkdir(path.dirname(path.join(tgtDir, rel)), { recursive: true });
    await writeFile(path.join(tgtDir, rel), b);
  }

  // ---- replay recorded content requests
  for (let i = 0; i < log.length; i++) {
    const r: RecordedRequest = log[i]!;
    const rep = report.replay[i]!;
    try {
      const req = { projectDir: tgtDir, kind: r.kind, name: r.name, displayName: r.displayName, params: r.params };
      const out = await planGenerate(services, req);
      if (out.blocked.length) {
        rep.status = "skipped";
        rep.detail = out.blocked.slice(0, 8);
        manual.push(`Content "${r.kind}${r.name ? ` ${r.name}` : ""}" could not be regenerated for ${toLoader} ${toMc}: ${out.blocked[0]}`);
        continue;
      }
      await writeGenerate(req, out);
      rep.status = "regenerated";
      const w = [...new Set(out.plans.flatMap((p) => p.warnings))];
      if (w.length) rep.detail = w;
    } catch (e) {
      rep.status = "failed";
      rep.detail = [(e as Error).message.split("\n")[0]!];
      if (!(e instanceof GenerateError)) warnings.push(`Replay of ${r.kind} failed: ${(e as Error).message.split("\n")[0]}`);
    }
  }

  // ---- mixins
  try {
    const mp = await portMixins(services, { projectDir: tgtDir, fromVersion: src.mcVersion, fromLoader: src.loader, toVersion: toMc, toLoader, apply: true });
    report.mixins = { broken: mp.broken, applied: mp.applied, remaining: mp.remaining, otherErrors: mp.otherErrors, notes: mp.notes };
    for (const b of mp.broken.filter((b) => !b.applied)) {
      const best = b.suggestions[0];
      manual.push(`Mixin ${b.kind} ${b.kind === "class" ? b.name.replace(/\//g, ".") : `${b.owner.replace(/\//g, ".")}#${b.name}`} (${b.files.join(", ")}): ${best ? `try ${best.replacement} (${best.confidence}: ${best.reason})` : "no replacement found"}.`);
    }
  } catch (e) {
    warnings.push(`Mixin port failed: ${(e as Error).message}`);
  }

  // ---- compile + breakages
  if (o.compile !== false) {
    const run = await runGradle(services, { projectDir: tgtDir, tasks: ["compileJava"], timeoutSec: 1800, daemon: true, logName: "port-compile" });
    if ("error" in run) warnings.push(`Compile skipped: ${run.error}`);
    else {
      const errs = run.diagnosis.findings.filter((f) => f.kind === "compile_error");
      const bySym = new Map<string, Set<string>>();
      for (const f of errs) {
        const m = /symbol:\s+(?:class|variable|method|static)\s+(\w+)/.exec(f.message) ?? /package ([\w.]+) does not exist/.exec(f.message);
        const sym = m?.[1] ?? f.message.split(" (")[0]!.slice(0, 80);
        const s = bySym.get(sym) ?? new Set<string>();
        if (f.file) s.add(path.relative(tgtDir, f.file));
        bySym.set(sym, s);
      }
      let tgtIndex;
      try {
        tgtIndex = (await services.indexes.open({ mcVersion: toMc, mappings: "mojmap", source: "vanilla" })).index;
      } catch {
        /* optional */
      }
      const breakages: NonNullable<PortReport["compile"]>["breakages"] = [];
      for (const [symbol, fs] of [...bySym].slice(0, 15)) {
        const candidates = tgtIndex && /^[A-Z]\w*$/.test(symbol) ? tgtIndex.search(symbol, "class", 3).map((h) => h.name.replace(/\//g, ".")) : [];
        let docs: { title: string; url: string }[] = [];
        if (o.docs !== false && /^\w+$/.test(symbol)) {
          try {
            const r = await docsSearch(services, { query: symbol, loader: toLoader, mcVersion: toMc, limit: 2, includeCode: false, verifyUrls: false });
            const sc = r.structuredContent as { results?: { title: string; url: string; score: number }[] } | undefined;
            docs = (sc?.results ?? []).map((x) => ({ title: x.title, url: x.url }));
          } catch {
            /* docs optional */
          }
        }
        breakages.push({ symbol, files: [...fs], candidates, docs });
      }
      report.compile = { status: run.result.exitCode === 0 ? "succeeded" : "failed", errors: errs.length, breakages, logFile: run.result.logFile };
    }
  }
  await mkdir(path.join(tgtDir, ".ffn", "port"), { recursive: true });
  await writeFile(path.join(tgtDir, ".ffn", "port", "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  return report;
}
