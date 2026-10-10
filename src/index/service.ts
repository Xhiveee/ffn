/**
 * Source index per (Minecraft version, names). Two strategies:
 *  - vanilla: Mojang client + server jars merged, remapped with tiny-remapper to Mojang (ProGuard),
 *    Yarn or Intermediary names (or used as-is when the version is unobfuscated), then indexed.
 *  - project (toolchain): the Minecraft jar the project actually compiles against (Loom / ModDevGradle /
 *    ForgeGradle output, incl. loader patches, in the project's names), with its -sources.jar if present.
 */
import AdmZip from "adm-zip";
import { createHash } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { runProcess } from "../exec/run.js";
import { readProjectInfo, type ProjectInfo } from "../project/info.js";
import type { Services } from "../services.js";
import { ENDPOINTS } from "../sources/endpoints.js";
import { Notes } from "../sources/index.js";
import { downloadFile } from "../util/download.js";
import { emptySet, MappingTable, parseProguard, parseTinyV2, parseTsrg2, writeTinyV2, type MappingSet } from "./mappings.js";
import { indexJar, McIndex, vineflowerDecompile, vineflowerDecompileMany, type IndexMeta } from "./store.js";
import { toolJar, toolJava } from "./tooljars.js";

export const INDEX_NAMESPACES = ["mojmap", "parchment", "yarn", "intermediary", "obf"] as const;
export type IndexNamespace = (typeof INDEX_NAMESPACES)[number];

export interface IndexSpec {
  mcVersion?: string;
  mappings?: IndexNamespace;
  loader?: string;
  projectDir?: string;
  /** auto: project jar when projectDir is given (falls back to vanilla), else vanilla. loader: patched jar from a cached official MDK. */
  source?: "auto" | "vanilla" | "project" | "loader";
}

export interface OpenedIndex {
  index: McIndex;
  notes: string[];
  project?: ProjectInfo;
}

const CLASSPATH_INIT = `// Written by FFN: prints the compile classpath so FFN can locate the Minecraft jar.
// clientCompileClasspath exists when Loom splits client and common source sets (the Fabric example mod):
// the client-only Minecraft classes are only on that classpath.
gradle.allprojects { p ->
    p.tasks.register("ffnPrintClasspath") {
        def cfgs = ["compileClasspath", "clientCompileClasspath"].collect { p.configurations.findByName(it) }.findAll { it != null }
        def files = p.provider { cfgs.collectMany { it.files }.unique() }
        def projectPath = p.path
        // Build task-produced classpath entries first (e.g. ModDevGradle's patched Minecraft jar).
        cfgs.each { dependsOn(it) }
        doLast {
            files.get().each { println "FFN-CP:" + projectPath + "|" + it.absolutePath }
        }
    }
}
`;

const MC_MARKER = "net/minecraft/server/MinecraftServer.class";
const CLIENT_MARKER = "net/minecraft/client/Minecraft.class";

export class IndexService {
  private loaded = new Map<string, McIndex>();
  private building = new Map<string, Promise<McIndex>>();
  private tables = new Map<string, Promise<{ table: MappingTable; notes: string[] }>>();

  constructor(private readonly services: Services) {}

  private get root(): string {
    return path.join(this.services.config.cacheDir, "index");
  }

  private remember(key: string, idx: McIndex): McIndex {
    this.loaded.delete(key);
    this.loaded.set(key, idx);
    while (this.loaded.size > 2) this.loaded.delete(this.loaded.keys().next().value!);
    return idx;
  }

  private async once(key: string, build: () => Promise<McIndex>): Promise<McIndex> {
    const hit = this.loaded.get(key);
    if (hit) return this.remember(key, hit);
    let p = this.building.get(key);
    if (!p) {
      p = build().finally(() => this.building.delete(key));
      this.building.set(key, p);
    }
    return this.remember(key, await p);
  }

  async open(spec: IndexSpec, onProgress?: (msg: string) => void): Promise<OpenedIndex> {
    const notes: string[] = [];
    let project: ProjectInfo | undefined;
    if (spec.projectDir) project = await readProjectInfo(spec.projectDir);
    const mc = spec.mcVersion ?? project?.mcVersion;
    if (!mc) throw new Error("Give mcVersion or projectDir.");
    if (project && spec.mcVersion && spec.mcVersion !== project.mcVersion) notes.push(`mcVersion ${spec.mcVersion} differs from the project's ${project.mcVersion}; using ${spec.mcVersion}.`);
    let ns: IndexNamespace = spec.mappings ?? project?.mappings ?? "mojmap";
    const source = spec.source ?? "auto";
    if (source === "loader" && !project) {
      const loader = spec.loader;
      if (loader !== "forge" && loader !== "neoforge") throw new Error('source="loader" needs loader "forge" or "neoforge" (Fabric adds no patches: use vanilla).');
      const { loaderWorkspace } = await import("./loaderws.js");
      const ws = await loaderWorkspace(this.services, loader, mc, onProgress);
      const wsProject = await readProjectInfo(ws.dir);
      const index = await this.openProject(wsProject, onProgress);
      if (wsProject.mcVersion !== mc) throw new Error(`The official ${loader} MDK for ${mc} targets ${wsProject.mcVersion}; use projectDir with a ${mc} project.`);
      notes.push(`Index of the ${loader}-patched Minecraft ${wsProject.mcVersion} jar from the official MDK (${ws.origin}), cached; mojmap names.`);
      return { index, notes };
    }
    if (project && source !== "vanilla" && (!spec.mcVersion || spec.mcVersion === project.mcVersion)) {
      try {
        const index = await this.openProject(project, onProgress);
        notes.push(`Index of the Minecraft jar this ${project.loader} project compiles against (includes loader patches; names as in the project).`);
        return { index, notes, project };
      } catch (e) {
        if (source === "project") throw e;
        notes.push(`Project jar unavailable (${(e as Error).message.split("\n")[0]}); using vanilla Minecraft classes instead — loader-added methods are not included.`);
      }
    }
    const details = await this.services.versions.mojangVersion(mc);
    if (!details) throw new Error(`Minecraft ${mc} is not in Mojang's version manifest.`);
    if (ns === "parchment") {
      ns = "mojmap";
      notes.push("Parchment only adds parameter names and javadoc on top of Mojang names; class/method/field names are Mojang's.");
    }
    if (!details.obfuscated && ns !== "mojmap") {
      if (ns === "obf") ns = "mojmap";
      else throw new Error(`Minecraft ${mc} ships unobfuscated (Mojang names). ${ns} mappings do not exist for it; use mojmap.`);
    }
    if (!details.obfuscated) notes.push(`Minecraft ${mc} is unobfuscated: the official jar already uses Mojang names (no remapping).`);
    const key = `vanilla:${mc}:${ns}`;
    const index = await this.once(key, async () => (await McIndex.load(path.join(this.root, mc, ns))) ?? this.buildVanilla(mc, ns, onProgress));
    return { index, notes: [...notes, ...index.meta.notes], project };
  }

  // ---------------- vanilla ----------------

  private async mergedOfficialJar(mc: string, onProgress?: (m: string) => void): Promise<{ jar: string; obfuscated: boolean }> {
    const details = (await this.services.versions.mojangVersion(mc))!;
    const dir = path.join(this.root, mc);
    const merged = path.join(dir, "merged-official.jar");
    if (existsSync(merged)) return { jar: merged, obfuscated: details.obfuscated };
    const ua = this.services.config.userAgent;
    const off = this.services.config.offline;
    const c = details.downloads.client;
    const s = details.downloads.server;
    if (!c) throw new Error(`No client download listed for ${mc}.`);
    onProgress?.(`Downloading Minecraft ${mc} client jar…`);
    const clientJar = await downloadFile(c.url, path.join(dir, "client.jar"), { userAgent: ua, sha1: c.sha1, offline: off });
    const out = new AdmZip();
    const names = new Set<string>();
    for (const e of new AdmZip(clientJar).getEntries()) {
      if (!e.entryName.endsWith(".class")) continue;
      out.addFile(e.entryName, e.getData());
      names.add(e.entryName);
    }
    if (s) {
      onProgress?.(`Downloading Minecraft ${mc} server jar…`);
      const serverJar = await downloadFile(s.url, path.join(dir, "server.jar"), { userAgent: ua, sha1: s.sha1, offline: off });
      let zip = new AdmZip(serverJar);
      const nested = zip.getEntries().find((e) => /^META-INF\/versions\/[^/]+\/server-[^/]+\.jar$/.test(e.entryName));
      if (nested) zip = new AdmZip(nested.getData()); // bundler format (1.18+)
      for (const e of zip.getEntries()) {
        if (!e.entryName.endsWith(".class") || names.has(e.entryName)) continue;
        if (!nested && !e.entryName.startsWith("net/minecraft/") && e.entryName.includes("/")) continue; // old fat server jars
        out.addFile(e.entryName, e.getData());
      }
    }
    await mkdir(dir, { recursive: true });
    out.writeZip(`${merged}.tmp`);
    const { rename } = await import("node:fs/promises");
    await rename(`${merged}.tmp`, merged);
    return { jar: merged, obfuscated: details.obfuscated };
  }

  /** Mojang ProGuard mappings (client + server merged). */
  async mojmapSet(mc: string): Promise<MappingSet | undefined> {
    const details = await this.services.versions.mojangVersion(mc);
    if (!details?.obfuscated) return undefined;
    const set = emptySet(["obf", "mojmap"]);
    for (const k of ["client_mappings", "server_mappings"] as const) {
      const d = details.downloads[k];
      if (!d) continue;
      const f = await downloadFile(d.url, path.join(this.root, mc, `${k}.txt`), { userAgent: this.services.config.userAgent, sha1: d.sha1, offline: this.services.config.offline });
      parseProguard(await readFile(f, "utf8"), set);
    }
    return set;
  }

  private async tinyFromJar(url: string, dest: string): Promise<string> {
    const jar = await downloadFile(url, dest, { userAgent: this.services.config.userAgent, offline: this.services.config.offline });
    const e = new AdmZip(jar).getEntry("mappings/mappings.tiny");
    if (!e) throw new Error(`${path.basename(jar)} has no mappings/mappings.tiny`);
    return e.getData().toString("utf8");
  }

  async yarnVersion(mc: string): Promise<string | undefined> {
    try {
      return (await this.services.versions.fabric(mc, new Notes())).yarn;
    } catch {
      return undefined;
    }
  }

  async intermediarySet(mc: string): Promise<MappingSet | undefined> {
    try {
      return parseTinyV2(await this.tinyFromJar(ENDPOINTS.intermediaryJar(mc), path.join(this.root, mc, "intermediary-v2.jar")), { official: "obf" });
    } catch (e) {
      if (/HTTP 404/.test((e as Error).message)) return undefined;
      throw e;
    }
  }

  async yarnSet(mc: string): Promise<{ set: MappingSet; version: string } | undefined> {
    const v = await this.yarnVersion(mc);
    if (!v) return undefined;
    const text = await this.tinyFromJar(ENDPOINTS.yarnJar(v), path.join(this.root, mc, `yarn-${v}-mergedv2.jar`));
    return { set: parseTinyV2(text, { official: "obf", named: "yarn" }), version: v };
  }

  async srgSet(mc: string): Promise<{ set: MappingSet; version: string } | undefined> {
    const v = await this.services.versions.mcpConfig(mc);
    if (!v) return undefined;
    const zipPath = await downloadFile(ENDPOINTS.mcpConfigZip(v), path.join(this.root, mc, `mcp_config-${v}.zip`), { userAgent: this.services.config.userAgent, offline: this.services.config.offline });
    const e = new AdmZip(zipPath).getEntry("config/joined.tsrg");
    if (!e) return undefined;
    const text = e.getData().toString("utf8");
    if (!text.startsWith("tsrg2")) return undefined;
    const set = parseTsrg2(text);
    set.namespaces = set.namespaces.slice(0, 2); // obf, srg (drop numeric ids)
    // MCPConfig for Mojang-named versions maps obf → obf/mojmap names; only real SRG (C_/f_/m_) is useful.
    const sample = [...set.methods.values()].slice(0, 50);
    if (!sample.some((n) => /^m_\d+_$/.test(n[1] ?? ""))) return undefined;
    return { set, version: v };
  }

  private async buildVanilla(mc: string, ns: IndexNamespace, onProgress?: (m: string) => void): Promise<McIndex> {
    const notes: string[] = [];
    const { jar: merged, obfuscated } = await this.mergedOfficialJar(mc, onProgress);
    const dir = path.join(this.root, mc, ns);
    await mkdir(dir, { recursive: true });
    let named = merged;
    if (obfuscated && ns !== "obf") {
      let tinyText: string;
      let to = "named";
      if (ns === "mojmap") {
        const set = await this.mojmapSet(mc);
        if (!set) throw new Error(`No Mojang mappings for ${mc}.`);
        tinyText = writeTinyV2(set, 1);
      } else if (ns === "yarn") {
        const v = await this.yarnVersion(mc);
        if (!v) throw new Error(`No Yarn build is published for ${mc}.`);
        tinyText = await this.tinyFromJar(ENDPOINTS.yarnJar(v), path.join(this.root, mc, `yarn-${v}-mergedv2.jar`));
        notes.push(`Yarn ${v}.`);
      } else {
        tinyText = await this.tinyFromJar(ENDPOINTS.intermediaryJar(mc), path.join(this.root, mc, "intermediary-v2.jar"));
        to = "intermediary";
      }
      const tiny = path.join(dir, "mappings.tiny");
      await writeFile(tiny, tinyText);
      named = path.join(dir, "named.jar");
      onProgress?.(`Remapping Minecraft ${mc} to ${ns} names with tiny-remapper…`);
      const java = await toolJava();
      const tr = await toolJar(this.services, "tiny-remapper");
      const r = await runProcess({
        command: java,
        args: ["-Xmx2G", "-jar", tr, merged, `${named.replace(/\.jar$/, "")}.tmp.jar`, tiny, "official", to, "--ignoreConflicts", "--renameInvalidLocals", "--rebuildSourceFilenames"],
        cwd: dir,
        timeoutMs: 900_000,
        logFile: path.join(dir, "remap.log"),
      });
      if (r.exitCode !== 0 || !existsSync(`${named.replace(/\.jar$/, "")}.tmp.jar`)) throw new Error(`tiny-remapper failed (exit ${r.exitCode}): ${r.tail.slice(-8).join("\n")}`);
      const { rename } = await import("node:fs/promises");
      await rename(`${named.replace(/\.jar$/, "")}.tmp.jar`, named);
    }
    onProgress?.("Indexing classes…");
    const classes = indexJar(named);
    const meta: IndexMeta = {
      formatVersion: 1, kind: "vanilla", mcVersion: mc, namespace: ns, jar: named, obfuscated,
      builtAt: new Date().toISOString(), classCount: classes.length, notes,
    };
    return McIndex.save(dir, meta, classes);
  }

  // ---------------- project / toolchain ----------------

  async projectClasspath(project: ProjectInfo, onProgress?: (m: string) => void): Promise<string[]> {
    const cacheFile = path.join(project.dir, ".ffn", "classpath.json");
    const stamp = ["build.gradle", "build.gradle.kts", "gradle.properties", "settings.gradle", "settings.gradle.kts"]
      .map((f) => path.join(project.dir, f))
      .filter(existsSync)
      .map((f) => `${f}:${statSync(f).mtimeMs}`)
      .concat("cp2") // bump when the classpath query changes (cp2: + clientCompileClasspath)
      .join(";");
    if (existsSync(cacheFile)) {
      const c = JSON.parse(await readFile(cacheFile, "utf8")) as { stamp: string; files: string[] };
      if (c.stamp === stamp && c.files.every((f) => existsSync(f))) return c.files;
    }
    onProgress?.("Asking Gradle for the project's compile classpath (first time can take minutes)…");
    const { runGradle } = await import("../tools/gradle.js");
    const init = path.join(project.dir, ".ffn", "ffn-classpath.gradle");
    await mkdir(path.dirname(init), { recursive: true });
    await writeFile(init, CLASSPATH_INIT);
    const run = await runGradle(this.services, {
      projectDir: project.dir,
      tasks: ["ffnPrintClasspath"],
      args: ["--init-script", init, "--no-configuration-cache", "-q"],
      timeoutSec: 1800,
      daemon: true,
      logName: "classpath",
    });
    if ("error" in run) throw new Error(run.error);
    if (run.result.exitCode !== 0) throw new Error(`Gradle failed while resolving the classpath: ${run.diagnosis.summary} (log: ${run.result.logFile})`);
    const text = await readFile(run.result.logFile, "utf8");
    const entries = [...text.matchAll(/^FFN-CP:([^|]*)\|(.+)$/gm)].map((m) => ({ project: m[1]!, file: m[2]!.trim() }));
    const rootFiles = entries.filter((e) => e.project === ":").map((e) => e.file);
    const files = [...new Set(rootFiles.length ? rootFiles : entries.map((e) => e.file))];
    await writeFile(cacheFile, JSON.stringify({ stamp, files }, null, 1));
    return files;
  }

  /** First jar on the classpath containing the given Minecraft class. */
  private findJarWith(files: string[], marker: string): string | undefined {
    const jars = files.filter((f) => f.endsWith(".jar") && existsSync(f));
    const likely = (f: string) => (/minecraft|neoforge|forge|merged|patched|joined|client/i.test(path.basename(f)) ? 0 : 1);
    jars.sort((a, b) => likely(a) - likely(b));
    for (const j of jars) {
      if (likely(j) === 1 && statSync(j).size < 5_000_000) continue;
      try {
        if (new AdmZip(j).getEntry(marker)) return j;
      } catch {
        /* not a zip */
      }
    }
    return undefined;
  }

  /** The Minecraft jar(s): one merged jar, or Loom's split pair (common + clientOnly). */
  private findMinecraftJars(files: string[]): string[] {
    const main = this.findJarWith(files, MC_MARKER);
    if (!main) return [];
    const client = this.findJarWith(files, CLIENT_MARKER);
    return client && client !== main ? [main, client] : [main];
  }

  /** Merge split jars into one (first jar wins on duplicate entries). */
  private mergeJars(jars: string[], out: string): void {
    const merged = new AdmZip();
    const seen = new Set<string>();
    for (const j of jars) {
      for (const e of new AdmZip(j).getEntries()) {
        if (e.isDirectory || seen.has(e.entryName) || /^META-INF\/.*\.(SF|RSA|DSA)$/.test(e.entryName)) continue;
        seen.add(e.entryName);
        merged.addFile(e.entryName, e.getData());
      }
    }
    merged.writeZip(out);
  }

  private sourcesFor(jar: string): string | undefined {
    const base = jar.replace(/\.jar$/, "");
    for (const cand of [`${base}-sources.jar`, `${base.replace(/-merged$/, "")}-sources.jar`]) if (existsSync(cand)) return cand;
    return undefined;
  }

  private async openProject(project: ProjectInfo, onProgress?: (m: string) => void): Promise<McIndex> {
    const files = await this.projectClasspath(project, onProgress);
    const jars = this.findMinecraftJars(files);
    if (!jars.length) throw new Error("No jar containing Minecraft classes on the compile classpath.");
    const hash = createHash("sha1")
      .update(jars.map((j) => `${j}:${statSync(j).size}:${statSync(j).mtimeMs}`).join("|"))
      .digest("hex")
      .slice(0, 16);
    const dir = path.join(this.root, "project", hash);
    const key = `project:${hash}`;
    let jar = jars[0]!;
    if (jars.length > 1) {
      // Loom split environments: index common + clientOnly together so client targets resolve
      jar = path.join(dir, "minecraft-merged.jar");
      const srcs = jars.map((j) => this.sourcesFor(j));
      if (!existsSync(jar)) {
        await mkdir(dir, { recursive: true });
        onProgress?.(`Merging ${jars.map((j) => path.basename(j)).join(" + ")}…`);
        this.mergeJars(jars, jar);
      }
      const mergedSrc = path.join(dir, "minecraft-merged-sources.jar");
      if (srcs.every(Boolean) && !existsSync(mergedSrc)) this.mergeJars(srcs as string[], mergedSrc);
    }
    return this.once(key, async () => {
      const existing = await McIndex.load(dir);
      if (existing) {
        const src = this.sourcesFor(jar);
        if (src && existing.meta.sourcesJar !== src) existing.meta.sourcesJar = src;
        return existing;
      }
      onProgress?.(`Indexing ${path.basename(jar)}…`);
      const classes = indexJar(jar);
      const meta: IndexMeta = {
        formatVersion: 1, kind: "toolchain", mcVersion: project.mcVersion, namespace: project.mappings === "parchment" ? "mojmap" : project.mappings,
        loader: project.loader, jar, sourcesJar: this.sourcesFor(jar), obfuscated: false, builtAt: new Date().toISOString(), classCount: classes.length,
        notes: this.sourcesFor(jar) ? [] : ["No -sources.jar next to the project jar (run genSources / IDE sync for full-text search); sources are decompiled per class with Vineflower."],
      };
      return McIndex.save(dir, meta, classes);
    });
  }

  // ---------------- sources & translation ----------------

  async source(index: McIndex, className: string) {
    return index.source(className, async (outer) => vineflowerDecompile(await toolJava(), await toolJar(this.services, "vineflower"), index, outer));
  }

  /** Decompile (and cache) several top-level classes in one Vineflower run; returns what was produced. */
  async decompileMany(index: McIndex, outers: string[]): Promise<Map<string, string>> {
    const m = await vineflowerDecompileMany(await toolJava(), await toolJar(this.services, "vineflower"), index, outers);
    for (const [o, t] of m) await index.storeSource(o, t);
    return m;
  }

  /** Joined mapping table for a version: obf ↔ mojmap ↔ intermediary ↔ yarn ↔ srg (whatever exists). */
  async table(mc: string): Promise<{ table: MappingTable; notes: string[] }> {
    let p = this.tables.get(mc);
    if (!p) {
      p = (async () => {
        const notes: string[] = [];
        const sets: MappingSet[] = [];
        const add = async <T>(label: string, f: () => Promise<T | undefined>, use: (v: T) => void) => {
          try {
            const v = await f();
            if (v === undefined) notes.push(`${label}: not published for ${mc}.`);
            else use(v);
          } catch (e) {
            notes.push(`${label}: could not be loaded (${(e as Error).message}).`);
          }
        };
        await add("Mojang mappings", () => this.mojmapSet(mc), (s) => sets.push(s));
        await add("Intermediary", () => this.intermediarySet(mc), (s) => sets.push(s));
        await add("Yarn", () => this.yarnSet(mc), (y) => {
          sets.push(y.set);
          notes.push(`Yarn ${y.version}.`);
        });
        const obf = (await this.services.versions.mojangVersion(mc))?.obfuscated;
        if (obf === false) notes.push(`Minecraft ${mc} is unobfuscated: every loader uses the same (Mojang) names, so translation is the identity.`);
        if (obf !== false) await add("SRG (MCPConfig)", () => this.srgSet(mc), (s) => {
          sets.push(s.set);
          notes.push(`SRG from MCPConfig ${s.version} (Forge runtime member names; class names at runtime are Mojang's).`);
        });
        return { table: new MappingTable(sets), notes };
      })();
      this.tables.set(mc, p);
      p.catch(() => this.tables.delete(mc));
    }
    return p;
  }
}
