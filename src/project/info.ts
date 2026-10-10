import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { Loader, Mappings } from "../profiles/schema.js";

/** What FFN needs to know about a mod project. Read from .ffn/project.json, else inferred from build files. */
export interface ProjectInfo {
  dir: string;
  loader: Loader;
  mcVersion: string;
  mappings: Mappings;
  modId?: string;
  /** e.g. yarn build, parchment version, when declared. */
  mappingsVersion?: string;
  source: "ffn" | "inferred";
  /** How loader / version / mappings were determined (file and key), for messages. */
  detectedFrom?: string[];
  /** Java version the mod targets / Gradle must run on, if FFN generated it. */
  java?: number;
  gradleJvm?: number;
  mixinConfigs: string[];
  javaSourceRoots: string[];
  resourceRoots: string[];
  /** Gradle root (settings.gradle, gradlew); equals dir for single-project builds. */
  rootDir?: string;
  /** Gradle path of this project (":" root, ":fabric"). */
  gradlePath?: string;
  /** Gradle project whose compile classpath describes this project (a platform subproject for a multi-project root). */
  classpathProject?: string;
  /** "common" for the shared module of a multi-loader build (loader then = a sibling platform, for profile lookups). */
  platform?: Loader | "common";
  /** Multi-project builds: subprojects from settings.gradle with the platform each targets. */
  subprojects?: SubprojectInfo[];
}

export interface SubprojectInfo {
  path: string;
  dir: string;
  platform?: Loader | "common";
}

/**
 * Subprojects declared in settings.gradle(.kts): include 'a', include(":b:c"), include("x", "y"),
 * Architectury-style loops over enabled_platforms, and project(':x').projectDir = file('dir') overrides.
 */
export function parseSettingsIncludes(text: string, props: Record<string, string> = {}): { path: string; dir: string }[] {
  const src = stripComments(text);
  const paths: string[] = [];
  for (const m of src.matchAll(/\binclude\b\s*\(?((?:\s*['"][^'"]+['"]\s*,?)+)\)?/g)) for (const q of m[1]!.matchAll(/['"]([^'"]+)['"]/g)) paths.push(q[1]!);
  if (/enabled_platforms/.test(src) && props.enabled_platforms) paths.push(...props.enabled_platforms.split(",").map((x) => x.trim()).filter(Boolean));
  const dirs = new Map<string, string>();
  for (const m of src.matchAll(/project\s*\(\s*['"]([^'"]+)['"]\s*\)\s*\.projectDir\s*=\s*(?:file|new File)\s*\(\s*(?:settingsDir\s*,\s*|rootDir\s*,\s*)?['"]([^'"]+)['"]/g)) dirs.set(m[1]!.replace(/^:?/, ":"), m[2]!);
  const out = new Map<string, string>();
  for (const raw of paths) {
    const p = raw.replace(/^:?/, ":");
    out.set(p, dirs.get(p) ?? p.slice(1).replace(/:/g, "/"));
  }
  return [...out].map(([p, dir]) => ({ path: p, dir }));
}

const PLATFORM_NAMES: [RegExp, Loader | "common"][] = [
  [/neoforge/i, "neoforge"],
  [/forge/i, "forge"],
  [/fabric|quilt/i, "fabric"],
  [/common|shared|core|xplat/i, "common"],
];

/** Which platform a subproject targets: Architectury `architectury { fabric() }`, loader plugins, else its name. */
export async function subprojectPlatform(dir: string, name: string): Promise<Loader | "common" | undefined> {
  const build = stripComments((await readText(path.join(dir, "build.gradle"))) ?? (await readText(path.join(dir, "build.gradle.kts"))) ?? "");
  const arch = /architectury\s*\{([^}]*)\}/.exec(build)?.[1] ?? "";
  if (/\bcommon\s*\(/.test(arch)) return "common";
  if (/\bneoForge\s*\(/.test(arch)) return "neoforge";
  if (/\bforge\s*\(/.test(arch)) return "forge";
  if (/\bfabric\s*\(/.test(arch)) return "fabric";
  for (const [re, p] of PLATFORM_NAMES) if (re.test(name)) return p;
  if (/net\.neoforged\.moddev\.legacyforge|net\.minecraftforge\.gradle/.test(build)) return "forge";
  if (/net\.neoforged\.(moddev|gradle)/.test(build)) return /neoFormVersion|neoForm\s*\{/.test(build) ? "common" : "neoforge";
  if (/fabric-loom|fabricmc\.loom/.test(build)) return "fabric";
  if (/org\.spongepowered\.gradle\.vanilla/.test(build)) return "common";
  return undefined;
}

/** Gradle path of a directory below the root (":fabric:sub"), for any OS path flavour. */
export function gradlePathOf(rootDir: string, dir: string, p: typeof path.posix = path): string {
  return `:${p.relative(rootDir, dir).split(/[\\/]/).filter(Boolean).join(":")}`;
}

/** The Gradle root containing dir: the nearest ancestor (max 3 up) whose settings.gradle includes dir. */
export async function findGradleRoot(dir: string): Promise<string> {
  let cur = dir;
  for (let i = 0; i < 3; i++) {
    const up = path.dirname(cur);
    if (up === cur) break;
    const settings = (await readText(path.join(up, "settings.gradle"))) ?? (await readText(path.join(up, "settings.gradle.kts")));
    if (settings) {
      const props = parseProperties((await readText(path.join(up, "gradle.properties"))) ?? "");
      if (parseSettingsIncludes(settings, props).some((s) => path.resolve(up, s.dir) === dir)) return up;
    }
    cur = up;
  }
  return dir;
}

export function parseProperties(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith("!")) continue;
    const m = /^([^=:\s]+)\s*[=:]\s*(.*)$/.exec(line);
    if (m) out[m[1]!] = m[2]!;
  }
  return out;
}

async function readText(p: string): Promise<string | undefined> {
  try {
    return await readFile(p, "utf8");
  } catch {
    return undefined;
  }
}

async function findFiles(dir: string, pred: (name: string) => boolean, depth = 6, out: string[] = []): Promise<string[]> {
  if (depth < 0 || !existsSync(dir)) return out;
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (e.name.startsWith(".") || e.name === "build" || e.name === "run" || e.name === "node_modules") continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) await findFiles(p, pred, depth - 1, out);
    else if (pred(e.name)) out.push(p);
  }
  return out;
}

export async function sourceSets(dir: string, subDirs: string[] = []): Promise<{ java: string[]; resources: string[] }> {
  const java: string[] = [];
  const resources: string[] = [];
  const srcDirs = [path.join(dir, "src"), ...subDirs.map((d) => path.join(d, "src"))];
  for (const src of srcDirs) {
    if (!existsSync(src)) continue;
    for (const set of await readdir(src, { withFileTypes: true })) {
      if (!set.isDirectory()) continue;
      const j = path.join(src, set.name, "java");
      const r = path.join(src, set.name, "resources");
      if (existsSync(j)) java.push(j);
      if (existsSync(r)) resources.push(r);
    }
  }
  return { java, resources };
}

/** Remove line and block comments so commented-out examples in MDK build scripts do not count. */
export function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'])\/\/.*$/gm, "$1");
}

/** A concrete value, not a template placeholder (${project.x}, @MC_VERSION@ in unprocessed MDK sources). */
const literal = (v: string | undefined) => (v && v.trim() && !/\$|@\w+@/.test(v) ? v.trim() : undefined);

/** Minecraft version from a loader version string: NeoForge 21.1.x → 1.21.1, 26.3.0.x → 26.3; Forge "1.20.1-47.1.0" → 1.20.1. */
export function mcFromLoaderVersion(loader: Loader, v: string | undefined): string | undefined {
  if (!v) return undefined;
  const dashed = /^(1\.\d+(?:\.\d+)?)-/.exec(v);
  if (dashed) return dashed[1];
  if (loader !== "neoforge") return undefined;
  const m = /^(\d+)\.(\d+)\./.exec(v);
  if (!m) return undefined;
  const major = Number(m[1]);
  if (major >= 25) return m[2] === "0" ? `${major}` : `${major}.${m[2]}`; // year-based versions (26.3)
  return m[2] === "0" ? `1.${major}` : `1.${major}.${m[2]}`;
}

interface Detected {
  loader: Loader;
  mcVersion: string;
  mappings: Mappings;
  modId?: string;
  mappingsVersion?: string;
  source: "inferred";
  detectedFrom: string[];
}

/**
 * Detect loader, Minecraft version, mappings and mod id from the project's own files, the way official MDKs and the
 * Fabric example mod declare them (gradle.properties keys, plugin ids in build.gradle(.kts)/settings.gradle(.kts),
 * fabric.mod.json / mods.toml). No FFN-specific file is needed.
 */
export async function detectProject(dir: string, props: Record<string, string>, mixinConfigs: string[], resourceRoots: string[], rootDir = dir, platform?: Loader): Promise<Detected> {
  const buildFile = ["build.gradle", "build.gradle.kts"].find((f) => existsSync(path.join(dir, f)));
  const build = stripComments((buildFile && (await readText(path.join(dir, buildFile)))) ?? "");
  const settings = stripComments((await readText(path.join(rootDir, "settings.gradle"))) ?? (await readText(path.join(rootDir, "settings.gradle.kts"))) ?? "");
  const all = rootDir === dir ? `${build}\n${settings}` : build; // a subproject's plugins are in its own build file
  const from: string[] = [];
  const resFile = async (rel: string) => {
    for (const r of resourceRoots) {
      const t = await readText(path.join(r, rel));
      if (t) return t;
    }
    for (const r of ["src/main/resources", "src/main/templates"]) {
      const t = await readText(path.join(dir, r, rel));
      if (t) return t;
    }
    return undefined;
  };
  const fabricJson = await resFile("fabric.mod.json");
  const modsToml = (await resFile("META-INF/neoforge.mods.toml")) ?? (await resFile("META-INF/mods.toml"));

  let loader: Loader | undefined;
  if (platform) (loader = platform), from.push(`subproject platform: ${platform}`);
  else if (/fabric-loom|fabricmc\.loom/.test(all)) (loader = "fabric"), from.push(`${buildFile}: Loom plugin`);
  else if (/net\.neoforged\.moddev\.legacyforge/.test(all)) {
    // ModDevGradle "legacyforge" builds both Forge 1.20.1 MDKs and NeoForge's 1.20.1 (net.neoforged:forge)
    loader = props.neo_version || /neoForge\s*\{|net\.neoforged:forge/.test(all) ? "neoforge" : "forge";
    from.push(`${buildFile}: net.neoforged.moddev.legacyforge + ${loader === "neoforge" ? "neo_version" : "forge_version"}`);
  } else if (/net\.neoforged\.(moddev|gradle)/.test(all)) (loader = "neoforge"), from.push(`${buildFile}: NeoForge plugin`);
  else if (/net\.minecraftforge\.gradle/.test(all)) (loader = "forge"), from.push(`${buildFile}: ForgeGradle`);
  else if (fabricJson) (loader = "fabric"), from.push("fabric.mod.json");
  else if (props.neo_version) (loader = "neoforge"), from.push("gradle.properties: neo_version");
  else if (props.forge_version) (loader = "forge"), from.push("gradle.properties: forge_version");

  let mcVersion = literal(props.minecraft_version) ?? literal(props.mc_version);
  if (mcVersion) from.push(`gradle.properties: ${props.minecraft_version ? "minecraft_version" : "mc_version"}=${mcVersion}`);
  if (!mcVersion) {
    const coord = /com\.mojang:minecraft:([^"'\s)]+)/.exec(build)?.[1];
    mcVersion = literal(coord);
    if (mcVersion) from.push(`${buildFile}: com.mojang:minecraft:${mcVersion}`);
  }
  if (!mcVersion && loader) {
    const lv = props.neo_version ?? props.forge_version ?? /net\.(?:neoforged|minecraftforge):(?:neoforge|forge):([^"'\s)]+)/.exec(build)?.[1];
    mcVersion = mcFromLoaderVersion(loader, literal(lv));
    if (mcVersion) from.push(`loader version ${lv} → Minecraft ${mcVersion}`);
  }
  if (!mcVersion) {
    const range = /^\[([\d.]+)(?:,|\])/.exec(props.minecraft_version_range ?? "")?.[1];
    if (range) (mcVersion = range), from.push(`gradle.properties: minecraft_version_range`);
  }
  if (!loader || !mcVersion) {
    throw new Error(
      `Could not determine ${!loader ? "the loader" : "the Minecraft version"} of ${dir}. FFN reads it from the project itself: ` +
        "gradle.properties (minecraft_version, neo_version / forge_version) and the Gradle plugin in build.gradle(.kts) " +
        "(Loom, ModDevGradle, NeoGradle, ForgeGradle), as in the official MDKs and the Fabric example mod.",
    );
  }

  let mappings: Mappings = "mojmap";
  const channel = props.mapping_channel ?? /mappings\s+channel:\s*['"](\w+)['"]/.exec(build)?.[1];
  if (props.yarn_mappings || /net\.fabricmc:yarn:/.test(build)) mappings = "yarn";
  else if (channel === "parchment" || props.parchment_mappings_version || props.parchment_version || props.parchment_minecraft_version || props["neogradle.subsystems.parchment.mappingsVersion"] || /parchment\s*\{|org\.parchmentmc|parchment\(/.test(build)) mappings = "parchment";
  from.push(`mappings: ${mappings}`);

  const tomlId = literal(/^\s*modId\s*=\s*"([^"]+)"/m.exec(modsToml ?? "")?.[1]);
  let jsonId: string | undefined;
  try {
    jsonId = literal(fabricJson ? (JSON.parse(fabricJson) as { id?: string }).id : undefined);
  } catch {
    /* templated fabric.mod.json */
  }
  const modId = literal(props.mod_id) ?? jsonId ?? tomlId ?? mixinConfigs.map((c) => /([\w-]+)\.mixins\.json$/.exec(c)?.[1]).find(Boolean) ?? literal(props.archives_base_name);
  return {
    loader, mcVersion, mappings, modId,
    mappingsVersion: props.yarn_mappings ?? props.parchment_mappings_version ?? props.parchment_version ?? props["neogradle.subsystems.parchment.mappingsVersion"] ?? props.mapping_version,
    source: "inferred",
    detectedFrom: from,
  };
}

/** Throws with an actionable message when the project cannot be understood. */
export async function readProjectInfo(dirIn: string): Promise<ProjectInfo> {
  const dir = path.resolve(dirIn);
  if (!existsSync(dir)) throw new Error(`Project directory not found: ${dir}`);
  const rootDir = await findGradleRoot(dir);
  const rootProps = parseProperties((await readText(path.join(rootDir, "gradle.properties"))) ?? "");
  const props = rootDir === dir ? rootProps : { ...rootProps, ...parseProperties((await readText(path.join(dir, "gradle.properties"))) ?? "") };
  const settings = (await readText(path.join(rootDir, "settings.gradle"))) ?? (await readText(path.join(rootDir, "settings.gradle.kts"))) ?? "";
  const subprojects: SubprojectInfo[] = [];
  for (const inc of parseSettingsIncludes(settings, rootProps)) {
    const d = path.resolve(rootDir, inc.dir);
    if (existsSync(d)) subprojects.push({ path: inc.path, dir: d, platform: await subprojectPlatform(d, inc.path.split(":").pop()!) });
  }
  const isRoot = dir === rootDir;
  const self = subprojects.find((x) => x.dir === dir);
  const gradlePath = isRoot ? ":" : (self?.path ?? gradlePathOf(rootDir, dir));
  const sets = await sourceSets(dir, isRoot ? subprojects.map((x) => x.dir) : []);
  const mixinConfigs = (await Promise.all(sets.resources.map((r) => findFiles(r, (n) => /mixins.*\.json$|\.mixins\.json$/.test(n), 2)))).flat();
  const base = { dir, rootDir, gradlePath, mixinConfigs, javaSourceRoots: sets.java, resourceRoots: sets.resources, ...(isRoot && subprojects.length ? { subprojects } : {}) };

  const ffn = await readText(path.join(dir, ".ffn", "project.json"));
  if (ffn) {
    const j = JSON.parse(ffn) as {
      loader: Loader; mcVersion: string; mappings: Mappings; modId?: string; profile?: { java?: number; gradleJvm?: number };
    };
    return {
      ...base, loader: j.loader, mcVersion: props.minecraft_version ?? j.mcVersion, mappings: j.mappings, modId: j.modId,
      mappingsVersion: props.yarn_mappings ?? props.parchment_mappings_version,
      source: "ffn", java: j.profile?.java, gradleJvm: j.profile?.gradleJvm, classpathProject: gradlePath,
    };
  }

  const platforms = subprojects.filter((x) => x.platform && x.platform !== "common");
  if (isRoot && subprojects.length) {
    // Multi-project root: use the root's own setup if it is a mod, else the first platform subproject.
    try {
      const d = await detectProject(dir, props, mixinConfigs, sets.resources);
      if (existsSync(path.join(dir, "src"))) return { ...base, ...d, classpathProject: ":" };
    } catch {
      /* fall through to a subproject */
    }
    const primary = platforms[0] ?? subprojects[0]!;
    const sub = await readProjectInfo(primary.dir);
    return { ...base, loader: sub.loader, mcVersion: sub.mcVersion, mappings: sub.mappings, modId: sub.modId, mappingsVersion: sub.mappingsVersion, source: "inferred", detectedFrom: [`multi-project: ${subprojects.map((x) => `${x.path}${x.platform ? `=${x.platform}` : ""}`).join(", ")}; defaults to ${primary.path}`, ...(sub.detectedFrom ?? [])], classpathProject: primary.path };
  }
  const siblings = isRoot ? [] : (await readProjectInfoSiblings(rootDir, rootProps, settings));
  const platform = self?.platform ?? (isRoot ? undefined : await subprojectPlatform(dir, path.basename(dir)));
  let d: Detected;
  try {
    d = await detectProject(dir, props, mixinConfigs, sets.resources, rootDir, platform && platform !== "common" ? platform : undefined);
  } catch (e) {
    if (platform !== "common" || !props.minecraft_version) throw e;
    d = { loader: siblings[0] ?? "fabric", mcVersion: props.minecraft_version, mappings: props.parchment_mappings_version || props.parchment_version ? "parchment" : "mojmap", source: "inferred", detectedFrom: [`gradle.properties: minecraft_version=${props.minecraft_version}`] };
  }
  if (!isRoot) d.detectedFrom = [`subproject ${gradlePath} of ${rootDir}${platform ? ` (${platform})` : ""}`, ...d.detectedFrom];
  return { ...base, ...d, classpathProject: gradlePath, ...(platform === "common" ? { platform } : {}) };
}

async function readProjectInfoSiblings(rootDir: string, rootProps: Record<string, string>, settings: string): Promise<Loader[]> {
  const out: Loader[] = [];
  for (const inc of parseSettingsIncludes(settings, rootProps)) {
    const p = await subprojectPlatform(path.resolve(rootDir, inc.dir), inc.path.split(":").pop()!);
    if (p && p !== "common") out.push(p);
  }
  return out;
}
