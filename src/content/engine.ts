/**
 * Content generation engine: renders the declarative catalog (profiles/content/*.yaml) for one project.
 * No version-specific logic lives here: variants are chosen by probing the project's real classpath and
 * by profile rules; every referenced class and every `requires` symbol is verified before anything is written.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { readProjectInfo, type ProjectInfo } from "../project/info.js";
import { lookupProfile, type Services } from "../services.js";
import { loadCatalog, resolveSettings, type Catalog, type ContentOp, type KindDef } from "./catalog.js";
import { ClasspathSymbols, type SymbolCheck } from "./classpath.js";
import { placeholderPng } from "./png.js";
import { evalCondition, render, TemplateError } from "./template.js";

export interface GenerateRequest {
  projectDir: string;
  kind: string;
  name?: string;
  displayName?: string;
  params?: Record<string, unknown>;
  force?: boolean;
}

export interface PlannedFile {
  path: string;
  action: "create" | "modify";
  content: string | Buffer;
}

export interface ContentPlan {
  kind: string;
  loader: string;
  mcVersion: string;
  catalogLoader: string;
  files: PlannedFile[];
  checks: SymbolCheck[];
  mismatches: SymbolCheck[];
  probes: Record<string, boolean>;
  variant?: string;
  notes: string[];
  warnings: string[];
  errors: string[];
}

export class GenerateError extends Error {}

export function pascal(s: string): string {
  return s
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((p) => p[0]!.toUpperCase() + p.slice(1))
    .join("");
}
const camel = (s: string) => {
  const p = pascal(s);
  return p ? p[0]!.toLowerCase() + p.slice(1) : p;
};
const title = (s: string) =>
  s
    .split(/[_\-/]+/)
    .filter(Boolean)
    .map((p) => p[0]!.toUpperCase() + p.slice(1))
    .join(" ");
const escRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Records imports for one Java file and renders class references as short names when safe. */
class TypeNamer {
  private bySimple = new Map<string, string>();
  readonly added = new Set<string>();
  private pkg: string;
  private own: string;

  constructor(content: string, filePath: string) {
    this.pkg = /^\s*package\s+([\w.]+)\s*;/m.exec(content)?.[1] ?? "";
    this.own = path.basename(filePath, ".java");
    for (const m of content.matchAll(/^\s*import\s+([\w.]+)\s*;/gm)) {
      const fq = m[1]!;
      this.bySimple.set(fq.slice(fq.lastIndexOf(".") + 1), fq);
    }
  }

  name(binary: string): string {
    const outer = binary.split("$")[0]!;
    const rest = binary.slice(outer.length).replace(/\$/g, ".");
    const dot = outer.lastIndexOf(".");
    const simple = outer.slice(dot + 1);
    const pkg = dot >= 0 ? outer.slice(0, dot) : "";
    if (simple === this.own) return outer === `${this.pkg}.${this.own}` ? simple + rest : outer + rest;
    if (pkg === this.pkg || pkg === "java.lang") return simple + rest;
    const existing = this.bySimple.get(simple);
    if (existing === outer) return simple + rest;
    if (existing) return outer + rest;
    this.bySimple.set(simple, outer);
    this.added.add(outer);
    return simple + rest;
  }
}

export function addImports(content: string, imports: Iterable<string>): string {
  const have = new Set([...content.matchAll(/^\s*import\s+([\w.]+)\s*;/gm)].map((m) => m[1]!));
  const add = [...new Set(imports)].filter((i) => !have.has(i)).sort();
  if (!add.length) return content;
  const lines = add.map((i) => `import ${i};`).join("\n");
  const importRe = /^import\s+[\w.]+\s*;[ \t]*$/gm;
  let lastEnd = -1;
  for (let m = importRe.exec(content); m; m = importRe.exec(content)) lastEnd = m.index + m[0].length;
  if (lastEnd >= 0) return `${content.slice(0, lastEnd)}\n${lines}${content.slice(lastEnd)}`;
  const pkg = /^\s*package\s+[\w.]+\s*;[ \t]*\n/m.exec(content);
  if (pkg) {
    const at = pkg.index + pkg[0].length;
    return `${content.slice(0, at)}\n${lines}\n${content.slice(at)}`;
  }
  return `${lines}\n\n${content}`;
}

/** Index of the brace closing the block opened at `open` (skips strings, chars and comments). */
export function matchBrace(src: string, open: number): number {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i]!;
    if (c === "/" && src[i + 1] === "/") {
      const nl = src.indexOf("\n", i);
      i = nl < 0 ? src.length : nl;
    } else if (c === "/" && src[i + 1] === "*") i = src.indexOf("*/", i + 2) + 1;
    else if (c === '"' || c === "'") {
      if (c === '"' && src.startsWith('"""', i)) {
        i = src.indexOf('"""', i + 3) + 2;
        continue;
      }
      for (i++; i < src.length && src[i] !== c; i++) if (src[i] === "\\") i++;
    } else if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function deepMerge(target: unknown, patch: unknown): unknown {
  if (Array.isArray(target) && Array.isArray(patch)) {
    const out = [...target];
    for (const v of patch) if (!out.some((o) => JSON.stringify(o) === JSON.stringify(v))) out.push(v);
    return out;
  }
  if (target && patch && typeof target === "object" && typeof patch === "object" && !Array.isArray(target) && !Array.isArray(patch)) {
    const out: Record<string, unknown> = { ...(target as Record<string, unknown>) };
    for (const [k, v] of Object.entries(patch as Record<string, unknown>)) out[k] = k in out ? deepMerge(out[k], v) : v;
    return out;
  }
  return patch;
}

function walkJava(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walkJava(p, out);
    else if (e.name.endsWith(".java")) out.push(p);
  }
  return out;
}

interface MainInfo {
  file: string;
  className: string;
  fqcn: string;
  pkg: string;
  ctorParams: { type: string; name: string }[];
}

function findMain(project: ProjectInfo, loader: string, resDir: string): MainInfo | undefined {
  const roots = project.javaSourceRoots.length ? project.javaSourceRoots : [path.join(project.dir, "src/main/java")];
  let fqcn: string | undefined;
  if (loader === "fabric") {
    const fmj = path.join(resDir, "fabric.mod.json");
    if (existsSync(fmj)) {
      const j = JSON.parse(readFileSync(fmj, "utf8")) as { entrypoints?: { main?: (string | { value: string })[] } };
      const e = j.entrypoints?.main?.[0];
      fqcn = (typeof e === "string" ? e : e?.value)?.split("::")[0];
    }
  }
  for (const root of roots) {
    const files = fqcn ? [path.join(root, `${fqcn.replace(/\./g, "/")}.java`)].filter(existsSync) : walkJava(root).filter((f) => /@Mod\s*\(/.test(readFileSync(f, "utf8")));
    const file = files[0];
    if (!file) continue;
    const text = readFileSync(file, "utf8");
    const className = path.basename(file, ".java");
    const pkg = /^\s*package\s+([\w.]+)\s*;/m.exec(text)?.[1] ?? "";
    const imports = new Map([...text.matchAll(/^\s*import\s+([\w.]+)\s*;/gm)].map((m) => [m[1]!.slice(m[1]!.lastIndexOf(".") + 1), m[1]!]));
    const ctor = new RegExp(`public\\s+${className}\\s*\\(([^)]*)\\)`).exec(text);
    const ctorParams = (ctor?.[1] ?? "")
      .split(",")
      .map((p) => p.replace(/@\w+(\([^)]*\))?/g, "").replace(/\bfinal\b/g, "").trim())
      .filter(Boolean)
      .map((p) => {
        const parts = p.split(/\s+/);
        const name = parts.pop()!;
        const t = parts.join(" ");
        const type = t.includes(".") ? t : (imports.get(t) ?? (pkg ? `${pkg}.${t}` : t));
        return { type, name };
      });
    return { file, className, fqcn: pkg ? `${pkg}.${className}` : className, pkg, ctorParams };
  }
  return undefined;
}

export async function planContent(services: Services, req: GenerateRequest, onProgress?: (m: string) => void): Promise<ContentPlan> {
  const project = await readProjectInfo(req.projectDir);
  const loader = project.loader;
  const mc = project.mcVersion;
  const notes: string[] = [];
  const warnings: string[] = [];
  const errors: string[] = [];

  const lookup = await lookupProfile(services, loader, mc);
  for (const w of lookup.profile.warnings) warnings.push(w);
  if (!project.modId) throw new GenerateError("Could not determine the mod id (no .ffn/project.json and no mod_id in gradle.properties).");

  onProgress?.("Reading the project's compile classpath…");
  let symbols: ClasspathSymbols;
  try {
    const files = await services.indexes.projectClasspath(project, onProgress);
    symbols = ClasspathSymbols.load(files, path.join(project.dir, ".ffn", "symbols.json"));
  } catch (e) {
    throw new GenerateError(
      `FFN needs the project's compile classpath to pick the right API for ${loader} ${mc} and to verify generated code, but Gradle could not provide it: ${(e as Error).message}. Fix the build (gradle_build) and retry.`,
    );
  }
  if (!symbols.hasClass("net.minecraft.server.MinecraftServer")) throw new GenerateError("No Minecraft classes found on the compile classpath; run gradle_build once and retry.");

  let catalogLoader: string = loader;
  let catalog = await loadCatalog(services.config, loader);
  const evalProbes = (c: Catalog) => Object.fromEntries(Object.entries(c.probes).map(([k, specs]) => [k, specs.every((s) => symbols.check(s).ok)]));
  let has = evalProbes(catalog);
  for (const d of catalog.delegate) {
    if (evalCondition(d.if, { has })) {
      catalogLoader = d.to;
      catalog = await loadCatalog(services.config, d.to);
      has = evalProbes(catalog);
      notes.push(`Using the ${d.to} templates for ${loader} ${mc} (${d.if}).`);
      break;
    }
  }
  const settings = resolveSettings(catalog.rules, mc, lookup.profile.obfuscated);
  const def: KindDef | undefined = catalog.kinds[req.kind];
  if (!def) throw new GenerateError(`Unknown content kind "${req.kind}" for ${catalogLoader}. Available: ${Object.keys(catalog.kinds).sort().join(", ")}.`);

  const checks = new Map<string, SymbolCheck>();
  const verify = (spec: string, why?: string) => {
    const r = symbols.check(spec);
    if (!checks.has(spec)) checks.set(spec, why && !r.ok ? { ...r, reason: `${r.reason} (needed by ${why})` } : r);
    return r.ok;
  };
  const resolveType = (name: string): string => {
    if (name === "Main") return main!.fqcn;
    if (name.startsWith("~")) return `${pkg}${name.slice(1)}`; // the mod's own classes, relative to its package
    if (name.includes(".")) {
      verify(name);
      return name;
    }
    const cands = catalog.symbols[name];
    if (!cands) throw new TemplateError(`Unknown class alias {{@${name}}} (define it under symbols:)`);
    const hit = cands.find((c) => symbols.hasClass(c));
    if (hit) {
      verify(hit);
      return hit;
    }
    checks.set(`@${name}`, { spec: cands.join(" | "), ok: false, reason: `none of ${cands.join(", ")} exist on the classpath` });
    return cands[0]!;
  };

  const resDir = project.resourceRoots[0] ?? path.join(project.dir, "src/main/resources");
  const main = findMain(project, loader, resDir);
  const pjPath = path.join(project.dir, ".ffn/project.json");
  const pjson = existsSync(pjPath) ? (JSON.parse(readFileSync(pjPath, "utf8")) as { package?: string }) : {};
  const pkg = pjson.package ?? main?.pkg;
  if (!pkg || !main) throw new GenerateError("Could not find the mod's main class (fabric.mod.json main entrypoint or the @Mod class).");
  const javaRoot = project.javaSourceRoots[0] ?? path.join(project.dir, "src/main/java");
  const modId = project.modId;
  const name = (req.name ?? "").trim();
  if (name && !/^[a-z0-9_./-]+$/.test(name)) throw new GenerateError(`Invalid name "${name}": use lowercase letters, digits and _ (it becomes the id ${modId}:${name}).`);
  const leaf = name.split("/").pop() ?? "";
  const params: Record<string, unknown> = { ...(req.params ?? {}) };
  const idOf = (s: string) => (s.includes(":") ? s : `${modId}:${s}`);

  const ctx: Record<string, unknown> = {
    loader,
    mcVersion: mc,
    modId,
    package: pkg,
    packagePath: pkg.replace(/\./g, "/"),
    javaDir: path.relative(project.dir, path.join(javaRoot, pkg.replace(/\./g, "/"))),
    resDir: path.relative(project.dir, resDir),
    assets: path.relative(project.dir, path.join(resDir, "assets", modId)),
    data: path.relative(project.dir, path.join(resDir, "data", modId)),
    dataRoot: path.relative(project.dir, path.join(resDir, "data")),
    mainClass: main.className,
    mainFqcn: main.fqcn,
    ModPrefix: pascal(modId),
    name,
    id: name ? idOf(name) : "",
    Name: pascal(leaf),
    NAME: leaf.toUpperCase().replace(/[^A-Z0-9]+/g, "_"),
    camel: camel(leaf),
    displayName: req.displayName ?? title(leaf),
    params,
    settings,
    has,
    tables: catalog.tables,
  };

  let modBusTemplate: string | undefined;
  for (const b of catalog.main?.modBus ?? []) {
    if (b.requires && !b.requires.every((s) => symbols.check(s).ok)) continue;
    let pname = "";
    if (b.param) {
      const p = main.ctorParams.find((cp) => cp.type === b.param);
      if (!p) continue;
      pname = p.name;
    }
    modBusTemplate = b.expr.replace(/\{\{param\}\}/g, pname);
    break;
  }

  normaliseParams(req.kind, params, ctx, catalog, idOf, errors);
  if (req.kind === "event_handler" && params.eventKey) {
    const ev = (catalog.tables.events as Record<string, { description?: string; variants: { requires?: string[] }[] }>)[String(params.eventKey)];
    const v = ev?.variants?.find((vv) => (vv.requires ?? []).every((s) => symbols.check(s).ok));
    if (!v) {
      const miss = (ev?.variants ?? []).flatMap((vv) => (vv.requires ?? []).map((s) => symbols.check(s))).filter((c) => !c.ok);
      throw new GenerateError(`No variant of event "${String(params.eventKey)}" matches ${loader} ${mc}. Missing: ${miss.map((c) => c.reason).join("; ")}.`);
    }
    for (const s of v.requires ?? []) verify(s, `event ${String(params.eventKey)}`);
    ctx.ev = v;
  }

  let variant: string | undefined;
  if (def.variants?.length) {
    const v = def.variants.find((vv) => (!vv.requires || vv.requires.every((s) => symbols.check(s).ok)) && (!vv.if || evalCondition(vv.if, ctx)));
    if (!v) {
      const all = def.variants.flatMap((vv) => (vv.requires ?? []).map((s) => symbols.check(s))).filter((c) => !c.ok);
      throw new GenerateError(`No ${req.kind} variant matches ${loader} ${mc}. Missing: ${all.map((c) => c.reason).join("; ")}.`);
    }
    for (const s of v.requires ?? []) verify(s, `${req.kind} variant`);
    variant = String(v.name ?? def.variants.indexOf(v));
    ctx.v = v;
  }

  const vfs = new Map<string, { orig?: Buffer; content: string | Buffer }>();
  const abs = (p: string) => (path.isAbsolute(p) ? p : path.join(project.dir, p));
  const read = (p: string): string | undefined => {
    const a = abs(p);
    const v = vfs.get(a);
    if (v) return typeof v.content === "string" ? v.content : v.content.toString("utf8");
    return existsSync(a) && statSync(a).isFile() ? readFileSync(a, "utf8") : undefined;
  };
  const put = (p: string, content: string | Buffer) => {
    const a = abs(p);
    const prev = vfs.get(a);
    vfs.set(a, { orig: prev ? prev.orig : existsSync(a) ? readFileSync(a) : undefined, content });
  };
  const exists = (p: string) => vfs.has(abs(p)) || existsSync(abs(p));
  const r = (tpl: string, file?: string, base?: string) => {
    const namer = file?.endsWith(".java") ? new TypeNamer(base ?? read(file) ?? "", file) : undefined;
    const out = render(tpl, ctx, {
      type: (n) => {
        const fq = resolveType(n);
        return namer ? namer.name(fq) : fq.replace(/\$/g, ".");
      },
    });
    return { text: out, imports: namer ? [...namer.added] : [] };
  };
  const plain = (tpl: string) => r(tpl).text;

  // mod bus expression rendered against the main class (its imports go there with the hook)
  let modBusImports: string[] = [];
  if (modBusTemplate) {
    const mb = r(modBusTemplate, main.file);
    ctx.modBus = mb.text;
    modBusImports = mb.imports;
  }

  const expand = (ops: ContentOp[], depth = 0): ContentOp[] =>
    ops.flatMap((o) => {
      if (!o.include) return [o];
      const inc = catalog.kinds[o.include];
      if (!inc || depth > 5) throw new GenerateError(`include: unknown kind "${o.include}"`);
      if (o.if && !evalCondition(o.if, ctx)) return [];
      return expand(inc.ops, depth + 1);
    });
  for (const op of expand(def.ops)) {
    const label = op.id ?? op.write ?? op.insert ?? op.json ?? op.hook ?? "op";
    try {
      if (op.if && !evalCondition(op.if, ctx)) continue;
      if (op.unless && evalCondition(op.unless, ctx)) continue;
      for (const s of op.requires ?? []) verify(s, label);
      if (op.note) notes.push(plain(op.note).trim());
      if (op.warn) warnings.push(plain(op.warn).trim());

      if (op.write) {
        const file = plain(op.write);
        if (exists(file) && !req.force) {
          errors.push(`${file} already exists (pass force=true to overwrite, or choose another name).`);
          continue;
        }
        const { text, imports } = r(op.template ?? "", file, "");
        put(file, file.endsWith(".java") ? addImports(text, imports) : text);
      }

      if (op.insert) {
        const file = plain(op.insert);
        let content = read(file);
        if (content === undefined) {
          if (!op.container) {
            errors.push(`${file} does not exist (generate the ${op.id ?? "container"} first).`);
            continue;
          }
          const c = r(op.container, file, "");
          content = file.endsWith(".java") ? addImports(c.text, c.imports) : c.text;
        }
        const allImports: string[] = [];
        for (const at of op.at ?? []) {
          const { text, imports } = r(at.text, file, content);
          if (at.conflict) {
            const c = plain(at.conflict);
            if (content.includes(c)) {
              errors.push(`${file} already contains "${c.trim()}" — choose another name.`);
              continue;
            }
          }
          const present = at.unlessPresent ? plain(at.unlessPresent) : text.trim();
          if (present && content.includes(present)) continue;
          const markerName = plain(at.marker);
          const mm = new RegExp(`^([ \\t]*)// ffn:${escRe(markerName)}[ \\t]*$`, "m").exec(content);
          if (!mm) {
            errors.push(`${file}: marker "// ffn:${markerName}" not found; add it where FFN should insert code.`);
            continue;
          }
          const indent = mm[1]!;
          const body = text.replace(/\n$/, "").split("\n").map((l) => (l ? indent + l : l)).join("\n");
          content = content.slice(0, mm.index) + body + "\n" + content.slice(mm.index);
          allImports.push(...imports);
        }
        put(file, file.endsWith(".java") ? addImports(content, allImports) : content);
      }

      if (op.hook === "main") {
        const content = read(main.file)!;
        const { text, imports } = r(op.text ?? "", main.file);
        const stmt = text.trim();
        if (content.includes(stmt)) continue;
        const init = catalog.main?.init ?? "constructor";
        const re = init === "constructor" ? new RegExp(`public\\s+${main.className}\\s*\\([^)]*\\)\\s*(?:throws[^{]+)?\\{`) : new RegExp(`void\\s+${init}\\s*\\(\\s*\\)\\s*\\{`);
        const m = re.exec(content);
        if (!m) {
          errors.push(`Could not find ${init === "constructor" ? `the ${main.className} constructor` : `${init}()`} in ${main.file}; add this yourself: ${stmt}`);
          continue;
        }
        const close = matchBrace(content, m.index + m[0].length - 1);
        const lineStart = content.lastIndexOf("\n", close) + 1;
        const lines = stmt.split("\n").map((l) => `        ${l.trim()}`).join("\n");
        const extra = ctx.modBus && stmt.includes(String(ctx.modBus)) ? modBusImports : [];
        put(main.file, addImports(`${content.slice(0, lineStart)}${lines}\n${content.slice(lineStart)}`, [...imports, ...extra]));
      }

      if (op.json) {
        const file = plain(op.json);
        const patchText = plain(op.merge ?? "{}");
        let patch: unknown;
        try {
          patch = JSON.parse(patchText);
        } catch (e) {
          throw new GenerateError(`template produced invalid JSON for ${file}: ${(e as Error).message}\n${patchText}`);
        }
        const cur = read(file);
        let base: unknown = {};
        if (cur !== undefined) {
          try {
            base = JSON.parse(cur);
          } catch {
            errors.push(`${file} is not valid JSON; not modified.`);
            continue;
          }
        }
        put(file, `${JSON.stringify(deepMerge(base, patch), null, 2)}\n`);
      }

      if (op.lang) {
        const file = path.join(String(ctx.assets), "lang", "en_us.json");
        const cur = read(file);
        const base = cur ? (JSON.parse(cur) as Record<string, string>) : {};
        let changed = false;
        for (const [k, v] of Object.entries(op.lang)) {
          const key = plain(k);
          if (key in base) continue;
          base[key] = plain(v);
          changed = true;
        }
        if (changed) put(file, `${JSON.stringify(base, null, 2)}\n`);
      }

      if (op.texture) {
        const file = plain(op.texture);
        if (!exists(file)) put(file, placeholderPng(op.color ? plain(op.color) : undefined));
      }

      if (op.gradle) {
        const file = plain(op.gradle);
        const content = read(file);
        const snippet = plain(op.text ?? "").trim();
        if (content === undefined) {
          errors.push(`${file} not found.`);
          continue;
        }
        const firstLine = snippet.split("\n")[0]!.trim();
        if (content.includes(firstLine)) continue;
        const blockName = op.block ? plain(op.block) : undefined;
        if (!blockName) {
          put(file, `${content.replace(/\s*$/, "\n")}\n${snippet}\n`);
          continue;
        }
        const m = new RegExp(`^([ \\t]*)${escRe(blockName)}\\s*\\{`, "m").exec(content);
        if (!m) {
          warnings.push(`No "${blockName} {" block in ${file}; add this yourself:\n${snippet}`);
          continue;
        }
        const close = matchBrace(content, m.index + m[0].length - 1);
        const lineStart = content.lastIndexOf("\n", close) + 1;
        const indent = `${m[1]}    `;
        const body = snippet.split("\n").map((l) => (l ? indent + l : l)).join("\n");
        put(file, `${content.slice(0, lineStart)}${body}\n${content.slice(lineStart)}`);
      }
    } catch (e) {
      if (e instanceof TemplateError || e instanceof GenerateError) errors.push(`${label}: ${e.message}`);
      else throw e;
    }
  }

  const files: PlannedFile[] = [...vfs.entries()]
    .filter(([, v]) => v.orig === undefined || Buffer.compare(v.orig, Buffer.from(v.content)) !== 0)
    .map(([p, v]) => ({ path: p, action: v.orig === undefined ? "create" : "modify", content: v.content }));
  const all = [...checks.values()];
  return {
    kind: req.kind,
    loader,
    mcVersion: mc,
    catalogLoader,
    files,
    checks: all,
    mismatches: all.filter((c) => !c.ok),
    probes: has,
    ...(variant !== undefined ? { variant } : {}),
    notes,
    warnings,
    errors,
  };
}

export async function writeContentPlan(plan: ContentPlan): Promise<void> {
  for (const f of plan.files) {
    await mkdir(path.dirname(f.path), { recursive: true });
    await writeFile(f.path, f.content);
  }
}

function normaliseParams(kind: string, p: Record<string, unknown>, ctx: Record<string, unknown>, catalog: Catalog, idOf: (s: string) => string, errors: string[]): void {
  const ing = (s: string) => {
    const tag = s.startsWith("#");
    const id = idOf(tag ? s.slice(1) : s);
    return { id, tag, raw: tag ? `#${id}` : id };
  };
  const listLast = <T>(a: T[]) => a.map((x, i) => ({ ...(typeof x === "object" ? x : { value: x }), last: i === a.length - 1 }));
  if (kind === "recipe") {
    const type = String(p.type ?? (p.pattern ? "shaped" : p.ingredients ? "shapeless" : "smelting"));
    p.type = type;
    p.result = idOf(String(p.result ?? ctx.id ?? ""));
    p.count = Number(p.count ?? 1);
    if (Array.isArray(p.pattern)) p.pattern = listLast((p.pattern as string[]).map((row) => ({ row })));
    if (p.key && typeof p.key === "object" && !Array.isArray(p.key)) p.keys = listLast(Object.entries(p.key as Record<string, string>).map(([k, v]) => ({ char: k, ...ing(v) })));
    if (Array.isArray(p.ingredients)) p.ingredients = listLast((p.ingredients as string[]).map(ing));
    if (typeof p.ingredient === "string") p.ingredient = ing(p.ingredient);
    p.experience = Number(p.experience ?? 0.1);
    p.cookingTime = Number(p.cookingTime ?? (type === "smelting" ? 200 : 100));
    p.isShaped = type === "shaped";
    p.isShapeless = type === "shapeless";
    p.isCooking = ["smelting", "blasting", "smoking", "campfire_cooking"].includes(type);
    if (p.isShaped && (!p.pattern || !p.keys)) errors.push("shaped recipes need pattern and key.");
    if (p.isShapeless && !p.ingredients) errors.push("shapeless recipes need ingredients.");
    if (p.isCooking && !p.ingredient) errors.push(`${type} recipes need ingredient.`);
  }
  if (kind === "tag") {
    p.registry = String(p.registry ?? "item");
    const vals = Array.isArray(p.values) ? (p.values as string[]) : [];
    if (!vals.length) errors.push("tag needs values.");
    p.values = listLast(vals.map((v) => ({ value: v.startsWith("#") ? `#${idOf(v.slice(1))}` : idOf(v) })));
    const tagId = String(p.tag ?? ctx.name ?? "");
    const [ns, tpath] = tagId.includes(":") ? (tagId.split(":", 2) as [string, string]) : [String(ctx.modId), tagId];
    p.namespace = ns;
    p.path = tpath;
    p.replace = Boolean(p.replace);
    const dirs = (ctx.settings as { tagDirs?: Record<string, string> }).tagDirs ?? {};
    if (!dirs[String(p.registry)]) errors.push(`Unknown tag registry "${String(p.registry)}". Known: ${Object.keys(dirs).join(", ")}.`);
    p.dir = dirs[String(p.registry)] ?? String(p.registry);
  }
  if (Array.isArray(p.items)) p.items = listLast((p.items as string[]).map((s) => ({ id: idOf(s) })));
  if (typeof p.icon === "string") p.icon = idOf(p.icon);
  if (kind === "loot_table") {
    p.drop = idOf(String(p.drop ?? ctx.id ?? ""));
    p.lootType = String(p.lootType ?? "block");
  }
  if (kind === "networking") {
    const table = (catalog.tables.fieldTypes ?? {}) as Record<string, Record<string, unknown>>;
    const fields = Array.isArray(p.fields) && p.fields.length ? (p.fields as { name: string; type: string }[]) : [{ name: "value", type: "int" }];
    p.fields = fields.map((f, i) => {
      const t = table[f.type];
      if (!t) errors.push(`Unknown payload field type "${f.type}". Known: ${Object.keys(table).join(", ")}.`);
      return { name: f.name, Name: pascal(f.name), type: f.type, ...(t ?? {}), last: i === fields.length - 1, first: i === 0 };
    });
    const dir = String(p.direction ?? "to_server");
    if (!["to_server", "to_client", "both"].includes(dir)) errors.push(`direction must be to_server, to_client or both.`);
    p.direction = dir;
    p.toServer = dir === "to_server" || dir === "both";
    p.toClient = dir === "to_client" || dir === "both";
  }
  if (kind === "config") {
    const table = (catalog.tables.configTypes ?? {}) as Record<string, Record<string, unknown>>;
    const entries = Array.isArray(p.entries) ? (p.entries as Record<string, unknown>[]) : [];
    if (!entries.length) errors.push("config needs entries: [{name, type, default, comment?, min?, max?}].");
    p.entries = entries.map((e, i) => {
      const type = String(e.type);
      const t = table[type];
      if (!t) errors.push(`Unknown config type "${type}". Known: ${Object.keys(table).join(", ")}.`);
      const d = e.default ?? (type === "bool" ? false : type === "string" ? "" : 0);
      const lit = type === "string" ? JSON.stringify(String(d)) : type === "double" ? (String(Number(d)).includes(".") ? String(Number(d)) : `${Number(d)}.0`) : String(d);
      const hasRange = e.min !== undefined && e.max !== undefined;
      const rangeLit = (v: unknown) => (type === "double" ? (String(Number(v)).includes(".") ? String(Number(v)) : `${Number(v)}.0`) : String(v));
      return {
        ...(t ?? {}),
        name: String(e.name),
        NAME: String(e.name).toUpperCase().replace(/[^A-Z0-9]+/g, "_"),
        camel: camel(String(e.name)),
        comment: String(e.comment ?? e.name).replace(/"/g, "'"),
        defaultLiteral: lit,
        hasRange,
        min: hasRange ? rangeLit(e.min) : "",
        max: hasRange ? rangeLit(e.max) : "",
        last: i === entries.length - 1,
      };
    });
    p.configType = String(p.configType ?? "common");
    p.CONFIG_TYPE = String(p.configType).toUpperCase();
  }
  if (kind === "event_handler") {
    const events = (catalog.tables.events ?? {}) as Record<string, unknown>;
    const key = String(p.event ?? "");
    if (!events[key]) {
      errors.push(`Unknown event "${key}". Known: ${Object.keys(events).join(", ")}.`);
      return;
    }
    p.eventKey = key;
    p.handler = `on${pascal(key)}`;
  }
}
