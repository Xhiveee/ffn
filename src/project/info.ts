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

export async function sourceSets(dir: string): Promise<{ java: string[]; resources: string[] }> {
  const java: string[] = [];
  const resources: string[] = [];
  const srcDirs = [path.join(dir, "src")];
  // multi-project layouts (common/fabric/forge) — one level deep
  for (const sub of existsSync(dir) ? await readdir(dir, { withFileTypes: true }) : []) {
    if (sub.isDirectory() && existsSync(path.join(dir, sub.name, "src")) && sub.name !== "src") srcDirs.push(path.join(dir, sub.name, "src"));
  }
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
export async function detectProject(dir: string, props: Record<string, string>, mixinConfigs: string[], resourceRoots: string[]): Promise<Detected> {
  const buildFile = ["build.gradle", "build.gradle.kts"].find((f) => existsSync(path.join(dir, f)));
  const build = stripComments((buildFile && (await readText(path.join(dir, buildFile)))) ?? "");
  const settings = stripComments((await readText(path.join(dir, "settings.gradle"))) ?? (await readText(path.join(dir, "settings.gradle.kts"))) ?? "");
  const all = `${build}\n${settings}`;
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
  if (/fabric-loom|fabricmc\.loom/.test(all)) (loader = "fabric"), from.push(`${buildFile}: Loom plugin`);
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
  const sets = await sourceSets(dir);
  const mixinConfigs = (await Promise.all(sets.resources.map((r) => findFiles(r, (n) => /mixins.*\.json$|\.mixins\.json$/.test(n), 2)))).flat();
  const props = parseProperties((await readText(path.join(dir, "gradle.properties"))) ?? "");

  const ffn = await readText(path.join(dir, ".ffn", "project.json"));
  if (ffn) {
    const j = JSON.parse(ffn) as {
      loader: Loader; mcVersion: string; mappings: Mappings; modId?: string; profile?: { java?: number; gradleJvm?: number };
    };
    return {
      dir, loader: j.loader, mcVersion: props.minecraft_version ?? j.mcVersion, mappings: j.mappings, modId: j.modId,
      mappingsVersion: props.yarn_mappings ?? props.parchment_mappings_version,
      source: "ffn", java: j.profile?.java, gradleJvm: j.profile?.gradleJvm,
      mixinConfigs, javaSourceRoots: sets.java, resourceRoots: sets.resources,
    };
  }

  const d = await detectProject(dir, props, mixinConfigs, sets.resources);
  return { dir, ...d, mixinConfigs, javaSourceRoots: sets.java, resourceRoots: sets.resources };
}
