/**
 * Symbol lookup over a project's real compile classpath (game jar, loader jars, APIs).
 * Used to pick template variants (probes) and to verify generated code references things that exist.
 */
import { existsSync, readFileSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { ClassReader } from "../index/classfile.js";
import { ZipDir } from "./zip.js";

const JDK_PREFIXES = ["java/", "javax/", "jdk/", "sun/"];

export interface SymbolCheck {
  spec: string;
  ok: boolean;
  reason?: string;
}

export class ClasspathSymbols {
  private classToJar = new Map<string, number>();
  private zips = new Map<number, ZipDir>();
  private readers = new Map<string, ClassReader | null>();
  private checks = new Map<string, SymbolCheck>();

  private constructor(readonly jars: string[]) {}

  /** Build (or load from cache) the class → jar map for these classpath entries. */
  static load(files: string[], cacheFile?: string): ClasspathSymbols {
    const jars = files.filter((f) => f.endsWith(".jar") && existsSync(f));
    const s = new ClasspathSymbols(jars);
    const stamp = jars.map((j) => `${j}:${statSync(j).size}`).join(";");
    if (cacheFile && existsSync(cacheFile)) {
      try {
        const c = JSON.parse(readFileSync(cacheFile, "utf8")) as { stamp: string; classes: Record<string, number> };
        if (c.stamp === stamp) {
          for (const [k, v] of Object.entries(c.classes)) s.classToJar.set(k, v);
          return s;
        }
      } catch {
        /* rebuild */
      }
    }
    jars.forEach((j, i) => {
      let z: ZipDir;
      try {
        z = new ZipDir(j);
      } catch {
        return;
      }
      for (const name of z.entries.keys()) {
        if (!name.endsWith(".class") || name.startsWith("META-INF/")) continue;
        const cls = name.slice(0, -6);
        if (!s.classToJar.has(cls)) s.classToJar.set(cls, i);
      }
    });
    if (cacheFile) {
      mkdirSync(path.dirname(cacheFile), { recursive: true });
      writeFileSync(cacheFile, JSON.stringify({ stamp, classes: Object.fromEntries(s.classToJar) }));
    }
    return s;
  }

  static internal(name: string): string {
    return name.replace(/\./g, "/");
  }

  get classCount(): number {
    return this.classToJar.size;
  }

  jarOf(cls: string): string | undefined {
    const i = this.classToJar.get(ClasspathSymbols.internal(cls));
    return i === undefined ? undefined : this.jars[i];
  }

  hasClass(cls: string): boolean {
    const n = ClasspathSymbols.internal(cls);
    if (this.classToJar.has(n)) return true;
    return JDK_PREFIXES.some((p) => n.startsWith(p));
  }

  reader(cls: string): ClassReader | undefined {
    const n = ClasspathSymbols.internal(cls);
    if (this.readers.has(n)) return this.readers.get(n) ?? undefined;
    let r: ClassReader | null = null;
    const i = this.classToJar.get(n);
    if (i !== undefined) {
      let z = this.zips.get(i);
      if (!z) {
        z = new ZipDir(this.jars[i]!);
        this.zips.set(i, z);
      }
      const buf = z.read(`${n}.class`);
      if (buf) r = new ClassReader(buf);
    }
    this.readers.set(n, r);
    return r ?? undefined;
  }

  /** Does owner (or a supertype on the classpath) declare a method/field with this name (and descriptor prefix)? */
  hasMember(owner: string, name: string, descPrefix?: string, kind: "method" | "field" | "any" = "any"): boolean {
    const seen = new Set<string>();
    const queue = [ClasspathSymbols.internal(owner)];
    while (queue.length) {
      const n = queue.shift()!;
      if (seen.has(n)) continue;
      seen.add(n);
      const r = this.reader(n);
      if (!r) continue;
      const info = r.info;
      const pools = kind === "method" ? [info.methods] : kind === "field" ? [info.fields] : [info.methods, info.fields];
      for (const list of pools) {
        for (const m of list) if (m.name === name && (!descPrefix || m.desc.startsWith(descPrefix))) return true;
      }
      if (info.superName) queue.push(info.superName);
      queue.push(...info.interfaces);
    }
    return false;
  }

  /**
   * Check a symbol spec:
   *   a.b.C                class exists
   *   a.b.C#name           method or field named `name` (inherited members count)
   *   a.b.C#name(Lx/Y;     method whose descriptor starts with the given prefix
   *   a.b.C#<init>(I)V     constructor
   *   !spec                negation
   */
  check(spec: string): SymbolCheck {
    const hit = this.checks.get(spec);
    if (hit) return hit;
    let res: SymbolCheck;
    if (spec.startsWith("!")) {
      const inner = this.check(spec.slice(1));
      res = { spec, ok: !inner.ok, ...(inner.ok ? { reason: `${spec.slice(1)} exists` } : {}) };
    } else {
      const [owner, member] = spec.split("#", 2) as [string, string | undefined];
      if (!this.hasClass(owner)) res = { spec, ok: false, reason: `class ${owner} not found on the classpath` };
      else if (!member) res = { spec, ok: true };
      else if (JDK_PREFIXES.some((p) => ClasspathSymbols.internal(owner).startsWith(p))) res = { spec, ok: true };
      else {
        const paren = member.indexOf("(");
        const colon = member.indexOf(":");
        const name = paren >= 0 ? member.slice(0, paren) : colon >= 0 ? member.slice(0, colon) : member;
        const desc = paren >= 0 ? member.slice(paren) : colon >= 0 ? member.slice(colon + 1) : undefined;
        const kind = paren >= 0 ? "method" : colon >= 0 ? "field" : "any";
        const ok = this.hasMember(owner, name, desc ? ClasspathSymbols.internal(desc) : undefined, kind);
        res = ok ? { spec, ok } : { spec, ok, reason: `${owner} has no ${kind === "any" ? "member" : kind} ${name}${desc ?? ""}` };
      }
    }
    this.checks.set(spec, res);
    return res;
  }
}
