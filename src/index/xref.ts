/**
 * Bytecode cross-references for an index: who calls a method, reads/writes a field or uses a class, plus the class
 * hierarchy in both directions (supertypes, subclasses/implementors, overrides).
 * The reference table (constant-pool refs per class) is built lazily on first use and cached next to the index.
 */
import AdmZip from "adm-zip";
import { existsSync } from "node:fs";
import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { ClassReader } from "./classfile.js";
import type { IndexedClass, McIndex } from "./store.js";

interface RefFile {
  v: 1;
  strings: string[];
  names: string[];
  refs: number[][];
}

/** "M owner name desc" | "F owner name desc" | "C owner" */
export type RefKey = string;

export class XrefTable {
  private byKey = new Map<string, number>();
  private users = new Map<number, number[]>();
  constructor(private readonly f: RefFile) {
    f.strings.forEach((s, i) => this.byKey.set(s, i));
    f.refs.forEach((ids, c) => {
      for (const id of ids) {
        const l = this.users.get(id);
        if (l) l.push(c);
        else this.users.set(id, [c]);
      }
    });
  }
  /** Classes whose constant pool references one of the keys. */
  classesUsing(keys: RefKey[]): Map<string, Set<RefKey>> {
    const out = new Map<string, Set<RefKey>>();
    for (const k of keys) {
      const id = this.byKey.get(k);
      if (id === undefined) continue;
      for (const c of this.users.get(id) ?? []) {
        const n = this.f.names[c]!;
        const s = out.get(n) ?? new Set();
        s.add(k);
        out.set(n, s);
      }
    }
    return out;
  }
}

/** Constant-pool references of one class. */
export function poolRefs(r: ClassReader): RefKey[] {
  const out = new Set<RefKey>();
  r.pool.forEach((c, i) => {
    if (!c) return;
    if (c.tag === 7) out.add(`C ${r.utf8(c.index)}`);
    else if (c.tag === 9 || c.tag === 10 || c.tag === 11) {
      const ref = r.ref(i);
      out.add(`${c.tag === 9 ? "F" : "M"} ${ref.owner} ${ref.name} ${ref.desc}`);
    }
  });
  return [...out];
}

const tables = new WeakMap<McIndex, Promise<XrefTable>>();

/** The reference table of an index (built once, ~seconds, then cached on disk as refs.json). */
export function xrefs(index: McIndex): Promise<XrefTable> {
  let t = tables.get(index);
  if (!t) {
    t = (async () => {
      const file = path.join(index.dir, "refs.json");
      if (existsSync(file)) {
        try {
          const j = JSON.parse(await readFile(file, "utf8")) as RefFile;
          if (j.v === 1) return new XrefTable(j);
        } catch {
          /* rebuild */
        }
      }
      const strings: string[] = [];
      const ids = new Map<string, number>();
      const names: string[] = [];
      const refs: number[][] = [];
      for (const e of new AdmZip(index.meta.jar).getEntries()) {
        const n = e.entryName;
        if (!n.endsWith(".class") || n.startsWith("META-INF/")) continue;
        const cls = n.slice(0, -6);
        if (!index.classes.has(cls)) continue;
        let keys: RefKey[];
        try {
          keys = poolRefs(new ClassReader(e.getData()));
        } catch {
          continue;
        }
        names.push(cls);
        refs.push(
          keys.map((k) => {
            let id = ids.get(k);
            if (id === undefined) {
              id = strings.length;
              strings.push(k);
              ids.set(k, id);
            }
            return id;
          }),
        );
      }
      const f: RefFile = { v: 1, strings, names, refs };
      const tmp = `${file}.${process.pid}.tmp`;
      await writeFile(tmp, JSON.stringify(f));
      await rename(tmp, file);
      return new XrefTable(f);
    })();
    tables.set(index, t);
    t.catch(() => tables.delete(index));
  }
  return t;
}

// ---------------------------------------------------------------- hierarchy

const subsCache = new WeakMap<McIndex, Map<string, string[]>>();

/** Direct subclasses and implementors (reverse of super/interfaces) within the index. */
export function directSubtypes(index: McIndex, name: string): string[] {
  let m = subsCache.get(index);
  if (!m) {
    m = new Map();
    for (const c of index.classes.values()) {
      for (const p of [c.s, ...c.i]) {
        if (!p) continue;
        const l = m.get(p);
        if (l) l.push(c.n);
        else m.set(p, [c.n]);
      }
    }
    for (const l of m.values()) l.sort();
    subsCache.set(index, m);
  }
  return m.get(name) ?? [];
}

/** All transitive subtypes (BFS). */
export function allSubtypes(index: McIndex, name: string): string[] {
  const out: string[] = [];
  const seen = new Set([name]);
  const q = [name];
  while (q.length) {
    for (const s of directSubtypes(index, q.shift()!)) {
      if (seen.has(s)) continue;
      seen.add(s);
      out.push(s);
      q.push(s);
    }
  }
  return out;
}

/** Superclass chain (excluding the class itself), ending at the first class not in the index. */
export function superChain(index: McIndex, name: string): string[] {
  const out: string[] = [];
  let c: IndexedClass | undefined = index.get(name);
  while (c?.s) {
    out.push(c.s);
    c = index.get(c.s);
  }
  return out;
}

/** All interfaces implemented directly or through supertypes. */
export function allInterfaces(index: McIndex, name: string): string[] {
  const out = new Set<string>();
  const visit = (n: string) => {
    const c = index.get(n);
    if (!c) return;
    for (const i of c.i) {
      if (!out.has(i)) {
        out.add(i);
        visit(i);
      }
    }
    if (c.s) visit(c.s);
  };
  visit(name);
  return [...out];
}

const declares = (c: IndexedClass | undefined, name: string, desc: string) => !!c?.m.some(([n, d]) => n === name && d === desc);

/** Supertypes declaring the same method (what it overrides/implements) and subtypes that override it. */
export function overrides(index: McIndex, owner: string, name: string, desc: string): { overrides: string[]; overriddenBy: string[] } {
  const supers = [...superChain(index, owner), ...allInterfaces(index, owner)];
  return {
    overrides: supers.filter((s) => declares(index.get(s), name, desc)),
    overriddenBy: allSubtypes(index, owner).filter((s) => declares(index.get(s), name, desc)),
  };
}

// ---------------------------------------------------------------- usages

export interface Usage {
  /** Class containing the reference. */
  cls: string;
  /** Method containing the reference: name+desc; undefined = only via a method handle/lambda bootstrap or class-level. */
  method?: string;
  /** How: INVOKEVIRTUAL, GETFIELD, NEW, type, … */
  how: string;
  /** Referenced owner when it differs from the queried class (call through a subtype). */
  via?: string;
}

export interface UsageTarget {
  owner: string;
  member?: { kind: "method" | "field"; name: string; desc?: string };
}

/** Find usages of a class or member. Calls through subtypes are included (marked `via`). */
export async function findUsages(index: McIndex, t: UsageTarget): Promise<Usage[]> {
  const table = await xrefs(index);
  const owners = [t.owner, ...allSubtypes(index, t.owner)];
  const out: Usage[] = [];
  if (t.member) {
    const m = t.member;
    const field = m.kind === "method" ? "m" : "f";
    const declaredIn = [t.owner, ...superChain(index, t.owner), ...allInterfaces(index, t.owner)];
    const descs = m.desc ? [m.desc] : [...new Set(declaredIn.flatMap((o) => (index.get(o)?.[field] ?? []).filter(([n]) => n === m.name).map(([, d]) => d)))];
    const p = m.kind === "method" ? "M" : "F";
    const keys = owners.flatMap((o) => descs.map((d) => `${p} ${o} ${m.name} ${d}`));
    const hits = table.classesUsing(keys);
    for (const [cls, ks] of hits) {
      const r = index.reader(cls);
      if (!r) continue;
      let inMethod = false;
      for (const meth of r.info.methods) {
        const refs = r.analyze(meth);
        const list = m.kind === "method" ? refs.invokes : refs.fields;
        for (const x of list) {
          if (x.name !== m.name || !ks.has(`${p} ${x.owner} ${x.name} ${x.desc}`)) continue;
          out.push({ cls, method: meth.name + meth.desc, how: x.opcode, ...(x.owner !== t.owner ? { via: x.owner } : {}) });
          inMethod = true;
        }
      }
      if (!inMethod) out.push({ cls, how: "method reference" });
    }
  } else {
    const hits = table.classesUsing([`C ${t.owner}`]);
    const L = `L${t.owner};`;
    for (const [cls] of hits) {
      if (cls === t.owner || cls.startsWith(`${t.owner}$`)) continue;
      const r = index.reader(cls);
      if (!r) continue;
      let any = false;
      for (const meth of r.info.methods) {
        const refs = r.analyze(meth);
        const how = new Set<string>();
        if (refs.news.includes(t.owner)) how.add("new");
        if (refs.instanceofs.includes(t.owner)) how.add("instanceof");
        if (refs.invokes.some((x) => x.owner === t.owner)) how.add("call");
        if (refs.fields.some((x) => x.owner === t.owner)) how.add("field");
        if (refs.typedConstants.some((x) => x.type === "class" && x.value === t.owner)) how.add("class literal");
        if (how.size) {
          out.push({ cls, method: meth.name + meth.desc, how: [...how].join("+") });
          any = true;
        }
      }
      if (!any) out.push({ cls, how: "type" });
    }
    // members whose signature mentions the class (parameters, returns, fields)
    for (const c of index.classes.values()) {
      if (c.n === t.owner || hits.has(c.n)) continue;
      const f = c.f.find(([, d]) => d.includes(L));
      const m = c.m.find(([, d]) => d.includes(L));
      if (f) out.push({ cls: c.n, how: `field ${f[0]}` });
      else if (m) out.push({ cls: c.n, method: m[0] + m[1], how: "signature" });
    }
  }
  return out.sort((a, b) => a.cls.localeCompare(b.cls) || (a.method ?? "").localeCompare(b.method ?? ""));
}

/** Parse "Owner#member(desc)" / "Owner#field" / "Owner" (dots or slashes). */
export function parseTarget(q: string): { cls: string; member?: string; desc?: string } {
  const [cls, rest] = q.trim().split("#");
  if (!rest) return { cls: cls! };
  const paren = rest.indexOf("(");
  const colon = rest.indexOf(":");
  if (paren > 0) return { cls: cls!, member: rest.slice(0, paren), desc: rest.slice(paren) };
  if (colon > 0) return { cls: cls!, member: rest.slice(0, colon), desc: rest.slice(colon + 1) };
  return { cls: cls!, member: rest };
}
