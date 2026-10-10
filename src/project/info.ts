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

  const build = (await readText(path.join(dir, "build.gradle"))) ?? (await readText(path.join(dir, "build.gradle.kts"))) ?? "";
  const settings = (await readText(path.join(dir, "settings.gradle"))) ?? (await readText(path.join(dir, "settings.gradle.kts"))) ?? "";
  const all = build + "\n" + settings;
  let loader: Loader | undefined;
  if (/fabric-loom|fabricmc\.loom|id\s*\(?\s*["']fabric-loom/.test(all) || existsSync(path.join(dir, "src/main/resources/fabric.mod.json"))) loader = "fabric";
  else if (/neoforged\.moddev\.legacyforge/.test(all)) loader = /neoForgeVersion|neo_version/.test(all + JSON.stringify(props)) ? "neoforge" : "forge";
  else if (/net\.neoforged\.(moddev|gradle)/.test(all) || props.neo_version) loader = "neoforge";
  else if (/net\.minecraftforge\.gradle|minecraftforge/.test(all) || props.forge_version) loader = "forge";
  const mcVersion = props.minecraft_version ?? props.mc_version ?? /minecraft\s*\(?\s*["']com\.mojang:minecraft:([^"']+)/.exec(build)?.[1];
  if (!loader || !mcVersion) {
    throw new Error(
      `Could not determine ${!loader ? "the loader" : "the Minecraft version"} of ${dir}. Projects created by create_project carry .ffn/project.json; ` +
        "for other projects make sure gradle.properties has minecraft_version and build.gradle applies Loom/ModDevGradle/ForgeGradle.",
    );
  }
  let mappings: Mappings = "mojmap";
  if (props.yarn_mappings || /net\.fabricmc:yarn:/.test(build)) mappings = "yarn";
  else if (/parchment/i.test(all) || props.parchment_mappings_version || props.parchment_version) mappings = "parchment";
  const modId = props.mod_id ?? props.archives_base_name ?? mixinConfigs.map((c) => /([\w-]+)\.mixins\.json$/.exec(c)?.[1]).find(Boolean);
  return {
    dir, loader, mcVersion, mappings, modId,
    mappingsVersion: props.yarn_mappings ?? props.parchment_mappings_version ?? props.parchment_version,
    source: "inferred", mixinConfigs, javaSourceRoots: sets.java, resourceRoots: sets.resources,
  };
}
