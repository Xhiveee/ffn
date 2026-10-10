/**
 * Mapping formats used across Minecraft versions, normalised to one in-memory model keyed by
 * the obfuscated ("official") names:
 *  - Mojang ProGuard (client_mappings / server_mappings)  named ← obf
 *  - Fabric tiny v2 (intermediary, yarn mergedv2)         official → intermediary → named
 *  - MCPConfig tsrg2 (joined.tsrg)                        obf → srg → id
 */
import { javaToDesc, mapDesc } from "./classfile.js";

export interface MappingSet {
  /** Namespace names in column order; column 0 is always "obf". */
  namespaces: string[];
  /** obf internal class name → names per namespace (index aligned with namespaces). */
  classes: Map<string, string[]>;
  /** key `obfOwner\tobfName\tobfDesc` (desc may be "" for tsrg fields) → names. */
  fields: Map<string, string[]>;
  methods: Map<string, string[]>;
}

const key = (owner: string, name: string, desc: string) => `${owner}\t${name}\t${desc}`;

export function emptySet(namespaces: string[]): MappingSet {
  return { namespaces, classes: new Map(), fields: new Map(), methods: new Map() };
}

/** Parse Mojang ProGuard mappings (may be called repeatedly to merge client + server). */
export function parseProguard(text: string, into: MappingSet = emptySet(["obf", "mojmap"])): MappingSet {
  type Pending = { owner: string; obf: string; named: string; namedDesc: string; isMethod: boolean };
  const pending: Pending[] = [];
  const namedToObf = new Map<string, string>();
  for (const [obf, names] of into.classes) namedToObf.set(names[1]!, obf);
  let owner: string | undefined;
  for (const raw of text.split("\n")) {
    if (!raw || raw.startsWith("#")) continue;
    const line = raw.replace(/\r$/, "");
    if (!line.startsWith(" ")) {
      const m = /^(\S+) -> (\S+):$/.exec(line);
      if (!m) continue;
      const named = m[1]!.replace(/\./g, "/");
      owner = m[2]!.replace(/\./g, "/");
      into.classes.set(owner, ["obf", named].map((_, i) => (i === 0 ? owner! : named)));
      namedToObf.set(named, owner);
      continue;
    }
    if (!owner) continue;
    const t = line.trim();
    const mm = /^(?:\d+:\d+:)?(\S+) ([^\s(]+)\(([^)]*)\)(?::\d+(?::\d+)?)? -> (\S+)$/.exec(t);
    if (mm) {
      const desc = `(${mm[3] ? mm[3].split(",").map(javaToDesc).join("") : ""})${javaToDesc(mm[1]!)}`;
      pending.push({ owner, obf: mm[4]!, named: mm[2]!, namedDesc: desc, isMethod: true });
      continue;
    }
    const fm = /^(\S+) (\S+) -> (\S+)$/.exec(t);
    if (fm) pending.push({ owner, obf: fm[3]!, named: fm[2]!, namedDesc: javaToDesc(fm[1]!), isMethod: false });
  }
  const toObf = (c: string) => namedToObf.get(c);
  for (const p of pending) {
    const obfDesc = mapDesc(p.namedDesc, toObf);
    (p.isMethod ? into.methods : into.fields).set(key(p.owner, p.obf, obfDesc), [p.obf, p.named]);
  }
  return into;
}

/**
 * Parse tiny v2. `rename` maps the file's namespace names to FFN's (e.g. official→obf, named→yarn).
 * Only class/field/method lines are read (params/comments ignored).
 */
export function parseTinyV2(text: string, rename: Record<string, string> = {}): MappingSet {
  const lines = text.split("\n");
  const header = lines[0]!.split("\t");
  if (header[0] !== "tiny" || header[1] !== "2") throw new Error("Not a tiny v2 file");
  const ns = header.slice(3).map((n) => rename[n] ?? n);
  if (ns[0] !== "obf") throw new Error(`First tiny namespace must map to obf (got ${header[3]})`);
  const set = emptySet(ns);
  let owner: string | undefined;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]!.replace(/\r$/, "");
    if (!line) continue;
    const cols = line.split("\t");
    if (cols[0] === "c") {
      owner = cols[1]!;
      set.classes.set(owner, fill(cols.slice(1), ns.length));
    } else if (cols[0] === "" && (cols[1] === "f" || cols[1] === "m") && owner) {
      const names = fill(cols.slice(3), ns.length);
      (cols[1] === "f" ? set.fields : set.methods).set(key(owner, names[0]!, cols[2]!), names);
    }
  }
  return set;
}

function fill(names: string[], n: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < n; i++) out.push(names[i] || out[i - 1] || names[0]!);
  return out;
}

/** Parse MCPConfig tsrg2 (`tsrg2 obf srg id`). Fields carry no descriptor (stored with desc ""). */
export function parseTsrg2(text: string): MappingSet {
  const lines = text.split("\n");
  if (!lines[0]!.startsWith("tsrg2")) throw new Error("Not a tsrg2 file");
  const header = lines[0]!.trim().split(" ").slice(1);
  const set = emptySet(["obf", ...header.slice(1).map((h) => (h === "srg" ? "srg" : h))]);
  let owner: string | undefined;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]!.replace(/\r$/, "");
    if (!line.trim()) continue;
    if (line.startsWith("\t\t")) continue; // params / static marker
    if (!line.startsWith("\t")) {
      const cols = line.split(" ");
      owner = cols[0]!;
      set.classes.set(owner, cols.slice(0, set.namespaces.length));
      continue;
    }
    if (!owner) continue;
    const cols = line.slice(1).split(" ");
    if (cols[1]?.startsWith("(")) set.methods.set(key(owner, cols[0]!, cols[1]!), [cols[0]!, ...cols.slice(2, 1 + set.namespaces.length)]);
    else set.fields.set(key(owner, cols[0]!, ""), cols.slice(0, set.namespaces.length));
  }
  return set;
}

/** Write tiny v2 with namespaces obf → target (used to drive tiny-remapper with Mojang mappings). */
export function writeTinyV2(set: MappingSet, target: number, fromName = "official", toName = "named"): string {
  const out: string[] = [`tiny\t2\t0\t${fromName}\t${toName}`];
  const byOwner = new Map<string, string[]>();
  const addMember = (kind: "f" | "m", map: Map<string, string[]>) => {
    for (const [k, names] of map) {
      const [owner, name, desc] = k.split("\t");
      if (!desc) continue; // tiny requires descriptors
      const l = byOwner.get(owner!) ?? [];
      l.push(`\t${kind}\t${desc}\t${name}\t${names[target]}`);
      byOwner.set(owner!, l);
    }
  };
  addMember("f", set.fields);
  addMember("m", set.methods);
  for (const [obf, names] of set.classes) {
    out.push(`c\t${obf}\t${names[target]}`);
    for (const m of byOwner.get(obf) ?? []) out.push(m);
  }
  return out.join("\n") + "\n";
}

/** A joined view across several mapping sets for translate_mapping. */
export interface Translation {
  kind: "class" | "field" | "method";
  /** Names per namespace; members are given as `Owner#name` plus a descriptor in `desc[ns]`. */
  names: Record<string, string>;
  owner?: Record<string, string>;
  desc?: Record<string, string>;
}

export class MappingTable {
  readonly namespaces: string[];
  private classByNs = new Map<string, Map<string, string>>(); // ns → (name → obf)

  constructor(private readonly sets: MappingSet[]) {
    this.namespaces = ["obf", ...new Set(sets.flatMap((s) => s.namespaces.slice(1)))];
  }

  private classNames(obf: string): Record<string, string> {
    const r: Record<string, string> = { obf };
    for (const s of this.sets) {
      const n = s.classes.get(obf);
      if (n) s.namespaces.forEach((ns, i) => (r[ns] = n[i]!));
    }
    return r;
  }

  private obfClass(ns: string, name: string): string | undefined {
    if (ns === "obf") return name;
    let idx = this.classByNs.get(ns);
    if (!idx) {
      idx = new Map();
      for (const s of this.sets) {
        const i = s.namespaces.indexOf(ns);
        if (i > 0) for (const [obf, n] of s.classes) idx.set(n[i]!, obf);
      }
      this.classByNs.set(ns, idx);
    }
    return idx.get(name);
  }

  private descIn(ns: string, obfDesc: string): string {
    return mapDesc(obfDesc, (c) => this.classNames(c)[ns]);
  }

  /**
   * Find entries whose name in namespace `from` matches. Accepts `pkg/Cls`, `pkg.Cls`, simple class names,
   * `Owner#member`, `Owner.member`, or a bare member name (e.g. m_1234_, method_5678, field_1234).
   */
  find(query: string, from: string, kind?: "class" | "field" | "method", limit = 25): Translation[] {
    const out: Translation[] = [];
    let q = query.trim();
    let ownerQ: string | undefined;
    let descQ: string | undefined;
    const paren = q.indexOf("(");
    if (paren > 0) {
      descQ = q.slice(paren);
      q = q.slice(0, paren);
    }
    const hash = q.lastIndexOf("#");
    if (hash > 0) {
      ownerQ = q.slice(0, hash).replace(/\./g, "/");
      q = q.slice(hash + 1);
    }
    const qSlash = q.replace(/\./g, "/");
    const classMatch = (name: string, query: string) =>
      name === query || name.endsWith(`/${query}`) || name.replace(/\$/g, "/").endsWith(`/${query.replace(/\$/g, "/")}`);

    if (!kind || kind === "class") {
      if (!ownerQ) {
        for (const s of this.sets) {
          const i = s.namespaces.indexOf(from);
          if (i < 0) continue;
          for (const [obf, n] of s.classes) {
            if (classMatch(n[i]!, qSlash) && !out.some((o) => o.names.obf === obf)) out.push({ kind: "class", names: this.classNames(obf) });
            if (out.length >= limit) return out;
          }
        }
      }
    }
    if (kind === "class") return out;
    // owner filter in obf space
    const ownerObfs = ownerQ ? this.ownerCandidates(ownerQ, from) : undefined;
    for (const [k, map] of [["field", "fields"], ["method", "methods"]] as const) {
      if (kind && kind !== k) continue;
      const seen = new Set<string>();
      for (const s of this.sets) {
        const i = s.namespaces.indexOf(from);
        if (i < 0) continue;
        for (const [mk, n] of s[map]) {
          if (n[i] !== q) continue;
          const [owner, obfName, obfDesc] = mk.split("\t") as [string, string, string];
          if (ownerObfs && !ownerObfs.has(owner)) continue;
          if (descQ && obfDesc && this.descIn(from, obfDesc) !== descQ) continue;
          const id = `${owner}\t${obfName}\t${obfDesc}`;
          if (seen.has(id)) continue;
          seen.add(id);
          out.push(this.member(k, owner, obfName, obfDesc));
          if (out.length >= limit) return out;
        }
      }
    }
    return out;
  }

  private ownerCandidates(ownerQ: string, from: string): Set<string> {
    const res = new Set<string>();
    const direct = this.obfClass(from, ownerQ);
    if (direct) res.add(direct);
    else {
      for (const s of this.sets) {
        const i = s.namespaces.indexOf(from);
        if (i < 0) continue;
        for (const [obf, n] of s.classes) if (n[i] === ownerQ || n[i]!.endsWith(`/${ownerQ}`) || n[i]!.endsWith(`$${ownerQ}`)) res.add(obf);
      }
    }
    return res;
  }

  private member(kind: "field" | "method", owner: string, obfName: string, obfDesc: string): Translation {
    const names: Record<string, string> = { obf: obfName };
    const desc: Record<string, string> = {};
    for (const s of this.sets) {
      const map = kind === "field" ? s.fields : s.methods;
      let n = map.get(key(owner, obfName, obfDesc));
      if (!n && kind === "field") n = map.get(key(owner, obfName, "")) ?? [...map.entries()].find(([k]) => k.startsWith(`${owner}\t${obfName}\t`))?.[1];
      if (!n && kind === "field" && !obfDesc) n = undefined;
      if (n) s.namespaces.forEach((ns, i) => (names[ns] = n![i]!));
    }
    const ownerNames = this.classNames(owner);
    if (obfDesc) for (const ns of this.namespaces) desc[ns] = this.descIn(ns, obfDesc);
    return { kind, names, owner: ownerNames, desc: obfDesc ? desc : undefined };
  }
}
