import AdmZip from "adm-zip";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runProcess } from "../exec/run.js";
import { ACC, ClassReader, type ClassInfo } from "./classfile.js";

export interface IndexMeta {
  formatVersion: 1;
  kind: "vanilla" | "toolchain";
  mcVersion: string;
  /** Names used in the index: mojmap | yarn | intermediary | obf | project (toolchain: whatever the project compiles against). */
  namespace: string;
  loader?: string;
  jar: string;
  sourcesJar?: string;
  obfuscated: boolean;
  builtAt: string;
  classCount: number;
  notes: string[];
}

/** Compact on-disk class record. */
export interface IndexedClass {
  n: string; // internal name
  a: number; // access
  s?: string; // super
  i: string[]; // interfaces
  f: [string, string, number][]; // name, desc, access
  m: [string, string, number][];
}

export function toIndexed(c: ClassInfo): IndexedClass {
  return {
    n: c.name,
    a: c.access,
    ...(c.superName ? { s: c.superName } : {}),
    i: c.interfaces,
    f: c.fields.map((f) => [f.name, f.desc, f.access]),
    m: c.methods.map((m) => [m.name, m.desc, m.access]),
  };
}

/** Parse every class in a jar into the compact index (skips module-info/package-info/META-INF). */
export function indexJar(jarPath: string, filter: (name: string) => boolean = () => true): IndexedClass[] {
  const zip = new AdmZip(jarPath);
  const out: IndexedClass[] = [];
  for (const e of zip.getEntries()) {
    const n = e.entryName;
    if (!n.endsWith(".class") || n.startsWith("META-INF/") || n.endsWith("module-info.class") || n.endsWith("package-info.class")) continue;
    if (!filter(n)) continue;
    try {
      out.push(toIndexed(new ClassReader(e.getData()).info));
    } catch {
      /* skip unreadable */
    }
  }
  return out;
}

export interface SearchHit {
  kind: "class" | "method" | "field";
  owner: string;
  name: string;
  desc?: string;
  access: number;
}

export class McIndex {
  readonly classes = new Map<string, IndexedClass>();
  private simple = new Map<string, string[]>();
  private zip?: AdmZip;
  private sourcesZip?: AdmZip | null;

  constructor(readonly dir: string, readonly meta: IndexMeta, list: IndexedClass[]) {
    for (const c of list) {
      this.classes.set(c.n, c);
      const s = c.n.slice(c.n.lastIndexOf("/") + 1);
      for (const key of new Set([s, s.slice(s.lastIndexOf("$") + 1)])) {
        const l = this.simple.get(key) ?? [];
        l.push(c.n);
        this.simple.set(key, l);
      }
    }
  }

  static async load(dir: string): Promise<McIndex | undefined> {
    const f = path.join(dir, "index.json");
    if (!existsSync(f)) return undefined;
    const j = JSON.parse(await readFile(f, "utf8")) as { meta: IndexMeta; classes: IndexedClass[] };
    if (j.meta.formatVersion !== 1 || !existsSync(j.meta.jar)) return undefined;
    return new McIndex(dir, j.meta, j.classes);
  }

  static async save(dir: string, meta: IndexMeta, classes: IndexedClass[]): Promise<McIndex> {
    await mkdir(dir, { recursive: true });
    const tmp = path.join(dir, `index.json.${process.pid}.tmp`);
    await writeFile(tmp, JSON.stringify({ meta, classes }));
    const { rename } = await import("node:fs/promises");
    await rename(tmp, path.join(dir, "index.json"));
    return new McIndex(dir, meta, classes);
  }

  /** Resolve a user-supplied class name (dots/slashes, `$` or `.` for inner classes, or a simple name). */
  resolve(q: string): string[] {
    const s = q.trim().replace(/\.class$/, "").replace(/^L(.+);$/, "$1");
    const slash = s.replace(/\./g, "/");
    if (this.classes.has(slash)) return [slash];
    // inner classes written with dots: net.minecraft.world.level.block.state.BlockBehaviour.Properties
    const parts = slash.split("/");
    for (let k = parts.length - 1; k > 0; k--) {
      const cand = parts.slice(0, k).join("/") + "/" + parts.slice(k).join("$");
      if (this.classes.has(cand)) return [cand];
    }
    const simple = slash.includes("/") ? undefined : this.simple.get(slash.replace(/.*\$/, ""));
    if (simple) return simple.filter((n) => !slash.includes("$") || n.endsWith(slash));
    return [];
  }

  get(name: string): IndexedClass | undefined {
    return this.classes.get(name);
  }

  /** Class plus all supertypes present in the index (BFS order, starting with the class). */
  hierarchy(name: string): IndexedClass[] {
    const out: IndexedClass[] = [];
    const seen = new Set<string>();
    const queue = [name];
    while (queue.length) {
      const n = queue.shift()!;
      if (seen.has(n)) continue;
      seen.add(n);
      const c = this.classes.get(n);
      if (!c) continue;
      out.push(c);
      if (c.s) queue.push(c.s);
      queue.push(...c.i);
    }
    return out;
  }

  search(query: string, kind: "class" | "method" | "field" | "any" = "any", limit = 50): SearchHit[] {
    const isRe = query.length > 2 && query.startsWith("/") && query.endsWith("/");
    const re = isRe ? new RegExp(query.slice(1, -1), "i") : undefined;
    const q = query.toLowerCase().replace(/\./g, "/");
    const score = (name: string): number => {
      if (re) return re.test(name) ? 1 : 0;
      const l = name.toLowerCase();
      if (l === q) return 4;
      if (l.endsWith("/" + q) || l.endsWith("$" + q)) return 3;
      if (l.startsWith(q)) return 2;
      return l.includes(q) ? 1 : 0;
    };
    const hits: (SearchHit & { score: number })[] = [];
    for (const c of this.classes.values()) {
      if (kind === "any" || kind === "class") {
        const s = score(c.n);
        if (s) hits.push({ kind: "class", owner: c.n, name: c.n, access: c.a, score: s + 0.5 });
      }
      if (kind === "any" || kind === "method") {
        for (const [n, d, a] of c.m) {
          if (a & ACC.SYNTHETIC && n.startsWith("lambda$")) continue;
          const s = score(n);
          if (s) hits.push({ kind: "method", owner: c.n, name: n, desc: d, access: a, score: s });
        }
      }
      if (kind === "any" || kind === "field") {
        for (const [n, d, a] of c.f) {
          const s = score(n);
          if (s) hits.push({ kind: "field", owner: c.n, name: n, desc: d, access: a, score: s });
        }
      }
    }
    hits.sort((x, y) => y.score - x.score || x.owner.length - y.owner.length || x.owner.localeCompare(y.owner));
    return hits.slice(0, limit).map(({ score: _s, ...h }) => h);
  }

  bytes(name: string): Buffer | undefined {
    this.zip ??= new AdmZip(this.meta.jar);
    return this.zip.getEntry(`${name}.class`)?.getData();
  }

  reader(name: string): ClassReader | undefined {
    const b = this.bytes(name);
    return b ? new ClassReader(b) : undefined;
  }

  hasSourcesJar(): boolean {
    return !!this.meta.sourcesJar && existsSync(this.meta.sourcesJar);
  }

  /** Source of a top-level class: from the sources jar, else the decompile cache, else Vineflower. */
  async source(name: string, decompile: (outer: string) => Promise<string | undefined>): Promise<{ text: string; origin: string } | undefined> {
    const outer = name.split("$")[0]!;
    if (this.hasSourcesJar()) {
      if (this.sourcesZip === undefined) this.sourcesZip = new AdmZip(this.meta.sourcesJar!);
      const e = this.sourcesZip?.getEntry(`${outer}.java`);
      if (e) return { text: e.getData().toString("utf8"), origin: `sources jar ${path.basename(this.meta.sourcesJar!)}` };
    }
    const cached = path.join(this.dir, "src", `${outer}.java`);
    if (existsSync(cached)) return { text: await readFile(cached, "utf8"), origin: "Vineflower (cached)" };
    const text = await decompile(outer);
    if (text === undefined) return undefined;
    await mkdir(path.dirname(cached), { recursive: true });
    await writeFile(cached, text);
    return { text, origin: "Vineflower" };
  }

  /** Grep the sources jar (only available when one exists). */
  grepSources(re: RegExp, limit: number): { file: string; line: number; text: string }[] | undefined {
    if (!this.hasSourcesJar()) return undefined;
    if (this.sourcesZip === undefined) this.sourcesZip = new AdmZip(this.meta.sourcesJar!);
    const out: { file: string; line: number; text: string }[] = [];
    for (const e of this.sourcesZip!.getEntries()) {
      if (!e.entryName.endsWith(".java")) continue;
      const lines = e.getData().toString("utf8").split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (re.test(lines[i]!)) {
          out.push({ file: e.entryName, line: i + 1, text: lines[i]!.trim().slice(0, 240) });
          if (out.length >= limit) return out;
        }
      }
    }
    return out;
  }
}

/** Decompile one top-level class (with its inner classes) using Vineflower. */
export async function vineflowerDecompile(java: string, vfJar: string, index: McIndex, outer: string): Promise<string | undefined> {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "ffn-vf-"));
  try {
    const inDir = path.join(tmp, "in");
    const outDir = path.join(tmp, "out");
    let wrote = 0;
    for (const n of index.classes.keys()) {
      if (n !== outer && !n.startsWith(`${outer}$`)) continue;
      const b = index.bytes(n);
      if (!b) continue;
      await mkdir(path.dirname(path.join(inDir, n)), { recursive: true });
      await writeFile(path.join(inDir, `${n}.class`), b);
      wrote++;
    }
    if (!wrote) return undefined;
    await mkdir(outDir, { recursive: true });
    const r = await runProcess({
      command: java,
      args: ["-Xmx1G", "-jar", vfJar, "-s", `-e=${index.meta.jar}`, inDir, outDir],
      cwd: tmp,
      timeoutMs: 180_000,
      logFile: path.join(tmp, "vf.log"),
    });
    const f = path.join(outDir, `${outer}.java`);
    if (!existsSync(f)) throw new Error(`Vineflower produced no output (exit ${r.exitCode}): ${r.tail.slice(-5).join(" | ")}`);
    return await readFile(f, "utf8");
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}
