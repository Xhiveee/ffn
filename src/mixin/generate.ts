/**
 * Generate mixin handlers from real descriptors in the index, validate, then write + register.
 */
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { ACC, parseMethodDesc } from "../index/classfile.js";
import type { McIndex } from "../index/store.js";
import { parseJava } from "./javaparse.js";
import { boxed, CONST_DESC, constMatches, MixinValidator, parseSelector, type ConstSpec, type MixinIssue, type ValidateContext } from "./validate.js";

export const INJECTION_KINDS = [
  "inject", "redirect", "modify_arg", "modify_variable", "modify_return_value", "modify_expression_value",
  "wrap_operation", "wrap_with_condition", "wrap_method", "accessor", "invoker", "modify_constant", "overwrite",
] as const;
export type InjectionKind = (typeof INJECTION_KINDS)[number];
const EXTRAS: InjectionKind[] = ["modify_return_value", "modify_expression_value", "wrap_operation", "wrap_with_condition", "wrap_method"];

export interface GenerateRequest {
  targetClass: string;
  member: string;
  injection: InjectionKind;
  at?: string;
  side?: "common" | "client" | "server";
  mixinName?: string;
  handlerName?: string;
  cancellable?: boolean;
  argIndex?: number;
  ordinal?: number;
  setter?: boolean;
  configFile?: string;
  /** modify_constant: the constant to change, e.g. "5", "int:5", "0.3F", "float:0.3", "\"text\"", "string:text", "class:net.minecraft.world.item.Item", "null". */
  constant?: string;
}

/** Parse the user's constant (typed prefix or literal syntax). */
export function parseConstant(raw: string): ConstSpec {
  const t = raw.trim();
  const pre = /^(int|long|float|double|string|class|null)\s*:\s*(.*)$/s.exec(t);
  if (pre) return { type: pre[1] as ConstSpec["type"], value: pre[1] === "class" ? pre[2]!.replace(/\.class$/, "").replace(/\./g, "/") : pre[1] === "string" ? pre[2]! : pre[2]!.replace(/[lLfFdD]$/, "") };
  if (t === "null") return { type: "null", value: "null" };
  if (/^".*"$/s.test(t)) return { type: "string", value: t.slice(1, -1) };
  if (/^-?\d+[lL]$/.test(t)) return { type: "long", value: t.slice(0, -1) };
  if (/^-?[\d.]+(e-?\d+)?[fF]$/.test(t)) return { type: "float", value: t.slice(0, -1) };
  if (/^-?[\d.]+(e-?\d+)?[dD]$/.test(t) || /^-?\d*\.\d+(e-?\d+)?$/.test(t)) return { type: "double", value: t.replace(/[dD]$/, "") };
  if (/^-?\d+$/.test(t)) return { type: "int", value: t };
  if (/\.class$/.test(t)) return { type: "class", value: t.replace(/\.class$/, "").replace(/\./g, "/") };
  return { type: "string", value: t };
}

export interface GeneratePlan {
  file: string;
  className: string;
  fqcn: string;
  content: string;
  appended: boolean;
  config: string;
  section: "mixins" | "client" | "server";
  configChanged: boolean;
  configContent: string;
  handler: string;
  annotation: string;
  issues: MixinIssue[];
}

class TypeNamer {
  readonly imports = new Map<string, string>(); // simple → dotted FQN
  constructor(existing?: Map<string, string>, private readonly pkg = "") {
    if (existing) for (const [k, v] of existing) this.imports.set(k, v);
  }
  use(fqn: string): string {
    const simple = fqn.slice(fqn.lastIndexOf(".") + 1);
    const have = this.imports.get(simple);
    if (have === fqn) return simple;
    if (have) return fqn;
    if (fqn.startsWith("java.lang.") && !fqn.slice(10).includes(".")) return simple;
    if (fqn.slice(0, fqn.lastIndexOf(".")) === this.pkg) return simple;
    this.imports.set(simple, fqn);
    return simple;
  }
  /** Java source type for a descriptor. */
  type(desc: string): string {
    let dims = 0;
    while (desc[dims] === "[") dims++;
    const base = desc.slice(dims);
    const prim: Record<string, string> = { V: "void", Z: "boolean", B: "byte", C: "char", S: "short", I: "int", J: "long", F: "float", D: "double" };
    let t: string;
    if (prim[base]) t = prim[base]!;
    else {
      const internal = base.slice(1, -1);
      const parts = internal.split("$");
      if (parts.slice(1).some((p) => /^\d/.test(p))) t = "Object"; // anonymous/local class cannot be named
      else t = [this.use(parts[0]!.replace(/\//g, ".")), ...parts.slice(1)].join(".");
    }
    return t + "[]".repeat(dims);
  }
  boxedType(desc: string): string {
    return this.type(boxed(desc));
  }
}

const cap = (s: string) => s.replace(/[<>]/g, "").replace(/^./, (c) => c.toUpperCase());

function paramNames(namer: TypeNamer, descs: string[], taken: Set<string>): string[] {
  return descs.map((d, k) => {
    const t = namer.type(d).replace(/\[\]/g, "Array").replace(/.*\./, "");
    let n = /^[a-z]/.test(t) ? `${t}Arg${k}` : t.replace(/^./, (c) => c.toLowerCase());
    if (["int", "long", "char", "byte", "short", "float", "double", "boolean", "class", "new", "default", "package"].includes(n)) n += k;
    while (taken.has(n)) n += "_";
    taken.add(n);
    return n;
  });
}

function isPublicChain(index: McIndex, internal: string): boolean {
  const parts = internal.split("$");
  for (let k = 1; k <= parts.length; k++) {
    const c = index.get(parts.slice(0, k).join("$"));
    if (!c || !(c.a & ACC.PUBLIC)) return false;
  }
  return true;
}

export async function planMixin(ctx: ValidateContext, req: GenerateRequest): Promise<GeneratePlan> {
  const { index, project, profile } = ctx;
  const found = index.resolve(req.targetClass);
  if (found.length !== 1) throw new Error(found.length ? `Target class is ambiguous: ${found.map((f) => f.replace(/\//g, ".")).join(", ")}` : `Target class ${req.targetClass} not found in Minecraft ${index.meta.mcVersion} (${index.meta.namespace}).`);
  const target = found[0]!;
  const cls = index.get(target)!;
  if (EXTRAS.includes(req.injection) && !ctx.mixinExtrasAvailable) {
    throw new Error(`${req.injection} needs MixinExtras, which this project does not have. ${profile?.mixin.mixinExtras.note ?? ""} Use inject/redirect/modify_arg instead, or add MixinExtras.`);
  }
  // config
  const cfgs = project.mixinConfigs;
  if (!cfgs.length) throw new Error("The project has no *.mixins.json; create one first (create_project generates it).");
  const cfgPath = req.configFile ? cfgs.find((c) => c.endsWith(req.configFile!)) : cfgs.find((c) => project.modId && path.basename(c) === `${project.modId}.mixins.json`) ?? cfgs[0];
  if (!cfgPath) throw new Error(`Mixin config ${req.configFile} not found. Available: ${cfgs.map((c) => path.basename(c)).join(", ")}`);
  const cfg = JSON.parse(await readFile(cfgPath, "utf8")) as Record<string, unknown>;
  const pkg = cfg.package as string;
  if (!pkg) throw new Error(`${path.basename(cfgPath)} has no "package".`);
  const clientOnly = /^(net\/minecraft\/client\/|com\/mojang\/blaze3d\/|com\/mojang\/realmsclient\/)/.test(target);
  const section = req.side === "client" ? "client" : req.side === "server" ? "server" : req.side === "common" ? "mixins" : clientOnly ? "client" : "mixins";
  const isAccessor = req.injection === "accessor" || req.injection === "invoker";
  const simpleTarget = target.slice(target.lastIndexOf("/") + 1).replace(/\$/g, "");
  const className = req.mixinName ?? `${simpleTarget}${isAccessor ? "Accessor" : "Mixin"}`;
  const root = project.javaSourceRoots.find((r) => /[\\/]main[\\/]java$/.test(r)) ?? project.javaSourceRoots[0] ?? path.join(project.dir, "src/main/java");
  const file = path.join(root, ...pkg.split("."), `${className}.java`);
  const existing = existsSync(file) ? await readFile(file, "utf8") : undefined;
  const parsedExisting = existing ? parseJava(existing) : undefined;
  if (parsedExisting) {
    const tgts = parsedExisting.classAnnotations.find((a) => a.name === "Mixin");
    if (!tgts) throw new Error(`${className}.java exists and is not a mixin; pass a different name.`);
    if (isAccessor !== parsedExisting.isInterface) throw new Error(`${className}.java exists but is ${parsedExisting.isInterface ? "an interface (accessor) mixin" : "a class mixin"}; pass a different name.`);
  }
  const namer = new TypeNamer(parsedExisting?.imports, pkg);
  const takenNames = new Set(parsedExisting?.members.map((m) => m.name) ?? []);
  const modId = project.modId ?? "mod";
  const lines: string[] = [];
  const I = "    ";
  let annotationText = "";
  let handler = "";
  // Names already used by the target (or its supertypes) would make Mixin try to overwrite them.
  const targetNames = new Set(index.hierarchy(target).flatMap((h) => h.m.map(([n]) => n)));
  const uniqueName = (n0: string) => {
    const n = targetNames.has(n0) ? `${modId}$${n0}` : n0;
    let x = n;
    let k = 2;
    while (takenNames.has(x)) x = `${n}${k++}`;
    takenNames.add(x);
    return x;
  };

  if (isAccessor) {
    if (req.injection === "accessor") {
      const f = cls.f.find(([n]) => n === req.member);
      if (!f) throw new Error(`Field ${req.member} not found in ${target.replace(/\//g, ".")}. Fields: ${cls.f.map(([n]) => n).slice(0, 40).join(", ")}`);
      const [fname, fdesc, facc] = f;
      const st = !!(facc & ACC.STATIC);
      const t = namer.type(fdesc);
      namer.use("org.spongepowered.asm.mixin.gen.Accessor");
      const getter = uniqueName(req.handlerName ?? `${fdesc === "Z" ? "is" : "get"}${cap(fname)}`);
      lines.push(`${I}@Accessor("${fname}")`, st ? `${I}static ${t} ${getter}() {\n${I}${I}throw new AssertionError();\n${I}}` : `${I}${t} ${getter}();`);
      handler = getter;
      annotationText = `@Accessor("${fname}")`;
      if (req.setter) {
        const setter = uniqueName(`set${cap(fname)}`);
        lines.push("");
        if (facc & ACC.FINAL) {
          namer.use("org.spongepowered.asm.mixin.Mutable");
          lines.push(`${I}@Mutable`);
        }
        lines.push(`${I}@Accessor("${fname}")`, st ? `${I}static void ${setter}(${t} value) {\n${I}${I}throw new AssertionError();\n${I}}` : `${I}void ${setter}(${t} value);`);
      }
    } else {
      const sel = parseSelector(req.member);
      const ms = cls.m.filter(([n, d]) => n === sel.name && (!sel.desc || d === sel.desc));
      if (!ms.length) throw new Error(`Method ${req.member} not found in ${target.replace(/\//g, ".")}.`);
      if (ms.length > 1) throw new Error(`${req.member} is overloaded; give a descriptor: ${ms.map(([n, d]) => n + d).join(", ")}`);
      const [mname, mdesc, macc] = ms[0]!;
      const { params, ret } = parseMethodDesc(mdesc);
      const st = !!(macc & ACC.STATIC) || mname === "<init>";
      namer.use("org.spongepowered.asm.mixin.gen.Invoker");
      const pn = paramNames(namer, params, new Set());
      const sig = params.map((d, k) => `${namer.type(d)} ${pn[k]}`).join(", ");
      const rt = mname === "<init>" ? namer.type(`L${target};`) : namer.type(ret);
      const nm = uniqueName(req.handlerName ?? (mname === "<init>" ? `create${simpleTarget}` : `invoke${cap(mname)}`));
      lines.push(`${I}@Invoker("${mname}")`, st ? `${I}static ${rt} ${nm}(${sig}) {\n${I}${I}throw new AssertionError();\n${I}}` : `${I}${rt} ${nm}(${sig});`);
      handler = nm;
      annotationText = `@Invoker("${mname}")`;
    }
  } else {
    const sel = parseSelector(req.member);
    const ms = cls.m.filter(([n, d]) => n === sel.name && (!sel.desc || d === sel.desc));
    if (!ms.length) {
      const near = cls.m.map(([n]) => n).filter((n) => n.toLowerCase().includes(sel.name.toLowerCase())).slice(0, 10);
      throw new Error(`Method ${req.member} not found in ${target.replace(/\//g, ".")}.${near.length ? ` Similar: ${[...new Set(near)].join(", ")}` : ""}`);
    }
    if (ms.length > 1) throw new Error(`${req.member} is overloaded; give a descriptor: ${ms.map(([n, d]) => n + d).join(", ")}`);
    const [mname, mdesc, macc] = ms[0]!;
    const tStatic = !!(macc & ACC.STATIC);
    const { params: tp, ret: tr } = parseMethodDesc(mdesc);
    const selector = `${mname}${mdesc}`;
    const st = tStatic ? "static " : "";
    if (req.injection === "overwrite") {
      if (mname === "<init>" || mname === "<clinit>") throw new Error("Constructors and static initialisers cannot be @Overwrite-n.");
      namer.use("org.spongepowered.asm.mixin.Overwrite");
      const pn = paramNames(namer, tp, new Set());
      const vis = macc & ACC.PUBLIC ? "public " : macc & ACC.PROTECTED ? "protected " : macc & ACC.PRIVATE ? "private " : "";
      handler = mname;
      annotationText = "@Overwrite";
      lines.push(
        `${I}/**`,
        `${I} * @author ${modId}`,
        `${I} * @reason TODO: explain why an overwrite is unavoidable (Mixin warns without @author/@reason).`,
        `${I} * WARNING: @Overwrite replaces the whole method; any other mod injecting into or overwriting it breaks or is broken.`,
        `${I} * Prefer @Inject (cancellable), @WrapMethod or @WrapOperation. Copy the original body first (get_source) and keep it close to vanilla.`,
        `${I} */`,
        `${I}@Overwrite`,
        `${I}${vis}${st}${namer.type(tr)} ${mname}(${tp.map((d, k) => `${namer.type(d)} ${pn[k]}`).join(", ")}) {`,
        `${I}${I}// TODO: full replacement body (start from the original source).`,
        `${I}${I}throw new UnsupportedOperationException("FFN: @Overwrite body not written yet");`,
        `${I}}`,
      );
    }
    if (req.injection === "modify_constant") {
      if (!req.constant) {
        const r0 = index.reader(target);
        const refs0 = r0?.analyze(r0.info.methods.find((m) => m.name === mname && m.desc === mdesc)!);
        throw new Error(`modify_constant needs constant (e.g. "5", "0.5F", "\"text\""). Constants in ${selector}: ${[...new Set((refs0?.typedConstants ?? []).map((c) => `${c.type}:${c.value}`))].slice(0, 40).join(", ")}`);
      }
    }
    // resolve @At
    const refs = index.reader(target)?.analyze(index.reader(target)!.info.methods.find((m) => m.name === mname && m.desc === mdesc)!);
    const needsCall = ["redirect", "modify_arg", "wrap_operation", "wrap_with_condition"].includes(req.injection);
    let atText: string;
    let call: { owner: string; name: string; desc: string; opcode: string } | undefined;
    let field: { owner: string; name: string; desc: string; opcode: string } | undefined;
    const skipAt = req.injection === "overwrite" || req.injection === "modify_constant";
    const rawAt = skipAt ? "HEAD" : req.at ?? (req.injection === "modify_return_value" ? "RETURN" : req.injection === "inject" ? (mname === "<init>" ? "TAIL" : "HEAD") : req.injection === "modify_variable" ? "HEAD" : undefined);
    if (!rawAt && req.injection !== "wrap_method") {
      const calls = refs?.invokes.map((i) => `INVOKE:L${i.owner};${i.name}${i.desc}`).slice(0, 40) ?? [];
      throw new Error(`${req.injection} needs at = "INVOKE:<call>"${req.injection === "modify_expression_value" ? ' or "FIELD:<field>"' : ""}. Calls in ${selector}: ${calls.join(", ")}`);
    }
    const ord = req.ordinal !== undefined ? `, ordinal = ${req.ordinal}` : "";
    let created: { cls: string; ctor?: string } | undefined;
    if (!rawAt || skipAt) atText = "";
    else if (/^(HEAD|RETURN|TAIL)$/.test(rawAt)) {
      if (needsCall || req.injection === "modify_expression_value") throw new Error(`${req.injection} needs an INVOKE${req.injection === "modify_expression_value" ? "/FIELD" : ""} injection point, not ${rawAt}.`);
      atText = ord ? `@At(value = "${rawAt}"${ord})` : `@At("${rawAt}")`;
    } else {
      const m = /^(INVOKE|FIELD|NEW)(?::(.+))?$/.exec(rawAt);
      if (!m || !m[2]) throw new Error(`Unsupported at "${rawAt}". Use HEAD, RETURN, TAIL, INVOKE:<call> or FIELD:<field> (call/field may be just a name).`);
      const s = parseSelector(m[2]);
      if (m[1] === "INVOKE") {
        const cands = (refs?.invokes ?? []).filter((i) => i.name === s.name && (!s.desc || i.desc === s.desc) && (!s.owner || i.owner === s.owner));
        if (!cands.length) throw new Error(`${selector} does not call ${m[2]}. Calls: ${(refs?.invokes ?? []).map((i) => `L${i.owner};${i.name}${i.desc}`).slice(0, 40).join(", ")}`);
        if (cands.length > 1) throw new Error(`${m[2]} is ambiguous in ${selector}: ${cands.map((i) => `L${i.owner};${i.name}${i.desc}`).join(", ")}`);
        call = cands[0]!;
        atText = `@At(value = "INVOKE", target = "L${call.owner};${call.name}${call.desc}"${ord})`;
      } else if (m[1] === "FIELD") {
        const cands = (refs?.fields ?? []).filter((f) => f.name === s.name && (!s.owner || f.owner === s.owner) && (!s.fieldDesc || f.desc === s.fieldDesc));
        const gets = cands.filter((f) => f.opcode.startsWith("GET"));
        const pick = req.injection === "modify_expression_value" ? gets : cands;
        if (!pick.length) throw new Error(`${selector} does not ${req.injection === "modify_expression_value" ? "read" : "access"} field ${m[2]}. Field accesses: ${(refs?.fields ?? []).map((f) => `${f.opcode} L${f.owner};${f.name}:${f.desc}`).slice(0, 40).join(", ")}`);
        field = pick[0]!;
        atText = `@At(value = "FIELD", target = "L${field.owner};${field.name}:${field.desc}"${req.injection === "modify_expression_value" ? "" : `, opcode = Opcodes.${field.opcode}`}${ord})`;
        if (req.injection !== "modify_expression_value") namer.use("org.objectweb.asm.Opcodes");
      } else {
        // NEW:<class> — the object creation (NEW + constructor call) of that class
        const cls0 = m[2].replace(/^L(.+);$/, "$1").replace(/\./g, "/");
        const hits = (refs?.news ?? []).filter((n) => n === cls0 || n.endsWith(`/${cls0}`) || n.replace(/\$/g, "/").endsWith(`/${cls0.replace(/\$/g, "/")}`));
        if (!hits.length) throw new Error(`${selector} never creates ${m[2]}. Objects created: ${(refs?.news ?? []).map((n) => n.replace(/\//g, ".")).slice(0, 30).join(", ") || "none"}`);
        if (new Set(hits).size > 1) throw new Error(`${m[2]} is ambiguous: ${[...new Set(hits)].join(", ")}`);
        const cls = hits[0]!;
        const ctors = [...new Set((refs?.invokes ?? []).filter((i) => i.owner === cls && i.name === "<init>").map((i) => i.desc))];
        const ctor = ctors.length === 1 ? ctors[0] : undefined;
        if (!ctor && ["redirect", "wrap_operation"].includes(req.injection)) throw new Error(`${cls} is created with ${ctors.length} different constructors (${ctors.join(", ")}); FFN can only generate ${req.injection} for a single one — write it by hand with the right descriptor.`);
        created = { cls, ctor };
        const tgt = ctor ? `${ctor.slice(0, ctor.lastIndexOf(")") + 1)}L${cls};` : cls;
        atText = `@At(value = "NEW", target = "${tgt}"${ord})`;
        if (!["inject", "redirect", "modify_expression_value", "wrap_operation"].includes(req.injection)) throw new Error(`NEW injection points are supported for inject, redirect, modify_expression_value and wrap_operation, not ${req.injection}.`);
      }
      if (needsCall && !call && !(created && ["redirect", "wrap_operation"].includes(req.injection))) throw new Error(`${req.injection} needs an INVOKE injection point.`);
    }
    if (!skipAt) namer.use("org.spongepowered.asm.mixin.injection.At");
    const taken = new Set<string>();
    const targetParams = () => {
      const pn = paramNames(namer, tp, taken);
      return tp.map((d, k) => `${namer.type(d)} ${pn[k]}`);
    };
    const base = (req.handlerName ?? `${modId}$${req.injection.replace(/_(.)/g, (_, c: string) => c.toUpperCase())}${cap(mname === "<init>" ? "init" : mname)}`).replace(/[^\w$]/g, "_");
    if (req.injection !== "overwrite") handler = uniqueName(base);
    const methodSel = `"${selector}"`;
    switch (req.injection) {
      case "overwrite":
        break;
      case "modify_constant": {
        const spec = parseConstant(req.constant!);
        const consts = refs?.typedConstants ?? [];
        const hits = consts.filter((c) => constMatches(spec, c));
        if (!hits.length) {
          const same = [...new Set(consts.filter((c) => c.type === spec.type).map((c) => c.value))];
          throw new Error(`${selector} never pushes the ${spec.type} constant ${spec.value}.${same.length ? ` ${spec.type} constants there: ${same.slice(0, 30).join(", ")}` : ` Constants there: ${[...new Set(consts.map((c) => `${c.type}:${c.value}`))].slice(0, 30).join(", ") || "none"}`}${spec.type === "int" && Number(spec.value) === 0 ? " (comparisons with 0 have no constant: use expandZeroConditions by hand)" : ""}`);
        }
        if (spec.type === "null") throw new Error("Modifying a null constant is not supported by @ModifyConstant handlers in a useful way; use @ModifyExpressionValue or @Redirect.");
        namer.use("org.spongepowered.asm.mixin.injection.ModifyConstant");
        namer.use("org.spongepowered.asm.mixin.injection.Constant");
        const key = { int: "intValue", float: "floatValue", long: "longValue", double: "doubleValue", string: "stringValue", class: "classValue", null: "nullValue" }[spec.type];
        const lit =
          spec.type === "string" ? JSON.stringify(spec.value) : spec.type === "class" ? `${namer.type(`L${spec.value.includes("/") ? spec.value : hits[0]!.value};`)}.class` : spec.type === "float" ? `${spec.value}F` : spec.type === "long" ? `${spec.value}L` : spec.type === "double" ? (/[.eE]/.test(spec.value) ? spec.value : `${spec.value}.0`) : spec.value;
        const t = namer.type(CONST_DESC[spec.type]);
        const ordinalText = req.ordinal !== undefined ? `, ordinal = ${req.ordinal}` : "";
        annotationText = `@ModifyConstant(method = ${methodSel}, constant = @Constant(${key} = ${lit}${ordinalText}))`;
        lines.push(`${I}${annotationText}`, `${I}private ${st}${t} ${handler}(${t} original) {`, `${I}${I}return original; // TODO: modify${hits.length > 1 && req.ordinal === undefined ? ` (matches all ${hits.length} occurrences; set ordinal to pick one)` : ""}`, `${I}}`);
        break;
      }
      case "inject": {
        const ciType = tr === "V" ? namer.use("org.spongepowered.asm.mixin.injection.callback.CallbackInfo") : `${namer.use("org.spongepowered.asm.mixin.injection.callback.CallbackInfoReturnable")}<${namer.boxedType(tr)}>`;
        namer.use("org.spongepowered.asm.mixin.injection.Inject");
        const ps = [...targetParams(), `${ciType} ${tr === "V" ? "ci" : "cir"}`];
        annotationText = `@Inject(method = ${methodSel}, at = ${atText}${req.cancellable ? ", cancellable = true" : ""})`;
        lines.push(`${I}${annotationText}`, `${I}private ${st}void ${handler}(${ps.join(", ")}) {`, `${I}${I}// TODO: your code${req.cancellable ? (tr === "V" ? `\n${I}${I}// ci.cancel(); // skips the rest of the target method` : `\n${I}${I}// cir.setReturnValue(...); // returns early with this value`) : ""}`, `${I}}`);
        break;
      }
      case "modify_return_value": {
        if (tr === "V") throw new Error(`${selector} returns void; nothing to modify.`);
        namer.use("com.llamalad7.mixinextras.injector.ModifyReturnValue");
        const t = namer.type(tr);
        annotationText = `@ModifyReturnValue(method = ${methodSel}, at = ${atText})`;
        lines.push(`${I}${annotationText}`, `${I}private ${st}${t} ${handler}(${t} original) {`, `${I}${I}return original; // TODO: modify`, `${I}}`);
        break;
      }
      case "wrap_method": {
        namer.use("com.llamalad7.mixinextras.injector.wrapmethod.WrapMethod");
        const op = namer.use("com.llamalad7.mixinextras.injector.wrapoperation.Operation");
        const pn = paramNames(namer, tp, taken);
        const ps = [...tp.map((d, k) => `${namer.type(d)} ${pn[k]}`), `${op}<${namer.boxedType(tr)}> original`];
        annotationText = `@WrapMethod(method = ${methodSel})`;
        lines.push(`${I}${annotationText}`, `${I}private ${st}${namer.type(tr)} ${handler}(${ps.join(", ")}) {`, `${I}${I}${tr === "V" ? "" : "return "}original.call(${pn.join(", ")}); // TODO: code before/after`, `${I}}`);
        break;
      }
      case "modify_variable": {
        const idx = req.argIndex ?? 0;
        if (idx >= tp.length) throw new Error(`${selector} has ${tp.length} parameter(s); argIndex ${idx} is out of range. (FFN generates @ModifyVariable for method arguments; local variables need names/ordinals from the source.)`);
        namer.use("org.spongepowered.asm.mixin.injection.ModifyVariable");
        const t = namer.type(tp[idx]!);
        const sameType = tp.slice(0, idx).filter((d) => d === tp[idx]).length;
        annotationText = `@ModifyVariable(method = ${methodSel}, at = ${atText}, argsOnly = true, ordinal = ${sameType})`;
        lines.push(`${I}${annotationText}`, `${I}private ${st}${t} ${handler}(${t} value) {`, `${I}${I}return value; // TODO: modify`, `${I}}`);
        break;
      }
      default: {
        // call-site based kinds
        if (field && req.injection === "modify_expression_value") {
          namer.use("com.llamalad7.mixinextras.injector.ModifyExpressionValue");
          const t = namer.type(field.desc);
          annotationText = `@ModifyExpressionValue(method = ${methodSel}, at = ${atText})`;
          lines.push(`${I}${annotationText}`, `${I}private ${st}${t} ${handler}(${t} original) {`, `${I}${I}return original; // TODO: modify`, `${I}}`);
          break;
        }
        if (created) {
          const ct = namer.type(`L${created.cls};`);
          if (req.injection === "modify_expression_value") {
            namer.use("com.llamalad7.mixinextras.injector.ModifyExpressionValue");
            annotationText = `@ModifyExpressionValue(method = ${methodSel}, at = ${atText})`;
            lines.push(`${I}${annotationText}`, `${I}private ${st}${ct} ${handler}(${ct} original) {`, `${I}${I}return original; // TODO: modify or replace the new object`, `${I}}`);
            break;
          }
          const { params: cp } = parseMethodDesc(created.ctor!);
          const names = paramNames(namer, cp, taken);
          const ps = cp.map((d, k) => `${namer.type(d)} ${names[k]}`);
          if (req.injection === "redirect") {
            namer.use("org.spongepowered.asm.mixin.injection.Redirect");
            annotationText = `@Redirect(method = ${methodSel}, at = ${atText})`;
            lines.push(`${I}${annotationText}`, `${I}private ${st}${ct} ${handler}(${ps.join(", ")}) {`, `${I}${I}// TODO: return a replacement object (only one mod can redirect this; prefer wrap_operation with MixinExtras).`, `${I}${I}return new ${ct}(${names.join(", ")});`, `${I}}`);
          } else {
            namer.use("com.llamalad7.mixinextras.injector.wrapoperation.WrapOperation");
            const op = namer.use("com.llamalad7.mixinextras.injector.wrapoperation.Operation");
            annotationText = `@WrapOperation(method = ${methodSel}, at = ${atText})`;
            lines.push(`${I}${annotationText}`, `${I}private ${st}${ct} ${handler}(${[...ps, `${op}<${ct}> original`].join(", ")}) {`, `${I}${I}return original.call(${names.join(", ")}); // TODO: code before/after or change arguments`, `${I}}`);
          }
          break;
        }
        if (!call) throw new Error(`${req.injection} needs at = "INVOKE:<call>".`);
        const { params: ip, ret: ir } = parseMethodDesc(call.desc);
        const isStaticCall = call.opcode === "INVOKESTATIC";
        const recvDesc = isStaticCall ? [] : [`L${call.owner};`];
        const names = paramNames(namer, [...recvDesc, ...ip], taken);
        if (!isStaticCall) names[0] = taken.has("instance") ? names[0]! : "instance";
        const ps = [...recvDesc, ...ip].map((d, k) => `${namer.type(d)} ${names[k]}`);
        const args = names.slice(recvDesc.length).join(", ");
        const direct = () => (isStaticCall ? `${namer.type(`L${call!.owner};`)}.${call!.name}(${args})` : `${names[0]}.${call!.name}(${args})`);
        const allArgs = names.join(", ");
        if (req.injection === "redirect") {
          namer.use("org.spongepowered.asm.mixin.injection.Redirect");
          annotationText = `@Redirect(method = ${methodSel}, at = ${atText})`;
          lines.push(`${I}${annotationText}`, `${I}private ${st}${namer.type(ir)} ${handler}(${ps.join(", ")}) {`, `${I}${I}// TODO: replace the call. Note: only one mod can @Redirect a call; prefer wrap_operation when MixinExtras is available.`, `${I}${I}${ir === "V" ? "" : "return "}${direct()};`, `${I}}`);
        } else if (req.injection === "wrap_operation") {
          namer.use("com.llamalad7.mixinextras.injector.wrapoperation.WrapOperation");
          const op = namer.use("com.llamalad7.mixinextras.injector.wrapoperation.Operation");
          annotationText = `@WrapOperation(method = ${methodSel}, at = ${atText})`;
          lines.push(`${I}${annotationText}`, `${I}private ${st}${namer.type(ir)} ${handler}(${[...ps, `${op}<${namer.boxedType(ir)}> original`].join(", ")}) {`, `${I}${I}${ir === "V" ? "" : "return "}original.call(${allArgs}); // TODO: code before/after or change arguments`, `${I}}`);
        } else if (req.injection === "wrap_with_condition") {
          if (ir !== "V") throw new Error("wrap_with_condition only works on calls returning void.");
          namer.use("com.llamalad7.mixinextras.injector.v2.WrapWithCondition");
          annotationText = `@WrapWithCondition(method = ${methodSel}, at = ${atText})`;
          lines.push(`${I}${annotationText}`, `${I}private ${st}boolean ${handler}(${ps.join(", ")}) {`, `${I}${I}return true; // TODO: return false to skip the call`, `${I}}`);
        } else if (req.injection === "modify_expression_value") {
          if (ir === "V") throw new Error("The call returns void; nothing to modify.");
          namer.use("com.llamalad7.mixinextras.injector.ModifyExpressionValue");
          const t = namer.type(ir);
          annotationText = `@ModifyExpressionValue(method = ${methodSel}, at = ${atText})`;
          lines.push(`${I}${annotationText}`, `${I}private ${st}${t} ${handler}(${t} original) {`, `${I}${I}return original; // TODO: modify`, `${I}}`);
        } else if (req.injection === "modify_arg") {
          if (!ip.length) throw new Error("The call has no arguments.");
          const idx = req.argIndex ?? (ip.length === 1 ? 0 : undefined);
          if (idx === undefined || idx >= ip.length) throw new Error(`modify_arg needs argIndex (0..${ip.length - 1}) for ${call.name}${call.desc}.`);
          namer.use("org.spongepowered.asm.mixin.injection.ModifyArg");
          const t = namer.type(ip[idx]!);
          annotationText = `@ModifyArg(method = ${methodSel}, at = ${atText}, index = ${idx})`;
          lines.push(`${I}${annotationText}`, `${I}private ${st}${t} ${handler}(${t} value) {`, `${I}${I}return value; // TODO: modify`, `${I}}`);
        }
      }
    }
  }
  // assemble the file
  namer.use("org.spongepowered.asm.mixin.Mixin");
  const mixinTarget = isPublicChain(index, target) ? `${namer.type(`L${target};`)}.class` : `targets = "${target.replace(/\//g, ".")}"`;
  let content: string;
  if (existing && parsedExisting) {
    const newImports = [...namer.imports.values()].filter((f) => ![...parsedExisting.imports.values()].includes(f)).sort();
    content = existing;
    if (newImports.length) {
      const lastImport = [...content.matchAll(/^import\s+[\w.]+\s*;[ \t]*$/gm)].at(-1);
      const pos = lastImport ? lastImport.index! + lastImport[0].length : content.indexOf(";", content.indexOf("package")) + 1;
      content = content.slice(0, pos) + "\n" + newImports.map((i) => `import ${i};`).join("\n") + content.slice(pos);
    }
    const end = content.lastIndexOf("}");
    content = content.slice(0, end).replace(/\s*$/, "\n") + "\n" + lines.join("\n") + "\n}\n";
  } else {
    const imports = [...namer.imports.values()].sort();
    content = [
      `package ${pkg};`,
      "",
      ...imports.map((i) => `import ${i};`),
      "",
      "/**",
      ` * Generated by FFN mixin_generate for Minecraft ${index.meta.mcVersion} (${project.loader}, ${index.meta.namespace} names).`,
      " * Prefer a loader event/API when one covers the use case — mixins are the most version-fragile part of a mod.",
      " */",
      `@Mixin(${mixinTarget})`,
      isAccessor ? `public interface ${className} {` : `public abstract class ${className} {`,
      lines.join("\n"),
      "}",
      "",
    ].join("\n");
  }
  // validate the result (in-memory)
  const v = new MixinValidator(ctx);
  const rel = path.relative(project.dir, file);
  const res = v.validateSource(content, rel, section);
  // config update
  const list = Array.isArray(cfg[section]) ? [...(cfg[section] as string[])] : [];
  const already = (["mixins", "client", "server"] as const).some((s) => Array.isArray(cfg[s]) && (cfg[s] as string[]).includes(className));
  if (!already) list.push(className);
  const newCfg = already ? cfg : { ...cfg, [section]: list };
  return {
    file, className, fqcn: `${pkg}.${className}`, content, appended: !!existing, config: cfgPath, section, configChanged: !already,
    configContent: JSON.stringify(newCfg, null, 2) + "\n", handler, annotation: annotationText, issues: res.issues,
  };
}

export async function writePlan(plan: GeneratePlan): Promise<void> {
  await mkdir(path.dirname(plan.file), { recursive: true });
  await writeFile(plan.file, plan.content);
  if (plan.configChanged) await writeFile(plan.config, plan.configContent);
}
