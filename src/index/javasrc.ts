/**
 * Extract method declarations (with bodies) from Java source text (Vineflower output or sources jars).
 * Heuristic but robust for compiler-shaped code: tracks brace depth outside strings, chars and comments.
 */
import { descToJava, parseMethodDesc } from "./classfile.js";

export interface ExtractedMethod {
  /** 1-based first line (including annotations/javadoc directly above). */
  startLine: number;
  endLine: number;
  text: string;
  params: string[];
}

/** Per-line brace depth at the START of each line, ignoring braces in strings, chars and comments. */
export function lineDepths(lines: string[]): number[] {
  const depths: number[] = [];
  let depth = 0;
  let block = false;
  for (const line of lines) {
    depths.push(depth);
    let inStr: string | undefined;
    for (let i = 0; i < line.length; i++) {
      const c = line[i]!;
      if (block) {
        if (c === "*" && line[i + 1] === "/") {
          block = false;
          i++;
        }
        continue;
      }
      if (inStr) {
        if (c === "\\") i++;
        else if (c === inStr) inStr = undefined;
        continue;
      }
      if (c === "/" && line[i + 1] === "/") break;
      if (c === "/" && line[i + 1] === "*") {
        block = true;
        i++;
      } else if (c === '"' || c === "'") inStr = c;
      else if (c === "{") depth++;
      else if (c === "}") depth--;
    }
  }
  depths.push(depth);
  return depths;
}

function splitTopLevel(s: string): string[] {
  const out: string[] = [];
  let lvl = 0;
  let cur = "";
  for (const c of s) {
    if (c === "<" || c === "(") lvl++;
    else if (c === ">" || c === ")") lvl--;
    if (c === "," && lvl === 0) {
      out.push(cur);
      cur = "";
    } else cur += c;
  }
  if (cur.trim()) out.push(cur);
  return out.map((x) => x.trim()).filter(Boolean);
}

/** Simple type name of a declared parameter: "final Map<K, V> map" → "Map", "String... a" → "String[]". */
export function paramType(p: string): string {
  let s = p.replace(/@[\w.]+(\([^)]*\))?\s*/g, "").replace(/\bfinal\s+/g, "").trim();
  s = s.replace(/<[^<>]*(<[^<>]*>[^<>]*)*>/g, "");
  const varargs = s.includes("...");
  s = s.replace("...", " ");
  const parts = s.trim().split(/\s+/);
  let type = parts.length > 1 ? parts.slice(0, -1).join("") : parts[0]!;
  let dims = (type.match(/\[\]/g) ?? []).length + (varargs ? 1 : 0);
  // C-style "int a[]"
  const last = parts.at(-1)!;
  dims += (last.match(/\[\]/g) ?? []).length && parts.length > 1 ? (last.match(/\[\]/g) ?? []).length : 0;
  type = type.replace(/\[\]/g, "");
  return type.slice(type.lastIndexOf(".") + 1) + "[]".repeat(dims);
}

export function descParamTypes(desc: string): string[] {
  return parseMethodDesc(desc).params.map((p) => {
    const j = descToJava(p);
    const base = j.replace(/\[\]/g, "");
    return base.slice(base.lastIndexOf(".") + 1) + "[]".repeat((j.match(/\[\]/g) ?? []).length);
  });
}

/** Does a declared parameter list match a descriptor (type variables match anything)? */
export function paramsMatch(declared: string[], desc: string): boolean {
  const want = descParamTypes(desc);
  if (want.length !== declared.length) return false;
  return declared.every((d, i) => d === want[i] || /^[A-Z][A-Z0-9]?(\[\])*$/.test(d));
}

/**
 * Find declarations of `name` (use the simple class name for constructors) in the class body region.
 * `classPath` is the chain of simple names from the outer class to the target (["Outer","Inner"]).
 */
export function extractMethods(src: string, classPath: string[], name: string): ExtractedMethod[] {
  const lines = src.split("\n");
  const depths = lineDepths(lines);
  // locate the body of the target class
  let from = 0;
  let to = lines.length;
  let bodyDepth = 0;
  for (const cls of classPath) {
    const re = new RegExp(`\\b(class|interface|enum|record)\\s+${cls.replace(/\$/g, "\\$")}\\b`);
    let found = -1;
    for (let i = from; i < to; i++) if (depths[i] === bodyDepth && re.test(lines[i]!) && !/^\s*(\/\/|\*)/.test(lines[i]!)) { found = i; break; }
    if (found < 0) return [];
    let open = found;
    while (open < to && depths[open + 1]! <= bodyDepth) open++;
    let end = open + 1;
    while (end < lines.length && depths[end + 1]! > bodyDepth) end++;
    from = open + 1;
    to = end + 1;
    bodyDepth++;
  }
  const out: ExtractedMethod[] = [];
  const decl = new RegExp(`(^|[\\s>\\]])${name.replace(/\$/g, "\\$")}\\s*\\(`);
  for (let i = from; i < to; i++) {
    if (depths[i] !== bodyDepth) continue;
    const line = lines[i]!;
    if (!decl.test(line) || /^\s*(\/\/|\*|\/\*|return\b|new\b|this\.|super\.)/.test(line) || /[=.]\s*\w*\s*$/.test(line.slice(0, line.search(decl) + 1)) || /\bnew\s+\w+\s*$/.test(line.slice(0, line.search(decl) + 1))) continue;
    // header may span lines until "{" or ";"
    let hEnd = i;
    let header = line;
    while (!/[{;]\s*(\/\/.*)?$/.test(header) && hEnd + 1 < to) header += "\n" + lines[++hEnd]!;
    const open = header.indexOf("(", header.search(decl));
    let lvl = 0;
    let close = -1;
    for (let k = open; k < header.length; k++) {
      if (header[k] === "(") lvl++;
      else if (header[k] === ")" && --lvl === 0) { close = k; break; }
    }
    if (close < 0) continue;
    const params = splitTopLevel(header.slice(open + 1, close)).map(paramType);
    let end = hEnd;
    if (!/;\s*(\/\/.*)?$/.test(header)) while (end + 1 < lines.length && depths[end + 1]! > bodyDepth) end++;
    let start = i;
    while (start - 1 >= from && /^\s*(@|\*|\/\*\*|\*\/)/.test(lines[start - 1]!) && depths[start - 1] === bodyDepth) start--;
    out.push({ startLine: start + 1, endLine: end + 1, text: lines.slice(start, end + 1).join("\n"), params });
    i = end;
  }
  return out;
}
