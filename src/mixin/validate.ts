/**
 * Static Mixin validation against the class index: mixins.json consistency, registration,
 * compatibilityLevel, target classes, method selectors, @At targets (checked in the target
 * method's bytecode), handler signatures, @Accessor/@Invoker/@Shadow members.
 */
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { ACC, parseMethodDesc, type CodeRefs, type TypedConstant } from "../index/classfile.js";
import type { McIndex } from "../index/store.js";
import type { ProjectInfo } from "../project/info.js";
import type { ResolvedProfile } from "../profiles/schema.js";
import { annsOf, boolOf, classesOf, numOf, parseJava, resolveType, strOf, strsOf, type Annotation, type ParsedJava, type ParsedMember } from "./javaparse.js";

export interface MixinIssue {
  severity: "error" | "warning" | "info";
  message: string;
  file?: string;
  line?: number;
  mixin?: string;
  suggestion?: string;
  /** Set when a member could not be found (lets callers look the name up in other mappings). */
  missing?: { owner: string; name: string; kind: "method" | "field" | "class" };
}

export interface ValidateContext {
  index: McIndex;
  project: ProjectInfo;
  profile?: ResolvedProfile;
  /** Using vanilla classes for a Forge/NeoForge project (loader-added members are absent). */
  vanillaForLoader: boolean;
  mixinExtrasAvailable: boolean;
}

export const INJECTORS = ["Inject", "Redirect", "ModifyArg", "ModifyArgs", "ModifyVariable", "ModifyConstant", "WrapOperation", "WrapWithCondition", "ModifyExpressionValue", "ModifyReturnValue", "ModifyReceiver", "WrapMethod"];
const MIXINEXTRAS = new Set(["WrapOperation", "WrapWithCondition", "ModifyExpressionValue", "ModifyReturnValue", "ModifyReceiver", "WrapMethod", "Local", "Share", "Cancellable"]);
const CLIENT_ONLY = /^(net\/minecraft\/client\/|com\/mojang\/blaze3d\/|com\/mojang\/realmsclient\/)/;
const BOX: Record<string, string> = { Z: "Ljava/lang/Boolean;", B: "Ljava/lang/Byte;", C: "Ljava/lang/Character;", S: "Ljava/lang/Short;", I: "Ljava/lang/Integer;", J: "Ljava/lang/Long;", F: "Ljava/lang/Float;", D: "Ljava/lang/Double;", V: "Ljava/lang/Void;" };
export const boxed = (d: string) => BOX[d] ?? d;

const isMcLike = (internal: string) => /^(net\/minecraft\/|com\/mojang\/)/.test(internal);

export interface Selector {
  owner?: string;
  name: string;
  desc?: string;
  /** Field selectors (`name:desc`). */
  fieldDesc?: string;
}

/** Class created by an @At("NEW") target: "pkg/Class", "Lpkg/Class;", "pkg.Class" or "(args)Lpkg/Class;". */
export function newClassOf(spec: string): string {
  return spec.trim().replace(/^\(.*\)L(.+);$/, "$1").replace(/^L(.+);$/, "$1").replace(/\./g, "/");
}

export function parseSelector(sel: string): Selector {
  let s = sel.trim();
  let owner: string | undefined;
  const om = /^L([^;]+);/.exec(s);
  if (om) {
    owner = om[1];
    s = s.slice(om[0].length);
  } else {
    const dot = /^([\w/$]+)\.([\w$<>*]+(?:\(.*|:.*)?)$/.exec(s);
    if (dot && dot[1]!.includes("/")) {
      owner = dot[1];
      s = dot[2]!;
    }
  }
  const p = s.indexOf("(");
  if (p >= 0) return { owner, name: s.slice(0, p), desc: s.slice(p) };
  const c = s.indexOf(":");
  if (c >= 0) return { owner, name: s.slice(0, c), fieldDesc: s.slice(c + 1) };
  return { owner, name: s };
}

const nameMatches = (pattern: string, name: string) =>
  pattern.includes("*") ? new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`).test(name) : pattern === name;

export function similar(name: string, candidates: string[], max = 6): string[] {
  const l = name.toLowerCase();
  const dist = (a: string, b: string) => {
    const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
    for (let j = 1; j <= b.length; j++) dp[0]![j] = j;
    for (let i = 1; i <= a.length; i++)
      for (let j = 1; j <= b.length; j++) dp[i]![j] = Math.min(dp[i - 1]![j]! + 1, dp[i]![j - 1]! + 1, dp[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    return dp[a.length]![b.length]!;
  };
  return [...new Set(candidates)]
    .map((c) => ({ c, d: c.toLowerCase().includes(l) || l.includes(c.toLowerCase()) ? 0 : dist(l, c.toLowerCase()) }))
    .filter((x) => x.d <= Math.max(2, Math.floor(l.length / 3)))
    .sort((a, b) => a.d - b.d)
    .slice(0, max)
    .map((x) => x.c);
}

interface TargetMethod {
  owner: string;
  name: string;
  desc: string;
  access: number;
}

// ---------------- constants / jumps / locals helpers ----------------

export interface ConstSpec {
  type: TypedConstant["type"];
  value: string;
  /** @Constant(expandZeroConditions = …) / args "expandZeroConditions=…" */
  expandZero?: boolean;
}

const CONST_KEYS: Record<string, TypedConstant["type"]> = { intValue: "int", floatValue: "float", longValue: "long", doubleValue: "double", stringValue: "string", classValue: "class", nullValue: "null" };
export const CONST_DESC: Record<TypedConstant["type"], string> = { int: "I", float: "F", long: "J", double: "D", string: "Ljava/lang/String;", class: "Ljava/lang/Class;", null: "Ljava/lang/Object;" };

/** From @At("CONSTANT") args, e.g. {"intValue=5"}, {"stringValue=foo"}, {"nullValue=true"}. */
export function constFromArgs(args: string[]): ConstSpec | undefined {
  let spec: ConstSpec | undefined;
  let expand = false;
  for (const a of args) {
    const m = /^\s*(\w+)\s*=\s*(.*)$/.exec(a);
    if (!m) continue;
    if (m[1] === "expandZeroConditions") expand = true;
    const t = CONST_KEYS[m[1]!];
    if (t) spec = { type: t, value: normConst(t, m[2]!.trim()) };
  }
  return spec ? { ...spec, expandZero: expand } : undefined;
}

/** From @Constant(intValue = 5) and friends. */
export function constFromAnn(c: Annotation): ConstSpec | undefined {
  for (const [k, t] of Object.entries(CONST_KEYS)) {
    const v = c.args[k];
    if (!v) continue;
    const raw = v.t === "class" ? v.v : v.t === "bool" ? String(v.v) : String(v.v);
    return { type: t, value: normConst(t, raw), expandZero: !!c.args.expandZeroConditions };
  }
  return undefined;
}

function normConst(t: TypedConstant["type"], raw: string): string {
  if (t === "class") return raw.replace(/\.class$/, "").replace(/^L(.+);$/, "$1").replace(/\./g, "/");
  if (t === "string") return raw.replace(/^"|"$/g, "");
  if (t === "null") return "null";
  return raw.replace(/[lLfFdD_]$/g, "").replace(/_/g, "");
}

export function constMatches(spec: ConstSpec, c: TypedConstant): boolean {
  if (spec.type !== c.type) return false;
  switch (spec.type) {
    case "int":
    case "double":
      return Number(spec.value) === Number(c.value);
    case "float":
      return Math.fround(Number(spec.value)) === Math.fround(Number(c.value));
    case "long":
      try {
        return BigInt(spec.value) === BigInt(c.value);
      } catch {
        return false;
      }
    case "class":
      return spec.value === c.value || c.value.endsWith(`/${spec.value}`);
    default:
      return spec.value === c.value;
  }
}

export const JUMP_OPCODES: Record<string, number> = {
  IFEQ: 153, IFNE: 154, IFLT: 155, IFGE: 156, IFGT: 157, IFLE: 158, IF_ICMPEQ: 159, IF_ICMPNE: 160, IF_ICMPLT: 161, IF_ICMPGE: 162,
  IF_ICMPGT: 163, IF_ICMPLE: 164, IF_ACMPEQ: 165, IF_ACMPNE: 166, GOTO: 167, JSR: 168, IFNULL: 198, IFNONNULL: 199, GOTO_W: 200, JSR_W: 201,
};
const JUMP_NAME = Object.fromEntries(Object.entries(JUMP_OPCODES).map(([k, v]) => [v, k]));
function opcodeOf(v: Annotation["args"][string] | undefined): number | undefined {
  if (!v) return undefined;
  if (v.t === "num") return Number(v.v);
  if (v.t === "ident") return JUMP_OPCODES[v.v.replace(/^.*\./, "")];
  return undefined;
}
/** Local variable category used by xLOAD/xSTORE for a type descriptor. */
export const localCategory = (d: string): "I" | "J" | "F" | "D" | "A" => (/^[ZBCSI]$/.test(d) ? "I" : d === "J" ? "J" : d === "F" ? "F" : d === "D" ? "D" : "A");

export class MixinValidator {
  constructor(readonly ctx: ValidateContext) {}

  private exists = (internal: string) => this.ctx.index.classes.has(internal);

  private typeDesc(p: ParsedJava, t: string): string | undefined {
    return resolveType(p, t, this.exists).desc;
  }

  /** Validate one mixin source. `section` is the mixins.json list it is registered in. */
  validateSource(text: string, file: string, section?: string): { issues: MixinIssue[]; targets: string[]; className: string } {
    const issues: MixinIssue[] = [];
    const p = parseJava(text);
    const push = (i: Omit<MixinIssue, "file" | "mixin">) => issues.push({ ...i, file, mixin: p.className });
    for (const pr of p.problems) push({ severity: "warning", message: `Parser: ${pr}` });
    const mixinAnn = p.classAnnotations.find((a) => a.name === "Mixin");
    if (!mixinAnn) {
      push({ severity: "error", message: "No @Mixin annotation on the class." });
      return { issues, targets: [], className: p.className };
    }
    const targets: string[] = [];
    for (const c of classesOf(mixinAnn.args.value)) {
      const d = this.typeDesc(p, c);
      if (d) targets.push(d.slice(1, -1));
      else push({ severity: "error", message: `Cannot resolve @Mixin target ${c} (missing import?).` });
    }
    for (const t of strsOf(mixinAnn.args.targets)) {
      const internal = t.replace(/\./g, "/");
      const r = this.ctx.index.resolve(internal);
      targets.push(r.length === 1 ? r[0]! : internal);
    }
    if (!targets.length) push({ severity: "error", message: "@Mixin has no targets." });
    const remapDefault = boolOf(mixinAnn.args.remap) ?? true;
    const known: string[] = [];
    for (const t of targets) {
      if (this.exists(t)) {
        known.push(t);
        if (section === "mixins" && CLIENT_ONLY.test(t)) {
          push({ severity: "warning", message: `${t.replace(/\//g, ".")} is client-only but this mixin is in the common "mixins" list — a dedicated server will crash loading it.`, suggestion: 'Move it to the "client" list.' });
        }
      } else if (isMcLike(t)) {
        const sugg = this.ctx.index.search(t.slice(t.lastIndexOf("/") + 1), "class", 5).map((h) => h.name.replace(/\//g, "."));
        push({ severity: "error", missing: { owner: t, name: t, kind: "class" }, message: `Target class ${t.replace(/\//g, ".")} does not exist in Minecraft ${this.ctx.index.meta.mcVersion} (${this.ctx.index.meta.namespace} names).`, suggestion: sugg.length ? `Similar: ${sugg.join(", ")}` : undefined });
      } else {
        push({ severity: "info", message: `Target ${t.replace(/\//g, ".")} is not a Minecraft class; FFN cannot verify members on it${this.ctx.vanillaForLoader ? " (use source=project to include loader classes)" : ""}.` });
      }
    }
    if (p.isInterface && p.members.some((m) => m.annotations.some((a) => INJECTORS.includes(a.name)))) {
      push({ severity: "warning", message: "Injectors inside an interface mixin need Java 9+ private interface methods and Mixin support; prefer an abstract class." });
    }
    for (const m of p.members) {
      for (const a of m.annotations) {
        if (MIXINEXTRAS.has(a.name) && !this.ctx.mixinExtrasAvailable) {
          push({ severity: "error", message: `@${a.name} is MixinExtras, which is not available in this project.`, suggestion: this.ctx.profile?.mixin.mixinExtras.note ?? "Add MixinExtras as a dependency." });
        }
      }
      const remap = (a: Annotation) => boolOf(a.args.remap) ?? remapDefault;
      for (const t of known) this.checkMember(p, m, t, (i) => push({ ...i, line: i.line ?? m.line }), remap);
    }
    return { issues, targets, className: p.className };
  }

  private targetMethods(owner: string, selectors: string[]): { matched: TargetMethod[]; missing: string[]; ambiguous: string[] } {
    const c = this.ctx.index.get(owner)!;
    const matched: TargetMethod[] = [];
    const missing: string[] = [];
    const ambiguous: string[] = [];
    for (const raw of selectors) {
      const sel = parseSelector(raw);
      const hits = c.m.filter(([n, d]) => nameMatches(sel.name, n) && (!sel.desc || sel.desc === d));
      if (!hits.length) missing.push(raw);
      else {
        if (!sel.desc && !sel.name.includes("*") && hits.length > 1) ambiguous.push(`${raw} → ${hits.map(([n, d]) => n + d).join(", ")}`);
        for (const [n, d, a] of hits) matched.push({ owner, name: n, desc: d, access: a });
      }
    }
    return { matched, missing, ambiguous };
  }

  private refsOf(t: TargetMethod): CodeRefs | undefined {
    const r = this.ctx.index.reader(t.owner);
    const m = r?.info.methods.find((x) => x.name === t.name && x.desc === t.desc);
    return r && m ? r.analyze(m) : undefined;
  }

  private related(a: string, b: string): boolean {
    if (a === b) return true;
    return this.ctx.index.hierarchy(a).some((c) => c.n === b) || this.ctx.index.hierarchy(b).some((c) => c.n === a);
  }

  private checkMember(p: ParsedJava, m: ParsedMember, target: string, push: (i: MixinIssue) => void, remapOf: (a: Annotation) => boolean): void {
    const idx = this.ctx.index;
    const cls = idx.get(target)!;
    const tname = target.replace(/\//g, ".");
    if (m.kind === "method" && m.annotations.some((a) => INJECTORS.includes(a.name) || a.name === "Accessor" || a.name === "Invoker")) {
      const params = m.params.map((x) => this.typeDesc(p, x.type));
      const ret = this.typeDesc(p, m.type);
      if (params.every(Boolean) && ret) {
        const desc = `(${params.join("")})${ret}`;
        const owner = idx.hierarchy(target).find((h) => h.m.some(([n, d]) => n === m.name && d === desc));
        if (owner) {
          push({
            severity: "error",
            message: `Mixin method ${m.name}${desc} has the same name and descriptor as a method in ${owner.n.replace(/\//g, ".")}; Mixin refuses to merge it ("cannot overwrite method … @Overwrite is required").`,
            suggestion: `Rename it, e.g. ${this.ctx.project.modId ?? "modid"}$${m.name}${m.annotations.some((a) => a.name === "Accessor" || a.name === "Invoker") ? " (keep the annotation value pointing at the real member)" : ""}.`,
          });
        }
      }
    }
    for (const a of m.annotations) {
      if (INJECTORS.includes(a.name)) {
        const selectors = strsOf(a.args.method);
        if (!selectors.length && !a.args.target) {
          push({ severity: "error", message: `@${a.name} on ${m.name} has no method = "...".` });
          continue;
        }
        const { matched, missing, ambiguous } = this.targetMethods(target, selectors);
        for (const s of missing) {
          const sel = parseSelector(s);
          const names = cls.m.map(([n]) => n);
          const sugg = similar(sel.name, names);
          const overloads = cls.m.filter(([n]) => n === sel.name).map(([n, d]) => n + d);
          const inherited = idx.hierarchy(target).slice(1).find((h) => h.m.some(([n]) => n === sel.name));
          push({
            severity: remapOf(a) || isMcLike(target) ? "error" : "warning",
            message: overloads.length
              ? `@${a.name} ${m.name}: descriptor of "${s}" matches no overload in ${tname}. Overloads: ${overloads.join(", ")}.`
              : `@${a.name} ${m.name}: method "${s}" not found in ${tname}${inherited ? ` (it is declared in ${inherited.n.replace(/\//g, ".")} — mixin that class instead, or override it)` : ""}.`,
            ...(overloads.length ? {} : { missing: { owner: target, name: sel.name, kind: "method" as const } }),
            suggestion: overloads.length ? "Use one of the listed descriptors." : sugg.length ? `Did you mean: ${sugg.join(", ")}?` : this.ctx.vanillaForLoader ? "If this method is added by the loader, re-run with source=project." : "Check get_class / mixin_targets for the real method names.",
          });
        }
        for (const s of ambiguous) push({ severity: "warning", message: `@${a.name} ${m.name}: selector ${s} — overloaded; add the descriptor so the right method is targeted.` });
        if (!matched.length) continue;
        const ats = annsOf(a.args.at);
        if (["Inject", "Redirect", "ModifyArg", "ModifyArgs", "ModifyVariable", "WrapOperation", "WrapWithCondition", "ModifyExpressionValue", "ModifyReturnValue", "ModifyReceiver"].includes(a.name) && !ats.length) {
          push({ severity: "error", message: `@${a.name} ${m.name}: missing at = @At(...).` });
        }
        const invoked: { owner?: string; name: string; desc?: string; kind: string }[] = [];
        for (const at of ats) {
          const r = this.checkAt(at, matched, a.name, m.name, push);
          if (r) invoked.push(r);
        }
        if (a.name === "ModifyConstant") this.checkModifyConstant(p, m, a, matched, push);
        if (a.name === "ModifyVariable") this.checkLocals(p, m, a, ats, matched, push);
        this.checkSlices(a, ats, matched, m.name, push);
        this.checkHandler(p, m, a, matched, invoked[0], push);
      } else if (a.name === "Accessor" || a.name === "Invoker") {
        this.checkAccessor(p, m, a, target, push);
      } else if (a.name === "Shadow" || a.name === "Overwrite") {
        this.checkShadow(p, m, a, target, push);
      }
    }
  }

  private checkAt(at: Annotation, methods: TargetMethod[], ann: string, handler: string, push: (i: MixinIssue) => void) {
    const value = strOf(at.args.value) ?? "";
    const target = strOf(at.args.target);
    const where = methods.map((t) => t.name + t.desc).join(", ");
    switch (value) {
      case "HEAD":
        if (methods.some((t) => t.name === "<init>") && ann === "Inject") {
          push({ severity: "warning", message: `@Inject ${handler}: HEAD of a constructor is not a valid injection point before super() — use RETURN/TAIL (or MixinExtras' constructor support).` });
        }
        return undefined;
      case "RETURN":
      case "TAIL":
        return undefined;
      case "INVOKE":
      case "INVOKE_ASSIGN":
      case "INVOKE_STRING": {
        if (!target) {
          push({ severity: "error", message: `@${ann} ${handler}: @At("${value}") needs target = "Lowner;name(desc)ret".` });
          return undefined;
        }
        const sel = parseSelector(target);
        if (sel.owner && isMcLike(sel.owner) && !this.ctx.index.classes.has(sel.owner)) {
          push({ severity: "error", missing: { owner: sel.owner, name: sel.owner, kind: "class" }, message: `@${ann} ${handler}: @At target owner ${sel.owner.replace(/\//g, ".")} does not exist.` });
          return undefined;
        }
        let found = false;
        const similarCalls: string[] = [];
        let analyzed = false;
        for (const t of methods) {
          const refs = this.refsOf(t);
          if (!refs) continue;
          analyzed = true;
          for (const inv of refs.invokes) {
            const nameOk = nameMatches(sel.name, inv.name);
            if (nameOk && (!sel.desc || sel.desc === inv.desc) && (!sel.owner || this.related(sel.owner, inv.owner))) found = true;
            else if (nameOk || (sel.owner && inv.owner === sel.owner)) similarCalls.push(`L${inv.owner};${inv.name}${inv.desc}`);
          }
        }
        if (analyzed && !found) {
          const lambdas = this.lambdaCallers(methods, sel);
          const ownerHas = sel.owner && this.ctx.index.classes.has(sel.owner) ? this.ctx.index.hierarchy(sel.owner).some((h) => h.m.some(([n]) => n === sel.name)) : true;
          push({
            severity: "error",
            ...(ownerHas ? {} : { missing: { owner: sel.owner!, name: sel.name, kind: "method" as const } }),
            message: `@${ann} ${handler}: ${where} never calls ${target}.`,
            suggestion: lambdas.length
              ? `The call is inside a lambda: target method ${lambdas.join(" or ")} instead.`
              : similarCalls.length
                ? `Similar calls in the target: ${[...new Set(similarCalls)].slice(0, 6).join(", ")}`
                : "List the real calls with mixin_targets.",
          });
        }
        return { owner: sel.owner, name: sel.name, desc: sel.desc, kind: "INVOKE" };
      }
      case "FIELD": {
        if (!target) {
          push({ severity: "error", message: `@${ann} ${handler}: @At("FIELD") needs target = "Lowner;name:type".` });
          return undefined;
        }
        const sel = parseSelector(target);
        let found = false;
        let analyzed = false;
        const near: string[] = [];
        for (const t of methods) {
          const refs = this.refsOf(t);
          if (!refs) continue;
          analyzed = true;
          for (const f of refs.fields) {
            if (f.name === sel.name && (!sel.fieldDesc || sel.fieldDesc === f.desc) && (!sel.owner || this.related(sel.owner, f.owner))) found = true;
            else if (f.name === sel.name || f.owner === sel.owner) near.push(`L${f.owner};${f.name}:${f.desc}`);
          }
        }
        if (analyzed && !found) push({ severity: "error", message: `@${ann} ${handler}: ${where} never accesses field ${target}.`, suggestion: near.length ? `Field accesses with similar names/owner: ${[...new Set(near)].slice(0, 6).join(", ")}` : undefined });
        return { owner: sel.owner, name: sel.name, desc: sel.fieldDesc, kind: "FIELD" };
      }
      case "NEW": {
        const spec = target ?? strsOf(at.args.args).find((x) => x.startsWith("class="))?.slice(6) ?? "";
        const cls = newClassOf(spec);
        if (!cls) {
          push({ severity: "error", message: `@${ann} ${handler}: @At("NEW") needs target = "pkg/Class" or "(args)Lpkg/Class;".` });
          return undefined;
        }
        const ctorDesc = /^\((.*)\)L.+;$/.exec(spec.trim()) ? `(${/^\((.*)\)/.exec(spec.trim())![1]})V` : undefined;
        let ok = false;
        const created = new Set<string>();
        const ctors = new Set<string>();
        for (const t of methods) {
          const refs = this.refsOf(t);
          if (!refs) continue;
          refs.news.forEach((n) => created.add(n));
          if (refs.news.includes(cls)) {
            const inits = refs.invokes.filter((i) => i.owner === cls && i.name === "<init>").map((i) => i.desc);
            inits.forEach((d) => ctors.add(d));
            if (!ctorDesc || inits.includes(ctorDesc)) ok = true;
          }
        }
        if (!ok)
          push({
            severity: "error",
            message: ctors.size ? `@${ann} ${handler}: ${where} creates ${cls.replace(/\//g, ".")} but never with constructor ${ctorDesc}.` : `@${ann} ${handler}: ${where} never creates ${cls.replace(/\//g, ".")}.`,
            suggestion: ctors.size ? `Constructors used: ${[...ctors].join(", ")}` : created.size ? `Objects created there: ${[...created].slice(0, 10).map((c) => c.replace(/\//g, ".")).join(", ")}` : undefined,
          });
        return { name: "<init>", owner: cls, desc: ctorDesc ?? [...ctors][0], kind: "NEW" };
      }
      case "CONSTANT": {
        const spec = constFromArgs(strsOf(at.args.args));
        if (!spec) {
          push({ severity: "error", message: `@${ann} ${handler}: @At("CONSTANT") needs args = "intValue=…" (or floatValue/longValue/doubleValue/stringValue/classValue/nullValue=true).` });
          return undefined;
        }
        this.checkConstantPresent(spec, methods, numOf(at.args.ordinal), `@${ann} ${handler}`, push);
        return { name: spec.value, desc: CONST_DESC[spec.type], kind: "CONSTANT" };
      }
      case "JUMP": {
        const opcode = opcodeOf(at.args.opcode);
        const ordinal = numOf(at.args.ordinal);
        let analyzed = false;
        const present: number[] = [];
        for (const t of methods) {
          const refs = this.refsOf(t);
          if (!refs) continue;
          analyzed = true;
          present.push(...refs.jumpOps.map((j) => j.opcode));
        }
        if (!analyzed) return undefined;
        const hits = opcode === undefined ? present : present.filter((o) => o === opcode);
        if (!hits.length)
          push({
            severity: "error",
            message: `@${ann} ${handler}: ${where} has no ${opcode === undefined ? "jump instructions" : `${JUMP_NAME[opcode] ?? opcode} jump`}.`,
            suggestion: present.length ? `Jumps present: ${[...new Set(present)].map((o) => JUMP_NAME[o] ?? o).join(", ")}` : "The method has no branches; use another injection point.",
          });
        else if (ordinal !== undefined && ordinal >= hits.length) push({ severity: "error", message: `@${ann} ${handler}: ordinal = ${ordinal} but there are only ${hits.length} matching jump(s).` });
        else if (opcode === undefined && ordinal === undefined && hits.length > 1) push({ severity: "warning", message: `@${ann} ${handler}: @At("JUMP") without opcode/ordinal matches all ${hits.length} jumps; set opcode = Opcodes.X and ordinal.` });
        return undefined;
      }
      case "LOAD":
      case "STORE": {
        let any = false;
        for (const t of methods) if (this.refsOf(t)?.locals.some((l) => l.kind === value)) any = true;
        if (!any && methods.some((t) => this.refsOf(t))) push({ severity: "error", message: `@${ann} ${handler}: ${where} has no ${value === "LOAD" ? "local variable loads" : "local variable stores"}.` });
        return undefined;
      }
      case "MIXINEXTRAS:EXPRESSION":
      case "CONSTANT_EXPRESSION":
        push({ severity: "info", message: `@${ann} ${handler}: @At("${value}") is not checked in detail by FFN.` });
        return undefined;
      default:
        push({ severity: "warning", message: `@${ann} ${handler}: unknown injection point "${value}".` });
        return undefined;
    }
  }

  private checkConstantPresent(spec: ConstSpec, methods: TargetMethod[], ordinal: number | undefined, label: string, push: (i: MixinIssue) => void): void {
    let analyzed = false;
    let hits = 0;
    const sameType = new Set<string>();
    let zeroJumps = 0;
    for (const t of methods) {
      const refs = this.refsOf(t);
      if (!refs) continue;
      analyzed = true;
      for (const c of refs.typedConstants) {
        if (constMatches(spec, c)) hits++;
        else if (c.type === spec.type) sameType.add(c.value);
      }
      zeroJumps += refs.jumpOps.filter((j) => j.opcode >= 153 && j.opcode <= 158).length;
    }
    if (!analyzed) return;
    const shown = spec.type === "string" ? JSON.stringify(spec.value) : spec.value;
    if (!hits) {
      const zero = spec.type === "int" && Number(spec.value) === 0 && zeroJumps > 0;
      if (zero && spec.expandZero) return; // comparisons against zero compile to IFxx without a constant
      push({
        severity: "error",
        message: `${label}: ${methods.map((t) => t.name + t.desc).join(", ")} never pushes the ${spec.type} constant ${shown}.`,
        suggestion: zero
          ? "Comparisons with 0 compile to IFEQ/IFLT/… with no constant: add expandZeroConditions = Constant.Condition.… (or target the JUMP)."
          : sameType.size
            ? `${spec.type} constants present: ${[...sameType].slice(0, 12).join(", ")}${spec.type === "int" ? " (note: javac folds constant expressions, and byte/short/char use int constants)" : ""}`
            : `No ${spec.type} constants in the target.`,
      });
    } else if (ordinal !== undefined && ordinal >= hits) push({ severity: "error", message: `${label}: ordinal = ${ordinal} but the constant ${shown} occurs only ${hits} time(s).` });
  }

  private checkModifyConstant(p: ParsedJava, m: ParsedMember, a: Annotation, methods: TargetMethod[], push: (i: MixinIssue) => void): void {
    const consts = annsOf(a.args.constant);
    const label = `@ModifyConstant ${m.name}`;
    if (!consts.length) {
      push({ severity: "warning", message: `${label}: no constant = @Constant(...) — Mixin then matches EVERY constant of the handler's type; specify the value.` });
      return;
    }
    const ret = this.typeDesc(p, m.type);
    const p0 = m.params[0] ? this.typeDesc(p, m.params[0].type) : undefined;
    for (const c of consts) {
      const spec = constFromAnn(c);
      if (!spec) {
        push({ severity: "error", message: `${label}: @Constant needs one of intValue/floatValue/longValue/doubleValue/stringValue/classValue/nullValue.` });
        continue;
      }
      this.checkConstantPresent(spec, methods, numOf(c.args.ordinal), label, push);
      const want = CONST_DESC[spec.type];
      if (spec.type !== "null") {
        if (ret && ret !== want) push({ severity: "error", message: `${label}: handler must return ${want} (type of the ${spec.type} constant), got ${ret}.` });
        if (p0 && p0 !== want) push({ severity: "error", message: `${label}: first parameter must be ${want}, got ${p0}.` });
      }
    }
  }

  private checkLocals(p: ParsedJava, m: ParsedMember, a: Annotation, ats: Annotation[], methods: TargetMethod[], push: (i: MixinIssue) => void): void {
    const p0 = m.params[0] ? this.typeDesc(p, m.params[0].type) : undefined;
    if (!p0 || boolOf(a.args.argsOnly)) return;
    const cat = localCategory(p0);
    const index = numOf(a.args.index);
    const ordinal = numOf(a.args.ordinal);
    const names = strsOf(a.args.name);
    const label = `@ModifyVariable ${m.name}`;
    const kinds = new Set(ats.map((x) => strOf(x.args.value)).filter((v) => v === "LOAD" || v === "STORE"));
    for (const t of methods) {
      const r = this.ctx.index.reader(t.owner);
      const mi = r?.info.methods.find((x) => x.name === t.name && x.desc === t.desc);
      const refs = mi ? r!.analyze(mi) : undefined;
      if (!refs) continue;
      const rel = refs.locals.filter((l) => l.type === cat && (!kinds.size || kinds.has(l.kind)));
      const idx = [...new Set(rel.map((l) => l.index))].sort((x, y) => x - y);
      const tl = `${label} → ${t.name}${t.desc}`;
      if (!idx.length) {
        push({ severity: "error", message: `${tl}: no ${kinds.size ? [...kinds].join("/") + " of a" : ""} ${p0} (${cat}) local variable in the target.` });
        continue;
      }
      if (index !== undefined && !idx.includes(index)) push({ severity: "error", message: `${tl}: index = ${index} is not a ${cat}-type local used there; indices: ${idx.join(", ")}.` });
      if (names.length) {
        const lvt = mi?.localVariables ?? [];
        if (!lvt.length) push({ severity: "warning", message: `${tl}: name = ${names.join("/")} cannot be checked — this jar has no local variable table (names are only available in dev with LVT); use ordinal or index.` });
        else if (!names.some((n) => lvt.some((v) => v.name === n))) push({ severity: "error", message: `${tl}: no local named ${names.join("/")}. Locals of that type: ${lvt.filter((v) => localCategory(v.desc) === cat).map((v) => v.name).join(", ") || "none"}.` });
      }
      if (ordinal !== undefined) {
        const firstLocal = (t.access & ACC.STATIC ? 0 : 1) + parseMethodDesc(t.desc).params.reduce((n, d) => n + (d === "J" || d === "D" ? 2 : 1), 0);
        const locals = idx.filter((i) => i >= firstLocal);
        if (ordinal >= locals.length) push({ severity: "warning", message: `${tl}: ordinal = ${ordinal} but only ${locals.length} ${cat}-type local(s) beyond the parameters were found (indices ${locals.join(", ") || "none"}); slots may be reused, so verify in the bytecode.` });
      }
      if (index === undefined && ordinal === undefined && !names.length && idx.length > 1)
        push({ severity: "warning", message: `${tl}: ${idx.length} ${cat}-type locals (slots ${idx.join(", ")}) — implicit selection fails when more than one is in scope; set ordinal, index or name.` });
    }
  }

  /** Positions (bytecode offsets) an @At matches in one target method; undefined = not computable. */
  private positions(at: Annotation, t: TargetMethod): number[] | undefined {
    const refs = this.refsOf(t);
    if (!refs) return undefined;
    const value = strOf(at.args.value) ?? "";
    const target = strOf(at.args.target);
    const seq = refs.seq;
    let out: number[] | undefined;
    switch (value) {
      case "HEAD":
        return [0];
      case "RETURN":
        out = seq.filter((x) => x.kind === "RETURN").map((x) => x.pc);
        break;
      case "TAIL": {
        const r = seq.filter((x) => x.kind === "RETURN");
        return r.length ? [r[r.length - 1]!.pc] : [];
      }
      case "INVOKE":
      case "INVOKE_ASSIGN":
      case "INVOKE_STRING": {
        if (!target) return undefined;
        const sel = parseSelector(target);
        out = seq
          .filter((x) => {
            if (x.kind !== "INVOKE") return false;
            const mm = /^L(.+?);([^(]+)(\(.*)$/.exec(x.key);
            return !!mm && nameMatches(sel.name, mm[2]!) && (!sel.desc || sel.desc === mm[3]) && (!sel.owner || this.related(sel.owner, mm[1]!));
          })
          .map((x) => x.pc);
        break;
      }
      case "FIELD": {
        if (!target) return undefined;
        const sel = parseSelector(target);
        const op = opcodeOf(at.args.opcode);
        const opName = op === undefined ? undefined : ({ 178: "GETSTATIC", 179: "PUTSTATIC", 180: "GETFIELD", 181: "PUTFIELD" } as Record<number, string>)[op];
        out = seq
          .filter((x) => {
            if (x.kind !== "FIELD" || (opName && x.opcode !== opName)) return false;
            const mm = /^L(.+?);([^:]+):(.+)$/.exec(x.key);
            return !!mm && mm[2] === sel.name && (!sel.fieldDesc || sel.fieldDesc === mm[3]) && (!sel.owner || this.related(sel.owner, mm[1]!));
          })
          .map((x) => x.pc);
        break;
      }
      case "NEW": {
        const cls = newClassOf(target ?? strsOf(at.args.args).find((x) => x.startsWith("class="))?.slice(6) ?? "");
        if (!cls) return undefined;
        out = seq.filter((x) => x.kind === "NEW" && x.key === cls).map((x) => x.pc);
        break;
      }
      case "CONSTANT": {
        const spec = constFromArgs(strsOf(at.args.args));
        if (!spec) return undefined;
        out = refs.typedConstants.filter((c) => constMatches(spec, c)).map((c) => c.pc);
        break;
      }
      case "JUMP": {
        const op = opcodeOf(at.args.opcode);
        out = refs.jumpOps.filter((j) => op === undefined || j.opcode === op).map((j) => j.pc);
        break;
      }
      default:
        return undefined;
    }
    const ordinal = numOf(at.args.ordinal);
    if (ordinal !== undefined && out) return out[ordinal] !== undefined ? [out[ordinal]!] : [];
    return out;
  }

  /** @Slice(from = @At, to = @At): both anchors must exist, from must precede to, and the injection point must fall inside. */
  private checkSlices(a: Annotation, ats: Annotation[], methods: TargetMethod[], handler: string, push: (i: MixinIssue) => void): void {
    const slices = annsOf(a.args.slice);
    if (!slices.length) return;
    const label = `@${a.name} ${handler}`;
    const constants = a.name === "ModifyConstant" ? annsOf(a.args.constant).map(constFromAnn).filter((c): c is ConstSpec => !!c) : [];
    for (const sl of slices) {
      const id = strOf(sl.args.id) ?? "";
      const from = annsOf(sl.args.from)[0];
      const to = annsOf(sl.args.to)[0];
      if (!from && !to) {
        push({ severity: "warning", message: `${label}: @Slice${id ? `(id = "${id}")` : ""} has neither from nor to; it selects the whole method.` });
        continue;
      }
      for (const [k, anchor] of [["from", from], ["to", to]] as const) if (anchor) this.checkAt(anchor, methods, `${a.name} slice.${k}`, handler, push);
      const mine = ats.filter((x) => (strOf(x.args.slice) ?? "") === id);
      for (const t of methods) {
        const fromPos = from ? this.positions(from, t) : [0];
        const toPos = to ? this.positions(to, t) : [Number.MAX_SAFE_INTEGER];
        if (!fromPos || !toPos || !fromPos.length || !toPos.length) continue; // unknown or already reported
        const lo = Math.min(...fromPos);
        const hi = Math.max(...toPos);
        if (lo > hi) {
          push({ severity: "error", message: `${label} → ${t.name}${t.desc}: the slice is empty — its "from" point (offset ${lo}) comes after its "to" point (offset ${hi}).` });
          continue;
        }
        const targets: number[][] = [];
        for (const at of mine) {
          const pos = this.positions(at, t);
          if (pos) targets.push(pos);
        }
        for (const c of constants) {
          const refs = this.refsOf(t);
          if (refs) targets.push(refs.typedConstants.filter((x) => constMatches(c, x)).map((x) => x.pc));
        }
        for (const pos of targets) {
          if (pos.length && !pos.some((x) => x >= lo && x <= hi))
            push({ severity: "error", message: `${label} → ${t.name}${t.desc}: the injection point occurs only outside the slice (offsets ${pos.join(", ")}; slice ${lo}..${hi === Number.MAX_SAFE_INTEGER ? "end" : hi}).`, suggestion: "Move the slice anchors or drop the slice." });
        }
      }
    }
  }

  private lambdaCallers(methods: TargetMethod[], sel: { owner?: string; name: string; desc?: string }): string[] {
    const out: string[] = [];
    const owner = methods[0]!.owner;
    const c = this.ctx.index.get(owner)!;
    for (const [n, d, a] of c.m) {
      if (!(a & ACC.SYNTHETIC) || !n.startsWith("lambda$")) continue;
      if (!methods.some((t) => n.startsWith(`lambda$${t.name.replace(/[<>]/g, "")}$`))) continue;
      const refs = this.refsOf({ owner, name: n, desc: d, access: a });
      if (refs?.invokes.some((i) => i.name === sel.name && (!sel.desc || i.desc === sel.desc))) out.push(`"${n}${d}"`);
    }
    return out;
  }

  private checkHandler(p: ParsedJava, m: ParsedMember, a: Annotation, methods: TargetMethod[], invoked: { owner?: string; name: string; desc?: string; kind: string } | undefined, push: (i: MixinIssue) => void) {
    const params = m.params.map((x) => ({ ...x, desc: this.typeDesc(p, x.type) }));
    const ret = this.typeDesc(p, m.type);
    const isStatic = m.modifiers.includes("static");
    const simple = (t: string) => t.replace(/<.*>/g, "").replace(/.*\./, "");
    const unresolved = params.filter((x) => !x.desc).map((x) => x.type);
    for (const t of methods) {
      const { params: tp, ret: tr } = parseMethodDesc(t.desc);
      const tStatic = !!(t.access & ACC.STATIC);
      const label = `@${a.name} ${m.name} → ${t.name}${t.desc}`;
      if (["Inject", "Redirect", "ModifyArg", "ModifyVariable", "WrapOperation", "ModifyExpressionValue", "ModifyReturnValue", "WrapMethod", "WrapWithCondition"].includes(a.name) && tStatic !== isStatic) {
        push({ severity: "error", message: `${label}: handler must ${tStatic ? "" : "not "}be static (target is ${tStatic ? "" : "not "}static).` });
      }
      if (a.name === "Inject") {
        const ciIdx = params.findIndex((x) => /^CallbackInfo(Returnable)?$/.test(simple(x.type)));
        if (ciIdx < 0) {
          push({ severity: "error", message: `${label}: handler needs a CallbackInfo${tr === "V" ? "" : "Returnable"} parameter.` });
          continue;
        }
        const ciType = simple(params[ciIdx]!.type);
        if (tr === "V" && ciType === "CallbackInfoReturnable") push({ severity: "error", message: `${label}: target returns void — use CallbackInfo, not CallbackInfoReturnable.` });
        if (tr !== "V" && ciType === "CallbackInfo") {
          push({ severity: "error", message: `${label}: target returns ${tr}; the handler must take CallbackInfoReturnable<${boxed(tr).slice(1, -1).replace(/.*\//, "")}> instead of CallbackInfo.` });
        }
        if (ciIdx > 0) {
          if (ciIdx !== tp.length) push({ severity: "error", message: `${label}: handler has ${ciIdx} parameter(s) before CallbackInfo, target has ${tp.length}. Capture all target parameters or none.` });
          else
            for (let k = 0; k < ciIdx; k++) {
              const d = params[k]!.desc;
              if (d && d !== tp[k]) push({ severity: "error", message: `${label}: parameter ${k + 1} is ${d}, target has ${tp[k]}.` });
            }
        }
      } else if (a.name === "ModifyReturnValue") {
        if (ret && ret !== tr) push({ severity: "error", message: `${label}: handler must return ${tr} (got ${ret}).` });
        if (params[0]?.desc && params[0].desc !== tr) push({ severity: "error", message: `${label}: first parameter must be ${tr}.` });
      } else if (a.name === "WrapMethod") {
        const opIdx = params.findIndex((x) => simple(x.type) === "Operation");
        if (opIdx !== tp.length) push({ severity: "error", message: `${label}: expected the ${tp.length} target parameter(s) followed by Operation<${boxed(tr).slice(1, -1).replace(/.*\//, "")}>.` });
        if (ret && ret !== tr) push({ severity: "error", message: `${label}: handler must return ${tr}.` });
      } else if ((a.name === "Redirect" || a.name === "WrapOperation" || a.name === "ModifyExpressionValue" || a.name === "WrapWithCondition" || a.name === "ModifyArg") && invoked?.kind === "INVOKE" && invoked.desc) {
        const { params: ip, ret: ir } = parseMethodDesc(invoked.desc);
        const recv = this.receiver(invoked, methods);
        const base = [...(recv ? [`L${recv};`] : []), ...ip];
        if (a.name === "Redirect" || a.name === "WrapOperation" || a.name === "WrapWithCondition") {
          const extra = a.name === "WrapOperation" ? 1 : 0;
          const n = params.length;
          if (n !== base.length + extra && n !== base.length + extra + tp.length && !(n > base.length + extra && unresolved.length === 0 && params.slice(base.length + extra).every((x) => x.annotations.some((q) => q.name === "Local" || q.name === "Share")))) {
            push({ severity: "error", message: `${label}: expected ${base.length + extra} parameter(s) (${base.join(", ")}${extra ? ", Operation" : ""})${tp.length ? ` optionally followed by the target's ${tp.length}` : ""}, got ${n}.` });
          } else
            base.forEach((d, k) => {
              const h = params[k]?.desc;
              if (h && h !== d && !(k === 0 && recv && h.startsWith("L") && this.related(h.slice(1, -1), recv))) push({ severity: "error", message: `${label}: parameter ${k + 1} should be ${d}, got ${h}.` });
            });
          if (a.name === "WrapOperation" && params[base.length] && simple(params[base.length]!.type) !== "Operation") push({ severity: "error", message: `${label}: parameter ${base.length + 1} must be Operation<${boxed(ir).slice(1, -1).replace(/.*\//, "")}>.` });
          const wantRet = a.name === "WrapWithCondition" ? "Z" : ir;
          if (ret && ret !== wantRet) push({ severity: "error", message: `${label}: handler must return ${wantRet} (got ${ret}).` });
        } else if (a.name === "ModifyExpressionValue") {
          if (ret && ret !== ir) push({ severity: "error", message: `${label}: handler must return ${ir} (the call's return type), got ${ret}.` });
          if (params[0]?.desc && params[0].desc !== ir) push({ severity: "error", message: `${label}: first parameter must be ${ir}.` });
        } else if (a.name === "ModifyArg") {
          const index = numOf(a.args.index);
          if (params.length === 1 && params[0]!.desc) {
            const cands = ip.map((d, k) => ({ d, k })).filter((x) => x.d === params[0]!.desc);
            if (index !== undefined && ip[index] !== params[0]!.desc) push({ severity: "error", message: `${label}: argument ${index} of the call is ${ip[index] ?? "missing"}, handler takes ${params[0]!.desc}.` });
            if (index === undefined && cands.length !== 1) push({ severity: cands.length ? "warning" : "error", message: `${label}: ${cands.length ? "several call arguments have" : "no call argument has"} type ${params[0]!.desc}; set index = N.` });
          }
          if (ret && params[0]?.desc && ret !== params[0].desc && params.length === 1) push({ severity: "error", message: `${label}: return type must equal the parameter type.` });
        }
      } else if (a.name === "ModifyVariable") {
        if (ret && params[0]?.desc && ret !== params[0].desc) push({ severity: "error", message: `${label}: return type must equal the first parameter type.` });
        if (boolOf(a.args.argsOnly) && params[0]?.desc && !tp.includes(params[0].desc)) push({ severity: "error", message: `${label}: argsOnly=true but the target has no ${params[0].desc} parameter.` });
      }
    }
    if (unresolved.length) push({ severity: "info", message: `@${a.name} ${m.name}: could not resolve type(s) ${[...new Set(unresolved)].join(", ")}; those parameters were not checked.` });
  }

  private receiver(inv: { owner?: string; name: string; desc?: string }, methods: TargetMethod[]): string | undefined {
    // static call → no receiver; find the instruction to know the opcode
    for (const t of methods) {
      const refs = this.refsOf(t);
      const hit = refs?.invokes.find((i) => i.name === inv.name && i.desc === inv.desc && (!inv.owner || this.related(inv.owner, i.owner)));
      if (hit) return hit.opcode === "INVOKESTATIC" ? undefined : inv.owner ?? hit.owner;
    }
    return inv.owner;
  }

  private checkAccessor(p: ParsedJava, m: ParsedMember, a: Annotation, target: string, push: (i: MixinIssue) => void) {
    const cls = this.ctx.index.get(target)!;
    const tname = target.replace(/\//g, ".");
    const explicit = strOf(a.args.value);
    const ret = this.typeDesc(p, m.type);
    const params = m.params.map((x) => this.typeDesc(p, x.type));
    if (a.name === "Accessor") {
      const name = explicit ?? m.name.replace(/^(get|is|set)/, "").replace(/^./, (c) => c.toLowerCase());
      const f = cls.f.find(([n]) => n === name);
      if (!f) {
        const sugg = similar(name, cls.f.map(([n]) => n));
        push({ severity: "error", missing: { owner: target, name, kind: "field" }, message: `@Accessor ${m.name}: field "${name}" not found in ${tname}.`, suggestion: sugg.length ? `Fields with similar names: ${sugg.join(", ")}` : undefined });
        return;
      }
      const isSetter = (ret === "V" || m.type === "void") && params.length === 1;
      const want = f[1];
      if (isSetter && params[0] && params[0] !== want) push({ severity: "error", message: `@Accessor ${m.name}: setter parameter must be ${want} (field type), got ${params[0]}.` });
      if (!isSetter && ret && ret !== want) push({ severity: "error", message: `@Accessor ${m.name}: getter must return ${want} (field type), got ${ret}.` });
      if (!!(f[2] & ACC.STATIC) !== m.modifiers.includes("static")) push({ severity: "error", message: `@Accessor ${m.name}: field is ${f[2] & ACC.STATIC ? "" : "not "}static, the accessor must match.` });
      if (isSetter && f[2] & ACC.FINAL && !m.annotations.some((x) => x.name === "Mutable")) push({ severity: "warning", message: `@Accessor ${m.name}: field is final — add @Mutable for a setter.` });
    } else {
      const name = explicit ?? m.name.replace(/^(call|invoke)/, "").replace(/^./, (c) => c.toLowerCase());
      if (params.some((x) => !x) || !ret) {
        push({ severity: "info", message: `@Invoker ${m.name}: could not resolve all types; only the name was checked.` });
        if (!cls.m.some(([n]) => n === name)) push({ severity: "error", message: `@Invoker ${m.name}: method "${name}" not found in ${tname}.` });
        return;
      }
      const desc = name === "<init>" ? `(${params.join("")})V` : `(${params.join("")})${ret}`;
      const hit = cls.m.find(([n, d]) => n === name && d === desc);
      if (!hit) {
        const overloads = cls.m.filter(([n]) => n === name).map(([n, d]) => n + d);
        push({ severity: "error", message: `@Invoker ${m.name}: no method ${name}${desc} in ${tname}.${overloads.length ? ` Existing: ${overloads.join(", ")}` : ""}`, suggestion: overloads.length ? undefined : (() => { const s = similar(name, cls.m.map(([n]) => n)); return s.length ? `Similar: ${s.join(", ")}` : undefined; })() });
      } else if (!!(hit[2] & ACC.STATIC) !== m.modifiers.includes("static") && name !== "<init>") {
        push({ severity: "error", message: `@Invoker ${m.name}: target method is ${hit[2] & ACC.STATIC ? "" : "not "}static, the invoker must match.` });
      }
    }
  }

  private checkShadow(p: ParsedJava, m: ParsedMember, a: Annotation, target: string, push: (i: MixinIssue) => void) {
    const cls = this.ctx.index.get(target)!;
    const tname = target.replace(/\//g, ".");
    const prefix = strOf(a.args.prefix) ?? "shadow$";
    const name = m.name.startsWith(prefix) ? m.name.slice(prefix.length) : m.name;
    if (m.kind === "field") {
      const own = cls.f.find(([n]) => n === name);
      if (!own) {
        const inh = this.ctx.index.hierarchy(target).slice(1).find((h) => h.f.some(([n]) => n === name));
        push({
          severity: inh ? "warning" : "error",
          ...(inh ? {} : { missing: { owner: target, name, kind: "field" as const } }),
          message: inh ? `@Shadow field ${name} is declared in ${inh.n.replace(/\//g, ".")}, not ${tname}; shadows must be declared in the target class.` : `@Shadow field ${name} not found in ${tname}.`,
          suggestion: inh ? `Mixin ${inh.n.replace(/\//g, ".")} instead, or extend a shadow of that class.` : (() => { const s = similar(name, cls.f.map(([n]) => n)); return s.length ? `Similar: ${s.join(", ")}` : undefined; })(),
        });
        return;
      }
      const d = this.typeDesc(p, m.type);
      if (d && d !== own[1]) push({ severity: "error", message: `@Shadow field ${name}: type is ${own[1]} in ${tname}, declared as ${d}.` });
      return;
    }
    const params = m.params.map((x) => this.typeDesc(p, x.type));
    const ret = this.typeDesc(p, m.type);
    const cands = cls.m.filter(([n]) => n === name);
    if (!cands.length) {
      const inh = this.ctx.index.hierarchy(target).slice(1).find((h) => h.m.some(([n]) => n === name));
      push({ severity: inh ? "warning" : "error", message: inh ? `@${a.name} method ${name} is declared in ${inh.n.replace(/\//g, ".")}, not ${tname}.` : `@${a.name} method ${name} not found in ${tname}.`, suggestion: (() => { const s = similar(name, cls.m.map(([n]) => n)); return s.length ? `Similar: ${s.join(", ")}` : undefined; })() });
      return;
    }
    if (params.every(Boolean) && ret) {
      const desc = `(${params.join("")})${ret}`;
      if (!cands.some(([, d]) => d === desc)) push({ severity: "error", message: `@${a.name} ${name}${desc} does not match ${tname}: ${cands.map(([n, d]) => n + d).join(", ")}.` });
    }
    if (a.name === "Overwrite") push({ severity: "warning", message: `@Overwrite ${name}: replaces the whole method and conflicts with any other mod touching it. Prefer @Inject / @WrapMethod / @WrapOperation.` });
  }
}

// ---------------- project-level ----------------

export interface ConfigReport {
  file: string;
  package?: string;
  compatibilityLevel?: string;
  registered: boolean;
  mixins: { name: string; section: string; file?: string; targets: string[]; errors: number; warnings: number }[];
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

const levelNum = (l?: string | null) => (l ? Number(/^JAVA_(\d+)$/.exec(l)?.[1] ?? NaN) : NaN);

export async function validateProject(ctx: ValidateContext, opts: { mixinClass?: string } = {}): Promise<{ configs: ConfigReport[]; issues: MixinIssue[] }> {
  const v = new MixinValidator(ctx);
  const issues: MixinIssue[] = [];
  const configs: ConfigReport[] = [];
  const { project, profile } = ctx;
  if (!project.mixinConfigs.length) issues.push({ severity: "info", message: "No *.mixins.json found in the project resources." });
  // registration sources
  const regFiles = [
    ...["build.gradle", "build.gradle.kts"].map((f) => path.join(project.dir, f)),
    ...(await walk(path.join(project.dir, "src"))).filter((f) => /(fabric\.mod\.json|mods\.toml|MANIFEST\.MF)$/.test(f)),
  ].filter(existsSync);
  const regText = (await Promise.all(regFiles.map((f) => readFile(f, "utf8")))).join("\n");
  const allJava = (await Promise.all(project.javaSourceRoots.map((r) => walk(r)))).flat().filter((f) => f.endsWith(".java"));
  const listedFiles = new Set<string>();

  for (const cfgPath of project.mixinConfigs) {
    const rel = path.relative(project.dir, cfgPath);
    let json: Record<string, unknown>;
    try {
      json = JSON.parse(await readFile(cfgPath, "utf8")) as Record<string, unknown>;
    } catch (e) {
      issues.push({ severity: "error", file: rel, message: `Invalid JSON: ${(e as Error).message}` });
      continue;
    }
    const base = path.basename(cfgPath);
    const modIdForm = project.modId && base === `${project.modId}.mixins.json` ? [/\$\{mod_?id\}\.mixins\.json/i, /\$\{modId\}\.mixins\.json/] : [];
    const registered = regText.includes(base) || modIdForm.some((r) => r.test(regText));
    const report: ConfigReport = { file: rel, package: json.package as string | undefined, compatibilityLevel: json.compatibilityLevel as string | undefined, registered, mixins: [] };
    configs.push(report);
    if (!registered) {
      const how = profile?.mixin.registration === "fabric.mod.json" ? 'add it to "mixins" in fabric.mod.json' : profile?.mixin.registration === "mods.toml" ? "add [[mixins]] config=\"" + base + "\" to the mods.toml" : "add it to the jar manifest MixinConfigs (and dev runs)";
      issues.push({ severity: "error", file: rel, message: `${base} is not registered anywhere, so it will never load.`, suggestion: `${how}.` });
    }
    if (typeof json.package !== "string" || !json.package) {
      issues.push({ severity: "error", file: rel, message: 'Missing "package".' });
      continue;
    }
    // compatibility level
    const lvl = json.compatibilityLevel as string | undefined;
    if (!lvl) issues.push({ severity: "warning", file: rel, message: "No compatibilityLevel set (defaults to JAVA_8, which limits mixins compiled for newer Java)." });
    else if (!/^JAVA_\d+$/.test(lvl)) issues.push({ severity: "error", file: rel, message: `compatibilityLevel "${lvl}" is not a valid level (JAVA_<n>).` });
    else if (profile) {
      const max = profile.mixin.maxCompatibilityLevel;
      const n = levelNum(lvl);
      if (max && n > levelNum(max)) {
        issues.push({ severity: "warning", file: rel, message: `compatibilityLevel ${lvl} is above ${max}, the highest level the Mixin bundled with ${profile.loader} ${profile.mcVersion} knows.`, suggestion: `Use ${max}.` });
      } else if (n < profile.java && (!max || levelNum(max) >= profile.java)) {
        issues.push({ severity: "warning", file: rel, message: `compatibilityLevel ${lvl} is lower than the Java ${profile.java} the mod is compiled for; Mixin may refuse newer class files.`, suggestion: `Use JAVA_${profile.java}.` });
      }
    }
    if (profile?.mixin.refmap && profile.loader !== "fabric" && !json.refmap) {
      issues.push({ severity: "warning", file: rel, message: `${profile.loader} ${profile.mcVersion} runs on SRG names: the config should name its refmap ("refmap": "<modid>.refmap.json") or injections into renamed members fail in production.` });
    }
    const pkgPath = (json.package as string).replace(/\./g, "/");
    const sections: [string, string[]][] = (["mixins", "client", "server"] as const).map((s) => [s, Array.isArray(json[s]) ? (json[s] as string[]) : []]);
    const seen = new Map<string, string>();
    for (const [section, names] of sections) {
      for (const name of names) {
        if (seen.has(name)) issues.push({ severity: "warning", file: rel, message: `${name} is listed in both "${seen.get(name)}" and "${section}".` });
        seen.set(name, section);
        if (opts.mixinClass && !`${json.package}.${name}`.endsWith(opts.mixinClass)) continue;
        const relJava = `${pkgPath}/${name.replace(/\./g, "/")}.java`;
        const file = project.javaSourceRoots.map((r) => path.join(r, relJava)).find(existsSync);
        if (!file) {
          issues.push({ severity: "error", file: rel, message: `${json.package}.${name} is listed in "${section}" but no source file ${relJava} exists.`, mixin: name });
          report.mixins.push({ name, section, targets: [], errors: 1, warnings: 0 });
          continue;
        }
        listedFiles.add(file);
        const res = v.validateSource(await readFile(file, "utf8"), path.relative(project.dir, file), section);
        issues.push(...res.issues);
        report.mixins.push({
          name, section, file: path.relative(project.dir, file), targets: res.targets.map((t) => t.replace(/\//g, ".")),
          errors: res.issues.filter((i) => i.severity === "error").length, warnings: res.issues.filter((i) => i.severity === "warning").length,
        });
      }
    }
    // unlisted mixins in the package
    if (!opts.mixinClass) {
      for (const f of allJava) {
        if (listedFiles.has(f)) continue;
        const relToRoot = project.javaSourceRoots.map((r) => path.relative(r, f)).find((x) => !x.startsWith(".."));
        if (!relToRoot?.replace(/\\/g, "/").startsWith(pkgPath + "/")) continue;
        const text = await readFile(f, "utf8");
        if (/@Mixin\s*\(/.test(text)) issues.push({ severity: "warning", file: path.relative(project.dir, f), message: `Has @Mixin but is not listed in ${base}; it will not be applied.`, suggestion: "Add it to mixins/client/server in the config." });
      }
    }
  }
  return { configs, issues };
}
