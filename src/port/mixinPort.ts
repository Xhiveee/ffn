/**
 * mixin_port: check a project's mixins against another Minecraft version (and/or loader) and suggest replacements
 * for broken targets.
 *
 * Suggestion sources, in order of confidence:
 *  - high: Fabric intermediary bridge (stable names across versions): source names → intermediary → target names;
 *          or a class whose simple name is unique in the target (moved package).
 *  - medium: same member name with a different descriptor (signature changed), or a single new member with the
 *          source descriptor and a similar name; several classes with the same simple name.
 *  - low: similar names only.
 * apply=true rewrites only high-confidence class/member renames (imports, string selectors, @Shadow names) and
 * re-validates against the target.
 */
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { MappingTable } from "../index/mappings.js";
import type { IndexNamespace } from "../index/service.js";
import type { McIndex } from "../index/store.js";
import { type MixinIssue, similar, validateProject, type ValidateContext } from "../mixin/validate.js";
import { readProjectInfo } from "../project/info.js";
import type { Loader } from "../profiles/schema.js";
import { lookupProfile, type Services } from "../services.js";

export type Confidence = "high" | "medium" | "low";

export interface Suggestion {
  replacement: string;
  confidence: Confidence;
  reason: string;
  /** Descriptor in the target (members). */
  desc?: string;
}

export interface BrokenRef {
  kind: "class" | "method" | "field";
  /** Internal class name (class) or owner (members). */
  owner: string;
  name: string;
  files: string[];
  messages: string[];
  suggestions: Suggestion[];
  applied?: string;
}

export interface MixinPortResult {
  from: { mcVersion: string; loader: string };
  to: { mcVersion: string; loader: string };
  mixinFiles: string[];
  broken: BrokenRef[];
  otherErrors: MixinIssue[];
  applied: { file: string; changes: string[] }[];
  remaining?: { errors: number; issues: MixinIssue[] };
  notes: string[];
}

const tableNs = (m: string) => (m === "yarn" ? "yarn" : "mojmap");

class Bridge {
  constructor(
    private src: MappingTable,
    private tgt: MappingTable,
    private from: string,
    private to: string,
  ) {}

  cls(name: string): string[] {
    const out = new Set<string>();
    for (const r of this.src.find(name, this.from, "class")) {
      if (r.names[this.from] !== name || !r.names.intermediary) continue;
      for (const t of this.tgt.find(r.names.intermediary, "intermediary", "class")) if (t.names.intermediary === r.names.intermediary && t.names[this.to]) out.add(t.names[this.to]!);
    }
    return [...out];
  }

  member(kind: "method" | "field", owner: string, name: string): { owner: string; name: string; desc?: string }[] {
    const out = new Map<string, { owner: string; name: string; desc?: string }>();
    for (const r of this.src.find(`${owner}#${name}`, this.from, kind)) {
      const inter = r.names.intermediary;
      if (!inter) continue;
      for (const t of this.tgt.find(inter, "intermediary", kind)) {
        const n = t.names[this.to];
        const o = t.owner?.[this.to];
        if (!n || !o) continue;
        out.set(`${o}#${n}${t.desc?.[this.to] ?? ""}`, { owner: o, name: n, desc: t.desc?.[this.to] });
      }
    }
    return [...out.values()];
  }
}

const simpleOf = (n: string) => n.slice(n.lastIndexOf("/") + 1);
const dotted = (n: string) => n.replace(/\//g, ".");

function suggestClass(name: string, tgt: McIndex, bridge?: Bridge): Suggestion[] {
  const out: Suggestion[] = [];
  const bridged = bridge?.cls(name).filter((c) => tgt.classes.has(c)) ?? [];
  if (bridged.length === 1) out.push({ replacement: bridged[0]!, confidence: "high", reason: "same intermediary class in both versions (renamed/moved)" });
  if (out.length) return out;
  const simple = simpleOf(name);
  const same = tgt.resolve(simple).filter((c) => simpleOf(c) === simple);
  if (same.length === 1) out.push({ replacement: same[0]!, confidence: "high", reason: "unique class with the same simple name (moved package)" });
  else for (const c of same.slice(0, 5)) out.push({ replacement: c, confidence: "medium", reason: "class with the same simple name (several candidates)" });
  if (!out.length) {
    const short = simple.replace(/^.*\$/, "");
    for (const h of tgt.search(short, "class", 5)) out.push({ replacement: h.owner || h.name, confidence: "low", reason: "similar class name" });
  }
  return out;
}

function suggestMember(kind: "method" | "field", owner: string, name: string, src: McIndex | undefined, tgt: McIndex, bridge?: Bridge): Suggestion[] {
  const out: Suggestion[] = [];
  const bridged = bridge?.member(kind, owner, name) ?? [];
  const onOwner = bridged.filter((b) => b.owner === owner || tgt.hierarchy(owner).some((h) => h.n === b.owner));
  const names = [...new Set(onOwner.map((b) => b.name))];
  if (names.length === 1 && names[0] !== name) {
    out.push({ replacement: names[0]!, confidence: "high", reason: "same intermediary member in both versions (renamed)", desc: onOwner[0]!.desc });
    return out;
  }
  for (const b of bridged.filter((b) => !onOwner.includes(b)).slice(0, 3))
    out.push({ replacement: `${dotted(b.owner)}#${b.name}`, confidence: "medium", reason: "same intermediary member, now declared in another class (moved)", desc: b.desc });
  const tcls = tgt.hierarchy(owner);
  if (!tcls.length) return out;
  const list = kind === "method" ? tcls.flatMap((c) => c.m) : tcls.flatMap((c) => c.f);
  const sameName = list.filter(([n]) => n === name);
  if (sameName.length) {
    for (const [n, d] of sameName.slice(0, 3)) out.push({ replacement: `${n}${kind === "method" ? d : ""}`, confidence: "medium", reason: "same name, different signature — update the descriptor and the handler parameters", desc: d });
    return out;
  }
  const srcDescs = new Set((src?.hierarchy(owner) ?? []).flatMap((c) => (kind === "method" ? c.m : c.f)).filter(([n]) => n === name).map(([, d]) => d));
  const srcNames = new Set((src?.hierarchy(owner) ?? []).flatMap((c) => (kind === "method" ? c.m : c.f)).map(([n]) => n));
  const fresh = list.filter(([n, d]) => srcDescs.has(d) && !srcNames.has(n) && !n.startsWith("lambda$"));
  const freshSimilar = fresh.filter(([n]) => similar(name, [n], 1).length);
  if (freshSimilar.length === 1) out.push({ replacement: freshSimilar[0]![0], confidence: "medium", reason: "new member with the same descriptor and a similar name", desc: freshSimilar[0]![1] });
  else if (fresh.length === 1) out.push({ replacement: fresh[0]![0], confidence: "medium", reason: "only new member with the same descriptor", desc: fresh[0]![1] });
  for (const n of similar(name, list.map(([n]) => n), 5)) if (!out.some((o) => o.replacement === n)) out.push({ replacement: n, confidence: "low", reason: "similar name" });
  return out;
}

function stringLiterals(text: string, fn: (s: string) => string): string {
  return text.replace(/"((?:[^"\\\n]|\\.)*)"/g, (_m, inner: string) => `"${fn(inner)}"`);
}

export interface MixinPortOptions {
  projectDir: string;
  toVersion?: string;
  toLoader?: Loader;
  apply?: boolean;
  /** Source version/loader when the project files already belong to the target (port_mod copies). */
  fromVersion?: string;
  fromLoader?: string;
}

export async function portMixins(services: Services, o: MixinPortOptions): Promise<MixinPortResult> {
  const project = await readProjectInfo(o.projectDir);
  const fromMc = o.fromVersion ?? project.mcVersion;
  const toMc = o.toVersion ?? project.mcVersion;
  const toLoader = (o.toLoader ?? project.loader) as Loader;
  const notes: string[] = [];
  const ns = (project.mappings === "yarn" ? "yarn" : "mojmap") as IndexNamespace;
  const tgtOpen = await services.indexes.open({ mcVersion: toMc, mappings: ns, source: "vanilla" });
  notes.push(...tgtOpen.notes.map((n) => `target: ${n}`));
  let srcIdx: McIndex | undefined;
  try {
    srcIdx = fromMc === toMc ? tgtOpen.index : (await services.indexes.open({ mcVersion: fromMc, mappings: ns, source: "vanilla" })).index;
  } catch (e) {
    notes.push(`Source ${fromMc} index unavailable (${(e as Error).message}); signature heuristics limited.`);
  }
  let bridge: Bridge | undefined;
  if (fromMc !== toMc) {
    try {
      const [s, t] = await Promise.all([services.indexes.table(fromMc), services.indexes.table(toMc)]);
      if (s.table.namespaces.includes("intermediary") && t.table.namespaces.includes("intermediary")) bridge = new Bridge(s.table, t.table, tableNs(project.mappings), tableNs(project.mappings));
      else notes.push(`No intermediary bridge ${fromMc} → ${toMc} (Fabric intermediary is not published for unobfuscated versions); suggestions use name/signature heuristics.`);
    } catch (e) {
      notes.push(`Mapping tables unavailable (${(e as Error).message}); suggestions use heuristics only.`);
    }
  }
  let profile;
  try {
    profile = (await lookupProfile(services, toLoader, toMc)).profile;
  } catch (e) {
    notes.push(`No ${toLoader} profile for ${toMc}: ${(e as Error).message}`);
  }
  const ctx: ValidateContext = { index: tgtOpen.index, project, profile, vanillaForLoader: toLoader !== "fabric", mixinExtrasAvailable: !!profile?.mixin.mixinExtras.bundled || project.loader === "fabric" };
  if (ctx.vanillaForLoader) notes.push(`Checked against vanilla Minecraft ${toMc}: members added by ${toLoader} patches are not visible.`);

  const first = await validateProject(ctx);
  const mixinFiles = [...new Set(first.configs.flatMap((c) => c.mixins.map((m) => m.file).filter((f): f is string => !!f)))];
  const broken = new Map<string, BrokenRef>();
  const add = (kind: BrokenRef["kind"], owner: string, name: string, file: string | undefined, msg: string) => {
    const k = `${kind}:${owner}:${name}`;
    const b = broken.get(k) ?? { kind, owner, name, files: [], messages: [], suggestions: [] };
    if (file && !b.files.includes(file)) b.files.push(file);
    if (!b.messages.includes(msg)) b.messages.push(msg);
    broken.set(k, b);
  };
  // imports of Minecraft classes that no longer exist (compile errors, not mixin errors)
  for (const f of mixinFiles) {
    const text = await readFile(path.join(project.dir, f), "utf8");
    for (const m of text.matchAll(/^import\s+((?:net\.minecraft|com\.mojang)\.[\w.$]+)\s*;/gm)) {
      const internal = m[1]!.replace(/\./g, "/");
      if (tgtOpen.index.classes.has(internal)) continue;
      // nested class imported as Outer.Inner
      const nested = internal.replace(/\/([A-Z]\w*)$/, "$$$1");
      if (tgtOpen.index.classes.has(nested)) continue;
      add("class", internal, internal, f, `import ${m[1]} does not exist in ${toMc}.`);
    }
  }
  const otherErrors: MixinIssue[] = [];
  for (const i of first.issues) {
    if (i.missing) add(i.missing.kind, i.missing.owner, i.missing.name, i.file, i.message);
    else if (i.severity === "error") otherErrors.push(i);
  }
  for (const b of broken.values()) {
    b.suggestions = b.kind === "class" ? suggestClass(b.name, tgtOpen.index, bridge) : suggestMember(b.kind, b.owner, b.name, srcIdx, tgtOpen.index, bridge);
  }

  const applied: MixinPortResult["applied"] = [];
  let remaining: MixinPortResult["remaining"];
  if (o.apply) {
    const byFile = new Map<string, string[]>();
    const texts = new Map<string, string>();
    for (const f of mixinFiles) texts.set(f, await readFile(path.join(project.dir, f), "utf8"));
    for (const b of broken.values()) {
      const hi = b.suggestions.filter((s) => s.confidence === "high");
      if (hi.length !== 1 || hi[0]!.replacement.includes("#")) continue;
      const rep = hi[0]!.replacement;
      for (const f of b.files) {
        let t = texts.get(f);
        if (t === undefined) continue;
        const before = t;
        if (b.kind === "class") {
          const oldDot = dotted(b.name).replace(/\$/g, ".");
          const newDot = dotted(rep).replace(/\$/g, ".");
          t = t.split(`import ${oldDot};`).join(`import ${newDot};`);
          t = stringLiterals(t, (s) => s.split(`L${b.name};`).join(`L${rep};`).split(dotted(b.name)).join(dotted(rep)));
          const os = simpleOf(b.name).replace(/^.*\$/, "");
          const nsName = simpleOf(rep).replace(/^.*\$/, "");
          if (os !== nsName) t = t.replace(new RegExp(`\\b${os}\\b`, "g"), nsName);
        } else {
          const esc = b.name.replace(/\$/g, "\\$");
          t = stringLiterals(t, (s) => s.replace(new RegExp(`(^|;|\\.)${esc}(?=\\(|:|$)`, "g"), `$1${rep}`));
          // @Shadow / @Invoker / @Accessor declarations named after the member
          const shadowDecl = new RegExp(`(@Shadow[^;{]*?\\b)${esc}(\\s*[(;=])`, "s");
          if (shadowDecl.test(t)) t = t.replace(new RegExp(`\\b${esc}\\b(?=\\s*[(;=)])`, "g"), rep);
        }
        if (t !== before) {
          texts.set(f, t);
          byFile.set(f, [...(byFile.get(f) ?? []), `${b.kind} ${dotted(b.kind === "class" ? b.name : `${b.owner}#${b.name}`)} → ${dotted(rep)}`]);
          b.applied = rep;
        }
      }
    }
    for (const [f, changes] of byFile) {
      await writeFile(path.join(project.dir, f), texts.get(f)!);
      applied.push({ file: f, changes });
    }
    const again = await validateProject({ ...ctx, project: await readProjectInfo(project.dir) });
    const errs = again.issues.filter((i) => i.severity === "error");
    remaining = { errors: errs.length, issues: errs };
  }
  return {
    from: { mcVersion: fromMc, loader: o.fromLoader ?? project.loader },
    to: { mcVersion: toMc, loader: toLoader },
    mixinFiles,
    broken: [...broken.values()],
    otherErrors,
    applied,
    remaining,
    notes,
  };
}
