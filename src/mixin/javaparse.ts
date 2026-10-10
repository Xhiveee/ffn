/**
 * Lightweight Java parsing for Mixin classes: enough structure (package, imports, @Mixin, member
 * annotations with their element values, declarations) to validate against the class index.
 * Not a full Java parser; it is tolerant and reports what it could not understand.
 */
import { javaToDesc } from "../index/classfile.js";

export type AnnValue =
  | { t: "str"; v: string }
  | { t: "num"; v: string }
  | { t: "bool"; v: boolean }
  | { t: "class"; v: string }
  | { t: "ident"; v: string }
  | { t: "arr"; v: AnnValue[] }
  | { t: "ann"; v: Annotation };

export interface Annotation {
  name: string;
  /** Element values; a single positional value is stored under "value". */
  args: Record<string, AnnValue>;
  start: number;
}

export interface ParsedParam {
  type: string;
  name: string;
  annotations: Annotation[];
}

export interface ParsedMember {
  kind: "method" | "field";
  name: string;
  /** Raw Java type text (return type for methods). */
  type: string;
  params: ParsedParam[];
  modifiers: string[];
  annotations: Annotation[];
  /** 1-based line of the declaration. */
  line: number;
}

export interface ParsedJava {
  package: string;
  imports: Map<string, string>; // simple → FQN (dotted)
  wildcardImports: string[];
  className: string;
  isInterface: boolean;
  classAnnotations: Annotation[];
  members: ParsedMember[];
  problems: string[];
}

/** Remove comments, keep string literals and line structure. */
export function stripComments(src: string): string {
  let out = "";
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    const n = src[i + 1];
    if (c === "/" && n === "/") {
      while (i < src.length && src[i] !== "\n") i++;
    } else if (c === "/" && n === "*") {
      i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) {
        if (src[i] === "\n") out += "\n";
        i++;
      }
      i += 2;
    } else if (c === '"' && src.startsWith('"""', i)) {
      const end = src.indexOf('"""', i + 3);
      const e = end < 0 ? src.length : end + 3;
      out += src.slice(i, e);
      i = e;
    } else if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < src.length && src[j] !== c) j += src[j] === "\\" ? 2 : 1;
      out += src.slice(i, j + 1);
      i = j + 1;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

class Cursor {
  constructor(readonly s: string, public i = 0) {}
  ws() {
    while (this.i < this.s.length && /\s/.test(this.s[this.i]!)) this.i++;
  }
  peek() {
    this.ws();
    return this.s[this.i];
  }
  eat(ch: string) {
    this.ws();
    if (this.s.startsWith(ch, this.i)) {
      this.i += ch.length;
      return true;
    }
    return false;
  }
  ident(): string | undefined {
    this.ws();
    const m = /^[A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*/.exec(this.s.slice(this.i, this.i + 400));
    if (!m) return undefined;
    this.i += m[0].length;
    return m[0].replace(/\s+/g, "");
  }
}

function parseString(c: Cursor): string {
  c.ws();
  let out = "";
  const q = c.s[c.i];
  if (q !== '"') throw new Error("expected string");
  c.i++;
  while (c.i < c.s.length && c.s[c.i] !== '"') {
    if (c.s[c.i] === "\\") {
      const e = c.s[c.i + 1]!;
      out += e === "n" ? "\n" : e === "t" ? "\t" : e;
      c.i += 2;
    } else out += c.s[c.i++];
  }
  c.i++;
  return out;
}

function parseValue(c: Cursor): AnnValue {
  const p = c.peek();
  if (p === "{") {
    c.eat("{");
    const arr: AnnValue[] = [];
    while (c.peek() !== "}" && c.i < c.s.length) {
      arr.push(parseValue(c));
      if (!c.eat(",")) break;
    }
    c.eat("}");
    return { t: "arr", v: arr };
  }
  if (p === "@") return { t: "ann", v: parseAnnotation(c) };
  if (p === '"') {
    let s = parseString(c);
    while (c.eat("+")) {
      if (c.peek() === '"') s += parseString(c);
      else c.ident();
    }
    return { t: "str", v: s };
  }
  if (p === "'") {
    c.i++;
    const ch = c.s[c.i] === "\\" ? c.s.slice(c.i, c.i + 2) : c.s[c.i]!;
    c.i += ch.length + 1;
    return { t: "str", v: ch };
  }
  const num = /^-?(?:0x[\da-fA-F]+|\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?)[lLfFdD]?/.exec(c.s.slice(c.i));
  if (num) {
    c.i += num[0].length;
    return { t: "num", v: num[0] };
  }
  const id = c.ident();
  if (!id) throw new Error(`unexpected '${c.s.slice(c.i, c.i + 20)}'`);
  if (id === "true" || id === "false") return { t: "bool", v: id === "true" };
  if (id.endsWith(".class")) return { t: "class", v: id.slice(0, -6) };
  return { t: "ident", v: id };
}

export function parseAnnotation(c: Cursor): Annotation {
  c.ws();
  const start = c.i;
  if (!c.eat("@")) throw new Error("expected @");
  const name = c.ident() ?? "";
  const args: Record<string, AnnValue> = {};
  if (c.peek() === "(") {
    c.eat("(");
    if (c.peek() !== ")") {
      const save = c.i;
      const id = c.ident();
      if (id && c.eat("=") && !c.s.startsWith("=", c.i)) {
        args[id] = parseValue(c);
        while (c.eat(",")) {
          const k = c.ident()!;
          c.eat("=");
          args[k] = parseValue(c);
        }
      } else {
        c.i = save;
        args.value = parseValue(c);
      }
    }
    c.eat(")");
  }
  return { name: name.replace(/^.*\./, ""), args, start };
}

/** Collect annotations at the cursor (skips none). */
function annotationsAt(c: Cursor): Annotation[] {
  const out: Annotation[] = [];
  while (c.peek() === "@" && !c.s.startsWith("@interface", c.i)) out.push(parseAnnotation(c));
  return out;
}

const MODIFIERS = new Set(["public", "protected", "private", "static", "final", "abstract", "native", "synchronized", "transient", "volatile", "strictfp", "default"]);

function splitTopLevel(s: string, sep = ","): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of s) {
    if (ch === "<" || ch === "(" || ch === "[" || ch === "{") depth++;
    if (ch === ">" || ch === ")" || ch === "]" || ch === "}") depth--;
    if (ch === sep && depth === 0) {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

function skipBalanced(s: string, i: number, open: string, close: string): number {
  let depth = 0;
  for (; i < s.length; i++) {
    const ch = s[i];
    if (ch === '"') {
      i++;
      while (i < s.length && s[i] !== '"') i += s[i] === "\\" ? 2 : 1;
      continue;
    }
    if (ch === open) depth++;
    else if (ch === close && --depth === 0) return i + 1;
  }
  return s.length;
}

export function parseJava(source: string): ParsedJava {
  const s = stripComments(source);
  const problems: string[] = [];
  const pkg = /\bpackage\s+([\w.]+)\s*;/.exec(s)?.[1] ?? "";
  const imports = new Map<string, string>();
  const wildcardImports: string[] = [];
  for (const m of s.matchAll(/\bimport\s+(static\s+)?([\w.]+)(\.\*)?\s*;/g)) {
    if (m[1]) continue;
    if (m[3]) wildcardImports.push(m[2]!);
    else imports.set(m[2]!.slice(m[2]!.lastIndexOf(".") + 1), m[2]!);
  }
  const lineAt = (i: number) => s.slice(0, i).split("\n").length;
  // class header: annotations + modifiers + class/interface Name
  const header = /((?:@[\w.]+(?:\s*\((?:[^()]|\((?:[^()]|\([^()]*\))*\))*\))?\s*)*)((?:(?:public|protected|private|abstract|final|static)\s+)*)(class|interface)\s+([\w$]+)/.exec(s);
  if (!header) return { package: pkg, imports, wildcardImports, className: "", isInterface: false, classAnnotations: [], members: [], problems: ["No class or interface declaration found."] };
  const classAnnotations: Annotation[] = [];
  try {
    const c = new Cursor(s, header.index);
    classAnnotations.push(...annotationsAt(c));
  } catch (e) {
    problems.push(`Could not parse class annotations: ${(e as Error).message}`);
  }
  const bodyStart = s.indexOf("{", header.index + header[0].length);
  const bodyEnd = skipBalanced(s, bodyStart, "{", "}") - 1;
  const members: ParsedMember[] = [];
  // Walk top-level members of the class body.
  let i = bodyStart + 1;
  while (i < bodyEnd) {
    const c = new Cursor(s, i);
    c.ws();
    if (c.i >= bodyEnd) break;
    if (s[c.i] === ";") {
      i = c.i + 1;
      continue;
    }
    if (s[c.i] === "{") {
      i = skipBalanced(s, c.i, "{", "}");
      continue;
    }
    let anns: Annotation[] = [];
    try {
      anns = annotationsAt(c);
    } catch (e) {
      problems.push(`Line ${lineAt(c.i)}: could not parse annotation (${(e as Error).message}).`);
    }
    const declStart = c.i;
    const mods: string[] = [];
    for (;;) {
      const save = c.i;
      const id = c.ident();
      if (id && MODIFIERS.has(id)) mods.push(id);
      else {
        c.i = save;
        break;
      }
      anns.push(...(c.peek() === "@" ? annotationsAt(c) : []));
    }
    // nested type → skip
    const rest = s.slice(c.i, c.i + 30);
    if (/^(class|interface|enum|record|@interface)\b/.test(rest)) {
      const ob = s.indexOf("{", c.i);
      i = skipBalanced(s, ob, "{", "}");
      continue;
    }
    // find end of declaration head: first top-level '(' ';' '=' or '{'
    let j = c.i;
    let depth = 0;
    while (j < bodyEnd) {
      const ch = s[j]!;
      if (ch === "<") depth++;
      else if (ch === ">") depth--;
      else if (depth === 0 && (ch === "(" || ch === ";" || ch === "=" || ch === "{")) break;
      j++;
    }
    const head = s.slice(c.i, j).trim();
    const hm = /^(?:<[^>]*(?:<[^>]*>[^>]*)*>\s*)?([\w$.<>\[\]?,\s]+?)\s+([\w$]+)$/.exec(head) ?? /^([\w$]+)$/.exec(head);
    if (s[j] === "(") {
      const pend = skipBalanced(s, j, "(", ")");
      const paramText = s.slice(j + 1, pend - 1);
      const params: ParsedParam[] = [];
      for (const raw of splitTopLevel(paramText)) {
        const pc = new Cursor(raw.trim());
        let panns: Annotation[] = [];
        try {
          panns = annotationsAt(pc);
        } catch {
          /* ignore */
        }
        const restP = raw.trim().slice(pc.i).trim().replace(/\bfinal\s+/, "");
        const pm = /^(.*?)\s*([\w$]+)$/.exec(restP);
        if (pm) params.push({ type: pm[1]!.replace(/\s+/g, ""), name: pm[2]!, annotations: panns });
      }
      // body or ';'
      let k = pend;
      while (k < bodyEnd && s[k] !== "{" && s[k] !== ";") k++;
      const end = s[k] === "{" ? skipBalanced(s, k, "{", "}") : k + 1;
      if (hm) {
        const isCtor = hm.length === 2;
        members.push({ kind: "method", name: isCtor ? "<init>" : hm[2]!, type: isCtor ? "void" : hm[1]!.replace(/\s+/g, ""), params, modifiers: mods, annotations: anns, line: lineAt(declStart) });
      }
      i = end;
    } else {
      // field: up to ';' at top level
      let k = j;
      let d = 0;
      while (k < bodyEnd) {
        const ch = s[k]!;
        if (ch === "{" || ch === "(") d++;
        else if (ch === "}" || ch === ")") d--;
        else if (ch === '"') {
          k++;
          while (k < bodyEnd && s[k] !== '"') k += s[k] === "\\" ? 2 : 1;
        } else if (ch === ";" && d === 0) break;
        k++;
      }
      if (hm && hm.length === 3) members.push({ kind: "field", name: hm[2]!, type: hm[1]!.replace(/\s+/g, ""), params: [], modifiers: mods, annotations: anns, line: lineAt(declStart) });
      i = k + 1;
    }
  }
  return { package: pkg, imports, wildcardImports, className: header[4]!, isInterface: header[3] === "interface", classAnnotations, members, problems };
}

const JAVA_LANG = new Set(["Object", "String", "Integer", "Long", "Short", "Byte", "Character", "Boolean", "Float", "Double", "Void", "Number", "Class", "Enum", "Iterable", "Runnable", "Throwable", "Exception", "RuntimeException", "Error", "Thread", "Math", "System", "StringBuilder", "CharSequence", "Comparable", "Record", "AutoCloseable"]);
const PRIMS = new Set(["void", "boolean", "byte", "char", "short", "int", "long", "float", "double"]);

/**
 * Resolve a Java source type to an internal name / descriptor using the file's imports.
 * `classExists` lets callers resolve nested types (Outer.Inner → Outer$Inner) against an index.
 */
export function resolveType(p: ParsedJava, type: string, classExists?: (internal: string) => boolean): { desc?: string; unresolved?: string } {
  let t = type.replace(/<.*>/g, "").replace(/\.\.\.$/, "[]").trim();
  let dims = 0;
  while (t.endsWith("[]")) {
    dims++;
    t = t.slice(0, -2);
  }
  const arr = "[".repeat(dims);
  if (PRIMS.has(t)) return { desc: arr + javaToDesc(t) };
  const parts = t.split(".");
  const head = parts[0]!;
  let fqn: string | undefined;
  if (p.imports.has(head)) fqn = [p.imports.get(head)!, ...parts.slice(1)].join(".");
  else if (/^[a-z]/.test(head) && parts.length > 1) fqn = t; // already qualified
  else if (JAVA_LANG.has(head)) fqn = `java.lang.${t}`;
  else if (p.wildcardImports.length && classExists) {
    for (const w of p.wildcardImports) if (classExists(`${w}.${head}`.replace(/\./g, "/"))) fqn = `${w}.${t}`;
  }
  if (!fqn) {
    if (classExists && classExists(`${p.package}.${head}`.replace(/\./g, "/"))) fqn = `${p.package}.${t}`;
    else if (head === "CallbackInfo" || head === "CallbackInfoReturnable") fqn = `org.spongepowered.asm.mixin.injection.callback.${t}`;
    else return { unresolved: type };
  }
  // nested class resolution: a.b.Outer.Inner → a/b/Outer$Inner
  const segs = fqn.split(".");
  let internal = segs.join("/");
  if (classExists) {
    for (let k = segs.length - 1; k > 0; k--) {
      const cand = segs.slice(0, k).join("/") + (k < segs.length ? "/" + segs.slice(k).join("$") : "");
      if (classExists(cand)) {
        internal = cand;
        break;
      }
    }
  }
  return { desc: `${arr}L${internal};` };
}

// ---- helpers for annotation values ----
export const strOf = (v?: AnnValue): string | undefined => (v?.t === "str" ? v.v : undefined);
export const strsOf = (v?: AnnValue): string[] => (!v ? [] : v.t === "arr" ? v.v.flatMap(strsOf) : v.t === "str" ? [v.v] : []);
export const annsOf = (v?: AnnValue): Annotation[] => (!v ? [] : v.t === "arr" ? v.v.flatMap(annsOf) : v.t === "ann" ? [v.v] : []);
export const classesOf = (v?: AnnValue): string[] => (!v ? [] : v.t === "arr" ? v.v.flatMap(classesOf) : v.t === "class" ? [v.v] : []);
export const boolOf = (v?: AnnValue): boolean | undefined => (v?.t === "bool" ? v.v : undefined);
export const numOf = (v?: AnnValue): number | undefined => (v?.t === "num" ? Number(v.v.replace(/[lLfFdD_]/g, "")) : undefined);
