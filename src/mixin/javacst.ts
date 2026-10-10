/**
 * Mixin class parsing with a real Java parser (java-parser, the Chevrotain-based parser behind
 * prettier-plugin-java). Produces the same ParsedJava model the validator uses; annotation values are
 * evaluated as constant expressions (string concatenation, class literals, enum constants and
 * `static final` String constants declared in the same file). Loaded lazily on first use.
 */
import { createRequire } from "node:module";
import type { Annotation, AnnValue, ParsedJava, ParsedMember, ParsedParam } from "./javaparse.js";

interface Tok {
  image: string;
  startOffset: number;
  startLine?: number;
  tokenType: { name: string };
}
interface Node {
  name: string;
  children: Record<string, (Node | Tok)[]>;
}
type El = Node | Tok;

let parser: { parse(src: string): Node } | undefined;
function jp() {
  parser ??= createRequire(import.meta.url)("java-parser") as { parse(src: string): Node };
  return parser;
}

const isTok = (x: El): x is Tok => (x as Tok).image !== undefined;
const kids = (n: Node | undefined, key: string): El[] => n?.children[key] ?? [];
const nodes = (n: Node | undefined, key: string): Node[] => kids(n, key).filter((x): x is Node => !isTok(x));
const node = (n: Node | undefined, key: string): Node | undefined => nodes(n, key)[0];

function toks(n: El, out: Tok[] = []): Tok[] {
  if (isTok(n)) out.push(n);
  else for (const k of Object.keys(n.children)) for (const c of n.children[k]!) toks(c, out);
  return out;
}
const sorted = (n: El): Tok[] => toks(n).sort((a, b) => a.startOffset - b.startOffset);
const WORD = /^[\w$]/;
function text(n: El | undefined): string {
  if (!n) return "";
  let s = "";
  let prev = "";
  for (const t of sorted(n)) {
    if (WORD.test(prev.slice(-1)) && WORD.test(t.image)) s += " ";
    s += t.image;
    prev = t.image;
  }
  return s;
}
const firstLine = (n: El): number => sorted(n)[0]?.startLine ?? 1;

/** Depth-first search for descendants named `name`, not descending into `stop` nodes. */
function find(n: Node, name: string, stop: Set<string> = new Set(), out: Node[] = []): Node[] {
  for (const k of Object.keys(n.children)) {
    for (const c of n.children[k]!) {
      if (isTok(c)) continue;
      if (c.name === name) out.push(c);
      else if (!stop.has(c.name)) find(c, name, stop, out);
    }
  }
  return out;
}

function unquote(lit: string): string {
  if (lit.startsWith('"""')) {
    const body = lit.slice(3, -3).replace(/^[^\n]*\n/, "");
    const lines = body.split("\n");
    const indent = Math.min(...lines.filter((l) => l.trim()).map((l) => /^\s*/.exec(l)![0].length));
    return lines.map((l) => l.slice(indent)).join("\n");
  }
  const inner = lit.slice(1, -1);
  return inner.replace(/\\(u+[0-9a-fA-F]{4}|[0-7]{1,3}|.)/g, (_, e: string) => {
    if (e[0] === "u") return String.fromCharCode(parseInt(e.replace(/^u+/, ""), 16));
    if (/^[0-7]/.test(e)) return String.fromCharCode(parseInt(e, 8));
    return ({ n: "\n", t: "\t", r: "\r", b: "\b", f: "\f", s: " " } as Record<string, string>)[e] ?? e;
  });
}

class Evaluator {
  constructor(
    private readonly consts: Map<string, AnnValue>,
    private readonly className: string,
  ) {}

  value(ev: Node): AnnValue {
    const ann = node(ev, "annotation");
    if (ann) return { t: "ann", v: this.annotation(ann) };
    const arr = node(ev, "elementValueArrayInitializer");
    if (arr) return { t: "arr", v: nodes(node(arr, "elementValueList"), "elementValue").map((e) => this.value(e)) };
    return this.expr(sorted(ev));
  }

  /** Constant expression from tokens: literals, '+' concatenation, class literals, names. */
  expr(ts: Tok[]): AnnValue {
    ts = ts.filter((t) => t.image !== "(" && t.image !== ")");
    // split on top-level '+'
    const parts: Tok[][] = [[]];
    for (const t of ts) {
      if (t.image === "+" && parts[parts.length - 1]!.length) parts.push([]);
      else parts[parts.length - 1]!.push(t);
    }
    if (parts.length > 1) {
      const vals = parts.map((p) => this.expr(p));
      if (vals.some((v) => v.t === "str")) return { t: "str", v: vals.map((v) => (v.t === "str" || v.t === "num" ? v.v : v.t === "ident" ? `\${${v.v}}` : String(v.v))).join("") };
      return { t: "ident", v: ts.map((t) => t.image).join("") };
    }
    if (ts.length === 1) {
      const t = ts[0]!;
      const k = t.tokenType.name;
      if (k === "StringLiteral" || k === "TextBlock") return { t: "str", v: unquote(t.image) };
      if (k === "True" || k === "False") return { t: "bool", v: k === "True" };
      if (k === "CharLiteral") return { t: "str", v: unquote(t.image) };
      if (/Literal$/.test(k)) return { t: "num", v: t.image };
    }
    if (ts.length === 2 && ts[0]!.image === "-" && /Literal$/.test(ts[1]!.tokenType.name)) return { t: "num", v: `-${ts[1]!.image}` };
    const joined = ts.map((t) => t.image).join("");
    if (joined.endsWith(".class")) return { t: "class", v: joined.slice(0, -6) };
    const local = joined.startsWith(`${this.className}.`) ? joined.slice(this.className.length + 1) : joined;
    return this.consts.get(local) ?? { t: "ident", v: joined };
  }

  annotation(a: Node): Annotation {
    const name = text(node(a, "typeName")).replace(/^.*\./, "");
    const args: Record<string, AnnValue> = {};
    for (const p of nodes(node(a, "elementValuePairList"), "elementValuePair")) {
      const k = kids(p, "Identifier")[0] as Tok;
      args[k.image] = this.value(node(p, "elementValue")!);
    }
    const single = node(a, "elementValue");
    if (single) args.value = this.value(single);
    return { name, args, start: sorted(a)[0]?.startOffset ?? 0 };
  }
}

const MODIFIER_KEYS = ["classModifier", "interfaceModifier", "fieldModifier", "methodModifier", "constructorModifier", "interfaceMethodModifier", "constantModifier", "variableModifier"];

function modsAndAnns(n: Node, ev: Evaluator): { modifiers: string[]; annotations: Annotation[] } {
  const modifiers: string[] = [];
  const annotations: Annotation[] = [];
  for (const key of MODIFIER_KEYS) {
    for (const m of nodes(n, key)) {
      const a = node(m, "annotation");
      if (a) annotations.push(ev.annotation(a));
      else modifiers.push(text(m));
    }
  }
  return { modifiers, annotations };
}

function params(header: Node | undefined, ev: Evaluator): ParsedParam[] {
  const list = node(header, "formalParameterList");
  const out: ParsedParam[] = [];
  for (const fp of nodes(list, "formalParameter")) {
    const reg = node(fp, "variableParaRegularParameter");
    const va = node(fp, "variableArityParameter");
    const p = reg ?? va;
    if (!p) continue;
    const { annotations } = modsAndAnns(p, ev);
    const type = text(node(p, "unannType")).replace(/\s+/g, "") + (va ? "[]" : "");
    const name = reg ? text(node(reg, "variableDeclaratorId")) : ((kids(va, "Identifier")[0] as Tok | undefined)?.image ?? "");
    out.push({ type: type.replace(/\.\.\.$/, "[]"), name: name.replace(/\[\]$/, ""), annotations });
  }
  return out;
}

/** Parse a Java compilation unit. Throws on syntax errors (callers fall back to the tolerant parser). */
export function parseJavaCst(source: string): ParsedJava {
  const cu = jp().parse(source);
  const ocu = node(cu, "ordinaryCompilationUnit");
  const pkgDecl = node(ocu, "packageDeclaration");
  const pkg = pkgDecl ? kids(pkgDecl, "Identifier").map((t) => (t as Tok).image).join(".") : "";
  const imports = new Map<string, string>();
  const wildcardImports: string[] = [];
  for (const im of nodes(ocu, "importDeclaration")) {
    if (kids(im, "Static").length) continue;
    const name = text(node(im, "packageOrTypeName")).replace(/\s+/g, "");
    if (!name) continue;
    if (kids(im, "Star").length) wildcardImports.push(name);
    else imports.set(name.slice(name.lastIndexOf(".") + 1), name);
  }
  const td = nodes(ocu, "typeDeclaration")[0];
  const cls = node(td, "classDeclaration");
  const itf = node(td, "interfaceDeclaration");
  const decl = cls ?? itf;
  const empty = { package: pkg, imports, wildcardImports, className: "", isInterface: false, classAnnotations: [], members: [], problems: ["No class or interface declaration found."] };
  if (!decl) return empty;
  const inner = cls ? (node(cls, "normalClassDeclaration") ?? node(cls, "enumDeclaration") ?? node(cls, "recordDeclaration")) : (node(itf, "normalInterfaceDeclaration") ?? node(itf, "annotationInterfaceDeclaration"));
  const className = text(node(inner, "typeIdentifier"));
  // Pass 1: String/primitive constants for annotation values.
  const consts = new Map<string, AnnValue>();
  const pre = new Evaluator(consts, className);
  const body = node(inner, "classBody") ?? node(inner, "interfaceBody") ?? node(node(inner, "enumBody"), "enumBodyDeclarations") ?? node(inner, "recordBody");
  const STOP = new Set(["classDeclaration", "interfaceDeclaration", "methodBody", "constructorBody", "block"]);
  for (const fd of [...find(body!, "fieldDeclaration", STOP), ...find(body!, "constantDeclaration", STOP)]) {
    const mods = text(fd);
    if (fd.name === "fieldDeclaration" && !(/\bstatic\b/.test(mods) && /\bfinal\b/.test(mods))) continue;
    for (const vd of nodes(node(fd, "variableDeclaratorList"), "variableDeclarator")) {
      const init = node(vd, "variableInitializer");
      if (!init) continue;
      const v = pre.expr(sorted(init));
      if (v.t === "str" || v.t === "num" || v.t === "bool") consts.set(text(node(vd, "variableDeclaratorId")), v);
    }
  }
  const ev = new Evaluator(consts, className);
  const { annotations: classAnnotations } = modsAndAnns(decl, ev);
  const members: ParsedMember[] = [];
  const lineOf = (n: Node, after: El | undefined) => (after ? firstLine(after) : firstLine(n));
  const firstNonAnnotation = (n: Node): El | undefined => {
    for (const key of MODIFIER_KEYS) for (const m of nodes(n, key)) if (!node(m, "annotation")) return m;
    return undefined;
  };
  for (const m of [...find(body!, "fieldDeclaration", STOP), ...find(body!, "constantDeclaration", STOP)]) {
    const { modifiers, annotations } = modsAndAnns(m, ev);
    const type = text(node(m, "unannType")).replace(/\s+/g, "");
    for (const vd of nodes(node(m, "variableDeclaratorList"), "variableDeclarator")) {
      members.push({ kind: "field", name: text(node(vd, "variableDeclaratorId")).replace(/\[\]$/, ""), type, params: [], modifiers, annotations, line: lineOf(m, firstNonAnnotation(m) ?? node(m, "unannType")) });
    }
  }
  for (const m of [...find(body!, "methodDeclaration", STOP), ...find(body!, "interfaceMethodDeclaration", STOP)]) {
    const { modifiers, annotations } = modsAndAnns(m, ev);
    const header = node(m, "methodHeader");
    for (const a of nodes(header, "annotation")) annotations.push(ev.annotation(a));
    const result = node(header, "result");
    const declarator = node(header, "methodDeclarator");
    const name = (kids(declarator, "Identifier")[0] as Tok).image;
    members.push({ kind: "method", name, type: text(result).replace(/\s+/g, ""), params: params(declarator, ev), modifiers, annotations, line: lineOf(m, firstNonAnnotation(m) ?? header) });
  }
  for (const m of find(body!, "constructorDeclaration", STOP)) {
    const { modifiers, annotations } = modsAndAnns(m, ev);
    members.push({ kind: "method", name: "<init>", type: "void", params: params(node(m, "constructorDeclarator"), ev), modifiers, annotations, line: lineOf(m, firstNonAnnotation(m) ?? node(m, "constructorDeclarator")) });
  }
  members.sort((a, b) => a.line - b.line);
  return { package: pkg, imports, wildcardImports, className, isInterface: !!itf, classAnnotations, members, problems: [] };
}
