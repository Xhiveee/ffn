import { chmod, copyFile, mkdir, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Mappings } from "../profiles/schema.js";
import { lookupProfile, type Services } from "../services.js";
import { Notes } from "../sources/index.js";
import { gitignore, gradleWrapperProperties, projectReadme } from "./templates/common.js";
import { fabricFiles } from "./templates/fabric.js";
import { forgegradleFiles, moddevgradleFiles, moddevgradleLegacyFiles } from "./templates/forgelike.js";
import type { FileContent, ProjectContext, ProjectParams, ProjectPlan, ResolvedVersions } from "./types.js";
import { deriveMainClass, validateClassName, validateModId, validatePackage } from "./validate.js";

export class ProjectError extends Error {}

function checkText(field: string, v: string): void {
  if (/["\\$\n\r]/.test(v)) throw new ProjectError(`${field} must not contain quotes, backslashes, "$" or newlines.`);
}

/** Resolve profile + live versions and build the in-memory file plan (no disk writes). */
export async function planProject(services: Services, input: ProjectParams): Promise<ProjectPlan> {
  const idErr = validateModId(input.modId);
  if (idErr) throw new ProjectError(idErr);
  const pkgErr = validatePackage(input.package);
  if (pkgErr) throw new ProjectError(pkgErr);
  checkText("modName", input.modName);
  checkText("author", input.author);
  if (input.description) checkText("description", input.description);
  if (!/^[0-9A-Za-z][0-9A-Za-z.+_-]*$/.test(input.version)) throw new ProjectError(`Invalid mod version "${input.version}" (use e.g. 1.0.0).`);
  const mainClass = input.mainClass ?? deriveMainClass(input.modName, input.modId);
  const clsErr = validateClassName(mainClass);
  if (clsErr) throw new ProjectError(clsErr);

  const notes = new Notes();
  const { profile } = await lookupProfile(services, input.loader, input.mcVersion, notes);
  const mc = input.mcVersion;

  let mappings: Mappings = input.mappings ?? profile.mappings.default;
  if (!profile.mappings.supported.includes(mappings)) {
    throw new ProjectError(
      `Mappings "${mappings}" are not supported for ${input.loader} ${mc}. Supported: ${profile.mappings.supported.join(", ")}.`,
    );
  }

  const v = services.versions;
  const versions: ResolvedVersions = { minecraft: mc, loader: "", pluginVersion: "" };

  // Loader version (live)
  if (input.loader === "fabric") {
    const fab = await v.fabric(mc, notes);
    if (!fab.gameSupported) notes.warn(`Fabric meta does not list Minecraft ${mc} as a supported game version yet.`);
    if (!fab.loader) throw new ProjectError("Could not determine the latest Fabric Loader version.");
    versions.loader = fab.loader;
    versions.fabricApi = fab.fabricApi;
    if (!fab.fabricApi) notes.warn(`No Fabric API build for ${mc} found on maven.fabricmc.net; the project is generated without it.`);
    if (mappings === "yarn") {
      if (!fab.yarn) throw new ProjectError(`No Yarn mappings published for ${mc}. Use mojmap.`);
      versions.yarn = fab.yarn;
    }
  } else if (input.loader === "forge") {
    const f = await v.forge(mc, notes);
    const chosen = f.recommended ?? f.latest;
    if (!chosen) throw new ProjectError(`MinecraftForge has no builds for Minecraft ${mc} (checked maven.minecraftforge.net).`);
    if (!f.recommended) notes.warn(`Forge has no "recommended" build for ${mc}; using latest ${chosen}.`);
    versions.loader = chosen;
    versions.forgeMajor = chosen.split(".")[0];
  } else {
    const n = await v.neoforge(mc, notes);
    const chosen = n.latestStable ?? n.latest;
    if (!chosen) throw new ProjectError(`NeoForge has no builds for Minecraft ${mc} (checked maven.neoforged.net).`);
    if (!n.latestStable) notes.warn(`NeoForge has only beta builds for ${mc}; using ${chosen}.`);
    if (n.artifact !== profile.loaderArtifact) {
      notes.warn(`Version data says ${n.artifact} but the profile expects ${profile.loaderArtifact}.`);
    }
    versions.loader = chosen;
    // Only legacy NeoForge (net.neoforged:forge, "1.20.1-47.1.x") needs a Forge-style major for mods.toml.
    if (n.artifact === "net.neoforged:forge") versions.forgeMajor = (chosen.split("-")[1] ?? chosen).split(".")[0];
  }

  // Parchment (live, optional)
  if (mappings === "parchment") {
    const p = await v.parchment(mc, notes);
    if (p) versions.parchment = p;
    else {
      notes.warn(`Parchment has no release for ${mc}; falling back to plain Mojang mappings.`);
      mappings = "mojmap";
    }
  }

  // Gradle plugin version (live unless the profile pins one)
  const pl = profile.plugin;
  if (pl.version === "latest") {
    if (!pl.metadataUrl) throw new ProjectError(`Profile plugin ${pl.id} says "latest" but has no metadataUrl.`);
    const latest = await v.latestPluginVersion(pl.metadataUrl, { prefix: pl.versionPrefix, allowUnstable: pl.allowUnstable }, notes);
    if (!latest) throw new ProjectError(`Could not resolve a version for Gradle plugin ${pl.id} from ${pl.metadataUrl}.`);
    versions.pluginVersion = latest;
  } else {
    versions.pluginVersion = pl.version;
  }

  const ctx: ProjectContext = {
    params: {
      modId: input.modId,
      modName: input.modName,
      package: input.package,
      author: input.author,
      version: input.version,
      mcVersion: mc,
      loader: input.loader,
      mappings,
      description: input.description ?? `${input.modName} - a ${input.loader} mod for Minecraft ${mc}.`,
      license: input.license ?? "All Rights Reserved",
      mainClass,
    },
    profile,
    versions,
  };

  let files: Map<string, FileContent>;
  switch (profile.buildSystem) {
    case "fabric-loom":
      files = fabricFiles(ctx);
      break;
    case "moddevgradle":
      files = moddevgradleFiles(ctx);
      break;
    case "moddevgradle-legacy":
      files = moddevgradleLegacyFiles(ctx);
      break;
    case "forgegradle6":
      files = forgegradleFiles(ctx, 6);
      break;
    case "forgegradle7":
      files = forgegradleFiles(ctx, 7);
      break;
  }

  const tpl = services.config.templatesDir;
  files.set("gradle/wrapper/gradle-wrapper.properties", gradleWrapperProperties(profile.gradle.version));
  files.set("gradlew", { copyFrom: path.join(tpl, "gradle-wrapper", "gradlew"), executable: true });
  files.set("gradlew.bat", { copyFrom: path.join(tpl, "gradle-wrapper", "gradlew.bat") });
  files.set("gradle/wrapper/gradle-wrapper.jar", { copyFrom: path.join(tpl, "gradle-wrapper", "gradle", "wrapper", "gradle-wrapper.jar") });
  if (input.loader === "fabric") files.set(`src/main/resources/assets/${input.modId}/icon.png`, { copyFrom: path.join(tpl, "icon.png") });
  files.set(`src/main/resources/data/${input.modId}/.gitkeep`, "");
  files.set(".gitignore", gitignore());
  profile.warnings = notes.warnings;
  files.set("README.md", projectReadme(ctx));
  files.set(
    ".ffn/project.json",
    `${JSON.stringify(
      {
        generator: "ffn",
        generatedAt: new Date().toISOString(),
        loader: input.loader,
        mcVersion: mc,
        mappings,
        modId: input.modId,
        modName: input.modName,
        author: input.author,
        version: input.version,
        description: input.description,
        license: input.license,
        package: input.package,
        mainClass,
        versions,
        profile: {
          basedOn: profile.basedOn,
          buildSystem: profile.buildSystem,
          java: profile.java,
          gradleJvm: Math.max(profile.java, profile.gradle.minJvm ?? 17),
          obfuscated: profile.obfuscated,
          verified: profile.verified,
          extrapolated: profile.extrapolated,
        },
        warnings: notes.warnings,
      },
      null,
      2,
    )}\n`,
  );

  return { context: ctx, files, warnings: notes.warnings, sources: [...notes.sources] };
}

async function isNonEmptyDir(dir: string): Promise<boolean> {
  try {
    const s = await stat(dir);
    if (!s.isDirectory()) throw new ProjectError(`${dir} exists and is not a directory.`);
    return (await readdir(dir)).length > 0;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw e;
  }
}

/** Write a plan to disk. Refuses a non-empty directory unless `overwrite`. */
export async function writeProject(plan: ProjectPlan, targetDir: string, opts: { overwrite?: boolean } = {}): Promise<string[]> {
  const root = path.resolve(targetDir);
  if (!opts.overwrite && (await isNonEmptyDir(root))) {
    throw new ProjectError(`Target directory ${root} is not empty. Pass overwrite=true to write into it anyway.`);
  }
  const written: string[] = [];
  for (const [rel, content] of [...plan.files.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const dest = path.join(root, rel);
    if (!dest.startsWith(root + path.sep)) throw new ProjectError(`Refusing to write outside target: ${rel}`);
    await mkdir(path.dirname(dest), { recursive: true });
    if (typeof content === "string") {
      await writeFile(dest, content);
    } else {
      await copyFile(content.copyFrom, dest);
      if (content.executable) await chmod(dest, 0o755);
    }
    written.push(rel);
  }
  return written;
}
