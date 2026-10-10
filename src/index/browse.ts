/**
 * Package browsing (subpackages + classes of one package) and callees (what a method references), both from the
 * class index / bytecode. Shared verbatim between FFN and BSP.
 */
import { ACC } from "./classfile.js";
import type { McIndex } from "./store.js";

export interface PackageEntry {
  kind: "package" | "class";
  /** Simple name (last package segment, or class simple name). */
  name: string;
  /** package: classes in it and below; class: interface/enum/record/@interface/abstract or "". */
  info: number | string;
}

/** Normalize "a.b.c" / "a/b/c/" / "." / "/" (root) to an internal package prefix ("" = root). */
export function normPackage(q: string): string {
  return q.trim().replace(/[./]\*$/, "").replace(/[./]+$/, "").replace(/^[./]+/, "").replace(/\./g, "/");
}

const pkgOf = (n: string) => n.slice(0, Math.max(0, n.lastIndexOf("/")));

/** Every package that contains at least one class (directly or below), internal form. */
function allPackages(index: McIndex): Set<string> {
  const out = new Set<string>([""]);
  for (const n of index.classes.keys()) {
    let p = pkgOf(n);
    while (p && !out.has(p)) {
      out.add(p);
      p = pkgOf(p);
    }
  }
  return out;
}

/**
 * Resolve a package query: exact, else a unique package ending with it ("level.block" → net/minecraft/world/level/block).
 * Returns the package or candidates.
 */
export function resolvePackage(index: McIndex, q: string): { pkg?: string; candidates: string[] } {
  const want = normPackage(q);
  const pkgs = allPackages(index);
  if (pkgs.has(want)) return { pkg: want, candidates: [] };
  const suffix = [...pkgs].filter((p) => p.endsWith(`/${want}`)).sort();
  if (suffix.length === 1) return { pkg: suffix[0], candidates: [] };
  if (suffix.length) return { candidates: suffix };
  const low = want.toLowerCase();
  const seg = low.slice(low.lastIndexOf("/") + 1);
  return { candidates: [...pkgs].filter((p) => p && p.slice(p.lastIndexOf("/") + 1).toLowerCase().includes(seg)).sort().slice(0, 10) };
}

function classKind(a: number): string {
  if (a & ACC.ANNOTATION) return "@interface";
  if (a & ACC.INTERFACE) return "interface";
  if (a & ACC.ENUM) return "enum";
  if (a & ACC.ABSTRACT) return "abstract";
  return "";
}

/** Direct subpackages (with total class counts) then top-level classes of a package, both sorted by name. */
export function listPackage(index: McIndex, pkg: string): PackageEntry[] {
  const subs = new Map<string, number>();
  const classes: PackageEntry[] = [];
  const pre = pkg ? `${pkg}/` : "";
  for (const c of index.classes.values()) {
    if (!c.n.startsWith(pre)) continue;
    const rest = c.n.slice(pre.length);
    const slash = rest.indexOf("/");
    if (slash >= 0) subs.set(rest.slice(0, slash), (subs.get(rest.slice(0, slash)) ?? 0) + (rest.includes("$") ? 0 : 1));
    else if (!rest.includes("$")) classes.push({ kind: "class", name: rest, info: c.s === "java/lang/Record" ? "record" : classKind(c.a) });
  }
  const byName = (a: PackageEntry, b: PackageEntry) => a.name.localeCompare(b.name);
  return [...[...subs].map(([name, n]): PackageEntry => ({ kind: "package", name, info: n })).sort(byName), ...classes.sort(byName)];
}

export interface Callee {
  /** call | get | put | ref (method handle: lambda body / method reference) */
  how: "call" | "get" | "put" | "ref";
  owner: string;
  name: string;
  desc: string;
  /** Found inside a lambda body of the method (followed through invokedynamic). */
  inLambda?: boolean;
}

/**
 * What a method references in its bytecode: invoked methods, read/written fields, method handles. Synthetic lambda
 * bodies of the same class reached through invokedynamic are followed (marked inLambda). Deduped, first-seen order.
 */
export function findCallees(index: McIndex, owner: string, name: string, desc: string): Callee[] | undefined {
  const r = index.reader(owner);
  const start = r?.info.methods.find((m) => m.name === name && m.desc === desc);
  if (!r || !start) return undefined;
  const out: Callee[] = [];
  const seen = new Set<string>();
  const add = (c: Callee) => {
    const k = `${c.how} ${c.owner}.${c.name}${c.desc}`;
    if (!seen.has(k)) {
      seen.add(k);
      out.push(c);
    }
  };
  const visited = new Set<string>();
  const walk = (m: (typeof r.info.methods)[number], inLambda: boolean) => {
    if (visited.has(m.name + m.desc)) return;
    visited.add(m.name + m.desc);
    const refs = r.analyze(m);
    for (const x of refs.invokes) add({ how: "call", owner: x.owner, name: x.name, desc: x.desc, ...(inLambda ? { inLambda } : {}) });
    for (const x of refs.fields) add({ how: x.opcode.startsWith("GET") ? "get" : "put", owner: x.owner, name: x.name, desc: x.desc, ...(inLambda ? { inLambda } : {}) });
    for (const h of refs.handles) {
      const body = h.owner === owner && !h.field ? r.info.methods.find((mm) => mm.name === h.name && mm.desc === h.desc && mm.access & ACC.SYNTHETIC) : undefined;
      if (body) walk(body, true);
      else add({ how: h.field ? "get" : "ref", owner: h.owner, name: h.name, desc: h.desc, ...(inLambda ? { inLambda } : {}) });
    }
  };
  walk(start, false);
  return out;
}
